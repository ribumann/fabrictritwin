#Requires -Version 7.0

[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,

    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$Location = 'polandcentral',
    [string]$FabricLocation = 'italynorth',
    [string]$FoundryLocation = 'swedencentral',
    [string]$NamePrefix = 'triatwin-dev',

    [ValidateSet('F2', 'F4', 'F8', 'F16', 'F32', 'F64')]
    [string]$FabricCapacitySkuName = 'F4',

    [string]$FabricCapacityAdminUpn = 'admin@example.invalid',

    [ValidateSet('Basic', 'Standard', 'Premium')]
    [string]$AcrSkuName = 'Basic',

    [string]$ImageTag = 'placeholder',
    [string]$SimulatorDailyScheduleCron = '0 3 * * *',
    [string]$DeploymentName = "infra-$(Get-Date -Format 'yyyyMMdd-HHmmss')",
    [string]$TenantId,
    [string]$LakehouseOneLakeFileSystem,
    [string]$LakehouseOneLakePath,
    [string]$EventstreamEventHubConnectionString,
    [string]$EventhouseQueryUri,
    [string]$EventhouseDatabaseName,
    [string]$DefaultAthleteId,
    [hashtable]$AuthorizedAthletePrincipalMap = @{}
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
$bicepMainFile = Join-Path $repoRoot 'infra' 'bicep' 'main.bicep'
$entraScriptPath = Join-Path $PSScriptRoot 'provision-entra-app-registrations.ps1'
. (Join-Path $PSScriptRoot 'runtime-arm.ps1')

if (-not (Test-Path $bicepMainFile)) {
    throw "Bicep entry point not found at '$bicepMainFile'. Run this script from a checkout of the fabrictritwin repository."
}
if (-not (Test-Path $entraScriptPath)) {
    throw "Required companion script not found at '$entraScriptPath' (T019)."
}

function Invoke-Az {
    <#
    Runs an `az` CLI command, treating a non-zero exit code as a terminating error (the `az`
    CLI does not throw PowerShell exceptions on failure by default).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,
        [switch]$AsJson
    )

    $output = & az @Arguments --subscription $SubscriptionId 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ') failed (exit $LASTEXITCODE):`n$($output -join [Environment]::NewLine)"
    }
    if ($AsJson) {
        if ([string]::IsNullOrWhiteSpace(($output -join ''))) {
            return $null
        }
        return ($output -join [Environment]::NewLine) | ConvertFrom-Json
    }
    return $output
}

function Assert-ResourceGroup {
    param(
        [string]$ResourceGroupName,
        [string]$Location
    )

    # `az group exists` always exits 0 and prints "true"/"false", unlike `az group show` which
    # exits non-zero (and would trip Invoke-Az's error handling) when the group is missing.
    $exists = (Invoke-Az -Arguments @('group', 'exists', '--name', $ResourceGroupName)) -join '' -eq 'true'
    if ($exists) {
        Write-Host "Resource group '$ResourceGroupName' already exists -- reusing."
        return
    }

    Write-Host "Creating resource group '$ResourceGroupName' in $Location..."
    Invoke-Az -Arguments @('group', 'create', '--name', $ResourceGroupName, '--location', $Location, '-o', 'none') | Out-Null
}

function Get-WorkloadManagedIdentityPrincipalId {
    <#
    Best-effort lookup of a workload's user-assigned managed identity object id (principalId),
    used to authorize service-to-service callers like the Console and Cockpit in
    ATHLETE_PRINCIPAL_MAP (FR-017). Returns $null (not an error) when the identity does not exist
    yet -- e.g. the very first bootstrap run, before managed-identities.bicep has ever deployed --
    so the caller can fall back to an admin-only mapping for that run and pick up the managed
    identity mapping automatically on the next (idempotent) run of this script, once the identity
    exists.
    #>
    param(
        [string]$ResourceGroupName,
        [string]$NamePrefix,
        [string]$WorkloadName
    )

    $identityName = "$NamePrefix-id-$WorkloadName"
    $identity = Invoke-RuntimeArm -Context $armContext -ResourceId "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$identityName" -ApiVersion '2023-01-31' -AllowNotFound
    if ($null -eq $identity) {
        Write-Host "$WorkloadName managed identity '$identityName' does not exist yet."
        return $null
    }
    return $identity.properties.principalId
}

