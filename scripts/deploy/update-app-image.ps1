#Requires -Version 7.0
<#
.SYNOPSIS
Updates one existing app/job to an immutable ACR digest without redeploying infrastructure.
.DESCRIPTION
Rejects bootstrap workloads and mismatched targets. Preserves runtime overlays,
ingress, custom domains, identities and job schedules; verifies the image and
non-image configuration after the update. Does not build images or start jobs.
Use -WhatIf for read-only preflight. Outputs identifiers and status, never runtime values.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$')]
    [string]$SubscriptionId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,89}$')]
    [string]$ResourceGroupName,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z][a-z0-9-]{0,30}[a-z0-9]$')]
    [string]$NamePrefix,

    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9]{5,50}$')]
    [string]$RegistryName,

    [Parameter(Mandatory)]
    [ValidateSet('cockpit', 'streaming-backend', 'mcp-tools', 'simulator')]
    [string]$App,

    [Parameter(Mandatory)]
    [ValidatePattern('^sha256:[a-f0-9]{64}$')]
    [string]$ImageDigest
)

$ErrorActionPreference = 'Stop'
if ($ImageDigest -cnotmatch '^sha256:[a-f0-9]{64}$') { throw 'Digest must use lowercase sha256 hexadecimal.' }
$resourceName = "$NamePrefix-$App"
$resourceType = if ($App -eq 'simulator') { 'jobs' } else { 'containerApps' }
$resourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.App/$resourceType/$resourceName"
$cliScope = @('--subscription', $SubscriptionId, '--resource-group', $ResourceGroupName, '--name', $resourceName)
$cliResource = @('containerapp')
if ($App -eq 'simulator') { $cliResource += 'job' }

function Invoke-AzureJson {
    param([string[]]$Arguments)
    $output = az @Arguments --only-show-errors -o json
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($output -join "`n"))) {
        throw 'Azure read failed; no further deployment operations will run.'
    }
    return ($output -join "`n") | ConvertFrom-Json -AsHashtable
}

function ConvertTo-CanonicalObject {
    param($Value)
    if ($Value -is [System.Collections.IDictionary]) {
        $sorted = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) {
            $sorted[$key] = ConvertTo-CanonicalObject $Value[$key]
        }
        return $sorted
    }
    if ($Value -is [array]) {
        return ,@($Value | ForEach-Object { ConvertTo-CanonicalObject $_ })
    }
    return $Value
}

function Get-PreservedState {
    param($Resource)
    # Revision suffixes are service-generated; all other template fields must survive.
    $template = $Resource.properties.template.Clone()
    $template.Remove('revisionSuffix')
    $containers = @($template.containers | ForEach-Object {
        $container = $_.Clone()
        if ($container.name -eq $App) { $container.Remove('image') }
        $container
    })
    $template.containers = $containers
    $state = @{
        identity = $Resource.identity
        environmentId = $Resource.properties.environmentId
        managedEnvironmentId = $Resource.properties.managedEnvironmentId
        configuration = $Resource.properties.configuration
        template = $template
    }
    return ConvertTo-CanonicalObject $state | ConvertTo-Json -Depth 100 -Compress
}

$account = Invoke-AzureJson -Arguments @('account', 'show', '--subscription', $SubscriptionId)
if ($account.id -ne $SubscriptionId) { throw 'Azure returned a different subscription.' }
$registry = Invoke-AzureJson -Arguments @('acr', 'show', '--subscription', $SubscriptionId, '--resource-group', $ResourceGroupName, '--name', $RegistryName)
if ($registry.loginServer -ne "$RegistryName.azurecr.io") {
    throw 'Registry login server does not match the approved public Azure ACR target.'
}
$image = "$($registry.loginServer)/$App@$ImageDigest"
$manifest = Invoke-AzureJson -Arguments @('acr', 'repository', 'show', '--subscription', $SubscriptionId, '--name', $RegistryName, '--image', "$App@$ImageDigest")
if ($manifest.digest -cne $ImageDigest) { throw 'Requested image digest was not verified in the approved ACR repository.' }
$before = Invoke-AzureJson ($cliResource + @('show') + $cliScope)
if ($before.id -ine $resourceId -or $before.properties.provisioningState -ne 'Succeeded') {
    throw 'Target ID or provisioning state does not match an existing ready workload.'
}
$containers = @($before.properties.template.containers)
if ($containers.Count -ne 1 -or $containers[0].name -ne $App) {
    throw 'Expected exactly one named application container; review this workload separately.'
}
if ($containers[0].image -notmatch "^$([regex]::Escape($registry.loginServer))/$([regex]::Escape($App))[:@]") {
    throw 'Bootstrap or foreign-registry image detected; image-only deployment cannot migrate this workload.'
}
if ($containers[0].command -or $containers[0].args) {
    throw 'Container command/argument overrides require separate review before image-only deployment.'
}
if ($App -ne 'simulator') {
    $ports = @{ cockpit = 3300; 'streaming-backend' = 3000; 'mcp-tools' = 3100 }
    if ($before.properties.configuration.ingress.targetPort -ne $ports[$App]) {
        throw 'Ingress target port does not match this application; no ingress changes are permitted.'
    }
    if ($before.properties.configuration.activeRevisionsMode -ne 'Single') {
        throw 'Multiple-revision traffic routing requires separate review.'
    }
}
$preservedState = Get-PreservedState $before
if ($containers[0].image -eq $image) {
    return [PSCustomObject]@{ ResourceId = $resourceId; Image = $image; Status = 'Unchanged' }
}
if (-not $PSCmdlet.ShouldProcess($resourceId, "Update only container '$App' image to $image")) {
    return [PSCustomObject]@{ ResourceId = $resourceId; Image = $image; Status = 'NotApplied' }
}

az @cliResource update @cliScope --container-name $App --image $image --only-show-errors -o none
if ($LASTEXITCODE -ne 0) { throw 'Image update failed; inspect the target before any retry.' }
$after = Invoke-AzureJson ($cliResource + @('show') + $cliScope)
if ($after.id -ine $resourceId -or $after.properties.provisioningState -ne 'Succeeded' -or
    @($after.properties.template.containers | Where-Object { $_.name -eq $App -and $_.image -eq $image }).Count -ne 1) {
    throw 'Image update was submitted but the expected ready image was not verified; inspect the target.'
}
if ((Get-PreservedState $after) -cne $preservedState) {
    throw 'Image changed but runtime configuration preservation failed; stop and inspect. No automatic rollback was attempted.'
}
[PSCustomObject]@{ ResourceId = $resourceId; Image = $image; Status = 'Verified' }
