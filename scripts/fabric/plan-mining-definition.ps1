#Requires -Version 7.0
<#
.SYNOPSIS
Checks an offline, operator-reviewed Eventstream definition against its preimage.
.DESCRIPTION
This does not call Fabric or verify target identity, KQL objects, or ingestion.
Apply is deliberately blocked: the documented update replaces the definition
and does not document an atomic revision precondition.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$EventstreamId,
    [Parameter(Mandatory)][guid]$KqlDatabaseId,
    [Parameter(Mandatory)][string]$BaselinePath,
    [Parameter(Mandatory)][string]$CurrentPath,
    [Parameter(Mandatory)][string]$DesiredPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$BaselineSha256,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$DesiredSha256,
    [ValidateSet('Plan', 'Verify', 'Apply')][string]$Mode = 'Plan'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($Mode -eq 'Apply') {
    throw 'Apply is blocked: an operator-approved, serialized update and fresh preimage recheck are required; no atomic compare-and-swap is documented.'
}
foreach ($id in @($SubscriptionId, $TenantId, $WorkspaceId, $EventstreamId, $KqlDatabaseId)) {
    if ($id -eq [guid]::Empty) { throw 'All target identifiers must be nonempty.' }
}

function Read-Definition {
    param([string]$Path, [string]$ExpectedHash)
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path).ProviderPath)
    $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes))
    if ($ExpectedHash -and $hash -ne $ExpectedHash) { throw 'Definition file hash does not match the approved hash.' }
    try { $definition = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
    catch { throw 'Definition is not valid JSON.' }
    if ($definition -isnot [System.Collections.IDictionary]) { throw 'Definition must be a JSON object.' }
    foreach ($key in @('sources', 'streams', 'operators', 'destinations')) {
        if (-not $definition.Contains($key) -or $definition[$key] -isnot [array]) {
            throw "Definition must contain a $key array."
        }
    }
    return ,$definition
}

function Get-OnlyNode {
    param([object[]]$Nodes, [string]$Name)
    $matches = @($Nodes | Where-Object { $_ -is [System.Collections.IDictionary] -and $_.name -ceq $Name })
    if ($matches.Count -ne 1) { throw "Expected exactly one node named '$Name'." }
    return $matches[0]
}

function Test-DefinitionEqual {
    param([object]$Left, [object]$Right)
    if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
    if ($Left -is [System.Collections.IDictionary] -and $Right -is [System.Collections.IDictionary]) {
        if ($Left.Count -ne $Right.Count) { return $false }
        foreach ($key in $Left.Keys) {
            if (@($Right.Keys) -cnotcontains $key -or -not (Test-DefinitionEqual $Left[$key] $Right[$key])) {
                return $false
            }
        }
        return $true
    }
    if ($Left -is [array] -and $Right -is [array]) {
        if ($Left.Count -ne $Right.Count) { return $false }
        for ($i = 0; $i -lt $Left.Count; $i++) {
            if (-not (Test-DefinitionEqual $Left[$i] $Right[$i])) { return $false }
        }
        return $true
    }
    if ($Left.GetType() -ne $Right.GetType()) { return $false }
    return $Left -ceq $Right
}

function Assert-Input {
    param([object]$Node, [string]$Name)
    if (@($Node.inputNodes).Count -ne 1 -or $Node.inputNodes[0].name -cne $Name) {
        throw "Unexpected input for '$($Node.name)'."
    }
}

$baseline = Read-Definition $BaselinePath $BaselineSha256
$current = Read-Definition $CurrentPath ''
$desired = Read-Definition $DesiredPath $DesiredSha256

if ($baseline.sources.Count -ne 1 -or $baseline.streams.Count -ne 3 -or
    $baseline.operators.Count -ne 2 -or $baseline.destinations.Count -ne 2) {
    throw 'Unexpected baseline topology.'
}
$source = Get-OnlyNode $baseline.sources 'triathlon_custom_endpoint'
$main = Get-OnlyNode $baseline.streams 'triathlon_main_stream'
if ($source.type -cne 'CustomEndpoint' -or $main.type -cne 'DefaultStream') { throw 'Unexpected triathlon source or default stream.' }
Assert-Input $main $source.name
foreach ($pair in @(
    @{ Prefix = 'racesplit'; Table = 'RaceSplit'; Entity = 'RaceSplit' },
    @{ Prefix = 'sessionmetric'; Table = 'SessionMetric'; Entity = 'SessionMetric' }
)) {
    $filter = Get-OnlyNode $baseline.operators "$($pair.Prefix)_filter"
    $stream = Get-OnlyNode $baseline.streams "$($pair.Prefix)_stream"
    $destination = Get-OnlyNode $baseline.destinations "$($pair.Prefix)_direct_ingestion"
    if ($filter.type -cne 'Filter' -or $stream.type -cne 'DerivedStream' -or $destination.type -cne 'Eventhouse') {
        throw 'Unexpected triathlon route type.'
    }
    Assert-Input $filter $main.name
    Assert-Input $stream $filter.name
    Assert-Input $destination $stream.name
    $properties = $destination.properties
    if ($properties.dataIngestionMode -cne 'DirectIngestion' -or $properties.workspaceId -ne $WorkspaceId.ToString() -or
        $properties.itemId -ne $KqlDatabaseId.ToString() -or $properties.tableName -cne $pair.Table -or
        $properties.mappingRuleName -cne "$($pair.Prefix)_json_map" -or -not $properties.connectionName) {
        throw 'Unexpected triathlon destination reference.'
    }
    $conditions = @($filter.properties.conditions)
    if ($conditions.Count -ne 1 -or $conditions[0].column.node -cne $main.name -or
        $conditions[0].column.columnName -cne 'entityType' -or $conditions[0].operatorType -cne 'Equals' -or
        $conditions[0].column.expressionType -cne 'ColumnReference' -or
        $conditions[0].value.expressionType -cne 'Literal' -or
        $conditions[0].value.dataType -cne 'Nvarchar(max)' -or
        $conditions[0].value.value -cne $pair.Entity) { throw 'Unexpected triathlon discriminator.' }
}

