#Requires -Version 7.0
<#
.SYNOPSIS
Builds and pushes the four remaining application container images (cockpit,
streaming-backend, mcp-tools, simulator) to the project's Azure Container Registry via `az acr build`.

.DESCRIPTION
Implements T041 (specs/001-triathlon-training-twin/tasks.md). For each Containerfile
produced by T040, runs `az acr build` (an ACR Task -- builds in the cloud, no local Docker
daemon required) with the **repository root as the build context** and
`--file apps/<app>/Containerfile`, matching the COPY paths each Containerfile assumes
(the npm workspaces monorepo needs the root `package.json`/`package-lock.json` plus every
workspace's own `package.json` to resolve dependencies correctly, even when building a
single app's image).

Idempotent/parameterized per `contracts/powershell-scripts-contract.md`: re-running with the
same `-ImageTag` simply rebuilds and overwrites that tag (ACR's own idempotent behavior for
a repeated `az acr build` with an identical tag); it is not itself destructive.

.PARAMETER SubscriptionId
Azure subscription ID containing the registry. Every Azure CLI call explicitly targets
this subscription without changing the CLI's default account, including during -WhatIf.

.PARAMETER ResourceGroupName
Resource group containing the Azure Container Registry. Defaults to
'rg-triathlon-twin-demo'.

.PARAMETER NamePrefix
Resource name prefix used to derive the registry name (`<namePrefix>acr`, hyphens removed,
per `infra/bicep/modules/container-registry.bicep`). Defaults to 'triatwin-dev'.

.PARAMETER RegistryName
Explicit ACR name, overriding the name derived from -NamePrefix. Use this if the registry
was provisioned with a non-default name.

.PARAMETER ImageTag
Tag to apply to all five images (e.g. a git SHA or version string). Required -- there is no
sensible default, since this is what advances the deployed application version.

.PARAMETER Apps
Which of the five apps to build. Defaults to all five. Accepts any subset for faster
iteration on a single app.

.OUTPUTS
PSCustomObject array, one entry per built app, with AppName, ImageName (registry/repo:tag),
and Containerfile path -- consumed by deploy-container-apps.ps1 (T042).

.EXAMPLE
./build-and-push-images.ps1 -SubscriptionId 7e6d4db3-7e33-54a8-9961-0da1b232e787 -ImageTag v1
Builds and pushes all four images tagged `v1`.

.EXAMPLE
./build-and-push-images.ps1 -SubscriptionId 7e6d4db3-7e33-54a8-9961-0da1b232e787 -ImageTag v2 -Apps cockpit
Rebuilds only the Cockpit image tagged `v2`.
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

    [ValidateSet('cockpit', 'streaming-backend', 'mcp-tools', 'simulator')]
    [string[]]$Apps = @('cockpit', 'streaming-backend', 'mcp-tools', 'simulator')
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path

# apps/mcp-tools' image repository is named 'mcp-tools' (matches its ACR image name in
# mcp-tool-server.bicep's containerImage variable), which is also its directory name -- so no
# app-name-to-image-name translation table is needed; each app directory name IS the image
# repository name.
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

Write-Host "Target registry: $RegistryName (resource group '$ResourceGroupName')"
Write-Host "Image tag: $ImageTag"
Write-Host "Apps: $($Apps -join ', ')"
Write-Host ''

$results = @()

foreach ($app in $Apps) {
    $containerfile = Join-Path $repoRoot 'apps' $app 'Containerfile'
    if (-not (Test-Path $containerfile)) {
        throw "Containerfile not found for app '$app' at '$containerfile' (expected from T040)."
    }

    $imageName = "${app}:${ImageTag}"
    Write-Host "--- Building '$app' -> $RegistryName.azurecr.io/$imageName ---"

    if ($PSCmdlet.ShouldProcess($imageName, "az acr build (registry $RegistryName)")) {
        # `az acr build` uploads the given context (repo root, '.') to ACR Tasks and builds
        # remotely -- no local Docker daemon is required, matching this project's CI runners.
        Push-Location $repoRoot
        try {
            az acr build `
                --subscription $SubscriptionId `
                --registry $RegistryName `
                --resource-group $ResourceGroupName `
                --image $imageName `
                --file $containerfile `
                .
            if ($LASTEXITCODE -ne 0) {
                throw "az acr build failed for app '$app' (image '$imageName')."
            }
        }
        finally {
            Pop-Location
        }
    }

    $results += [PSCustomObject]@{
        AppName       = $app
        ImageName     = $imageName
        Containerfile = $containerfile
    }
}

Write-Host ''
Write-Host 'All requested images built and pushed successfully:'
$results | Format-Table -AutoSize | Out-String | Write-Host

return $results
