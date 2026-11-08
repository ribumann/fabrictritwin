// Container App shell for the Streaming Backend: live telemetry/alerts/chat bridge
// consumed by the cockpit web app. Public ingress + Entra ID "Easy Auth" per ADR-004
// (Variant A network posture) — not anonymous public access.
metadata description = 'Streaming Backend Container App (public ingress, Easy Auth)'

@description('Azure region.')
param location string

@description('Resource name prefix (e.g. "triatwin-dev").')
param namePrefix string

@description('Tags applied to this resource.')
param tags object = {}

@description('Resource ID of the Container Apps managed environment (from container-apps-env.bicep).')
param environmentId string

@description('Resource ID of the user-assigned managed identity for this app (from managed-identities.bicep).')
param userAssignedIdentityId string

@description('Client ID of the user-assigned managed identity for this app (from managed-identities.bicep).')
param userAssignedIdentityClientId string

@description('ACR login server hosting the app image (from container-registry.bicep).')
param registryLoginServer string

@description('Container image tag to deploy. Defaults to a placeholder until build-and-push-images.ps1 (T041) publishes the first real image.')
param imageTag string = 'placeholder'

@description('Synthetic uses process-local admission and must not scale horizontally. Live leaves DEMO_PROFILE unset.')
@allowed(['live', 'synthetic'])
param demoProfile string = 'live'

@description('Entra app registration client (application) ID used for Container Apps Easy Auth (from T019 provisioning script).')
param authClientId string

@description('Entra tenant ID for Easy Auth OpenID Connect issuer.')
param tenantId string = subscription().tenantId

@description('Client (application) ID of the Cockpit app\'s user-assigned managed identity, allow-listed so its app-only REST/WS proxy tokens pass Easy Auth authorization on the Streaming Backend. Empty string omits the allow-list entry (e.g. first bootstrap pass before the Cockpit MI exists).')
param cockpitManagedIdentityClientId string = ''

@description('Client (application) ID of the Foundry-agent managed identity, allow-listed so its app-only MCP bridge tokens pass Easy Auth authorization on the Streaming Backend. Empty string omits the allow-list entry until Foundry connection wiring is completed.')
param assistantManagedIdentityClientId string = ''

// Bootstrap bypass: Container Apps validate the image manifest at creation time, so the
// first infra-only deployment (before any image has been pushed to ACR) would otherwise
// fail with MANIFEST_UNKNOWN (confirmed via live deployment test). While imageTag is left
// at its 'placeholder' default, use a public MCR image instead so the app resource
// provisions successfully; build-and-push-images.ps1 (T041) + CI then set a real imageTag,
// which switches this back to the ACR-hosted image automatically.
var isBootstrapPlaceholder = (imageTag == 'placeholder')
var containerImage = isBootstrapPlaceholder ? 'mcr.microsoft.com/k8se/quickstart:latest' : '${registryLoginServer}/streaming-backend:${imageTag}'
// The k8se/quickstart bootstrap image listens on port 80 (per Microsoft's Container Apps
// quickstart docs), not the real app's port -- target port must switch with the image or
// the revision sits Unhealthy (ingress connection-refused) during the bootstrap window.
var containerTargetPort = isBootstrapPlaceholder ? 80 : 3000

@description('Key Vault URI for runtime secret access (Eventhouse/Activator connection info).')
param keyVaultUri string

@description('Logical simulator environment name forwarded to history-seeding requests.')
param simulatorEnvironment string = 'dev'

@description('OneLake DFS account URL for history-seeding writes.')
param lakehouseOneLakeAccountUrl string = ''

@description('Operator-supplied configuration; see the parameter name and deployment guide.')
param lakehouseOneLakeFileSystem string = ''

@description('Operator-supplied configuration; see the parameter name and deployment guide.')
param lakehouseOneLakePath string = ''

@description('SAS connection string for the Eventstream custom-endpoint source (from the Fabric "Get Eventstream Source Connection" API), used to publish SessionMetric events. This is the only supported auth mode for Eventstream CustomEndpoint sources -- their backing Event Hubs namespace is Fabric-managed and not a visible Azure resource, so there is no RBAC surface for a managed identity.')
@secure()
param eventstreamEventHubConnectionString string = ''

@description('Eventhouse/KQL query URI for app-facing analyses and alerts (for example https://<cluster>.<region>.kusto.windows.net). Required at runtime by the Streaming Backend\'s direct Kusto query path introduced for User Story 4; left blank until a post-provision/manual step resolves the Fabric tenant\'s query URI.')
param eventhouseQueryUri string = ''

@description('Eventhouse/KQL database name queried by the Streaming Backend for analyses and alerts (for example triatwin-dev-realtime). Left blank until Fabric item wiring is completed.')
param eventhouseDatabaseName string = ''

@description('JSON object mapping Easy-Auth-authenticated caller Entra object IDs to the athleteId they are authorized for (FR-017), consumed by src/auth/authorization.ts as ATHLETE_PRINCIPAL_MAP. Populated by provision-azure-resources.ps1 from AdminObjectId + -DefaultAthleteId. Defaults to an empty map, which fails closed -- authorization.ts treats every caller as unauthorized (403) rather than crashing -- until a real mapping is supplied.')
param athletePrincipalMapJson string = '{}'

