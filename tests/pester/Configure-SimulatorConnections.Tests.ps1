#Requires -Version 7.0
<#
.SYNOPSIS
Pester tests for scripts/provision/configure-simulator-connections.ps1 (T059b).

.DESCRIPTION
Invokes the real script as a black box, mocking the Azure CLI, Microsoft Graph cmdlets, and
Fabric REST calls it (and the real nested provision-azure-resources.ps1 second pass it
invokes) depend on. Mirrors the mocking conventions established in
Provision-AzureResources.Tests.ps1 and Provision-FabricItems.Tests.ps1 -- the nested script is
allowed to run for real (not mocked as a unit), since Pester cannot reliably mock an external
.ps1 invoked via an absolute path (confirmed: such calls bypass command-name resolution), so
its own az/Graph dependencies are mocked instead, exactly as provision-azure-resources.ps1's
own tests already do for its nested provision-entra-app-registrations.ps1 call.
#>

BeforeAll {
    . (Join-Path $PSScriptRoot 'Runtime-Fixtures.ps1')
    $script:ConfigureScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'provision' 'configure-simulator-connections.ps1')).Path
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

    $script:WorkspaceId = 'fbad4bfe-2c3e-4cc7-80b4-30da9774299a'
    $script:LakehouseId = 'a2a64b11-e244-4316-9c02-aa523f79571e'
    $script:EventstreamId = '526c7832-1b76-4440-988b-87e41ad52705'
    $script:SourceId = '9063f35b-d006-43db-b40e-581416241c9b'
    $script:EventHubNamespace = 'esehplc9lie0ozp0fm3022g.servicebus.windows.net'
    $script:EventHubName = 'es_hub_1'
    $script:EventHubConnectionString = 'Endpoint=sb://esehplc9lie0ozp0fm3022g.servicebus.windows.net/;SharedAccessKeyName=key;SharedAccessKey=fakekey123=;EntityPath=es_hub_1'
    $script:EventhouseId = 'c1a7f6ee-1c39-4b1b-8d9a-3e3f6b1f6a10'
    $script:KqlDatabaseId = 'd2b8a7ff-2d4a-4c2c-9e0b-4f4a7c2f7b21'
    $script:EventhouseQueryUri = 'https://trd-faketestcluster.z1.kusto.fabric.microsoft.com'

    $global:T059b_SubscriptionId = $script:SubscriptionId
    $global:T059b_GraphTenantId = $script:GraphTenantId
    $global:T059b_AuthClientId = $script:AuthClientId
    $global:T059b_AuthObjectId = $script:AuthObjectId
    $global:T059b_ServicePrincipalId = $script:ServicePrincipalId
    $global:T059b_AdminObjectId = $script:AdminObjectId
    $global:T059b_DeploymentOutputsJson = $script:DeploymentOutputsJson
    $global:T059b_WorkspaceId = $script:WorkspaceId
    $global:T059b_LakehouseId = $script:LakehouseId
    $global:T059b_EventstreamId = $script:EventstreamId
    $global:T059b_SourceId = $script:SourceId
    $global:T059b_EventHubNamespace = $script:EventHubNamespace
    $global:T059b_EventHubName = $script:EventHubName
    $global:T059b_EventHubConnectionString = $script:EventHubConnectionString
    $global:T059b_EventhouseId = $script:EventhouseId
    $global:T059b_KqlDatabaseId = $script:KqlDatabaseId
    $global:T059b_EventhouseQueryUri = $script:EventhouseQueryUri

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
            [string]$AppId = $global:T059b_AuthClientId,
            [string]$ObjectId = $global:T059b_AuthObjectId
        )

        return [pscustomobject]@{
            Id    = $ObjectId
            AppId = $AppId
            Web   = [pscustomobject]@{
                RedirectUris = $RedirectUris
            }
        }
    }

    function Set-ConfigureConnectionsMocks {
        param(
            [bool]$LakehouseExists = $true,
            [bool]$EventstreamExists = $true,
            [bool]$EventhouseExists = $true,
            [bool]$KqlDatabaseExists = $true,
            [bool]$DatabaseBelongsToEventhouse = $true,
            [string]$QueryServiceUri = $script:EventhouseQueryUri,
            [string]$KqlDatabaseType = 'KQLDatabase',
            [bool]$SourceExistsInTopology = $true,
            [string]$WorkspaceLookupMode = 'ByIdOnly'
        )

        $global:T059b_ArmParamsFileContents = $null
        $global:T059b_WorkspaceLookupMode = $WorkspaceLookupMode
        $global:T059b_DatabaseBelongsToEventhouse = $DatabaseBelongsToEventhouse
        $global:T059b_QueryServiceUri = $QueryServiceUri
        $global:T059b_StreamingBackendIdentityPrincipalId = '77777777-7777-7777-7777-777777777777'
        $global:T059b_SimulatorIdentityPrincipalId = '88888888-8888-8888-8888-888888888888'
        $global:T059b_McpToolsIdentityPrincipalId = '99999999-9999-9999-9999-999999999999'
        $global:T059b_IdentityPrincipalIds = @{
            'triatwin-dev-id-streaming-backend' = $global:T059b_StreamingBackendIdentityPrincipalId
            'triatwin-dev-id-simulator'          = $global:T059b_SimulatorIdentityPrincipalId
            'triatwin-dev-id-mcp-tools'           = $global:T059b_McpToolsIdentityPrincipalId
        }
        $global:T059b_GrantedRoleAssignments = @()
        New-RuntimeFixture
        Mock Invoke-WebRequest {
            param($Uri, $Method, $Body)
            Invoke-RuntimeFixtureRequest $Uri $Method $Body
        }

        Mock -CommandName Get-Module -ParameterFilter {
            $ListAvailable -and $Name -in @(
                'Microsoft.Graph.Applications',
                'Microsoft.Graph.Users',
                'Microsoft.Graph.Authentication'
            )
        } -MockWith {
            [pscustomobject]@{ Name = $Name; Version = [version]'2.0.0' }
        }

        Mock -CommandName Import-Module -ParameterFilter {
            $Name -in @(
                'Microsoft.Graph.Applications',
                'Microsoft.Graph.Users',
                'Microsoft.Graph.Authentication'
            )
        } -MockWith { }

        Mock -CommandName Get-MgContext -MockWith {
            [pscustomobject]@{ Account = 'tester@contoso.com'; TenantId = $global:T059b_GraphTenantId }
        }
        Mock -CommandName Connect-MgGraph -MockWith { throw 'Connect-MgGraph should not be called by this test.' }
        Mock -CommandName Get-MgApplication -MockWith { New-FakeMgApplication }
        Mock -CommandName New-MgApplication -MockWith { New-FakeMgApplication }
        Mock -CommandName Update-MgApplication -MockWith { }
        Mock -CommandName Get-MgServicePrincipal -MockWith { [pscustomobject]@{ Id = $global:T059b_ServicePrincipalId } }
        Mock -CommandName New-MgServicePrincipal -MockWith { [pscustomobject]@{ Id = '66666666-6666-6666-6666-666666666666' } }
        Mock -CommandName Get-MgUser -MockWith { [pscustomobject]@{ Id = $global:T059b_AdminObjectId } }

        Mock -CommandName az -MockWith {
            $global:LASTEXITCODE = 0

            if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'show') {
                return "{`"id`":`"$global:T059b_SubscriptionId`",`"tenantId`":`"$global:T059b_GraphTenantId`"}"
            }
            if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'set') {
                return $null
            }
            if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'get-access-token') {
                if ($args -contains 'https://management.azure.com/') {
                    # Matches runtime-arm.ps1's Get-RuntimeAccessToken, which always requests
                    # --output json and validates the returned tenant claim.
                    return "{`"accessToken`":`"arm-test-token`",`"tenant`":`"$global:T059b_GraphTenantId`"}"
                }
                # Fabric token path (Get-FabricAuthHeaders) uses --query accessToken -o tsv,
                # so it expects a bare token string, not JSON.
                return 'fabric-access-token'
            }
            if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists') {
                return 'true'
            }
            if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'create') {
                return $null
            }
            if ($args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'create') {
                $paramsFileArg = ($args | Where-Object { $_ -like '@*' }) | Select-Object -First 1
                if ($paramsFileArg) {
                    $global:T059b_ArmParamsFileContents = Get-Content -Raw -Path $paramsFileArg.Substring(1) | ConvertFrom-Json
                }
                return $null
            }
            if ($args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'what-if') {
                return 'what-if completed'
            }
            if ($args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'show') {
                return $global:T059b_DeploymentOutputsJson
            }
            if ($args.Count -ge 2 -and $args[0] -eq 'identity' -and $args[1] -eq 'show') {
                $nameIndex = [array]::IndexOf($args, '--name')
                $identityName = if ($nameIndex -ge 0 -and $args.Count -gt ($nameIndex + 1)) { $args[$nameIndex + 1] } else { $null }
                if ($global:T059b_IdentityPrincipalIds.ContainsKey($identityName)) {
                    return $global:T059b_IdentityPrincipalIds[$identityName]
                }
                return ''
            }

            throw "Unexpected az invocation: $($args -join ' ')"
        }

        $lakehouseItems = @()
        if ($LakehouseExists) {
            $lakehouseItems += [pscustomobject]@{ id = $global:T059b_LakehouseId; displayName = 'triatwin_dev_lakehouse'; type = 'Lakehouse' }
        }
        $eventstreamItems = @()
        if ($EventstreamExists) {
            $eventstreamItems += [pscustomobject]@{ id = $global:T059b_EventstreamId; displayName = 'triatwin-dev-eventstream'; type = 'Eventstream' }
        }
        $eventhouseItems = @()
        if ($EventhouseExists) {
            $eventhouseItems += [pscustomobject]@{ id = $global:T059b_EventhouseId; displayName = 'triatwin-dev-eventhouse'; type = 'Eventhouse' }
        }
        $kqlDatabaseItems = @()
        if ($KqlDatabaseExists) {
            $kqlDatabaseItems += [pscustomobject]@{ id = $global:T059b_KqlDatabaseId; displayName = 'triatwin-dev-realtime'; type = $KqlDatabaseType }
        }
        $global:T059b_AllItems = @($lakehouseItems) + @($eventstreamItems) + @($eventhouseItems) + @($kqlDatabaseItems)
        $global:T059b_SourceExistsInTopology = $SourceExistsInTopology

        Mock -CommandName Invoke-RestMethod -MockWith {
            param($Method, $Uri, $Headers, $Body, $ContentType, $ErrorAction, $ResponseHeadersVariable)

            if ($Method -eq 'Get' -and $Uri -like 'https://api.fabric.microsoft.com/v1/workspaces?roles=Admin*') {
                if ($global:T059b_WorkspaceLookupMode -eq 'ByName') {
                    return [pscustomobject]@{
                        value           = @([pscustomobject]@{ id = $global:T059b_WorkspaceId; displayName = 'triatwin-dev-fabric' })
                        continuationUri = $null
                    }
                }
                throw 'Workspace lookup by name should not be called when -FabricWorkspaceId is supplied.'
            }

            if ($Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T059b_WorkspaceId)/items") {
                return [pscustomobject]@{ value = @($global:T059b_AllItems); continuationUri = $null }
            }

            if ($Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T059b_WorkspaceId)/roleAssignments") {
                $existing = @($global:T059b_GrantedRoleAssignments | ForEach-Object {
                        [pscustomobject]@{ principal = [pscustomobject]@{ id = $_ }; role = 'Contributor' }
                    })
                return [pscustomobject]@{ value = $existing }
            }

            if ($Method -eq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T059b_WorkspaceId)/roleAssignments") {
                $parsedBody = $Body | ConvertFrom-Json
                $global:T059b_GrantedRoleAssignments += $parsedBody.principal.id
                return [pscustomobject]@{}
            }

            if ($Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T059b_WorkspaceId)/eventhouses/$($global:T059b_EventhouseId)") {
                return [pscustomobject]@{
                    id          = $global:T059b_EventhouseId
                    type        = 'Eventhouse'
                    displayName = 'triatwin-dev-eventhouse'
                    properties  = [pscustomobject]@{
                        queryServiceUri     = $global:T059b_QueryServiceUri
                        databasesItemIds    = if ($global:T059b_DatabaseBelongsToEventhouse) { @($global:T059b_KqlDatabaseId) } else { @() }
                        ingestionServiceUri = 'https://ingest-trd-faketestcluster.z1.kusto.fabric.microsoft.com'
                    }
                }
            }

            if ($Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T059b_WorkspaceId)/eventstreams/$($global:T059b_EventstreamId)/topology") {
                $sources = @()
                if ($global:T059b_SourceExistsInTopology) {
                    $sources += [pscustomobject]@{ id = $global:T059b_SourceId; name = 'triathlon_custom_endpoint'; type = 'CustomEndpoint' }
                }
                else {
                    $sources += [pscustomobject]@{ id = 'aaaaaaaa-0000-0000-0000-000000000000'; name = 'some_other_source'; type = 'CustomEndpoint' }
                }
                return [pscustomobject]@{ sources = $sources }
            }

            if ($Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T059b_WorkspaceId)/eventstreams/$($global:T059b_EventstreamId)/sources/$($global:T059b_SourceId)/connection") {
                return [pscustomobject]@{
                    type                    = 'CustomEndpoint'
                    fullyQualifiedNamespace = $global:T059b_EventHubNamespace
                    eventHubName            = $global:T059b_EventHubName
                    accessKeys              = [pscustomobject]@{
                        primaryKey               = 'fakeprimarykey'
                        secondaryKey             = 'fakesecondarykey'
                        primaryConnectionString  = $global:T059b_EventHubConnectionString
                        secondaryConnectionString = 'Endpoint=sb://fake/;SharedAccessKeyName=key;SharedAccessKey=secondary'
                    }
                }
            }

            throw "Unexpected Invoke-RestMethod invocation: $Method $Uri"
        }
    }
}

