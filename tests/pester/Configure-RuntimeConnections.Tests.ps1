BeforeAll {
    . (Join-Path $PSScriptRoot 'Runtime-Fixtures.ps1')
    . (Join-Path $PSScriptRoot '..\..\scripts\provision\runtime-arm.ps1')
    $script:RuntimeScript = Join-Path $PSScriptRoot '..\..\scripts\provision\configure-runtime-connections.ps1'
    $script:SettingsScript = Join-Path $PSScriptRoot '..\..\scripts\provision\configure-workload-settings.ps1'
}

Describe 'Runtime principal map serialization' {
    It 'emits canonical JSON regardless of insertion order, GUID casing, or repeated merges' {
        $athlete = '44444444-4444-4444-4444-444444444444'
        $expected = '{"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb":"44444444-4444-4444-4444-444444444444","cccccccc-cccc-cccc-cccc-cccccccccccc":"44444444-4444-4444-4444-444444444444"}'
        $existing = '{"CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC":"44444444-4444-4444-4444-444444444444","BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB":"44444444-4444-4444-4444-444444444444"}'
        $additions = @{ 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' = $athlete; 'cccccccc-cccc-cccc-cccc-cccccccccccc' = $athlete }
        foreach ($inputJson in @('{}', $existing, $expected)) {
            $result = Merge-RuntimePrincipalMap -ExistingJson $inputJson -Additions $additions
            $result | Should -BeExactly $expected
            1..5 | ForEach-Object {
                $result = Merge-RuntimePrincipalMap -ExistingJson $result -Additions @{}
                $result = Merge-RuntimePrincipalMap -ExistingJson $result -Additions $additions
                $result | Should -BeExactly $expected
            }
        }
    }
}

Describe 'Runtime access token acquisition' {
    It 'requests a token with only --subscription (az CLI >= 2.7x rejects --subscription and --tenant together)' {
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -contains '--tenant') { throw 'Must not pass --tenant alongside --subscription.' }
            if ($args -notcontains '--subscription') { throw 'Missing explicit subscription.' }
            return (@{ accessToken = 'DO-NOT-LEAK-TOKEN'; tenant = 'tenant-a' } | ConvertTo-Json)
        }
        $token = Get-RuntimeAccessToken -SubscriptionId 'sub-a' -TenantId 'tenant-a' -Resource 'https://management.azure.com/'
        $token | Should -BeExactly 'DO-NOT-LEAK-TOKEN'
    }

    It 'fails closed when the returned token tenant does not match the requested tenant' {
        Mock az {
            $global:LASTEXITCODE = 0
            return (@{ accessToken = 'DO-NOT-LEAK-TOKEN'; tenant = 'unexpected-tenant' } | ConvertTo-Json)
        }
        { Get-RuntimeAccessToken -SubscriptionId 'sub-a' -TenantId 'tenant-a' -Resource 'https://management.azure.com/' } |
            Should -Throw '*different tenant*'
    }

    It 'fails closed when the token response omits a tenant claim' {
        Mock az {
            $global:LASTEXITCODE = 0
            return (@{ accessToken = 'DO-NOT-LEAK-TOKEN' } | ConvertTo-Json)
        }
        { Get-RuntimeAccessToken -SubscriptionId 'sub-a' -TenantId 'tenant-a' -Resource 'https://management.azure.com/' } |
            Should -Throw '*different tenant*'
    }
}

