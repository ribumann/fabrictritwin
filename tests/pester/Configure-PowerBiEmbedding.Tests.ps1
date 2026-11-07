#Requires -Version 7.0
BeforeAll {
    $global:PowerBiTest_ScriptPath = (Resolve-Path "$PSScriptRoot\..\..\scripts\provision\configure-powerbi-embedding.ps1").Path
    $global:PowerBiTest_Params = @{
        SubscriptionId = '11111111-1111-1111-1111-111111111111'
        TenantId = '22222222-2222-2222-2222-222222222222'
        WorkspaceId = '33333333-3333-3333-3333-333333333333'
        ReportId = '44444444-4444-4444-4444-444444444444'
        ResourceGroupName = 'rg-demo'; CockpitAppName = 'demo-cockpit'
        AllowedPrincipalIds = @('55555555-5555-5555-5555-555555555555')
    }
    $global:PowerBiTest_DatasetId = '66666666-6666-6666-6666-666666666666'
    $global:PowerBiTest_ClientId = '77777777-7777-7777-7777-777777777777'
    $global:PowerBiTest_SpId = '88888888-8888-8888-8888-888888888888'
    $global:PowerBiTest_GroupId = '99999999-9999-9999-9999-999999999999'
    $global:PowerBiTest_ConnectionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    $global:PowerBiTest_AppObjectId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    $global:PowerBiTest_ArmRoot = "https://management.azure.com/subscriptions/$($global:PowerBiTest_Params.SubscriptionId)/resourceGroups/rg-demo/providers/Microsoft.App/containerApps/demo-cockpit"
    function Json-Object($value) { $value | ConvertTo-Json -Depth 50 | ConvertFrom-Json }
}

