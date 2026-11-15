#Requires -Version 7.0
<#
.SYNOPSIS
Creates the Mining D01 DirectLake semantic model and its catalog-topology report.
.DESCRIPTION
This is create-only for new items. Existing items are reused only after the model query and report
binding are verified. Every create is journaled before submission; an unresolved create is never
blindly retried.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$LakehouseId,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [string]$AzureCliPath = 'az',
    [string[]]$AzureCliPrefixArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
foreach ($id in @($SubscriptionId, $TenantId, $WorkspaceId, $LakehouseId)) {
    if ($id -eq [guid]::Empty) { throw 'Subscription, tenant, workspace, and Lakehouse IDs must be nonempty.' }
}
if (-not [IO.Path]::IsPathFullyQualified($ReceiptPath) -or
    -not (Test-Path -LiteralPath (Split-Path $ReceiptPath -Parent) -PathType Container)) {
    throw 'ReceiptPath must be an absolute path in an existing directory.'
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$definitionScript = Join-Path $root 'scripts\fabric\New-MiningAnalyticsDefinition.ps1'
$semanticModelName = 'mining-d01-topology-semanticmodel'
$script:SemanticModelName = $semanticModelName
$reportName = 'mining-d01-topology-report'
$script:RootCmdlet = $PSCmdlet
Import-Module (Join-Path $root 'scripts\fabric\MiningAnalyticsSafety.psm1') -Force

function Invoke-Az {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $allArguments = @($AzureCliPrefixArguments) + @($Arguments)
    $output = & $AzureCliPath @allArguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI command failed (exit $LASTEXITCODE): $($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

function Get-AccessToken {
    param([Parameter(Mandatory)][string]$Resource)
    $token = Invoke-Az -Arguments @(
        'account', 'get-access-token', '--subscription', $SubscriptionId,
        '--resource', $Resource, '--query', 'accessToken', '-o', 'tsv'
    )
    if ([string]::IsNullOrWhiteSpace($token)) { throw "Could not acquire an access token for '$Resource'." }
    return $token
}

function Get-FabricItems {
    param([Parameter(Mandatory)][hashtable]$Headers)
    return ,(Get-MiningAnalyticsFabricItems -WorkspaceId $WorkspaceId -Headers $Headers)
}

function Get-MatchingItem {
    param(
        [Parameter(Mandatory)][object[]]$Items,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$Type
    )
    return Get-MiningAnalyticsMatchingItem -Items $Items -DisplayName $DisplayName -Type $Type
}

function Add-Receipt {
    param([Parameter(Mandatory)][hashtable]$Record)
    $Record.utc = [DateTime]::UtcNow.ToString('o')
    $Record.workspaceId = $WorkspaceId.ToString()
    $Record | ConvertTo-Json -Depth 20 -Compress |
        Add-Content -LiteralPath $ReceiptPath -Encoding utf8
}

function Read-ReceiptHistory {
    if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) { return }
    $records = [System.Collections.Generic.List[object]]::new()
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $ReceiptPath) {
        $lineNumber++
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $record = $line | ConvertFrom-Json -AsHashtable -Depth 100
        } catch {
            throw "Receipt '$ReceiptPath' contains invalid JSON on line $lineNumber."
        }
        if (-not $record.Contains('workspaceId') -or
            $record.workspaceId -cne $WorkspaceId.ToString()) {
            throw "Receipt '$ReceiptPath' contains a malformed or cross-workspace record; refusing to continue."
        }
        $records.Add([pscustomobject]$record)
    }
    return $records.ToArray()
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Text)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
            [Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
}

function Get-HeaderValue {
    param([Parameter(Mandatory)][object]$Headers, [Parameter(Mandatory)][string]$Name)
    $value = $Headers[$Name]
    if ($value -is [array]) { return [string]$value[0] }
    return [string]$value
}

function Wait-FabricOperation {
    param([Parameter(Mandatory)][guid]$OperationId, [Parameter(Mandatory)][hashtable]$Headers)
    $state = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $state = Invoke-RestMethod -Method Get `
            -Uri "https://api.fabric.microsoft.com/v1/operations/$OperationId" -Headers $Headers
        if ($state.status -in @('Succeeded', 'Failed')) { break }
        Start-Sleep -Seconds 5
    }
    $result = $null
    if ($state -and $state.status -eq 'Succeeded') {
        try {
            $result = Invoke-RestMethod -Method Get `
                -Uri "https://api.fabric.microsoft.com/v1/operations/$OperationId/result" -Headers $Headers
        } catch {
            $statusCode = [int]$_.Exception.Response.StatusCode
            if ($statusCode -ne 404) { throw }
        }
    }
    return [pscustomobject]@{ State = $state; Result = $result }
}

