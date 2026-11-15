#Requires -Version 7.0
<#
.SYNOPSIS
Resumes paused derived streams in an existing triathlon or Mining Eventstream.
.DESCRIPTION
Mining defaults to read-only preflight and requires explicit write opt-in, its exact
target, an Active capacity, workspace assignment and expected routing filters.
Triathlon retains its existing behavior. Does not change
definitions, connections, secrets, identities, or permissions. Running is control-plane
evidence only; verify a fresh generated event in Eventhouse separately.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$EventstreamId,
    [Parameter(Mandatory)][guid]$KqlDatabaseId,
    [ValidateSet('Triathlon', 'Mining')][string]$Profile = 'Triathlon',
    [switch]$ApplyMiningRecovery,
    [ValidateSet('Now', 'WhenLastStopped')][string]$StartType = 'WhenLastStopped',
    [ValidateRange(1, 900)][int]$TimeoutSeconds = 180,
    [ValidateRange(1, 30)][int]$PollIntervalSeconds = 5
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\provision\runtime-arm.ps1')
$accountOutput = & az account show --subscription $SubscriptionId.ToString() --output json --only-show-errors 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the explicitly selected subscription.' }
$account = ($accountOutput -join "`n") | ConvertFrom-Json
if ($account.id -ne $SubscriptionId.ToString() -or $account.tenantId -ne $TenantId.ToString()) {
    throw 'The selected subscription does not belong to the requested tenant.'
}
function Assert-MiningCapacityActive {
    $state = & az resource show --subscription $SubscriptionId.ToString() `
        --resource-group 'rg-triathlon-twin-demo' --name 'triatwindevfabriccap' `
        --resource-type 'Microsoft.Fabric/capacities' --query 'properties.state' `
        --output tsv --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the exact Mining capacity state; no recovery attempted.' }
    $value = ($state -join "`n").Trim()
    if ($value -cnotin @('Active', 'Provisioning', 'Failed', 'Updating', 'Deleting', 'Suspending',
            'Suspended', 'Pausing', 'Paused', 'Resuming', 'Scaling', 'Preparing')) {
        throw 'Capacity state was missing or unrecognized; no recovery attempted.'
    }
    return ($value -ceq 'Active')
}
if ($Profile -eq 'Mining') {
    if ($SubscriptionId.ToString() -cne '86677b6e-28fc-48e4-8988-5ab9e568eece' -or
        $TenantId.ToString() -cne 'ecd6dfda-d2ce-47a8-9901-e35f31fe18dd' -or
        $WorkspaceId.ToString() -cne 'db05aacb-bd7c-405a-a19b-90cc1c67d87b' -or
        $EventstreamId.ToString() -cne '6fca8489-4a0d-452b-8df1-217b91b9b557' -or
        $KqlDatabaseId.ToString() -cne '62177ca4-73f8-4573-b0c6-8e9317e7dacc') {
        throw 'Mining recovery target does not match the approved exact scope.'
    }
    if ($StartType -cne 'WhenLastStopped') { throw 'Mining recovery requires WhenLastStopped.' }
    if (-not (Assert-MiningCapacityActive)) {
        return [pscustomobject]@{ Status = 'DeferredCapacityNotActive'; IngestionVerified = $false }
    }
}
$token = Get-RuntimeAccessToken -SubscriptionId $SubscriptionId -TenantId $TenantId -Resource 'https://api.fabric.microsoft.com'
$headers = @{ Authorization = "Bearer $token" }
$baseUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/eventstreams/$EventstreamId"

if ($Profile -eq 'Mining') {
    try {
        $workspaceResponse = Invoke-WebRequest -Method GET -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId" `
            -Headers $headers -SkipHttpErrorCheck -TimeoutSec 60 -Verbose:$false -Debug:$false -ErrorAction Stop
    } catch { throw 'Mining workspace request failed before a response was received. Details suppressed.' }
    if ([int]$workspaceResponse.StatusCode -ne 200) {
        throw "Mining workspace read failed with HTTP $($workspaceResponse.StatusCode)."
    }
    try { $workspace = ConvertFrom-Json -InputObject $workspaceResponse.Content }
    catch { throw 'Mining workspace response was not valid JSON.' }
    if ($workspace.id -ne $WorkspaceId.ToString() -or
        $workspace.capacityId -ne 'bd00d528-b25d-4960-bd09-a70f8aa11e2c') {
        throw 'Mining workspace is not assigned to the approved Fabric capacity.'
    }
}

