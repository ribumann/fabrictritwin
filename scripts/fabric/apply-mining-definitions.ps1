#Requires -Version 7.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$EventhouseId,
    [Parameter(Mandatory)][guid]$KqlDatabaseId,
    [Parameter(Mandatory)][string]$ReceiptPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$script:RootCmdlet = $PSCmdlet

foreach ($id in @($SubscriptionId, $TenantId, $WorkspaceId, $EventhouseId, $KqlDatabaseId)) {
    if ($id -eq [guid]::Empty) { throw 'Target identifiers must be nonempty.' }
}
if (-not [IO.Path]::IsPathFullyQualified($ReceiptPath) -or
    -not (Test-Path -LiteralPath (Split-Path $ReceiptPath -Parent) -PathType Container)) {
    throw 'ReceiptPath must be an absolute path in an existing private directory.'
}
if (Test-Path -LiteralPath $ReceiptPath) {
    throw 'ReceiptPath already exists. Reconcile its recorded operations before applying definitions again.'
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\infra\fabric\eventhouse')).Path
$schemaPath = Join-Path $root 'MiningSchema.kql'
$validationPath = Join-Path $root 'MiningValidation.kql'
$queriesPath = Join-Path $root 'MiningQueries.kql'

function Invoke-Az {
    param([string[]]$Arguments)
    $output = & az @Arguments --subscription $SubscriptionId 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ') failed (exit $LASTEXITCODE): $($output -join [Environment]::NewLine)"
    }
    return ($output -join [Environment]::NewLine).Trim()
}

function Invoke-FabricGet {
    param([string]$Uri, [hashtable]$Headers)
    return Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers
}

function Invoke-KustoManagement {
    param([string]$Command)
    $body = @{ db = $databaseName; csl = $Command } | ConvertTo-Json -Compress
    return Invoke-RestMethod -Method Post -Uri "$($kustoUri.GetLeftPart([UriPartial]::Authority))/v1/rest/mgmt" `
        -Headers @{ Authorization = "Bearer $kustoToken"; Accept = 'application/json' } `
        -ContentType 'application/json' -Body $body
}

function Get-KustoRows {
    param([string]$Command)
    $response = Invoke-KustoManagement -Command $Command
    if (-not $response.Tables -or $response.Tables.Count -lt 1) {
        throw "Kusto command returned no result table: $Command"
    }
    return ,@($response.Tables[0].Rows)
}

function Get-ExpectedTableColumns {
    param([string]$Definition)
    $columns = @()
    foreach ($column in $Definition.Split(',')) {
        $parts = $column.Trim().Split(':')
        if ($parts.Count -ne 2) { throw 'MiningSchema.kql contains an unsupported table column declaration.' }
        $columns += [pscustomobject]@{ Name = $parts[0]; CslType = $parts[1] }
    }
    return ,$columns
}

function Assert-TableSchema {
    param([string]$TableName, [object[]]$ExpectedColumns)
    $rows = Get-KustoRows -Command ".show table $TableName schema as json"
    if ($rows.Count -ne 1 -or $rows[0].Count -lt 2) {
        throw "Could not read the exact schema for mining table '$TableName'."
    }
    $schema = $rows[0][1] | ConvertFrom-Json -Depth 20
    $actualColumns = @($schema.OrderedColumns | ForEach-Object {
            [pscustomobject]@{ Name = $_.Name; CslType = $_.CslType }
        })
    if ($actualColumns.Count -ne $ExpectedColumns.Count) {
        throw "Mining table '$TableName' has a schema drift; no columns were changed."
    }
    for ($index = 0; $index -lt $ExpectedColumns.Count; $index++) {
        if ($actualColumns[$index].Name -cne $ExpectedColumns[$index].Name -or
            $actualColumns[$index].CslType -cne $ExpectedColumns[$index].CslType) {
            throw "Mining table '$TableName' has a schema drift; no columns were changed."
        }
    }
}

function Write-MiningReceipt {
    param([hashtable]$Record)
    $Record.utc = [DateTime]::UtcNow.ToString('o')
    $Record.workspaceId = $WorkspaceId.ToString()
    $Record.eventhouseId = $EventhouseId.ToString()
    $Record.databaseId = $KqlDatabaseId.ToString()
    $Record | ConvertTo-Json -Depth 10 -Compress | Add-Content -LiteralPath $ReceiptPath -Encoding utf8
}

