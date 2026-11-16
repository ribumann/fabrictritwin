Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:MiningWorkspaceId = [guid]'4a809e56-42a8-4c30-a84f-83a47dd8793f'
$script:SemanticModelName = 'mining-d01-topology-semanticmodel'
$script:DataAgentName = 'mining-d01-topology-dataagent'
$script:PublishedDescription = 'Static Mining D01 topology catalog, not live telemetry.'
$script:SafetyPath = Join-Path $PSScriptRoot 'MiningAnalyticsSafety.psm1'
$script:CatalogModulePath = Join-Path $PSScriptRoot '..\mining-ontology\MiningOntology.psm1'
Import-Module $script:SafetyPath -Force

function Invoke-MiningBootstrapRequest {
    param($Client, [string]$Method, [string]$Uri, $Body = $null)
    $result = & $Client.request $Method $Uri $Body
    if ($result -isnot [Collections.IDictionary] -or
        -not $result.Contains('statusCode') -or -not $result.Contains('headers') -or
        -not $result.Contains('body')) {
        throw 'Fabric client returned a malformed response.'
    }
    return $result
}

function Assert-MiningBootstrapStatus {
    param($Response, [int[]]$Allowed)
    if ([int]$Response.statusCode -notin $Allowed) {
        $code = if ($Response.body -is [Collections.IDictionary]) { [string]$Response.body.errorCode } else { '' }
        throw "Fabric request failed with HTTP $($Response.statusCode) ($code)."
    }
}

function Get-MiningBootstrapRetryAfter {
    param($Headers, [string]$Label)
    $seconds = 0
    if (-not $Headers -or
        -not [int]::TryParse([string]$Headers['Retry-After'], [ref]$seconds) -or
        $seconds -lt 0 -or $seconds -gt 120) {
        throw "$Label did not return a supported integer Retry-After header."
    }
    return $seconds
}

function Wait-MiningBootstrapOperation {
    param($Client, [guid]$OperationId, [Parameter(Mandatory)][ValidateRange(0, 120)][int]$InitialRetryAfterSeconds,
        [ValidateRange(1, 120)][int]$MaxPolls = 60)
    if ($OperationId -eq [guid]::Empty) { throw 'Fabric returned an empty operation ID.' }
    for ($attempt = 0; $attempt -lt $MaxPolls; $attempt++) {
        $delay = if ($attempt -eq 0 -and $InitialRetryAfterSeconds -gt 0) { $InitialRetryAfterSeconds } else { 5 }
        & $Client.sleep $delay
        $state = Invoke-MiningBootstrapRequest $Client GET "https://api.fabric.microsoft.com/v1/operations/$OperationId"
        Assert-MiningBootstrapStatus $state @(200)
        if ($state.body.status -eq 'Failed') {
            return [pscustomobject]@{ Status = 'Failed'; State = $state.body; Result = $null }
        }
        if ($state.body.status -eq 'Succeeded') {
            $result = Invoke-MiningBootstrapRequest $Client GET "https://api.fabric.microsoft.com/v1/operations/$OperationId/result"
            Assert-MiningBootstrapStatus $result @(200)
            return [pscustomobject]@{ Status = 'Succeeded'; State = $state.body; Result = $result.body }
        }
        if ($state.body.status -notin @('NotStarted', 'Running')) {
            throw "Fabric operation '$OperationId' returned unsupported state '$($state.body.status)'."
        }
        $delay = Get-MiningBootstrapRetryAfter $state.headers "Fabric operation '$OperationId' status"
    }
    throw "Fabric operation '$OperationId' is still unresolved after $MaxPolls polls."
}

