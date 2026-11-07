#Requires -Version 7.0
<#
.SYNOPSIS
Rolls the Console, Cockpit, Streaming Backend, MCP Tool Server Container Apps and the Simulator
Container Apps Job to a freshly built image tag.

.DESCRIPTION
Implements T042 (specs/001-triathlon-training-twin/tasks.md). Wraps `az containerapp update`
(for the four ingress-based Container Apps from T020/T021/T022/T123) and
`az containerapp job update` (for the Simulator Job from T023) to switch each resource's
container image to `<registryLoginServer>/<app>:<imageTag>`, replacing whatever image
(including the `imageTag = 'placeholder'` bootstrap image) is currently deployed.

Idempotent/parameterized per `contracts/powershell-scripts-contract.md`: re-running with the
same `-ImageTag` is a no-op revision-wise (Container Apps only creates a new revision when
the image reference actually changes); safe to re-run. Also corrects each ingress-based app's
`targetPort` to match the image being deployed (80 for the bootstrap placeholder, the app's real
listen port otherwise), since `az containerapp update --image` alone never updates ingress
config -- this is a second `az containerapp ingress update` call made right after the image swap.

.PARAMETER SubscriptionId
Azure subscription ID containing the Container Apps environment. Every Azure CLI call
explicitly targets this subscription without changing the CLI's default account,
including during -WhatIf.

.PARAMETER ResourceGroupName
Resource group containing the Container Apps/Job. Defaults to 'rg-triathlon-twin-demo'.

.PARAMETER NamePrefix
Resource name prefix used to derive each Container App/Job's name (`<namePrefix>-console`,
etc., per the `infra/bicep/modules/*.bicep` naming convention). Defaults to 'triatwin-dev'.

.PARAMETER RegistryName
Azure Container Registry name to pull images from. Defaults to `<namePrefix>acr` (hyphens
removed), matching `container-registry.bicep`'s naming convention.

.PARAMETER ImageTag
Tag to deploy, matching the tag just built by build-and-push-images.ps1 (T041). Required.

.PARAMETER Apps
Which of the five apps to roll. Defaults to all five. Accepts any subset for faster
iteration on a single app.

.OUTPUTS
PSCustomObject array, one entry per updated app, with AppName, ResourceType
(Microsoft.App/containerApps or Microsoft.App/jobs), and ImageName.

.EXAMPLE
./deploy-container-apps.ps1 -SubscriptionId 7e6d4db3-7e33-54a8-9961-0da1b232e787 -ImageTag v1
Rolls all four apps/job to the `v1` image tag.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$NamePrefix = 'triatwin-dev',
    [string]$RegistryName,

    [Parameter(Mandatory)]
    [string]$ImageTag,

    [ValidateSet('console', 'cockpit', 'streaming-backend', 'mcp-tools', 'simulator')]
    [string[]]$Apps = @('console', 'cockpit', 'streaming-backend', 'mcp-tools', 'simulator')
)

$ErrorActionPreference = 'Stop'

# Each app's Container App/Job resource name and Azure resource type, per the corresponding
# infra/bicep/modules/*.bicep file's `name:` property.
$appResourceMap = @{
    'console'           = @{ ResourceName = "$NamePrefix-console"; ResourceType = 'containerapp' }
    'cockpit'           = @{ ResourceName = "$NamePrefix-cockpit"; ResourceType = 'containerapp' }
    'streaming-backend' = @{ ResourceName = "$NamePrefix-streaming-backend"; ResourceType = 'containerapp' }
    'mcp-tools'         = @{ ResourceName = "$NamePrefix-mcp-tools"; ResourceType = 'containerapp' }
    'simulator'         = @{ ResourceName = "$NamePrefix-simulator"; ResourceType = 'containerappjob' }
}

$appTargetPortMap = @{
    'console'           = 3200
    'cockpit'           = 3300
    'streaming-backend' = 3000
    'mcp-tools'         = 3100
}

if (-not $RegistryName) {
    $RegistryName = (('{0}acr' -f $NamePrefix) -replace '-', '')
}

function Assert-AzureContext {
    param([string]$SubscriptionId)

    Write-Host "Verifying az CLI login for subscription $SubscriptionId..."
    $accountJson = az account show --subscription $SubscriptionId -o json
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($accountJson -join "`n"))) {
        throw "Failed to read Azure subscription '$SubscriptionId'. Sign in to its tenant with 'az login' first."
    }
    $account = ($accountJson -join "`n") | ConvertFrom-Json
    if ($account.id -ne $SubscriptionId) {
        throw "Azure CLI returned an unexpected subscription instead of '$SubscriptionId'."
    }
    Write-Host "Using subscription: $SubscriptionId"
}

Assert-AzureContext -SubscriptionId $SubscriptionId

Write-Host "Resolving login server for registry '$RegistryName'..."
$registryLoginServer = (az acr show --subscription $SubscriptionId --name $RegistryName --resource-group $ResourceGroupName --query loginServer -o tsv)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($registryLoginServer)) {
    throw "Failed to resolve the login server for registry '$RegistryName' in resource group '$ResourceGroupName'."
}
Write-Host "Registry login server: $registryLoginServer"
Write-Host "Image tag: $ImageTag"
Write-Host "Apps: $($Apps -join ', ')"
Write-Host ''

$results = @()

foreach ($app in $Apps) {
    $mapping = $appResourceMap[$app]
    $imageRef = "$registryLoginServer/${app}:${ImageTag}"

    Write-Host "--- Rolling '$app' ($($mapping.ResourceName)) to $imageRef ---"

    if ($PSCmdlet.ShouldProcess($mapping.ResourceName, "Update image to $imageRef")) {
        if ($mapping.ResourceType -eq 'containerapp') {
            az containerapp update `
                --subscription $SubscriptionId `
                --name $mapping.ResourceName `
                --resource-group $ResourceGroupName `
                --image $imageRef `
                -o none
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to update '$($mapping.ResourceName)' to image '$imageRef'."
            }

            # Keep ingress targetPort in sync with the image being deployed (see $appTargetPortMap
            # comment above) -- this must run as a second, separate call because `containerapp
            # update` does not accept `--target-port`; only `containerapp ingress update` does.
            $targetPort = if ($ImageTag -eq 'placeholder') { 80 } else { $appTargetPortMap[$app] }
            Write-Host "Syncing '$($mapping.ResourceName)' ingress target port to $targetPort..."
            az containerapp ingress update `
                --subscription $SubscriptionId `
                --name $mapping.ResourceName `
                --resource-group $ResourceGroupName `
                --target-port $targetPort `
                -o none
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to update ingress target port for '$($mapping.ResourceName)' to $targetPort."
            }
        }
        else {
            az containerapp job update `
                --subscription $SubscriptionId `
                --name $mapping.ResourceName `
                --resource-group $ResourceGroupName `
                --image $imageRef `
                -o none

            if ($LASTEXITCODE -ne 0) {
                throw "Failed to update '$($mapping.ResourceName)' to image '$imageRef'."
            }
        }
    }

    $results += [PSCustomObject]@{
        AppName      = $app
        ResourceName = $mapping.ResourceName
        ResourceType = $mapping.ResourceType
        ImageName    = $imageRef
    }
}

Write-Host ''
Write-Host 'All requested Container Apps/Jobs updated successfully:'
$results | Format-Table -AutoSize | Out-String | Write-Host

return $results
