function New-RuntimeFixture {
    $global:RuntimeFixture = @{
        SubscriptionId = '00000000-0000-0000-0000-000000000123'
        TenantId = '11111111-1111-1111-1111-111111111111'
        WorkspaceId = '22222222-2222-2222-2222-222222222222'
        AgentId = '33333333-3333-3333-3333-333333333333'
        AthleteId = '44444444-4444-4444-4444-444444444444'
        BackendClientId = '55555555-5555-5555-5555-555555555555'
        CockpitClientId = '66666666-6666-6666-6666-666666666666'
        ProjectOid = '77777777-7777-7777-7777-777777777777'
        ProjectClientId = '88888888-8888-8888-8888-888888888888'
        BackendOid = '99999999-9999-9999-9999-999999999999'
        ConsoleOid = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
        UserOid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        Resources = @{}
        Requests = [System.Collections.Generic.List[object]]::new()
    }
    $f = $global:RuntimeFixture
    $f.Root = "/subscriptions/$($f.SubscriptionId)/resourceGroups/rg-triathlon-twin-demo/providers"
    $f.ProjectId = "$($f.Root)/Microsoft.CognitiveServices/accounts/triatwin-dev-foundry/projects/triatwin-dev-athlete-assistant"
    $f.Resources[$f.ProjectId] = @{ id = $f.ProjectId; identity = @{ principalId = $f.ProjectOid } }
    $f.FabricId = "$($f.ProjectId)/connections/athlete-fabric-data"
    $f.Resources[$f.FabricId] = @{
        id = $f.FabricId
        properties = @{
            category = 'MicrosoftFabric'; authType = 'AAD'; isSharedToAll = $false
            target = "https://api.fabric.microsoft.com/v1/workspaces/$($f.WorkspaceId)/aiskills/$($f.AgentId)"
            metadata = @{ 'workspace-id' = $f.WorkspaceId; 'artifact-id' = $f.AgentId }
        }
    }
    $f.Resources["$($f.ProjectId)/providers/Microsoft.Authorization/roleAssignments"] = @{ value = @() }
    $modelId = "$($f.Root)/Microsoft.CognitiveServices/accounts/triatwin-dev-foundry/deployments/test-model"
    $f.Resources[$modelId] = @{ id = $modelId }
    foreach ($workload in @('console', 'cockpit', 'streaming-backend', 'mcp-tools', 'simulator')) {
        $kind = if ($workload -eq 'simulator') { 'jobs' } else { 'containerApps' }
        $id = "$($f.Root)/Microsoft.App/$kind/triatwin-dev-$workload"
        $identityId = "$($f.Root)/Microsoft.ManagedIdentity/userAssignedIdentities/triatwin-dev-id-$workload"
        $oid = switch ($workload) {
            'streaming-backend' { $f.BackendOid }
            'console' { $f.ConsoleOid }
            default { 'cccccccc-cccc-cccc-cccc-cccccccccccc' }
        }
        $f.Resources[$identityId] = @{ id = $identityId; properties = @{ principalId = $oid; clientId = $oid } }
        $f.Resources[$id] = @{
            id = $id; name = "triatwin-dev-$workload"
            identity = @{ userAssignedIdentities = @{ $identityId = @{} } }
            properties = @{
                provisioningState = 'Succeeded'; latestRevisionName = "triatwin-dev-$workload--original"
                configuration = @{
                    ingress = @{ fqdn = "$workload.example.test"; external = $true; targetPort = 3300 }
                    secrets = @(@{ name = 'keep-secret'; value = 'DO-NOT-LEAK-NATIVE-SECRET' })
                    registries = @(@{ server = 'registry.example.test'; identity = $identityId })
                }
                template = @{
                    scale = @{ minReplicas = 1; maxReplicas = 3 }
                    containers = @(@{
                        name = $workload; image = "registry.example.test/$workload`:distinct-tag"
                        resources = @{ cpu = 0.5; memory = '1Gi' }
                        env = @(
                            @{ name = 'KEEP_SETTING'; value = "keep-$workload" }
                            @{ name = 'KEEP_SECRET'; secretRef = 'keep-secret' }
                            @{ name = 'ATHLETE_ASSISTANT_MODEL_DEPLOYMENT_NAME'; value = 'test-model' }
                        )
                    })
                }
            }
        }
    }
    $f.BackendId = "$($f.Root)/Microsoft.App/containerApps/triatwin-dev-streaming-backend"
    $f.CockpitId = "$($f.Root)/Microsoft.App/containerApps/triatwin-dev-cockpit"
    $f.Resources[$f.BackendId].properties.configuration.secrets += @{ name = 'assistant-obo-client-secret'; value = 'DO-NOT-LEAK-OBO' }
    $f.Resources["$($f.BackendId)/authConfigs/current"] = @{
        id = "$($f.BackendId)/authConfigs/current"
        properties = @{
            platform = @{ enabled = $true }
            login = @{ preserve = 'yes' }
            identityProviders = @{ azureActiveDirectory = @{
                registration = @{ clientId = $f.BackendClientId }
                validation = @{
                    allowedAudiences = @("api://$($f.BackendClientId)", $f.BackendClientId)
                    defaultAuthorizationPolicy = @{ allowedApplications = @('dddddddd-dddd-dddd-dddd-dddddddddddd') }
                }
            } }
        }
    }
    $f.AuthResult = [pscustomobject]@{
        SchemaVersion = 1; SubscriptionId = $f.SubscriptionId; TenantId = $f.TenantId
        ResourceGroupName = 'rg-triathlon-twin-demo'; BackendAuthClientId = $f.BackendClientId
        CockpitAuthClientId = $f.CockpitClientId; CockpitAppName = 'triatwin-dev-cockpit'
        StreamingBackendAppName = 'triatwin-dev-streaming-backend'
        AuthorizedAthletePrincipalMap = @{ $f.UserOid = $f.AthleteId }
        FoundryUserPrincipalIds = @($f.UserOid); ConfigurationReady = $true
    }
}

