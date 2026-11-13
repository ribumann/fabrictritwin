#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CatalogPath,
    [Parameter(Mandatory)][string]$BaselinePath,
    [Parameter(Mandatory)][string]$BaselineSha256,
    [Parameter(Mandatory)][string]$CurrentPath,
    [Parameter(Mandatory)][string]$TargetPath,
    [Parameter(Mandatory)][string]$TargetSha256,
    [Parameter(Mandatory)][string]$BundleDirectory,
    [Parameter(Mandatory)][string]$ReviewedPlanSha256,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [ValidateSet('Apply', 'Verify')][string]$Mode = 'Verify',
    [switch]$ApproveStaticWrites,
    [switch]$AcknowledgeNonAtomicUpdate,
    [string]$ExclusiveWriterWindowId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'MiningOntology.psm1') -Force
$planInputs = @{}
foreach ($key in @('CatalogPath', 'BaselinePath', 'BaselineSha256', 'CurrentPath', 'TargetPath', 'TargetSha256')) {
    $planInputs[$key] = $PSBoundParameters[$key]
}
Invoke-MiningStaticApply -PlanInputs $planInputs -BundleDirectory $BundleDirectory `
    -ReviewedPlanSha256 $ReviewedPlanSha256 -ReceiptPath $ReceiptPath -Mode $Mode `
    -ApproveStaticWrites:$ApproveStaticWrites -AcknowledgeNonAtomicUpdate:$AcknowledgeNonAtomicUpdate `
    -ExclusiveWriterWindowId $ExclusiveWriterWindowId