@description('Azure AI Foundry project endpoint for the Athlete Assistant runtime helper. Blank keeps the assistant route in graceful-degradation mode (503) until Foundry wiring is finished.')
param foundryProjectEndpoint string = ''

@description('Logical Athlete Assistant agent name used by the runtime helper.')
param athleteAssistantAgentName string = 'athlete-assistant'

@description('Foundry model deployment name used by the Athlete Assistant runtime helper.')
param athleteAssistantModelDeploymentName string = ''

@description('Foundry project connection ID for the native Fabric Data Agent tool. Bicep cannot currently create this project connection declaratively here, so it is parameterized and may remain blank until a post-provision/manual connection step supplies the ID.')
param athleteAssistantFabricProjectConnectionId string = ''

@description('Foundry project connection ID used for the managed-identity-authenticated MCP bridge back to this Streaming Backend. Parameterized because Foundry project connections are not provisioned as stable ARM/Bicep resources in this flow.')
param athleteAssistantMcpProjectConnectionId string = ''

@description('Public Streaming Backend MCP bridge URL used by the Athlete Assistant for per-request tool calls.')
param athleteAssistantMcpProxyUrl string = ''

@description('Internal MCP Tool Server URL used by the Streaming Backend proxy route to reach the read-only MCP Container App inside the Container Apps environment.')
param athleteAssistantMcpInternalUrl string = ''

resource streamingBackend 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-streaming-backend'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: containerTargetPort
        transport: 'auto'
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registryLoginServer
          identity: userAssignedIdentityId
        }
      ]
      // Container Apps secret store: keeps the SAS connection string out of plain env-var
      // values / ARM deployment history. Omitted entirely while empty (bootstrap-before-Fabric-
      // provisioning) since Container Apps rejects a secret entry with an empty value.
      secrets: !empty(eventstreamEventHubConnectionString) ? [
        {
          name: 'eventstream-eventhub-connection-string'
          value: eventstreamEventHubConnectionString
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'streaming-backend'
          image: containerImage
          env: concat([
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'AZURE_CLIENT_ID', value: userAssignedIdentityClientId }
            { name: 'SIMULATOR_ENVIRONMENT', value: simulatorEnvironment }
            { name: 'LAKEHOUSE_ONELAKE_ACCOUNT_URL', value: lakehouseOneLakeAccountUrl }
            { name: 'LAKEHOUSE_ONELAKE_FILESYSTEM', value: lakehouseOneLakeFileSystem }
            { name: 'LAKEHOUSE_ONELAKE_PATH', value: lakehouseOneLakePath }
            { name: 'EVENTHOUSE_QUERY_URI', value: eventhouseQueryUri }
            { name: 'EVENTHOUSE_DATABASE_NAME', value: eventhouseDatabaseName }
            { name: 'ATHLETE_PRINCIPAL_MAP', value: athletePrincipalMapJson }
            { name: 'FOUNDRY_PROJECT_ENDPOINT', value: foundryProjectEndpoint }
            { name: 'ATHLETE_ASSISTANT_AGENT_NAME', value: athleteAssistantAgentName }
            { name: 'ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME', value: athleteAssistantModelDeploymentName }
            { name: 'ATHLETE_ASSISTANT_FABRIC_PROJECT_CONNECTION_ID', value: athleteAssistantFabricProjectConnectionId }
            { name: 'ATHLETE_ASSISTANT_MCP_PROJECT_CONNECTION_ID', value: athleteAssistantMcpProjectConnectionId }
            { name: 'ATHLETE_ASSISTANT_MCP_PROXY_URL', value: athleteAssistantMcpProxyUrl }
            { name: 'ATHLETE_ASSISTANT_MCP_INTERNAL_URL', value: athleteAssistantMcpInternalUrl }
          ], demoProfile == 'synthetic' ? [
            { name: 'DEMO_PROFILE', value: 'synthetic' }
          ] : [], !empty(eventstreamEventHubConnectionString) ? [
            { name: 'EVENTSTREAM_EVENTHUB_CONNECTION_STRING', secretRef: 'eventstream-eventhub-connection-string' }
          ] : [])
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: demoProfile == 'synthetic' ? 1 : 3
      }
    }
  }
}

// Container Apps built-in auth ("Easy Auth"): Entra ID as the only identity provider,
// unauthenticated requests are redirected to login (RequireAuthentication) per ADR-004.
resource easyAuth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: streamingBackend
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            'api://${authClientId}'
            authClientId
          ]
          defaultAuthorizationPolicy: {
            allowedApplications:             concat(
              cockpitManagedIdentityClientId == '' ? [] : [
                cockpitManagedIdentityClientId
              ],
              assistantManagedIdentityClientId == '' ? [] : [
                assistantManagedIdentityClientId
              ]
            )
          }
        }
      }
    }
  }
}

output appId string = streamingBackend.id
output appName string = streamingBackend.name
output fqdn string = streamingBackend.properties.configuration.ingress.fqdn