function Invoke-MiningDefinitionWrite {
    param(
        [string]$Kind,
        [string]$Name,
        [string]$Command
    )
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
            [Text.Encoding]::UTF8.GetBytes($Command))).ToLowerInvariant()
    if (-not $script:RootCmdlet.ShouldProcess("$databaseName/$Name", "Apply mining $Kind")) { return }
    Write-MiningReceipt @{ status = 'Submitting'; kind = $Kind; name = $Name; commandSha256 = $hash }
    try {
        Invoke-KustoManagement -Command $Command | Out-Null
        Write-MiningReceipt @{ status = 'Applied'; kind = $Kind; name = $Name; commandSha256 = $hash }
    }
    catch {
        Write-MiningReceipt @{ status = 'Unresolved'; kind = $Kind; name = $Name; commandSha256 = $hash }
        throw
    }
}

$account = Invoke-Az -Arguments @('account', 'show', '--query', '{id:id,tenantId:tenantId}', '-o', 'json') |
    ConvertFrom-Json
if ($account.id -ne $SubscriptionId.ToString() -or $account.tenantId -ne $TenantId.ToString()) {
    throw 'The active Azure CLI account does not match the explicitly selected subscription and tenant.'
}

$fabricToken = Invoke-Az -Arguments @(
    'account', 'get-access-token', '--resource', 'https://api.fabric.microsoft.com',
    '--query', 'accessToken', '-o', 'tsv'
)
if ([string]::IsNullOrWhiteSpace($fabricToken)) { throw 'Failed to acquire a Fabric API access token.' }
$fabricHeaders = @{ Authorization = "Bearer $fabricToken"; Accept = 'application/json' }
$workspace = Invoke-FabricGet -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId" -Headers $fabricHeaders
if ($workspace.id -ne $WorkspaceId.ToString()) { throw 'Fabric returned a different workspace identity.' }
$itemsResponse = Invoke-FabricGet -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items" -Headers $fabricHeaders
$items = @($itemsResponse.value)
$eventhouse = @($items | Where-Object {
        $_.id -eq $EventhouseId.ToString() -and $_.type -ceq 'Eventhouse' -and $_.displayName -ceq 'mining-d01-eventhouse'
    })
$database = @($items | Where-Object {
        $_.id -eq $KqlDatabaseId.ToString() -and $_.type -ceq 'KQLDatabase' -and $_.displayName -ceq 'mining-d01-realtime'
    })
if ($eventhouse.Count -ne 1 -or $database.Count -ne 1) {
    throw 'The explicitly selected items are not the exact isolated mining Eventhouse and KQL database.'
}
$databaseDetail = Invoke-FabricGet `
    -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/kqlDatabases/$KqlDatabaseId" `
    -Headers $fabricHeaders
if ($databaseDetail.id -ne $KqlDatabaseId.ToString() -or
    $databaseDetail.properties.parentEventhouseItemId -ne $EventhouseId.ToString()) {
    throw 'The selected KQL database is not bound to the selected mining Eventhouse.'
}
$databaseName = $databaseDetail.displayName
$kustoUri = [uri]$databaseDetail.properties.queryServiceUri
if (-not $kustoUri.IsAbsoluteUri -or $kustoUri.Scheme -ne 'https' -or
    $kustoUri.Host -notlike '*.kusto.fabric.microsoft.com') {
    throw 'The mining database did not return a verified HTTPS Fabric Kusto endpoint.'
}
$kustoToken = Invoke-Az -Arguments @(
    'account', 'get-access-token', '--resource', $kustoUri.GetLeftPart([UriPartial]::Authority),
    '--query', 'accessToken', '-o', 'tsv'
)
if ([string]::IsNullOrWhiteSpace($kustoToken)) { throw 'Failed to acquire a Kusto access token.' }

$schemaText = [IO.File]::ReadAllText($schemaPath)
$tableDefinitions = @([regex]::Matches($schemaText, '(?m)^\.create table (mining_\w+) \(([^)]+)\)\r?$') |
    ForEach-Object {
        [pscustomobject]@{
            Name = $_.Groups[1].Value
            Definition = $_.Groups[2].Value
            Columns = Get-ExpectedTableColumns -Definition $_.Groups[2].Value
        }
    })
$expectedTableNames = @(
    'mining_TelemetryRaw', 'mining_PlantStateEvents', 'mining_PlantCatalog',
    'mining_PublishProfile', 'mining_SourceContract', 'mining_ValidatedTelemetry',
    'mining_ValidatedState', 'mining_Quarantine', 'mining_AlertTransitions', 'mining_IncidentLedger'
)
if ($tableDefinitions.Count -ne $expectedTableNames.Count -or
    @($tableDefinitions.Name | Where-Object { $_ -cnotin $expectedTableNames }).Count -ne 0) {
    throw 'MiningSchema.kql has an unexpected mining table inventory.'
}

