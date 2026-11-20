#Requires -Version 7.5
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][uri]$KustoEndpoint,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,127}$')][string]$Database,
    [ValidateRange(1, 10)][int]$Samples = 5,
    [ValidateRange(100, 10000)][int]$BudgetMs = 3000
)

$ErrorActionPreference = 'Stop'
if ($KustoEndpoint.Scheme -ne 'https' -or
    $KustoEndpoint.Host -notmatch '^[a-z0-9.-]+\.kusto\.fabric\.microsoft\.com$' -or
    !$KustoEndpoint.IsDefaultPort -or $KustoEndpoint.UserInfo -or
    $KustoEndpoint.AbsolutePath -ne '/' -or $KustoEndpoint.Query -or $KustoEndpoint.Fragment) {
    throw 'Supply the bare HTTPS query endpoint of the existing Mining Eventhouse database.'
}
$cluster = $KustoEndpoint.GetLeftPart([UriPartial]::Authority)
$token = az account get-access-token --subscription $SubscriptionId --resource $cluster --query accessToken -o tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or !$token) { throw 'Unable to obtain Fabric access.' }
$headers = @{ Authorization = "Bearer $token" }
$table = 'mining_LatencyProbe_' + [guid]::NewGuid().ToString('N')
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$validation = Get-Content (Join-Path $repo 'infra\fabric\eventhouse\MiningValidation.kql') -Raw

function Invoke-Kusto($Route, $Query, $Timeout = 30) {
    Invoke-RestMethod "$cluster/v1/rest/$Route" -Method Post -Headers $headers `
        -ContentType application/json -TimeoutSec $Timeout -MaximumRedirection 0 `
        -Body (@{ db = $Database; csl = $Query } | ConvertTo-Json -Compress)
}

function Remove-ProbeTable {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            [void](Invoke-Kusto mgmt ".drop table $table ifexists" 90)
        } catch {
            Write-Warning "Drop of $table did not return success on attempt ${attempt}; checking readback."
        }
        try {
            $readback = Invoke-Kusto mgmt ".show tables | where TableName == '$table' | project TableName"
            if ($readback.Tables[0].Rows.Count -eq 0) { return }
        } catch {
            Write-Warning "Cleanup readback for $table failed on attempt $attempt."
        }
        Start-Sleep -Seconds 2
    }
    throw "Probe cleanup not confirmed: $table"
}

function Get-Classifier($Kind, $Source, $Sample) {
    $definition = [regex]::Match($validation, "(?ms)^\.create-or-alter function[^\r\n]+mining_Classify$Kind\(\)\r?\n(?<body>\{.*?^\})")
    $sourceLine = '(?m)^    ' + [regex]::Escape($Source) + '\r?$'
    if (!$definition.Success -or [regex]::Matches($definition.Groups['body'].Value, $sourceLine).Count -ne 1) {
        throw "Cannot bind the existing $Kind classifier to the isolated table."
    }
    [regex]::Replace($definition.Groups['body'].Value, $sourceLine, "    $table | where probe_number == $Sample and probe_kind == '$Kind'")
}

$ready = Invoke-Kusto query 'mining_SourceReadiness() | project status'
if ($ready.Tables[0].Rows.Count -ne 1 -or $ready.Tables[0].Rows[0][0] -ne 'READY') {
    throw 'The target Mining database does not have a ready source contract.'
}

Push-Location $repo
try {
    $fixture = @'
import { randomUUID } from "node:crypto";
import { createD01Simulation } from "./apps/simulator/dist/mining/index.js";
const startedAt = new Date(Date.now() - 60_000);
const simulation = createD01Simulation({runId: randomUUID(), startedAt, durationSeconds: 60});
for (let seconds = 5; seconds <= 30; seconds += 5) {
  simulation.step(new Date(+startedAt + seconds * 1000));
}
const batch = simulation.getPendingBatch().events;
const telemetry = batch.filter(event => event.entityType === "PlantTelemetry");
const state = batch.filter(event => event.entityType === "PlantStateEvent");
const rows = [
  ...telemetry.slice(1).map(event => ({kind: "Telemetry", event})),
  ...state.slice(1).map(event => ({kind: "State", event})),
  {kind: "Telemetry", event: {...telemetry[0], unit: "invalid-probe-unit"}},
  {kind: "State", event: {...state[0], state: "invalid-probe-state"}},
];
console.log(JSON.stringify({rows, validTelemetry: telemetry.length - 1, validState: state.length - 1}));
'@ | node --input-type=module
    if ($LASTEXITCODE -ne 0) { throw 'Build the simulator workspace before running this probe.' }
    $fixture = $fixture | ConvertFrom-Json -DateKind String -AsHashtable
} finally {
    Pop-Location
}

