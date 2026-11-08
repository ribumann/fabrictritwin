// Resource-group scoped orchestration of the Triathlon Training Twin Azure infrastructure.
// Invoked (idempotently) by scripts/provision/provision-azure-resources.ps1 (T035), which
// runs the Entra app registration script (T019) first and passes its output as parameters
// here. See specs/001-triathlon-training-twin/plan.md Project Structure for module map.
metadata description = 'Triathlon Training Twin: main orchestration template'

targetScope = 'resourceGroup'

@description('Azure region for general Azure resources (Container Apps, Key Vault, ACR, managed identities). Poland Central by default. Independent from `fabricLocation` since 2026-09: Poland Central was found to NOT support "Fabric App (preview)" (see ADR-010 amendment), so the Fabric capacity moved to Italy North while these loosely-coupled Azure resources (reached only via HTTPS REST/OneLake DFS, never private networking) stayed put to avoid unnecessary redeploys.')
param location string = 'polandcentral'

@description('Azure region for the Fabric capacity/workspace. Italy North by default -- per the official Fabric region-availability table, Italy North supports all Fabric workloads including "Fabric App (preview)" with no listed exclusions, unlike Poland Central. See ADR-010 amendment (2026-09).')
param fabricLocation string = 'italynorth'

@description('Azure region for the Azure AI Foundry account/project. Independent from `location`/`fabricLocation` because Foundry Agent Service region availability differs (validate before changing).')
param foundryLocation string = 'swedencentral'

@description('Resource name prefix used to derive all resource names (e.g. "triatwin-dev").')
@minLength(3)
param namePrefix string = 'triatwin-dev'

@description('Tags applied to every resource in this deployment.')
param tags object = {
  project: 'triathlon-training-twin'
  managedBy: 'bicep'
}

@description('Fabric capacity SKU (ADR-001). Starts at F4, resizable to F8/F16.')
@allowed(['F2', 'F4', 'F8', 'F16', 'F32', 'F64'])
param fabricCapacitySkuName string = 'F4'

@description('UPN of the Fabric capacity administrator.')
param fabricCapacityAdminUpn string

@description('Entra app registration client ID for Streaming Backend Easy Auth (from T019 provisioning script).')
param authClientId string

@description('Entra object IDs (users/groups) granted the "Foundry User" RBAC role on the Foundry account -- the identity-passthrough prerequisite for the Fabric Data Agent OBO tool call (ADR-008). Populated by provision-azure-resources.ps1 (T035), which resolves fabricCapacityAdminUpn to an object ID; no Entra app registration/consent grant is involved.')
param foundryUserPrincipalIds array = []

@description('Optional object ID of an interactive human operator (e.g. the deploying admin user, same identity as foundryUserPrincipalIds) who should also get Key Vault "Secrets Officer" access for manual troubleshooting/validation such as running smoke-test.ps1 (T045) interactively. Populated by provision-azure-resources.ps1 from the same resolved AdminObjectId. Leave empty to skip.')
param operatorPrincipalId string = ''

@description('ACR SKU. Basic is sufficient for a demo.')
@allowed(['Basic', 'Standard', 'Premium'])
param acrSkuName string = 'Basic'

@description('Container image tag to deploy for the four remaining workloads. Defaults to a placeholder until build-and-push-images.ps1 (T041) publishes real images.')
param imageTag string = 'placeholder'

@description('Explicit application runtime profile. Live preserves existing cloud-backed behavior; synthetic requires matching runtime images and protected hosted proxy authentication.')
@allowed(['live', 'synthetic'])
param demoProfile string = 'live'

@description('Existing workload names retained by incremental deployment. Set by provision-azure-resources.ps1 after scoped reads. Runtime overlays and deploy-container-apps.ps1 own changes to existing workloads.')
param preservedWorkloads array = []

resource existingBackend 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: '${namePrefix}-streaming-backend'
}
resource existingMcp 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: '${namePrefix}-mcp-tools'
}
resource existingCockpit 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: '${namePrefix}-cockpit'
}