$functionNames = @()
$functionCommands = @()
foreach ($path in @($validationPath, $queriesPath)) {
    $text = [IO.File]::ReadAllText($path)
    $matches = [regex]::Matches($text, '(?m)^\.create-or-alter function\b')
    for ($index = 0; $index -lt $matches.Count; $index++) {
        $start = $matches[$index].Index
        $end = if ($index + 1 -lt $matches.Count) { $matches[$index + 1].Index } else { $text.Length }
        $command = $text.Substring($start, $end - $start).Trim()
        $nameMatch = [regex]::Match($command, '(?m)^\.create-or-alter function with \(folder = "[^"]+"\) (mining_\w+)\(')
        if (-not $nameMatch.Success) { throw "Could not identify a mining function in '$path'." }
        $functionNames += $nameMatch.Groups[1].Value
        $functionCommands += [pscustomobject]@{ Name = $nameMatch.Groups[1].Value; Command = $command }
    }
}
$expectedFunctionNames = @(
    'mining_SourceReadiness', 'mining_ClassifyTelemetry', 'mining_ClassifyState',
    'mining_DeduplicatedTelemetry', 'mining_DeduplicatedState', 'mining_PlantLatest',
    'mining_PlantSummary', 'mining_AssetTrend', 'mining_ActiveIncidents', 'mining_CompareLines'
)
if ($functionNames.Count -ne $expectedFunctionNames.Count -or
    @($functionNames | Where-Object { $_ -cnotin $expectedFunctionNames }).Count -ne 0 -or
    @($functionNames | Group-Object | Where-Object Count -ne 1).Count -ne 0) {
    throw 'Mining validation/query files have an unexpected function inventory.'
}

$tableRows = Get-KustoRows -Command '.show tables | project TableName'
$existingTables = @($tableRows | ForEach-Object { $_[0] })
foreach ($definition in $tableDefinitions) {
    if ($definition.Name -cin $existingTables) {
        Assert-TableSchema -TableName $definition.Name -ExpectedColumns $definition.Columns
    }
}

$expectedMappings = @(
    @{
        Table = 'mining_TelemetryRaw'; Name = 'mining_telemetry_raw_json_map'
        Json = '[{"column":"event","Properties":{"path":"$"}},{"column":"timestamp_raw","Properties":{"path":"$.timestamp"}}]'
    },
    @{
        Table = 'mining_PlantStateEvents'; Name = 'mining_state_raw_json_map'
        Json = '[{"column":"event","Properties":{"path":"$"}},{"column":"timestamp_raw","Properties":{"path":"$.timestamp"}}]'
    }
)
foreach ($mapping in $expectedMappings) {
    $rows = Get-KustoRows -Command ".show table $($mapping.Table) ingestion mappings"
    $matches = @($rows | Where-Object { $_[0] -ceq $mapping.Name })
    if ($matches.Count -ne 1) { throw "Expected exactly one deployed mapping '$($mapping.Name)'." }
    $actual = @((ConvertFrom-Json $matches[0][2]) | ForEach-Object {
            [pscustomobject]@{ Column = $_.column; Path = $_.path }
        })
    $expected = @((ConvertFrom-Json $mapping.Json) | ForEach-Object {
            [pscustomobject]@{ Column = $_.column; Path = $_.Properties.path }
        })
    if (($actual | ConvertTo-Json -Compress) -cne ($expected | ConvertTo-Json -Compress)) {
        throw "The deployed mapping '$($mapping.Name)' differs from the isolated Eventstream contract."
    }
}

foreach ($tableName in @('mining_TelemetryRaw', 'mining_PlantStateEvents')) {
    $rows = Get-KustoRows -Command ".show table $tableName policy ingestiontime"
    if ($rows.Count -ne 1 -or -not ($rows[0][2] | ConvertFrom-Json).IsEnabled) {
        throw "Ingestion-time policy is not enabled on '$tableName'."
    }
}

$retentionCommands = @([regex]::Matches(
        $schemaText, '(?m)^\.alter-merge table (mining_\w+) policy retention softdelete = (\d+)d\r?$'
    ) | ForEach-Object {
        [pscustomobject]@{ Name = $_.Groups[1].Value; Days = [int]$_.Groups[2].Value }
    })
if ($retentionCommands.Count -ne 7) { throw 'MiningSchema.kql has an unexpected retention policy inventory.' }