Describe 'Runtime connection reconciliation' {
    BeforeEach {
        New-RuntimeFixture
        $f = $global:RuntimeFixture
        $script:Params = @{
            SubscriptionId = $f.SubscriptionId; TenantId = $f.TenantId
            FabricWorkspaceId = $f.WorkspaceId; FabricDataAgentId = $f.AgentId; AthleteId = $f.AthleteId
            AssistantAuthResult = $f.AuthResult
        }
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -notcontains '--subscription') { throw 'Missing explicit subscription.' }
            if ($args[0] -eq 'account' -and $args[1] -eq 'show') {
                return (@{ id = $global:RuntimeFixture.SubscriptionId; tenantId = $global:RuntimeFixture.TenantId } | ConvertTo-Json)
            }
            if ($args[0] -eq 'account' -and $args[1] -eq 'get-access-token') {
                # Real az CLI (>= 2.7x) rejects `--subscription` and `--tenant` together on this
                # subcommand, so Get-RuntimeAccessToken must pass subscription only and rely on
                # the returned `tenant` claim for verification -- assert that contract here.
                if ($args -contains '--tenant') { throw 'Must not combine --subscription and --tenant on get-access-token.' }
                return (@{ accessToken = 'DO-NOT-LEAK-TOKEN'; tenant = $global:RuntimeFixture.TenantId } | ConvertTo-Json)
            }
            throw 'Unexpected Azure CLI operation.'
        }
        Mock Invoke-WebRequest { param($Uri, $Method, $Body) Invoke-RuntimeFixtureRequest $Uri $Method $Body }
        Mock Invoke-RestMethod -ParameterFilter { $Uri -like 'https://graph.microsoft.com/*' } {
            return @{ id = $global:RuntimeFixture.ProjectOid; appId = $global:RuntimeFixture.ProjectClientId }
        }
    }

    It 'uses the project MI for MCP, grants backend and explicit humans, preserves existing callers and secret references' {
        $result = & $script:RuntimeScript @script:Params
        $f = $global:RuntimeFixture
        $result.ProjectManagedIdentityPrincipalId | Should -Be $f.ProjectOid
        $result.FabricConnectionAuthType | Should -Be 'AAD'
        $connection = $f.Resources["$($f.ProjectId)/connections/athlete-mcp-tools"]
        $connection.properties.authType | Should -Be 'ProjectManagedIdentity'
        $connection.properties.audience | Should -Be "api://$($f.BackendClientId)"
        $policy = $f.Resources["$($f.BackendId)/authConfigs/current"].properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy
        $policy.allowedApplications | Should -Contain $f.ProjectClientId
        $policy.allowedApplications | Should -Contain $f.CockpitClientId
        $policy.allowedApplications | Should -Contain 'dddddddd-dddd-dddd-dddd-dddddddddddd'
        # Foundry's project-managed-identity MCP callback is rejected by Easy Auth despite a
        # fully valid, allow-listed token (a platform limitation -- see mcp-caller.ts); this
        # path must be excluded so the backend's own JWKS-verified check (which still enforces
        # ATHLETE_PRINCIPAL_MAP) runs instead.
        $f.Resources["$($f.BackendId)/authConfigs/current"].properties.globalValidation.excludedPaths |
            Should -Contain '/api/assistant/mcp'
        $roles = $f.Resources["$($f.ProjectId)/providers/Microsoft.Authorization/roleAssignments"].value
        $roles.properties.principalId | Should -Contain $f.BackendOid
        $roles.properties.principalId | Should -Contain $f.UserOid
        $roles.Count | Should -Be 2
        $envMap = @{}
        foreach ($e in $f.Resources[$f.BackendId].properties.template.containers[0].env) { $envMap[$e.name] = $e }
        $map = $envMap.ATHLETE_PRINCIPAL_MAP.value | ConvertFrom-Json -AsHashtable
        $map[$f.ProjectOid] | Should -Be $f.AthleteId
        $map[$f.UserOid] | Should -Be $f.AthleteId
        $envMap.ASSISTANT_AUTH_CLIENT_SECRET.secretRef | Should -Be 'assistant-obo-client-secret'
        $f.Resources[$f.BackendId].properties.template.containers[0].image | Should -Be 'registry.example.test/streaming-backend:distinct-tag'
        $cockpitEnv = $f.Resources[$f.CockpitId].properties.template.containers[0].env
        ($cockpitEnv | Where-Object name -eq STREAMING_BACKEND_SCOPE).value | Should -Be "api://$($f.BackendClientId)/.default"
        ($result | ConvertTo-Json -Depth 20) | Should -Not -Match 'DO-NOT-LEAK|Authorization|credentials'
        @($f.Requests | Where-Object { $_.Method -eq 'PATCH' -and $_.Body -match '"configuration"|"identity"|"ingress"|"scale"' }).Count | Should -Be 0
    }

    It 'is a no-op on the second reconciliation' {
        & $script:RuntimeScript @script:Params | Out-Null
        $global:RuntimeFixture.Requests.Clear()
        $result = & $script:RuntimeScript @script:Params
        $result.ChangedResources.Count | Should -Be 0
        @($global:RuntimeFixture.Requests | Where-Object Method -in @('PUT', 'PATCH')).Count | Should -Be 0
    }

    It 'does not mutate under WhatIf or print secret material even in verbose output' {
        $output = & $script:RuntimeScript @script:Params -WhatIf -Verbose 4>&1 6>&1
        @($global:RuntimeFixture.Requests | Where-Object Method -in @('PUT', 'PATCH')).Count | Should -Be 0
        ($output | Out-String) | Should -Not -Match 'DO-NOT-LEAK'
        Should -Invoke az -Times 0 -ParameterFilter { $args[1] -eq 'set' }
    }

    It 'creates the native Fabric connection via ARM when absent (no manual portal step required)' {
        $f = $global:RuntimeFixture
        $f.Resources.Remove($f.FabricId)
        $result = & $script:RuntimeScript @script:Params
        $result.FabricConnectionAuthType | Should -Be 'AAD'
        $result.FabricProjectConnectionId | Should -Be $f.FabricId
        $connection = $f.Resources[$f.FabricId]
        $connection.properties.category | Should -Be 'MicrosoftFabric'
        $connection.properties.authType | Should -Be 'AAD'
        $connection.properties.target | Should -Be "https://api.fabric.microsoft.com/v1/workspaces/$($f.WorkspaceId)/aiskills/$($f.AgentId)"
        $connection.properties.metadata.'workspace-id' | Should -Be $f.WorkspaceId
        $connection.properties.metadata.'artifact-id' | Should -Be $f.AgentId
        $result.ChangedResources | Should -Contain 'connection:athlete-fabric-data'
    }

    It 'self-heals a stale Fabric connection target/metadata to the requested workspace and agent' {
        $f = $global:RuntimeFixture
        $f.Resources[$f.FabricId].properties.target = 'https://api.fabric.microsoft.com/v1/workspaces/stale/aiskills/stale'
        $f.Resources[$f.FabricId].properties.metadata = @{ 'workspace-id' = 'stale'; 'artifact-id' = 'stale' }
        $result = & $script:RuntimeScript @script:Params
        $connection = $f.Resources[$f.FabricId]
        $connection.properties.target | Should -Be "https://api.fabric.microsoft.com/v1/workspaces/$($f.WorkspaceId)/aiskills/$($f.AgentId)"
        $connection.properties.metadata.'workspace-id' | Should -Be $f.WorkspaceId
        $connection.properties.metadata.'artifact-id' | Should -Be $f.AgentId
        $result.ChangedResources | Should -Contain 'connection:athlete-fabric-data'
    }

    It 'refuses to reuse a same-named connection owned by a different category' {
        $f = $global:RuntimeFixture
        $f.Resources[$f.FabricId].properties.category = 'RemoteTool'
        { & $script:RuntimeScript @script:Params } | Should -Throw '*owned by a different category*'
        @($f.Requests | Where-Object Method -in @('PUT', 'PATCH')).Count | Should -Be 0
    }

    It 'fails closed on tenant, auth-output, and athlete-map conflicts' {
        $wrong = $script:Params.Clone()
        $wrong.TenantId = $global:RuntimeFixture.UserOid
        { & $script:RuntimeScript @wrong } | Should -Throw '*requested tenant*'
        $global:RuntimeFixture.AuthResult.BackendAuthClientId = $global:RuntimeFixture.UserOid
        { & $script:RuntimeScript @script:Params } | Should -Throw '*does not match*'
        @($global:RuntimeFixture.Requests | Where-Object Method -in @('PUT', 'PATCH')).Count | Should -Be 0
    }

    It 'rejects conflicting existing athlete maps and missing OBO secrets before writes' {
        $f = $global:RuntimeFixture
        $container = $f.Resources[$f.BackendId].properties.template.containers[0]
        $container.env += @{ name = 'ATHLETE_PRINCIPAL_MAP'; value = (@{ $f.UserOid.ToUpperInvariant() = $f.AgentId } | ConvertTo-Json -Compress) }
        { & $script:RuntimeScript @script:Params } | Should -Throw '*different athlete*'
        $container.env = @($container.env | Where-Object name -ne ATHLETE_PRINCIPAL_MAP)
        $f.Resources[$f.BackendId].properties.configuration.secrets = @(@{ name = 'keep-secret'; value = 'DO-NOT-LEAK' })
        { & $script:RuntimeScript @script:Params } | Should -Throw '*OBO secret is missing*'
        @($f.Requests | Where-Object Method -in @('PUT', 'PATCH')).Count | Should -Be 0
    }

    It 'restarts only the existing backend revision when rotating an otherwise unchanged SAS' {
        $f = $global:RuntimeFixture
        $settings = @{ SubscriptionId = $f.SubscriptionId; TenantId = $f.TenantId; EventstreamEventHubConnectionString = 'old-sas' }
        & $script:SettingsScript @settings | Out-Null
        $f.Requests.Clear()
        $settings.EventstreamEventHubConnectionString = 'new-sas'
        & $script:SettingsScript @settings | Out-Null
        @($f.Requests | Where-Object { $_.Method -eq 'POST' -and $_.Uri -like '*/revisions/*/restart?*' }).Count | Should -Be 1
    }

    It 'refreshes all affected active revisions after rollback without activating the latest or changing traffic' -ForEach @(
        @{ ChangeEnvironment = $false }, @{ ChangeEnvironment = $true }
    ) {
        $f = $global:RuntimeFixture
        $settings = @{ SubscriptionId = $f.SubscriptionId; TenantId = $f.TenantId; EventstreamEventHubConnectionString = 'old-sas' }
        & $script:SettingsScript @settings | Out-Null
        $app = $f.Resources[$f.BackendId]
        $app.properties.latestRevisionName = 'backend--inactive'
        $app.properties.configuration.activeRevisionsMode = 'Multiple'
        $app.properties.configuration.ingress.traffic = @(
            @{ revisionName = 'backend--serving-a'; weight = 70 },
            @{ revisionName = 'backend--serving-b'; weight = 30 }
        )
        $revisions = @()
        foreach ($name in @('backend--serving-a', 'backend--serving-b', 'backend--unrelated', 'backend--inactive')) {
            $secretRef = if ($name -eq 'backend--unrelated') { 'keep-secret' } else { 'eventstream-eventhub-connection-string' }
            $revisions += @{
                id = "$($f.BackendId)/revisions/$name"; name = $name
                properties = @{
                    active = $name -ne 'backend--inactive'
                    template = @{ containers = @(@{ name = 'streaming-backend'; env = @(@{ name = 'SECRET'; secretRef = $secretRef }) }) }
                }
            }
        }
        $f.Resources["$($f.BackendId)/revisions"] = @{ value = $revisions }
        $trafficBefore = $app.properties.configuration.ingress.traffic | ConvertTo-Json -Compress
        $f.Requests.Clear()
        $settings.EventstreamEventHubConnectionString = 'new-sas'
        if ($ChangeEnvironment) { $settings.LakehouseOneLakePath = 'new-lakehouse' }
        & $script:SettingsScript @settings | Out-Null
        $restarts = @($f.Requests | Where-Object { $_.Method -eq 'POST' -and $_.Uri -like '*/revisions/*/restart?*' })
        $restarts.Count | Should -Be 2
        ($restarts.Uri -join ',') | Should -Match 'backend--serving-a'
        ($restarts.Uri -join ',') | Should -Match 'backend--serving-b'
        ($restarts.Uri -join ',') | Should -Not -Match 'backend--inactive|backend--unrelated'
        ($app.properties.configuration.ingress.traffic | ConvertTo-Json -Compress) | Should -Be $trafficBefore
        @($revisions | Where-Object { $_.properties.active }).Count | Should -Be 3
    }

    It 'merges only owned workload settings and native secrets while preserving distinct images and configuration' {
        $f = $global:RuntimeFixture
        $settings = @{
            SubscriptionId = $f.SubscriptionId; TenantId = $f.TenantId
            LakehouseOneLakeFileSystem = $f.WorkspaceId; LakehouseOneLakePath = $f.AgentId
            EventstreamEventHubConnectionString = 'DO-NOT-LEAK-SAS'
            EventhouseQueryUri = 'https://cluster.kusto.fabric.microsoft.com'
            EventhouseDatabaseName = 'realtime'; DefaultAthleteId = $f.AthleteId
        }
        $result = & $script:SettingsScript @settings
        $result.ChangedWorkloads.Count | Should -Be 5
        foreach ($workload in @('streaming-backend', 'simulator', 'mcp-tools', 'console', 'cockpit')) {
            $kind = if ($workload -eq 'simulator') { 'jobs' } else { 'containerApps' }
            $resource = $f.Resources["$($f.Root)/Microsoft.App/$kind/triatwin-dev-$workload"]
            $resource.properties.template.containers[0].image | Should -Be "registry.example.test/$workload`:distinct-tag"
            $resource.properties.template.scale.maxReplicas | Should -Be 3
            $resource.properties.configuration.ingress.targetPort | Should -Be 3300
            ($resource.properties.configuration.secrets | Where-Object name -eq keep-secret).value | Should -Be 'DO-NOT-LEAK-NATIVE-SECRET'
            ($resource.properties.template.containers[0].env | Where-Object name -eq KEEP_SETTING).value | Should -Be "keep-$workload"
        }
        $f.Requests.Clear()
        (& $script:SettingsScript @settings).ChangedWorkloads.Count | Should -Be 0
        @($f.Requests | Where-Object Method -eq 'PATCH').Count | Should -Be 0
    }

    It 'sanitizes ARM failure bodies, including failed secret writes' {
        Mock Invoke-WebRequest {
            return @{ StatusCode = 403; Content = '{"error":{"message":"DO-NOT-LEAK-ERROR"}}' }
        }
        { & $script:RuntimeScript @script:Params } | Should -Throw '*HTTP 403*'
        try { & $script:RuntimeScript @script:Params } catch { $_.Exception.Message | Should -Not -Match 'DO-NOT-LEAK' }
    }
}