function New-ArmParametersFile {
    <#
    Builds an ARM parameters JSON file (not main.bicepparam) so array-typed parameters
    (foundryUserPrincipalIds) can be supplied without the CLI array-quoting issues that occur
    when combining a .bicepparam file with an inline --parameters override.
    #>
    param([hashtable]$Values)

    $parameters = @{}
    foreach ($key in $Values.Keys) {
        $parameters[$key] = @{ value = $Values[$key] }
    }
    $armParams = [ordered]@{
        '$schema'      = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'
        contentVersion = '1.0.0.0'
        parameters     = $parameters
    }

    # Always writes for real, even under -WhatIf: this file is a read-only prerequisite for
    # `az deployment group what-if` itself (not a mutating Azure operation being previewed).
    # Set-Content would honor the ambient $WhatIfPreference (inherited from this script's own
    # -WhatIf) and silently no-op, leaving `az ... --parameters @<missing file>` to fail --
    # so [System.IO.File]::WriteAllText is used instead, which has no ShouldProcess support.
    $tempFile = Join-Path ([System.IO.Path]::GetTempPath()) "triatwin-deploy-params-$([Guid]::NewGuid().ToString('N')).json"
    [System.IO.File]::WriteAllText($tempFile, ($armParams | ConvertTo-Json -Depth 10))
    return $tempFile
}

function Invoke-EntraAppRegistration {
    param(
        [string]$NamePrefix,
        [string]$FabricCapacityAdminUpn,
        [string]$TenantId,
        [string[]]$RedirectUris = @()
    )

    $splat = @{
        AppDisplayNamePrefix   = $NamePrefix
        FabricCapacityAdminUpn = $FabricCapacityAdminUpn
    }
    if ($TenantId) {
        $splat.TenantId = $TenantId
    }
    if ($RedirectUris.Count -gt 0) {
        $splat.RedirectUris = $RedirectUris
    }

    return & $entraScriptPath @splat
}

Write-Host "=== provision-azure-resources.ps1 (T035) ==="
Write-Host "ResourceGroupName : $ResourceGroupName"
Write-Host "Location          : $Location"
Write-Host "FabricLocation    : $FabricLocation"
Write-Host "FoundryLocation   : $FoundryLocation"
Write-Host "NamePrefix        : $NamePrefix"
Write-Host ''

$armContext = Get-RuntimeArmContext -SubscriptionId $SubscriptionId -TenantId $TenantId
$TenantId = $armContext.TenantId
$preservedWorkloads = @()
foreach ($workload in @('console', 'cockpit', 'streaming-backend', 'mcp-tools', 'simulator')) {
    $resourceType = if ($workload -eq 'simulator') { 'jobs' } else { 'containerApps' }
    $resourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.App/$resourceType/$NamePrefix-$workload"
    $existing = Invoke-RuntimeArm -Context $armContext -ResourceId $resourceId -AllowNotFound
    if ($null -ne $existing) {
        if ($existing.id -ne $resourceId) { throw "Workload lookup returned an unexpected resource ID for '$workload'." }
        $preservedWorkloads += $workload
    }
}
Write-Host "Preserving existing workloads (images, env, secrets, auth): $($preservedWorkloads -join ', ')."
Write-Host 'Their Bicep modules are intentionally bypassed; runtime overlays and deploy-container-apps.ps1 own subsequent changes.'

Write-Host ''
Write-Host '--- Step 1/4: Entra app registration (T019, first pass) ---'
if ($WhatIfPreference) {
    # provision-entra-app-registrations.ps1 (T019) has no ShouldProcess/-WhatIf support of its
    # own -- it always creates/updates real Entra ID state via Microsoft Graph. Calling it
    # unconditionally here would make `-WhatIf` mutate real tenant data, defeating the whole
    # point of a dry run. So under -WhatIf this step is skipped entirely and placeholder GUIDs
    # are substituted, which is sufficient to let `az deployment group what-if` evaluate the
    # Bicep template shape/diff (What-if does not validate these values against Graph).
    Write-Host 'What-if mode: skipping the real Entra app registration call (it has no dry-run support and would mutate tenant state). Using placeholder AuthClientId/AdminObjectId for the Bicep what-if only.'
    $entraResult = [PSCustomObject]@{
        AuthClientId  = '00000000-0000-0000-0000-000000000000'
        AdminObjectId = '00000000-0000-0000-0000-000000000000'
        TenantId      = $TenantId
    }
}
else {
    $entraResult = Invoke-EntraAppRegistration -NamePrefix $NamePrefix -FabricCapacityAdminUpn $FabricCapacityAdminUpn -TenantId $TenantId
    if (-not $entraResult -or -not $entraResult.AuthClientId) {
        throw 'provision-entra-app-registrations.ps1 did not return an AuthClientId. Cannot continue.'
    }
}
Write-Host "AuthClientId  : $($entraResult.AuthClientId)"
Write-Host "AdminObjectId : $($entraResult.AdminObjectId)"

Write-Host ''
Write-Host '--- Step 2/4: Resource group ---'
if ($PSCmdlet.ShouldProcess($ResourceGroupName, 'Create resource group if missing')) {
    Assert-ResourceGroup -ResourceGroupName $ResourceGroupName -Location $Location
}

