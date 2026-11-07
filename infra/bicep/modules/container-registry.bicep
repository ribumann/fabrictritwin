// Azure Container Registry: the image source every Container App/Job in this project
// deploys from. Built/pushed via scripts/deploy/build-and-push-images.ps1 (T041).
metadata description = 'Azure Container Registry for the four apps/* Containerfile images'

@description('Azure region for the registry.')
param location string

@description('Resource name prefix (e.g. "triatwin-dev"). ACR names must be alphanumeric only.')
@minLength(3)
param namePrefix string

@description('Tags applied to all resources in this module.')
param tags object = {}

@description('ACR SKU. Basic is sufficient for a demo; Standard/Premium add geo-replication/private endpoints for Variant B.')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Basic'

@description('Principal IDs of managed identities that need "AcrPull" access to pull images.')
param acrPullPrincipalIds array

// ACR names must be globally unique, 5-50 chars, alphanumeric only (no hyphens).
var registryName = take(replace('${namePrefix}acr', '-', ''), 50)

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  // registryName is always >= 3 chars because namePrefix has @minLength(3) plus the
  // literal 'acr' suffix; the linter can't trace minLength through take()/replace().
  #disable-next-line BCP334
  name: registryName
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false // managed identity + AcrPull RBAC only, no admin credentials (Principle VI)
  }
}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource acrPullAssignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in acrPullPrincipalIds: {
    name: guid(registry.id, principalId, acrPullRoleId)
    scope: registry
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
      principalId: principalId
      principalType: 'ServicePrincipal'
    }
  }
]

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output registryId string = registry.id
