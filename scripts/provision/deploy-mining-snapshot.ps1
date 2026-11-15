#Requires -Version 7.5
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TargetPath,
    [Parameter(Mandatory)][string]$RunExpectationPath,
    [Parameter(Mandatory)][string]$CapturePath,
    [ValidateSet('Capture', 'Apply', 'Verify')][string]$Mode = 'Verify',
    [string]$AsOfUtc,
    [string]$CaptureSha256,
    [string]$ReceiptPath,
    [string]$AzureCliPython,
    [string]$PythonExecutable = 'python',
    [switch]$ApproveSnapshotWrites,
    [string]$ExclusiveWriterWindowId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\fabric\MiningSnapshot.psm1') -Force
$target = Get-Content -LiteralPath $TargetPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
$run = Get-Content -LiteralPath $RunExpectationPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
foreach ($key in @('TenantId', 'SubscriptionId', 'CallerObjectId', 'WorkspaceId', 'StaticLakehouseId', 'SqlEndpointId')) {
    $id = [guid]::Empty
    if (-not [guid]::TryParseExact($target[$key], 'D', [ref]$id) -or $id -eq [guid]::Empty) { throw "Invalid reviewed target $key." }
}
if ($Mode -ceq 'Apply' -and (-not $ApproveSnapshotWrites -or [string]::IsNullOrWhiteSpace($ExclusiveWriterWindowId))) {
    throw 'Apply requires explicit snapshot-write approval and an acknowledged exclusive-writer window.'
}
if ($Mode -ceq 'Capture') {
    if (Test-Path -LiteralPath $CapturePath) { throw 'Capture already exists and will not be overwritten.' }
    $client = New-MiningSnapshotClient $target -AzureCliPython $AzureCliPython
    $capture = Get-MiningSnapshotCapture $run $AsOfUtc $client $target.KustoEndpoint $target.KustoDatabase $target.PublisherStatusUri
    $catalog = Join-Path $PSScriptRoot '..\..\apps\simulator\src\mining\plant-catalog.json'
    $bundle = New-MiningSnapshotBundle -Run $run -AsOfUtc $AsOfUtc -CatalogPath $catalog -PublisherEvidence $capture.publisherEvidence -Ingestion $capture.ingestion -Telemetry $capture.telemetry -State $capture.state
    $capture.bundle = $bundle
    $json = ($capture | ConvertTo-Json -Depth 100) + "`n"
    $stream = [IO.FileStream]::new([IO.Path]::GetFullPath($CapturePath), 'CreateNew', 'Write', 'None')
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($json)
        $stream.Write($bytes)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    [ordered]@{ status = 'CapturedReconciledSnapshot'; sha256 = (Get-FileHash $CapturePath -Algorithm SHA256).Hash.ToLowerInvariant(); runId = $run.runId }
    return
}
if ($CaptureSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    (Get-FileHash -LiteralPath $CapturePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $CaptureSha256) {
    throw 'Exact reviewed capture hash is required.'
}
if ([string]::IsNullOrWhiteSpace($ReceiptPath)) { throw 'A new durable receipt path is required.' }
$capture = Get-Content -LiteralPath $CapturePath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
if (($capture.run | ConvertTo-Json -Compress -Depth 20) -cne ($run | ConvertTo-Json -Compress -Depth 20) -or
    $capture.kustoEndpoint -cne $target.KustoEndpoint -or $capture.kustoDatabase -cne $target.KustoDatabase -or
    $capture.publisherStatusUri -cne $target.PublisherStatusUri) {
    throw 'Reviewed event expectation/source differs from the captured target.'
}
$catalog = Join-Path $PSScriptRoot '..\..\apps\simulator\src\mining\plant-catalog.json'
$bundle = New-MiningSnapshotBundle -Run $run -AsOfUtc $capture.asOfUtc -CatalogPath $catalog -PublisherEvidence $capture.publisherEvidence -Ingestion $capture.ingestion -Telemetry $capture.telemetry -State $capture.state
$client = New-MiningSnapshotClient $target -AzureCliPython $AzureCliPython
Invoke-MiningSnapshotDeployment $bundle $target $client $ReceiptPath -Mode $Mode -PythonExecutable $PythonExecutable
