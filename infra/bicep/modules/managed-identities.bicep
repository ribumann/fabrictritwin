// Managed identities for the Streaming Backend, MCP Tool Server, Cockpit, Simulator,
// Athlete Assistant (Foundry Agent), and provisioning scripts — one dedicated identity per
// workload. Constitution Principle VI (Single-Tenant Least-Privilege Footprint): each
// workload gets its own user-assigned identity so RBAC role assignments can be scoped
// per-service rather than sharing one broad identity across unrelated components.
metadata description = 'User-assigned managed identities for Triathlon Training Twin workloads'

@description('Azure region for the managed identities.')
param location string

@description('Resource name prefix (e.g. "triatwin-dev").')
param namePrefix string

@description('Tags applied to all resources in this module.')
param tags object = {}

resource streamingBackendIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-streaming-backend'
  location: location
  tags: tags
}

resource mcpToolServerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-mcp-tools'
  location: location
  tags: tags
}

resource cockpitIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-cockpit'
  location: location
  tags: tags
}

resource simulatorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-simulator'
  location: location
  tags: tags
}

resource provisioningIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-provisioning'
  location: location
  tags: tags
}

resource foundryAgentIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id-foundry-agent'
  location: location
  tags: tags
}

output streamingBackendIdentityId string = streamingBackendIdentity.id
output streamingBackendIdentityPrincipalId string = streamingBackendIdentity.properties.principalId
output streamingBackendIdentityClientId string = streamingBackendIdentity.properties.clientId

output mcpToolServerIdentityId string = mcpToolServerIdentity.id
output mcpToolServerIdentityPrincipalId string = mcpToolServerIdentity.properties.principalId
output mcpToolServerIdentityClientId string = mcpToolServerIdentity.properties.clientId

output cockpitIdentityId string = cockpitIdentity.id
output cockpitIdentityPrincipalId string = cockpitIdentity.properties.principalId
output cockpitIdentityClientId string = cockpitIdentity.properties.clientId

output simulatorIdentityId string = simulatorIdentity.id
output simulatorIdentityPrincipalId string = simulatorIdentity.properties.principalId
output simulatorIdentityClientId string = simulatorIdentity.properties.clientId

output provisioningIdentityId string = provisioningIdentity.id
output provisioningIdentityPrincipalId string = provisioningIdentity.properties.principalId
output provisioningIdentityClientId string = provisioningIdentity.properties.clientId

output foundryAgentIdentityId string = foundryAgentIdentity.id
output foundryAgentIdentityPrincipalId string = foundryAgentIdentity.properties.principalId
output foundryAgentIdentityClientId string = foundryAgentIdentity.properties.clientId
