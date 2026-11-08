// Container App shell for the Unified Operations Cockpit: analyses/alerts, embedded Power BI
// report, live telemetry/race views, and later the Foundry-agent / direct-MCP panels. Public
// ingress + Entra ID Easy Auth per ADR-004 / ADR-010 Amendment 2.
metadata description = 'Cockpit Container App (public ingress, Easy Auth)'

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

@description('Container image tag to deploy. Defaults to a placeholder until build-and-push-images.ps1 publishes the first real image.')
param imageTag string = 'placeholder'

@description('Must match the Streaming Backend profile. Live leaves DEMO_PROFILE unset; synthetic does not disable hosting authentication.')
@allowed(['live', 'synthetic'])
param demoProfile string = 'live'

@description('Entra app registration client (application) ID used for Container Apps Easy Auth.')
param authClientId string

@description('Entra tenant ID for Easy Auth OpenID Connect issuer.')
param tenantId string = subscription().tenantId

@description('Fully-qualified base URL of the Streaming Backend Container App.')
param streamingBackendBaseUrl string = ''

@description('Default athleteId used by the cockpit when only one athlete has been seeded.')
param defaultAthleteId string = ''

@description('Workspace ID of the Power BI/Fabric workspace holding the demo report. Leave empty until provisioned/configured.')
param powerBiWorkspaceId string = ''

@description('Report ID of the Power BI report to embed. Leave empty until provisioned/configured.')
param powerBiReportId string = ''

@description('Exact semantic model ID resolved from the report datasetId. Rebinding requires explicit reconfiguration.')
param powerBiSemanticModelId string = ''

@description('Dedicated service principal client ID for automatic V2 embed token issuance.')
param powerBiClientId string = ''

@description('Tenant of the embedding identity and permitted EasyAuth callers.')
param powerBiTenantId string = tenantId

@description('Embedding client secret stored as an ACA encrypted secret for this public-network demo. The tenant blocks Key Vault data-plane access.')
@secure()
param powerBiClientSecret string = ''

@description('Entra object IDs explicitly authorized to view this entire single-athlete demo report. Empty denies everyone.')
param powerBiAllowedPrincipalIds array = []

@description('Graph password key ID retained by embedding provisioning for credential reuse.')
param powerBiCredentialKeyId string = ''

@description('Owned Fabric fixed connection ID retained across redeployments.')
param powerBiConnectionId string = ''

@description('Durable scoped connection creation intent retained across redeployments and interrupted creation.')
param powerBiConnectionName string = ''

@description('Last Graph credential key ID successfully applied to the Fabric connection.')
param powerBiConnectionCredentialKeyId string = ''

var isBootstrapPlaceholder = (imageTag == 'placeholder')
var containerImage = isBootstrapPlaceholder ? 'mcr.microsoft.com/k8se/quickstart:latest' : '${registryLoginServer}/cockpit:${imageTag}'
var containerTargetPort = isBootstrapPlaceholder ? 80 : 3300

resource cockpit 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-cockpit'
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
      ingress: {
        external: true
        targetPort: containerTargetPort
        transport: 'auto'
      }
      registries: [
        {
          server: registryLoginServer
          identity: userAssignedIdentityId
        }
      ]
      secrets: !empty(powerBiClientSecret) ? [
        {
          name: 'powerbi-client-secret'
          value: powerBiClientSecret
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'cockpit'
          image: containerImage
          env: concat([
            { name: 'AZURE_CLIENT_ID', value: userAssignedIdentityClientId }
            { name: 'STREAMING_BACKEND_BASE_URL', value: streamingBackendBaseUrl }
            { name: 'STREAMING_BACKEND_SCOPE', value: 'api://${authClientId}/.default' }
            { name: 'DEFAULT_ATHLETE_ID', value: defaultAthleteId }
            { name: 'POWERBI_WORKSPACE_ID', value: powerBiWorkspaceId }
            { name: 'POWERBI_REPORT_ID', value: powerBiReportId }
            { name: 'POWERBI_SEMANTIC_MODEL_ID', value: powerBiSemanticModelId }
            { name: 'POWERBI_CLIENT_ID', value: powerBiClientId }
            { name: 'POWERBI_TENANT_ID', value: powerBiTenantId }
            { name: 'POWERBI_ALLOWED_PRINCIPAL_IDS', value: join(powerBiAllowedPrincipalIds, ',') }
            { name: 'POWERBI_CREDENTIAL_KEY_ID', value: powerBiCredentialKeyId }
            { name: 'POWERBI_CONNECTION_ID', value: powerBiConnectionId }
            { name: 'POWERBI_CONNECTION_NAME', value: powerBiConnectionName }
            { name: 'POWERBI_CONNECTION_CREDENTIAL_KEY_ID', value: powerBiConnectionCredentialKeyId }
          ], demoProfile == 'synthetic' ? [
            { name: 'DEMO_PROFILE', value: 'synthetic' }
          ] : [], !empty(powerBiClientSecret) ? [
            { name: 'POWERBI_CLIENT_SECRET', secretRef: 'powerbi-client-secret' }
          ] : [])
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
}

resource easyAuth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: cockpit
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      // AllowAnonymous: Cockpit's own MI already authorizes almost all functionality
      // (Power BI embed access control has its own explicit allowlist check; MCP/console
      // actions call the backend via MI). Only the Athlete Assistant's native Fabric Data
      // Agent grounding needs a signed-in human (platform restriction -- see ADR-008); the
      // Assistant gracefully degrades to MCP-tool-only MI-mode for anonymous visitors.
      unauthenticatedClientAction: 'AllowAnonymous'
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
        }
      }
    }
  }
}

output appId string = cockpit.id
output appName string = cockpit.name
output fqdn string = cockpit.properties.configuration.ingress.fqdn