var backendFqdn = contains(preservedWorkloads, 'streaming-backend') ? existingBackend.properties.configuration.ingress.fqdn : streamingBackend!.outputs.fqdn
var mcpFqdn = contains(preservedWorkloads, 'mcp-tools') ? existingMcp.properties.configuration.ingress.fqdn : mcpToolServer!.outputs.fqdn
var cockpitFqdnValue = contains(preservedWorkloads, 'cockpit') ? existingCockpit.properties.configuration.ingress.fqdn : cockpit!.outputs.fqdn

@description('Cron expression (UTC) for the simulator daily generation run.')
param simulatorDailyScheduleCron string = '0 3 * * *'

@description('Enable the daily simulator schedule only after configuring the deployment.')
param enableSimulatorSchedule bool = false

@description('Logical simulator environment name forwarded to the seeding/orchestration CLI.')
param simulatorEnvironment string = 'dev'

@description('OneLake DFS account URL used by simulator/streaming-backend history seeding. Left blank until Fabric item endpoints are wired post-provisioning.')
param lakehouseOneLakeAccountUrl string = ''

@description('Operator-supplied configuration; see the parameter name and deployment guide.')
param lakehouseOneLakeFileSystem string = ''

@description('Operator-supplied configuration; see the parameter name and deployment guide.')
param lakehouseOneLakePath string = ''

@description('SAS connection string for the Eventstream custom-endpoint source (from the Fabric "Get Eventstream Source Connection" API), used to publish SessionMetric events. This is the only supported auth mode for Eventstream CustomEndpoint sources -- their backing Event Hubs namespace is Fabric-managed and not a visible Azure resource, so there is no RBAC surface for a managed identity. Left blank until the Eventstream connection info is retrieved post-provisioning.')
@secure()
param eventstreamEventHubConnectionString string = ''

@description('Eventhouse/KQL query URI used by the Streaming Backend\'s direct analyses/alerts query path (User Story 4), for example https://<cluster>.<region>.kusto.windows.net. Left blank until the Fabric tenant\'s query URI is resolved after item provisioning.')
param eventhouseQueryUri string = ''

@description('Eventhouse/KQL database name used by the Streaming Backend\'s direct analyses/alerts query path (User Story 4), for example triatwin-dev-realtime. Left blank until Fabric item wiring is completed.')
param eventhouseDatabaseName string = ''

@description('Default athleteId used by Cockpit trigger controls once a Data Agent/simulator run has produced a seeded athlete ID. Leave empty until then.')
param defaultAthleteId string = ''

@description('Workspace ID of the existing Fabric/Power BI workspace that holds the dashboard report embedded by the cockpit. Leave empty until provisioned/configured.')
param powerBiWorkspaceId string = ''

@description('Report ID of the existing Power BI report embedded by the cockpit. Leave empty until provisioned/configured.')
param powerBiReportId string = ''

@description('Exact model ID resolved from the cockpit report datasetId.')
param powerBiSemanticModelId string = ''

@description('Dedicated embedding service principal client ID.')
param powerBiClientId string = ''

@description('Tenant of the embedding identity and permitted cockpit users.')
param powerBiTenantId string = subscription().tenantId

@description('Dedicated embedding client secret, stored as an ACA native encrypted secret in the public-network demo; never an expiring embed token.')
@secure()
param powerBiClientSecret string = ''

@description('Entra object IDs approved to view the entire single-athlete demo report.')
param powerBiAllowedPrincipalIds array = []

@description('Embedding credential and connection lifecycle state; preserve all four on a cockpit redeployment.')
param powerBiCredentialKeyId string = ''
param powerBiConnectionId string = ''
param powerBiConnectionName string = ''
param powerBiConnectionCredentialKeyId string = ''

@description('JSON object mapping Easy-Auth-authenticated caller Entra object IDs to the athleteId they are authorized for (FR-017), forwarded to the Streaming Backend as ATHLETE_PRINCIPAL_MAP. Populated by provision-azure-resources.ps1 from AdminObjectId + -DefaultAthleteId. Defaults to an empty map (every request unauthorized, fail-closed) until the seeded athlete is known.')
param athletePrincipalMapJson string = '{}'

