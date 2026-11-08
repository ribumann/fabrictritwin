#Requires -Version 7.0
<#
.SYNOPSIS
Merges resolved simulator/Fabric settings into existing workloads without redeploying them.
.DESCRIPTION
Called after foundation creation. Native secrets are read and merged only in memory.
No image, identity, ingress, scale, or Easy Auth changes are made.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [Parameter(Mandatory)][string]$TenantId,
    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$NamePrefix = 'triatwin-dev',
    [string]$LakehouseOneLakeFileSystem,
    [string]$LakehouseOneLakePath,
    [string]$EventstreamEventHubConnectionString,
    [string]$EventhouseQueryUri,
    [string]$EventhouseDatabaseName,
    [string]$DefaultAthleteId,
    [hashtable]$AuthorizedAthletePrincipalMap = @{}
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-arm.ps1')
$context = Get-RuntimeArmContext -SubscriptionId $SubscriptionId -TenantId $TenantId
$resourceRoot = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.App"
$changed = @()
foreach ($workload in @('streaming-backend', 'simulator', 'mcp-tools', 'cockpit')) {
    $envMap = @{}
    $secrets = @{}
    if ($workload -in @('streaming-backend', 'simulator')) {
        if ($LakehouseOneLakeFileSystem) {
            $envMap.LAKEHOUSE_ONELAKE_ACCOUNT_URL = 'https://onelake.dfs.fabric.microsoft.com'
            $envMap.LAKEHOUSE_ONELAKE_FILESYSTEM = $LakehouseOneLakeFileSystem
        }
        if ($LakehouseOneLakePath) { $envMap.LAKEHOUSE_ONELAKE_PATH = $LakehouseOneLakePath }
        if ($EventstreamEventHubConnectionString) {
            $secrets['eventstream-eventhub-connection-string'] = $EventstreamEventHubConnectionString
            $envMap.EVENTSTREAM_EVENTHUB_CONNECTION_STRING = @{ secretRef = 'eventstream-eventhub-connection-string' }
        }
    }
    if ($workload -in @('streaming-backend', 'mcp-tools')) {
        if ($EventhouseQueryUri) { $envMap.EVENTHOUSE_QUERY_URI = $EventhouseQueryUri }
        if ($EventhouseDatabaseName) { $envMap.EVENTHOUSE_DATABASE_NAME = $EventhouseDatabaseName }
    }
    if ($workload -eq 'cockpit' -and $DefaultAthleteId) {
        $envMap.DEFAULT_ATHLETE_ID = [guid]::Parse($DefaultAthleteId).ToString()
    }
    $updateMap = $workload -eq 'streaming-backend' -and ($DefaultAthleteId -or $AuthorizedAthletePrincipalMap.Count -gt 0)
    if ($envMap.Count -eq 0 -and $secrets.Count -eq 0 -and -not $updateMap) { continue }
    $kind = if ($workload -eq 'simulator') { 'jobs' } else { 'containerApps' }
    $app = Invoke-RuntimeArm -Context $context -ResourceId "$resourceRoot/$kind/$NamePrefix-$workload"
    if ($updateMap) {
        $current = Get-RuntimeEnvironment (Get-RuntimeContainer $app $workload)
        $mapJson = if ($current.ATHLETE_PRINCIPAL_MAP) { $current.ATHLETE_PRINCIPAL_MAP } else { '{}' }
        $mapJson = Merge-RuntimePrincipalMap -ExistingJson $mapJson -Additions $AuthorizedAthletePrincipalMap
        if ($DefaultAthleteId) {
            $serviceMap = @{}
            foreach ($caller in @('cockpit')) {
                $identity = Invoke-RuntimeArm -Context $context -ResourceId "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$NamePrefix-id-$caller" -ApiVersion '2023-01-31'
                $serviceMap[[guid]::Parse($identity.properties.principalId).ToString()] = $DefaultAthleteId
            }
            $mapJson = Merge-RuntimePrincipalMap -ExistingJson $mapJson -Additions $serviceMap
        }
        $envMap.ATHLETE_PRINCIPAL_MAP = $mapJson
    }
    if (Update-RuntimeAppSetting -Context $context -App $app -ContainerName $workload -Environment $envMap -Secrets $secrets) {
        $changed += $workload
    }
}
return [pscustomobject]@{ ChangedWorkloads = $changed; WhatIf = [bool]$WhatIfPreference }
