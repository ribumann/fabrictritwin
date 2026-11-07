#Requires -Version 7.0
<#
.SYNOPSIS
Reconciles Foundry connections, project access, and existing Container App runtime settings.
.DESCRIPTION
Run after Azure/Fabric creation and credential overlays. The Fabric tool uses delegated
user identity; only the RemoteTool connection uses the Foundry PROJECT managed identity.
AssistantAuthResult and PowerBiEmbeddingResult are safe outputs from their respective
setup scripts, never credentials. WhatIf performs reads and reports proposed mutations.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$FabricWorkspaceId,
    [Parameter(Mandatory)][guid]$FabricDataAgentId,
    [Parameter(Mandatory)][guid]$AthleteId,
    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$NamePrefix = 'triatwin-dev',
    [string]$FoundryAccountName,
    [string]$FoundryProjectName,
    [string]$ModelDeploymentName,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{2,32}$')][string]$FabricConnectionName = 'athlete-fabric-data',
    [string]$FabricConnectionId,
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{2,32}$')][string]$McpConnectionName = 'athlete-mcp-tools',
    [object]$AssistantAuthResult,
    [object]$PowerBiEmbeddingResult,
    [hashtable]$AuthorizedAthletePrincipalMap = @{}
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runtime-arm.ps1')
if (-not $FoundryAccountName) { $FoundryAccountName = "$NamePrefix-foundry" }
if (-not $FoundryProjectName) { $FoundryProjectName = "$NamePrefix-athlete-assistant" }
$context = Get-RuntimeArmContext -SubscriptionId $SubscriptionId -TenantId $TenantId
$root = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers"
$projectId = "$root/Microsoft.CognitiveServices/accounts/$FoundryAccountName/projects/$FoundryProjectName"
$project = Invoke-RuntimeArm -Context $context -ResourceId $projectId -ApiVersion '2025-06-01'
$connectionPrefix = "$projectId/connections/"
if ($FabricConnectionId) {
    if (-not $FabricConnectionId.StartsWith($connectionPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $FabricConnectionId.Substring($connectionPrefix.Length) -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{2,32}$') {
        throw 'FabricConnectionId must identify a connection in the selected Foundry project.'
    }
    $FabricConnectionName = $FabricConnectionId.Substring($connectionPrefix.Length)
}
else { $FabricConnectionId = "$connectionPrefix$FabricConnectionName" }
$backend = Invoke-RuntimeArm -Context $context -ResourceId "$root/Microsoft.App/containerApps/$NamePrefix-streaming-backend"
$cockpit = Invoke-RuntimeArm -Context $context -ResourceId "$root/Microsoft.App/containerApps/$NamePrefix-cockpit"
$mcp = Invoke-RuntimeArm -Context $context -ResourceId "$root/Microsoft.App/containerApps/$NamePrefix-mcp-tools"
$auth = Invoke-RuntimeArm -Context $context -ResourceId "$($backend.id)/authConfigs/current"
$backendEnv = Get-RuntimeEnvironment (Get-RuntimeContainer $backend 'streaming-backend')
$backendClientId = [guid]::Parse($auth.properties.identityProviders.azureActiveDirectory.registration.clientId).ToString()
$projectPrincipalId = [guid]::Parse($project.identity.principalId).ToString()

# Resolve the project service principal in the selected tenant, never the account UAMI.
$graphHeaders = @{ Authorization = "Bearer $(Get-RuntimeAccessToken -SubscriptionId $SubscriptionId -TenantId $TenantId -Resource 'https://graph.microsoft.com/')" }
$projectSp = Invoke-RestMethod -Method Get -Uri "https://graph.microsoft.com/v1.0/servicePrincipals/${projectPrincipalId}?`$select=id,appId" -Headers $graphHeaders -Verbose:$false -Debug:$false
if ($projectSp.id -ne $projectPrincipalId -or -not $projectSp.appId) { throw 'Cannot resolve the Foundry project managed identity client ID.' }
$projectClientId = [guid]::Parse($projectSp.appId).ToString()

if ($AssistantAuthResult) {
    if ($AssistantAuthResult.SchemaVersion -ne 1 -or $AssistantAuthResult.SubscriptionId -ne $SubscriptionId.ToString() -or
        $AssistantAuthResult.TenantId -ne $TenantId.ToString() -or $AssistantAuthResult.ResourceGroupName -ne $ResourceGroupName -or
        $AssistantAuthResult.BackendAuthClientId -ne $backendClientId -or
        $AssistantAuthResult.CockpitAppName -ne $cockpit.name -or $AssistantAuthResult.StreamingBackendAppName -ne $backend.name) {
        throw 'Assistant auth output does not match the configured tenant, subscription, workload, or backend audience.'
    }
    if (-not $AssistantAuthResult.ConfigurationReady -and -not $WhatIfPreference) {
        throw 'Assistant credential setup is not ready. Run configure-assistant-auth.ps1 successfully first.'
    }
    $AuthorizedAthletePrincipalMap = (Merge-RuntimePrincipalMap -ExistingJson (ConvertTo-Json -InputObject $AuthorizedAthletePrincipalMap -Compress) -Additions $AssistantAuthResult.AuthorizedAthletePrincipalMap) | ConvertFrom-Json -AsHashtable
}
$mapJson = if ($backendEnv.ATHLETE_PRINCIPAL_MAP) { $backendEnv.ATHLETE_PRINCIPAL_MAP } else { '{}' }
$mapJson = Merge-RuntimePrincipalMap -ExistingJson $mapJson -Additions $AuthorizedAthletePrincipalMap
$serviceMap = @{ $projectPrincipalId = $AthleteId.ToString() }
$callerClientIds = @($projectClientId)
$backendPrincipalId = $null
foreach ($workload in @('console', 'cockpit', 'streaming-backend')) {
    $identityId = "$root/Microsoft.ManagedIdentity/userAssignedIdentities/$NamePrefix-id-$workload"
    $identity = Invoke-RuntimeArm -Context $context -ResourceId $identityId -ApiVersion '2023-01-31'
    $principalId = [guid]::Parse($identity.properties.principalId).ToString()
    if ($workload -eq 'streaming-backend') {
        $backendPrincipalId = $principalId
        # ARM echoes container app identity dictionary keys with its own casing (observed:
        # lowercase "resourcegroups" regardless of how the resource ID was originally cased),
        # so this membership check must be case-insensitive rather than an exact string match.
        if (-not ($backend.identity.userAssignedIdentities.Keys | Where-Object { $_ -ieq $identityId })) { throw 'Expected backend identity is not attached to the backend app.' }
    }
    else {
        $serviceMap[$principalId] = $AthleteId.ToString()
        $callerClientIds += [guid]::Parse($identity.properties.clientId).ToString()
    }
}
$mapJson = Merge-RuntimePrincipalMap -ExistingJson $mapJson -Additions $serviceMap
$cockpitClientId = if ($AssistantAuthResult) { [guid]::Parse($AssistantAuthResult.CockpitAuthClientId).ToString() } else { $backendEnv.ASSISTANT_AUTH_ALLOWED_CLIENT_ID }
if ($cockpitClientId) { $callerClientIds += [guid]::Parse($cockpitClientId).ToString() }
if ($cockpitClientId -and 'assistant-obo-client-secret' -notin @($backend.properties.configuration.secrets.name)) {
    throw 'Backend OBO secret is missing. Run configure-assistant-auth.ps1 before runtime wiring.'
}
if ($PowerBiEmbeddingResult -and $PowerBiEmbeddingResult.WorkspaceId -ne $FabricWorkspaceId.ToString()) {
    throw 'Power BI setup result belongs to a different Fabric workspace.'
}
if ($AssistantAuthResult) {
    foreach ($oid in $AssistantAuthResult.FoundryUserPrincipalIds) {
        if (-not $AuthorizedAthletePrincipalMap.ContainsKey([guid]::Parse($oid).ToString())) {
            throw 'Foundry user role input must match explicitly authorized athlete principals.'
        }
    }
}

if (-not $ModelDeploymentName) { $ModelDeploymentName = $backendEnv.ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME }
if (-not $ModelDeploymentName) { throw 'No model deployment is configured. Supply -ModelDeploymentName.' }
Invoke-RuntimeArm -Context $context -ResourceId "$root/Microsoft.CognitiveServices/accounts/$FoundryAccountName/deployments/$ModelDeploymentName" -ApiVersion '2024-10-01' | Out-Null

$changed = [System.Collections.Generic.List[string]]::new()
function Set-ProjectConnection {
    [CmdletBinding(SupportsShouldProcess)]
    param([string]$Name, [hashtable]$Properties)
    $resourceId = "$projectId/connections/$Name"
    $existing = Invoke-RuntimeArm -Context $context -ResourceId $resourceId -ApiVersion '2025-10-01-preview' -AllowNotFound
    $desired = if ($existing) { $existing.properties } else { @{} }
    if ($existing -and $desired.category -ne $Properties.category) { throw "Connection '$Name' is owned by a different category; refusing to replace it." }
    $differs = -not $existing
    foreach ($key in $Properties.Keys) {
        if ($key -eq 'metadata') {
            if (-not $desired.metadata) { $desired.metadata = @{} }
            foreach ($metadataKey in $Properties.metadata.Keys) {
                if ($desired.metadata[$metadataKey] -cne $Properties.metadata[$metadataKey]) {
                    $differs = $true
                    $desired.metadata[$metadataKey] = $Properties.metadata[$metadataKey]
                }
            }
        }
        elseif (-not (Test-RuntimeValueEqual $desired[$key] $Properties[$key])) {
            $differs = $true
            $desired[$key] = $Properties[$key]
        }
    }
    if ($differs -and $PSCmdlet.ShouldProcess($resourceId, 'Reconcile Foundry project connection')) {
        Invoke-RuntimeArm -Context $context -Method PUT -ResourceId $resourceId -ApiVersion '2025-10-01-preview' -Body @{ properties = $desired } | Out-Null
        $changed.Add("connection:$Name")
    }
    if (-not $WhatIfPreference) {
        $actual = Invoke-RuntimeArm -Context $context -ResourceId $resourceId -ApiVersion '2025-10-01-preview'
        if ($actual.id -ne $resourceId) { throw "Connection '$Name' returned an unexpected resource ID." }
        foreach ($key in @('category', 'authType', 'target', 'audience')) {
            if ($Properties.ContainsKey($key) -and $actual.properties[$key] -cne $Properties[$key]) {
                throw "Connection '$Name' did not retain the requested '$key'."
            }
        }
        return $actual.id
    }
    return $resourceId
}

# Native Fabric Data Agent connections use authType AAD with a `target` pointing at the
# Fabric AI-skill endpoint and workspace-id/artifact-id recorded in `metadata` -- confirmed
# live via ARM PUT. The Foundry portal UI's "Microsoft Fabric" connection type visually asks
# for workspace-id/artifact-id as if they were CustomKeys secrets, but the ARM API actually
# rejects authType CustomKeys for this category ("AuthType for MicrosoftFabric Connection can
# only be AAD, UserEntraToken") and requires a non-empty `target`; a missing `target` fails
# with "Target Property can't be empty". This was previously a documented preview gap
# requiring manual portal creation -- reconcile it like every other owned connection instead.
$fabricTarget = "https://api.fabric.microsoft.com/v1/workspaces/$FabricWorkspaceId/aiskills/$FabricDataAgentId"
$fabricId = Set-ProjectConnection -Name $FabricConnectionName -Properties @{
    category = 'MicrosoftFabric'; authType = 'AAD'; isSharedToAll = $false
    target = $fabricTarget
    metadata = @{ 'workspace-id' = $FabricWorkspaceId.ToString(); 'artifact-id' = $FabricDataAgentId.ToString() }
}

$mcpUrl = "https://$($backend.properties.configuration.ingress.fqdn)/api/assistant/mcp"
$mcpId = Set-ProjectConnection -Name $McpConnectionName -Properties @{
    category = 'RemoteTool'; authType = 'ProjectManagedIdentity'; isSharedToAll = $true
    target = $mcpUrl; audience = "api://$backendClientId"; metadata = @{ ApiType = 'Azure' }
}

$foundryRoleId = "/subscriptions/$SubscriptionId/providers/Microsoft.Authorization/roleDefinitions/53ca6127-db72-4b80-b1b0-d745d6d5456d"
$roles = @(Get-RuntimeArmCollection -Context $context -ResourceId "$projectId/providers/Microsoft.Authorization/roleAssignments" -ApiVersion '2022-04-01')
$rolePrincipals = @{ $backendPrincipalId = 'ServicePrincipal' }
foreach ($oid in $AuthorizedAthletePrincipalMap.Keys) { $rolePrincipals[[guid]::Parse($oid).ToString()] = 'User' }
if ($AssistantAuthResult) {
    foreach ($oid in $AssistantAuthResult.FoundryUserPrincipalIds) {
        $normalizedOid = [guid]::Parse($oid).ToString()
        if (-not $AuthorizedAthletePrincipalMap.ContainsKey($normalizedOid)) { throw 'Foundry user role input must match explicitly authorized athlete principals.' }
        $rolePrincipals[$normalizedOid] = 'User'
    }
}
foreach ($oid in @($rolePrincipals.Keys | Sort-Object)) {
    $existingRole = @($roles | Where-Object { $_.properties.principalId -eq $oid -and $_.properties.roleDefinitionId -eq $foundryRoleId })
    if ($existingRole.Count -gt 0) { continue }
    $hash = [System.Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("$projectId|$oid|$foundryRoleId".ToLowerInvariant()))
    $assignmentName = [guid]::new([byte[]]$hash[0..15]).ToString()
    if ($PSCmdlet.ShouldProcess("$oid at $projectId", 'Grant Foundry User role')) {
        Invoke-RuntimeArm -Context $context -Method PUT -ResourceId "$projectId/providers/Microsoft.Authorization/roleAssignments/$assignmentName" -ApiVersion '2022-04-01' -Body @{
            properties = @{ principalId = $oid; principalType = $rolePrincipals[$oid]; roleDefinitionId = $foundryRoleId }
        } | Out-Null
        $changed.Add("role:$oid")
    }
}

$validation = $auth.properties.identityProviders.azureActiveDirectory.validation
if (-not $validation.defaultAuthorizationPolicy) { $validation.defaultAuthorizationPolicy = @{} }
$existingCallers = @($validation.defaultAuthorizationPolicy.allowedApplications)
$callers = @(@($existingCallers) + $callerClientIds | Where-Object { $_ } | Sort-Object -Unique)
$authChanged = -not (Test-RuntimeValueEqual @($existingCallers | Sort-Object) $callers)
if ($authChanged) {
    $validation.defaultAuthorizationPolicy.allowedApplications = $callers
}

# Foundry's project-managed-identity MCP connection (Set-ProjectConnection above) calls back
# into this exact path. Live testing proved Container Apps Easy Auth rejects that specific
# caller with 403 even though its token's issuer/audience/azp all correctly match this app's
# Easy Auth config and allowedApplications entry above -- a platform limitation for this
# token shape, not a configuration gap (see apps/streaming-backend/src/auth/mcp-caller.ts's
# docstring for the full live-verified evidence). Excluding this one path from Easy Auth is
# therefore required; the backend performs equivalent self-verification (signature via
# tenant JWKS, issuer, audience, then the same ATHLETE_PRINCIPAL_MAP allowlist) for it
# instead -- see mcp-caller.ts. Easy Auth still unconditionally strips any client-supplied
# `x-ms-client-principal*` headers on excluded paths, so this does not open an impersonation
# hole.
$mcpPath = '/api/assistant/mcp'
if (-not $auth.properties.globalValidation) { $auth.properties.globalValidation = @{} }
$existingExcludedPaths = @($auth.properties.globalValidation.excludedPaths)
if ($existingExcludedPaths -notcontains $mcpPath) {
    $auth.properties.globalValidation.excludedPaths = @(@($existingExcludedPaths) + $mcpPath | Sort-Object -Unique)
    $authChanged = $true
}

if ($authChanged -and $PSCmdlet.ShouldProcess($backend.name, 'Union exact managed identity/cockpit allowlist entries and exclude the self-verified MCP bridge path from Easy Auth')) {
    Invoke-RuntimeArm -Context $context -Method PUT -ResourceId "$($backend.id)/authConfigs/current" -Body @{ properties = $auth.properties } | Out-Null
    $changed.Add('backend-allowlist')
}
$runtimeEnv = @{
    FOUNDRY_PROJECT_ENDPOINT = "https://$FoundryAccountName.services.ai.azure.com/api/projects/$FoundryProjectName"
    ATHLETE_ASSISTANT_AGENT_NAME = 'athlete-assistant'
    ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME = $ModelDeploymentName
    ATHLETE_ASSISTANT_FABRIC_PROJECT_CONNECTION_ID = $fabricId
    ATHLETE_ASSISTANT_MCP_PROJECT_CONNECTION_ID = $mcpId
    ATHLETE_ASSISTANT_MCP_PROXY_URL = $mcpUrl
    ATHLETE_ASSISTANT_MCP_INTERNAL_URL = "https://$($mcp.properties.configuration.ingress.fqdn)/mcp"
    ATHLETE_PRINCIPAL_MAP = $mapJson
}
$cockpitEnv = @{
    STREAMING_BACKEND_BASE_URL = "https://$($backend.properties.configuration.ingress.fqdn)"
    STREAMING_BACKEND_SCOPE = "api://$backendClientId/.default"
    DEFAULT_ATHLETE_ID = $AthleteId.ToString()
}
if ($cockpitClientId) {
    $runtimeEnv.ASSISTANT_AUTH_TENANT_ID = $TenantId.ToString()
    $runtimeEnv.ASSISTANT_AUTH_CLIENT_ID = $backendClientId
    $runtimeEnv.ASSISTANT_AUTH_ALLOWED_CLIENT_ID = $cockpitClientId
    # The credential overlay owns secret creation; do not synthesize an empty secret.
    $runtimeEnv.ASSISTANT_AUTH_CLIENT_SECRET = @{ secretRef = 'assistant-obo-client-secret' }
    $cockpitEnv.ASSISTANT_AUTH_BACKEND_CLIENT_ID = $backendClientId
    $cockpitEnv.ASSISTANT_AUTH_TENANT_ID = $TenantId.ToString()
}
# Power BI setup is authoritative for its fields; runtime reconciliation never replaces them.
if (Update-RuntimeAppSetting -Context $context -App $backend -ContainerName 'streaming-backend' -Environment $runtimeEnv) { $changed.Add('backend-env') }
if (Update-RuntimeAppSetting -Context $context -App $cockpit -ContainerName 'cockpit' -Environment $cockpitEnv) { $changed.Add('cockpit-env') }

return [pscustomobject]@{
    SchemaVersion = 1; SubscriptionId = $SubscriptionId.ToString(); TenantId = $TenantId.ToString()
    ResourceGroupName = $ResourceGroupName; FoundryProjectResourceId = $projectId
    FabricProjectConnectionId = $fabricId; McpProjectConnectionId = $mcpId
    FabricConnectionAuthType = 'AAD'
    ProjectManagedIdentityPrincipalId = $projectPrincipalId; ProjectManagedIdentityClientId = $projectClientId
    BackendAuthClientId = $backendClientId; CockpitAuthClientId = $cockpitClientId
    ChangedResources = $changed.ToArray(); WhatIf = [bool]$WhatIfPreference
    ConfigurationReady = (-not $WhatIfPreference -and [bool]$cockpitClientId)
    UserSignInRequired = $true
    PowerBiStatus = if ($PowerBiEmbeddingResult) { $PowerBiEmbeddingResult.Status } else { 'NotRequested' }
    PowerBiRuntimeValidated = ($null -ne $PowerBiEmbeddingResult -and [bool]$PowerBiEmbeddingResult.RuntimeValidated)
}
