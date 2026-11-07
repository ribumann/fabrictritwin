// Container Apps Job for the Simulator: daily-generation for User Story 2 (cron
// schedule) plus on-demand manual triggers for User Stories 1/3 (seed-history,
// trigger-session, trigger-race — see scripts/simulate/*.ps1). Container Apps Jobs
// with triggerType 'Schedule' still support on-demand starts via
// `az containerapp job start`, so one job resource covers both trigger modes.
metadata description = 'Simulator Container Apps Job (scheduled + on-demand triggers)'

@description('Azure region.')
param location string

@description('Resource name prefix (e.g. "triatwin-dev").')
param namePrefix string

@description('Tags applied to this resource.')
param tags object = {}

@description('Resource ID of the Container Apps managed environment (from container-apps-env.bicep).')
param environmentId string

@description('Resource ID of the user-assigned managed identity for this job (from managed-identities.bicep).')
param userAssignedIdentityId string

@description('Client ID of the user-assigned managed identity for this job (from managed-identities.bicep).')
param userAssignedIdentityClientId string

@description('ACR login server hosting the job image (from container-registry.bicep).')
param registryLoginServer string

@description('Container image tag to deploy. Defaults to a placeholder until build-and-push-images.ps1 (T041) publishes the first real image.')
param imageTag string = 'placeholder'

@description('Key Vault URI for runtime secret access (Eventstream connection info).')
param keyVaultUri string

@description('Cron expression (UTC) for the daily generation run. Default: 03:00 UTC daily.')
param dailyScheduleCron string = '0 3 * * *'

@description('Explicit opt-in to scheduled cloud execution. Manual triggers remain available.')
param enableSchedule bool = false

@description('Logical simulator environment name forwarded to the orchestration entry points.')
param simulatorEnvironment string = 'dev'

@description('OneLake DFS account URL for history seeding writes.')
param lakehouseOneLakeAccountUrl string = ''

@description('Operator-supplied configuration; see the parameter name and deployment guide.')
param lakehouseOneLakeFileSystem string = ''

@description('Operator-supplied configuration; see the parameter name and deployment guide.')
param lakehouseOneLakePath string = ''

@description('SAS connection string for the Eventstream custom-endpoint source (from the Fabric "Get Eventstream Source Connection" API), used to publish SessionMetric events. This is the only supported auth mode for Eventstream CustomEndpoint sources -- their backing Event Hubs namespace is Fabric-managed and not a visible Azure resource, so there is no RBAC surface for a managed identity.')
@secure()
param eventstreamEventHubConnectionString string = ''

// Bootstrap bypass: while Container Apps Jobs with a Schedule trigger don't validate the
// image at creation time (only when a run is actually triggered), this mirrors the same
// placeholder pattern as the other 3 app modules for consistency and to avoid a manifest
// failure the first time this job is scheduled/manually triggered before a real image
// exists. While imageTag is left at its 'placeholder' default, run a trivial, fast-exiting
// public image instead of the (not-yet-published) ACR image; build-and-push-images.ps1
// (T041) + CI then set a real imageTag, switching this back to the ACR-hosted image.
var isBootstrapPlaceholder = (imageTag == 'placeholder')
var containerImage = isBootstrapPlaceholder ? 'mcr.microsoft.com/azure-cli:latest' : '${registryLoginServer}/simulator:${imageTag}'
var bootstrapCommand = ['/bin/sh', '-c']
var bootstrapArgs = ['echo "Bootstrap placeholder - simulator image not yet published"; exit 0']

resource simulatorJob 'Microsoft.App/jobs@2024-03-01' = {
  name: '${namePrefix}-simulator'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${userAssignedIdentityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: enableSchedule ? 'Schedule' : 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      scheduleTriggerConfig: enableSchedule ? {
        cronExpression: dailyScheduleCron
        parallelism: 1
        replicaCompletionCount: 1
      } : null
      manualTriggerConfig: enableSchedule ? null : {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registryLoginServer
          identity: userAssignedIdentityId
        }
      ]
      // Container Apps Jobs secret store: keeps the SAS connection string out of plain env-var
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
          name: 'simulator'
          image: containerImage
          command: isBootstrapPlaceholder ? bootstrapCommand : null
          args: isBootstrapPlaceholder ? bootstrapArgs : null
          env: concat([
            { name: 'KEY_VAULT_URI', value: keyVaultUri }
            { name: 'AZURE_CLIENT_ID', value: userAssignedIdentityClientId }
            { name: 'SIMULATOR_ENVIRONMENT', value: simulatorEnvironment }
            { name: 'LAKEHOUSE_ONELAKE_ACCOUNT_URL', value: lakehouseOneLakeAccountUrl }
            { name: 'LAKEHOUSE_ONELAKE_FILESYSTEM', value: lakehouseOneLakeFileSystem }
            { name: 'LAKEHOUSE_ONELAKE_PATH', value: lakehouseOneLakePath }
            // Default CLI entry point for the scheduled run; on-demand invocations
            // (seed-history/trigger-session/trigger-race) override this via
            // `az containerapp job start --command` from scripts/simulate/*.ps1.
            { name: 'SIMULATOR_MODE', value: 'daily-generation' }
          ], !empty(eventstreamEventHubConnectionString) ? [
            { name: 'EVENTSTREAM_EVENTHUB_CONNECTION_STRING', secretRef: 'eventstream-eventhub-connection-string' }
          ] : [])
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
    }
  }
}

output jobId string = simulatorJob.id
output jobName string = simulatorJob.name
