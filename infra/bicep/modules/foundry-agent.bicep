// Azure AI Foundry project + Athlete Assistant agent hosting resources (ADR-005).
// Uses the AIServices account + project + model-deployment pattern (current Foundry
// Agent Service resource model). NOTE: Agent Service region availability differs from
// the Fabric capacity's region (Poland Central) — kept as an independent `location`
// param so this can be deployed to a supported Foundry region even if that differs.
metadata description = 'Azure AI Foundry project + Athlete Assistant agent (ADR-005)'

@description('Azure region for the Foundry account/project. Sweden Central has GA Azure AI Foundry Agent Service support (validated independently of the Fabric capacity region).')
param location string = 'swedencentral'

@description('Resource name prefix (e.g. "triatwin-dev").')
param namePrefix string

@description('Tags applied to this resource.')
param tags object = {}

@description('Resource ID of the user-assigned managed identity used by the agent runtime (from managed-identities.bicep).')
param userAssignedIdentityId string

@description('Chat model deployment name, per ADR-005 sizing (small, tool-calling model).')
param modelDeploymentName string = 'gpt-5.4-mini'

@description('Logical Athlete Assistant agent name used by the runtime ensure/create helper.')
param assistantAgentName string = 'athlete-assistant'

@description('Underlying model name to deploy.')
param modelName string = 'gpt-5.4-mini'

@description('Model format/version. Verified against the live Foundry model catalog in Sweden Central via `az cognitiveservices account list-models` (GenerallyAvailable at time of check).')
param modelVersion string = '2026-03-17'

@description('Deployment SKU capacity (tokens-per-minute units), kept small for demo load per ADR-005.')
param modelCapacity int = 10

@description('Entra object IDs (users/groups) granted the built-in "Foundry User" role on this account, required for the Fabric Data Agent On-Behalf-Of tool-call identity passthrough (ADR-008 -- verified: this is a pure Azure RBAC grant, no Entra app registration/consent is involved). Populated by provision-azure-resources.ps1 (T035) resolving fabricCapacityAdminUpn to an object ID.')
param foundryUserPrincipalIds array = []

var accountName = take('${namePrefix}-foundry', 64)
var projectName = '${namePrefix}-athlete-assistant'
// Built-in "Foundry User" role (formerly "Azure AI User"); GUID is stable across the
// rename. Verified present in this subscription via `az role definition list --name
// "Foundry User"`.
var foundryUserRoleDefinitionId = '53ca6127-db72-4b80-b1b0-d745d6d5456d'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: accountName
  location: location
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled' // Variant A; Variant B would restrict to private networking (ADR-004/ADR-006)
    disableLocalAuth: true // managed identity / Entra auth only, no API keys (Principle VI)
    allowProjectManagement: true // required for the Foundry Agent Service project sub-resource below (confirmed via live deployment error)
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: account
  name: modelDeploymentName
  sku: {
    // GlobalStandard is the supported deployment SKU for gpt-5.4-mini (confirmed via live
    // `az cognitiveservices account list-models`); 'Standard' is not offered for this model.
    name: 'GlobalStandard'
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
}

resource project 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: account
  name: projectName
  location: location
  tags: tags
  dependsOn: [
    modelDeployment
  ]
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    displayName: 'Athlete Assistant'
    description: 'On-demand conversational agent answering readiness/recovery/race questions via the Fabric Data Agent + MCP tools (ADR-008).'
  }
}

resource foundryUserRoleAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in foundryUserPrincipalIds: {
    name: guid(account.id, principalId, foundryUserRoleDefinitionId)
    scope: account
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', foundryUserRoleDefinitionId)
      principalId: principalId
      principalType: 'User'
    }
  }
]

output accountId string = account.id
output accountName string = account.name
output projectId string = project.id
output projectName string = project.name
output modelDeploymentName string = modelDeployment.name
output assistantAgentName string = assistantAgentName
output projectEndpoint string = 'https://${account.name}.services.ai.azure.com/api/projects/${project.name}'