@description('Foundry project connection ID for the native Fabric Data Agent tool used by the Athlete Assistant. Left blank until the connection is created in the Foundry project.')
param athleteAssistantFabricProjectConnectionId string = ''

@description('Foundry project connection ID for the managed-identity-authenticated MCP bridge back to the Streaming Backend. Left blank until the connection is created in the Foundry project.')
param athleteAssistantMcpProjectConnectionId string = ''

// --- Foundational resources (no cross-module dependencies) ---

module managedIdentities 'modules/managed-identities.bicep' = {
  name: 'managed-identities'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
  }
}

module fabricCapacity 'modules/fabric-capacity.bicep' = {
  name: 'fabric-capacity'
  params: {
    location: fabricLocation
    namePrefix: namePrefix
    tags: tags
    skuName: fabricCapacitySkuName
    adminUpn: fabricCapacityAdminUpn
  }
}

module containerAppsEnv 'modules/container-apps-env.bicep' = {
  name: 'container-apps-env'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
  }
}

module containerRegistry 'modules/container-registry.bicep' = {
  name: 'container-registry'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    skuName: acrSkuName
    acrPullPrincipalIds: [
      managedIdentities.outputs.streamingBackendIdentityPrincipalId
      managedIdentities.outputs.mcpToolServerIdentityPrincipalId
      managedIdentities.outputs.cockpitIdentityPrincipalId
      managedIdentities.outputs.simulatorIdentityPrincipalId
    ]
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    secretsUserPrincipalIds: [
      managedIdentities.outputs.streamingBackendIdentityPrincipalId
      managedIdentities.outputs.mcpToolServerIdentityPrincipalId
      managedIdentities.outputs.simulatorIdentityPrincipalId
    ]
    vaultWriterPrincipalId: managedIdentities.outputs.provisioningIdentityPrincipalId
    operatorPrincipalId: operatorPrincipalId
  }
}

// --- Apps depending on the environment/registry/key vault above ---

module streamingBackend 'modules/streaming-backend.bicep' = if (!contains(preservedWorkloads, 'streaming-backend')) {
  name: 'streaming-backend'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    environmentId: containerAppsEnv.outputs.environmentId
    userAssignedIdentityId: managedIdentities.outputs.streamingBackendIdentityId
    userAssignedIdentityClientId: managedIdentities.outputs.streamingBackendIdentityClientId
    registryLoginServer: containerRegistry.outputs.registryLoginServer
    imageTag: imageTag
    demoProfile: demoProfile
    authClientId: authClientId
    keyVaultUri: keyVault.outputs.keyVaultUri
    simulatorEnvironment: simulatorEnvironment
    lakehouseOneLakeAccountUrl: lakehouseOneLakeAccountUrl
    lakehouseOneLakeFileSystem: lakehouseOneLakeFileSystem
    lakehouseOneLakePath: lakehouseOneLakePath
    eventstreamEventHubConnectionString: eventstreamEventHubConnectionString
    eventhouseQueryUri: eventhouseQueryUri
    eventhouseDatabaseName: eventhouseDatabaseName
    athletePrincipalMapJson: athletePrincipalMapJson
    cockpitManagedIdentityClientId: managedIdentities.outputs.cockpitIdentityClientId
    assistantManagedIdentityClientId: managedIdentities.outputs.foundryAgentIdentityClientId
    foundryProjectEndpoint: foundryAgent.outputs.projectEndpoint
    athleteAssistantAgentName: foundryAgent.outputs.assistantAgentName
    athleteAssistantModelDeploymentName: foundryAgent.outputs.modelDeploymentName
    athleteAssistantFabricProjectConnectionId: athleteAssistantFabricProjectConnectionId
    athleteAssistantMcpProjectConnectionId: athleteAssistantMcpProjectConnectionId
    athleteAssistantMcpProxyUrl: 'https://${namePrefix}-streaming-backend.${containerAppsEnv.outputs.defaultDomain}/api/assistant/mcp'
    athleteAssistantMcpInternalUrl: 'https://${mcpFqdn}/mcp'
  }
}