function Get-FabricItemDefinition {
    param([Parameter(Mandatory)][guid]$ItemId, [Parameter(Mandatory)][hashtable]$Headers)
    $uri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items/$ItemId/getDefinition"
    $response = Invoke-WebRequest -Method Post -Uri $uri -Headers $Headers
    if ($response.StatusCode -eq 202) {
        $operationIdText = Get-HeaderValue -Headers $response.Headers -Name 'x-ms-operation-id'
        $operationId = [guid]::Empty
        if (-not [guid]::TryParse($operationIdText, [ref]$operationId) -or $operationId -eq [guid]::Empty) {
            throw "Fabric returned an invalid getDefinition operation ID for '$ItemId'."
        }
        $operation = Wait-FabricOperation -OperationId $operationId -Headers $Headers
        if ($operation.State.status -ne 'Succeeded' -or -not $operation.Result) {
            throw "Could not retrieve the native definition for item '$ItemId' (operation '$operationId')."
        }
        $body = $operation.Result
    } elseif ($response.StatusCode -in @(200, 201)) {
        $body = $response.Content | ConvertFrom-Json -AsHashtable -Depth 100
    } else {
        throw "Unexpected HTTP status $($response.StatusCode) from getDefinition for '$ItemId'."
    }
    if (-not $body.definition -or -not $body.definition.parts) {
        throw "Fabric returned no native definition parts for item '$ItemId'."
    }
    return $body.definition
}