$functionRows = Get-KustoRows -Command '.show functions | project Name'
$existingFunctions = @($functionRows | ForEach-Object { $_[0] })
$unexpectedMiningFunctions = @($existingFunctions | Where-Object {
        $_ -like 'mining_*' -and $_ -cnotin $expectedFunctionNames
    })
if ($unexpectedMiningFunctions.Count -gt 0) {
    throw "Unexpected mining-owned functions exist: $($unexpectedMiningFunctions -join ', ')."
}

$pendingTables = @($tableDefinitions | Where-Object { $_.Name -cnotin $existingTables })
if ($WhatIfPreference) {
    [pscustomobject]@{
        status = 'WhatIf'
        workspaceId = $WorkspaceId.ToString()
        eventhouseId = $EventhouseId.ToString()
        databaseId = $KqlDatabaseId.ToString()
        tablesToCreate = @($pendingTables | ForEach-Object { $_.Name })
        retentionPoliciesToApply = $retentionCommands.Count
        functionsToApply = $expectedFunctionNames
        readinessChanged = $false
        materializationEnabled = $false
    }
    return
}

$sourceHashes = @{}
foreach ($path in @($schemaPath, $validationPath, $queriesPath)) {
    $relative = [IO.Path]::GetRelativePath((Resolve-Path (Join-Path $PSScriptRoot '..\..\')).Path, $path).Replace('\', '/')
    $sourceHashes[$relative] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
Write-MiningReceipt @{
    status = 'Started'
    sourceHashes = $sourceHashes
    tables = $expectedTableNames
    functions = $expectedFunctionNames
    readinessChanged = $false
    materializationEnabled = $false
}

foreach ($definition in $pendingTables) {
    $command = ".create-merge table $($definition.Name) ($($definition.Definition))"
    Invoke-MiningDefinitionWrite -Kind 'table' -Name $definition.Name -Command $command
    Assert-TableSchema -TableName $definition.Name -ExpectedColumns $definition.Columns
}
foreach ($definition in $tableDefinitions) {
    Assert-TableSchema -TableName $definition.Name -ExpectedColumns $definition.Columns
}

foreach ($retention in $retentionCommands) {
    $duration = [TimeSpan]::FromDays($retention.Days).ToString()
    $policy = @{ SoftDeletePeriod = $duration; Recoverability = 'Enabled' } | ConvertTo-Json -Compress
    $command = ".alter table $($retention.Name) policy retention '$policy'"
    Invoke-MiningDefinitionWrite -Kind 'retention-policy' -Name $retention.Name -Command $command
    $rows = Get-KustoRows -Command ".show table $($retention.Name) policy retention"
    if ($rows.Count -ne 1) { throw "Could not verify retention policy for '$($retention.Name)'." }
    $actualPolicy = $rows[0][2] | ConvertFrom-Json
    if ([TimeSpan]::Parse($actualPolicy.SoftDeletePeriod) -ne [TimeSpan]::FromDays($retention.Days)) {
        throw "Retention policy verification failed for '$($retention.Name)'."
    }
}

foreach ($function in $functionCommands) {
    Invoke-MiningDefinitionWrite -Kind 'function' -Name $function.Name -Command $function.Command
}
$verifiedFunctions = @()
$missingFunctions = @($expectedFunctionNames)
for ($attempt = 1; $attempt -le 13 -and $missingFunctions.Count -gt 0; $attempt++) {
    $functionRows = Get-KustoRows -Command '.show functions | project Name'
    $verifiedFunctions = @($functionRows | ForEach-Object { $_[0] })
    $missingFunctions = @($expectedFunctionNames | Where-Object { $_ -cnotin $verifiedFunctions })
    if ($missingFunctions.Count -gt 0 -and $attempt -lt 13) { Start-Sleep -Seconds 5 }
}
if ($missingFunctions.Count -gt 0) {
    throw "Mining functions were not found after deployment: $($missingFunctions -join ', '). Observed: $($verifiedFunctions -join ', ')."
}

Write-MiningReceipt @{ status = 'DefinitionsAppliedReadinessGated' }
[pscustomobject]@{
    status = 'DefinitionsAppliedReadinessGated'
    workspaceId = $WorkspaceId.ToString()
    eventhouseId = $EventhouseId.ToString()
    databaseId = $KqlDatabaseId.ToString()
    tableCount = $tableDefinitions.Count
    functionCount = $expectedFunctionNames.Count
    readinessChanged = $false
    materializationEnabled = $false
}