Describe 'Power BI embedding configuration' {
BeforeEach {
    $global:PowerBiTest_Writes = [System.Collections.Generic.List[object]]::new()
    $global:PowerBiTest_AzCalls = [System.Collections.Generic.List[object]]::new()
    $global:PowerBiTest_MembersReadHeaders = [System.Collections.Generic.List[object]]::new()
    $global:PowerBiTest_AuthEnabled = $true
    $global:PowerBiTest_ReturnedTenant = $global:PowerBiTest_Params.TenantId
    $global:PowerBiTest_ReportDataset = $global:PowerBiTest_DatasetId
    $global:PowerBiTest_BindingType = 'AzureDataLakeStorage'
    $global:PowerBiTest_ModelRls = $false
    $global:PowerBiTest_ExcludedPaths = @()
    $global:PowerBiTest_MissingApp = $false
    $global:PowerBiTest_MissingConnection = $false
    $global:PowerBiTest_AutomaticBinding = $false
    $global:PowerBiTest_ExpireCredential = $false
    $global:PowerBiTest_TokenFailure = $false
    $global:PowerBiTest_PasswordKeyId = 'key-one'
    $global:PowerBiTest_FailConnectionPatchOnce = $false
    $global:PowerBiTest_FailOwnershipWriteOnce = $false
    $global:PowerBiTest_ConnectionCreated = $false
    $global:PowerBiTest_SimulateMemberAddRace = $false
    $global:PowerBiTest_Marker = 'fabrictritwin-powerbi:' + [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($global:PowerBiTest_ArmRoot.ToLowerInvariant())))
    $global:PowerBiTest_Settings = @(
        (Json-Object @{ title = 'Embed content in apps'; settingName = 'Embedding'; enabled = $true; canSpecifySecurityGroups = $true })
        (Json-Object @{ title = 'Service principals can call Fabric public APIs'; settingName = 'ServicePrincipalAccessPermissionAPIs'; enabled = $true; canSpecifySecurityGroups = $true })
    )
    $global:PowerBiTest_Secrets = @(
        (Json-Object @{ name = 'unrelated'; value = 'unrelated-secret-preserved' })
        (Json-Object @{ name = 'powerbi-client-secret'; value = 'test-client-secret' })
    )
    $global:PowerBiTest_Connection = Json-Object @{
        id = $global:PowerBiTest_ConnectionId; connectivityType = 'ShareableCloud'
        displayName = "demo-cockpit-$global:PowerBiTest_DatasetId-$('d' * 32)"
        connectionDetails = @{
            type = 'AzureDataLakeStorage'
            path = "https://onelake.dfs.fabric.microsoft.com/$($global:PowerBiTest_Params.WorkspaceId)/cccccccc-cccc-cccc-cccc-cccccccccccc/"
        }
        credentialDetails = @{ credentialType = 'ServicePrincipal'; singleSignOnType = 'None'; connectionEncryption = 'NotEncrypted' }
    }
    $global:PowerBiTest_AppState = Json-Object @{
        id = $global:PowerBiTest_ArmRoot.Replace('https://management.azure.com', '')
        properties = @{
            provisioningState = 'Succeeded'
            managedEnvironmentId = '/unrelated/environment'
            configuration = @{
                ingress = @{ external = $true; targetPort = 3300 }
                registries = @(@{ server = 'keep.azurecr.io'; identity = '/keep/identity' })
                secrets = @(@{ name = 'unrelated' }, @{ name = 'powerbi-client-secret' })
            }
            template = @{
                containers = @(@{
                    name = 'cockpit'; image = 'keep.azurecr.io/cockpit:keep'
                    resources = @{ cpu = 0.5; memory = '1Gi' }
                    env = @(
                        @{ name = 'KEEP_ME'; value = 'unchanged' }
                        @{ name = 'POWERBI_CLIENT_ID'; value = $global:PowerBiTest_ClientId }
                        @{ name = 'POWERBI_CREDENTIAL_KEY_ID'; value = 'key-one' }
                        @{ name = 'POWERBI_CONNECTION_ID'; value = $global:PowerBiTest_ConnectionId }
                        @{ name = 'POWERBI_CONNECTION_NAME'; value = $global:PowerBiTest_Connection.displayName }
                        @{ name = 'POWERBI_CONNECTION_CREDENTIAL_KEY_ID'; value = 'key-one' }
                    )
                })
                scale = @{ minReplicas = 1; maxReplicas = 1 }
            }
        }
    }
    Mock az {
        $global:LASTEXITCODE = 0
        $global:PowerBiTest_AzCalls.Add(@($args))
        if ($args[0] -eq 'account' -and $args[1] -eq 'show') {
            return @{ id = $global:PowerBiTest_Params.SubscriptionId; tenantId = $global:PowerBiTest_ReturnedTenant } | ConvertTo-Json
        }
        if ($args[0] -eq 'account' -and $args[1] -eq 'get-access-token') { return 'test-api-token' }
        throw 'Unexpected Azure CLI command.'
    }
    Mock Invoke-RestMethod {
        param($Uri, $Method, $Body, $Headers)
        if ($Method -ne 'GET' -and $Uri -notlike '*/listSecrets?*') {
            $parsedBody = if ($Body -is [string]) { $Body | ConvertFrom-Json } else { Json-Object $Body }
            $global:PowerBiTest_Writes.Add(@{ Uri = $Uri; Method = $Method; Body = $parsedBody })
        }
        if ($Uri -like '*/authConfigs/current?*') {
            return Json-Object @{ properties = @{
                platform = @{ enabled = $global:PowerBiTest_AuthEnabled }
                globalValidation = @{ unauthenticatedClientAction = 'RedirectToLoginPage'; excludedPaths = $global:PowerBiTest_ExcludedPaths }
                identityProviders = @{ azureActiveDirectory = @{
                    enabled = $true; registration = @{ openIdIssuer = "https://login.microsoftonline.com/$($global:PowerBiTest_Params.TenantId)/v2.0" }
                }}
            }}
        }
        if ($Uri -eq "$global:PowerBiTest_ArmRoot`?api-version=2024-03-01") {
            if ($Method -eq 'PATCH') {
                $update = $Body | ConvertFrom-Json
                if ($global:PowerBiTest_FailOwnershipWriteOnce -and $global:PowerBiTest_ConnectionCreated -and
                    @($update.properties.template.containers[0].env | Where-Object name -eq 'POWERBI_CONNECTION_ID').Count -eq 1) {
                    $global:PowerBiTest_FailOwnershipWriteOnce = $false
                    throw 'Simulated interrupted ownership persistence'
                }
                $global:PowerBiTest_AppState.properties.configuration = $update.properties.configuration
                $global:PowerBiTest_AppState.properties.template = $update.properties.template
                $global:PowerBiTest_Secrets = @($update.properties.configuration.secrets)
            }
            return $global:PowerBiTest_AppState
        }
        if ($Uri -like '*/listSecrets?*') { return Json-Object @{ value = $global:PowerBiTest_Secrets } }
        if ($Uri -like '*/applications*') {
            if ($Uri -like '*/addPassword') {
                $global:PowerBiTest_PasswordKeyId = 'key-two'
                $global:PowerBiTest_ExpireCredential = $false
                return Json-Object @{ secretText = 'test-new-client-secret'; keyId = 'key-two'; endDateTime = [datetimeoffset]::UtcNow.AddDays(180).ToString('o') }
            }
            $application = Json-Object @{
                id = $global:PowerBiTest_AppObjectId; appId = $global:PowerBiTest_ClientId
                tags = @($global:PowerBiTest_Marker)
                passwordCredentials = @(@{
                    keyId = $global:PowerBiTest_PasswordKeyId
                    endDateTime = [datetimeoffset]::UtcNow.AddDays($(if ($global:PowerBiTest_ExpireCredential) { 1 } else { 90 })).ToString('o')
                })
            }
            if ($Method -eq 'POST') { $global:PowerBiTest_MissingApp = $false; return $application }
            return Json-Object @{ value = $(if ($global:PowerBiTest_MissingApp) { @() } else { @($application) }) }
        }
        if ($Uri -like 'https://graph.microsoft.com/*/servicePrincipals*') {
            return Json-Object @{ value = @(@{ id = $global:PowerBiTest_SpId; appId = $global:PowerBiTest_ClientId }) }
        }
        if ($Uri -like 'https://graph.microsoft.com/*/groups*') {
            if ($Uri -like '*/members*') {
                $global:PowerBiTest_MembersReadHeaders.Add($Headers)
                if ($global:PowerBiTest_SimulateMemberAddRace) {
                    if ($Method -eq 'POST') {
                        throw 'One or more added object references already exist for the following modified properties: ''members''.'
                    }
                    return Json-Object @{ value = @() }
                }
                return Json-Object @{ value = @(@{ id = $global:PowerBiTest_SpId }) }
            }
            return Json-Object @{ value = @(@{
                id = $global:PowerBiTest_GroupId; description = $global:PowerBiTest_Marker
                displayName = 'demo-cockpit-powerbi-embedding-allowed'; securityEnabled = $true
            }) }
        }
        if ($Uri -like '*/admin/tenantsettings*') {
            if ($Method -eq 'POST') {
                $setting = $global:PowerBiTest_Settings | Where-Object { $Uri -like "*/$($_.settingName)/update" }
                $update = $Body | ConvertFrom-Json
                $setting.enabled = $update.enabled
                $setting | Add-Member -NotePropertyName enabledSecurityGroups -NotePropertyValue $update.enabledSecurityGroups -Force
                return $null
            }
            return Json-Object @{ value = $global:PowerBiTest_Settings }
        }
        if ($Uri -like '*/roleAssignments') {
            return Json-Object @{ value = @(@{
                id = 'role-id'; principal = @{ id = $global:PowerBiTest_SpId; type = 'ServicePrincipal' }
                role = $(if ($Uri -like '*/connections/*') { 'User' } else { 'Member' })
            }) }
        }
        if ($Uri -like '*/supportedConnectionTypes?*') {
            return Json-Object @{ value = @(@{
                type = 'AzureDataLakeStorage'; supportedCredentialTypes = @('ServicePrincipal')
                supportedConnectionEncryptionTypes = @('NotEncrypted'); supportsSkipTestConnection = $false
                creationMethods = @(@{ name = 'AzureDataLakeStorage'; parameters = @(
                    @{ name = 'server'; dataType = 'Text'; required = $true }
                    @{ name = 'path'; dataType = 'Text'; required = $true }
                )})
            }) }
        }
        if ($Uri -like 'https://api.fabric.microsoft.com/v1/connections*') {
            if ($Uri -eq 'https://api.fabric.microsoft.com/v1/connections') {
                if ($Method -eq 'POST') {
                    $global:PowerBiTest_MissingConnection = $false
                    $global:PowerBiTest_ConnectionCreated = $true
                    $global:PowerBiTest_Connection.displayName = ($Body | ConvertFrom-Json).displayName
                    return $global:PowerBiTest_Connection
                }
                return Json-Object @{ value = $(if ($global:PowerBiTest_MissingConnection) { @() } else { @($global:PowerBiTest_Connection) }) }
            }
            if ($Method -eq 'PATCH' -and $global:PowerBiTest_FailConnectionPatchOnce) {
                $global:PowerBiTest_FailConnectionPatchOnce = $false
                throw 'Simulated interrupted connection credential update'
            }
            return $global:PowerBiTest_Connection
        }
        if ($Uri -like '*/bindConnection') { $global:PowerBiTest_AutomaticBinding = $false; return $null }
        if ($Uri -like '*/Default.TakeOver') { return $null }
        if ($Uri -like '*/oauth2/v2.0/token') { return Json-Object @{ access_token = 'test-sp-access-token' } }
        if ($Uri -like '*/GenerateToken') {
            if ($global:PowerBiTest_TokenFailure) { throw 'test-client-secret should not escape' }
            return Json-Object @{ token = 'test-embed-token'; expiration = [datetimeoffset]::UtcNow.AddMinutes(10).ToString('o') }
        }
        if ($Uri -like '*/reports/*') {
            return Json-Object @{ id = $global:PowerBiTest_Params.ReportId; datasetId = $global:PowerBiTest_ReportDataset; reportType = 'PowerBIReport' }
        }
        if ($Uri -like '*/datasets/*/datasources') {
            return Json-Object @{ value = @(@{
                datasourceType = 'AzureDataLakeStorage'; connectionDetails = @{
                    server = 'onelake.dfs.fabric.microsoft.com'
                    path = "/$($global:PowerBiTest_Params.WorkspaceId)/cccccccc-cccc-cccc-cccc-cccccccccccc/"
                }
            })}
        }
        if ($Uri -like '*/datasets/*') {
            return Json-Object @{ id = $global:PowerBiTest_ReportDataset; isEffectiveIdentityRequired = $global:PowerBiTest_ModelRls; isEffectiveIdentityRolesRequired = $false }
        }
        if ($Uri -like '*/items/*/connections') {
            return Json-Object @{ value = @(@{
                id = $(if ($global:PowerBiTest_AutomaticBinding) { $null } else { $global:PowerBiTest_ConnectionId })
                connectivityType = $(if ($global:PowerBiTest_AutomaticBinding) { 'Automatic' } else { 'ShareableCloud' })
                connectionDetails = @{
                    type = $global:PowerBiTest_BindingType
                    path = "https://onelake.dfs.fabric.microsoft.com/$($global:PowerBiTest_Params.WorkspaceId)/cccccccc-cccc-cccc-cccc-cccccccccccc/"
                }
            })}
        }
        throw "Unexpected mock API: $Method $Uri"
    }
}

    It 'performs WhatIf discovery with explicit subscription, no writes and no secrets' {
        $result = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -WhatIf
        $result.Status | Should -Be 'Planned'
        $result.SemanticModelId | Should -Be $global:PowerBiTest_DatasetId
        $global:PowerBiTest_Writes.Count | Should -Be 0
        foreach ($call in $global:PowerBiTest_AzCalls) {
            $call | Should -Contain '--subscription'
            $call | Should -Contain $global:PowerBiTest_Params.SubscriptionId
            $call | Should -Not -Contain 'set'
            $call | Should -Not -Contain '--tenant'
        }
        ($result | ConvertTo-Json -Depth 20) | Should -Not -Match 'test-api-token|test-client-secret'
        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -ne 'GET' }
    }

    It 'rejects a mismatched Azure tenant without API access or account switching' {
        $global:PowerBiTest_ReturnedTenant = $global:PowerBiTest_ClientId
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -WhatIf } | Should -Throw '*requested tenant*'
        Should -Invoke Invoke-RestMethod -Times 0
    }

    It 'fails closed when EasyAuth is disabled' {
        $global:PowerBiTest_AuthEnabled = $false
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -WhatIf } | Should -Throw '*EasyAuth*'
        $global:PowerBiTest_Writes.Count | Should -Be 0
    }

    It 'rejects report endpoint exclusions but permits unrelated health checks' {
        $global:PowerBiTest_ExcludedPaths = @('/api/*')
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -WhatIf } | Should -Throw '*excluded*'
        $global:PowerBiTest_ExcludedPaths = @('/healthz')
        (& $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -WhatIf).Status | Should -Be 'Planned'
    }

    It 'resolves the report datasetId and rejects an expected-model mismatch' {
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -ExpectedSemanticModelId $global:PowerBiTest_ClientId -WhatIf } | Should -Throw '*ExpectedSemanticModelId*'
        $global:PowerBiTest_Writes.Count | Should -Be 0
    }

    It 'rejects unsupported RLS and non-Direct-Lake sources before writes' {
        $global:PowerBiTest_ModelRls = $true
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -WhatIf } | Should -Throw '*single-athlete*'
        $global:PowerBiTest_ModelRls = $false
        $global:PowerBiTest_BindingType = 'SQL'
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -WhatIf } | Should -Throw '*AzureDataLakeStorage*'
        $global:PowerBiTest_Writes.Count | Should -Be 0
    }

    It 'reuses credentials, preserves app image/env/native secrets/auth and is idempotent' {
        $result = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        $result.Status | Should -Be 'Configured'
        $result.RuntimeValidated | Should -BeTrue
        $result.ReportRenderingValidated | Should -BeFalse
        ($result | ConvertTo-Json -Depth 20) | Should -Not -Match 'test-client-secret|test-sp-access-token|test-embed-token'
        $container = $global:PowerBiTest_AppState.properties.template.containers[0]
        $container.image | Should -Be 'keep.azurecr.io/cockpit:keep'
        ($container.env | Where-Object name -eq 'KEEP_ME').value | Should -Be 'unchanged'
        ($container.env | Where-Object name -eq 'POWERBI_CLIENT_SECRET').secretRef | Should -Be 'powerbi-client-secret'
        ($global:PowerBiTest_Secrets | Where-Object name -eq 'unrelated').value | Should -Be 'unrelated-secret-preserved'
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/addPassword').Count | Should -Be 0
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/authConfigs/*').Count | Should -Be 0
        # Graph's plain /members list can silently omit service-principal members without
        # an eventually-consistent read; assert the header is always sent to avoid a
        # false-negative idempotency check that re-attempts an already-satisfied add.
        $global:PowerBiTest_MembersReadHeaders.Count | Should -BeGreaterThan 0
        $global:PowerBiTest_MembersReadHeaders | ForEach-Object { $_.ConsistencyLevel | Should -Be 'eventual' }
        $global:PowerBiTest_Writes.Clear()
        $again = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        $again.Changes.Count | Should -Be 0
        @($global:PowerBiTest_Writes | Where-Object Method -eq PATCH).Count | Should -Be 0
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/admin/tenantsettings/*').Count | Should -Be 0
    }

    It 'mints a fresh revisionSuffix on the cockpit PATCH instead of reusing a stale one' {
        # A prior rollout (e.g. auth credential rotation) leaves its explicit revisionSuffix
        # stored on the app; echoing that stale value back on this PATCH would collide with
        # the revision ARM already created for it and fail the update.
        $global:PowerBiTest_AppState.properties.template | Add-Member -NotePropertyName revisionSuffix -NotePropertyValue 'auth-c7cd67295b' -Force
        $null = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        $patchWrite = $global:PowerBiTest_Writes | Where-Object { $_.Uri -eq "$global:PowerBiTest_ArmRoot`?api-version=2024-03-01" -and $_.Method -eq 'PATCH' } | Select-Object -Last 1
        $patchWrite.Body.properties.template.revisionSuffix | Should -Not -Be 'auth-c7cd67295b'
        $patchWrite.Body.properties.template.revisionSuffix | Should -Match '^pbi-[0-9a-f]{10}$'
    }

    It 'treats a raced already-exists group-member add as a benign no-op' {
        $global:PowerBiTest_SimulateMemberAddRace = $true
        $result = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        $result.Status | Should -Be 'Configured'
        $result.Changes | Should -Not -Contain 'Add only the embedding service principal to its security group'
    }

    It 'returns a consent checkpoint instead of enabling tenant settings implicitly' {
        $global:PowerBiTest_Settings[0].enabled = $false
        $result = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        $result.Status | Should -Be 'TenantSettingsRequired'
        $result.RuntimeValidated | Should -BeFalse
        $result.RequiredTenantSettings | Should -Contain 'Embed content in apps'
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/admin/tenantsettings/*').Count | Should -Be 0
        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Uri -like '*/listSecrets?*' }
    }

    It 'uses approved scoped tenant settings without widening organization access' {
        $global:PowerBiTest_Settings[0].enabled = $false
        $global:PowerBiTest_Settings[0] | Add-Member -NotePropertyName delegateToWorkspace -NotePropertyValue $true
        $null = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -ApproveTenantSettings -Confirm:$false
        $update = $global:PowerBiTest_Writes | Where-Object Uri -like '*/admin/tenantsettings/*/update'
        $update.Body.enabledSecurityGroups.Count | Should -Be 1
        $update.Body.enabledSecurityGroups[0].graphId | Should -Be $global:PowerBiTest_GroupId
        $update.Body.delegateToWorkspace | Should -BeTrue
    }

    It 'creates a source-exact fixed connection and binds only the actual report model' {
        $global:PowerBiTest_MissingConnection = $true
        $global:PowerBiTest_AutomaticBinding = $true
        $result = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        $create = $global:PowerBiTest_Writes | Where-Object Uri -eq 'https://api.fabric.microsoft.com/v1/connections'
        $create.Body.credentialDetails.singleSignOnType | Should -Be 'None'
        $create.Body.credentialDetails.credentials.credentialType | Should -Be 'ServicePrincipal'
        $create.Body.connectionDetails.parameters[0].value | Should -Be 'https://onelake.dfs.fabric.microsoft.com'
        $bind = $global:PowerBiTest_Writes | Where-Object Uri -like '*/bindConnection'
        $bind.Uri | Should -BeLike "*/semanticModels/$global:PowerBiTest_DatasetId/bindConnection"
        $bind.Body.connectionBinding.connectionDetails.path | Should -Be $global:PowerBiTest_Connection.connectionDetails.path
        $result.ConnectionId | Should -Be $global:PowerBiTest_ConnectionId
    }

    It 'renews expiring credentials in memory, without CLI secret arguments' {
        $global:PowerBiTest_ExpireCredential = $true
        $result = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/addPassword').Count | Should -Be 1
        ($global:PowerBiTest_Secrets | Where-Object name -eq 'powerbi-client-secret').value | Should -Be 'test-new-client-secret'
        ($global:PowerBiTest_AzCalls | ConvertTo-Json -Depth 10) | Should -Not -Match 'test-new-client-secret|test-client-secret'
        ($result | ConvertTo-Json -Depth 20) | Should -Not -Match 'test-new-client-secret'
    }

    It 'never reports runtime readiness when GenerateToken fails and suppresses secret errors' {
        $global:PowerBiTest_TokenFailure = $true
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false } | Should -Throw '*V2 token validation failed*'
        @($global:PowerBiTest_Writes | Where-Object Method -eq PATCH).Count | Should -Be 0
    }

    It 'requires explicit approval before transferring semantic model ownership' {
        $global:PowerBiTest_AutomaticBinding = $true
        $null = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -TakeOverSemanticModel -Confirm:$false
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/Default.TakeOver').Count | Should -Be 1
        ($global:PowerBiTest_Writes | Where-Object Uri -like '*/Default.TakeOver').Uri | Should -BeLike "*/datasets/$global:PowerBiTest_DatasetId/Default.TakeOver"
    }

    It 'reconciles a connection credential update interrupted after ACA credential persistence' {
        $global:PowerBiTest_ExpireCredential = $true
        $global:PowerBiTest_FailConnectionPatchOnce = $true
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false } | Should -Throw '*API request failed*'
        $global:PowerBiTest_Writes.Clear()
        $result = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        $result.Status | Should -Be 'Configured'
        @($global:PowerBiTest_Writes | Where-Object { $_.Method -eq 'PATCH' -and $_.Uri -like '*/connections/*' }).Count | Should -Be 1
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/addPassword').Count | Should -Be 0
        ($global:PowerBiTest_AppState.properties.template.containers[0].env |
            Where-Object name -eq 'POWERBI_CONNECTION_CREDENTIAL_KEY_ID').value | Should -Be 'key-two'
    }

    It 'recovers a successful connection create when recording its ownership was interrupted' {
        $global:PowerBiTest_MissingConnection = $true
        $global:PowerBiTest_AutomaticBinding = $true
        $global:PowerBiTest_FailOwnershipWriteOnce = $true
        $container = $global:PowerBiTest_AppState.properties.template.containers[0]
        $container.env = @($container.env | Where-Object name -notlike 'POWERBI_CONNECTION*')
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false } | Should -Throw '*API request failed*'
        ($global:PowerBiTest_AppState.properties.template.containers[0].env |
            Where-Object name -eq 'POWERBI_CONNECTION_NAME').value | Should -Match '^[a-z0-9-]+-[0-9a-f]{32}$'
        $global:PowerBiTest_Writes.Clear()
        $result = & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false
        $result.Status | Should -Be 'Configured'
        @($global:PowerBiTest_Writes | Where-Object Uri -eq 'https://api.fabric.microsoft.com/v1/connections').Count | Should -Be 0
    }

    It 'rejects a mismatched created connection before rebinding the model' {
        $global:PowerBiTest_MissingConnection = $true
        $global:PowerBiTest_AutomaticBinding = $true
        $global:PowerBiTest_Connection.connectionDetails.path = 'https://onelake.dfs.fabric.microsoft.com/unexpected-source/'
        { & $global:PowerBiTest_ScriptPath @global:PowerBiTest_Params -Confirm:$false } | Should -Throw '*model will not be rebound*'
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/bindConnection').Count | Should -Be 0
        @($global:PowerBiTest_Writes | Where-Object Uri -like '*/GenerateToken').Count | Should -Be 0
    }
}

AfterAll {
    Remove-Variable -Scope Global -Name PowerBiTest_* -ErrorAction SilentlyContinue
}
