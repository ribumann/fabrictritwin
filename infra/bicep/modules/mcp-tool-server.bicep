// Container App shell for the MCP Tool Server backing the Athlete Assistant's custom
// tools. Internal-only ingress (no Easy Auth needed) — reached only by the Azure AI
// Foundry agent / Streaming Backend within the Container Apps environment, using
// managed-identity auth per ADR-004.
metadata description = 'MCP Tool Server Container App (internal ingress, managed identity)'

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

@description('Key Vault URI for runtime secret access.')
param keyVaultUri string

@description('Eventhouse/KQL query URI used by the read-only MCP tools.')
param eventhouseQueryUri string = ''

@description('Eventhouse/KQL database name used by the read-only MCP tools.')
param eventhouseDatabaseName string = ''

@description('This app own internal-ingress FQDN, passed back in so the MCP SDK Host-header DNS-rebinding check allows it (see index.ts: the SDK defaults to localhost-only validation, which rejects every real request to an internal Container App). Deterministic from the environment default domain, so no circular dependency on this resource own output.')
param internalFqdn string

// Bootstrap bypass: Container Apps validate the image manifest at creation time, so the
// first infra-only deployment (before any image has been pushed to ACR) would otherwise
// fail with MANIFEST_UNKNOWN (confirmed via live deployment test). While imageTag is left
// at its 'placeholder' default, use a public MCR image instead so the app resource
// provisions successfully; build-and-push-images.ps1 (T041) + CI then set a real imageTag,
// which switches this back to the ACR-hosted image automatically.
var isBootstrapPlaceholder = (imageTag == 'placeholder')
var containerImage = isBootstrapPlaceholder ? 'mcr.microsoft.com/k8se/quickstart:latest' : '${registryLoginServer}/mcp-tools:${imageTag}'
// The k8se/quickstart bootstrap image listens on port 80 (per Microsoft's Container Apps
// quickstart docs), not the real app's port -- target port must switch with the image or
// the revision sits Unhealthy (ingress connection-refused) during the bootstrap window.
var containerTargetPort = isBootstrapPlaceholder ? 80 : 3100

resource mcpToolServer 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-mcp-tools'
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
        external: false
        targetPort: containerTargetPort
        transport: 'auto'
      }
      registries: [
        {
          server: registryLoginServer
          identity: userAssignedIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'mcp-tools'
          image: containerImage
          env: [
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'AZURE_CLIENT_ID', value: userAssignedIdentityClientId }
            { name: 'EVENTHOUSE_QUERY_URI', value: eventhouseQueryUri }
            { name: 'EVENTHOUSE_DATABASE_NAME', value: eventhouseDatabaseName }
            { name: 'MCP_TOOLS_ALLOWED_HOST', value: internalFqdn }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

output appId string = mcpToolServer.id
output appName string = mcpToolServer.name
output fqdn string = mcpToolServer.properties.configuration.ingress.fqdn
