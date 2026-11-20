#Requires -Version 7.0
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][uri]$KustoEndpoint,
    [Parameter(Mandatory)][string]$Database,
    [Parameter(Mandatory)][ValidateSet('triathlon', 'mining')][string]$Scenario,
    [Parameter(Mandatory)][guid]$RunId
)

$ErrorActionPreference = 'Stop'
if ($KustoEndpoint.Scheme -ne 'https' -or
    $KustoEndpoint.Host -notmatch '^[a-z0-9.-]+\.kusto\.fabric\.microsoft\.com$' -or
    !$KustoEndpoint.IsDefaultPort -or $KustoEndpoint.UserInfo -or
    $KustoEndpoint.AbsolutePath -ne '/' -or $KustoEndpoint.Query -or $KustoEndpoint.Fragment) {
    throw 'Supply the bare HTTPS query endpoint of the existing Fabric KQL database.'
}
$cluster = $KustoEndpoint.GetLeftPart([UriPartial]::Authority)
$token = az account get-access-token --subscription $SubscriptionId --resource $cluster --query accessToken -o tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or !$token) { throw 'Unable to obtain Fabric query access for the selected subscription.' }
$query = if ($Scenario -eq 'triathlon') {
    @"
SessionMetric
| where sessionId == "$RunId"
| project eventKey=tostring(sessionId), sampleTime=timestamp, rawReceipt=ingestion_time()
| order by sampleTime asc
| take 100
"@
} else {
    @"
union
    (mining_ValidatedTelemetry | extend eventKind="telemetry"),
    (mining_ValidatedState | extend eventKind="state")
| where run_id == "$RunId"
| extend validatedReceipt=ingestion_time()
| project eventKind, eventKey=event_id, sampleTime=timestamp, rawReceipt=received_at, validatedReceipt
| order by sampleTime asc, eventKey asc
| take 2000
"@
}
$response = Invoke-RestMethod "$cluster/v1/rest/query" -Method Post `
    -Headers @{ Authorization = "Bearer $token" } -MaximumRedirection 0 -TimeoutSec 45 `
    -ContentType application/json -Body (@{ db = $Database; csl = $query } | ConvertTo-Json -Compress)
$table = $response.Tables[0]
if (!$table.Columns) { throw 'Query did not return the expected primary table.' }
$rows = @(
    foreach ($row in $table.Rows) {
        $result = [ordered]@{}
        for ($i = 0; $i -lt $table.Columns.Count; $i++) {
            $result[$table.Columns[$i].ColumnName] = $row[$i]
        }
        [pscustomobject]$result
    }
)
[pscustomobject]@{ scenario = $Scenario; runId = $RunId; rows = $rows } | ConvertTo-Json -Depth 5
