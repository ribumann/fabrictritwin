#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$LakehouseId,
    [guid]$SemanticModelId = [guid]::Empty,
    [ValidateSet('Generate', 'CatalogVerify', 'CatalogApply')][string]$Mode = 'Generate',
    [string]$TargetPath,
    [string]$ReceiptPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspaceId = [guid]'4a809e56-42a8-4c30-a84f-83a47dd8793f'
if ($LakehouseId -eq [guid]::Empty) { throw 'A nonempty isolated Lakehouse ID is required.' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$catalogPath = Join-Path $root 'apps\simulator\src\mining\plant-catalog.json'
Import-Module (Join-Path $root 'scripts\mining-ontology\MiningOntology.psm1') -Force
$tables = New-MiningCatalogTables -CatalogPath $catalogPath

$catalogResult = $null
if ($Mode -ne 'Generate') {
    if ([string]::IsNullOrWhiteSpace($TargetPath) -or [string]::IsNullOrWhiteSpace($ReceiptPath)) {
        throw 'Catalog Verify and Apply require an exact target file and a receipt path.'
    }
    if (-not [IO.Path]::IsPathFullyQualified($ReceiptPath) -or
        -not (Test-Path -LiteralPath (Split-Path $ReceiptPath -Parent) -PathType Container)) {
        throw 'ReceiptPath must be absolute and in an existing private directory.'
    }
    $target = Get-Content -LiteralPath $TargetPath -Raw | ConvertFrom-Json -AsHashtable
    $targetWorkspace = [guid]::Empty
    $targetLakehouse = [guid]::Empty
    if (-not $target.Contains('WorkspaceId') -or
        -not [guid]::TryParseExact([string]$target.WorkspaceId, 'D', [ref]$targetWorkspace) -or
        $targetWorkspace -ne $workspaceId -or
        -not $target.Contains('StaticLakehouseId') -or
        -not [guid]::TryParseExact([string]$target.StaticLakehouseId, 'D', [ref]$targetLakehouse) -or
        $targetLakehouse -ne $LakehouseId) {
        throw 'Target must identify the approved isolated workspace and the selected Lakehouse.'
    }
    $loadMode = if ($Mode -eq 'CatalogApply') { 'Apply' } else { 'Verify' }
    $catalogResult = Invoke-MiningCatalogLoad -CatalogPath $catalogPath -Target $target `
        -ReceiptPath $ReceiptPath -Mode $loadMode
}

$model = (& (Join-Path $PSScriptRoot 'New-MiningAnalyticsDefinition.ps1') `
        -WorkspaceId $workspaceId -LakehouseId $LakehouseId -DefinitionKind SemanticModel).SemanticModelRequest
$agent = $null
if ($SemanticModelId -ne [guid]::Empty) {
    $agent = & (Join-Path $PSScriptRoot 'New-MiningDataAgentDefinition.ps1') `
        -WorkspaceId $workspaceId -SemanticModelId $SemanticModelId | ConvertFrom-Json
}

[pscustomobject]@{
    Status = 'GeneratedNotPublished'
    WorkspaceId = $workspaceId.ToString()
    LakehouseId = $LakehouseId.ToString()
    CatalogStatus = if ($catalogResult) { $catalogResult.status } else { 'GeneratedOnly' }
    CatalogTables = @($tables | ForEach-Object { [pscustomobject]@{
                Name = $_.name; RowCount = $_.rowCount; Sha256 = $_.sha256
            } })
    SemanticModelRequest = $model
    DataAgentDefinition = $agent
}
