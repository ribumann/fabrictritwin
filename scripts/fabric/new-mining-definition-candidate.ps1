#Requires -Version 7.5
<#
.SYNOPSIS
Builds a review-only mining Eventstream candidate from a private live definition.
.DESCRIPTION
This is offline and does not establish that input schemas preserve raw JSON.
The output must not be applied until that behavior and all other prerequisites
are verified in an approved hosted validation window.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$EventstreamId,
    [Parameter(Mandatory)][guid]$KqlDatabaseId,
    [Parameter(Mandatory)][string]$BaselinePath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$BaselineSha256,
    [Parameter(Mandatory)][string]$InputSchemasPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9_-]{1,40}$')][string]$TelemetryConnectionName,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9_-]{1,40}$')][string]$StateConnectionName,
    [Parameter(Mandatory)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Copy-Json($Value) {
    return ,($Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable -DateKind String)
}
function Assert-Columns($Columns, [string[]]$Names) {
    if ($Columns -isnot [array] -or $Columns.Count -ne $Names.Count) {
        throw 'Input schema must contain exactly the expected wire fields.'
    }
    $actual = @()
    foreach ($column in $Columns) {
        if ($column -isnot [System.Collections.IDictionary] -or
            @($column.Keys).Count -ne 4 -or
            @('name', 'type', 'fields', 'items').Where({ $_ -cnotin @($column.Keys) }).Count -ne 0 -or
            $column.name -isnot [string] -or $column.type -isnot [string] -or
            [string]::IsNullOrWhiteSpace($column.type) -or $null -ne $column.fields -or $null -ne $column.items) {
            throw 'Unexpected input schema column shape.'
        }
        $actual += $column.name
    }
    foreach ($name in $Names) {
        if (@($actual | Where-Object { $_ -ceq $name }).Count -ne 1) {
            throw 'Input schema must contain exactly the expected wire fields.'
        }
    }
}

$baselineBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $BaselinePath).ProviderPath)
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($baselineBytes))
if ($hash -ne $BaselineSha256) { throw 'Baseline definition hash does not match the approved hash.' }
$envelope = [Text.Encoding]::UTF8.GetString($baselineBytes) | ConvertFrom-Json -AsHashtable -DateKind String
if ($envelope.definition.parts -isnot [array]) { throw 'Expected a definition parts array.' }
$parts = @($envelope.definition.parts)
if ($parts.Count -ne 3 -or @($parts | Where-Object { $_.path -ceq 'eventstream.json' }).Count -ne 1 -or
    @($parts | Where-Object { $_.path -ceq 'eventstreamProperties.json' }).Count -ne 1 -or
    @($parts | Where-Object { $_.path -ceq '.platform' }).Count -ne 1) {
    throw 'Unexpected definition parts.'
}
$part = @($parts | Where-Object { $_.path -ceq 'eventstream.json' })[0]
if ($part.payloadType -cne 'InlineBase64') { throw 'Unexpected Eventstream payload type.' }
$eventstream = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json -AsHashtable -DateKind String
$original = Copy-Json $eventstream
$schemas = Get-Content -LiteralPath $InputSchemasPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
if ($schemas -isnot [System.Collections.IDictionary] -or $schemas.Count -ne 2 -or
    @('telemetry', 'state').Where({ $_ -cnotin @($schemas.Keys) }).Count -ne 0) {
    throw 'Expected telemetry and state input schemas.'
}
$common = @('entityType', 'schema_version', 'run_id', 'event_id', 'sequence', 'timestamp', 'plant_id')
Assert-Columns $schemas.telemetry ($common + @('interval_seconds', 'module_id', 'equipment_id', 'tag_id', 'value', 'unit', 'quality'))
Assert-Columns $schemas.state ($common + @('scope_id', 'scheduled_running', 'state'))

if ($TelemetryConnectionName -ieq $StateConnectionName -or
    @($eventstream.destinations | Where-Object {
        $_.properties.connectionName -ieq $TelemetryConnectionName -or $_.properties.connectionName -ieq $StateConnectionName
    }).Count -ne 0) { throw 'Connection names must be distinct from each other and existing destinations.' }

foreach ($route in @(
    @{ Prefix = 'mining_telemetry'; Entity = 'PlantTelemetry'; Table = 'mining_TelemetryRaw'; Connection = $TelemetryConnectionName; Columns = $schemas.telemetry },
    @{ Prefix = 'mining_state'; Entity = 'PlantStateEvent'; Table = 'mining_PlantStateEvents'; Connection = $StateConnectionName; Columns = $schemas.state }
)) {
    $filter = @{
        name = "$($route.Prefix)_filter"; type = 'Filter'
        inputNodes = @(@{ name = 'triathlon_main_stream' })
        properties = @{ conditions = @(@{
            column = @{ node = 'triathlon_main_stream'; columnName = 'entityType'; columnPath = $null; expressionType = 'ColumnReference' }
            operatorType = 'Equals'
            value = @{ dataType = 'Nvarchar(max)'; value = $route.Entity; expressionType = 'Literal' }
        }) }
    }
    $stream = @{
        name = "$($route.Prefix)_stream"; type = 'DerivedStream'
        inputNodes = @(@{ name = $filter.name })
        properties = @{ inputSerialization = @{ type = 'Json'; properties = @{ encoding = 'UTF8' } } }
    }
    $destination = @{
        name = "$($route.Prefix)_direct_ingestion"; type = 'Eventhouse'
        inputNodes = @(@{ name = $stream.name })
        properties = @{
            dataIngestionMode = 'DirectIngestion'; workspaceId = $WorkspaceId.ToString()
            itemId = $KqlDatabaseId.ToString(); tableName = $route.Table
            mappingRuleName = "$($route.Prefix)_json_map"; connectionName = $route.Connection
        }
        inputSchemas = @(@{ name = $stream.name; schema = @{ columns = $route.Columns } })
    }
    $eventstream.operators += $filter
    $eventstream.streams += $stream
    $eventstream.destinations += $destination
}

$baselineTemp = [IO.Path]::GetTempFileName()
$candidateTemp = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($baselineTemp, ($original | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($candidateTemp, ($eventstream | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    $planner = Join-Path $PSScriptRoot 'plan-mining-definition.ps1'
    $null = & $planner -SubscriptionId $SubscriptionId -TenantId $TenantId -WorkspaceId $WorkspaceId `
        -EventstreamId $EventstreamId -KqlDatabaseId $KqlDatabaseId `
        -BaselinePath $baselineTemp -CurrentPath $baselineTemp -DesiredPath $candidateTemp `
        -BaselineSha256 (Get-FileHash -LiteralPath $baselineTemp -Algorithm SHA256).Hash `
        -DesiredSha256 (Get-FileHash -LiteralPath $candidateTemp -Algorithm SHA256).Hash
    $part.payload = [Convert]::ToBase64String([IO.File]::ReadAllBytes($candidateTemp))
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($envelope | ConvertTo-Json -Depth 100))
    $file = [IO.File]::Open($OutputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try { $file.Write($bytes, 0, $bytes.Length) } finally { $file.Dispose() }
} finally {
    Remove-Item -LiteralPath $baselineTemp, $candidateTemp -Force
}
[pscustomobject]@{
    Status = 'CandidateForReviewOnly'
    CandidateSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
    RawPreservationVerified = $false
    ApplySupported = $false
}