function Invoke-RuntimeFixtureRequest {
    param($Uri, $Method, $Body)
    $f = $global:RuntimeFixture
    $id = ([uri]$Uri).AbsolutePath
    $f.Requests.Add(@{ Uri = $Uri; Method = "$Method"; Body = $Body })
    $status = 200
    $value = $null
    if ($Method -eq 'GET') {
        if ($f.Resources.ContainsKey($id)) {
            $value = $f.Resources[$id] | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable
            if ($value.properties -and $value.properties.configuration) {
                foreach ($secret in $value.properties.configuration.secrets) { $secret.Remove('value') }
            }
            if ($value.properties) { $value.properties.Remove('credentials') }
        }
        elseif ($id -match '/revisions$' -and $f.Resources.ContainsKey(($id -replace '/revisions$', ''))) {
            $app = $f.Resources[($id -replace '/revisions$', '')]
            $name = $app.properties.latestRevisionName
            $value = @{ value = @(@{
                id = "$id/$name"; name = $name
                properties = @{ active = $true; template = $app.properties.template }
            }) }
        }
        else { $status = 404; $value = @{ error = @{ code = 'ResourceNotFound' } } }
    }
    elseif ($Method -eq 'POST' -and $id -match '/listsecrets$') {
        $parent = $id -replace '/listsecrets$', ''
        if ($parent -match '/connections/') { $value = $f.Resources[$parent] }
        else { $value = @{ value = $f.Resources[$parent].properties.configuration.secrets } }
    }
    elseif ($Method -eq 'PATCH') {
        $patch = $Body | ConvertFrom-Json -AsHashtable
        foreach ($key in $patch.properties.Keys) {
            if ($key -eq 'template') {
                foreach ($field in $patch.properties.template.Keys) { $f.Resources[$id].properties.template[$field] = $patch.properties.template[$field] }
            }
            else { $f.Resources[$id].properties[$key] = $patch.properties[$key] }
        }
        $value = $f.Resources[$id]
    }
    elseif ($Method -eq 'PUT') {
        $value = $Body | ConvertFrom-Json -AsHashtable
        $value.id = $id
        $f.Resources[$id] = $value
        if ($id -match '/providers/Microsoft.Authorization/roleAssignments/[^/]+$') {
            $f.Resources["$($f.ProjectId)/providers/Microsoft.Authorization/roleAssignments"].value += $value
        }
    }
    elseif ($Method -eq 'POST' -and $id -match '/revisions/.+/restart$') { $value = @{} }
    else { throw "Unexpected mock request: $Method $id" }
    return @{ StatusCode = $status; Content = (ConvertTo-Json -InputObject $value -Depth 100 -Compress) }
}
