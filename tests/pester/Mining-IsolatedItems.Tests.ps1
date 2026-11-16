#Requires -Version 7.0
BeforeAll {
    $script:workspace = '4a809e56-42a8-4c30-a84f-83a47dd8793f'
    $script:lakehouse = '11111111-2222-4333-8444-555555555555'
    $script:modelId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    $script:agentId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
    $script:lakehouseId = 'cccccccc-dddd-4eee-8fff-000000000001'
    $script:modulePath = Join-Path $PSScriptRoot '..\..' 'scripts\fabric\MiningIsolatedItems.psm1'
    $script:modelGenerator = Join-Path $PSScriptRoot '..\..' 'scripts\fabric\New-MiningAnalyticsDefinition.ps1'
    $script:agentGenerator = Join-Path $PSScriptRoot '..\..' 'scripts\fabric\New-MiningDataAgentDefinition.ps1'
    Import-Module $script:modulePath -Force

    function New-MiningBootstrapTestClient {
        $workspaceId = $script:workspace
        $modelId = $script:modelId
        $agentId = $script:agentId
        $lakehouseId = $script:lakehouseId
        $operationId = 'eeeeeeee-ffff-4000-8111-222222222222'
        $state = @{
            Calls = [Collections.Generic.List[object]]::new()
            Items = [Collections.Generic.List[object]]::new()
            Definitions = @{}
            LostCreateResponse = $false
            LostPublishResponse = $false
            AgentDefinitionMismatch = $false
            Lakehouse = $false
            LakehouseCreateFailure = $false
            AsyncModel = $false
            OperationPolls = 0
        }
        $request = {
            param($Method, $Uri, $Body)
            $null = $state.Calls.Add([pscustomobject]@{ Method = $Method; Uri = $Uri; Body = $Body })
            if ($Method -ieq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId") {
                return @{ statusCode = 200; headers = @{}; body = @{ id = $workspaceId } }
            }
            if ($Method -ieq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/operations/$operationId") {
                $state.OperationPolls++
                $status = if ($state.OperationPolls -eq 1) { 'Running' } else { 'Succeeded' }
                return @{ statusCode = 200; headers = @{ 'Retry-After' = '0' }; body = @{ status = $status } }
            }
            if ($Method -ieq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/operations/$operationId/result") {
                return @{ statusCode = 200; headers = @{}; body = @{ id = $modelId } }
            }
            if ($Method -ieq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/lakehouses/$lakehouseId") {
                return @{ statusCode = 200; headers = @{}; body = @{
                        id = $lakehouseId; workspaceId = $workspaceId
                        type = 'Lakehouse'; displayName = 'mining_d01_static_lakehouse'
                        properties = @{
                            defaultSchema = 'dbo'
                            sqlEndpointProperties = @{
                                id = 'dddddddd-eeee-4fff-8000-000000000002'
                                provisioningStatus = 'Success'
                                connectionString = 'mock.datawarehouse.fabric.microsoft.com'
                            }
                        }
                    } }
            }
            if ($Method -ieq 'Get' -and $Uri -like "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/items*") {
                return @{ statusCode = 200; headers = @{}; body = @{ value = @($state.Items.ToArray()) } }
            }
            if ($Method -ieq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/lakehouses") {
                if ($state.LakehouseCreateFailure) {
                    return @{ statusCode = 400; headers = @{}; body = @{
                            errorCode = 'CapacityNotAvailable'; message = 'Do not log this response body.'
                        } }
                }
                $requestBody = $Body | ConvertFrom-Json -AsHashtable -Depth 20
                $state.Lakehouse = $true
                $item = [pscustomobject]@{
                    id = $lakehouseId; type = 'Lakehouse'
                    displayName = $requestBody.displayName; workspaceId = $workspaceId
                }
                $state.Items.Add($item)
                return @{ statusCode = 201; headers = @{}; body = $item }
            }
            if ($Method -ieq 'Post' -and $Uri -match '/items/([^/]+)/getDefinition$') {
                $id = $Matches[1]
                return @{ statusCode = 200; headers = @{}; body = @{ definition = $state.Definitions[$id] } }
            }
            if ($Method -ieq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/semanticModels") {
                if ($state.LostCreateResponse) { throw 'Mocked lost create response.' }
                $requestBody = $Body | ConvertFrom-Json -AsHashtable -Depth 100
                $item = [pscustomobject]@{
                    id = $modelId; type = 'SemanticModel'
                    displayName = $requestBody.displayName; workspaceId = $workspaceId
                }
                $state.Items.Add($item)
                $state.Definitions[$modelId] = $requestBody.definition
                if ($state.AsyncModel) {
                    return @{ statusCode = 202; headers = @{
                            'x-ms-operation-id' = $operationId; 'Retry-After' = '0'
                        }; body = $null }
                }
                return @{ statusCode = 201; headers = @{}; body = @{ id = $modelId } }
            }
            if ($Method -ieq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/dataAgents") {
                $requestBody = $Body | ConvertFrom-Json -AsHashtable -Depth 100
                $item = [pscustomobject]@{
                    id = $agentId; type = 'DataAgent'
                    displayName = $requestBody.displayName; workspaceId = $workspaceId
                }
                $state.Items.Add($item)
                $state.Definitions[$agentId] = $requestBody.definition
                if ($state.AgentDefinitionMismatch) {
                    $state.Definitions[$agentId].parts += @{
                        path = '.platform'; payloadType = 'InlineBase64'
                        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
                    }
                }
                return @{ statusCode = 201; headers = @{}; body = @{ id = $agentId } }
            }
            if ($Method -ieq 'Post' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/dataAgents/$agentId/staging/publish") {
                $publish = $Body | ConvertFrom-Json -AsHashtable
                $definition = $state.Definitions[$agentId]
                $parts = [Collections.Generic.List[object]]::new()
                foreach ($part in $definition.parts) {
                    $parts.Add($part)
                    if ($part.path -like 'Files/Config/draft/*') {
                        $parts.Add(@{
                            path = $part.path.Replace('Files/Config/draft/', 'Files/Config/published/')
                            payload = $part.payload
                            payloadType = 'InlineBase64'
                        })
                    }
                }
                $publishInfo = @{
                    '$schema' = '1.0.0'; description = $publish.publishedDescription
                } | ConvertTo-Json -Compress
                $parts.Add(@{
                    path = 'Files/Config/publish_info.json'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($publishInfo))
                    payloadType = 'InlineBase64'
                })
                $definition.parts = $parts.ToArray()
                $state.Definitions[$agentId] = $definition
                if ($state.LostPublishResponse) { throw 'Mocked lost publish response.' }
                return @{ statusCode = 200; headers = @{}; body = @{ publishedDescription = $publish.publishedDescription } }
            }
            throw "Unexpected mocked Fabric request: $Method $Uri"
        }.GetNewClosure()
        return @{
            State = $state
            Client = @{ request = $request; sleep = { param($Seconds) } }
        }
    }

    function Invoke-TestBootstrap($Client, [string]$ReceiptPath, [switch]$Apply) {
        Invoke-MiningIsolatedNativeItems -WorkspaceId $script:workspace -LakehouseId $script:lakehouse `
            -ReceiptPath $ReceiptPath -Client $Client -Apply:$Apply
    }

    function New-MiningExistingDraftTestClient {
        $fixture = New-MiningBootstrapTestClient
        $fixture.State.Items.Add([pscustomobject]@{
            id = $script:modelId; type = 'SemanticModel'
            displayName = 'mining-d01-topology-semanticmodel'; workspaceId = $script:workspace
        })
        $fixture.State.Items.Add([pscustomobject]@{
            id = $script:agentId; type = 'DataAgent'
            displayName = 'mining-d01-topology-dataagent'; workspaceId = $script:workspace
        })
        $model = & $script:modelGenerator -WorkspaceId $script:workspace -LakehouseId $script:lakehouse `
            -DefinitionKind SemanticModel
        $fixture.State.Definitions[$script:modelId] = $model.SemanticModelRequest.definition
        $agent = & $script:agentGenerator -WorkspaceId $script:workspace -SemanticModelId $script:modelId |
            ConvertFrom-Json -AsHashtable -Depth 100
        $fixture.State.Definitions[$script:agentId] = $agent.definition
        return $fixture
    }
}

