#Requires -Version 7.5
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][uri]$KustoEndpoint,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9 _-]{0,127}$')][string]$Database,
    [switch]$DemoSignalOnly
)

$ErrorActionPreference = 'Stop'
if ($KustoEndpoint.Scheme -ne 'https' -or
    $KustoEndpoint.Host -notmatch '^[a-z0-9.-]+\.kusto\.fabric\.microsoft\.com$' -or
    !$KustoEndpoint.IsDefaultPort -or $KustoEndpoint.UserInfo -or
    $KustoEndpoint.AbsolutePath -ne '/' -or $KustoEndpoint.Query -or $KustoEndpoint.Fragment) {
    throw 'Supply the bare HTTPS query endpoint of the existing Mining database.'
}
$cluster = $KustoEndpoint.GetLeftPart([UriPartial]::Authority)
$token = az account get-access-token --subscription $SubscriptionId --resource $cluster --query accessToken -o tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or !$token) { throw 'Unable to obtain Fabric access.' }
function Invoke-Kusto($Route, $Query) {
    Invoke-RestMethod "$cluster/v1/rest/$Route" -Method Post -Headers @{ Authorization = "Bearer $token" } `
        -ContentType application/json -TimeoutSec 30 -MaximumRedirection 0 `
        -Body (@{ db = $Database; csl = $Query } | ConvertTo-Json -Compress)
}
$ready = Invoke-Kusto query 'mining_SourceReadiness() | project status'
if ($ready.Tables[0].Rows.Count -ne 1 -or $ready.Tables[0].Rows[0][0] -ne 'READY') {
    throw 'The target database does not have a ready Mining source contract.'
}
function Confirm-StreamingSchema($Table) {
    $cache = Invoke-Kusto mgmt ".clear table $Table cache streamingingestion schema"
    $index = [Array]::IndexOf(@($cache.Tables[0].Columns.ColumnName), 'Status')
    if ($index -lt 0 -or !$cache.Tables[0].Rows.Count) { throw 'Schema refresh did not return status.' }
    foreach ($node in $cache.Tables[0].Rows) {
        if ($node[$index] -ne 'Succeeded') { throw 'Streaming schema refresh did not succeed on every node.' }
    }
}
if ($DemoSignalOnly) {
    if (!$PSCmdlet.ShouldProcess($Database, 'Install only the isolated five-second Mining demo signal')) { return }
    $commands = @(
        '.create table mining_DemoSignal (run_id:string, sample_time:datetime, elapsed_seconds:long, hopper_tonnes:real)'
        '.alter table mining_DemoSignal policy streamingingestion ''{"IsEnabled":true}'''
        '.alter table mining_DemoSignal policy ingestiontime true'
        '.alter-merge table mining_DemoSignal policy retention softdelete = 1d'
        '.create-or-alter table mining_DemoSignal ingestion json mapping ''mining_demo_signal_map'' ''[{"column":"run_id","Properties":{"Path":"$.runId"}},{"column":"sample_time","Properties":{"Path":"$.sampleTime"}},{"column":"elapsed_seconds","Properties":{"Path":"$.elapsedSeconds"}},{"column":"hopper_tonnes","Properties":{"Path":"$.hopperTonnes"}}]'''
        (Get-Content (Join-Path $PSScriptRoot '..\..\infra\fabric\eventhouse\MiningDemoSignal.kql') -Raw)
    )
    foreach ($command in $commands) { [void](Invoke-Kusto mgmt $command) }
    Confirm-StreamingSchema mining_DemoSignal
    $result = Invoke-Kusto query 'mining_DemoSignalReceipt("00000000-0000-0000-0000-000000000000", datetime(2000-01-01), 60)'
    if ($result.Tables[0].Rows.Count -ne 1 -or $result.Tables[0].Rows[0][0] -ne 0 -or
        $null -ne $result.Tables[0].Rows[0][3] -or $null -ne $result.Tables[0].Rows[0][4]) {
        throw 'Demo signal receipt did not return the expected empty result.'
    }
    return
}
$source = Get-Content (Join-Path $PSScriptRoot '..\..\infra\fabric\eventhouse\MiningValidation.kql') -Raw
function Bind-Classifier($Kind, $SourceTable) {
    $definition = [regex]::Match($source, "(?ms)^\.create-or-alter function[^\r\n]+mining_Classify$Kind\(\)\r?\n(?<body>\{.*?^\})")
    $line = '(?m)^    ' + [regex]::Escape($SourceTable) + '\r?$'
    if (!$definition.Success -or [regex]::Matches($definition.Groups['body'].Value, $line).Count -ne 1) {
        throw "Cannot bind the $Kind classifier to the native stream."
    }
    $entity = if ($Kind -eq 'Telemetry') { 'PlantTelemetry' } else { 'PlantStateEvent' }
    [regex]::Replace($definition.Groups['body'].Value, $line,
        "    mining_NativeLiveRaw | where run_id == run and batch_time == batch and tostring(event.entityType) == '$entity'")
}
$telemetry = Bind-Classifier Telemetry mining_TelemetryRaw
$state = Bind-Classifier State mining_PlantStateEvents
$definition = @"
.create-or-alter function with (folder = "Mining/Validation") mining_NativeLiveReceipt(run:string, batch:datetime)
{
    let telemetry = () $telemetry;
    let state = () $state;
    let accepted = materialize(union (telemetry()), (state()) | where disposition == "ACCEPTED");
    let reading = accepted | where source_kind == "telemetry" | top 1 by sequence asc | project tag_id, value, unit, k=1;
    accepted
    | summarize stateCount=countif(source_kind == "state" and isnotnull(received_at)),
                telemetryCount=countif(source_kind == "telemetry" and isnotnull(received_at)),
                copies=count(), receivedAt=max(received_at), ids=make_set(event_id, 200)
    | extend k=1
    | join kind=leftouter reading on k
    | project stateCount, telemetryCount, copies, receivedAt, tag_id, value, unit,
              fingerprint=hash_sha256(strcat_array(array_sort_asc(ids), "\n"))
}
"@
if (!$PSCmdlet.ShouldProcess($Database, 'Install only the isolated Mining native live table and receipt function')) { return }
$commands = @(
    '.create table mining_NativeLiveRaw (event:dynamic, timestamp_raw:string, batch_time:datetime, run_id:string)'
    '.alter table mining_NativeLiveRaw policy streamingingestion ''{"IsEnabled":true}'''
    '.alter table mining_NativeLiveRaw policy ingestiontime true'
    '.alter-merge table mining_NativeLiveRaw policy retention softdelete = 1d'
    '.create-or-alter table mining_NativeLiveRaw ingestion json mapping ''mining_native_live_map'' ''[{"column":"event","Properties":{"Path":"$.event"}},{"column":"timestamp_raw","Properties":{"Path":"$.timestamp_raw"}},{"column":"batch_time","Properties":{"Path":"$.batch_time"}},{"column":"run_id","Properties":{"Path":"$.run_id"}}]'''
    $definition
)
foreach ($command in $commands) { [void](Invoke-Kusto mgmt $command) }
Confirm-StreamingSchema mining_NativeLiveRaw
$result = Invoke-Kusto query 'mining_NativeLiveReceipt("00000000-0000-0000-0000-000000000000", datetime(2000-01-01))'
if ($result.Tables[0].Rows.Count -ne 1 -or $result.Tables[0].Rows[0][2] -ne 0) {
    throw 'Native receipt function did not return the expected empty result.'
}
