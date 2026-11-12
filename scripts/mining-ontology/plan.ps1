#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CatalogPath,
    [Parameter(Mandatory)][string]$BaselinePath,
    [Parameter(Mandatory)][string]$BaselineSha256,
    [Parameter(Mandatory)][string]$CurrentPath,
    [Parameter(Mandatory)][string]$TargetPath,
    [Parameter(Mandatory)][string]$TargetSha256,
    [ValidateSet('Plan', 'Verify', 'Apply')][string]$Mode = 'Plan',
    [string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'MiningOntology.psm1') -Force
$arguments = @{}
foreach ($key in @('CatalogPath', 'BaselinePath', 'BaselineSha256', 'CurrentPath', 'TargetPath', 'TargetSha256')) {
    $arguments[$key] = $PSBoundParameters[$key]
}
$plan = New-MiningOntologyPlan @arguments
if ($Mode -eq 'Apply') { throw ("Apply is blocked. " + ($plan.blockers -join ' ')) }
if ($Mode -eq 'Verify' -and $plan.status -ne 'DefinitionMatchesOffline') {
    throw 'Current snapshot does not match the additive definition; no live verification was performed.'
}
if ($OutputDirectory) { Export-MiningOntologyPlan -Plan $plan -OutputDirectory $OutputDirectory }
else { $plan }
