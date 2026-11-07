#Requires -Version 7.0
<#
.SYNOPSIS
Idempotently resumes the ADR-001 Fabric capacity if it is currently paused, and waits until
it reports an "Active" state.

.DESCRIPTION
Implements T036a (specs/001-triathlon-training-twin/tasks.md). Fabric capacities
(`Microsoft.Fabric/capacities`, provisioned by `infra/bicep/modules/fabric-capacity.bicep`)
are ARM resources exposing `resume`/`suspend` control-plane actions
(`POST .../providers/Microsoft.Fabric/capacities/{name}/resume?api-version=2023-11-01`),
invoked here via `az resource invoke-action` rather than a raw REST call, since the `az` CLI
already handles auth/retries for ARM control-plane actions.

This is a hard execution-order prerequisite of `provision-fabric-items.ps1` (T036): Fabric
item creation and workspace-to-capacity assignment both require an `Active` capacity, so
`provision-fabric-items.ps1` calls this script first, unconditionally, on every run.

Idempotent: no-ops with exit 0 if the capacity is already `Active`.

.PARAMETER ResourceGroupName
Resource group containing the Fabric capacity.

.PARAMETER CapacityName
Name of the `Microsoft.Fabric/capacities` resource (the `capacityName` output of
`fabric-capacity.bicep`, e.g. `triatwindevfabriccap`).

.PARAMETER TimeoutSeconds
Maximum time to wait for the capacity to report `Active` after issuing the resume action.
Defaults to 300 seconds (5 minutes).

.PARAMETER SubscriptionId
Explicit subscription used for all reads, actions and polls. Provisioning always supplies
this; omitted direct calls retain the legacy current-subscription behavior.

.OUTPUTS
None. Writes progress to the host; throws (non-zero exit) on failure or timeout.

.EXAMPLE
./resume-capacity.ps1 -ResourceGroupName rg-triathlon-twin-demo -CapacityName triatwindevfabriccap
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory)]
    [string]$CapacityName,

    [int]$TimeoutSeconds = 300,
    [string]$SubscriptionId
)

$ErrorActionPreference = 'Stop'

$apiVersion = '2023-11-01'
$pollIntervalSeconds = 10
$subscriptionArguments = if ($SubscriptionId) { @('--subscription', $SubscriptionId) } else { @() }

function Get-FabricCapacityState {
    param([string]$ResourceGroupName, [string]$CapacityName)

    $json = az resource show `
        @subscriptionArguments `
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

function Invoke-ResumeCapacity {
    <#
    Main flow, wrapped in a function purely for readability/structure. Pester
    (tests/pester/Fabric-Capacity-Lifecycle.Tests.ps1, T039a) tests this script as a black
    box: it mocks the external `az`/`Start-Sleep` commands and invokes the script file
    directly (`& $scriptPath -ResourceGroupName ... -CapacityName ...`), since the top-level
    parameters are mandatory and dot-sourcing without supplying them would otherwise prompt.
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param(
        [Parameter(Mandatory)]
        [string]$ResourceGroupName,

        [Parameter(Mandatory)]
        [string]$CapacityName,

        [int]$TimeoutSeconds = 300
    )

    Write-Host "Checking state of Fabric capacity '$CapacityName' in resource group '$ResourceGroupName'..."
    $state = Get-FabricCapacityState -ResourceGroupName $ResourceGroupName -CapacityName $CapacityName
    Write-Host "Current state: $state"

    if ($state -eq 'Active') {
        Write-Host "Fabric capacity '$CapacityName' is already Active. Nothing to do."
        return
    }

    if ($PSCmdlet.ShouldProcess($CapacityName, 'Resume Fabric capacity')) {
        Write-Host "Resuming Fabric capacity '$CapacityName'..."
        $targetSubscription = $SubscriptionId
        if (-not $targetSubscription) {
            $targetSubscription = az account show --query id -o tsv
            if ($LASTEXITCODE -ne 0 -or -not $targetSubscription) { throw 'Cannot resolve the Azure subscription for capacity resume.' }
        }
        $resourceId = "/subscriptions/$targetSubscription/resourceGroups/$ResourceGroupName/providers/Microsoft.Fabric/capacities/$CapacityName"
        az resource invoke-action --action resume --ids $resourceId --api-version $apiVersion @subscriptionArguments -o none
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to invoke the 'resume' action on Fabric capacity '$CapacityName'."
        }
    }
    else {
        return
    }

    Write-Host "Waiting for Fabric capacity '$CapacityName' to become Active (timeout: ${TimeoutSeconds}s)..."
    $elapsed = 0
    while ($elapsed -lt $TimeoutSeconds) {
        Start-Sleep -Seconds $pollIntervalSeconds
        $elapsed += $pollIntervalSeconds
        $state = Get-FabricCapacityState -ResourceGroupName $ResourceGroupName -CapacityName $CapacityName
        Write-Host "  [$($elapsed)s] state: $state"
        if ($state -eq 'Active') {
            Write-Host "Fabric capacity '$CapacityName' is now Active."
            return
        }
    }

    throw "Timed out after ${TimeoutSeconds}s waiting for Fabric capacity '$CapacityName' to become Active (last observed state: $state)."
}

Invoke-ResumeCapacity -ResourceGroupName $ResourceGroupName -CapacityName $CapacityName -TimeoutSeconds $TimeoutSeconds
