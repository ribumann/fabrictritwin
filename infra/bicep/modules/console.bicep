// Container App shell for the Demo Control Console: a minimal UI to manually trigger
// seed-history/trigger-session/trigger-race activities. Public ingress + Entra ID
// Easy Auth per ADR-004 (Variant A network posture).
metadata description = 'Demo Control Console Container App (public ingress, Easy Auth)'

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

@description('Entra app registration client (application) ID used for Container Apps Easy Auth (from T019 provisioning script).')
param authClientId string

@description('Entra tenant ID for Easy Auth OpenID Connect issuer.')
param tenantId string = subscription().tenantId

@description('Fully-qualified base URL of the Streaming Backend Container App (from streaming-backend.bicep\'s `fqdn` output), used by the "Seed History" trigger action (T062) for its service-to-service call.')
param streamingBackendBaseUrl string = ''

@description('Default athleteId used by the Console\'s trigger buttons when only one athlete has been seeded (FR-001). Leave empty until a Data Agent/simulator run has produced a seeded athlete ID.')
param defaultAthleteId string = ''

// Bootstrap bypass: Container Apps validate the image manifest at creation time, so the
// first infra-only deployment (before any image has been pushed to ACR) would otherwise
// fail with MANIFEST_UNKNOWN (confirmed via live deployment test). While imageTag is left
// at its 'placeholder' default, use a public MCR image instead so the app resource
// provisions successfully; build-and-push-images.ps1 (T041) + CI then set a real imageTag,
// which switches this back to the ACR-hosted image automatically.
var isBootstrapPlaceholder = (imageTag == 'placeholder')
var containerImage = isBootstrapPlaceholder ? 'mcr.microsoft.com/k8se/quickstart:latest' : '${registryLoginServer}/console:${imageTag}'
// The k8se/quickstart bootstrap image listens on port 80 (per Microsoft's Container Apps
// quickstart docs), not the real app's port -- target port must switch with the image or
// the revision sits Unhealthy (ingress connection-refused) during the bootstrap window.
var containerTargetPort = isBootstrapPlaceholder ? 80 : 3200

resource console 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-console'
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
    }
    template: {
      containers: [
        {
          name: 'console'
          image: containerImage
          env: [
            { name: 'AZURE_CLIENT_ID', value: userAssignedIdentityClientId }
            { name: 'STREAMING_BACKEND_BASE_URL', value: streamingBackendBaseUrl }
            { name: 'STREAMING_BACKEND_SCOPE', value: 'api://${authClientId}/.default' }
            { name: 'DEFAULT_ATHLETE_ID', value: defaultAthleteId }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
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
  parent: console
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      // AllowAnonymous: every console action (trigger-session/trigger-race/etc.) already
      // authenticates to the backend via Console's own managed identity, independent of the
      // visitor's identity -- requiring a login here only gated the page load, not any
      // actual capability. See cockpit.bicep for the matching change and rationale.
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

output appId string = console.id
output appName string = console.name
output fqdn string = console.properties.configuration.ingress.fqdn
