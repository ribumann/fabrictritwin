#Requires -Version 7.0
<#
.SYNOPSIS
Pester tests for scripts/provision/provision-fabric-items.ps1 (T039).

.DESCRIPTION
Exercises the real provisioning script as a black box while mocking every external az CLI and
Fabric REST call. Covers parameter validation and idempotency for both the all-existing and
create-if-absent flows.
#>

BeforeAll {
    $script:ProvisionScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'provision' 'provision-fabric-items.ps1')).Path
    $script:SubscriptionId = '00000000-0000-0000-0000-000000000123'
    $script:ResourceGroupName = 'rg-triathlon-twin-demo'
    $script:FabricCapacityName = 'triatwindevfabriccap'
    # Fabric-native capacity GUID as returned by GET /v1/capacities -- deliberately NOT an
    # ARM resource ID. provision-fabric-items.ps1 resolves this via the Fabric REST API
    # (Get-FabricCapacityByDisplayName), not `az resource show`, because the Fabric
    # `capacityId` field on POST /v1/workspaces requires a GUID (confirmed via a live 400
    # error: "Error converting value '<arm-id>' to type '...Guid'").
    $script:FabricCapacityId = '7ba9b8e5-8783-49c1-8bec-fa69e696d9f1'
    $script:WorkspaceName = 'triatwin-dev-fabric'
    $script:WorkspaceId = '11111111-2222-3333-4444-555555555555'
    $script:TeamsTeamId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    $script:TeamsChannelId = '19:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@thread.tacv2'
    $script:OpsNotebookItemId = '99999999-8888-7777-6666-555555555555'
    $global:T039_SubscriptionId = $script:SubscriptionId
    $global:T039_FabricCapacityId = $script:FabricCapacityId
    $global:T039_FabricCapacityName = $script:FabricCapacityName
    $global:T039_WorkspaceId = $script:WorkspaceId
    $global:T039_WorkspaceName = $script:WorkspaceName
    $global:T039_TenantId = 'bbbbbbbb-1111-4444-8888-111111111111'
    $script:ItemDefinitions = @(
        @{ LogicalName = 'Eventhouse'; Type = 'Eventhouse'; DisplayName = 'triatwin-dev-eventhouse'; UriSuffix = '/eventhouses' },
        @{ LogicalName = 'KQLDatabase'; Type = 'KQLDatabase'; DisplayName = 'triatwin-dev-realtime'; UriSuffix = '/kqlDatabases' },
        @{ LogicalName = 'Eventstream'; Type = 'Eventstream'; DisplayName = 'triatwin-dev-eventstream'; UriSuffix = '/items' },
        @{ LogicalName = 'Lakehouse'; Type = 'Lakehouse'; DisplayName = 'triatwin_dev_lakehouse'; UriSuffix = '/lakehouses' },
        @{ LogicalName = 'Notebook'; Type = 'Notebook'; DisplayName = 'triatwin-dev-load-history-to-tables'; UriSuffix = '/notebooks' },
        @{ LogicalName = 'SemanticModel'; Type = 'SemanticModel'; DisplayName = 'triatwin-dev-athlete-trends-semanticmodel'; UriSuffix = '/semanticModels' },
        @{ LogicalName = 'Report'; Type = 'Report'; DisplayName = 'triatwin-dev-athlete-trends-report'; UriSuffix = '/reports' },
        @{ LogicalName = 'DigitalTwinBuilder'; Type = 'DigitalTwinBuilder'; DisplayName = 'triatwin_dev_digitaltwinbuilder'; UriSuffix = '/digitaltwinbuilders' },
        @{ LogicalName = 'Ontology'; Type = 'Ontology'; DisplayName = 'triatwin_dev_ontology'; UriSuffix = '/ontologies' },
        @{ LogicalName = 'Reflex'; Type = 'Reflex'; DisplayName = 'triatwin-dev-alerts'; UriSuffix = '/reflexes' },
        @{ LogicalName = 'DataAgent'; Type = 'DataAgent'; DisplayName = 'triatwin-dev-dataagent'; UriSuffix = '/dataAgents' },
        @{ LogicalName = 'OperationsAgent'; Type = 'OperationsAgent'; DisplayName = 'triatwin-dev-operationsagent'; UriSuffix = '/operationsAgents' }
    )
    $global:T039_ItemDefinitions = $script:ItemDefinitions

    function New-T039Item {
        param(
            [string]$Id,
            [string]$DisplayName,
            [string]$Type
        )

        return [pscustomobject]@{
            id          = $Id
            displayName = $DisplayName
            type        = $Type
        }
    }

    function New-T039GuidFor {
        param([string]$Seed)

        $hashBytes = [System.Security.Cryptography.MD5]::HashData([System.Text.Encoding]::UTF8.GetBytes($Seed))
        $hex = [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
        return ([guid]::ParseExact($hex, 'N')).Guid
    }

    function Set-ProvisionFabricMocks {
        param(
            [switch]$WorkspaceExists,
            [switch]$ItemsExist
        )

        $global:T039_Workspaces = [System.Collections.ArrayList]::new()
        $global:T039_Items = [System.Collections.ArrayList]::new()
        $global:T039_RequestLog = [System.Collections.ArrayList]::new()

        if ($WorkspaceExists) {
            [void]$global:T039_Workspaces.Add([pscustomobject]@{
                    id          = $script:WorkspaceId
                    displayName = $script:WorkspaceName
                })
        }

        if ($ItemsExist) {
            foreach ($itemDef in $global:T039_ItemDefinitions) {
                [void]$global:T039_Items.Add((New-T039Item -Id (New-T039GuidFor -Seed $itemDef.DisplayName) -DisplayName $itemDef.DisplayName -Type $itemDef.Type))
            }
        }

        Mock -CommandName az -MockWith {
            $global:LASTEXITCODE = 0
            if ($args -notcontains '--subscription' -or $args -notcontains $global:T039_SubscriptionId) {
                throw 'Every nested CLI operation must target the requested subscription.'
            }

            if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'show') {
                return "{`"id`":`"$($global:T039_SubscriptionId)`",`"tenantId`":`"$($global:T039_TenantId)`"}"
            }

            if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'set') {
                return $null
            }

            if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'get-access-token') {
                return 'fabric-access-token'
            }

            if ($args.Count -ge 2 -and $args[0] -eq 'resource' -and $args[1] -eq 'show') {
                if ($args -contains 'properties.state') {
                    return 'Active'
                }
                throw "Unexpected 'az resource show' invocation without --query properties.state: $($args -join ' ') (capacity ID resolution now goes through the Fabric REST API GET /v1/capacities, not az resource show)"
            }

            throw "Unexpected az invocation: $($args -join ' ')"
        }

        Mock -CommandName Invoke-RestMethod -MockWith {
            param($Method, $Uri, $Headers, $Body, $ContentType, $ErrorAction, $ResponseHeadersVariable)

            if ($Method -eq 'Get' -and $Uri -eq 'https://api.fabric.microsoft.com/v1/capacities') {
                return [pscustomobject]@{
                    value           = @([pscustomobject]@{
                            id          = $global:T039_FabricCapacityId
                            displayName = $global:T039_FabricCapacityName
                        })
                    continuationUri = $null
                }
            }

            if ($Method -eq 'Get' -and $Uri -like 'https://api.fabric.microsoft.com/v1/workspaces?roles=Admin*') {
                return [pscustomobject]@{
                    value           = @($global:T039_Workspaces)
                    continuationUri = $null
                }
            }

            if ($Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T039_WorkspaceId)/items") {
                return [pscustomobject]@{
                    value           = @($global:T039_Items)
                    continuationUri = $null
                }
            }

            if ($Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T039_WorkspaceId)") {
                return [pscustomobject]@{ id = $global:T039_WorkspaceId; capacityId = $global:T039_FabricCapacityId }
            }

            if ($Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T039_WorkspaceId)/kqlDatabases/$(New-T039GuidFor -Seed 'mining-d01-realtime')") {
                return [pscustomobject]@{
                    id = New-T039GuidFor -Seed 'mining-d01-realtime'
                    displayName = 'mining-d01-realtime'
                    properties = [pscustomobject]@{ queryServiceUri = 'https://trd-test.z2.kusto.fabric.microsoft.com' }
                }
            }

            if ($Method -eq 'Post' -and $Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces') {
                $request = $Body | ConvertFrom-Json -Depth 100
                $workspace = [pscustomobject]@{
                    id          = $global:T039_WorkspaceId
                    displayName = $request.displayName
                }
                [void]$global:T039_Workspaces.Add($workspace)
                return [pscustomobject]@{ id = $global:T039_WorkspaceId }
            }

            if ($Method -eq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T039_WorkspaceId)/assignToCapacity") {
                return $null
            }

            foreach ($itemDef in $global:T039_ItemDefinitions) {
                if ($Method -eq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T039_WorkspaceId)$($itemDef.UriSuffix)") {
                    [void]$global:T039_RequestLog.Add([pscustomobject]@{
                            Uri  = $Uri
                            Body = $Body
                        })

                    $request = $Body | ConvertFrom-Json -Depth 100
                    $item = New-T039Item -Id (New-T039GuidFor -Seed $request.displayName) -DisplayName $request.displayName -Type $itemDef.Type
                    [void]$global:T039_Items.Add($item)
                    return [pscustomobject]@{ id = $item.id }
                }
            }

            if ($Method -eq 'Post' -and $Uri -like "https://api.fabric.microsoft.com/v1/workspaces/$($global:T039_WorkspaceId)/kqlDatabases/*/shortcuts") {
                $request = $Body | ConvertFrom-Json -Depth 100
                [void]$global:T039_RequestLog.Add([pscustomobject]@{
                        Uri  = $Uri
                        Body = $Body
                    })
                return [pscustomobject]@{ name = $request.name }
            }

            if ($Method -eq 'Post' -and $Uri -eq 'https://trd-test.z2.kusto.fabric.microsoft.com/v1/rest/mgmt') {
                $request = $Body | ConvertFrom-Json
                [void]$global:T039_RequestLog.Add([pscustomobject]@{
                        Uri = $Uri
                        Body = $Body
                    })
                if ($request.csl -like '.show table * policy ingestiontime') {
                    return [pscustomobject]@{
                        Tables = @([pscustomobject]@{
                                Rows = @(,@('IngestionTimePolicy', 'entity', '{"IsEnabled":true}'))
                            })
                    }
                }
                return [pscustomobject]@{}
            }

            if ($Method -eq 'Post' -and $Uri -like "https://api.fabric.microsoft.com/v1/workspaces/$($global:T039_WorkspaceId)/items/*/updateDefinition") {
                [void]$global:T039_RequestLog.Add([pscustomobject]@{
                        Uri  = $Uri
                        Body = $Body
                    })
                return $null
            }

            throw "Unexpected Invoke-RestMethod invocation: $Method $Uri"
        }
    }
}

Describe 'provision-fabric-items.ps1 (T039)' {

    Context 'Parameter validation' {
        It 'throws when -SubscriptionId is not supplied' {
            { & $script:ProvisionScript } | Should -Throw
        }
    }

    Context 'Idempotency: workspace and all items already exist' {
        BeforeEach {
            Set-ProvisionFabricMocks -WorkspaceExists -ItemsExist
        }

        It 'keeps WhatIf free of Fabric writes and nested capacity/context mutations' {
            & $script:ProvisionScript -SubscriptionId $script:SubscriptionId -ResourceGroupName $script:ResourceGroupName -FabricCapacityName $script:FabricCapacityName -FabricWorkspaceName $script:WorkspaceName -WhatIf | Out-Null
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -in @('Post', 'Put', 'Patch', 'Delete') }
            Should -Invoke az -Times 0 -ParameterFilter { $args -contains 'invoke-action' -or $args[1] -eq 'set' }
            Should -Invoke az -Times 1 -Exactly -ParameterFilter { $args[0] -eq 'resource' -and $args -contains '--subscription' -and $args -contains $global:T039_SubscriptionId }
        }

        It 'reuses every existing Fabric item and only replays workspace assignment' {
            $result = & $script:ProvisionScript `
                -SubscriptionId $script:SubscriptionId `
                -ResourceGroupName $script:ResourceGroupName `
                -FabricCapacityName $script:FabricCapacityName `
                -FabricWorkspaceName $script:WorkspaceName `
                -TeamsTeamId $script:TeamsTeamId `
                -TeamsChannelId $script:TeamsChannelId `
                -OpsNotebookItemId $script:OpsNotebookItemId

            $result.FabricWorkspaceId | Should -Be $script:WorkspaceId
            $result.WorkspaceStatus | Should -Be 'Existing'
            ($result.Items | Measure-Object).Count | Should -Be 12
            @($result.Items.Status | Select-Object -Unique | Sort-Object) | Should -Be @('Existing', 'Updated')

            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter {
                $Method -eq 'Post' -and $Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces'
            }
            Should -Invoke -CommandName Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
                $Method -eq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/assignToCapacity"
            }
            # Even when every item already exists, the DataAgent's definition is refreshed
            # (UpdateDefinitionIfExists) and the 5 KQL shortcuts are re-asserted every run --
            # these are the only other POST calls expected in the reuse path.
            Should -Invoke -CommandName Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
                $Method -eq 'Post' -and $Uri -like "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/items/*/updateDefinition"
            }
            Should -Invoke -CommandName Invoke-RestMethod -Times 5 -Exactly -ParameterFilter {
                $Method -eq 'Post' -and $Uri -like "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/kqlDatabases/*/shortcuts"
            }
            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter {
                $Method -eq 'Post' -and $Uri -ne "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/assignToCapacity" -and
                $Uri -notlike "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/items/*/updateDefinition" -and
                $Uri -notlike "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/kqlDatabases/*/shortcuts"
            }
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'get-access-token'
            }
        }
    }

    Context 'Idempotency: create-if-absent path' {
        BeforeEach {
            Set-ProvisionFabricMocks
        }

        It 'creates the workspace and each Fabric item exactly once' {
            $result = & $script:ProvisionScript `
                -SubscriptionId $script:SubscriptionId `
                -ResourceGroupName $script:ResourceGroupName `
                -FabricCapacityName $script:FabricCapacityName `
                -FabricWorkspaceName $script:WorkspaceName `
                -TeamsTeamId $script:TeamsTeamId `
                -TeamsChannelId $script:TeamsChannelId `
                -OpsNotebookItemId $script:OpsNotebookItemId

            $result.WorkspaceStatus | Should -Be 'Created'
            ($result.Items | Measure-Object).Count | Should -Be 12
            @($result.Items.Status | Select-Object -Unique) | Should -HaveCount 1
            (@($result.Items.Status | Select-Object -Unique))[0] | Should -Be 'Created'

            Should -Invoke -CommandName Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
                $Method -eq 'Post' -and $Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces'
            }
            Should -Invoke -CommandName Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
                $Method -eq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/assignToCapacity"
            }
            foreach ($itemDef in $script:ItemDefinitions) {
                Should -Invoke -CommandName Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
                    $Method -eq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)$($itemDef.UriSuffix)"
                }
            }

            $semanticModelUri = "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/semanticModels"
            $lakehouseId = New-T039GuidFor -Seed 'triatwin_dev_lakehouse'
            $semanticModelRequestBody = ($global:T039_RequestLog | Where-Object { $_.Uri -eq $semanticModelUri } | Select-Object -First 1).Body
            $semanticModelRequest = ($semanticModelRequestBody | ConvertFrom-Json -Depth 100)
            $semanticExpressionsPart = @($semanticModelRequest.definition.parts | Where-Object { $_.path -eq 'definition/expressions.tmdl' })[0]
            $semanticExpressions = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($semanticExpressionsPart.payload))
            $semanticExpressions | Should -Match ([regex]::Escape("https://onelake.dfs.fabric.microsoft.com/$($script:WorkspaceId)/$lakehouseId"))

            $reportUri = "https://api.fabric.microsoft.com/v1/workspaces/$($script:WorkspaceId)/reports"
            $semanticModelId = New-T039GuidFor -Seed 'triatwin-dev-athlete-trends-semanticmodel'
            $reportRequestBody = ($global:T039_RequestLog | Where-Object { $_.Uri -eq $reportUri } | Select-Object -First 1).Body
            $reportRequest = ($reportRequestBody | ConvertFrom-Json -Depth 100)
            $reportDefinitionPart = @($reportRequest.definition.parts | Where-Object { $_.path -eq 'definition.pbir' })[0]
            $reportDefinition = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($reportDefinitionPart.payload))
            $reportDefinition | Should -Match ([regex]::Escape("semanticmodelid=$semanticModelId"))
        }
    }

    Context 'Isolated mining streaming' {
        BeforeEach {
            $global:T039_ItemDefinitions = @(
                @{ Type = 'Eventhouse'; DisplayName = 'mining-d01-eventhouse'; UriSuffix = '/eventhouses' },
                @{ Type = 'KQLDatabase'; DisplayName = 'mining-d01-realtime'; UriSuffix = '/kqlDatabases' },
                @{ Type = 'Eventstream'; DisplayName = 'mining-d01-eventstream'; UriSuffix = '/items' }
            )
            Set-ProvisionFabricMocks -WorkspaceExists
            $script:MiningArguments = @{
                SubscriptionId = $script:SubscriptionId
                FabricCapacityName = $script:FabricCapacityName
                Profile = 'MiningStreaming'
                ExistingWorkspaceId = $script:WorkspaceId
                TenantId = $global:T039_TenantId
                NamePrefix = 'mining-d01'
                ReceiptPath = Join-Path $TestDrive "$([guid]::NewGuid()).jsonl"
            }
        }

        It 'creates only three isolated items and binds raw destinations to the new database' {
            $result = & $script:ProvisionScript @script:MiningArguments
            $result.status | Should -Be 'ItemsCreatedNotIngestionVerified'
            Should -Invoke Invoke-RestMethod -Times 3 -Exactly -ParameterFilter { $Method -eq 'Post' -and $Uri -like 'https://api.fabric.microsoft.com/*' }
            Should -Invoke Invoke-RestMethod -Times 4 -Exactly -ParameterFilter { $Method -eq 'Post' -and $Uri -like 'https://*.kusto.fabric.microsoft.com/v1/rest/mgmt' }
            Should -Invoke az -Times 0 -ParameterFilter { $args[0] -eq 'resource' -or $args[1] -eq 'set' }
            $requests = @($global:T039_RequestLog | ForEach-Object { $_.Body | ConvertFrom-Json -Depth 100 })
            $database = $requests | Where-Object displayName -eq 'mining-d01-realtime'
            $propertiesPart = $database.definition.parts | Where-Object path -eq 'DatabaseProperties.json'
            $properties = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($propertiesPart.payload)) | ConvertFrom-Json
            $properties.parentEventhouseItemId | Should -Be $result.eventhouseId
            $stream = $requests | Where-Object displayName -eq 'mining-d01-eventstream'
            $topologyPart = $stream.definition.parts | Where-Object path -eq 'eventstream.json'
            $topology = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($topologyPart.payload)) | ConvertFrom-Json -Depth 100
            @($topology.destinations.properties.itemId | Select-Object -Unique) | Should -Be @($result.databaseId)
            @($topology.operators.properties.conditions.value.value | Sort-Object) | Should -Be @('PlantStateEvent', 'PlantTelemetry')
            @($topology.sources) | Should -HaveCount 1
            $topology.sources[0].name | Should -Be 'mining_custom_endpoint'
            $policyCommands = @($global:T039_RequestLog | Where-Object { $_.Uri -like 'https://*.kusto.fabric.microsoft.com/v1/rest/mgmt' } | ForEach-Object { ($_.Body | ConvertFrom-Json).csl })
            @($policyCommands | Where-Object { $_ -like '.alter table * policy ingestiontime true' }) | Should -HaveCount 2
            @($policyCommands | Where-Object { $_ -like '.show table * policy ingestiontime' }) | Should -HaveCount 2
            $receipt = Get-Content -LiteralPath $script:MiningArguments.ReceiptPath | ForEach-Object { $_ | ConvertFrom-Json }
            @($receipt | Where-Object status -eq 'Created') | Should -HaveCount 3
            @($receipt | Where-Object status -eq 'IngestionTimePolicyEnabled') | Should -HaveCount 2
            $receipt[-1].status | Should -Be 'ItemsCreatedNotIngestionVerified'
        }

        It 'keeps WhatIf free of writes and receipts, including capacity operations' {
            $result = & $script:ProvisionScript @script:MiningArguments -WhatIf
            $result.status | Should -Be 'WhatIf'
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -ne 'Get' }
            Should -Invoke az -Times 0 -ParameterFilter { $args[0] -eq 'resource' -or $args[1] -eq 'set' }
            Test-Path -LiteralPath $script:MiningArguments.ReceiptPath | Should -BeFalse
        }

        It 'rejects a workspace on a different capacity without making writes' {
            Mock Invoke-RestMethod -ParameterFilter { $Method -eq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:T039_WorkspaceId)" } -MockWith {
                [pscustomobject]@{ id = $global:T039_WorkspaceId; capacityId = 'wrong-capacity' }
            }
            { & $script:ProvisionScript @script:MiningArguments } | Should -Throw '*not on the explicitly selected capacity*'
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -ne 'Get' }
        }

        It 'refuses to adopt existing items rather than updating or repointing them' {
            [void]$global:T039_Items.Add((New-T039Item -Id ([guid]::NewGuid()) -DisplayName 'mining-d01-eventstream' -Type 'Eventstream'))
            { & $script:ProvisionScript @script:MiningArguments } | Should -Throw '*never adopts or updates*'
            Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -ne 'Get' }
        }

        It 'does not retry unknown create delivery and blocks reuse of its receipt' {
            Mock Invoke-RestMethod -ParameterFilter { $Method -eq 'Post' } -MockWith { throw 'Connection interrupted; delivery unknown.' }
            { & $script:ProvisionScript @script:MiningArguments } | Should -Throw '*delivery unknown*'
            Should -Invoke Invoke-RestMethod -Times 1 -Exactly -ParameterFilter { $Method -eq 'Post' }
            $receipt = Get-Content -LiteralPath $script:MiningArguments.ReceiptPath | ForEach-Object { $_ | ConvertFrom-Json }
            $receipt[-1].status | Should -Be 'Unresolved'
            { & $script:ProvisionScript @script:MiningArguments } | Should -Throw '*ReceiptPath already exists*'
            Should -Invoke Invoke-RestMethod -Times 1 -Exactly -ParameterFilter { $Method -eq 'Post' }
        }
    }
}
