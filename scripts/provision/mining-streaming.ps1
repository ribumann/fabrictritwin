# Invoked only by provision-fabric-items.ps1 -Profile MiningStreaming.

if ($ExistingWorkspaceId -eq [guid]::Empty -or $TenantId -eq [guid]::Empty) {
    throw 'MiningStreaming requires explicit ExistingWorkspaceId and TenantId.'
}
if ($NamePrefix -notmatch '^mining-[a-z0-9]+(?:-[a-z0-9]+)*$' -or $NamePrefix.Length -gt 40) {
    throw 'MiningStreaming requires a mining- prefixed lowercase name of at most 40 characters.'
}
if (-not $ReceiptPath -or -not [IO.Path]::IsPathFullyQualified($ReceiptPath) -or
    -not (Test-Path -LiteralPath (Split-Path $ReceiptPath -Parent) -PathType Container)) {
    throw 'ReceiptPath must be an absolute path in an existing private directory.'
}
if (Test-Path -LiteralPath $ReceiptPath) {
    throw 'ReceiptPath already exists. Reconcile its recorded operations before any further provisioning.'
}

Assert-AzureContext -SubscriptionId $SubscriptionId
$account = Invoke-Az -Arguments @('account', 'show', '-o', 'json') -AsJson
if ($account.tenantId -ne $TenantId.ToString()) { throw 'The selected subscription belongs to a different tenant.' }
$headers = Get-FabricAuthHeaders
$capacity = Get-FabricCapacityByDisplayName -CapacityName $FabricCapacityName -Headers $headers
$workspaceId = $ExistingWorkspaceId.ToString()
$workspace = (Invoke-FabricRestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId" -Headers $headers).Body
if ($workspace.id -ne $workspaceId -or $workspace.capacityId -ne $capacity.id) {
    throw 'The existing workspace is not on the explicitly selected capacity. No assignment or capacity change is permitted by this profile.'
}

foreach ($name in @("$NamePrefix-eventhouse", "$NamePrefix-realtime", "$NamePrefix-eventstream")) {
    if (Get-FabricItemByDisplayName -WorkspaceId $workspaceId -DisplayName $name -Headers $headers) {
        throw "An item named '$name' already exists. Reconcile its ownership and definition; this profile never adopts or updates existing items."
    }
}

function Write-MiningProvisionReceipt {
    param([hashtable]$Record)
    if (-not $WhatIfPreference) {
        $Record.utc = [DateTime]::UtcNow.ToString('o')
        $Record.workspaceId = $workspaceId
        $Record.capacityId = $capacity.id
        $Record | ConvertTo-Json -Depth 20 -Compress | Add-Content -LiteralPath $ReceiptPath -Encoding utf8
    }
}

function New-MiningStreamingItem {
    param(
        [string]$Type,
        [string]$Collection,
        [string]$DisplayName,
        [string]$TemplatePath,
        [string]$DefinitionSourceRoot,
        [hashtable]$Overrides = @{}
    )

    $request = New-RequestBodyFromTemplate -TemplatePath $TemplatePath -Replacements $replacements `
        -DefinitionSourceRoot $DefinitionSourceRoot -DefinitionSourceOverrides $Overrides | ConvertFrom-Json -Depth 100
    $request.description = 'Isolated D01 mining sample. Independent of triathlon artifacts.'
    foreach ($part in @($request.definition.parts | Where-Object path -eq '.platform')) {
        $metadata = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json -Depth 100
        $metadata.metadata.description = $request.description
        $metadata.config.logicalId = [guid]::NewGuid().ToString()
        $part.payload = ConvertTo-Utf8Base64 -Text ($metadata | ConvertTo-Json -Depth 100 -Compress)
    }
    $body = $request | ConvertTo-Json -Depth 100 -Compress
    if (-not $script:RootCmdlet.ShouldProcess("$workspaceId/$DisplayName", "Create isolated mining $Type")) {
        return [pscustomobject]@{ id = [guid]::Empty.ToString(); type = $Type; displayName = $DisplayName; status = 'WhatIf' }
    }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($body))).ToLowerInvariant()
    Write-MiningProvisionReceipt @{ status = 'Submitting'; type = $Type; displayName = $DisplayName; requestSha256 = $hash }
    try {
        $response = Invoke-FabricRestMethod -Method Post -Uri "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/$Collection" `
            -Headers $headers -Body $body -DisplayNameRetryDelaysSeconds @()
        $created = Get-FabricItemByDisplayName -WorkspaceId $workspaceId -DisplayName $DisplayName -Headers $headers -ExpectedType $Type
        if (-not $created -or $created.type -ne $Type -or -not $created.id -or
            ($response.Body.id -and $response.Body.id -ne $created.id)) {
            throw 'The create result could not be reconciled with exact-name, exact-type inventory.'
        }
        Write-MiningProvisionReceipt @{
            status = 'Created'; type = $Type; displayName = $DisplayName; id = $created.id; requestSha256 = $hash
            operationId = Get-FabricResponseHeaderValue -Headers $response.Headers -Name 'x-ms-operation-id'
        }
        return $created
    }
    catch {
        Write-MiningProvisionReceipt @{ status = 'Unresolved'; type = $Type; displayName = $DisplayName; requestSha256 = $hash }
        throw
    }
}