function Get-MiningBootstrapDefinition {
    param($Client, [guid]$WorkspaceId, [guid]$ItemId)
    $uri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items/$ItemId/getDefinition"
    $response = Invoke-MiningBootstrapRequest $Client POST $uri
    if ($response.statusCode -eq 200) { return $response.body.definition }
    if ($response.statusCode -eq 202) {
        $operationId = [guid]::Empty
        if (-not [guid]::TryParse([string]$response.headers['x-ms-operation-id'], [ref]$operationId) -or
            $operationId -eq [guid]::Empty) {
            throw "Definition readback for '$ItemId' returned 202 without a valid operation ID."
        }
        $operation = Wait-MiningBootstrapOperation $Client $operationId `
            -InitialRetryAfterSeconds ([int]$response.headers['Retry-After'])
        if ($operation.Status -ne 'Succeeded' -or -not $operation.Result.definition) {
            throw "Definition readback for '$ItemId' did not return a successful definition."
        }
        return $operation.Result.definition
    }
    Assert-MiningBootstrapStatus $response @(200, 202)
}

function ConvertTo-MiningBootstrapCanonical {
    param([AllowNull()]$Value)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [ValueType]) { return $Value }
    if ($Value -is [Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object -CaseSensitive)) {
            $ordered[[string]$key] = ConvertTo-MiningBootstrapCanonical $Value[$key]
        }
        return $ordered
    }
    if ($Value -is [Collections.IEnumerable]) {
        return ,@($Value | ForEach-Object { ConvertTo-MiningBootstrapCanonical $_ })
    }
    return $Value
}

function Get-MiningBootstrapPartMap {
    param($Definition, [string]$Label)
    if (-not $Definition -or -not $Definition.parts) { throw "$Label has no definition parts." }
    $parts = @{}
    foreach ($part in $Definition.parts) {
        if ([string]::IsNullOrWhiteSpace([string]$part.path) -or $part.payloadType -cne 'InlineBase64' -or
            $parts.ContainsKey([string]$part.path)) {
            throw "$Label contains an invalid or duplicate definition part."
        }
        try {
            $parts[[string]$part.path] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$part.payload))
        } catch {
            throw "$Label part '$($part.path)' is not valid InlineBase64."
        }
    }
    return $parts
}

function Assert-MiningJsonPartMatches {
    param([string]$Expected, [string]$Actual, [string]$Label)
    try {
        $expectedJson = $Expected | ConvertFrom-Json -AsHashtable -Depth 100
        $actualJson = $Actual | ConvertFrom-Json -AsHashtable -Depth 100
        $expectedCanonical = ConvertTo-Json -InputObject (ConvertTo-MiningBootstrapCanonical $expectedJson) -Depth 100 -Compress
        $actualCanonical = ConvertTo-Json -InputObject (ConvertTo-MiningBootstrapCanonical $actualJson) -Depth 100 -Compress
    } catch {
        throw "$Label is not valid JSON."
    }
    if ($expectedCanonical -cne $actualCanonical) { throw "$Label differs from the reviewed definition." }
}

function Assert-MiningAgentDefinition {
    param($ExpectedDefinition, $ActualDefinition, [switch]$Published)
    $expected = Get-MiningBootstrapPartMap $ExpectedDefinition 'Expected Data Agent'
    $actual = Get-MiningBootstrapPartMap $ActualDefinition 'Actual Data Agent'
    $publishedPaths = @($expected.Keys | Where-Object { $_ -like 'Files/Config/draft/*' } |
        ForEach-Object { $_.Replace('Files/Config/draft/', 'Files/Config/published/') })
    $allowedPaths = @($expected.Keys)
    if ($Published) { $allowedPaths += $publishedPaths + 'Files/Config/publish_info.json' }
    $actualPaths = @($actual.Keys | Sort-Object -CaseSensitive)
    $expectedPaths = @($allowedPaths | Sort-Object -CaseSensitive)
    $pathDifferences = @(Compare-Object -ReferenceObject $expectedPaths `
            -DifferenceObject $actualPaths -CaseSensitive)
    if ($actualPaths.Count -ne $expectedPaths.Count -or $pathDifferences.Count -gt 0) {
        $missingPaths = @($pathDifferences | Where-Object SideIndicator -eq '<=' |
            ForEach-Object InputObject)
        $unexpectedPaths = @($pathDifferences | Where-Object SideIndicator -eq '=>' |
            ForEach-Object InputObject)
        throw "Data Agent definition parts differ (missing: $($missingPaths -join ', '); unexpected: $($unexpectedPaths -join ', '))."
    }
    foreach ($path in $expected.Keys) {
        Assert-MiningJsonPartMatches $expected[$path] $actual[$path] "Data Agent part '$path'"
    }
    if ($Published) {
        foreach ($path in $expected.Keys | Where-Object { $_ -like 'Files/Config/draft/*' }) {
            $publishedPath = $path.Replace('Files/Config/draft/', 'Files/Config/published/')
            Assert-MiningJsonPartMatches $expected[$path] $actual[$publishedPath] "Published Data Agent part '$publishedPath'"
        }
        $publishInfo = $actual['Files/Config/publish_info.json'] | ConvertFrom-Json -AsHashtable -Depth 100
        if ($publishInfo.'$schema' -cne '1.0.0' -or
            $publishInfo.description -cne $script:PublishedDescription) {
            throw 'Data Agent publish info does not match the reviewed published description.'
        }
    }
}

function Read-MiningBootstrapReceipt {
    param([string]$Path, [guid]$WorkspaceId, [guid]$LakehouseId, [switch]$AllowAnyLakehouse)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return ,@() }
    if ((Get-Item -LiteralPath $Path).Length -eq 0) {
        throw 'Bootstrap receipt is empty; reconcile it manually before any writes.'
    }
    $records = [Collections.Generic.List[object]]::new()
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $Path) {
        $lineNumber++
        try { $record = $line | ConvertFrom-Json -AsHashtable -Depth 20 } catch {
            throw "Bootstrap receipt contains invalid JSON on line $lineNumber."
        }
        $lakehouseCreateWithoutId = $record.operation -ceq 'LakehouseCreate' -and
            $record.lakehouseId -ceq [guid]::Empty.ToString()
        if ($record.workspaceId -cne $WorkspaceId.ToString() -or
            (-not $AllowAnyLakehouse -and $record.lakehouseId -cne $LakehouseId.ToString() -and
                -not $lakehouseCreateWithoutId)) {
            throw 'Bootstrap receipt is malformed or belongs to a different target.'
        }
        if ($AllowAnyLakehouse -and $record.operation -cne 'LakehouseCreate' -and
            $record.lakehouseId -cne $LakehouseId.ToString() -and $LakehouseId -ne [guid]::Empty) {
            throw 'Bootstrap receipt contains an item operation for a different Lakehouse.'
        }
        $records.Add([pscustomobject]$record)
    }
    return ,$records.ToArray()
}