$passed = $true
try {
    Write-Verbose "Isolated table: $table"
    [void](Invoke-Kusto mgmt ".create table $table (event:dynamic, timestamp_raw:string, probe_number:int, probe_kind:string)")
    [void](Invoke-Kusto mgmt ".alter table $table policy streamingingestion '{`"IsEnabled`":true}'")
    [void](Invoke-Kusto mgmt ".alter table $table policy ingestiontime true")
    $mapping = '[{"column":"event","Properties":{"Path":"$.event"}},{"column":"timestamp_raw","Properties":{"Path":"$.timestamp_raw"}},{"column":"probe_number","Properties":{"Path":"$.sample"}},{"column":"probe_kind","Properties":{"Path":"$.kind"}}]'
    [void](Invoke-Kusto mgmt ".create table $table ingestion json mapping 'probe' '$mapping'")
    $cache = Invoke-Kusto mgmt ".clear table $table cache streamingingestion schema"
    $statusIndex = [Array]::IndexOf(@($cache.Tables[0].Columns.ColumnName), 'Status')
    if ($statusIndex -lt 0 -or !$cache.Tables[0].Rows.Count) {
        throw 'Streaming schema cache refresh did not return status.'
    }
    foreach ($node in $cache.Tables[0].Rows) {
        if ($node[$statusIndex] -ne 'Succeeded') {
            throw "Streaming schema cache refresh did not succeed on every node: $($node[$statusIndex])."
        }
    }
    $path = [uri]::EscapeDataString($Database)
    foreach ($sample in 1..$Samples) {
        $telemetry = Get-Classifier Telemetry mining_TelemetryRaw $sample
        $state = Get-Classifier State mining_PlantStateEvents $sample
        $query = @"
let telemetry = () $telemetry;
let state = () $state;
union (telemetry()), (state())
| summarize acceptedTelemetry=countif(disposition == "ACCEPTED" and source_kind == "telemetry"),
            acceptedState=countif(disposition == "ACCEPTED" and source_kind == "state"),
            quarantined=countif(disposition == "QUARANTINED"),
            blocked=countif(disposition == "BLOCKED"),
            acceptedReceipts=countif(disposition == "ACCEPTED" and isnotnull(received_at))
"@
        $lines = foreach ($row in $fixture.rows) {
            @{ kind = $row.kind; event = $row.event; timestamp_raw = $row.event.timestamp; sample = $sample } | ConvertTo-Json -Depth 6 -Compress
        }
        Write-Verbose "Starting sample $sample with $($lines.Count) events"
        $clock = [Diagnostics.Stopwatch]::StartNew()
        [void](Invoke-RestMethod "$cluster/v1/rest/ingest/$path/${table}?streamFormat=Json&mappingName=probe" `
            -Method Post -Headers $headers -ContentType application/json -Body ($lines -join "`n") `
            -TimeoutSec 15 -MaximumRedirection 0)
        $ack = $clock.ElapsedMilliseconds
        $result = Invoke-Kusto query $query
        $elapsed = $clock.ElapsedMilliseconds
        $row = $result.Tables[0].Rows[0]
        $samplePassed = $row[0] -eq $fixture.validTelemetry -and $row[1] -eq $fixture.validState -and
            $row[2] -eq 2 -and $row[3] -eq 0 -and $row[4] -eq ($fixture.validTelemetry + $fixture.validState) -and
            $elapsed -le $BudgetMs
        $passed = $passed -and $samplePassed
        [pscustomobject]@{
            sample = $sample; ingestAckMs = $ack; classifiedReadMs = $elapsed
            acceptedTelemetry = $row[0]; acceptedState = $row[1]; quarantined = $row[2]
            blocked = $row[3]; acceptedWithReceipt = $row[4]; passed = $samplePassed
        } | ConvertTo-Json -Compress
    }
} finally {
    Remove-ProbeTable
}
if (!$passed) { throw "At least one sample failed exact classification or the ${BudgetMs}ms latency budget." }
