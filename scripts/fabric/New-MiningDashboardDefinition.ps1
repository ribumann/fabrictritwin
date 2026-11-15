#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][Guid]$DashboardId,
    [Parameter(Mandatory)][Guid]$WorkspaceId,
    [Parameter(Mandatory)][string]$QueryEndpoint,
    [Parameter(Mandatory)][Guid]$KqlDatabaseId,
    [Parameter(Mandatory)][string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($DashboardId -eq [Guid]::Empty -or $WorkspaceId -eq [Guid]::Empty -or
    $KqlDatabaseId -eq [Guid]::Empty -or
    $QueryEndpoint -cnotmatch '^https://[a-z0-9-]+\.z[0-9]+\.kusto\.fabric\.microsoft\.com$') {
    throw 'A nonempty dashboard/workspace ID and exact Fabric Kusto query target are required.'
}

$sourceId = '70000000-0000-4000-8000-000000000001'
$pageId = '70000000-0000-4000-8000-000000000002'
$scope = @'
let asof = now();
let runs = mining_ValidatedTelemetry
    | where plant_id == "D01" and received_at <= asof and timestamp between ((asof - 7d) .. asof)
    | summarize last_received = max(received_at) by run_id;
let selected_run = toscalar(runs | order by last_received desc, run_id asc | take 1 | project run_id);
'@

$specifications = @(
    @{
        Title = 'Observed run and source reception (not metric validity)'
        Visual = 'table'
        Query = @'
let last_received = toscalar(runs | where run_id == selected_run | project last_received);
print observed_run = selected_run,
    source_status = toscalar(mining_SourceReadiness() | project status),
    last_received_at = last_received, checked_at = asof,
    reception = case(isnull(last_received), "NO_DATA", last_received < asof - 90s, "NO_RECENT_DATA", "RECENT_DATA")
'@
    },
    @{
        Title = 'Raw / validated event IDs (not publisher completion)'
        Visual = 'table'
        Query = 'mining_RunIngestion("D01", selected_run, asof)'
    },
    @{
        Title = 'Rolling five-minute throughput and coverage'
        Visual = 'table'
        Query = @'
mining_PlantSummary("D01", selected_run, asof - 5m, asof)
| project status, window_start_utc, window_end_utc, plant_feed_tph, running_lines,
    processed_tonnes, gross_process_water_m3_per_t, whole_plant_energy_kwh_per_t, common_coverage
'@
    },
    @{
        Title = 'A / B / C feed - covered event-time history, last 30 minutes'
        Visual = 'line'
        Query = @'
mining_CompareLines("D01", selected_run, "feed", asof - 30m, asof, 1)
| where status == "OK" and coverage >= 0.9
| project timestamp = bin_start_utc, value, line_id
| order by timestamp asc
'@
    }
)
$tiles = @()
for ($index = 0; $index -lt $specifications.Count; $index++) {
    $specification = $specifications[$index]
    $tiles += @{
        id = ('70000000-0000-4000-8000-{0:d12}' -f ($index + 10))
        title = $specification.Title
        query = "$scope`n$($specification.Query)"
        layout = @{ x = ($index % 2) * 12; y = [Math]::Floor($index / 2) * 6; width = 12; height = 6 }
        pageId = $pageId
        visualType = $specification.Visual
        dataSourceId = $sourceId
        usedParamVariables = @()
        visualOptions = @{
            xColumn = @{ type = 'infer' }
            yColumns = @{ type = 'infer' }
            seriesColumns = @{ type = 'infer' }
            hideLegend = $false
        }
    }
}
$dashboard = @{
    '$schema' = 'https://dataexplorer.azure.com/static/d/schema/20/dashboard.json'
    schema_version = '20'
    id = $DashboardId.ToString()
    title = 'D01 Mining operations'
    tiles = $tiles
    parameters = @()
    pages = @(@{ id = $pageId; name = 'D01 Operations' })
    dataSources = @(@{
        id = $sourceId; name = 'D01 validated realtime'
        scopeId = 'kusto-trident'; kind = 'kusto-trident'
        workspace = $WorkspaceId.ToString(); clusterUri = $QueryEndpoint; database = $KqlDatabaseId.ToString()
    })
    autoRefresh = @{ enabled = $true; defaultInterval = '30s'; minInterval = '30s' }
}
$json = $dashboard | ConvertTo-Json -Depth 20
$definition = @{
    definition = @{
        parts = @(@{
            path = 'RealTimeDashboard.json'
            payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
            payloadType = 'InlineBase64'
        })
    }
}
$definition | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
Write-Output "Wrote an offline definition with $($tiles.Count) query-backed tiles; no Fabric request was sent."