Describe 'configure-simulator-connections.ps1 (T059b)' {

    Context 'Parameter validation' {
        It 'throws when -SubscriptionId is not supplied' {
            { & $script:ConfigureScript } | Should -Throw
        }
    }

    Context 'Happy path: FabricWorkspaceId supplied directly' {
        BeforeEach {
            Set-ConfigureConnectionsMocks
        }

        It 'resolves Fabric connections and redeploys with Eventhouse configuration and all three identity grants' {
            $result = & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId

            $result.FabricWorkspaceId | Should -Be $script:WorkspaceId
            $result.LakehouseItemId | Should -Be $script:LakehouseId
            $result.EventstreamItemId | Should -Be $script:EventstreamId
            $result.EventstreamSourceId | Should -Be $script:SourceId
            $result.EventHubFullyQualifiedNamespace | Should -Be $script:EventHubNamespace
            $result.EventHubName | Should -Be $script:EventHubName
            $result.EventhouseItemId | Should -Be $script:EventhouseId
            $result.EventhouseQueryUri | Should -Be $script:EventhouseQueryUri
            $result.EventhouseDatabaseName | Should -Be 'triatwin-dev-realtime'
            $result.AzureResources.FabricCapacityName | Should -Be 'triatwin-dev-fabric'

            # The connection string itself must never be present on the returned object.
            ($result.PSObject.Properties.Name) | Should -Not -Contain 'EventHubConnectionString'
            ($result.PSObject.Properties.Name) | Should -Not -Contain 'EventstreamEventHubConnectionString'

            $global:T059b_ArmParamsFileContents | Should -Not -BeNullOrEmpty
            $global:T059b_ArmParamsFileContents.parameters.lakehouseOneLakeFileSystem.value | Should -Be $script:WorkspaceId
            $global:T059b_ArmParamsFileContents.parameters.lakehouseOneLakePath.value | Should -Be $script:LakehouseId
            $global:T059b_ArmParamsFileContents.parameters.PSObject.Properties.Name | Should -Not -Contain 'eventstreamEventHubConnectionString'
            foreach ($id in @(
                "$($global:RuntimeFixture.Root)/Microsoft.App/containerApps/triatwin-dev-streaming-backend",
                "$($global:RuntimeFixture.Root)/Microsoft.App/jobs/triatwin-dev-simulator"
            )) {
                ($global:RuntimeFixture.Resources[$id].properties.configuration.secrets | Where-Object name -eq eventstream-eventhub-connection-string).value | Should -Be $script:EventHubConnectionString
            }
            $global:T059b_ArmParamsFileContents.parameters.lakehouseOneLakeAccountUrl.value | Should -Be 'https://onelake.dfs.fabric.microsoft.com'
            $global:T059b_ArmParamsFileContents.parameters.eventhouseQueryUri.value | Should -Be $script:EventhouseQueryUri
            $global:T059b_ArmParamsFileContents.parameters.eventhouseDatabaseName.value | Should -Be 'triatwin-dev-realtime'

            # Every Fabric-item-querying identity (streaming-backend, simulator, mcp-tools)
            # must receive the Contributor workspace role grant, not just the two OneLake ones.
            $result.GrantedWorkspaceRoleAssignments | Should -Contain 'triatwin-dev-id-streaming-backend'
            $result.GrantedWorkspaceRoleAssignments | Should -Contain 'triatwin-dev-id-simulator'
            $result.GrantedWorkspaceRoleAssignments | Should -Contain 'triatwin-dev-id-mcp-tools'
        }

        It 'does not recreate workspace role assignments on repeated runs' {
            & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId | Out-Null
            $result = & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId

            $result.GrantedWorkspaceRoleAssignments | Should -BeNullOrEmpty
            Should -Invoke -CommandName Invoke-RestMethod -Times 3 -Exactly -ParameterFilter {
                $Method -eq 'Post' -and $Uri -like '*/roleAssignments'
            }
        }

        It 'finds existing higher-privilege assignments on later pages without downgrading them' {
            Mock -CommandName Invoke-RestMethod -ParameterFilter {
                $Method -eq 'Get' -and $Uri -like '*/roleAssignments*'
            } -MockWith {
                if ($Uri -like '*continuationToken=next') {
                    return [pscustomobject]@{
                        value = @($global:T059b_IdentityPrincipalIds.Values | ForEach-Object {
                            [pscustomobject]@{ principal = [pscustomobject]@{ id = $_ }; role = 'Admin' }
                        })
                    }
                }
                return [pscustomobject]@{ value = @(); continuationUri = "$($Uri)?continuationToken=next" }
            }

            $result = & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId
            $result.GrantedWorkspaceRoleAssignments | Should -BeNullOrEmpty
            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter { $Method -eq 'Post' }
        }

        It 'fails explicitly rather than silently accepting an insufficient workspace role' {
            Mock -CommandName Invoke-RestMethod -ParameterFilter {
                $Method -eq 'Get' -and $Uri -like '*/roleAssignments'
            } -MockWith {
                return [pscustomobject]@{
                    value = @([pscustomobject]@{
                        principal = [pscustomobject]@{ id = $global:T059b_StreamingBackendIdentityPrincipalId }
                        role = 'Viewer'
                    })
                }
            }

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*Contributor*required*'
            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter { $Method -eq 'Post' }
        }
    }

    Context 'Workspace resolution by name' {
        BeforeEach {
            Set-ConfigureConnectionsMocks -WorkspaceLookupMode 'ByName'
        }

        It 'resolves the workspace ID via the Fabric REST API when -FabricWorkspaceId is omitted' {
            $result = & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceName 'triatwin-dev-fabric'

            $result.FabricWorkspaceId | Should -Be $script:WorkspaceId
        }
    }

    Context 'Missing Fabric items' {
        It 'throws when the Lakehouse item cannot be found' {
            Set-ConfigureConnectionsMocks -LakehouseExists $false

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*Lakehouse item*was not found*'
        }

        It 'throws when the Eventstream item cannot be found' {
            Set-ConfigureConnectionsMocks -EventstreamExists $false

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*Eventstream item*was not found*'
        }

        It 'throws when the Eventhouse item cannot be found' {
            Set-ConfigureConnectionsMocks -EventhouseExists $false

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*Eventhouse item*was not found*'
        }

        It 'throws when the KQL database item cannot be found' {
            Set-ConfigureConnectionsMocks -KqlDatabaseExists $false

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*KQL database item*was not found*'
        }

        It 'rejects a same-named item of the wrong type' {
            Set-ConfigureConnectionsMocks -KqlDatabaseType 'Lakehouse'

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*KQL database item*was not found*'
        }

        It 'rejects an Eventhouse without a query URI before granting roles or deploying' {
            Set-ConfigureConnectionsMocks -QueryServiceUri ''

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*no properties.queryServiceUri*'
            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter { $Method -eq 'Post' }
        }

        It 'rejects a database hosted by a different Eventhouse' {
            Set-ConfigureConnectionsMocks -DatabaseBelongsToEventhouse $false

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*does not belong to Eventhouse*'
            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter { $Method -eq 'Post' }
        }

        It 'throws when the CustomEndpoint source cannot be found in the topology' {
            Set-ConfigureConnectionsMocks -SourceExistsInTopology $false

            { & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId } | Should -Throw '*Eventstream source*was not found in the topology*'
        }
    }

    Context 'WhatIf mode' {
        BeforeEach {
            Set-ConfigureConnectionsMocks
        }

        It 'passes -WhatIf through to the nested provision-azure-resources.ps1 redeploy' {
            $result = & $script:ConfigureScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceId $script:WorkspaceId -WhatIf

            $result.AzureResources | Should -BeNullOrEmpty
            $result.LakehouseItemId | Should -Be $script:LakehouseId
            $result.EventhouseQueryUri | Should -Be $script:EventhouseQueryUri
            $result.GrantedWorkspaceRoleAssignments | Should -BeNullOrEmpty
            $global:T059b_GrantedRoleAssignments | Should -BeNullOrEmpty
            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter {
                $Method -ne 'Get'
            }

            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
                $args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'create'
            }
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 3 -and $args[0] -eq 'deployment' -and $args[1] -eq 'group' -and $args[2] -eq 'what-if'
            }
        }
    }
}