function Invoke-EventstreamRequest {
    param([ValidateSet('GET', 'POST')][string]$Method, [ValidateSet('topology', 'resume')][string]$Operation)
    $parameters = @{
        Method = $Method; Uri = "$baseUri/$Operation"; Headers = $headers
        SkipHttpErrorCheck = $true; TimeoutSec = 60
        Verbose = $false; Debug = $false; ErrorAction = 'Stop'
    }
    if ($Method -eq 'POST') {
        $parameters.Body = @{ startType = $StartType } | ConvertTo-Json -Compress
        $parameters.ContentType = 'application/json'
    }
    try { $response = Invoke-WebRequest @parameters }
    catch { throw "Eventstream $Operation request failed before a response was received. Details suppressed." }
    if ([int]$response.StatusCode -ne 200) {
        throw "Eventstream $Operation failed with HTTP $($response.StatusCode). No alternate endpoint or permission changes attempted."
    }
    if ($Method -eq 'GET') {
        try { return ConvertFrom-Json -InputObject $response.Content }
        catch { throw 'Eventstream topology response was not valid JSON.' }
    }
}

$profileDefinition = if ($Profile -eq 'Mining') {
    @{
        Source = 'mining_custom_endpoint'; Main = 'mining_main_stream'
        Pairs = @(
            @{ Label = 'mining state'; Stream = 'mining_state_stream'; Filter = 'mining_state_filter'; Entity = 'PlantStateEvent'; Destination = 'mining_state_raw_ingestion'; Table = 'mining_PlantStateEvents'; Mapping = 'mining_state_raw_json_map' }
            @{ Label = 'mining telemetry'; Stream = 'mining_telemetry_stream'; Filter = 'mining_telemetry_filter'; Entity = 'PlantTelemetry'; Destination = 'mining_telemetry_raw_ingestion'; Table = 'mining_TelemetryRaw'; Mapping = 'mining_telemetry_raw_json_map' }
        )
    }
} else {
    @{
        Source = 'triathlon_custom_endpoint'; Main = 'triathlon_main_stream'
        Pairs = @(
            @{ Label = 'racesplit'; Stream = 'racesplit_stream'; Filter = 'racesplit_filter'; Destination = 'racesplit_direct_ingestion'; Table = 'RaceSplit'; Mapping = 'racesplit_json_map' }
            @{ Label = 'sessionmetric'; Stream = 'sessionmetric_stream'; Filter = 'sessionmetric_filter'; Destination = 'sessionmetric_direct_ingestion'; Table = 'SessionMetric'; Mapping = 'sessionmetric_json_map' }
        )
    }
}

