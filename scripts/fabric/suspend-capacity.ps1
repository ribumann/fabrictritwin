#Requires -Version 7.0
<#
.SYNOPSIS
Idempotently pauses the ADR-001 Fabric capacity to avoid idle spend outside demo windows.

.DESCRIPTION
Implements T045a (specs/001-triathlon-training-twin/tasks.md). Mirrors `resume-capacity.ps1`
(T036a): Fabric capacities (`Microsoft.Fabric/capacities`) expose a `suspend` control-plane
action (`POST .../providers/Microsoft.Fabric/capacities/{name}/suspend?api-version=2023-11-01`),
invoked here via `az resource invoke-action`.

Not part of `provision-all.ps1`'s critical path -- invoked manually or by the scheduled
`.github/workflows/pause-capacity-schedule.yml` workflow (T049a), per ADR-001's "pause
outside demo windows to conserve credits" cost-control design.

Idempotent: no-ops with exit 0 if the capacity is already `Paused`.

.PARAMETER ResourceGroupName
Resource group containing the Fabric capacity.

.PARAMETER CapacityName
Name of the `Microsoft.Fabric/capacities` resource (the `capacityName` output of
`fabric-capacity.bicep`, e.g. `triatwindevfabriccap`).

.OUTPUTS
None. Writes progress to the host; throws (non-zero exit) on failure.

.EXAMPLE
./suspend-capacity.ps1 -ResourceGroupName rg-triathlon-twin-demo -CapacityName triatwindevfabriccap
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory)]
    [string]$CapacityName
)

$ErrorActionPreference = 'Stop'

$apiVersion = '2023-11-01'

function Get-FabricCapacityState {
    param([string]$ResourceGroupName, [string]$CapacityName)

    $json = az resource show `
        --resource-group $ResourceGroupName `
        --name $CapacityName `
        --resource-type 'Microsoft.Fabric/capacities' `
        --query 'properties.state' `
        -o tsv 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "Failed to read state of Fabric capacity '$CapacityName' in resource group '$ResourceGroupName':`n$json"
    }
    return ($json | Out-String).Trim()
}

Write-Host "Checking state of Fabric capacity '$CapacityName' in resource group '$ResourceGroupName'..."
$state = Get-FabricCapacityState -ResourceGroupName $ResourceGroupName -CapacityName $CapacityName
Write-Host "Current state: $state"

if ($state -eq 'Paused') {
    Write-Host "Fabric capacity '$CapacityName' is already Paused. Nothing to do."
    return
}

if ($PSCmdlet.ShouldProcess($CapacityName, 'Suspend Fabric capacity')) {
    Write-Host "Suspending Fabric capacity '$CapacityName'..."
    $resourceId = "/subscriptions/$((az account show --query id -o tsv))/resourceGroups/$ResourceGroupName/providers/Microsoft.Fabric/capacities/$CapacityName"
    az resource invoke-action --action suspend --ids $resourceId --api-version $apiVersion -o none
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to invoke the 'suspend' action on Fabric capacity '$CapacityName'."
    }
    Write-Host "Fabric capacity '$CapacityName' suspend action issued."
}
