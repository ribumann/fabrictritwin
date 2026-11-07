// Key Vault storing secrets consumed by the Streaming Backend, MCP Tool Server, and
// provisioning scripts (e.g. the Entra app registration client secret from T019, Fabric
// service-principal credentials if used). RBAC-based access (not access policies) so
// role assignments stay least-privilege and auditable (Constitution Principle VI).
metadata description = 'Key Vault + least-privilege RBAC role assignments'

@description('Azure region for the Key Vault.')
param location string

@description('Resource name prefix (e.g. "triatwin-dev").')
param namePrefix string

@description('Tags applied to all resources in this module.')
param tags object = {}

@description('Principal IDs of managed identities that need "Key Vault Secrets User" (read-only) access.')
param secretsUserPrincipalIds array

@description('Principal ID of the identity/user that needs "Key Vault Secrets Officer" (read/write) access for provisioning scripts.')
param vaultWriterPrincipalId string

@description('Optional object ID of an interactive human operator (e.g. the deploying admin user) who should also get "Key Vault Secrets Officer" access for manual troubleshooting/validation, such as running smoke-test.ps1 (T045) interactively rather than via a CI provisioning identity. Leave empty to skip.')
param operatorPrincipalId string = ''

// Key Vault names must be globally unique, 3-24 chars, alphanumeric + hyphens.
var keyVaultName = take('${replace(namePrefix, '_', '-')}-kv', 24)

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// Built-in role definition IDs (stable across all subscriptions).
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var keyVaultSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'


resource secretsUserAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in secretsUserPrincipalIds: {
    name: guid(keyVault.id, principalId, keyVaultSecretsUserRoleId)
    scope: keyVault
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

resource secretsOfficerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, vaultWriterPrincipalId, keyVaultSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: vaultWriterPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Optional: grants the interactive human operator (e.g. the deploying admin) the same
// "Key Vault Secrets Officer" access as the provisioning identity, so smoke-test.ps1
// (T045) and manual troubleshooting work without a separate az role assignment step.
resource operatorSecretsOfficerAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  name: guid(keyVault.id, operatorPrincipalId, keyVaultSecretsOfficerRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsOfficerRoleId)
    principalId: operatorPrincipalId
    principalType: 'User'
  }
}

output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output keyVaultId string = keyVault.id