Describe 'Isolated Mining native items' {
    It 'does not treat no missing paths as payload verification or permission to repair' {
        $fixture = New-MiningExistingDraftTestClient
        $definition = $fixture.State.Definitions[$script:agentId]
        $sourcePart = $definition.parts | Where-Object path -Like '*/datasource.json'
        $source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($sourcePart.payload)) |
            ConvertFrom-Json -AsHashtable -Depth 100
        $source.artifactId = 'dddddddd-eeee-4fff-8000-000000000003'
        $sourcePart.payload = [Convert]::ToBase64String(
            [Text.Encoding]::UTF8.GetBytes(($source | ConvertTo-Json -Depth 100 -Compress)))
        # Match the reported path set only; these are synthetic extra payloads,
        # not a recognized legacy preimage.
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
        $fewshotsPath = 'Files/Config/draft/semantic-model-Mining D01 topology semantic model/fewshots.json'
        $definition.parts += @(
            @{ path = $fewshotsPath; payload = $payload; payloadType = 'InlineBase64' }
            @{ path = '.platform'; payload = $payload; payloadType = 'InlineBase64' }
        )
        $receipt = Join-Path $TestDrive 'path-evidence-only.jsonl'
        $failure = $null
        try { Invoke-TestBootstrap $fixture.Client $receipt -Apply } catch { $failure = $_.Exception.Message }
        $failure | Should -BeExactly "Data Agent definition parts differ (missing: ; unexpected: .platform, $fewshotsPath)."

        # Removing the extras would expose a previously unchecked wrong model
        # binding, not make the saved datasource match the reviewed definition.
        $definition.parts = @($definition.parts | Where-Object { $_.path -notin @('.platform', $fewshotsPath) })
        { Invoke-TestBootstrap $fixture.Client $receipt -Apply } |
            Should -Throw '*Data Agent part*datasource.json*differ*reviewed definition*'
        @($fixture.State.Calls | Where-Object {
                $_.Method -ine 'Get' -and $_.Uri -notmatch '/getDefinition$'
            }) | Should -HaveCount 0
        Test-Path -LiteralPath $receipt | Should -BeFalse
    }

    It 'never reaches publication when Data Agent create readback fails definition verification' {
        $fixture = New-MiningBootstrapTestClient
        $fixture.State.AgentDefinitionMismatch = $true
        $receipt = Join-Path $TestDrive 'create-readback-mismatch.jsonl'
        { Invoke-TestBootstrap $fixture.Client $receipt -Apply } |
            Should -Throw '*Data Agent definition parts differ*'
        @($fixture.State.Calls | Where-Object Uri -Match '/dataAgents$') | Should -HaveCount 1
        @($fixture.State.Calls | Where-Object Uri -Match '/staging/publish$') | Should -HaveCount 0
        $records = @(Get-Content -LiteralPath $receipt | ForEach-Object { $_ | ConvertFrom-Json })
        $createRecords = @($records | Where-Object operation -EQ 'DataAgentCreate')
        $createRecords[-1].status | Should -BeExactly 'Unresolved'
        @($createRecords | Where-Object status -In @('Verified', 'Reconciled')) | Should -HaveCount 0
        @($records | Where-Object operation -EQ 'DataAgentPublish') | Should -HaveCount 0
    }

    It 'blocks a stale <SourceFolder> draft without receipts, including repeat attempts (Apply=<Apply>)' -ForEach @(
        @{ SourceFolder = 'semantic_model-mining-d01-topology'; Apply = $false }
        @{ SourceFolder = 'semantic_model-mining-d01-topology'; Apply = $true }
        @{ SourceFolder = 'semantic-model-Mining D01 topology semantic model'; Apply = $false }
        @{ SourceFolder = 'semantic-model-Mining D01 topology semantic model'; Apply = $true }
    ) {
        $fixture = New-MiningExistingDraftTestClient
        $definition = $fixture.State.Definitions[$script:agentId]
        ($definition.parts | Where-Object path -Like '*/datasource.json').path =
            "Files/Config/draft/$SourceFolder/datasource.json"
        # Synthetic unsupported parts reproduce the reported path shape, not a
        # captured cloud preimage or evidence that .platform can be ignored.
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
        $definition.parts += @(
            @{ path = "Files/Config/draft/$SourceFolder/fewshots.json"; payload = $payload; payloadType = 'InlineBase64' }
            @{ path = '.platform'; payload = $payload; payloadType = 'InlineBase64' }
        )
        $receipt = Join-Path $TestDrive 'missing-native.jsonl'
        foreach ($attempt in 1..2) {
            { Invoke-TestBootstrap $fixture.Client $receipt -Apply:$Apply } |
                Should -Throw '*Data Agent definition parts differ*'
        }
        @($fixture.State.Calls | Where-Object {
                $_.Method -ine 'Get' -and $_.Uri -notmatch '/getDefinition$'
            }) | Should -HaveCount 0
        Test-Path -LiteralPath $receipt | Should -BeFalse
    }

    It 'does not adopt or publish even a corrected unpublished draft without its ownership receipt' {
        $fixture = New-MiningExistingDraftTestClient
        $receipt = Join-Path $TestDrive 'unowned-native.jsonl'
        { Invoke-TestBootstrap $fixture.Client $receipt } |
            Should -Throw '*draft is not published; use the explicit apply path*'
        foreach ($attempt in 1..2) {
            { Invoke-TestBootstrap $fixture.Client $receipt -Apply } |
                Should -Throw '*Refusing to publish a pre-existing, unowned Data Agent draft*'
        }
        @($fixture.State.Calls | Where-Object {
                $_.Method -ine 'Get' -and $_.Uri -notmatch '/getDefinition$'
            }) | Should -HaveCount 0
        Test-Path -LiteralPath $receipt | Should -BeFalse
    }

    It 'does not ignore an extra <ExtraPart> part or mutate the existing draft' -ForEach @(
        @{ ExtraPart = 'Files/Config/draft/semantic-model-Mining D01 topology semantic model/fewshots.json' }
        @{ ExtraPart = '.platform' }
        @{ ExtraPart = 'Files/Config/publish_info.json' }
        @{ ExtraPart = 'Files/Config/published/stage_config.json' }
    ) {
        $fixture = New-MiningExistingDraftTestClient
        $fixture.State.Definitions[$script:agentId].parts += @{
            path = $ExtraPart; payloadType = 'InlineBase64'
            payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
        }
        $receipt = Join-Path $TestDrive 'unexpected-part.jsonl'
        { Invoke-TestBootstrap $fixture.Client $receipt -Apply } |
            Should -Throw '*Data Agent definition parts differ*'
        @($fixture.State.Calls | Where-Object {
                $_.Method -ine 'Get' -and $_.Uri -notmatch '/getDefinition$'
            }) | Should -HaveCount 0
        Test-Path -LiteralPath $receipt | Should -BeFalse
    }

    It 'reports only missing and unexpected Data Agent definition paths' {
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
        $expected = @{ parts = @(@{
                    path = 'Files/Config/data_agent.json'; payload = $payload; payloadType = 'InlineBase64'
                }) }
        $actual = @{ parts = @(@{
                    path = '.platform'; payload = $payload; payloadType = 'InlineBase64'
                }) }
        InModuleScope -ModuleName 'MiningIsolatedItems' -Parameters @{
            expected = $expected; actual = $actual
        } -ScriptBlock {
            { Assert-MiningAgentDefinition $expected $actual } |
                Should -Throw '*missing: Files/Config/data_agent.json; unexpected: .platform*'
        }
    }

    It 'creates exact model and agent definitions, publishes once, and verifies a repeat run read-only' {
        $fixture = New-MiningBootstrapTestClient
        $receipt = Join-Path $TestDrive 'native.jsonl'
        $result = Invoke-TestBootstrap $fixture.Client $receipt -Apply

        $result.Status | Should -BeExactly 'Verified'
        $result.SemanticModelId | Should -BeExactly $script:modelId
        $result.DataAgentId | Should -BeExactly $script:agentId
        @($fixture.State.Calls | Where-Object Uri -Match '/semanticModels$') | Should -HaveCount 1
        @($fixture.State.Calls | Where-Object Uri -Match '/dataAgents$') | Should -HaveCount 1
        @($fixture.State.Calls | Where-Object Uri -Match '/staging/publish$') | Should -HaveCount 1
        $records = @(Get-Content -LiteralPath $receipt | ForEach-Object { $_ | ConvertFrom-Json })
        @($records | Where-Object { $_.status -eq 'Verified' }) | Should -HaveCount 3

        $writePath = '/semanticModels$|/dataAgents$|/staging/publish$'
        $beforeWrites = @($fixture.State.Calls | Where-Object Uri -Match $writePath).Count
        $repeat = Invoke-TestBootstrap $fixture.Client $receipt
        $repeat.Status | Should -BeExactly 'Verified'
        @($fixture.State.Calls | Where-Object Uri -Match $writePath).Count | Should -Be $beforeWrites
    }

    It 'does not create after an ambiguous pre-dispatch failure and missing item' {
        $fixture = New-MiningBootstrapTestClient
        $fixture.State.LostCreateResponse = $true
        $receipt = Join-Path $TestDrive 'unresolved.jsonl'
        { Invoke-TestBootstrap $fixture.Client $receipt -Apply } | Should -Throw '*Mocked lost create response*'
        @($fixture.State.Calls | Where-Object Uri -Match '/semanticModels$') | Should -HaveCount 1

        $fixture.State.LostCreateResponse = $false
        { Invoke-TestBootstrap $fixture.Client $receipt -Apply } | Should -Throw '*unresolved pre-dispatch/response state*'
        @($fixture.State.Calls | Where-Object Uri -Match '/semanticModels$') | Should -HaveCount 1
    }

    It 'waits for a documented model create operation before reading back and continuing' {
        $fixture = New-MiningBootstrapTestClient
        $fixture.State.AsyncModel = $true
        $result = Invoke-TestBootstrap $fixture.Client (Join-Path $TestDrive 'native-lro.jsonl') -Apply
        $result.Status | Should -BeExactly 'Verified'
        $fixture.State.OperationPolls | Should -Be 2
        @($fixture.State.Calls | Where-Object Uri -Match '/operations/.+/result$') | Should -HaveCount 1
        @($fixture.State.Calls | Where-Object Uri -Match '/semanticModels$') | Should -HaveCount 1
    }

    It 'rejects a workspace substitution before making any request' {
        $fixture = New-MiningBootstrapTestClient
        $otherWorkspace = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
        { Invoke-MiningIsolatedNativeItems -WorkspaceId $otherWorkspace -LakehouseId $script:lakehouse `
                -ReceiptPath (Join-Path $TestDrive 'wrong.jsonl') -Client $fixture.Client -Apply } |
            Should -Throw '*Only the approved isolated workspace*'
        $fixture.State.Calls | Should -HaveCount 0
    }

    It 'creates only the schema-enabled isolated Lakehouse and reuses its verified identity' {
        $fixture = New-MiningBootstrapTestClient
        $receipt = Join-Path $TestDrive 'lakehouse.jsonl'
        $lakehouse = Ensure-MiningIsolatedLakehouse -WorkspaceId $script:workspace `
            -ReceiptPath $receipt -Client $fixture.Client -Apply
        $lakehouse.Lakehouse.id | Should -BeExactly $script:lakehouseId
        $lakehouse.Status | Should -BeExactly 'CreatedAndVerified'
        $lakehouse.Target.SourceSchema | Should -BeExactly 'dbo'
        $lakehouse.Target.SqlEndpointId | Should -BeExactly 'dddddddd-eeee-4fff-8000-000000000002'
        $create = $fixture.State.Calls | Where-Object Uri -Match '/lakehouses$' | Select-Object -First 1
        $body = $create.Body | ConvertFrom-Json -AsHashtable
        $body.displayName | Should -BeExactly 'mining_d01_static_lakehouse'
        $body.creationPayload.enableSchemas | Should -BeTrue

        $existing = Ensure-MiningIsolatedLakehouse -WorkspaceId $script:workspace `
            -ReceiptPath $receipt -Client $fixture.Client -Apply
        $existing.Status | Should -BeExactly 'VerifiedExisting'
        @($fixture.State.Calls | Where-Object Uri -Match '/lakehouses$') | Should -HaveCount 1
    }

    It 'blocks an unresolved Lakehouse create instead of resubmitting it' {
        $fixture = New-MiningBootstrapTestClient
        $workspaceId = $script:workspace
        $fixture.Client.request = {
            param($Method, $Uri, $Body)
            $null = $fixture.State.Calls.Add([pscustomobject]@{ Method = $Method; Uri = $Uri; Body = $Body })
            if ($Method -ieq 'Get' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$workspaceId/items") {
                return @{ statusCode = 200; headers = @{}; body = @{ value = @() } }
            }
            if ($Method -ieq 'Post' -and $Uri -like '*/lakehouses') { throw 'Mocked lost create response.' }
            throw "Unexpected mocked request $Method $Uri"
        }.GetNewClosure()
        $receipt = Join-Path $TestDrive 'lakehouse-unresolved.jsonl'
        { Ensure-MiningIsolatedLakehouse -WorkspaceId $script:workspace -ReceiptPath $receipt `
                -Client $fixture.Client -Apply } | Should -Throw '*Mocked lost create response*'
        { Ensure-MiningIsolatedLakehouse -WorkspaceId $script:workspace -ReceiptPath $receipt `
                -Client $fixture.Client -Apply } | Should -Throw '*unresolved pre-dispatch/response state*'
        @($fixture.State.Calls | Where-Object Uri -Match '/lakehouses$') | Should -HaveCount 1
    }

    It 'reports only the Fabric error code for a rejected Lakehouse create' {
        $fixture = New-MiningBootstrapTestClient
        $fixture.State.LakehouseCreateFailure = $true
        $receipt = Join-Path $TestDrive 'lakehouse-rejected.jsonl'
        $failure = $null
        try {
            Ensure-MiningIsolatedLakehouse -WorkspaceId $script:workspace -ReceiptPath $receipt `
                -Client $fixture.Client -Apply | Out-Null
        } catch { $failure = $_.Exception.Message }
        $failure | Should -BeExactly 'Lakehouse create returned HTTP 400 (CapacityNotAvailable).'
        $failure | Should -Not -Match 'Do not log this response body'
        $records = @(Get-Content -LiteralPath $receipt | ForEach-Object { $_ | ConvertFrom-Json })
        $records[-1].errorCode | Should -BeExactly 'CapacityNotAvailable'
    }
}
