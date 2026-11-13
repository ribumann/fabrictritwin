#Requires -Version 7.0
BeforeAll {
    $script:Bootstrap = Join-Path $PSScriptRoot '..' '..' 'scripts' 'deploy' 'bootstrap-mining-state.ps1'
    $script:Parameters = @{
        SubscriptionId = '11111111-1111-1111-1111-111111111111'
        TenantId = '22222222-2222-2222-2222-222222222222'
        CallerClientId = '33333333-3333-3333-3333-333333333333'
        CallerPrincipalId = '44444444-4444-4444-4444-444444444444'
        ResourceGroupName = 'rg-example'; StorageAccountName = 'examplestate'
        ContainerName = 'mining-private'; BackendAppName = 'example-streaming-backend'; IdentityName = 'example-backend'
        IdentityClientId = '55555555-5555-5555-5555-555555555555'
        IdentityPrincipalId = '66666666-6666-6666-6666-666666666666'
        SourceRevision = 'a' * 40
    }
    function New-MiningFixture {
        $rg = "/subscriptions/$($script:Parameters.SubscriptionId)/resourceGroups/rg-example"
        $storage = "$rg/providers/Microsoft.Storage/storageAccounts/examplestate"
        $identity = "$rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/example-backend"
        $app = "$rg/providers/Microsoft.App/containerApps/example-streaming-backend"
        @{
            Parameters = $script:Parameters
            StorageId = $storage; ContainerId = "$storage/blobServices/default/containers/mining-private"
            Account = @{
                id = $storage; kind = 'StorageV2'; etag = 'account-v1'
                properties = @{
                    provisioningState = 'Succeeded'; allowSharedKeyAccess = $false; allowBlobPublicAccess = $false
                    primaryEndpoints = @{ blob = 'https://examplestate.blob.core.windows.net/' }
                }
            }
            App = @{
                id = $app; properties = @{ provisioningState = 'Succeeded'; template = @{ secretReference = 'private-never-print' } }
                identity = @{ userAssignedIdentities = @{ $identity = @{
                    clientId = $script:Parameters.IdentityClientId; principalId = $script:Parameters.IdentityPrincipalId
                } } }
            }
            Identity = @{ id = $identity; properties = @{
                tenantId = $script:Parameters.TenantId; clientId = $script:Parameters.IdentityClientId
                principalId = $script:Parameters.IdentityPrincipalId
            } }
            Claims = @{
                tid = $script:Parameters.TenantId; oid = $script:Parameters.CallerPrincipalId
                appid = $script:Parameters.CallerClientId; idtyp = 'app'
            }
            Container = $null; Roles = @(); Reads = 0; BlobStatus = 0; RoleFailure = $false; BlobFailure = $false
            DriftAt = 0; Denied = $false; Conflict = $false; MissingRole = $false; Collision = $false
        }
    }
    function New-Role {
        param([string]$Name = '77777777-7777-7777-7777-777777777777')
        @{
            id = "$($global:MiningFixture.ContainerId)/providers/Microsoft.Authorization/roleAssignments/$Name"; name = $Name
            properties = @{
                scope = $global:MiningFixture.ContainerId; principalId = $script:Parameters.IdentityPrincipalId
                principalType = 'ServicePrincipal'
                roleDefinitionId = "/subscriptions/$($script:Parameters.SubscriptionId)/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe"
            }
        }
    }
}