Write-Host ''
Write-Host '--- Step 3/4: Bicep deployment (infra/bicep/main.bicep) ---'
$deploymentParams = @{
    location                    = $Location
    fabricLocation               = $FabricLocation
    foundryLocation              = $FoundryLocation
    namePrefix                  = $NamePrefix
    fabricCapacitySkuName        = $FabricCapacitySkuName
    fabricCapacityAdminUpn       = $FabricCapacityAdminUpn
    authClientId                 = $entraResult.AuthClientId
    foundryUserPrincipalIds      = @($entraResult.AdminObjectId)
    operatorPrincipalId         = $entraResult.AdminObjectId
    acrSkuName                   = $AcrSkuName
    imageTag                     = $ImageTag
    simulatorDailyScheduleCron   = $SimulatorDailyScheduleCron
    preservedWorkloads           = $preservedWorkloads
}
# These three are only known once Fabric items exist. IMPORTANT: because each run generates a
# fresh ARM parameters file (not a merge/patch of the previous deployment), omitting them here
# does NOT preserve a prior run's values -- it resets them to main.bicep's empty-string default.
# So configure-simulator-connections.ps1 (T059b, invoked as provision-all.ps1's Step 3) always
# re-resolves and re-passes all three on every full provisioning run, the same way Step 4 below
# always re-registers Easy Auth redirect URIs rather than assuming a prior run's registration
# still holds. Callers who only want the Azure-resources-only first pass (Fabric items don't
# exist yet) simply omit these parameters, same as before this change.
if (-not [string]::IsNullOrWhiteSpace($LakehouseOneLakeFileSystem)) {
    $deploymentParams.lakehouseOneLakeAccountUrl = 'https://onelake.dfs.fabric.microsoft.com'
    $deploymentParams.lakehouseOneLakeFileSystem = $LakehouseOneLakeFileSystem
}
if (-not [string]::IsNullOrWhiteSpace($LakehouseOneLakePath)) {
    $deploymentParams.lakehouseOneLakePath = $LakehouseOneLakePath
}
# SAS is applied after creation using the in-memory overlay, never an ARM parameters file.
if (-not [string]::IsNullOrWhiteSpace($EventhouseQueryUri)) {
    $deploymentParams.eventhouseQueryUri = $EventhouseQueryUri
}
if (-not [string]::IsNullOrWhiteSpace($EventhouseDatabaseName)) {
    $deploymentParams.eventhouseDatabaseName = $EventhouseDatabaseName
}
if (-not [string]::IsNullOrWhiteSpace($DefaultAthleteId)) {
    $deploymentParams.defaultAthleteId = $DefaultAthleteId
    # Only explicit humans are authorized. Runtime setup adds the distinct Foundry project
    # identity after it exists; the account identity is not a substitute for that caller.
    $athletePrincipalMap = (Merge-RuntimePrincipalMap -Additions $AuthorizedAthletePrincipalMap) | ConvertFrom-Json -AsHashtable
    $consolePrincipalId = Get-WorkloadManagedIdentityPrincipalId -ResourceGroupName $ResourceGroupName -NamePrefix $NamePrefix -WorkloadName 'console'
    if ($consolePrincipalId) {
        $athletePrincipalMap[$consolePrincipalId] = $DefaultAthleteId
    }
    $cockpitPrincipalId = Get-WorkloadManagedIdentityPrincipalId -ResourceGroupName $ResourceGroupName -NamePrefix $NamePrefix -WorkloadName 'cockpit'
    if ($cockpitPrincipalId) {
        $athletePrincipalMap[$cockpitPrincipalId] = $DefaultAthleteId
    }
    $deploymentParams.athletePrincipalMapJson = ($athletePrincipalMap | ConvertTo-Json -Compress)
}
elseif ($AuthorizedAthletePrincipalMap.Count -gt 0) {
    $deploymentParams.athletePrincipalMapJson = Merge-RuntimePrincipalMap -Additions $AuthorizedAthletePrincipalMap
}
$paramsFile = New-ArmParametersFile -Values $deploymentParams

