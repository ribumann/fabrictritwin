#Requires -Version 7.0
<#
.SYNOPSIS
Pester tests for scripts/provision/provision-azure-resources.ps1 (T038).

.DESCRIPTION
Invokes the real top-level provisioning script as a black box while mocking the Azure CLI and
Microsoft Graph cmdlets it depends on, including the nested
provision-entra-app-registrations.ps1 call.
#>

BeforeAll {
    $script:ProvisionScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'provision' 'provision-azure-resources.ps1')).Path
    $script:SubscriptionId = '00000000-0000-0000-0000-000000000123'
    $script:GraphTenantId = '11111111-1111-1111-1111-111111111111'
    $script:AuthClientId = '22222222-2222-2222-2222-222222222222'
    $script:AuthObjectId = '33333333-3333-3333-3333-333333333333'
    $script:ServicePrincipalId = '44444444-4444-4444-4444-444444444444'
    $script:AdminObjectId = '55555555-5555-5555-5555-555555555555'
    $script:ConsoleFqdn = 'triatwin-dev-console.polandcentral.azurecontainerapps.io'
    $script:StreamingBackendFqdn = 'triatwin-dev-streaming.polandcentral.azurecontainerapps.io'
    $script:DeploymentOutputsJson = (@{
            fabricCapacityName           = @{ value = 'triatwin-dev-fabric' }
            containerRegistryLoginServer = @{ value = 'triatwindev.azurecr.io' }
            keyVaultUri                  = @{ value = 'https://triatwin-dev-kv.vault.azure.net/' }
            streamingBackendFqdn         = @{ value = $script:StreamingBackendFqdn }
            consoleFqdn                  = @{ value = $script:ConsoleFqdn }
            foundryProjectName           = @{ value = 'triatwin-dev-foundry' }
        } | ConvertTo-Json -Depth 5 -Compress)

    $global:T038_SubscriptionId = $script:SubscriptionId
    $global:T038_GraphTenantId = $script:GraphTenantId
    $global:T038_AuthClientId = $script:AuthClientId
    $global:T038_AuthObjectId = $script:AuthObjectId
    $global:T038_ServicePrincipalId = $script:ServicePrincipalId
    $global:T038_AdminObjectId = $script:AdminObjectId
    $global:T038_DeploymentOutputsJson = $script:DeploymentOutputsJson

    foreach ($commandName in @(
            'Get-MgContext',
            'Connect-MgGraph',
            'Get-MgApplication',
            'New-MgApplication',
            'Update-MgApplication',
            'Get-MgServicePrincipal',
            'New-MgServicePrincipal',
            'Get-MgUser'
        )) {
        if (-not (Get-Command -Name $commandName -ErrorAction SilentlyContinue)) {
            Set-Item -Path "Function:$commandName" -Value { throw 'Test placeholder should be mocked.' }
        }
    }

    function New-FakeMgApplication {
        param(
            [string[]]$RedirectUris = @(),
            [string]$AppId = $global:T038_AuthClientId,
            [string]$ObjectId = $global:T038_AuthObjectId
        )

        return [pscustomobject]@{
            Id    = $ObjectId
            AppId = $AppId
            Web   = [pscustomobject]@{
                RedirectUris = $RedirectUris
            }
        }
    }

    function Set-CommonProvisionMocks {
        param(
            [ValidateSet('true', 'false')]
            [string]$ResourceGroupExists = 'true',

            [ValidateSet('ExistingApp', 'MissingThenExisting')]
            [string]$ApplicationLookupMode = 'ExistingApp'
        )

        $global:T038_ApplicationLookupMode = $ApplicationLookupMode
        $global:T038_ResourceGroupExists = $ResourceGroupExists
        $global:T038_GetMgApplicationCallCount = 0
        $global:T038_UpdateMgApplicationCalls = @()
        $global:T038_ExistingWorkloads = @()
        $global:T038_LookupStatus = 404
        $global:T038_DeploymentParameters = $null
        $global:T038_ProfileEnv = @{}
        $global:T038_BackendScale = @{ minReplicas = 1; maxReplicas = 1 }
        $global:T038_BackendConfiguration = @{ activeRevisionsMode = 'Single'; ingress = @{ traffic = @(@{ latestRevision = $true; weight = 100 }) } }

        Mock -CommandName Invoke-WebRequest -MockWith {
            param($Uri, $Method)
            if ($Method -ne 'GET') { throw 'Unexpected mutating ARM request.' }
            $name = (([uri]$Uri).AbsolutePath -split '/')[-1] -replace '^triatwin-dev-', ''
            if ($name -in $global:T038_ExistingWorkloads) {
                return @{ StatusCode = 200; Content = (@{ id = ([uri]$Uri).AbsolutePath; name = "triatwin-dev-$name"; properties = @{
                    configuration = $global:T038_BackendConfiguration
                    template = @{ scale = $global:T038_BackendScale; containers = @(@{ image = "acr/$name`:unique"; env = @($global:T038_ProfileEnv[$name]) }) }
                } } | ConvertTo-Json -Depth 10) }
            }
            return @{ StatusCode = $global:T038_LookupStatus; Content = '{"error":{"code":"ResourceNotFound"}}' }
        }

        Mock -CommandName Get-Module -ParameterFilter {
            $ListAvailable -and $Name -in @(
                'Microsoft.Graph.Applications',
                'Microsoft.Graph.Users',
                'Microsoft.Graph.Authentication'
            )
        } -MockWith {
            [pscustomobject]@{
                Name    = $Name
                Version = [version]'2.0.0'
            }
        }

        Mock -CommandName Import-Module -ParameterFilter {
            $Name -in @(
                'Microsoft.Graph.Applications',
                'Microsoft.Graph.Users',
                'Microsoft.Graph.Authentication'
            )
        } -MockWith { }

        Mock -CommandName Get-MgContext -MockWith {
            [pscustomobject]@{
                Account  = 'tester@contoso.com'
                TenantId = $global:T038_GraphTenantId
            }
        }

        Mock -CommandName Connect-MgGraph -MockWith {
            throw 'Connect-MgGraph should not be called by this test.'
        }

        Mock -CommandName Get-MgApplication -MockWith {
            $global:T038_GetMgApplicationCallCount++

            switch ($global:T038_ApplicationLookupMode) {
                'ExistingApp' {
                    return New-FakeMgApplication
                }
                'MissingThenExisting' {
                    if ($global:T038_GetMgApplicationCallCount -eq 1) {
                        return $null
                    }
                    return New-FakeMgApplication
                }
                default {
                    throw "Unhandled application lookup mode '$($global:T038_ApplicationLookupMode)'."
                }
            }
        }

        Mock -CommandName New-MgApplication -MockWith {
            New-FakeMgApplication
        }

        Mock -CommandName Update-MgApplication -MockWith {
            param(
                $ApplicationId,
                $Web,
                $IdentifierUris
            )

            $global:T038_UpdateMgApplicationCalls += [pscustomobject]@{
                ApplicationId  = $ApplicationId
                Web            = $Web
                IdentifierUris = @($IdentifierUris)
            }
        }

        Mock -CommandName Get-MgServicePrincipal -MockWith {
            [pscustomobject]@{
                Id = $global:T038_ServicePrincipalId
            }
        }

        Mock -CommandName New-MgServicePrincipal -MockWith {
            [pscustomobject]@{
                Id = '66666666-6666-6666-6666-666666666666'
            }
        }

        Mock -CommandName Get-MgUser -MockWith {
            [pscustomobject]@{
                Id = $global:T038_AdminObjectId
            }
        }

        Mock -CommandName az -MockWith {
            $global:LASTEXITCODE = 0

            if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'show') {
                return "{`"id`":`"$global:T038_SubscriptionId`",`"tenantId`":`"$global:T038_GraphTenantId`"}"
            }
            if ($args[0] -eq 'account' -and $args[1] -eq 'get-access-token') {
                # runtime-arm.ps1's Get-RuntimeAccessToken always requests --output json and
                # requires the returned tenant claim to match the requested tenant.
                return "{`"accessToken`":`"test-arm-token`",`"tenant`":`"$global:T038_GraphTenantId`"}"
            }

            if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'set') {
                return $null
            }

            if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists') {
                return $global:T038_ResourceGroupExists
            }

            if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'create') {
                return $null
            }

            if ($args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'create') {
                $paramsPath = @($args | Where-Object { $_ -like '@*' })[0].Substring(1)
                $global:T038_DeploymentParameters = Get-Content -LiteralPath $paramsPath -Raw | ConvertFrom-Json
                return $null
            }

            if ($args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'what-if') {
                return 'what-if completed'
            }

            if ($args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'show') {
                return $global:T038_DeploymentOutputsJson
            }

            throw "Unexpected az invocation: $($args -join ' ')"
        }
    }
}