function Assert-ExpectedTopology {
    param([object]$Topology)
    $sources = @($Topology.sources)
    $destinations = @($Topology.destinations)
    $streams = @($Topology.streams)
    if ($sources.Count -ne 1 -or $sources[0].type -ne 'CustomEndpoint' -or
        $sources[0].name -ne $profileDefinition.Source -or $destinations.Count -ne 2 -or $streams.Count -ne 3) {
        throw 'Unexpected Eventstream topology; refusing an eventstream-wide resume.'
    }
    if ($Profile -eq 'Mining' -and @($Topology.operators).Count -ne 2) {
        throw 'Unexpected Mining operators; refusing an eventstream-wide resume.'
    }
    $default = @($streams | Where-Object { $_.name -eq $profileDefinition.Main })
    if ($default.Count -ne 1 -or $default[0].type -ne 'DefaultStream' -or
        @($default[0].inputNodes).Count -ne 1 -or $default[0].inputNodes[0].name -ne $sources[0].name) {
        throw 'Unexpected default stream reference.'
    }
    if ($Profile -eq 'Mining' -and ($sources[0].name -cne $profileDefinition.Source -or
        $sources[0].type -cne 'CustomEndpoint' -or $default[0].name -cne $profileDefinition.Main -or
        $default[0].type -cne 'DefaultStream' -or $default[0].inputNodes[0].name -cne $profileDefinition.Source)) {
        throw 'Unexpected Mining source or default stream reference.'
    }
    foreach ($pair in $profileDefinition.Pairs) {
        if ($Profile -eq 'Mining') {
            $filter = @($Topology.operators | Where-Object { $_.name -ceq $pair.Filter })
            if ($filter.Count -ne 1 -or $filter[0].type -cne 'Filter' -or
                @($filter[0].inputNodes).Count -ne 1 -or $filter[0].inputNodes[0].name -cne $profileDefinition.Main) {
                throw "Unexpected $($pair.Label) filter route."
            }
            $conditions = @($filter[0].properties.conditions)
            if ($conditions.Count -ne 1 -or $conditions[0].column.node -cne $profileDefinition.Main -or
                $conditions[0].column.columnName -cne 'entityType' -or $null -ne $conditions[0].column.columnPath -or
                $conditions[0].column.expressionType -cne 'ColumnReference' -or
                $conditions[0].operatorType -cne 'Equals' -or $conditions[0].value.expressionType -cne 'Literal' -or
                $conditions[0].value.dataType -cne 'Nvarchar(max)' -or $conditions[0].value.value -cne $pair.Entity) {
                throw "Unexpected $($pair.Label) filter condition."
            }
        }
        $stream = @($streams | Where-Object { $_.name -eq $pair.Stream })
        $destination = @($destinations | Where-Object { $_.name -eq $pair.Destination })
        if ($stream.Count -ne 1 -or $stream[0].type -ne 'DerivedStream' -or
            @($stream[0].inputNodes).Count -ne 1 -or $stream[0].inputNodes[0].name -ne $pair.Filter -or
            $destination.Count -ne 1 -or $destination[0].type -ne 'Eventhouse') {
            throw "Unexpected $($pair.Label) stream or destination."
        }
        if ($Profile -eq 'Mining' -and ($stream[0].name -cne $pair.Stream -or
            $stream[0].type -cne 'DerivedStream' -or $stream[0].inputNodes[0].name -cne $pair.Filter -or
            $destination[0].name -cne $pair.Destination -or $destination[0].type -cne 'Eventhouse')) {
            throw "Unexpected $($pair.Label) stream or destination."
        }
        $properties = $destination[0].properties
        if ($properties.dataIngestionMode -ne 'DirectIngestion' -or $properties.workspaceId -ne $WorkspaceId.ToString() -or
            $properties.itemId -ne $KqlDatabaseId.ToString() -or $properties.tableName -ne $pair.Table -or
            $properties.mappingRuleName -ne $pair.Mapping -or -not $properties.connectionName -or
            @($destination[0].inputNodes).Count -ne 1 -or $destination[0].inputNodes[0].name -ne $stream[0].name) {
            throw "Unexpected $($pair.Label) Eventhouse reference."
        }
        if ($Profile -eq 'Mining' -and ($properties.dataIngestionMode -cne 'DirectIngestion' -or
            $properties.tableName -cne $pair.Table -or $properties.mappingRuleName -cne $pair.Mapping -or
            $destination[0].inputNodes[0].name -cne $pair.Stream)) {
            throw "Unexpected $($pair.Label) Eventhouse reference."
        }
    }
    if ($sources[0].status -ne 'Running' -or $default[0].status -ne 'Running') {
        throw 'CustomEndpoint and default stream must already be Running; this script does not repair sources.'
    }
    foreach ($destination in $destinations) {
        if ($destination.status -notin @('Running', 'Warning')) {
            throw "Destination '$($destination.name)' is $($destination.status); investigate before resuming routing."
        }
        if ($destination.status -eq 'Warning') {
            Write-Warning "Destination '$($destination.name)' reports Warning; fresh table ingestion must be verified separately."
        }
    }
    foreach ($stream in @($streams | Where-Object { $_.type -eq 'DerivedStream' })) {
        if ($stream.status -notin @('Paused', 'Running', 'Resuming')) {
            throw "Derived stream '$($stream.name)' is $($stream.status); investigate before resuming."
        }
    }
}

$topology = Invoke-EventstreamRequest -Method GET -Operation topology
Assert-ExpectedTopology $topology
$paused = @($topology.streams | Where-Object { $_.type -eq 'DerivedStream' -and $_.status -eq 'Paused' })
if ($paused.Count -gt 0) {
    if ($Profile -eq 'Mining' -and -not $ApplyMiningRecovery) {
        return [pscustomobject]@{ Status = 'PreflightPaused'; Paused = @($paused.name); IngestionVerified = $false }
    }
    if (-not $PSCmdlet.ShouldProcess("$WorkspaceId/$EventstreamId", "Resume paused derived streams ($StartType)")) {
        return [pscustomobject]@{ Status = 'NotApplied'; Resumed = @(); StartType = $StartType }
    }
    if ($Profile -eq 'Mining' -and -not (Assert-MiningCapacityActive)) {
        return [pscustomobject]@{ Status = 'DeferredCapacityNotActive'; IngestionVerified = $false }
    }
    Invoke-EventstreamRequest -Method POST -Operation resume
}
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while (@($topology.streams | Where-Object { $_.type -eq 'DerivedStream' -and $_.status -ne 'Running' }).Count -gt 0) {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting for both derived streams to report Running.' }
    Start-Sleep -Seconds $PollIntervalSeconds
    $topology = Invoke-EventstreamRequest -Method GET -Operation topology
    Assert-ExpectedTopology $topology
}
[pscustomobject]@{
    Status = 'Running'
    Resumed = @($paused | ForEach-Object { $_.name })
    StartType = $StartType
    IngestionVerified = $false
}
