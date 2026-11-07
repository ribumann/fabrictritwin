targetScope = 'resourceGroup'

@description('Dedicated assistant token store. Never reuse an application data account.')
@minLength(3)
@maxLength(24)
param storageAccountName string

param location string = resourceGroup().location

@minLength(3)
@maxLength(63)
param containerName string = 'assistant-tokens'

@description('Ownership marker verified by configure-assistant-auth.ps1 before reuse.')
param owner string

@description('Object ID of the human operator granted Storage Blob Delegator so configure-assistant-auth.ps1 can sign user-delegation SAS tokens once tenant policy disables shared-key access. Omit to skip the role assignment.')
param operatorPrincipalId string = ''

@description('Operator-supplied configuration; see the parameter name and deployment guide.')
param publicNetworkPolicyAssignmentId string = ''

@description('Definition reference ID, within the policy assignment above, of the specific publicNetworkAccess Modify definition to exempt. Only used when publicNetworkPolicyAssignmentId is supplied.')
param publicNetworkPolicyDefinitionReferenceId string = 'storageaccountpublicnetworkmodify'

var storageBlobDelegatorRoleId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: {
    assistantAuthOwner: owner
  }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'None'
      defaultAction: 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {}
}

resource tokens 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

// Least-privilege: this role can only mint a user-delegation key (used to sign SAS
// tokens); it grants no read/write/delete access to blob data itself.
resource operatorDelegatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(operatorPrincipalId)) {
  name: guid(account.id, operatorPrincipalId, storageBlobDelegatorRoleId)
  scope: account
  properties: {
    principalId: operatorPrincipalId
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDelegatorRoleId)
    principalType: 'User'
  }
}

resource publicNetworkExemption 'Microsoft.Authorization/policyExemptions@2022-07-01-preview' = if (!empty(publicNetworkPolicyAssignmentId)) {
  name: 'triatwin-assistant-token-store-public-network-waiver'
  scope: account
  properties: {
    policyAssignmentId: publicNetworkPolicyAssignmentId
    policyDefinitionReferenceIds: [
      publicNetworkPolicyDefinitionReferenceId
    ]
    exemptionCategory: 'Waiver'
    displayName: 'Triathlon Twin assistant token-store: allow public network access'
    description: 'Demo OAuth token-store blob for a non-VNet ACA env (public-internet arch, ADR-006). No private-endpoint path without a larger VNet redesign (deferred variant). allowSharedKeyAccess stays false; access is via short-lived scoped User Delegation SAS only. Scoped to this one resource.'
  }
}

output storageAccountName string = account.name
output containerName string = tokens.name
output storageAccountId string = account.id
output blobEndpoint string = account.properties.primaryEndpoints.blob
