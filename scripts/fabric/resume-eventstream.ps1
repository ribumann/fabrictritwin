#Requires -Version 7.0
<#
.SYNOPSIS
Resumes paused derived streams in an existing triathlon or Mining Eventstream.
.DESCRIPTION
Checks the explicit subscription/tenant and exact source, streams, and destination
references before using the documented Eventstream resume API. Does not change
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
$token = Get-RuntimeAccessToken -SubscriptionId $SubscriptionId -TenantId $TenantId -Resource 'https://api.fabric.microsoft.com'
$headers = @{ Authorization = "Bearer $token" }
$baseUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/eventstreams/$EventstreamId"

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
            @{ Label = 'mining state'; Stream = 'mining_state_stream'; Filter = 'mining_state_filter'; Destination = 'mining_state_raw_ingestion'; Table = 'mining_PlantStateEvents'; Mapping = 'mining_state_raw_json_map' }
            @{ Label = 'mining telemetry'; Stream = 'mining_telemetry_stream'; Filter = 'mining_telemetry_filter'; Destination = 'mining_telemetry_raw_ingestion'; Table = 'mining_TelemetryRaw'; Mapping = 'mining_telemetry_raw_json_map' }
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
    $default = @($streams | Where-Object { $_.name -eq $profileDefinition.Main })
    if ($default.Count -ne 1 -or $default[0].type -ne 'DefaultStream' -or
        @($default[0].inputNodes).Count -ne 1 -or $default[0].inputNodes[0].name -ne $sources[0].name) {
        throw 'Unexpected default stream reference.'
    }
    foreach ($pair in $profileDefinition.Pairs) {
        $stream = @($streams | Where-Object { $_.name -eq $pair.Stream })
        $destination = @($destinations | Where-Object { $_.name -eq $pair.Destination })
        if ($stream.Count -ne 1 -or $stream[0].type -ne 'DerivedStream' -or
            @($stream[0].inputNodes).Count -ne 1 -or $stream[0].inputNodes[0].name -ne $pair.Filter -or
            $destination.Count -ne 1 -or $destination[0].type -ne 'Eventhouse') {
            throw "Unexpected $($pair.Label) stream or destination."
        }
        $properties = $destination[0].properties
        if ($properties.dataIngestionMode -ne 'DirectIngestion' -or $properties.workspaceId -ne $WorkspaceId.ToString() -or
            $properties.itemId -ne $KqlDatabaseId.ToString() -or $properties.tableName -ne $pair.Table -or
            $properties.mappingRuleName -ne $pair.Mapping -or -not $properties.connectionName -or
            @($destination[0].inputNodes).Count -ne 1 -or $destination[0].inputNodes[0].name -ne $stream[0].name) {
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
    if (-not $PSCmdlet.ShouldProcess("$WorkspaceId/$EventstreamId", "Resume paused derived streams ($StartType)")) {
        return [pscustomobject]@{ Status = 'NotApplied'; Resumed = @(); StartType = $StartType }
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