function Add-MiningBootstrapReceipt {
    param([string]$Path, [guid]$WorkspaceId, [guid]$LakehouseId, [hashtable]$Record)
    $Record.workspaceId = $WorkspaceId.ToString()
    $Record.lakehouseId = $LakehouseId.ToString()
    $Record.utc = [DateTimeOffset]::UtcNow.ToString('O')
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Record | ConvertTo-Json -Depth 30 -Compress) + "`n")
    $stream = [IO.FileStream]::new($Path, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}

function Get-MiningBootstrapLatestReceipt {
    param([object[]]$Records, [string]$Operation)
    return $Records | Where-Object operation -CEQ $Operation | Select-Object -Last 1
}

function Get-MiningBootstrapOptionalValue {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    if ($Object -is [Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return $Object[$Name] }
        return $null
    }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Get-MiningBootstrapItems {
    param($Client, [guid]$WorkspaceId)
    $request = {
        param($Uri, $Headers)
        $response = & $Client.request GET $Uri $null
        if ($response -isnot [Collections.IDictionary] -or
            -not $response.Contains('statusCode') -or -not $response.Contains('body') -or
            [int]$response.statusCode -ne 200) {
            throw 'Fabric item inventory request did not return HTTP 200.'
        }
        return $response.body
    }.GetNewClosure()
    return ,(Get-MiningAnalyticsFabricItems -WorkspaceId $WorkspaceId -Headers @{} -Request $request)
}

function Get-MiningIsolatedLakehouseDetails {
    param($Client, [guid]$WorkspaceId, $Item)
    $itemId = [guid]::Empty
    if (-not [guid]::TryParse([string]$Item.id, [ref]$itemId) -or $itemId -eq [guid]::Empty) {
        throw 'Mining Lakehouse has an invalid item ID.'
    }
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $response = Invoke-MiningBootstrapRequest $Client GET `
            "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/lakehouses/$itemId"
        Assert-MiningBootstrapStatus $response @(200)
        $lakehouse = $response.body
        if ($lakehouse.id -cne $itemId.ToString() -or
            $lakehouse.workspaceId -cne $WorkspaceId.ToString() -or
            $lakehouse.type -cne 'Lakehouse' -or
            $lakehouse.displayName -cne 'mining_d01_static_lakehouse' -or
            $lakehouse.properties.defaultSchema -cne 'dbo') {
            throw 'The exact Mining Lakehouse is not the expected schema-enabled dbo Lakehouse.'
        }
        $endpoint = $lakehouse.properties.sqlEndpointProperties
        if ($endpoint.provisioningStatus -ceq 'Failed') {
            throw 'Mining Lakehouse SQL endpoint provisioning failed.'
        }
        if ($endpoint.provisioningStatus -ceq 'Success') {
            $endpointId = [guid]::Empty
            if (-not [guid]::TryParse([string]$endpoint.id, [ref]$endpointId) -or
                $endpointId -eq [guid]::Empty -or
                [string]$endpoint.connectionString -notmatch '^[a-z0-9-]+(?:\.datawarehouse\.fabric\.microsoft\.com|-datawarehouse\.pbidedicated\.windows\.net)$') {
                throw 'Mining Lakehouse returned an invalid ready SQL endpoint.'
            }
            return [pscustomobject]@{
                Lakehouse = $lakehouse
                Target = @{
                    WorkspaceId = $WorkspaceId.ToString()
                    StaticLakehouseId = $itemId.ToString()
                    SourceSchema = 'dbo'
                    SqlEndpointId = $endpointId.ToString()
                    SqlServer = [string]$endpoint.connectionString
                    SqlDatabase = [string]$lakehouse.displayName
                }
            }
        }
        if ($endpoint.provisioningStatus -cne 'InProgress') {
            throw "Mining Lakehouse returned unsupported SQL endpoint state '$($endpoint.provisioningStatus)'."
        }
        if ($attempt -lt 59) { & $Client.sleep 5 }
    }
    throw 'Mining Lakehouse SQL endpoint did not become ready within the bounded wait.'
}

function Ensure-MiningIsolatedLakehouse {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][guid]$WorkspaceId,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [Parameter(Mandatory)]$Client,
        [switch]$Apply
    )
    if ($WorkspaceId -ne $script:MiningWorkspaceId) {
        throw 'Only the approved isolated workspace is permitted.'
    }
    $records = Read-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]::Empty) -AllowAnyLakehouse
    $items = Get-MiningBootstrapItems $Client $WorkspaceId
    $item = Get-MiningAnalyticsMatchingItem -Items $items `
        -DisplayName 'mining_d01_static_lakehouse' -Type 'Lakehouse'
    $latest = Get-MiningBootstrapLatestReceipt $records 'LakehouseCreate'
    if ($item) {
        $receiptItemId = Get-MiningBootstrapOptionalValue $latest 'itemId'
        if ($receiptItemId -and $receiptItemId -cne $item.id) {
            throw 'The verified Mining Lakehouse ID changed; refusing to adopt a replacement item.'
        }
        $resolved = Get-MiningIsolatedLakehouseDetails $Client $WorkspaceId $item
        if ($latest -and $latest.status -in @('Submitting', 'Accepted', 'Unresolved')) {
            $resolvedStatus = 'Reconciled'
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]$item.id) @{
                operation = 'LakehouseCreate'; status = 'Reconciled'; itemId = $item.id
                operationId = Get-MiningBootstrapOptionalValue $latest 'operationId'
            }
        } else { $resolvedStatus = 'VerifiedExisting' }
        $resolved | Add-Member -NotePropertyName Status -NotePropertyValue $resolvedStatus
        return $resolved
    }
    if (Get-MiningBootstrapOptionalValue $latest 'itemId') {
        throw 'The receipt records a prior Mining Lakehouse, but it is absent from inventory; refusing to recreate it.'
    }
    if ($latest -and $latest.status -in @('Submitting', 'Accepted', 'Unresolved')) {
        $operationId = [guid]::Empty
        $priorOperationId = Get-MiningBootstrapOptionalValue $latest 'operationId'
        if (-not [guid]::TryParse([string]$priorOperationId, [ref]$operationId) -or
            $operationId -eq [guid]::Empty) {
            throw 'Lakehouse create has an unresolved pre-dispatch/response state; no retry is permitted.'
        }
        $priorRetryAfter = Get-MiningBootstrapOptionalValue $latest 'retryAfterSeconds'
        if ($null -eq $priorRetryAfter) {
            throw 'Lakehouse create has no documented Retry-After value; reconcile the operation manually.'
        }
        $operationResult = Wait-MiningBootstrapOperation $Client $operationId `
            -InitialRetryAfterSeconds ([int]$priorRetryAfter)
        if ($operationResult.Status -eq 'Failed') {
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]::Empty) @{
                operation = 'LakehouseCreate'; status = 'OperationFailed'; operationId = $operationId.ToString()
            }
            throw 'Lakehouse create operation failed; a later run may retry after fresh inventory.'
        }
        $items = Get-MiningBootstrapItems $Client $WorkspaceId
        $item = Get-MiningAnalyticsMatchingItem -Items $items `
            -DisplayName 'mining_d01_static_lakehouse' -Type 'Lakehouse'
        if (-not $operationResult.Result.id -or -not $item -or
            $item.id -cne [string]$operationResult.Result.id) {
            throw 'Lakehouse create operation result is not the unique exact-name item; no retry is permitted.'
        }
        $resolved = Get-MiningIsolatedLakehouseDetails $Client $WorkspaceId $item
        Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]$item.id) @{
            operation = 'LakehouseCreate'; status = 'Reconciled'; itemId = $item.id
            operationId = $operationId.ToString()
        }
        $resolved | Add-Member -NotePropertyName Status -NotePropertyValue 'Reconciled'
        return $resolved
    }
    if (-not $Apply) { throw 'Schema-enabled Mining Lakehouse is absent; use the explicit apply path to create it.' }

    $attemptId = [guid]::NewGuid().ToString()
    Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]::Empty) @{
        operation = 'LakehouseCreate'; status = 'Submitting'; attemptId = $attemptId
        displayName = 'mining_d01_static_lakehouse'
    }
    $operationId = $null
    try {
        $body = @{
            displayName = 'mining_d01_static_lakehouse'
            description = 'Isolated Lakehouse for the public static Mining D01 topology catalog.'
            creationPayload = @{ enableSchemas = $true }
        } | ConvertTo-Json -Depth 20 -Compress
        $response = Invoke-MiningBootstrapRequest $Client POST `
            "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/lakehouses" $body
        if ($response.statusCode -in @(200, 201)) {
            $result = $response.body
        } elseif ($response.statusCode -eq 202) {
            $operationId = [guid]::Empty
            if (-not [guid]::TryParse([string]$response.headers['x-ms-operation-id'], [ref]$operationId) -or
                $operationId -eq [guid]::Empty) {
                throw 'Lakehouse create returned 202 without a valid operation ID; reconcile before retrying.'
            }
            $retryAfter = Get-MiningBootstrapRetryAfter $response.headers 'Lakehouse create'
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]::Empty) @{
                operation = 'LakehouseCreate'; status = 'Accepted'; attemptId = $attemptId
                operationId = $operationId.ToString(); retryAfterSeconds = $retryAfter
            }
            $operationResult = Wait-MiningBootstrapOperation $Client $operationId -InitialRetryAfterSeconds $retryAfter
            if ($operationResult.Status -eq 'Failed') {
                Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]::Empty) @{
                    operation = 'LakehouseCreate'; status = 'OperationFailed'; operationId = $operationId.ToString()
                }
                throw 'Lakehouse create operation failed; a later run may retry after fresh inventory.'
            }
            $result = $operationResult.Result
        } else {
            $status = [int]$response.statusCode
            $errorCode = if ($response.body -is [Collections.IDictionary]) { [string]$response.body.errorCode } else { '' }
            $terminal = $status -ge 400 -and $status -lt 500 -and $status -ne 409
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]::Empty) @{
                operation = 'LakehouseCreate'; status = if ($terminal) { 'Failed' } else { 'Unresolved' }
                httpStatus = $status; errorCode = $errorCode
            }
            throw "Lakehouse create returned HTTP $status ($errorCode)."
        }
        $returnedId = [guid]::Empty
        if (-not $result.id -or -not [guid]::TryParse([string]$result.id, [ref]$returnedId) -or
            $returnedId -eq [guid]::Empty -or
            $result.type -cne 'Lakehouse' -or $result.displayName -cne 'mining_d01_static_lakehouse' -or
            $result.workspaceId -cne $WorkspaceId.ToString()) {
            throw 'Lakehouse create did not return the exact expected item identity; reconcile before retrying.'
        }
        $items = Get-MiningBootstrapItems $Client $WorkspaceId
        $item = Get-MiningAnalyticsMatchingItem -Items $items `
            -DisplayName 'mining_d01_static_lakehouse' -Type 'Lakehouse'
        if (-not $item -or $item.id -cne $returnedId.ToString()) {
            throw 'Lakehouse create result is not the unique exact-name item in the isolated workspace.'
        }
        $resolved = Get-MiningIsolatedLakehouseDetails $Client $WorkspaceId $item
        Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $returnedId @{
            operation = 'LakehouseCreate'; status = 'Verified'; attemptId = $attemptId
            itemId = $returnedId.ToString(); operationId = if ($operationId) { $operationId.ToString() } else { $null }
        }
        $resolved | Add-Member -NotePropertyName Status -NotePropertyValue 'CreatedAndVerified'
        return $resolved
    } catch {
        $latestAfterError = Get-MiningBootstrapLatestReceipt (
            Read-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]::Empty) -AllowAnyLakehouse) 'LakehouseCreate'
        if (-not $latestAfterError -or $latestAfterError.status -notin @('Failed', 'OperationFailed', 'Unresolved')) {
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId ([guid]::Empty) @{
                operation = 'LakehouseCreate'; status = 'Unresolved'; attemptId = $attemptId
                operationId = if ($operationId) { $operationId.ToString() } else { $null }
                retryAfterSeconds = Get-MiningBootstrapOptionalValue $latestAfterError 'retryAfterSeconds'
                error = $_.Exception.Message
            }
        }
        throw
    }
}

