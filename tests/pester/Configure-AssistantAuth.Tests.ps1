#Requires -Version 7.0
BeforeAll {
    $script:Configure = (Resolve-Path (Join-Path $PSScriptRoot '..\..\scripts\provision\configure-assistant-auth.ps1')).Path
    . (Join-Path $PSScriptRoot '..\..\scripts\provision\runtime-arm.ps1')
    $script:Parameters = @{
        SubscriptionId = '00000000-0000-0000-0000-000000000123'
        TenantId = '11111111-1111-1111-1111-111111111111'
        AuthorizedUserObjectIds = @('55555555-5555-5555-5555-555555555555')
        AthleteId = '66666666-6666-6666-6666-666666666666'
        TokenStoreStorageAccountName = 'assistanttesttokens'
    }
    function Copy-TestValue($value) { ConvertFrom-Json -AsHashtable -InputObject (ConvertTo-Json -InputObject $value -Depth 100) }
    function Throw-TestHttp([int]$status, [string]$code = 'TestFailure') {
        $exception = [Exception]::new('DO-NOT-LEAK-ERROR-BODY-SECRET')
        $exception | Add-Member -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{ StatusCode = $status })
        $record = [System.Management.Automation.ErrorRecord]::new($exception, 'MockHttp', 'InvalidOperation', $null)
        $record.ErrorDetails = [System.Management.Automation.ErrorDetails]::new(
            "{`"error`":{`"code`":`"$code`",`"message`":`"DO-NOT-LEAK-ERROR-BODY-SECRET`"}}")
        throw $record
    }
    function Add-TestStorage {
        $s = $global:AssistantAuthTestState
        $s.Storage = @{
            id = $s.StorageId; kind = 'StorageV2'; tags = @{ assistantAuthOwner = $s.Owner }
            properties = @{
                allowSharedKeyAccess = $true; publicNetworkAccess = 'Enabled'; networkAcls = @{ defaultAction = 'Allow' }
                supportsHttpsTrafficOnly = $true; minimumTlsVersion = 'TLS1_2'; allowBlobPublicAccess = $false
            }
        }
        $s.Container = @{ id = "$($s.StorageId)/blobServices/default/containers/assistant-tokens"; properties = @{ publicAccess = 'None' } }
    }
    function New-TestApp([string]$id, [string]$name, [string]$container, [string]$secret) {
        @{
            id = $id; name = $name; location = 'polandcentral'; etag = '"v1"'; tags = @{ existing = 'preserved' }
            identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ 'existing-mi' = @{ clientId = 'workload-client-id' } } }
            properties = @{
                provisioningState = 'Succeeded'; latestRevisionName = 'existing-r1'; latestReadyRevisionName = 'existing-r1'
                managedEnvironmentId = 'environment-id'
                configuration = @{
                    activeRevisionsMode = 'Single'
                    ingress = @{ fqdn = "$name.fictional.westeurope.azurecontainerapps.io"; external = $true; targetPort = 3000 }
                    registries = @(@{ server = 'images.azurecr.io'; identity = 'existing-mi' })
                    secrets = @(@{ name = $secret }, @{ name = 'kv-other'; keyVaultUrl = 'https://private.vault.azure.net/secrets/other'; identity = 'existing-mi' })
                }
                template = @{
                    containers = @(
                        @{ name = $container; image = 'images.azurecr.io/app:original'; resources = @{ cpu = 0.5; memory = '1Gi' }
                            env = @(
                                @{ name = 'AZURE_CLIENT_ID'; value = 'workload-client-id' }
                                @{ name = 'STREAMING_BACKEND_SCOPE'; value = 'api://22222222-2222-2222-2222-222222222222/.default' }
                                @{ name = 'OTHER_SECRET'; secretRef = $secret }
                                @{ name = 'ATHLETE_PRINCIPAL_MAP'; value = '{"77777777-7777-7777-7777-777777777777":"66666666-6666-6666-6666-666666666666"}' }
                            )
                        }
                        @{ name = 'sidecar'; image = 'sidecar:unchanged'; env = @(@{ name = 'SIDE'; value = 'preserve' }) }
                    )
                    scale = @{ minReplicas = 1; maxReplicas = 3 }
                }
            }
        }
    }
    function Reset-TestState {
        $rg = '/subscriptions/00000000-0000-0000-0000-000000000123/resourceGroups/rg-triathlon-twin-demo'
        $cid = "$rg/providers/Microsoft.App/containerApps/triatwin-dev-cockpit"
        $bid = "$rg/providers/Microsoft.App/containerApps/triatwin-dev-streaming-backend"
        $owner = 'triatwin-assistant-auth:' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
            [Text.Encoding]::UTF8.GetBytes($cid.ToLowerInvariant()))).Substring(0,20).ToLowerInvariant()
        $global:AssistantAuthTestState = @{
            Owner = $owner; Subscription = $script:Parameters.SubscriptionId; Tenant = $script:Parameters.TenantId
            CockpitId = $cid; BackendId = $bid; StorageId = "$rg/providers/Microsoft.Storage/storageAccounts/assistanttesttokens"
            BackendClient = '22222222-2222-2222-2222-222222222222'; CockpitClient = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
            BackendObject = '33333333-3333-3333-3333-333333333333'; BackendSp = '44444444-4444-4444-4444-444444444444'
            CockpitObject = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; CockpitSp = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
            FoundrySp = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
            Calls = [Collections.Generic.List[object]]::new(); CliCalls = [Collections.Generic.List[object]]::new()
            Applications = @{}; ServicePrincipals = @{}; Grants = @{}; Assignments = @()
            Apps = @{}; Auth = @{}; Secrets = @{}; Storage = $null; Container = $null; NextKey = 1
            RoleAssignments = @{}
            FailPath = $null; FailMethod = $null; FailStatus = 403; FailCode = 'Authorization_RequestDenied'
            Concurrent = $false; ConcurrentReads = 0; UnexpectedReadback = $false; DisabledUser = $false
            Ambiguous = $false; WrongTokenTenant = $false; WrongArmId = $false; UserType = 'Member'
            FailedRevision = $false; MultipleRevisions = $false
            ConcurrentGraph = $false; GraphReads = 0; AdditionalSecret = $false; DeploymentDenied = $false
            SasSigningDenied = $false; SasSigningTransientFailures = 0
        }
        $s = $global:AssistantAuthTestState
        $s.Applications[$s.BackendObject] = @{
            id = $s.BackendObject; appId = $s.BackendClient; displayName = 'triatwin-dev-easyauth'
            web = @{ redirectUris = @('https://old/callback', 'https://legacy.example/callback') }
            api = @{ oauth2PermissionScopes = @(@{ id = '53d326ba-123b-4567-a854-6205d5ea8896'; value = 'user_impersonation'; isEnabled = $true }) }
            requiredResourceAccess = @(@{ resourceAppId = 'graph-app'; resourceAccess = @(@{ id = 'user-read'; type = 'Scope' }) })
            passwordCredentials = @(@{ keyId = 'unmanaged-key'; displayName = 'unmanaged'; endDateTime = [DateTimeOffset]::UtcNow.AddDays(300).ToString('o') })
            tags = @('other-tag')
        }
        $s.ServicePrincipals[$s.BackendSp] = @{ id = $s.BackendSp; appId = $s.BackendClient; appRoleAssignmentRequired = $false }
        $s.ServicePrincipals[$s.FoundrySp] = @{
            id = $s.FoundrySp; appId = '18a66f5f-dbdf-4c17-9dd7-1634712a9cbe'; servicePrincipalNames = @('https://ai.azure.com')
            oauth2PermissionScopes = @(@{ id = '1a7925b5-f871-417a-9b8b-303f9f29fa10'; value = 'user_impersonation'; isEnabled = $true })
        }
        $s.Apps[$cid] = New-TestApp $cid 'triatwin-dev-cockpit' 'cockpit' 'powerbi-client-secret'
        $s.Apps[$bid] = New-TestApp $bid 'triatwin-dev-streaming-backend' 'streaming-backend' 'eventstream-secret'
        $s.Secrets[$cid] = @(@{ name = 'powerbi-client-secret'; value = 'SECRET-POWERBI' }, @{ name = 'kv-other'; keyVaultUrl = 'https://private.vault.azure.net/secrets/other'; identity = 'existing-mi' })
        $s.Secrets[$bid] = @(@{ name = 'eventstream-secret'; value = 'SECRET-EVENTSTREAM' }, @{ name = 'kv-other'; keyVaultUrl = 'https://private.vault.azure.net/secrets/other'; identity = 'existing-mi' })
        foreach ($id in @($cid,$bid)) {
            $s.Auth[$id] = @{
                id = "$id/authConfigs/current"; etag = '"a1"'
                properties = @{
                    platform = @{ enabled = $true }
                    globalValidation = @{ unauthenticatedClientAction = 'Return401'; excludedPaths = @('/health') }
                    login = @{ preserveUrlFragmentsForLogins = $true }
                    identityProviders = @{ azureActiveDirectory = @{
                        enabled = $true
                        registration = @{ clientId = $s.BackendClient; openIdIssuer = "https://login.microsoftonline.com/$($s.Tenant)/v2.0" }
                        validation = @{
                            allowedAudiences = @($s.BackendClient, "api://$($s.BackendClient)")
                            defaultAuthorizationPolicy = @{ allowedApplications = @('workload-one','workload-two'); allowedPrincipals = @{ identities = @('existing-principal') } }
                        }
                    } }
                }
            }
        }
    }
    function Invoke-TestRest([string]$Method, [string]$Uri, $Body, $Headers) {
        $s = $global:AssistantAuthTestState
        $data = if ($Body) { ConvertFrom-Json -AsHashtable -InputObject $Body } else { $null }
        $url = [uri]$Uri
        $path = $url.AbsolutePath
        $s.Calls.Add(@{ Method = $Method; Uri = $Uri; Path = $path; Body = $data; Headers = Copy-TestValue $Headers })
        if ($s.FailPath -and $path -like $s.FailPath -and $Method -eq $s.FailMethod) {
            Throw-TestHttp $s.FailStatus $s.FailCode
        }
        if ($url.Host -eq 'graph.microsoft.com') {
            $path = $path -replace '^/v1.0/', ''
            if ($path -match '^users/([^/]+)$') {
                return @{ id = $Matches[1]; accountEnabled = -not $s.DisabledUser; userType = $s.UserType }
            }
            $collection = ($path -split '/')[0]
            $store = switch ($collection) {
                'applications' { $s.Applications }
                'servicePrincipals' { $s.ServicePrincipals }
                'oauth2PermissionGrants' { $s.Grants }
                default { throw "Unhandled Graph collection $collection" }
            }
            if ($path -eq $collection) {
                if ($Method -eq 'GET') {
                    $filter = [uri]::UnescapeDataString($url.Query)
                    $values = @($store.Values)
                    foreach ($field in @('appId','displayName','clientId','resourceId','consentType','principalId')) {
                        if ($filter -match "$field eq '([^']+)'") {
                            $expected = $Matches[1]
                            $values = @($values | Where-Object { $_[$field] -eq $expected })
                        }
                    }
                    if ($filter -match 'servicePrincipalNames') { $values = @($values | Where-Object { 'https://ai.azure.com' -in $_.servicePrincipalNames }) }
                    if ($s.Ambiguous -and $collection -eq 'applications') { $values += $values }
                    return @{ value = $values }
                }
                if ($Method -eq 'POST') {
                    $id = switch ($collection) { 'applications' { $s.CockpitObject }; 'servicePrincipals' { $s.CockpitSp }; default { [guid]::NewGuid().ToString() } }
                    $data.id = $id
                    if ($collection -eq 'applications') { $data.appId = $s.CockpitClient; $data.passwordCredentials = @(); $data.requiredResourceAccess = @() }
                    $store[$id] = Copy-TestValue $data
                    return $data
                }
            }
            $parts = $path -split '/'
            $id = $parts[1]
            if ($parts.Count -eq 3) {
                switch ($parts[2]) {
                    'addPassword' {
                        $key = '99999999-9999-9999-9999-' + ($s.NextKey++).ToString('000000000000')
                        $credential = @{ keyId = $key; displayName = $data.passwordCredential.displayName; endDateTime = $data.passwordCredential.endDateTime }
                        $store[$id].passwordCredentials = @($store[$id].passwordCredentials) + $credential
                        return $credential + @{ secretText = "SECRET-PASSWORD-$key" }
                    }
                    'removePassword' {
                        $store[$id].passwordCredentials = @($store[$id].passwordCredentials | Where-Object keyId -ne $data.keyId)
                        return $null
                    }
                    'appRoleAssignedTo' {
                        if ($Method -eq 'GET') { return @{ value = @($s.Assignments | Where-Object resourceId -eq $id) } }
                        $s.Assignments += $data
                        return $data
                    }
                    default { throw "Unhandled Graph action $($parts[2])" }
                }
            }
            if (-not $store.ContainsKey($id)) { Throw-TestHttp 404 }
            if ($Method -eq 'GET') {
                if ($s.ConcurrentGraph -and $id -eq $s.BackendObject) {
                    $s.GraphReads++
                    if ($s.GraphReads -eq 2) {
                        $store[$id].requiredResourceAccess += @{ resourceAppId = 'concurrent-resource'; resourceAccess = @(@{ id = 'new-scope'; type = 'Scope' }) }
                    }
                }
                return $store[$id]
            }
            if ($Method -eq 'PATCH') {
                foreach ($key in $data.Keys) { $store[$id][$key] = $data[$key] }
                return $null
            }
        } else {
            if ($path -eq $s.StorageId) {
                if (-not $s.Storage) { Throw-TestHttp 404 }
                return $s.Storage
            }
            if ($path -eq "$($s.StorageId)/blobServices/default/containers/assistant-tokens") {
                if ($Method -eq 'PUT') { $s.Container = @{ id = $path; properties = $data.properties } }
                if (-not $s.Container) { Throw-TestHttp 404 }
                return $s.Container
            }
            if ($path -match '/providers/Microsoft\.Authorization/roleAssignments/([^/]+)$') {
                $name = $Matches[1]
                if ($Method -eq 'GET') {
                    if (-not $s.RoleAssignments.ContainsKey($name)) { Throw-TestHttp 404 }
                    return $s.RoleAssignments[$name]
                }
                if ($Method -eq 'PUT') {
                    $s.RoleAssignments[$name] = @{ id = $path; properties = $data.properties }
                    return $s.RoleAssignments[$name]
                }
            }
            if ($path -match '/providers/Microsoft\.Authorization/roleAssignments$' -and $Method -eq 'GET') {
                $filter = [uri]::UnescapeDataString($url.Query)
                if ($filter -match "principalId eq '([^']+)'") {
                    $wantedPrincipal = $Matches[1]
                    return @{ value = @($s.RoleAssignments.Values | Where-Object { $_.properties.principalId -eq $wantedPrincipal }) }
                }
                return @{ value = @() }
            }
            if ($path -match '^(.*)/listSecrets$') { return @{ value = $s.Secrets[$Matches[1]] } }
            if ($path -match '^(.*)/authConfigs/current$') {
                $id = $Matches[1]
                if ($Method -eq 'PUT') { $s.Auth[$id].properties = $data.properties }
                if (-not $s.Auth.ContainsKey($id)) { Throw-TestHttp 404 }
                return $s.Auth[$id]
            }
            if (-not $s.Apps.ContainsKey($path)) { Throw-TestHttp 404 }
            if ($Method -eq 'GET') {
                if ($s.WrongArmId) { $copy = Copy-TestValue $s.Apps[$path]; $copy.id = '/wrong-resource'; return $copy }
                if ($s.Concurrent -and $path -eq $s.BackendId) {
                    $s.ConcurrentReads++
                    if ($s.ConcurrentReads -eq 3) { $s.Apps[$path].tags.concurrent = 'other-provisioner' }
                }
                return $s.Apps[$path]
            }
            if ($Method -eq 'PATCH') {
                foreach ($key in $data.properties.Keys) { $s.Apps[$path].properties[$key] = $data.properties[$key] }
                $s.Apps[$path].tags = $data.tags
                $s.Secrets[$path] = Copy-TestValue $data.properties.configuration.secrets
                $s.Apps[$path].properties.configuration.secrets = @($data.properties.configuration.secrets | ForEach-Object {
                    if ($_.keyVaultUrl) { $_ } else { @{ name = $_.name } }
                })
                $s.Apps[$path].properties.latestRevisionName = 'accepted-new-revision'
                $s.Apps[$path].properties.latestReadyRevisionName = 'accepted-new-revision'
                if ($s.FailedRevision) { $s.Apps[$path].properties.provisioningState = 'Failed' }
                if ($s.UnexpectedReadback) { $s.Apps[$path].properties.template.containers[0].image = 'unexpected:image' }
                if ($s.AdditionalSecret) { $s.Apps[$path].properties.configuration.secrets += @{ name = 'concurrent-native-secret' } }
                return $s.Apps[$path]
            }
        }
        throw "Unhandled REST operation $Method $path"
    }
    function Get-TestWrites {
        @($global:AssistantAuthTestState.Calls | Where-Object { $_.Method -ne 'GET' -and $_.Path -notlike '*/listSecrets' })
    }
    function Get-SasCliCallCount {
        @($global:AssistantAuthTestState.CliCalls | Where-Object { ($_[0..2] -join ' ') -eq 'storage container generate-sas' }).Count
    }
    function Clear-TestCalls {
        $global:AssistantAuthTestState.Calls.Clear()
        $global:AssistantAuthTestState.CliCalls.Clear()
    }
}