$owned = @{
    streams = @('mining_telemetry_stream', 'mining_state_stream')
    operators = @('mining_telemetry_filter', 'mining_state_filter')
    destinations = @('mining_telemetry_direct_ingestion', 'mining_state_direct_ingestion')
}
if ($desired.sources.Count -ne 1 -or $desired.streams.Count -ne 5 -or
    $desired.operators.Count -ne 4 -or $desired.destinations.Count -ne 4) {
    throw 'Desired definition has unexpected topology.'
}
foreach ($kind in $owned.Keys) {
    foreach ($name in $owned[$kind]) {
        if (@($baseline[$kind] | Where-Object { $_.name -ceq $name }).Count -ne 0) { throw 'Baseline already contains a mining-owned node.' }
        $null = Get-OnlyNode $desired[$kind] $name
    }
}
$withoutMining = @{}
foreach ($key in $desired.Keys) {
    if ($owned.ContainsKey($key)) {
        $withoutMining[$key] = @($desired[$key] | Where-Object { $_.name -cnotin $owned[$key] })
    } else { $withoutMining[$key] = $desired[$key] }
}
if (-not (Test-DefinitionEqual $baseline $withoutMining)) { throw 'Desired definition changes non-mining content.' }

foreach ($route in @(
    @{ Prefix = 'mining_telemetry'; Entity = 'PlantTelemetry'; Table = 'mining_TelemetryRaw' },
    @{ Prefix = 'mining_state'; Entity = 'PlantStateEvent'; Table = 'mining_PlantStateEvents' }
)) {
    $filter = Get-OnlyNode $desired.operators "$($route.Prefix)_filter"
    $stream = Get-OnlyNode $desired.streams "$($route.Prefix)_stream"
    $destination = Get-OnlyNode $desired.destinations "$($route.Prefix)_direct_ingestion"
    if ($filter.type -cne 'Filter' -or $stream.type -cne 'DerivedStream' -or $destination.type -cne 'Eventhouse') {
        throw 'Unexpected mining route type.'
    }
    Assert-Input $filter $main.name
    Assert-Input $stream $filter.name
    Assert-Input $destination $stream.name
    $conditions = @($filter.properties.conditions)
    if ($conditions.Count -ne 1 -or $conditions[0].column.node -cne $main.name -or
        $conditions[0].column.columnName -cne 'entityType' -or $conditions[0].operatorType -cne 'Equals' -or
        $conditions[0].column.expressionType -cne 'ColumnReference' -or
        $conditions[0].value.expressionType -cne 'Literal' -or
        $conditions[0].value.dataType -cne 'Nvarchar(max)' -or
        $conditions[0].value.value -cne $route.Entity) { throw 'Unexpected mining discriminator.' }
    $properties = $destination.properties
    if ($properties.dataIngestionMode -cne 'DirectIngestion' -or $properties.workspaceId -ne $WorkspaceId.ToString() -or
        $properties.itemId -ne $KqlDatabaseId.ToString() -or $properties.tableName -cne $route.Table -or
        $properties.mappingRuleName -cne "$($route.Prefix)_json_map" -or -not $properties.connectionName) {
        throw 'Unexpected mining destination reference.'
    }
}

$isBaseline = Test-DefinitionEqual $current $baseline
$isDesired = Test-DefinitionEqual $current $desired
if (-not $isBaseline -and -not $isDesired) { throw 'Current definition differs from both approved revisions; refusing drift.' }
if ($Mode -eq 'Verify' -and -not $isDesired) { throw 'Current definition does not match the desired definition.' }
[pscustomobject]@{
    Status = if ($isDesired) { 'DefinitionMatchesOffline' } else { 'ChangesPlannedOffline' }
    AddedNodes = if ($isDesired) { @() } else { @($owned.streams + $owned.operators + $owned.destinations) }
    TargetVerified = $false
    KqlVerified = $false
    IngestionVerified = $false
    ApplySupported = $false
}