function Invoke-MiningBootstrapCreate {
    param(
        $Client, [guid]$WorkspaceId, [guid]$LakehouseId, [string]$ReceiptPath,
        [string]$Operation, [string]$Kind, [string]$DisplayName, [string]$Uri,
        [string]$Body, $ExpectedDefinition, [object[]]$PreimageItems, [object[]]$Records
    )
    $item = Get-MiningAnalyticsMatchingItem -Items $PreimageItems -DisplayName $DisplayName -Type $Kind
    $latest = Get-MiningBootstrapLatestReceipt $Records $Operation
    if ($item) {
        $receiptItemId = Get-MiningBootstrapOptionalValue $latest 'itemId'
        if ($receiptItemId -and $receiptItemId -cne $item.id) {
            throw "$Kind '$DisplayName' no longer matches the item ID in its receipt."
        }
        $priorStatus = Get-MiningBootstrapOptionalValue $latest 'status'
        $preimageItemIds = @(Get-MiningBootstrapOptionalValue $latest 'preimageItemIds')
        if ($priorStatus -in @('Submitting', 'Accepted', 'Unresolved') -and $item.id -in $preimageItemIds) {
            throw "$Kind '$DisplayName' was present before the uncertain create attempt; refusing to adopt it as newly created."
        }
        $actual = Get-MiningBootstrapDefinition $Client $WorkspaceId ([guid]$item.id)
        if ($Kind -eq 'DataAgent') {
            $actualParts = Get-MiningBootstrapPartMap $actual 'Data Agent'
            if (@($actualParts.Keys | Where-Object { $_ -like 'Files/Config/published/*' }).Count -gt 0) {
                Assert-MiningAgentPublished $ExpectedDefinition $actual
            } else {
                Assert-MiningAgentDefinition $ExpectedDefinition $actual
            }
        } else {
            Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $ExpectedDefinition `
                -ActualDefinition $actual -Label "$Kind '$DisplayName'"
        }
        if ($latest -and $latest.status -in @('Submitting', 'Accepted', 'Unresolved')) {
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
                operation = $Operation; status = 'Reconciled'; itemId = $item.id
                operationId = Get-MiningBootstrapOptionalValue $latest 'operationId'
            }
        }
        return [pscustomobject]@{ Item = $item; CreatedByThisRun = [bool]($receiptItemId -and $receiptItemId -eq $item.id) }
    }
    if (Get-MiningBootstrapOptionalValue $latest 'itemId') {
        throw "$Kind '$DisplayName' was previously verified but is absent from inventory; refusing to recreate it."
    }
    if ($latest -and $latest.status -in @('Submitting', 'Accepted', 'Unresolved')) {
        $operationId = [guid]::Empty
        $priorOperationId = Get-MiningBootstrapOptionalValue $latest 'operationId'
        if (-not [guid]::TryParse([string]$priorOperationId, [ref]$operationId) -or
            $operationId -eq [guid]::Empty) {
            throw "$Kind create has an unresolved pre-dispatch/response state; no retry is permitted."
        }
        $priorRetryAfter = Get-MiningBootstrapOptionalValue $latest 'retryAfterSeconds'
        if ($null -eq $priorRetryAfter) {
            throw "$Kind create has no documented Retry-After value; reconcile the operation manually."
        }
        $operationResult = Wait-MiningBootstrapOperation $Client $operationId `
            -InitialRetryAfterSeconds ([int]$priorRetryAfter)
        if ($operationResult.Status -eq 'Failed') {
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
                operation = $Operation; status = 'OperationFailed'; operationId = $operationId.ToString()
            }
            throw "$Kind create operation '$operationId' failed; a later run may retry after fresh inventory."
        }
        $result = $operationResult.Result
        if (-not $result.id) { throw "$Kind create operation succeeded without a result item ID; no retry is permitted." }
        $refreshed = Get-MiningBootstrapItems $Client $WorkspaceId
        $item = Get-MiningAnalyticsMatchingItem -Items $refreshed -DisplayName $DisplayName -Type $Kind
        if (-not $item -or $item.id -cne [string]$result.id) {
            throw "$Kind create operation result is not the unique exact-name item; no retry is permitted."
        }
        $actual = Get-MiningBootstrapDefinition $Client $WorkspaceId ([guid]$item.id)
        if ($Kind -eq 'DataAgent') { Assert-MiningAgentDefinition $ExpectedDefinition $actual }
        else {
            Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $ExpectedDefinition `
                -ActualDefinition $actual -Label "$Kind '$DisplayName'"
        }
        Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
            operation = $Operation; status = 'Reconciled'; itemId = $item.id; operationId = $operationId.ToString()
        }
        return [pscustomobject]@{ Item = $item; CreatedByThisRun = $true }
    }
    if (-not $script:ApplyMiningWrites) {
        throw "$Kind '$DisplayName' is absent; use the explicit apply path to create it."
    }
    $attemptId = [guid]::NewGuid().ToString()
    Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
        operation = $Operation; status = 'Submitting'; attemptId = $attemptId
        desiredRequestSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
                [Text.Encoding]::UTF8.GetBytes($Body))).ToLowerInvariant()
        preimageItemIds = @($PreimageItems | ForEach-Object { $_.id })
    }
    $operationId = $null
    try {
        $response = Invoke-MiningBootstrapRequest $Client POST $Uri $Body
        if ($response.statusCode -in @(200, 201)) {
            $result = $response.body
        } elseif ($response.statusCode -eq 202) {
            $operationId = [guid]::Empty
            if (-not [guid]::TryParse([string]$response.headers['x-ms-operation-id'], [ref]$operationId) -or
                $operationId -eq [guid]::Empty) {
                throw "$Kind create returned 202 without a valid operation ID; reconcile before retrying."
            }
            $retryAfter = Get-MiningBootstrapRetryAfter $response.headers "$Kind create"
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
                operation = $Operation; status = 'Accepted'; attemptId = $attemptId
                operationId = $operationId.ToString(); retryAfterSeconds = $retryAfter
            }
            $operationResult = Wait-MiningBootstrapOperation $Client $operationId -InitialRetryAfterSeconds $retryAfter
            if ($operationResult.Status -eq 'Failed') {
                Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
                    operation = $Operation; status = 'OperationFailed'; operationId = $operationId.ToString()
                }
                throw "$Kind create operation '$operationId' failed; a later run may retry after fresh inventory."
            }
            $result = $operationResult.Result
        } else {
            $status = [int]$response.statusCode
            $errorCode = if ($response.body -is [Collections.IDictionary]) { [string]$response.body.errorCode } else { '' }
            $terminal = $status -ge 400 -and $status -lt 500 -and $status -ne 409
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
                operation = $Operation; status = if ($terminal) { 'Failed' } else { 'Unresolved' }
                attemptId = $attemptId; httpStatus = $status; errorCode = $errorCode
            }
            throw "$Kind create returned HTTP $status ($errorCode)."
        }
        $returnedId = [guid]::Empty
        if (-not $result.id -or -not [guid]::TryParse([string]$result.id, [ref]$returnedId) -or
            $returnedId -eq [guid]::Empty) {
            throw "$Kind create did not return a valid item ID; reconcile before retrying."
        }
        $refreshed = Get-MiningBootstrapItems $Client $WorkspaceId
        $item = Get-MiningAnalyticsMatchingItem -Items $refreshed -DisplayName $DisplayName -Type $Kind
        if (-not $item -or $item.id -cne $returnedId.ToString() -or
            ($item.PSObject.Properties.Name -contains 'workspaceId' -and
                $item.workspaceId -cne $WorkspaceId.ToString())) {
            throw "$Kind create result is not the unique exact-name, exact-type item in the isolated workspace."
        }
        $actual = Get-MiningBootstrapDefinition $Client $WorkspaceId $returnedId
        if ($Kind -eq 'DataAgent') { Assert-MiningAgentDefinition $ExpectedDefinition $actual }
        else {
            Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $ExpectedDefinition `
                -ActualDefinition $actual -Label "$Kind '$DisplayName'"
        }
        Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
            operation = $Operation; status = 'Verified'; attemptId = $attemptId
            itemId = $returnedId.ToString(); operationId = if ($operationId) { $operationId.ToString() } else { $null }
        }
        return [pscustomobject]@{ Item = $item; CreatedByThisRun = $true }
    } catch {
        $latestAfterError = Get-MiningBootstrapLatestReceipt (Read-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId) $Operation
        if (-not $latestAfterError -or $latestAfterError.status -notin @('Failed', 'OperationFailed', 'Unresolved')) {
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
                operation = $Operation; status = 'Unresolved'; attemptId = $attemptId
                operationId = if ($operationId) { $operationId.ToString() } else { $null }
                retryAfterSeconds = Get-MiningBootstrapOptionalValue $latestAfterError 'retryAfterSeconds'
                error = $_.Exception.Message
            }
        }
        throw
    }
}