function Assert-FabricItemDefinition {
    param(
        [Parameter(Mandatory)][guid]$ItemId,
        [Parameter(Mandatory)][object]$ExpectedDefinition,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][hashtable]$Headers
    )
    $actualDefinition = Get-FabricItemDefinition -ItemId $ItemId -Headers $Headers
    Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $ExpectedDefinition `
        -ActualDefinition $actualDefinition -Label $Label `
        -ExpectedWorkspaceName $script:WorkspaceDisplayName `
        -ExpectedSemanticModelName $script:SemanticModelName
}

function Resolve-PriorCreateReceipts {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Records,
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Items,
        [Parameter(Mandatory)][hashtable]$ExpectedDefinitions,
        [Parameter(Mandatory)][hashtable]$Headers
    )
    foreach ($pending in Get-PendingMiningAnalyticsCreates -Records $Records) {
        $attempt = $pending
        $attemptIdProperty = $attempt.PSObject.Properties['attemptId']
        $operationIdProperty = $attempt.PSObject.Properties['operationId']
        $itemIdProperty = $attempt.PSObject.Properties['itemId']
        $desiredHashProperty = $attempt.PSObject.Properties['desiredRequestSha256']
        $attemptId = if ($attemptIdProperty) { [string]$attemptIdProperty.Value } else { '' }
        $operationId = if ($operationIdProperty) { [string]$operationIdProperty.Value } else { '' }
        $desiredHash = if ($desiredHashProperty) { [string]$desiredHashProperty.Value } else { '' }
        if ([string]::IsNullOrWhiteSpace($operationId)) {
            $itemId = [guid]::Empty
            if ($itemIdProperty -and [guid]::TryParse([string]$itemIdProperty.Value, [ref]$itemId) -and
                $itemId -ne [guid]::Empty) {
                $item = @($Items | Where-Object { $_.id -eq $itemId.ToString() })
                if ($item.Count -eq 1 -and $ExpectedDefinitions.ContainsKey([string]$attempt.kind) -and
                    $item[0].displayName -ceq $attempt.displayName -and $item[0].type -ceq $attempt.kind) {
                    $matchedItem = Get-MatchingItem -Items $Items -DisplayName $attempt.displayName -Type $attempt.kind
                    if ($matchedItem.id -cne $itemId.ToString()) {
                        throw 'Receipt item ID does not match the unique item name in the workspace.'
                    }
                    Assert-FabricItemDefinition -ItemId $itemId `
                        -ExpectedDefinition $ExpectedDefinitions[[string]$attempt.kind] `
                        -Label "$($attempt.kind) '$($attempt.displayName)'" -Headers $Headers
                    Add-Receipt @{
                        status = 'Reconciled'
                        kind = $attempt.kind
                        displayName = $attempt.displayName
                        itemId = $itemId.ToString()
                        desiredRequestSha256 = $desiredHash
                        attemptId = $attemptId
                        detail = 'Verified receipt item ID and complete native definition.'
                    }
                    continue
                }
            }
            throw "Receipt has an unresolved $($attempt.kind) create for '$($attempt.displayName)' without a reconcilable operation or item ID; inspect '$ReceiptPath' before any create."
        }

        $operation = Wait-FabricOperation -OperationId $operationId -Headers $Headers
        if (-not $operation.State -or $operation.State.status -notin @('Succeeded', 'Failed')) {
            throw "Receipt operation '$operationId' is not terminal; no create may be retried."
        }
        if ($operation.State.status -eq 'Failed') {
            Add-Receipt @{
                status = 'OperationFailed'
                kind = $attempt.kind
                displayName = $attempt.displayName
                operationId = $operationId
                desiredRequestSha256 = $desiredHash
                attemptId = $attemptId
                operationStatus = 'Failed'
            }
            continue
        }

        $resultIdProperty = if ($operation.Result) { $operation.Result.PSObject.Properties['id'] } else { $null }
        if (-not $resultIdProperty -or -not $resultIdProperty.Value) {
            throw "Successful receipt operation '$operationId' has no result item ID; no create may be retried."
        }
        $itemId = [guid]::Empty
        if (-not [guid]::TryParse([string]$resultIdProperty.Value, [ref]$itemId) -or $itemId -eq [guid]::Empty) {
            throw "Successful receipt operation '$operationId' returned an invalid item ID; no create may be retried."
        }
        $item = @($Items | Where-Object { $_.id -eq $itemId.ToString() })
        if ($item.Count -ne 1 -or $item[0].displayName -cne $attempt.displayName -or
            $item[0].type -cne $attempt.kind -or
            -not $ExpectedDefinitions.ContainsKey([string]$attempt.kind)) {
            throw "Successful receipt operation '$operationId' cannot be uniquely matched to the reviewed item; no create may be retried."
        }
        $matchedItem = Get-MatchingItem -Items $Items -DisplayName $attempt.displayName -Type $attempt.kind
        if ($matchedItem.id -cne $itemId.ToString()) {
            throw "Successful receipt operation '$operationId' result does not match the unique item name; no create may be retried."
        }
        Assert-FabricItemDefinition -ItemId $itemId `
            -ExpectedDefinition $ExpectedDefinitions[[string]$attempt.kind] `
            -Label "$($attempt.kind) '$($attempt.displayName)'" -Headers $Headers
        Add-Receipt @{
            status = 'Reconciled'
            kind = $attempt.kind
            displayName = $attempt.displayName
            itemId = $itemId.ToString()
            operationId = $operationId
            desiredRequestSha256 = $desiredHash
            attemptId = $attemptId
            detail = 'Verified successful operation result and complete native definition.'
        }
    }
}

function Invoke-CreateItem {
    param(
        [Parameter(Mandatory)][string]$Kind,
        [Parameter(Mandatory)][string]$DisplayName,
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Body,
        [Parameter(Mandatory)][object]$ExpectedDefinition,
        [Parameter(Mandatory)][hashtable]$Headers,
        [Parameter(Mandatory)][object[]]$PreimageItems
    )
    $definitionHash = Get-Sha256 -Text $Body
    $preimage = @($PreimageItems | ForEach-Object { $_.id })
    $attemptId = [guid]::NewGuid().ToString()
    if (-not $script:RootCmdlet.ShouldProcess(
            "$WorkspaceId/$DisplayName", "Create Mining $Kind (definition SHA-256 $definitionHash)")) {
        return $null
    }

    Add-Receipt @{
        status = 'Submitting'
        kind = $Kind
        displayName = $DisplayName
        preimageItemIds = $preimage
        desiredRequestSha256 = $definitionHash
        attemptId = $attemptId
    }
    $operationId = $null
    $itemId = $null
    $terminalFailureRecorded = $false
    try {
        $response = Invoke-WebRequest -Method Post -Uri $Uri `
            -Headers ($Headers + @{ 'Content-Type' = 'application/json' }) -Body $Body
        $itemId = $null
        if ($response.StatusCode -eq 201 -or $response.StatusCode -eq 200) {
            $itemId = ($response.Content | ConvertFrom-Json -Depth 100).id
        } elseif ($response.StatusCode -eq 202) {
            $operationIdText = Get-HeaderValue -Headers $response.Headers -Name 'x-ms-operation-id'
            $operationId = [guid]::Empty
            if (-not [guid]::TryParse($operationIdText, [ref]$operationId) -or $operationId -eq [guid]::Empty) {
                throw "Fabric accepted $Kind creation without a valid operation ID; the outcome must be reconciled."
            }
            $operation = Wait-FabricOperation -OperationId $operationId -Headers $Headers
            if ($operation.State.status -eq 'Failed') {
                Add-Receipt @{
                    status = 'OperationFailed'
                    kind = $Kind
                    displayName = $DisplayName
                    operationId = $operationId
                    desiredRequestSha256 = $definitionHash
                    attemptId = $attemptId
                    operationStatus = 'Failed'
                }
                $terminalFailureRecorded = $true
                throw "Fabric operation '$operationId' failed; the create will not be retried in this run."
            }
            if ($operation.State.status -ne 'Succeeded') {
                throw "Fabric operation '$operationId' is not terminal; the create outcome is unresolved."
            }
            if ($operation.Result -and $operation.Result.id) { $itemId = [string]$operation.Result.id }
            Add-Receipt @{
                status = 'OperationSucceeded'
                kind = $Kind
                displayName = $DisplayName
                operationId = $operationId
                operationStatus = $operation.State.status
                desiredRequestSha256 = $definitionHash
                attemptId = $attemptId
            }
        } else {
            throw "Unexpected HTTP status $($response.StatusCode) while creating $Kind."
        }

        $items = Get-FabricItems -Headers $Headers
        $created = Get-MatchingItem -Items $items -DisplayName $DisplayName -Type $Kind
        if ($created) {
            $itemId = Assert-MiningAnalyticsCreatedItemIdentity -Item $created -ReturnedId $itemId `
                -PreimageItemIds $preimage -DisplayName $DisplayName -Type $Kind
        }
        if ([string]::IsNullOrWhiteSpace($itemId)) {
            throw "$Kind creation completed but the new item could not be resolved."
        }
        if (-not $created) {
            throw "$Kind result '$itemId' is not present as the unique exact-name, exact-type workspace item."
        }
        Assert-FabricItemDefinition -ItemId ([guid]$itemId) -ExpectedDefinition $ExpectedDefinition `
            -Label "$Kind '$DisplayName'" -Headers $Headers
        Add-Receipt @{
            status = 'Applied'
            kind = $Kind
            displayName = $DisplayName
            itemId = $itemId
            operationId = $operationId
            desiredRequestSha256 = $definitionHash
            attemptId = $attemptId
            definitionVerified = $true
        }
        return $itemId
    } catch {
        $errorMessage = $_.Exception.Message
        if ($terminalFailureRecorded) { throw $errorMessage }
        Add-Receipt @{
            status = 'Unresolved'
            kind = $Kind
            displayName = $DisplayName
            operationId = $operationId
            itemId = $itemId
            desiredRequestSha256 = $definitionHash
            attemptId = $attemptId
            error = $errorMessage
        }
        throw "The $Kind create outcome is unresolved; inspect receipt '$ReceiptPath' and operation '$operationId' before retrying. $errorMessage"
    }
}