$replacements = @{
    NAME_PREFIX = $NamePrefix
    EVENTHOUSE_WORKSPACE_ID = $workspaceId
    TELEMETRY_CONNECTION_NAME = New-EventstreamConnectionName -NamePrefix $NamePrefix -Suffix 'telemetry'
    STATE_CONNECTION_NAME = New-EventstreamConnectionName -NamePrefix $NamePrefix -Suffix 'state'
}
$miningRoot = Join-Path $infraFabricRoot 'mining-streaming'
$createdEventhouse = New-MiningStreamingItem -Type 'Eventhouse' -Collection 'eventhouses' `
    -DisplayName "$NamePrefix-eventhouse" -TemplatePath (Join-Path $eventhouseRoot 'create-eventhouse.request.json') `
    -DefinitionSourceRoot $eventhouseRoot
$replacements.EVENTHOUSE_ITEM_ID = $createdEventhouse.id

$createdDatabase = New-MiningStreamingItem -Type 'KQLDatabase' -Collection 'kqlDatabases' `
    -DisplayName "$NamePrefix-realtime" -TemplatePath (Join-Path $eventhouseRoot 'create-kql-database.request.json') `
    -DefinitionSourceRoot $eventhouseRoot -Overrides @{
        DATABASE_SCHEMA_B64 = Join-Path $miningRoot 'MiningRawSchema.kql'
        DATABASE_PROPERTIES_B64 = Join-Path $miningRoot 'DatabaseProperties.json'
    }
$replacements.KQLDATABASE_ITEM_ID = $createdDatabase.id

if (-not $WhatIfPreference) {
    $databaseDetail = (Invoke-FabricRestMethod -Method Get `
            -Uri "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/kqlDatabases/$($createdDatabase.id)" `
            -Headers $headers).Body
    $queryServiceUri = [uri]$databaseDetail.properties.queryServiceUri
    if ($databaseDetail.id -ne $createdDatabase.id -or
        $databaseDetail.displayName -ne "$NamePrefix-realtime" -or
        -not $queryServiceUri.IsAbsoluteUri -or $queryServiceUri.Scheme -ne 'https' -or
        $queryServiceUri.Host -notlike '*.kusto.fabric.microsoft.com') {
        throw 'The created mining database did not return its exact identity and an HTTPS Fabric Kusto endpoint.'
    }

    $kustoToken = ((Invoke-Az -Arguments @(
                'account', 'get-access-token',
                '--resource', $queryServiceUri.GetLeftPart([UriPartial]::Authority),
                '--query', 'accessToken',
                '-o', 'tsv'
            )) -join '').Trim()
    if ([string]::IsNullOrWhiteSpace($kustoToken)) {
        throw 'Failed to acquire a Kusto access token for the verified mining database endpoint.'
    }

    foreach ($tableName in @('mining_TelemetryRaw', 'mining_PlantStateEvents')) {
        $alterCommand = ".alter table $tableName policy ingestiontime true"
        $alterHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
                [Text.Encoding]::UTF8.GetBytes($alterCommand))).ToLowerInvariant()
        Write-MiningProvisionReceipt @{
            status = 'ApplyingIngestionTimePolicy'; databaseId = $createdDatabase.id
            table = $tableName; requestSha256 = $alterHash
        }
        try {
            $body = @{ db = "$NamePrefix-realtime"; csl = $alterCommand } | ConvertTo-Json -Compress
            Invoke-RestMethod -Method Post -Uri "$($queryServiceUri.GetLeftPart([UriPartial]::Authority))/v1/rest/mgmt" `
                -Headers @{ Authorization = "Bearer $kustoToken"; Accept = 'application/json' } `
                -ContentType 'application/json' -Body $body | Out-Null

            $verifyCommand = ".show table $tableName policy ingestiontime"
            $verifyBody = @{ db = "$NamePrefix-realtime"; csl = $verifyCommand } | ConvertTo-Json -Compress
            $verification = Invoke-RestMethod -Method Post `
                -Uri "$($queryServiceUri.GetLeftPart([UriPartial]::Authority))/v1/rest/mgmt" `
                -Headers @{ Authorization = "Bearer $kustoToken"; Accept = 'application/json' } `
                -ContentType 'application/json' -Body $verifyBody
            $policy = $verification.Tables[0].Rows[0][2] | ConvertFrom-Json
            if (-not $policy.IsEnabled) { throw "Ingestion-time policy verification failed for '$tableName'." }
            Write-MiningProvisionReceipt @{
                status = 'IngestionTimePolicyEnabled'; databaseId = $createdDatabase.id; table = $tableName
            }
        }
        catch {
            Write-MiningProvisionReceipt @{
                status = 'UnresolvedIngestionTimePolicy'; databaseId = $createdDatabase.id; table = $tableName
                requestSha256 = $alterHash
            }
            throw
        }
    }
}

$createdEventstream = New-MiningStreamingItem -Type 'Eventstream' -Collection 'items' `
    -DisplayName "$NamePrefix-eventstream" -TemplatePath (Join-Path $eventstreamRoot 'create-eventstream.request.json') `
    -DefinitionSourceRoot $eventstreamRoot -Overrides @{
        EVENTSTREAM_TOPOLOGY_B64 = Join-Path $miningRoot 'eventstream.json'
    }
Write-MiningProvisionReceipt @{ status = 'ItemsCreatedNotIngestionVerified'; eventhouseId = $createdEventhouse.id; databaseId = $createdDatabase.id; eventstreamId = $createdEventstream.id }
[pscustomobject]@{
    workspaceId = $workspaceId; capacityId = $capacity.id
    eventhouseId = $createdEventhouse.id; databaseId = $createdDatabase.id; eventstreamId = $createdEventstream.id
    status = $(if ($WhatIfPreference) { 'WhatIf' } else { 'ItemsCreatedNotIngestionVerified' })
}