function Assert-MiningAgentPublished {
    param($ExpectedDefinition, $ActualDefinition)
    Assert-MiningAgentDefinition $ExpectedDefinition $ActualDefinition -Published
}

function Publish-MiningBootstrapAgent {
    param($Client, [guid]$WorkspaceId, [guid]$LakehouseId, [string]$ReceiptPath,
        [object[]]$Records, [guid]$AgentId, $ExpectedDefinition)
    $actual = Get-MiningBootstrapDefinition $Client $WorkspaceId $AgentId
    $parts = Get-MiningBootstrapPartMap $actual 'Data Agent'
    if (@($parts.Keys | Where-Object { $_ -like 'Files/Config/published/*' }).Count -gt 0) {
        Assert-MiningAgentPublished $ExpectedDefinition $actual
        Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
            operation = 'DataAgentPublish'; status = 'Verified'; itemId = $AgentId.ToString()
        }
        return 'AlreadyPublished'
    }
    Assert-MiningAgentDefinition $ExpectedDefinition $actual
    $latest = Get-MiningBootstrapLatestReceipt $Records 'DataAgentPublish'
    if ($latest -and $latest.status -in @('Submitting', 'Acknowledged', 'Unresolved')) {
        throw 'Data Agent publish outcome is unresolved and published parts are not verified; do not retry.'
    }
    if (-not $script:ApplyMiningWrites) { throw 'Data Agent draft is not published; use the explicit apply path to publish it.' }
    $agentCreate = Get-MiningBootstrapLatestReceipt $Records 'DataAgentCreate'
    if (-not $agentCreate -or $agentCreate.status -notin @('Verified', 'Reconciled') -or
        $agentCreate.itemId -cne $AgentId.ToString()) {
        throw 'Refusing to publish a pre-existing, unowned Data Agent draft.'
    }
    Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
        operation = 'DataAgentPublish'; status = 'Submitting'; itemId = $AgentId.ToString()
        publishedDescription = $script:PublishedDescription
    }
    try {
        $uri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/dataAgents/$AgentId/staging/publish"
        $body = @{ publishedDescription = $script:PublishedDescription } | ConvertTo-Json -Compress
        $response = Invoke-MiningBootstrapRequest $Client POST $uri $body
        Assert-MiningBootstrapStatus $response @(200)
        if ($response.body.publishedDescription -cne $script:PublishedDescription) {
            throw 'Data Agent publish response differs from the requested published description.'
        }
        Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
            operation = 'DataAgentPublish'; status = 'Acknowledged'; itemId = $AgentId.ToString()
        }
        $actual = Get-MiningBootstrapDefinition $Client $WorkspaceId $AgentId
        Assert-MiningAgentPublished $ExpectedDefinition $actual
        Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
            operation = 'DataAgentPublish'; status = 'Verified'; itemId = $AgentId.ToString()
        }
        return 'PublishedAndVerified'
    } catch {
        $latestAfterError = Get-MiningBootstrapLatestReceipt (
            Read-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId) 'DataAgentPublish'
        if ($latestAfterError.status -notin @('Unresolved', 'Verified')) {
            Add-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId @{
                operation = 'DataAgentPublish'; status = 'Unresolved'; itemId = $AgentId.ToString()
                error = $_.Exception.Message
            }
        }
        throw
    }
}