function Invoke-ExecuteQuery {
    param(
        [Parameter(Mandatory)][guid]$DatasetId,
        [Parameter(Mandatory)][string]$Query,
        [Parameter(Mandatory)][hashtable]$Headers
    )
    $body = @{ queries = @(@{ query = $Query }) } | ConvertTo-Json -Depth 10
    $queryHeaders = @{
        Authorization = $Headers.Authorization
        Accept = 'application/json'
        'Content-Type' = 'application/json'
    }
    $response = Invoke-RestMethod -Method Post `
        -Uri "https://api.powerbi.com/v1.0/myorg/groups/$WorkspaceId/datasets/$DatasetId/executeQueries" `
        -Headers $queryHeaders -Body $body
    if ($response.results.Count -ne 1) { throw 'Power BI query returned an unexpected result count.' }
    $result = $response.results[0]
    if ($result.PSObject.Properties.Name -contains 'error' -and $result.error) {
        $errorDetail = $result.error | ConvertTo-Json -Depth 10 -Compress
        throw "Power BI query failed: $errorDetail"
    }
    if ($result.tables.Count -ne 1) { throw 'Power BI query returned no result table.' }
    return ,@($result.tables[0].rows)
}

function Invoke-ModelRefresh {
    param([Parameter(Mandatory)][guid]$DatasetId, [Parameter(Mandatory)][hashtable]$Headers)
    $refreshUri = "https://api.powerbi.com/v1.0/myorg/groups/$WorkspaceId/datasets/$DatasetId/refreshes"
    $historyUri = "$refreshUri`?`$top=5"
    $history = Invoke-RestMethod -Method Get -Uri $historyUri -Headers $Headers
    $latest = @($history.value | Sort-Object startTime -Descending | Select-Object -First 1)
    if ($latest.Count -gt 0 -and $latest[0].status -eq 'Completed') {
        return [pscustomobject]@{ Status = 'Completed'; RequestId = $latest[0].requestId }
    }

    $preimageRequestIds = @($history.value | ForEach-Object { $_.requestId } | Where-Object { $_ })
    $requestId = $null
    $correlationId = $null
    if ($latest.Count -gt 0 -and $latest[0].status -in @('InProgress', 'Unknown')) {
        $requestId = $latest[0].requestId
    } else {
        if (-not $script:RootCmdlet.ShouldProcess(
                "$WorkspaceId/$DatasetId", 'Request a full Mining DirectLake model refresh')) {
            return [pscustomobject]@{ Status = 'WhatIf'; RequestId = $null }
        }

        Add-Receipt @{
            status = 'Submitting'
            kind = 'DatasetRefresh'
            datasetId = $DatasetId.ToString()
            refreshType = 'full'
            preimageRefreshRequestIds = $preimageRequestIds
        }
        try {
            $refreshHeaders = @{
                Authorization = $Headers.Authorization
                Accept = 'application/json'
                'Content-Type' = 'application/json'
            }
            $response = Invoke-WebRequest -Method Post -Uri $refreshUri -Headers $refreshHeaders `
                -Body '{"type":"full"}'
            $correlationId = Get-HeaderValue -Headers $response.Headers -Name 'x-ms-request-id'
        } catch {
            $errorMessage = $_.Exception.Message
            try {
                $history = Invoke-RestMethod -Method Get -Uri $historyUri -Headers $Headers
                $reconciled = @($history.value | Where-Object { $_.requestId -notin $preimageRequestIds } |
                    Sort-Object startTime -Descending | Select-Object -First 1)
            } catch {
                Add-Receipt @{
                    status = 'Unresolved'
                    kind = 'DatasetRefresh'
                    datasetId = $DatasetId.ToString()
                    refreshType = 'full'
                    error = "$errorMessage; refresh reconciliation failed: $($_.Exception.Message)"
                }
                throw "The dataset refresh outcome is unresolved; reconcile receipt '$ReceiptPath' before retrying. $errorMessage"
            }
            if ($reconciled.Count -eq 0 -or $reconciled[0].status -notin @('InProgress', 'Unknown', 'Completed')) {
                Add-Receipt @{
                    status = 'Unresolved'
                    kind = 'DatasetRefresh'
                    datasetId = $DatasetId.ToString()
                    refreshType = 'full'
                    error = $errorMessage
                }
                throw "The dataset refresh outcome is unresolved; inspect receipt '$ReceiptPath' before retrying. $errorMessage"
            }
            $requestId = $reconciled[0].requestId
            Add-Receipt @{
                status = 'Reconciled'
                kind = 'DatasetRefresh'
                datasetId = $DatasetId.ToString()
                requestId = $requestId
                correlationId = $correlationId
                refreshStatus = $reconciled[0].status
            }
        }
    }

    $refreshStatus = $null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Seconds 5
        $history = Invoke-RestMethod -Method Get -Uri $historyUri -Headers $Headers
        $current = if ($requestId) {
            @($history.value | Where-Object { $_.requestId -eq $requestId } | Select-Object -First 1)
        } else {
            @($history.value | Where-Object { $_.requestId -notin $preimageRequestIds } |
                Sort-Object startTime -Descending | Select-Object -First 1)
        }
        if ($current.Count -eq 0) { continue }
        $refreshStatus = $current[0].status
        $requestId = $current[0].requestId
        if ($refreshStatus -in @('Completed', 'Failed', 'Cancelled', 'Disabled', 'TimedOut')) { break }
    }
    if ($refreshStatus -ne 'Completed') {
        Add-Receipt @{
            status = if ($refreshStatus -in @('Failed', 'Cancelled', 'Disabled', 'TimedOut')) { 'Failed' } else { 'Unresolved' }
            kind = 'DatasetRefresh'
            datasetId = $DatasetId.ToString()
            requestId = $requestId
            correlationId = $correlationId
            refreshStatus = $refreshStatus
        }
        throw "The Mining model refresh did not complete successfully (request '$requestId', status '$refreshStatus')."
    }
    Add-Receipt @{
        status = 'Applied'
        kind = 'DatasetRefresh'
        datasetId = $DatasetId.ToString()
        requestId = $requestId
        correlationId = $correlationId
        refreshStatus = $refreshStatus
    }
    return [pscustomobject]@{ Status = $refreshStatus; RequestId = $requestId }
}

function Test-MiningModel {
    param([Parameter(Mandatory)][guid]$DatasetId, [Parameter(Mandatory)][hashtable]$Headers)
    $metricsQuery = @'
EVALUATE
ROW(
    "metric_Plant count", [Plant count],
    "metric_Line count", [Line count],
    "metric_Module count", [Module count],
    "metric_Equipment count", [Equipment count],
    "metric_Tag count", [Tag count],
    "metric_Stream count", [Stream count],
    "metric_Catalog relationship count", [Catalog relationship count],
    "metric_Equipment tag coverage", [Equipment tag coverage]
)
'@
    $metricRows = Invoke-ExecuteQuery -DatasetId $DatasetId -Query $metricsQuery -Headers $Headers
    if ($metricRows.Count -ne 1) { throw 'The Mining model metrics query did not return exactly one row.' }
    $metricRow = $metricRows[0]
    $metrics = [ordered]@{}
    foreach ($name in @(
            'Plant count', 'Line count', 'Module count', 'Equipment count',
            'Tag count', 'Stream count', 'Catalog relationship count', 'Equipment tag coverage'
        )) {
        $propertyName = "[metric_$name]"
        $property = $metricRow.PSObject.Properties[$propertyName]
        if (-not $property -or $null -eq $property.Value) {
            throw "The Mining model returned no value for measure '$name'."
        }
        $metrics[$name] = $property.Value
    }
    foreach ($name in @('Plant count', 'Line count', 'Module count', 'Equipment count', 'Tag count', 'Stream count')) {
        if ([double]$metrics[$name] -le 0) { throw "The Mining DirectLake model returned an empty '$name' result." }
    }

    $visualQueries = @(
        @{ Name = 'Modules by processing line'; Query = "EVALUATE SUMMARIZECOLUMNS('Line'[label], `"visual_Modules`", [Modules per line])"; ValueColumns = @('[visual_Modules]') },
        @{ Name = 'Equipment by module'; Query = "EVALUATE SUMMARIZECOLUMNS('Module'[label], `"visual_Equipment`", [Equipment per module])"; ValueColumns = @('[visual_Equipment]') },
        @{ Name = 'Tags by equipment'; Query = "EVALUATE SUMMARIZECOLUMNS('Equipment'[label], `"visual_Tags`", [Tags per equipment])"; ValueColumns = @('[visual_Tags]') },
        @{ Name = 'Process streams by module'; Query = "EVALUATE SUMMARIZECOLUMNS('Module'[label], `"visual_Outgoing`", [Outgoing streams per module], `"visual_Incoming`", [Incoming streams per module])"; ValueColumns = @('[visual_Outgoing]', '[visual_Incoming]') }
    )
    $visualResults = @()
    foreach ($visualQuery in $visualQueries) {
        $rows = Invoke-ExecuteQuery -DatasetId $DatasetId -Query $visualQuery.Query -Headers $Headers
        if ($rows.Count -eq 0) { throw "The report visual query '$($visualQuery.Name)' returned no data." }
        $valueTotals = [ordered]@{}
        foreach ($column in $visualQuery.ValueColumns) {
            $valueTotal = 0.0
            foreach ($row in $rows) {
                $value = $row.PSObject.Properties[$column]
                if ($value -and $null -ne $value.Value) {
                    $valueTotal += [double]$value.Value
                }
            }
            if ($valueTotal -le 0) { throw "The report visual query '$($visualQuery.Name)' returned no positive '$column' counts." }
            $valueTotals[$column] = $valueTotal
        }
        $visualResults += [pscustomobject]@{
            name = $visualQuery.Name
            groups = $rows.Count
            valueTotals = $valueTotals
        }
    }
    return [pscustomobject]@{ Metrics = $metrics; VisualResults = $visualResults }
}