Describe 'provision-azure-resources.ps1 (T038)' {

    Context 'Parameter validation' {
        It 'throws when -SubscriptionId is not supplied' {
            { & $script:ProvisionScript } | Should -Throw
        }
    }

    Context 'Idempotency: existing resource group and existing app registration' {
        BeforeEach {
            Set-CommonProvisionMocks -ResourceGroupExists 'true' -ApplicationLookupMode 'ExistingApp'
        }

        It 'reuses existing resources, returns deployment outputs, and updates redirect URIs on the second pass' {
            $result = & $script:ProvisionScript -SubscriptionId $script:SubscriptionId

            $result.ResourceGroupName | Should -Be 'rg-triathlon-twin-demo'
            $result.FabricCapacityName | Should -Be 'triatwin-dev-fabric'
            $result.ContainerRegistryLoginServer | Should -Be 'triatwindev.azurecr.io'
            $result.KeyVaultUri | Should -Be 'https://triatwin-dev-kv.vault.azure.net/'
            $result.StreamingBackendFqdn | Should -Be $script:StreamingBackendFqdn
            $result.ConsoleFqdn | Should -Be $script:ConsoleFqdn
            $result.FoundryProjectName | Should -Be 'triatwin-dev-foundry'
            $result.AuthClientId | Should -Be $script:AuthClientId
            $result.AdminObjectId | Should -Be $script:AdminObjectId
            $result.TenantId | Should -Be $script:GraphTenantId

            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists'
            }

            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'create'
            }
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'create'
            }
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'show'
            }
            Should -Invoke -CommandName New-MgApplication -Times 0 -Exactly

            $redirectUpdate = $global:T038_UpdateMgApplicationCalls | Where-Object { $_.Web } | Select-Object -Last 1
            $redirectUpdate | Should -Not -BeNullOrEmpty
            $redirectUpdate.ApplicationId | Should -Be $script:AuthObjectId
            $redirectUpdate.Web.RedirectUris | Should -Contain "https://$($script:ConsoleFqdn)/.auth/login/aad/callback"
            $redirectUpdate.Web.RedirectUris | Should -Contain "https://$($script:StreamingBackendFqdn)/.auth/login/aad/callback"
        }

        It 'preserves only present workloads in a mixed deployment without copying their images or secrets' {
            $global:T038_ExistingWorkloads = @('cockpit', 'streaming-backend', 'simulator')
            $result = & $script:ProvisionScript -SubscriptionId $script:SubscriptionId
            $result.PreservedWorkloads.Count | Should -Be 3
            $global:T038_DeploymentParameters.parameters.preservedWorkloads.value | Should -Be @('cockpit', 'streaming-backend', 'simulator')
            $global:T038_DeploymentParameters.parameters.PSObject.Properties.Name | Should -Not -Contain 'eventstreamEventHubConnectionString'
            $global:T038_DeploymentParameters | ConvertTo-Json -Depth 20 | Should -Not -Match ':unique'
            Should -Invoke Invoke-WebRequest -Times 5 -Exactly -ParameterFilter {
                $Method -eq 'GET' -and $Uri -like "https://management.azure.com/subscriptions/$global:T038_SubscriptionId/resourceGroups/rg-triathlon-twin-demo/providers/Microsoft.App/*"
            }
            Should -Invoke az -Times 0 -ParameterFilter { $args[0] -eq 'account' -and $args[1] -eq 'set' }
        }

        It 'fails closed on lookup errors other than confirmed 404' {
            $global:T038_LookupStatus = 403
            { & $script:ProvisionScript -SubscriptionId $script:SubscriptionId } | Should -Throw '*HTTP 403*'
            Should -Invoke az -Times 0 -ParameterFilter { $args[0] -eq 'deployment' }
            Should -Invoke Get-MgApplication -Times 0
        }

        It 'defaults new workloads to live and forwards explicit synthetic selection' {
            & $script:ProvisionScript -SubscriptionId $script:SubscriptionId | Out-Null
            $global:T038_DeploymentParameters.parameters.demoProfile.value | Should -Be 'live'
            & $script:ProvisionScript -SubscriptionId $script:SubscriptionId -DemoProfile synthetic | Out-Null
            $global:T038_DeploymentParameters.parameters.demoProfile.value | Should -Be 'synthetic'
        }

        It 'inherits synthetic from a preserved backend when creating a missing Cockpit' {
            $global:T038_ExistingWorkloads = @('streaming-backend')
            $global:T038_ProfileEnv['streaming-backend'] = @{ name = 'DEMO_PROFILE'; value = 'synthetic' }
            & $script:ProvisionScript -SubscriptionId $script:SubscriptionId | Out-Null
            $global:T038_DeploymentParameters.parameters.demoProfile.value | Should -Be 'synthetic'
        }

        It 'rejects an explicit profile switch instead of silently skipping preserved workloads' {
            $global:T038_ExistingWorkloads = @('cockpit', 'streaming-backend')
            { & $script:ProvisionScript -SubscriptionId $script:SubscriptionId -DemoProfile synthetic } | Should -Throw '*cannot switch*'
            Should -Invoke Get-MgApplication -Times 0
            Should -Invoke az -Times 0 -ParameterFilter { $args[0] -eq 'deployment' }
        }

        It 'rejects mismatched existing profiles' {
            $global:T038_ExistingWorkloads = @('cockpit', 'streaming-backend')
            $global:T038_ProfileEnv['cockpit'] = @{ name = 'DEMO_PROFILE'; value = 'synthetic' }
            { & $script:ProvisionScript -SubscriptionId $script:SubscriptionId } | Should -Throw '*profiles disagree*'
            Should -Invoke Get-MgApplication -Times 0
        }

        It 'rejects invalid retained profile <Value>' -TestCases @(
            @{ Value = '' }, @{ Value = 'Synthetic' }, @{ Value = 'unknown' }
        ) {
            param($Value)
            $global:T038_ExistingWorkloads = @('cockpit')
            $global:T038_ProfileEnv['cockpit'] = @{ name = 'DEMO_PROFILE'; value = $Value }
            { & $script:ProvisionScript -SubscriptionId $script:SubscriptionId } | Should -Throw '*invalid DEMO_PROFILE*'
            Should -Invoke Get-MgApplication -Times 0
        }

        It 'rejects invalid explicit casing before external calls' {
            { & $script:ProvisionScript -SubscriptionId $script:SubscriptionId -DemoProfile Synthetic } | Should -Throw '*exactly live or synthetic*'
            Should -Invoke Invoke-WebRequest -Times 0
        }

        It 'rejects unsafe retained synthetic backend <Setting>' -TestCases @(
            @{ Setting = 'minReplicas' }, @{ Setting = 'maxReplicas' },
            @{ Setting = 'revisionMode' }, @{ Setting = 'traffic' }
        ) {
            param($Setting)
            $global:T038_ExistingWorkloads = @('streaming-backend')
            $global:T038_ProfileEnv['streaming-backend'] = @{ name = 'DEMO_PROFILE'; value = 'synthetic' }
            switch ($Setting) {
                minReplicas { $global:T038_BackendScale.minReplicas = 0 }
                maxReplicas { $global:T038_BackendScale.maxReplicas = 3 }
                revisionMode { $global:T038_BackendConfiguration.activeRevisionsMode = 'Multiple' }
                traffic { $global:T038_BackendConfiguration.ingress.traffic[0].weight = 50 }
            }
            { & $script:ProvisionScript -SubscriptionId $script:SubscriptionId } | Should -Throw '*Single revision mode*'
            Should -Invoke Get-MgApplication -Times 0
        }
    }

    Context 'Idempotency: missing resource group and missing app registration' {
        BeforeEach {
            Set-CommonProvisionMocks -ResourceGroupExists 'false' -ApplicationLookupMode 'MissingThenExisting'
        }

        It 'creates the resource group and creates the app registration only once' {
            $result = & $script:ProvisionScript -SubscriptionId $script:SubscriptionId

            $result.AuthClientId | Should -Be $script:AuthClientId
            $result.ConsoleFqdn | Should -Be $script:ConsoleFqdn

            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists'
            }
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'create'
            }
            Should -Invoke -CommandName New-MgApplication -Times 1 -Exactly
        }
    }

    Context 'WhatIf mode' {
        BeforeEach {
            Set-CommonProvisionMocks -ResourceGroupExists 'false' -ApplicationLookupMode 'ExistingApp'
        }

        It 'skips mutating az operations and runs deployment what-if instead' {
            $result = & $script:ProvisionScript -SubscriptionId $script:SubscriptionId -WhatIf

            $result | Should -BeNullOrEmpty

            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'create'
            }
            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
                $args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'create'
            }
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'what-if'
            }
            Should -Invoke -CommandName Update-MgApplication -Times 0 -Exactly
            Should -Invoke -CommandName New-MgApplication -Times 0 -Exactly
        }
    }
}