Describe 'Protected mining-state bootstrap' {
    BeforeEach {
        $script:OriginalWorkflowEnvironment = @{}
        $workflowEnvironment = @{
            GITHUB_ACTIONS = 'true'; GITHUB_REPOSITORY = 'ribumann/fabrictritwin'; GITHUB_REF = 'refs/heads/main'
            GITHUB_SHA = $script:Parameters.SourceRevision; GITHUB_RUN_ATTEMPT = '1'
            GITHUB_WORKFLOW_REF = 'ribumann/fabrictritwin/.github/workflows/bootstrap-mining-state.yml@refs/heads/main'
        }
        foreach ($name in $workflowEnvironment.Keys) {
            $script:OriginalWorkflowEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
            [Environment]::SetEnvironmentVariable($name, $workflowEnvironment[$name])
        }
        $global:MiningFixture = New-MiningFixture
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -contains 'show') {
                return @{ id = $global:MiningFixture.Parameters.SubscriptionId; tenantId = $global:MiningFixture.Parameters.TenantId } | ConvertTo-Json
            }
            $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
                ($global:MiningFixture.Claims | ConvertTo-Json -Compress))).TrimEnd('=').Replace('+','-').Replace('/','_')
            @{ accessToken = "header.$payload.signature"; tenant = $global:MiningFixture.Parameters.TenantId } | ConvertTo-Json
        }
        Mock Invoke-WebRequest {
            param($Method, $Uri, $Headers, $Body)
            $f = $global:MiningFixture
            if ($Uri -like 'https://examplestate.blob.core.windows.net/*') {
                if ($Method -eq 'HEAD') {
                    if ($f.BlobStatus) { return @{ StatusCode = $f.BlobStatus; Headers = @{} } }
                    if ($f.Container) { return @{ StatusCode = 200; Headers = @{ ETag = '"container-v1"' } } }
                    return @{ StatusCode = 404; Headers = @{ 'x-ms-error-code' = 'ContainerNotFound' } }
                }
                if ($f.BlobFailure) { throw 'private transport details' }
                if ($f.Conflict) { return @{ StatusCode = 409; Headers = @{} } }
                $f.Container = @{ id = $f.ContainerId; properties = @{ publicAccess = 'None' } }
                return @{ StatusCode = 201; Headers = @{} }
            }
            if ($f.Denied) { return @{ StatusCode = 403; Content = '{"error":"private denied details"}' } }
            $id = ([uri]$Uri).AbsolutePath
            $resource = $null
            if ($id -eq $f.StorageId) {
                $f.Reads++
                if ($f.DriftAt -eq $f.Reads) { $f.Account.etag = 'concurrent-account-change' }
                $resource = $f.Account
            } elseif ($id -eq $f.App.id) { $resource = $f.App }
            elseif ($id -eq $f.Identity.id) { $resource = $f.Identity }
            elseif ($id -eq $f.ContainerId) { $resource = $f.Container }
            elseif ($id -eq "$($f.ContainerId)/providers/Microsoft.Authorization/roleAssignments") { $resource = @{ value = @($f.Roles) } }
            elseif ($id -like "$($f.ContainerId)/providers/Microsoft.Authorization/roleAssignments/*") {
                if ($Method -eq 'PUT') {
                    if ($f.RoleFailure) { throw 'private write details' }
                    if ($f.MissingRole) { return @{ StatusCode = 202; Content = '{}' } }
                    $role = @{ id = $id; name = $id.Split('/')[-1]; properties = ($Body | ConvertFrom-Json -AsHashtable).properties }
                    $role.properties.scope = $f.ContainerId
                    $f.Roles += $role
                    $resource = $role
                } else {
                    $resource = @($f.Roles | Where-Object { $_.id -eq $id }) | Select-Object -First 1
                    if ($f.Collision) {
                        $resource = @{ id = $id; name = $id.Split('/')[-1]; properties = @{ principalId = 'wrong' } }
                    }
                }
            } else { throw 'Unexpected request target in test.' }
            if ($null -eq $resource) { return @{ StatusCode = 404; Content = '{}' } }
            return @{ StatusCode = 200; Content = (ConvertTo-Json -InputObject $resource -Depth 100) }
        }
    }

    It 'previews without writes and emits no private target/configuration values' {
        $result = & $script:Bootstrap @script:Parameters
        $result.Status | Should -Be 'Preview'
        $result.Digest | Should -Match '^[a-f0-9]{64}$'
        $result.Overlay | Should -Be 'Deferred'
        ($result | ConvertTo-Json) | Should -Not -Match 'examplestate|private-never-print|66666666|rg-example'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -notin @('GET','HEAD') }
    }

    It 'creates only the private container and deterministic container-level UAMI role' {
        $digest = (& $script:Bootstrap @script:Parameters).Digest
        $result = & $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $digest
        $result.Status | Should -Be 'BootstrapVerified'
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'PUT' -and $Uri -eq 'https://examplestate.blob.core.windows.net/mining-private?restype=container' -and
            -not $Headers.ContainsKey('x-ms-blob-public-access') -and -not $Body
        }
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'PUT' -and $Uri -match '/containers/mining-private/providers/Microsoft.Authorization/roleAssignments/[a-f0-9-]{36}\?' -and
            $Body -match '"principalType":"ServicePrincipal"'
        }
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter {
            $Method -notin @('GET','HEAD') -and $Uri -notmatch '/mining-private'
        }
        $next = (& $script:Bootstrap @script:Parameters).Digest
        (& $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $next).Status | Should -Be 'BootstrapVerified'
        Should -Invoke Invoke-WebRequest -Times 2 -Exactly -ParameterFilter { $Method -eq 'PUT' }
    }

    It 'preserves an existing private container and matching non-deterministic role without rewriting' {
        $global:MiningFixture.Container = @{ id = $global:MiningFixture.ContainerId; properties = @{ publicAccess = 'None'; metadata = @{ ownedElsewhere = 'retain' } } }
        $global:MiningFixture.Roles = @(New-Role)
        $digest = (& $script:Bootstrap @script:Parameters).Digest
        (& $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $digest).Status | Should -Be 'BootstrapVerified'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -notin @('GET','HEAD') }
    }

    It 'never writes with WhatIf even when apply is requested' {
        (& $script:Bootstrap @script:Parameters -Apply -ApprovedDigest ('b' * 64) -WhatIf).Status | Should -Be 'Preview'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -notin @('GET','HEAD') }
    }

    It 'rejects local or wrong-ref apply before acquiring credentials' -ForEach @(
        @{ Name = 'GITHUB_ACTIONS'; Value = 'false' }, @{ Name = 'GITHUB_REF'; Value = 'refs/heads/feature' },
        @{ Name = 'GITHUB_RUN_ATTEMPT'; Value = '2' }, @{ Name = 'GITHUB_WORKFLOW_REF'; Value = 'different-workflow' }
    ) {
        [Environment]::SetEnvironmentVariable($Name, $Value)
        { & $script:Bootstrap @script:Parameters -Apply -ApprovedDigest ('b' * 64) } | Should -Throw '*protected main workflow*'
        Should -Invoke az -Times 0 -Exactly
    }

    It 'rejects changed source, protected target or state against the approved digest' -ForEach @(
        @{ Change = 'source' }, @{ Change = 'state' }, @{ Change = 'principal' }
    ) {
        $digest = (& $script:Bootstrap @script:Parameters).Digest
        $parameters = $script:Parameters.Clone()
        switch ($Change) {
            source { $parameters.SourceRevision = 'b' * 40 }
            state { $global:MiningFixture.Account.etag = 'new-version' }
            principal { $parameters.IdentityPrincipalId = '88888888-8888-8888-8888-888888888888' }
        }
        { & $script:Bootstrap @parameters -Apply -ApprovedDigest $digest } | Should -Throw
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -notin @('GET','HEAD') }
    }

    It 'rejects invalid policies, unattached identities, private-state mismatch and foreign callers' -ForEach @(
        @{ Change = 'public' }, @{ Change = 'sharedKey' }, @{ Change = 'endpoint' }, @{ Change = 'identity' },
        @{ Change = 'tenant' }, @{ Change = 'caller' }, @{ Change = 'conditionalRole' }, @{ Change = 'container' },
        @{ Change = 'network' }, @{ Change = 'denied' }, @{ Change = 'collision' }, @{ Change = 'delegated' }
    ) {
        $f = $global:MiningFixture
        switch ($Change) {
            public { $f.Account.properties.allowBlobPublicAccess = $true }
            sharedKey { $f.Account.properties.allowSharedKeyAccess = $true }
            endpoint { $f.Account.properties.primaryEndpoints.blob = 'https://foreign.invalid/' }
            identity { $f.App.identity.userAssignedIdentities = @{} }
            tenant { $f.Identity.properties.tenantId = '88888888-8888-8888-8888-888888888888' }
            caller { $f.Claims.oid = '88888888-8888-8888-8888-888888888888' }
            conditionalRole { $role = New-Role; $role.properties.condition = 'restricted'; $f.Roles = @($role) }
            container { $f.Container = @{ id = $f.ContainerId; properties = @{ publicAccess = 'Blob' } } }
            network { $f.BlobStatus = 403 }
            denied { $f.Denied = $true }
            collision { $f.Collision = $true }
            delegated { $f.Claims.scp = 'user_impersonation' }
        }
        { & $script:Bootstrap @script:Parameters } | Should -Throw
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -notin @('GET','HEAD') }
    }

    It 'stops on fresh drift before any write' {
        $digest = (& $script:Bootstrap @script:Parameters).Digest
        $global:MiningFixture.Reads = 0; $global:MiningFixture.DriftAt = 2
        { & $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $digest } | Should -Throw '*drifted*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'PUT' }
    }

    It 'stops at the non-atomic boundary without granting a role after unexpected drift' {
        $digest = (& $script:Bootstrap @script:Parameters).Digest
        $global:MiningFixture.Reads = 0; $global:MiningFixture.DriftAt = 3
        { & $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $digest } | Should -Throw '*partial outcome*'
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PUT' }
    }

    It 'does not retry unknown writes or roll back partial outcomes' -ForEach @(
        @{ Failure = 'BlobFailure'; Writes = 1 }, @{ Failure = 'RoleFailure'; Writes = 2 }
    ) {
        $digest = (& $script:Bootstrap @script:Parameters).Digest
        $global:MiningFixture[$Failure] = $true
        { & $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $digest } | Should -Throw '*unknown*'
        Should -Invoke Invoke-WebRequest -Times $Writes -Exactly -ParameterFilter { $Method -eq 'PUT' }
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -in @('DELETE','PATCH','POST') }
    }

    It 'stops on a create race without overwriting or assigning a role' {
        $digest = (& $script:Bootstrap @script:Parameters).Digest
        $global:MiningFixture.Conflict = $true
        { & $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $digest } | Should -Throw '*HTTP 409*'
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'PUT' }
    }

    It 'does not report an accepted but unverified role as success' {
        $digest = (& $script:Bootstrap @script:Parameters).Digest
        $global:MiningFixture.MissingRole = $true
        { & $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $digest } | Should -Throw '*not verified*'
        Should -Invoke Invoke-WebRequest -Times 2 -Exactly -ParameterFilter { $Method -eq 'PUT' }
    }

    It 'binds a locally exported private plan to the digest and refuses overwrites' {
        $original = $env:GITHUB_ACTIONS
        try {
            $env:GITHUB_ACTIONS = 'false'
            $path = Join-Path $TestDrive 'private-plan.json'
            $result = & $script:Bootstrap @script:Parameters -PrivatePlanPath $path
            (Get-Content $path -Raw | ConvertFrom-Json).digest | Should -BeExactly $result.Digest
            { & $script:Bootstrap @script:Parameters -PrivatePlanPath $path } | Should -Throw
            { & $script:Bootstrap @script:Parameters -Apply -ApprovedDigest $result.Digest -PrivatePlanPath $path } | Should -Throw '*local preview only*'
            $env:GITHUB_ACTIONS = 'true'
            { & $script:Bootstrap @script:Parameters -PrivatePlanPath (Join-Path $TestDrive 'actions-plan.json') } | Should -Throw '*local preview only*'
            Test-Path (Join-Path $TestDrive 'actions-plan.json') | Should -BeFalse
        } finally { $env:GITHUB_ACTIONS = $original }
    }

    It 'allows only an explicitly pinned local service-principal reader for independent private review' {
        $original = $env:GITHUB_ACTIONS
        try {
            $env:GITHUB_ACTIONS = 'false'
            $digest = (& $script:Bootstrap @script:Parameters).Digest
            $reader = @{
                PrivateReviewReaderClientId = '88888888-8888-8888-8888-888888888888'
                PrivateReviewReaderPrincipalId = '99999999-9999-9999-9999-999999999999'
            }
            $global:MiningFixture.Claims.appid = $reader.PrivateReviewReaderClientId
            $global:MiningFixture.Claims.oid = $reader.PrivateReviewReaderPrincipalId
            $path = Join-Path $TestDrive 'reader-review.json'
            (& $script:Bootstrap @script:Parameters @reader -PrivatePlanPath $path).Digest | Should -BeExactly $digest
            $private = Get-Content $path -Raw | ConvertFrom-Json
            $private.reviewReader.principalId | Should -Be $reader.PrivateReviewReaderPrincipalId
            $private.plan.caller.principalId | Should -Be $script:Parameters.CallerPrincipalId
            { & $script:Bootstrap @script:Parameters @reader -Apply -ApprovedDigest $digest } | Should -Throw
            { & $script:Bootstrap @script:Parameters -PrivatePlanPath (Join-Path $TestDrive 'wrong-reader.json') } | Should -Throw '*approved deployment caller*'
            Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -notin @('GET','HEAD') }
        } finally { $env:GITHUB_ACTIONS = $original }
    }

    AfterEach {
        foreach ($name in $script:OriginalWorkflowEnvironment.Keys) {
            [Environment]::SetEnvironmentVariable($name, $script:OriginalWorkflowEnvironment[$name])
        }
    }
    AfterAll { Remove-Variable MiningFixture -Scope Global }
}