$account = Invoke-Az -Arguments @(
    'account', 'show', '--subscription', $SubscriptionId,
    '--query', '{id:id,tenantId:tenantId}', '-o', 'json'
) | ConvertFrom-Json
if ($account.id -ne $SubscriptionId.ToString() -or $account.tenantId -ne $TenantId.ToString()) {
    throw 'The Azure CLI principal is not in the explicitly selected subscription and tenant.'
}
$principalId = Invoke-Az -Arguments @('ad', 'signed-in-user', 'show', '--query', 'id', '-o', 'tsv')
if ([string]::IsNullOrWhiteSpace($principalId)) { throw 'Could not resolve the current Azure CLI user object ID.' }

$fabricToken = Get-AccessToken -Resource 'https://api.fabric.microsoft.com'
$fabricHeaders = @{ Authorization = "Bearer $fabricToken"; Accept = 'application/json' }
$workspace = Invoke-RestMethod -Method Get `
    -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId" -Headers $fabricHeaders
if ($workspace.id -ne $WorkspaceId.ToString() -or
    [string]::IsNullOrWhiteSpace([string]$workspace.displayName)) {
    throw 'Fabric returned a different workspace identity or an empty workspace name.'
}
$script:WorkspaceDisplayName = [string]$workspace.displayName
$lakehouse = Invoke-RestMethod -Method Get `
    -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/lakehouses/$LakehouseId" -Headers $fabricHeaders
