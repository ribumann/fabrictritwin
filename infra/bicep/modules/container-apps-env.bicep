// Azure Container Apps environment + Log Analytics workspace shared by the Streaming
// Backend, MCP Tool Server, Cockpit, and Simulator Job (Container Apps Job).
metadata description = 'Container Apps environment + Log Analytics workspace'

@description('Azure region for the Container Apps environment.')
param location string

@description('Resource name prefix (e.g. "triatwin-dev").')
param namePrefix string

@description('Tags applied to all resources in this module.')
param tags object = {}

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-law'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource containerAppsEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-cae'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

output environmentId string = containerAppsEnv.id
output environmentName string = containerAppsEnv.name
output logAnalyticsWorkspaceId string = logAnalytics.id
output defaultDomain string = containerAppsEnv.properties.defaultDomain
