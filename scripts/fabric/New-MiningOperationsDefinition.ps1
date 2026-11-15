#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][Guid]$WorkspaceId,
    [Parameter(Mandatory)][Guid]$KqlDatabaseId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($WorkspaceId -eq [Guid]::Empty -or $KqlDatabaseId -eq [Guid]::Empty) {
    throw 'Explicit nonempty Mining workspace and KQL database IDs are required.'
}
$queryPath = Join-Path $PSScriptRoot '..\..\infra\fabric\mining-operations-agent\source-freshness.kql'
$query = [IO.File]::ReadAllText($queryPath).Trim()
$instructions = @"
D01 Mining demonstration source-freshness advisor. Use ONLY mining_ValidatedTelemetry from the attached Mining KQL database and plant_id D01. Never query TriTwin or another workspace.
Create exactly one informational SOURCE STALE OR DEMO IDLE rule with NoEventsInLast5m == true. No external actions, messages, Teams destinations, recipients or equipment controls are authorized. Do not start the agent during generation.
This demo deliberately stops publishing after five minutes. Absent samples mean missing/idle evidence, not plant failure or healthy operation. Do not claim ingestion completeness without exact event-ID reconciliation. Never infer engineering thresholds, module states, durations or root causes.
Use the following reviewed bounded monitoring query without changing its aggregation, scope or empty-input behavior. Keep the assessment time, last bounded event time, run ID and row count as evidence; null/empty fields mean missing evidence.
$query
Do not replace the aggregate with a timestamp equality join or count() over a leftouter join: an unmatched left row would be counted as an event. Do not discard the default aggregate row for an empty source. Generate only the named boolean state condition, with no action binding.
"@
$configuration = @{
    configuration = @{
        instructions = $instructions
        dataSources = @{
            MiningD01 = @{
                id = $KqlDatabaseId.ToString()
                type = 'KustoDatabase'
                workspaceId = $WorkspaceId.ToString()
            }
        }
        actions = @{}
    }
    playbook = @{}
    shouldRun = $false
}
$json = $configuration | ConvertTo-Json -Depth 20 -Compress
@{ definition = @{ parts = @(@{
    path = 'Configurations.json'
    payloadType = 'InlineBase64'
    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
}) } } | ConvertTo-Json -Depth 10