if ($lakehouse.id -ne $LakehouseId.ToString() -or
    $lakehouse.workspaceId -ne $WorkspaceId.ToString() -or
    $lakehouse.properties.defaultSchema -cne 'dbo' -or
    $lakehouse.properties.sqlEndpointProperties.provisioningStatus -cne 'Success') {
    throw 'The selected Lakehouse does not have the verified dbo schema and ready SQL endpoint.'
}
$roleResponse = Invoke-RestMethod -Method Get `
    -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/roleAssignments" -Headers $fabricHeaders
$callerRoles = @($roleResponse.value | Where-Object {
        $_.principal.id -eq $principalId -and $_.principal.type -ceq 'User'
    } | ForEach-Object { $_.role })
if (@($callerRoles | Where-Object { $_ -in @('Admin', 'Member', 'Contributor') }).Count -eq 0) {
    throw 'The current user has no workspace role that permits creating Mining analytics items.'
}

$items = Get-FabricItems -Headers $fabricHeaders
$modelItem = Get-MatchingItem -Items $items -DisplayName $semanticModelName -Type 'SemanticModel'
$reportItem = Get-MatchingItem -Items $items -DisplayName $reportName -Type 'Report'
if ($reportItem -and -not $modelItem) {
    throw "Mining report '$reportName' exists without its semantic model; refusing to rebind or replace it."
}

$modelRequest = (& $definitionScript -WorkspaceId $WorkspaceId -LakehouseId $LakehouseId `
        -DefinitionKind SemanticModel).SemanticModelRequest