module mcpToolServer 'modules/mcp-tool-server.bicep' = if (!contains(preservedWorkloads, 'mcp-tools')) {
  name: 'mcp-tool-server'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    environmentId: containerAppsEnv.outputs.environmentId
    userAssignedIdentityId: managedIdentities.outputs.mcpToolServerIdentityId
    userAssignedIdentityClientId: managedIdentities.outputs.mcpToolServerIdentityClientId
    registryLoginServer: containerRegistry.outputs.registryLoginServer
    imageTag: imageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
    eventhouseQueryUri: eventhouseQueryUri
    eventhouseDatabaseName: eventhouseDatabaseName
    // Deterministic from the environment's default domain (matches the exact FQDN Container
    // Apps assigns to an internal-ingress app) -- computed here, not read back from this same
    // module's own output, to avoid a circular dependency.
    internalFqdn: '${namePrefix}-mcp-tools.internal.${containerAppsEnv.outputs.defaultDomain}'
  }
}

module cockpit 'modules/cockpit.bicep' = if (!contains(preservedWorkloads, 'cockpit')) {
  name: 'cockpit'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    environmentId: containerAppsEnv.outputs.environmentId
    userAssignedIdentityId: managedIdentities.outputs.cockpitIdentityId
    userAssignedIdentityClientId: managedIdentities.outputs.cockpitIdentityClientId
    registryLoginServer: containerRegistry.outputs.registryLoginServer
    imageTag: imageTag
    demoProfile: demoProfile
    authClientId: authClientId
    streamingBackendBaseUrl: 'https://${backendFqdn}'
    defaultAthleteId: defaultAthleteId
    powerBiWorkspaceId: powerBiWorkspaceId
    powerBiReportId: powerBiReportId
    powerBiSemanticModelId: powerBiSemanticModelId
    powerBiClientId: powerBiClientId
    powerBiTenantId: powerBiTenantId
    powerBiClientSecret: powerBiClientSecret
    powerBiAllowedPrincipalIds: powerBiAllowedPrincipalIds
    powerBiCredentialKeyId: powerBiCredentialKeyId
    powerBiConnectionId: powerBiConnectionId
    powerBiConnectionName: powerBiConnectionName
    powerBiConnectionCredentialKeyId: powerBiConnectionCredentialKeyId
  }
}

module simulatorJob 'modules/simulator-job.bicep' = if (!contains(preservedWorkloads, 'simulator')) {
  name: 'simulator-job'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
    environmentId: containerAppsEnv.outputs.environmentId
    userAssignedIdentityId: managedIdentities.outputs.simulatorIdentityId
    userAssignedIdentityClientId: managedIdentities.outputs.simulatorIdentityClientId
    registryLoginServer: containerRegistry.outputs.registryLoginServer
    imageTag: imageTag
    keyVaultUri: keyVault.outputs.keyVaultUri
    dailyScheduleCron: simulatorDailyScheduleCron
    enableSchedule: enableSimulatorSchedule
    simulatorEnvironment: simulatorEnvironment
    lakehouseOneLakeAccountUrl: lakehouseOneLakeAccountUrl
    lakehouseOneLakeFileSystem: lakehouseOneLakeFileSystem
    lakehouseOneLakePath: lakehouseOneLakePath
    eventstreamEventHubConnectionString: eventstreamEventHubConnectionString
  }
}

module foundryAgent 'modules/foundry-agent.bicep' = {
  name: 'foundry-agent'
  params: {
    location: foundryLocation
    namePrefix: namePrefix
    tags: tags
    userAssignedIdentityId: managedIdentities.outputs.foundryAgentIdentityId
    foundryUserPrincipalIds: foundryUserPrincipalIds
  }
}

// --- Outputs consumed by scripts/provision/provision-fabric-items.ps1 (T036) and
//     scripts/deploy/*.ps1 ---

output fabricCapacityName string = fabricCapacity.outputs.capacityName
output containerRegistryLoginServer string = containerRegistry.outputs.registryLoginServer
output keyVaultUri string = keyVault.outputs.keyVaultUri
output streamingBackendFqdn string = backendFqdn
output cockpitFqdn string = cockpitFqdnValue
output foundryProjectName string = foundryAgent.outputs.projectName