Describe 'Configure delegated assistant authentication (black-box, no live cloud)' {
    BeforeEach {
        Reset-TestState
        Mock az {
            $global:LASTEXITCODE = 0
            $s = $global:AssistantAuthTestState
            $s.CliCalls.Add(@($args))
            if ($args[0] -eq 'account' -and $args[1] -eq 'show') {
                return @{ id = $s.Subscription; tenantId = $s.Tenant } | ConvertTo-Json
            }
            if ($args[0] -eq 'account' -and $args[1] -eq 'get-access-token') {
                $tenant = if ($s.WrongTokenTenant) { 'wrong-tenant' } else { $s.Tenant }
                return @{ accessToken = 'SECRET-ADMIN-ACCESS-TOKEN'; subscription = $s.Subscription; tenant = $tenant } | ConvertTo-Json
            }
            if (($args[0..2] -join ' ') -eq 'deployment group create') {
                if ($s.DeploymentDenied) {
                    $global:LASTEXITCODE = 1
                    return 'RequestDisallowedByPolicy Microsoft.Storage/storageAccounts/allowSharedKeyAccess DO-NOT-LEAK-ERROR-BODY-SECRET'
                }
                Add-TestStorage
                # Mirrors assistant-auth-token-store.bicep's conditional operatorDelegatorAssignment:
                # the deployment itself grants Storage Blob Delegator when operatorPrincipalId is
                # non-empty, under an ARM guid()-derived name distinct from
                # Ensure-OperatorDelegatorRole's own MD5-derived naming (this is the exact scenario
                # that must not collide with RoleAssignmentExists on a fresh account).
                $operatorParam = @($args | Where-Object { $_ -like 'operatorPrincipalId=*' })
                if ($operatorParam.Count -gt 0) {
                    $operatorId = ($operatorParam[0] -split '=', 2)[1]
                    if ($operatorId) {
                        $s.RoleAssignments['bicep-armguid-simulated'] = @{
                            id = "$($s.StorageId)/providers/Microsoft.Authorization/roleAssignments/bicep-armguid-simulated"
                            properties = @{
                                principalId = $operatorId
                                roleDefinitionId = "/subscriptions/$($s.Subscription)/providers/Microsoft.Authorization/roleDefinitions/db58b8e5-c6ad-4a2a-8342-4190687cbf4a"
                                principalType = 'User'
                            }
                        }
                    }
                }
                return ''
            }
            if (($args[0..2] -join ' ') -eq 'storage container generate-sas') {
                if ($s.SasSigningDenied) { $global:LASTEXITCODE = 1; return 'AuthorizationPermissionMismatch DO-NOT-LEAK-ERROR-BODY-SECRET' }
                if ($s.SasSigningTransientFailures -gt 0) {
                    $s.SasSigningTransientFailures--
                    $global:LASTEXITCODE = 1
                    return 'AuthorizationPermissionMismatch DO-NOT-LEAK-ERROR-BODY-SECRET'
                }
                $expiryIndex = [array]::IndexOf($args, '--expiry')
                $expiry = if ($expiryIndex -ge 0) { $args[$expiryIndex + 1] } else { [DateTimeOffset]::UtcNow.AddDays(7).ToString('yyyy-MM-ddTHH:mm:ssZ') }
                # Mirrors a real user-delegation SAS: signed with an Entra delegation key (skoid/
                # sktid/skt/ske/sks/skv), not the account key, and valid whether the account's
                # allowSharedKeyAccess is true or false.
                return "sp=rwd&sr=c&spr=https&se=$([uri]::EscapeDataString($expiry))&sig=SECRET-SAS-SIGNATURE&skoid=test-operator-oid&sktid=$($s.Tenant)&skt=2024-01-01T00%3A00%3A00Z&ske=$([uri]::EscapeDataString($expiry))&sks=b&skv=2023-11-03"
            }
            throw 'Unexpected Azure CLI command; no live command permitted.'
        }
        Mock Invoke-RestMethod {
            $response = Invoke-TestRest $Method $Uri $Body $Headers
            if ($null -ne $response) { return Copy-TestValue $response }
        }
        Mock Start-Sleep { }
    }

    It 'creates dedicated auth, Principal grants, container SAS and safe integration output while preserving workload configuration' {
        $result = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        @($result).Count | Should -Be 1
        $result.SchemaVersion | Should -Be 1
        $result.ConfigurationReady | Should -BeTrue
        $result.UserSignInRequired | Should -BeTrue
        $result.NeedsRenewal | Should -BeFalse
        $result.BackendAuthClientId | Should -Be $s.BackendClient
        $result.CockpitAuthClientId | Should -Be $s.CockpitClient
        $result.FoundryUserPrincipalIds | Should -Be @($script:Parameters.AuthorizedUserObjectIds)
        $result.AuthorizedAthletePrincipalMap.($script:Parameters.AuthorizedUserObjectIds[0]) | Should -Be $script:Parameters.AthleteId
        $result.SecretReferences.CockpitClientSecret | Should -Be 'assistant-easyauth-client-secret'
        $result.SecretReferences.BackendClientSecret | Should -Be 'assistant-obo-client-secret'
        $result.SecretReferences.TokenStoreSas | Should -Be 'assistant-token-store-sas'
        @($s.Grants.Values).Count | Should -Be 2
        @($s.Grants.Values | Where-Object consentType -ne 'Principal').Count | Should -Be 0
        @($s.Grants.Values | Where-Object principalId -ne $script:Parameters.AuthorizedUserObjectIds[0]).Count | Should -Be 0
        @($s.Assignments).Count | Should -Be 1
        $s.ServicePrincipals[$s.CockpitSp].appRoleAssignmentRequired | Should -BeTrue
        $s.Applications[$s.CockpitObject].web.redirectUris | Should -Be @('https://triatwin-dev-cockpit.fictional.westeurope.azurecontainerapps.io/.auth/login/aad/callback')
        $s.Applications[$s.CockpitObject].signInAudience | Should -Be 'AzureADMyOrg'
        $s.Applications[$s.CockpitObject].web.implicitGrantSettings.enableIdTokenIssuance | Should -BeTrue
        $s.Applications[$s.CockpitObject].web.implicitGrantSettings.enableAccessTokenIssuance | Should -BeFalse
        $s.Applications[$s.BackendObject].web.redirectUris.Count | Should -Be 2
        @($s.Applications[$s.BackendObject].requiredResourceAccess | Where-Object resourceAppId -eq 'graph-app').Count | Should -Be 1
        @($s.Applications[$s.BackendObject].passwordCredentials | Where-Object keyId -eq 'unmanaged-key').Count | Should -Be 1
        $auth = $s.Auth[$s.CockpitId].properties
        $auth.login.tokenStore.enabled | Should -BeTrue
        $auth.login.tokenStore.azureBlobStorage.sasUrlSettingName | Should -Be 'assistant-token-store-sas'
        $auth.identityProviders.azureActiveDirectory.login.loginParameters | Should -Be @("scope=openid profile email offline_access api://$($s.BackendClient)/user_impersonation")
        $auth.identityProviders.azureActiveDirectory.registration.clientSecretSettingName | Should -Be 'assistant-easyauth-client-secret'
        $s.Auth[$s.BackendId].properties.identityProviders.azureActiveDirectory.registration.clientId | Should -Be $s.BackendClient
        $s.Auth[$s.BackendId].properties.identityProviders.azureActiveDirectory.validation.allowedAudiences | Should -Be @($s.BackendClient, "api://$($s.BackendClient)")
        $s.Auth[$s.BackendId].properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedApplications | Should -Be @('workload-one','workload-two',$s.CockpitClient)
        $s.Auth[$s.BackendId].properties.identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedPrincipals.identities | Should -Be @('existing-principal',$script:Parameters.AuthorizedUserObjectIds[0])
        $sasCall = @($s.CliCalls | Where-Object { ($_[0..2] -join ' ') -eq 'storage container generate-sas' })[0]
        $sasCall | Should -Contain '--account-name'; $sasCall | Should -Contain $script:Parameters.TokenStoreStorageAccountName
        $sasCall | Should -Contain '--name'; $sasCall | Should -Contain 'assistant-tokens'
        $sasCall | Should -Contain '--permissions'; $sasCall | Should -Contain 'rwd'
        $sasCall | Should -Contain '--https-only'
        $sasCall | Should -Contain '--auth-mode'; $sasCall | Should -Contain 'login'
        $sasCall | Should -Contain '--as-user'
        # Least privilege: signs the SAS with a Microsoft Entra user-delegation key, never the
        # account key, so it works whether or not the account allows shared-key access.
        $sasCall | Should -Not -Contain '--account-key'
        # The Bicep deployment above (assistant-auth-token-store.bicep) already granted Storage
        # Blob Delegator to the operator under its own ARM guid()-derived assignment name.
        # Ensure-OperatorDelegatorRole must recognize that existing grant by principal+role
        # (not by name) and must not attempt a second, conflicting role assignment PUT.
        @($s.RoleAssignments.Keys) | Should -Be @('bicep-armguid-simulated')
        foreach ($id in @($s.CockpitId, $s.BackendId)) {
            $app = $s.Apps[$id]
            $app.properties.template.containers[0].image | Should -Be 'images.azurecr.io/app:original'
            $app.properties.template.containers[1].image | Should -Be 'sidecar:unchanged'
            $app.tags.existing | Should -Be 'preserved'
            @($app.properties.template.containers[0].env | Where-Object name -eq 'AZURE_CLIENT_ID')[0].value | Should -Be 'workload-client-id'
            @($app.properties.template.containers[0].env | Where-Object name -eq 'STREAMING_BACKEND_SCOPE')[0].value | Should -Be "api://$($s.BackendClient)/.default"
            @($s.Secrets[$id] | Where-Object name -eq 'kv-other')[0].keyVaultUrl | Should -Be 'https://private.vault.azure.net/secrets/other'
        }
        @($s.Secrets[$s.CockpitId] | Where-Object name -eq 'powerbi-client-secret')[0].value | Should -Be 'SECRET-POWERBI'
        @($s.Secrets[$s.BackendId] | Where-Object name -eq 'eventstream-secret')[0].value | Should -Be 'SECRET-EVENTSTREAM'
        $map = @($s.Apps[$s.BackendId].properties.template.containers[0].env | Where-Object name -eq 'ATHLETE_PRINCIPAL_MAP')[0].value | ConvertFrom-Json -AsHashtable
        $map.Count | Should -Be 2
        $map['77777777-7777-7777-7777-777777777777'] | Should -Be $script:Parameters.AthleteId
        foreach ($call in $s.CliCalls) {
            $call | Should -Contain '--subscription'
            ($call -join ' ') | Should -Not -Match 'SECRET-|account set|identity show|credential reset|secret set'
        }
        @($s.Calls | Where-Object { $_.Method -eq 'PATCH' -and $_.Path -eq $s.BackendId })[0].Headers['If-Match'] | Should -Be '"v1"'
        ($result | ConvertTo-Json -Depth 10) | Should -Not -Match 'SECRET-|sig=|secretText|accessToken'
    }

    It 'is a zero-write no-op on rerun and CheckOnly verifies stored expiry without renewal' {
        $null = & $script:Configure @script:Parameters
        Clear-TestCalls
        $result = & $script:Configure @script:Parameters
        @(Get-TestWrites).Count | Should -Be 0
        $result.ConfigurationReady | Should -BeTrue
        $result.UserSignInRequired | Should -BeFalse
        $result.NeedsRenewal | Should -BeFalse
        Clear-TestCalls
        $checked = & $script:Configure @script:Parameters -CheckOnly
        @(Get-TestWrites).Count | Should -Be 0
        $checked.ConfigurationReady | Should -BeTrue
        $checked.Expiry.BackendClientSecretExpiresOn | Should -Not -BeNullOrEmpty
        @($global:AssistantAuthTestState.CliCalls | Where-Object { $_[0] -eq 'deployment' }).Count | Should -Be 0
    }

    It 'remains a zero-write no-op after runtime wiring adds a managed identity and settings' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        Mock Invoke-RuntimeArm {
            param($Context, [string]$Method = 'GET', $ResourceId, $Body)
            $state = $global:AssistantAuthTestState
            if ($ResourceId -ne $state.BackendId) { throw 'Unexpected runtime resource; no live calls permitted.' }
            if ($Method -eq 'GET') { return Copy-TestValue $state.Apps[$ResourceId] }
            if ($Method -eq 'PATCH') {
                foreach ($key in $Body.properties.Keys) { $state.Apps[$ResourceId].properties[$key] = Copy-TestValue $Body.properties[$key] }
                return
            }
            throw 'Unexpected runtime operation; no live calls permitted.'
        }
        $backend = $s.Apps[$s.BackendId]
        $mapEntry = @($backend.properties.template.containers[0].env | Where-Object name -eq 'ATHLETE_PRINCIPAL_MAP')[0]
        $runtimeEnv = @{
            ATHLETE_PRINCIPAL_MAP = Merge-RuntimePrincipalMap -ExistingJson $mapEntry.value -Additions @{
                '88888888-8888-8888-8888-888888888888' = $script:Parameters.AthleteId
            }
            FOUNDRY_PROJECT_ENDPOINT = 'https://foundry.example.test/api/projects/athlete-assistant'
        }
        Update-RuntimeAppSetting -Context @{} -App $backend -ContainerName 'streaming-backend' -Environment $runtimeEnv | Should -BeTrue
        1..3 | ForEach-Object {
            Clear-TestCalls
            $result = & $script:Configure @script:Parameters
            @(Get-TestWrites).Count | Should -Be 0
            $result.ConfigurationReady | Should -BeTrue
            $result.UserSignInRequired | Should -BeFalse
            $backend = $s.Apps[$s.BackendId]
            $mapEntry = @($backend.properties.template.containers[0].env | Where-Object name -eq 'ATHLETE_PRINCIPAL_MAP')[0]
            $mapEntry.value | Should -BeExactly $runtimeEnv.ATHLETE_PRINCIPAL_MAP
            Update-RuntimeAppSetting -Context @{} -App $backend -ContainerName 'streaming-backend' -Environment $runtimeEnv | Should -BeFalse
        }
        Should -Invoke Invoke-RuntimeArm -Times 1 -Exactly -ParameterFilter { $Method -eq 'PATCH' }
    }

    It 'preserves existing environment order on unchanged auth reruns' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $expectedNames = @{}
        foreach ($id in @($s.CockpitId, $s.BackendId)) {
            $container = $s.Apps[$id].properties.template.containers[0]
            $container.env = @($container.env | Sort-Object name)
            $expectedNames[$id] = @($container.env.name)
        }
        Clear-TestCalls
        $null = & $script:Configure @script:Parameters
        @(Get-TestWrites).Count | Should -Be 0
        foreach ($id in @($s.CockpitId, $s.BackendId)) {
            @($s.Apps[$id].properties.template.containers[0].env.name) | Should -Be $expectedNames[$id]
        }
    }

    It 'repairs a changed auth setting in place without moving other environment entries' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $container = $s.Apps[$s.CockpitId].properties.template.containers[0]
        $container.env = @($container.env | Sort-Object name)
        $expectedNames = @($container.env.name)
        @($container.env | Where-Object name -eq 'ASSISTANT_AUTH_TENANT_ID')[0].value = 'outdated-tenant'
        Clear-TestCalls
        $null = & $script:Configure @script:Parameters
        $updatedEnv = $s.Apps[$s.CockpitId].properties.template.containers[0].env
        @($updatedEnv.name) | Should -Be $expectedNames
        @($updatedEnv | Where-Object name -eq 'ASSISTANT_AUTH_TENANT_ID')[0].value | Should -Be $script:Parameters.TenantId
        @($s.Calls | Where-Object { $_.Method -eq 'PATCH' -and $_.Path -eq $s.CockpitId }).Count | Should -Be 1
    }

    It 'repairs disabled hybrid ID-token issuance without enabling implicit access tokens' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $s.Applications[$s.CockpitObject].web.implicitGrantSettings.enableIdTokenIssuance = $false
        Clear-TestCalls
        $checked = & $script:Configure @script:Parameters -CheckOnly
        $checked.ConfigurationReady | Should -BeFalse
        @(Get-TestWrites).Count | Should -Be 0
        $null = & $script:Configure @script:Parameters
        $s.Applications[$s.CockpitObject].web.implicitGrantSettings.enableIdTokenIssuance | Should -BeTrue
        $s.Applications[$s.CockpitObject].web.implicitGrantSettings.enableAccessTokenIssuance | Should -BeFalse
    }

    It 'automatically renews near-expiry credentials and SAS and retires only previously installed owned keys' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $oldKeys = @($s.Apps[$s.CockpitId].tags.assistantAuthCredentialKeyId, $s.Apps[$s.BackendId].tags.assistantAuthCredentialKeyId)
        foreach ($app in $s.Applications.Values) {
            foreach ($credential in $app.passwordCredentials) {
                if ($credential.keyId -in $oldKeys) { $credential.endDateTime = [DateTimeOffset]::UtcNow.AddDays(13).ToString('o') }
            }
        }
        $sas = @($s.Secrets[$s.CockpitId] | Where-Object name -eq 'assistant-token-store-sas')[0]
        $sas.value = $sas.value -replace 'se=[^&]+', "se=$([uri]::EscapeDataString([DateTimeOffset]::UtcNow.AddDays(2).ToString('o')))"
        Clear-TestCalls
        $result = & $script:Configure @script:Parameters
        @($s.Calls | Where-Object Path -like '*/addPassword').Count | Should -Be 2
        Get-SasCliCallCount | Should -Be 1
        @($s.Calls | Where-Object Path -like '*/removePassword').Count | Should -Be 2
        foreach ($key in $oldKeys) { @($s.Applications.Values.passwordCredentials | Where-Object keyId -eq $key).Count | Should -Be 0 }
        @($s.Applications[$s.BackendObject].passwordCredentials | Where-Object keyId -eq 'unmanaged-key').Count | Should -Be 1
        $result.NeedsRenewal | Should -BeFalse
        ([DateTimeOffset]::Parse($result.Expiry.BackendClientSecretExpiresOn) - [DateTimeOffset]::UtcNow).TotalDays | Should -BeGreaterThan 179
    }

    It 'forces bounded rotation and retains old credentials while multiple revisions may remain live' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $s.Apps[$s.BackendId].properties.configuration.activeRevisionsMode = 'Multiple'
        Clear-TestCalls
        $result = & $script:Configure @script:Parameters -RotateCredentials -CredentialLifetimeDays 30 -TokenStoreSasLifetimeDays 5 -WarningAction SilentlyContinue
        @($s.Calls | Where-Object Path -like '*/addPassword').Count | Should -Be 2
        @($s.Calls | Where-Object Path -like '*/removePassword').Count | Should -Be 1
        @($s.Applications[$s.BackendObject].passwordCredentials).Count | Should -Be 3
        ([DateTimeOffset]::Parse($result.Expiry.TokenStoreSasExpiresOn) - [DateTimeOffset]::UtcNow).TotalDays | Should -BeGreaterThan 4
        ([DateTimeOffset]::Parse($result.Expiry.TokenStoreSasExpiresOn) - [DateTimeOffset]::UtcNow).TotalDays | Should -BeLessOrEqual 5
    }

    It 'performs no writes for fresh <Mode>, including absent app/token-store resources' -ForEach @(
        @{ Mode = 'WhatIf' }, @{ Mode = 'CheckOnly' }
    ) {
        $flags = @{ $Mode = $true }
        $result = & $script:Configure @script:Parameters @flags
        @(Get-TestWrites).Count | Should -Be 0
        @($global:AssistantAuthTestState.CliCalls | Where-Object { $_[0] -eq 'deployment' }).Count | Should -Be 0
        $result.ConfigurationReady | Should -BeFalse
        $result.NeedsRenewal | Should -BeTrue
        $result.CockpitAuthClientId | Should -BeNullOrEmpty
    }

    It 'reports drift and expiry in CheckOnly without renewing or granting' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        foreach ($credential in $s.Applications[$s.BackendObject].passwordCredentials) { $credential.endDateTime = [DateTimeOffset]::UtcNow.AddDays(1).ToString('o') }
        $s.Grants.Clear()
        Clear-TestCalls
        $result = & $script:Configure @script:Parameters -CheckOnly
        @(Get-TestWrites).Count | Should -Be 0
        $result.ConfigurationReady | Should -BeFalse
        $result.NeedsRenewal | Should -BeTrue
    }

    It 'does not attempt writes under WhatIf even when rotation, grant and auth updates are due' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $s.Grants.Clear()
        $s.Auth[$s.CockpitId].properties.login.tokenStore.enabled = $false
        Clear-TestCalls
        $result = & $script:Configure @script:Parameters -WhatIf -RotateCredentials
        @(Get-TestWrites).Count | Should -Be 0
        $result.ConfigurationReady | Should -BeFalse
    }

    It 'rejects an explicit tenant mismatch before acquiring tokens or writing' {
        $global:AssistantAuthTestState.Tenant = 'wrong-tenant'
        { & $script:Configure @script:Parameters } | Should -Throw '*subscription/tenant*'
        $global:AssistantAuthTestState.Calls.Count | Should -Be 0
        $global:AssistantAuthTestState.CliCalls.Count | Should -Be 1
    }

    It 'rejects a token tenant mismatch before REST access' {
        $global:AssistantAuthTestState.WrongTokenTenant = $true
        { & $script:Configure @script:Parameters } | Should -Throw '*token subscription/tenant*'
        $global:AssistantAuthTestState.Calls.Count | Should -Be 0
    }

    It 'rejects <Case> before any mutation' -ForEach @(
        @{ Case = 'a disabled user'; StateKey = 'DisabledUser'; StateValue = $true; Error = '*enabled Graph human*' }
        @{ Case = 'a non-human principal'; StateKey = 'UserType'; StateValue = 'ServicePrincipal'; Error = '*enabled Graph human*' }
        @{ Case = 'an unexpected ARM resource'; StateKey = 'WrongArmId'; StateValue = $true; Error = '*unexpected resource identity*' }
        @{ Case = 'ambiguous application lookup'; StateKey = 'Ambiguous'; StateValue = $true; Error = '*Ambiguous Graph*' }
    ) {
        $global:AssistantAuthTestState[$StateKey] = $StateValue
        { & $script:Configure @script:Parameters } | Should -Throw $Error
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'requires GUID human IDs and never substitutes the CLI operator' {
        $parameters = $script:Parameters.Clone()
        $parameters.AuthorizedUserObjectIds = @('operator@example.com')
        { & $script:Configure @parameters } | Should -Throw '*explicit human user GUIDs*'
        @(Get-TestWrites).Count | Should -Be 0
        @($global:AssistantAuthTestState.Calls | Where-Object Path -like '*/me*').Count | Should -Be 0
    }

    It 'rejects backend client/audience migration and conflicting human-athlete map before mutation' {
        { & $script:Configure @script:Parameters -BackendAuthClientId 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } | Should -Throw '*conflicts with the live backend*'
        $s = $global:AssistantAuthTestState
        $map = @($s.Apps[$s.BackendId].properties.template.containers[0].env | Where-Object name -eq 'ATHLETE_PRINCIPAL_MAP')[0]
        $map.value = '{"55555555-5555-5555-5555-555555555555":"99999999-9999-9999-9999-999999999999"}'
        { & $script:Configure @script:Parameters } | Should -Throw '*Conflicting athlete mapping*'
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'rejects conflicting human mappings with an equivalent <Representation> GUID before mutation' -ForEach @(
        @{ Representation = 'uppercase'; ExistingKey = 'AABBCCDD-AAAA-BBBB-CCCC-112233445566' }
        @{ Representation = 'braced'; ExistingKey = '{aabbccdd-aaaa-bbbb-cccc-112233445566}' }
    ) {
        $parameters = $script:Parameters.Clone()
        $parameters.AuthorizedUserObjectIds = @('aabbccdd-aaaa-bbbb-cccc-112233445566')
        $s = $global:AssistantAuthTestState
        $map = @($s.Apps[$s.BackendId].properties.template.containers[0].env | Where-Object name -eq 'ATHLETE_PRINCIPAL_MAP')[0]
        $map.value = @{ $ExistingKey = '99999999-9999-9999-9999-999999999999' } | ConvertTo-Json -Compress
        { & $script:Configure @parameters } | Should -Throw '*Conflicting athlete mapping*'
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'canonicalizes matching explicit human aliases while preserving unrelated mappings' {
        $parameters = $script:Parameters.Clone()
        $parameters.AuthorizedUserObjectIds = @('aabbccdd-aaaa-bbbb-cccc-112233445566')
        $s = $global:AssistantAuthTestState
        $map = @($s.Apps[$s.BackendId].properties.template.containers[0].env | Where-Object name -eq 'ATHLETE_PRINCIPAL_MAP')[0]
        $map.value = @"
{
  "AABBCCDD-AAAA-BBBB-CCCC-112233445566": "$($parameters.AthleteId)",
  "aabbccdd-aaaa-bbbb-cccc-112233445566": "$($parameters.AthleteId)",
  "77777777-7777-7777-7777-777777777777": "$($parameters.AthleteId)"
}
"@
        $null = & $script:Configure @parameters
        $merged = @($s.Apps[$s.BackendId].properties.template.containers[0].env | Where-Object name -eq 'ATHLETE_PRINCIPAL_MAP')[0].value |
            ConvertFrom-Json -AsHashtable
        $merged.Count | Should -Be 2
        $merged.Contains('AABBCCDD-AAAA-BBBB-CCCC-112233445566') | Should -BeFalse
        $merged['aabbccdd-aaaa-bbbb-cccc-112233445566'] | Should -Be $parameters.AthleteId
        $merged['77777777-7777-7777-7777-777777777777'] | Should -Be $parameters.AthleteId
        Clear-TestCalls
        $null = & $script:Configure @parameters
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'rejects conflicting case-variant duplicates even when the canonical key matches' {
        $parameters = $script:Parameters.Clone()
        $parameters.AuthorizedUserObjectIds = @('aabbccdd-aaaa-bbbb-cccc-112233445566')
        $s = $global:AssistantAuthTestState
        $map = @($s.Apps[$s.BackendId].properties.template.containers[0].env | Where-Object name -eq 'ATHLETE_PRINCIPAL_MAP')[0]
        $map.value = @"
{
  "AABBCCDD-AAAA-BBBB-CCCC-112233445566": "99999999-9999-9999-9999-999999999999",
  "aabbccdd-aaaa-bbbb-cccc-112233445566": "$($parameters.AthleteId)"
}
"@
        { & $script:Configure @parameters } | Should -Throw '*Conflicting athlete mapping*'
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'preserves unrelated permission entries and per-user grant scopes and ignores AllPrincipals grants' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $s.Grants['tenant-wide-existing'] = @{ id = 'tenant-wide-existing'; clientId = $s.CockpitSp; resourceId = $s.BackendSp; consentType = 'AllPrincipals'; scope = 'other' }
        $s.Grants['unrelated-human'] = @{ id = 'unrelated-human'; clientId = $s.CockpitSp; resourceId = $s.BackendSp; consentType = 'Principal'; principalId = 'other-human'; scope = 'other' }
        foreach ($grant in $s.Grants.Values) {
            if ($grant.principalId -eq $script:Parameters.AuthorizedUserObjectIds[0]) { $grant.scope = 'existing_scope' }
        }
        $resource = @($s.Applications[$s.BackendObject].requiredResourceAccess | Where-Object resourceAppId -eq '18a66f5f-dbdf-4c17-9dd7-1634712a9cbe')[0]
        $resource.resourceAccess = @(@{ id = 'other-delegated-scope'; type = 'Scope' })
        Clear-TestCalls
        $null = & $script:Configure @script:Parameters
        @($s.Grants.Values | Where-Object scope -eq 'existing_scope user_impersonation').Count | Should -Be 2
        $s.Grants['tenant-wide-existing'].scope | Should -Be 'other'
        $s.Grants['unrelated-human'].scope | Should -Be 'other'
        @($s.Applications[$s.BackendObject].requiredResourceAccess | Where-Object resourceAppId -eq '18a66f5f-dbdf-4c17-9dd7-1634712a9cbe')[0].resourceAccess.Count | Should -Be 2
        @($s.Calls | Where-Object { $_.Body.consentType -eq 'AllPrincipals' }).Count | Should -Be 0
    }

    It 'configures only explicitly supplied multiple humans and preserves existing identities' {
        $parameters = $script:Parameters.Clone()
        $parameters.AuthorizedUserObjectIds += '88888888-8888-8888-8888-888888888888'
        $result = & $script:Configure @parameters
        $result.FoundryUserPrincipalIds.Count | Should -Be 2
        @($global:AssistantAuthTestState.Grants.Values).Count | Should -Be 4
        @($global:AssistantAuthTestState.Assignments).Count | Should -Be 2
    }

    It 'fails closed on storage <Constraint> without policy/network changes' -ForEach @(
        @{ Constraint = 'private-only endpoint'; Property = 'publicNetworkAccess'; Value = 'Disabled'; Error = '*publicNetworkAccess must be Enabled*' }
        @{ Constraint = 'network ACL'; Property = 'networkAcls'; Value = @{ defaultAction = 'Deny' }; Error = '*networkAcls.defaultAction must be Allow*' }
        @{ Constraint = 'anonymous blobs'; Property = 'allowBlobPublicAccess'; Value = $true; Error = '*allowBlobPublicAccess=false*' }
    ) {
        Add-TestStorage
        $global:AssistantAuthTestState.Storage.properties[$Property] = $Value
        { & $script:Configure @script:Parameters } | Should -Throw $Error
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'retains previous credentials on <Failure> and never returns the raw error body' -ForEach @(
        @{ Failure = 'secret installation failure'; FailPath = '*/containerApps/triatwin-dev-streaming-backend'; FailMethod = 'PATCH' }
        @{ Failure = 'auth configuration failure'; FailPath = '*/triatwin-dev-cockpit/authConfigs/current'; FailMethod = 'PUT' }
    ) {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $oldKeys = @($s.Apps[$s.CockpitId].tags.assistantAuthCredentialKeyId, $s.Apps[$s.BackendId].tags.assistantAuthCredentialKeyId)
        $s.FailPath = $FailPath; $s.FailMethod = $FailMethod
        if ($FailMethod -eq 'PUT') { $s.Auth[$s.CockpitId].properties.login.tokenStore.enabled = $false }
        Clear-TestCalls
        $caught = $null
        try { $null = & $script:Configure @script:Parameters -RotateCredentials } catch { $caught = $_ }
        $caught | Should -Not -BeNullOrEmpty
        $caught.Exception.Message | Should -Match 'HTTP 403'
        $caught.Exception.Message | Should -Not -Match 'DO-NOT-LEAK|SECRET-'
        @($s.Calls | Where-Object Path -like '*/removePassword').Count | Should -Be 0
        foreach ($key in $oldKeys) { @($s.Applications.Values.passwordCredentials | Where-Object keyId -eq $key).Count | Should -Be 1 }
    }

    It 'fails on concurrent ACA mutation before overwriting sibling configuration' {
        $global:AssistantAuthTestState.Concurrent = $true
        { & $script:Configure @script:Parameters } | Should -Throw '*Concurrent Container App change*'
        @($global:AssistantAuthTestState.Calls | Where-Object { $_.Method -eq 'PATCH' -and $_.Path -eq $global:AssistantAuthTestState.BackendId }).Count | Should -Be 0
        @($global:AssistantAuthTestState.Calls | Where-Object Path -like '*/removePassword').Count | Should -Be 0
    }

    It 'retains old credentials on unexpected revision readback or failure' -ForEach @(
        @{ Flag = 'UnexpectedReadback'; Error = '*Unexpected Container App readback mutation*' }
        @{ Flag = 'FailedRevision'; Error = '*Container App revision failed*' }
    ) {
        $null = & $script:Configure @script:Parameters
        $global:AssistantAuthTestState[$Flag] = $true
        Clear-TestCalls
        { & $script:Configure @script:Parameters -RotateCredentials } | Should -Throw $Error
        @($global:AssistantAuthTestState.Calls | Where-Object Path -like '*/removePassword').Count | Should -Be 0
    }

    It 'does not emit secrets to any output stream even with verbose logging enabled' {
        $output = & $script:Configure @script:Parameters -Verbose *>&1
        ($output | Out-String) | Should -Not -Match 'SECRET-|sig=|secretText|accessToken|DO-NOT-LEAK'
        $cli = $global:AssistantAuthTestState.CliCalls | ConvertTo-Json -Depth 10
        $cli | Should -Not -Match 'SECRET-|sig=|secretText|accessToken'
    }

    It 'plans all work without writes when base Container Apps are not deployed yet' {
        $global:AssistantAuthTestState.Apps.Clear()
        $result = & $script:Configure @script:Parameters -WhatIf
        $result.ConfigurationReady | Should -BeFalse
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'renews a missing installed secret without deleting any unmanaged credential' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $s.Secrets[$s.BackendId] = @($s.Secrets[$s.BackendId] | Where-Object name -ne 'assistant-obo-client-secret')
        $s.Apps[$s.BackendId].properties.configuration.secrets = @($s.Apps[$s.BackendId].properties.configuration.secrets | Where-Object name -ne 'assistant-obo-client-secret')
        Clear-TestCalls
        $result = & $script:Configure @script:Parameters
        @($s.Calls | Where-Object Path -like '*/addPassword').Count | Should -Be 1
        Get-SasCliCallCount | Should -Be 0
        @($s.Applications[$s.BackendObject].passwordCredentials | Where-Object keyId -eq 'unmanaged-key').Count | Should -Be 1
        $result.ConfigurationReady | Should -BeTrue
    }

    It 'replaces an incorrectly scoped SAS without rotating healthy app credentials' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $sas = @($s.Secrets[$s.CockpitId] | Where-Object name -eq 'assistant-token-store-sas')[0]
        $sas.value = $sas.value -replace 'sp=rwd', 'sp=rwdl'
        Clear-TestCalls
        $result = & $script:Configure @script:Parameters
        @($s.Calls | Where-Object Path -like '*/addPassword').Count | Should -Be 0
        Get-SasCliCallCount | Should -Be 1
        $result.NeedsRenewal | Should -BeFalse
    }

    It 'rejects takeover of an unowned cockpit application or storage account' {
        $null = & $script:Configure @script:Parameters
        $s = $global:AssistantAuthTestState
        $s.Applications[$s.CockpitObject].tags = @('somebody-else')
        Clear-TestCalls
        { & $script:Configure @script:Parameters } | Should -Throw '*unowned/shared application*'
        @(Get-TestWrites).Count | Should -Be 0
        $s.Storage.tags.assistantAuthOwner = 'another-owner'
        { & $script:Configure @script:Parameters } | Should -Throw '*not owned by this cockpit*'
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'fails rather than overwriting a concurrent Graph permission change' {
        $global:AssistantAuthTestState.ConcurrentGraph = $true
        { & $script:Configure @script:Parameters } | Should -Throw '*Concurrent Graph change*'
        $s = $global:AssistantAuthTestState
        @($s.Calls | Where-Object { $_.Method -eq 'PATCH' -and $_.Path -eq "/v1.0/applications/$($s.BackendObject)" }).Count | Should -Be 0
        @($s.Applications[$s.BackendObject].requiredResourceAccess | Where-Object resourceAppId -eq 'concurrent-resource').Count | Should -Be 1
    }

    It 'detects a concurrently added secret in revision readback' {
        $global:AssistantAuthTestState.AdditionalSecret = $true
        { & $script:Configure @script:Parameters } | Should -Throw '*Unexpected Container App readback mutation*secret names*'
        @($global:AssistantAuthTestState.Calls | Where-Object Path -like '*/removePassword').Count | Should -Be 0
    }

    It 'reports the storage policy constraint without printing CLI errors or bypassing policy' {
        $global:AssistantAuthTestState.DeploymentDenied = $true
        $errorMessage = $null
        try { $null = & $script:Configure @script:Parameters } catch { $errorMessage = $_.Exception.Message }
        $errorMessage | Should -Match 'RequestDisallowedByPolicy'
        $errorMessage | Should -Match 'Microsoft.Storage/storageAccounts/allowSharedKeyAccess'
        $errorMessage | Should -Not -Match 'DO-NOT-LEAK|SECRET-'
        @($global:AssistantAuthTestState.Calls | Where-Object Path -like '*/addPassword').Count | Should -Be 0
    }

    It 'honors an existing blocking SAS lifetime policy instead of signing an unusable SAS' {
        Add-TestStorage
        $global:AssistantAuthTestState.Storage.properties.sasPolicy = @{ sasExpirationPeriod = '3.00:00:00'; expirationAction = 'Block' }
        { & $script:Configure @script:Parameters } | Should -Throw '*sasPolicy.sasExpirationPeriod=3.00:00:00*'
        @(Get-TestWrites).Count | Should -Be 0
    }

    It 'retries user-delegation SAS signing while a fresh RBAC role assignment propagates' {
        $global:AssistantAuthTestState.SasSigningTransientFailures = 2
        $result = & $script:Configure @script:Parameters
        Get-SasCliCallCount | Should -Be 3
        $result.NeedsRenewal | Should -BeFalse
        Should -Invoke Start-Sleep -Times 2 -Exactly
    }

    It 'fails after exhausting SAS signing retries without leaking the CLI error body' {
        $global:AssistantAuthTestState.SasSigningDenied = $true
        $errorMessage = $null
        try { $null = & $script:Configure @script:Parameters } catch { $errorMessage = $_.Exception.Message }
        $s = $global:AssistantAuthTestState
        Get-SasCliCallCount | Should -Be 6
        Should -Invoke Start-Sleep -Times 5 -Exactly
        $errorMessage | Should -Not -Match 'DO-NOT-LEAK|AuthorizationPermissionMismatch'
        @($s.Calls | Where-Object { $_.Method -eq 'PUT' -and $_.Path -like '*/authConfigs/current' }).Count | Should -Be 0
        @($s.Calls | Where-Object Path -like '*/removePassword').Count | Should -Be 0
    }

    It 'resolves downstream service identity and scope values rather than relying on hardcoded GUIDs' {
        $s = $global:AssistantAuthTestState
        $s.ServicePrincipals[$s.FoundrySp].appId = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
        $s.ServicePrincipals[$s.FoundrySp].oauth2PermissionScopes[0].id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
        $null = & $script:Configure @script:Parameters
        $entry = @($s.Applications[$s.BackendObject].requiredResourceAccess | Where-Object resourceAppId -eq 'ffffffff-ffff-ffff-ffff-ffffffffffff')
        $entry.Count | Should -Be 1
        $entry[0].resourceAccess[0].id | Should -Be 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    }

    It 'does not install credentials before a grant failure and sanitizes Graph permission errors' {
        $s = $global:AssistantAuthTestState
        $s.FailPath = '*/oauth2PermissionGrants'; $s.FailMethod = 'POST'
        $errorMessage = $null
        try { $null = & $script:Configure @script:Parameters } catch { $errorMessage = $_.Exception.Message }
        $errorMessage | Should -Match 'DelegatedPermissionGrant.ReadWrite.All'
        $errorMessage | Should -Not -Match 'DO-NOT-LEAK|SECRET-'
        @($s.Calls | Where-Object Path -like '*/addPassword').Count | Should -Be 0
    }

    It 'rejects out-of-policy lifetime bounds before contacting Azure' {
        { & $script:Configure @script:Parameters -CredentialLifetimeDays 181 } | Should -Throw
        { & $script:Configure @script:Parameters -TokenStoreSasLifetimeDays 8 } | Should -Throw
        { & $script:Configure @script:Parameters -TokenStoreSasLifetimeDays 0 } | Should -Throw
        $global:AssistantAuthTestState.CliCalls.Count | Should -Be 0
    }
}

AfterAll { Remove-Variable AssistantAuthTestState -Scope Global -ErrorAction SilentlyContinue }