$modelId = $null
if ($modelItem) { $modelId = [guid]$modelItem.id }
$expectedDefinitions = @{ SemanticModel = $modelRequest.definition }
$reportRequest = $null
if ($modelId) {
    $reportRequest = (& $definitionScript -WorkspaceId $WorkspaceId -LakehouseId $LakehouseId `
            -SemanticModelId $modelId -DefinitionKind Report).ReportRequest
    $expectedDefinitions.Report = $reportRequest.definition
}
$receiptRecords = @(Read-ReceiptHistory)
if ($WhatIfPreference) {
    $pendingCreates = @(Get-PendingMiningAnalyticsCreates -Records $receiptRecords)
    if ($pendingCreates.Count -gt 0) {
        throw "Receipt '$ReceiptPath' has unresolved create attempts; reconcile them before running deployment."
    }
}
else {
    Resolve-PriorCreateReceipts -Records $receiptRecords -Items $items `
        -ExpectedDefinitions $expectedDefinitions -Headers $fabricHeaders
}

if ($modelItem) {
    Assert-FabricItemDefinition -ItemId $modelId -ExpectedDefinition $modelRequest.definition `
        -Label "SemanticModel '$semanticModelName'" -Headers $fabricHeaders
}
if ($reportItem) {
    Assert-FabricItemDefinition -ItemId ([guid]$reportItem.id) -ExpectedDefinition $reportRequest.definition `
        -Label "Report '$reportName'" -Headers $fabricHeaders
}

if (-not $modelItem -and $WhatIfPreference) {
    $modelBody = $modelRequest | ConvertTo-Json -Depth 100
    [void]$PSCmdlet.ShouldProcess(
        "$WorkspaceId/$semanticModelName",
        "Create Mining SemanticModel (definition SHA-256 $(Get-Sha256 $modelBody))")
    return [pscustomobject]@{
        Status = 'WhatIf'
        WorkspaceId = $WorkspaceId
        LakehouseId = $LakehouseId
        SemanticModelName = $semanticModelName
        ReportName = $reportName
    }
} else {
    if (-not $modelItem) {
        $modelBody = $modelRequest | ConvertTo-Json -Depth 100
        $createdId = Invoke-CreateItem -Kind 'SemanticModel' -DisplayName $semanticModelName `
            -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/semanticModels" `
            -Body $modelBody -ExpectedDefinition $modelRequest.definition `
            -Headers $fabricHeaders -PreimageItems $items
        if (-not $createdId) {
            return [pscustomobject]@{ Status = 'WhatIf'; SemanticModelName = $semanticModelName; ReportName = $reportName }
        }
        $modelId = [guid]$createdId
    }
}

$powerBiToken = Get-AccessToken -Resource 'https://analysis.windows.net/powerbi/api'
$powerBiHeaders = @{ Authorization = "Bearer $powerBiToken"; Accept = 'application/json' }
$refreshResult = Invoke-ModelRefresh -DatasetId $modelId -Headers $powerBiHeaders
if ($refreshResult.Status -eq 'WhatIf') {
    return [pscustomobject]@{
        Status = 'ModelRefreshWhatIf'
        WorkspaceId = $WorkspaceId
        SemanticModelId = $modelId
        ReportName = $reportName
    }
}
$modelResults = Test-MiningModel -DatasetId $modelId -Headers $powerBiHeaders

if (-not $reportRequest) {
    $reportRequest = (& $definitionScript -WorkspaceId $WorkspaceId -LakehouseId $LakehouseId `
            -SemanticModelId $modelId -DefinitionKind Report).ReportRequest
}
$reportId = $null
if ($reportItem) {
    $reportId = [guid]$reportItem.id
} else {
    $reportBody = $reportRequest | ConvertTo-Json -Depth 100
    $createdId = Invoke-CreateItem -Kind 'Report' -DisplayName $reportName `
        -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/reports" `
        -Body $reportBody -ExpectedDefinition $reportRequest.definition `
        -Headers $fabricHeaders -PreimageItems (Get-FabricItems -Headers $fabricHeaders)
    if (-not $createdId) {
        return [pscustomobject]@{
            Status = 'ModelVerifiedReportWhatIf'
            WorkspaceId = $WorkspaceId
            SemanticModelId = $modelId
            Metrics = $modelResults.Metrics
            VisualResults = $modelResults.VisualResults
        }
    }
    $reportId = [guid]$createdId
}

$reportResponse = Invoke-RestMethod -Method Get `
    -Uri "https://api.powerbi.com/v1.0/myorg/groups/$WorkspaceId/reports/$reportId" -Headers $powerBiHeaders
if ($reportResponse.id -ne $reportId.ToString() -or $reportResponse.datasetId -ne $modelId.ToString()) {
    throw 'The Power BI report readback is not bound to the verified Mining semantic model.'
}

[pscustomobject]@{
    Status = 'Verified'
    WorkspaceId = $WorkspaceId
    LakehouseId = $LakehouseId
    SemanticModelId = $modelId
    SemanticModelName = $semanticModelName
    ReportId = $reportId
    ReportName = $reportName
    ReportWebUrl = $reportResponse.webUrl
    RefreshStatus = $refreshResult.Status
    Metrics = $modelResults.Metrics
    VisualResults = $modelResults.VisualResults
}