function Invoke-MiningIsolatedNativeItems {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][guid]$WorkspaceId,
        [Parameter(Mandatory)][guid]$LakehouseId,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [Parameter(Mandatory)]$Client,
        [switch]$Apply
    )
    if ($WorkspaceId -ne $script:MiningWorkspaceId -or $WorkspaceId -eq [guid]::Empty -or
        $LakehouseId -eq [guid]::Empty) {
        throw 'Only the approved isolated workspace and a nonempty Lakehouse ID are permitted.'
    }
    if (-not [IO.Path]::IsPathFullyQualified($ReceiptPath) -or
        -not (Test-Path -LiteralPath (Split-Path $ReceiptPath -Parent) -PathType Container)) {
        throw 'ReceiptPath must be absolute and in an existing private directory.'
    }
    $workspaceResponse = Invoke-MiningBootstrapRequest $Client GET "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId"
    Assert-MiningBootstrapStatus $workspaceResponse @(200)
    if ($workspaceResponse.body.id -cne $WorkspaceId.ToString()) {
        throw 'Fabric returned a different workspace identity.'
    }

    $script:ApplyMiningWrites = [bool]$Apply
    Import-Module $script:SafetyPath -Force
    $analyticsScript = Join-Path $PSScriptRoot 'New-MiningAnalyticsDefinition.ps1'
    $agentScript = Join-Path $PSScriptRoot 'New-MiningDataAgentDefinition.ps1'
    $modelRequest = (& $analyticsScript -WorkspaceId $WorkspaceId -LakehouseId $LakehouseId `
            -DefinitionKind SemanticModel).SemanticModelRequest
    $modelBody = [ordered]@{
        displayName = $script:SemanticModelName
        description = 'DirectLake semantic model for the verified static Mining D01 catalog topology; it does not represent live telemetry.'
        definition = $modelRequest.definition
    } | ConvertTo-Json -Depth 100 -Compress
    $modelHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
            [Text.Encoding]::UTF8.GetBytes($modelBody))).ToLowerInvariant()
    $agent = $null
    $agentBody = $null
    $items = Get-MiningBootstrapItems $Client $WorkspaceId
    $receipt = Read-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId
    $model = Invoke-MiningBootstrapCreate $Client $WorkspaceId $LakehouseId $ReceiptPath `
        'SemanticModelCreate' 'SemanticModel' $script:SemanticModelName `
        "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/semanticModels" `
        $modelBody $modelRequest.definition $items $receipt
    $modelId = [guid]$model.Item.id
    $agent = & $agentScript -WorkspaceId $WorkspaceId -SemanticModelId $modelId | ConvertFrom-Json -Depth 100
    $agentDefinition = $agent.definition
    $agentBody = [ordered]@{
        displayName = $script:DataAgentName
        description = $script:PublishedDescription
        definition = $agentDefinition
    } | ConvertTo-Json -Depth 100 -Compress
    $freshItems = Get-MiningBootstrapItems $Client $WorkspaceId
    $dataAgent = Invoke-MiningBootstrapCreate $Client $WorkspaceId $LakehouseId $ReceiptPath `
        'DataAgentCreate' 'DataAgent' $script:DataAgentName `
        "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/dataAgents" `
        $agentBody $agentDefinition $freshItems `
        (Read-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId)
    $publishStatus = Publish-MiningBootstrapAgent $Client $WorkspaceId $LakehouseId $ReceiptPath `
        (Read-MiningBootstrapReceipt $ReceiptPath $WorkspaceId $LakehouseId) `
        ([guid]$dataAgent.Item.id) $agentDefinition
    return [pscustomobject]@{
        Status = if ($publishStatus -in @('AlreadyPublished', 'PublishedAndVerified')) { 'Verified' } else { 'Unverified' }
        WorkspaceId = $WorkspaceId.ToString()
        LakehouseId = $LakehouseId.ToString()
        SemanticModelId = $modelId.ToString()
        SemanticModelName = $script:SemanticModelName
        DataAgentId = $dataAgent.Item.id
        DataAgentName = $script:DataAgentName
        DataAgentPublishStatus = $publishStatus
        SemanticModelRequestSha256 = $modelHash
    }
}

Export-ModuleMember -Function Ensure-MiningIsolatedLakehouse, Invoke-MiningIsolatedNativeItems