try {
    if ($WhatIfPreference) {
        Write-Host "Running what-if for deployment '$DeploymentName'..."
        Invoke-Az -Arguments @(
            'deployment', 'group', 'what-if',
            '--resource-group', $ResourceGroupName,
            '--name', $DeploymentName,
            '--template-file', $bicepMainFile,
            '--parameters', "@$paramsFile"
        ) | Write-Host
        Write-Host ''
        Write-Host 'What-if complete. No resources were changed. Exiting before Step 4 (Entra callback URL update).'
        return
    }

    if ($PSCmdlet.ShouldProcess($DeploymentName, 'Deploy infra/bicep/main.bicep to resource group')) {
        Write-Host "Starting deployment '$DeploymentName' (this can take several minutes, especially for the Foundry account/project)..."
        Invoke-Az -Arguments @(
            'deployment', 'group', 'create',
            '--resource-group', $ResourceGroupName,
            '--name', $DeploymentName,
            '--template-file', $bicepMainFile,
            '--parameters', "@$paramsFile",
            '--mode', 'Incremental',
            '-o', 'none'
        ) | Out-Null
    }
}
finally {
    # [System.IO.File]::Delete (not Remove-Item) so temp-file cleanup isn't skipped under
    # -WhatIf either -- this is cleanup of our own scratch file, not an Azure-affecting change.
    if (Test-Path $paramsFile) {
        [System.IO.File]::Delete($paramsFile)
    }
}

Write-Host "Deployment '$DeploymentName' succeeded. Fetching outputs..."
$outputs = Invoke-Az -Arguments @(
    'deployment', 'group', 'show',
    '--resource-group', $ResourceGroupName,
    '--name', $DeploymentName,
    '--query', 'properties.outputs',
    '-o', 'json'
) -AsJson

$fabricCapacityName = $outputs.fabricCapacityName.value
$containerRegistryLoginServer = $outputs.containerRegistryLoginServer.value
$keyVaultUri = $outputs.keyVaultUri.value
$streamingBackendFqdn = $outputs.streamingBackendFqdn.value
$consoleFqdn = $outputs.consoleFqdn.value
$cockpitFqdn = $outputs.cockpitFqdn.value
$foundryProjectName = $outputs.foundryProjectName.value

if ($LakehouseOneLakeFileSystem -or $LakehouseOneLakePath -or $EventstreamEventHubConnectionString -or $EventhouseQueryUri -or $EventhouseDatabaseName -or $DefaultAthleteId -or $AuthorizedAthletePrincipalMap.Count -gt 0) {
    $settings = @{
        SubscriptionId = $SubscriptionId; TenantId = $TenantId
        ResourceGroupName = $ResourceGroupName; NamePrefix = $NamePrefix
        LakehouseOneLakeFileSystem = $LakehouseOneLakeFileSystem
        LakehouseOneLakePath = $LakehouseOneLakePath
        EventstreamEventHubConnectionString = $EventstreamEventHubConnectionString
        EventhouseQueryUri = $EventhouseQueryUri; EventhouseDatabaseName = $EventhouseDatabaseName
        DefaultAthleteId = $DefaultAthleteId
        AuthorizedAthletePrincipalMap = $AuthorizedAthletePrincipalMap
    }
    & (Join-Path $PSScriptRoot 'configure-workload-settings.ps1') @settings | Out-Null
}

Write-Host ''
Write-Host '--- Step 4/4: Entra app registration (T019, second pass -- register Easy Auth callback URLs) ---'
$redirectUris = @()
if ($consoleFqdn) {
    $redirectUris += "https://$consoleFqdn/.auth/login/aad/callback"
}
if ($cockpitFqdn) {
    $redirectUris += "https://$cockpitFqdn/.auth/login/aad/callback"
}
if ($streamingBackendFqdn) {
    $redirectUris += "https://$streamingBackendFqdn/.auth/login/aad/callback"
}
if ($redirectUris.Count -gt 0) {
    if ($PSCmdlet.ShouldProcess(($redirectUris -join ', '), 'Register Easy Auth redirect URIs on the app registration')) {
        $entraResult = Invoke-EntraAppRegistration -NamePrefix $NamePrefix -FabricCapacityAdminUpn $FabricCapacityAdminUpn -TenantId $TenantId -RedirectUris $redirectUris
    }
}
else {
    Write-Host 'No Container App FQDNs returned by the deployment outputs -- skipping redirect URI registration.'
}

$result = [PSCustomObject]@{
    ResourceGroupName             = $ResourceGroupName
    FabricCapacityName            = $fabricCapacityName
    ContainerRegistryLoginServer  = $containerRegistryLoginServer
    KeyVaultUri                   = $keyVaultUri
    StreamingBackendFqdn          = $streamingBackendFqdn
    ConsoleFqdn                   = $consoleFqdn
    CockpitFqdn                   = $cockpitFqdn
    FoundryProjectName            = $foundryProjectName
    AuthClientId                  = $entraResult.AuthClientId
    AdminObjectId                 = $entraResult.AdminObjectId
    TenantId                      = $entraResult.TenantId
    PreservedWorkloads             = $preservedWorkloads
}

Write-Host ''
Write-Host 'Azure resource provisioning complete:'
$result | Format-List | Out-String | Write-Host

return $result