Describe 'Mining bootstrap workflow boundary' {
    BeforeAll {
        $script:Workflow = Get-Content (Join-Path $PSScriptRoot '..' '..' '.github' 'workflows' 'bootstrap-mining-state.yml') -Raw
    }
    It 'uses a manual, main-only protected OIDC job and no public plan artifacts' {
        $script:Workflow | Should -Match "github.repository == 'ribumann/fabrictritwin' && github.ref == 'refs/heads/main'"
        $script:Workflow | Should -Match 'environment: azure-deploy'
        $script:Workflow | Should -Match 'default: false'
        $script:Workflow | Should -Match 'MINING_STATE_APPROVED_DIGEST'
        $script:Workflow | Should -Match 'MINING_STATE_BOOTSTRAP_ENABLED'
        $script:Workflow | Should -Match 'claims.workflow_ref'
        $script:Workflow | Should -Match 'claims.actor_id'
        $script:Workflow | Should -Not -Match 'upload-artifact|PrivatePlanPath|secrets\.|deploy-container-apps|--set-env-vars'
        $script:Workflow | Should -Not -Match '(?m)^\s+(push|pull_request|pull_request_target|schedule|workflow_run):'
        foreach ($block in [regex]::Matches($script:Workflow, '(?ms)^        run: \|\r?\n(.*?)(?=^      -|\z)')) {
            $block.Groups[1].Value | Should -Not -Match '\$\{\{'
        }
    }
}
