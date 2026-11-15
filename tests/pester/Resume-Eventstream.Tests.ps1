#Requires -Version 7.0
BeforeAll {
    $script:ResumeScript = Join-Path $PSScriptRoot '..\..\scripts\fabric\resume-eventstream.ps1'
    $script:Arguments = @{
        SubscriptionId = '00000000-0000-0000-0000-000000000001'
        TenantId = '00000000-0000-0000-0000-000000000002'
        WorkspaceId = '00000000-0000-0000-0000-000000000003'
        EventstreamId = '00000000-0000-0000-0000-000000000004'
        KqlDatabaseId = '00000000-0000-0000-0000-000000000005'
        TimeoutSeconds = 1
        PollIntervalSeconds = 1
    }
    $script:MiningArguments = @{
        SubscriptionId = '86677b6e-28fc-48e4-8988-5ab9e568eece'
        TenantId = 'ecd6dfda-d2ce-47a8-9901-e35f31fe18dd'
        WorkspaceId = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
        EventstreamId = '6fca8489-4a0d-452b-8df1-217b91b9b557'
        KqlDatabaseId = '62177ca4-73f8-4573-b0c6-8e9317e7dacc'
        TimeoutSeconds = 1; PollIntervalSeconds = 1; Profile = 'Mining'
    }
    function New-TestTopology {
        @{
            sources = @(@{ name = 'triathlon_custom_endpoint'; type = 'CustomEndpoint'; status = 'Running' })
            streams = @(
                @{ name = 'triathlon_main_stream'; type = 'DefaultStream'; status = 'Running'; inputNodes = @(@{ name = 'triathlon_custom_endpoint' }) }
                @{ name = 'racesplit_stream'; type = 'DerivedStream'; status = 'Paused'; inputNodes = @(@{ name = 'racesplit_filter' }) }
                @{ name = 'sessionmetric_stream'; type = 'DerivedStream'; status = 'Paused'; inputNodes = @(@{ name = 'sessionmetric_filter' }) }
            )
            destinations = @(
                @{ name = 'racesplit_direct_ingestion'; type = 'Eventhouse'; status = 'Running'; inputNodes = @(@{ name = 'racesplit_stream' }); properties = @{
                    dataIngestionMode = 'DirectIngestion'; workspaceId = $script:Arguments.WorkspaceId
                    itemId = $script:Arguments.KqlDatabaseId; tableName = 'RaceSplit'
                    mappingRuleName = 'racesplit_json_map'; connectionName = 'existing-racesplit'
                } }
                @{ name = 'sessionmetric_direct_ingestion'; type = 'Eventhouse'; status = 'Running'; inputNodes = @(@{ name = 'sessionmetric_stream' }); properties = @{
                    dataIngestionMode = 'DirectIngestion'; workspaceId = $script:Arguments.WorkspaceId
                    itemId = $script:Arguments.KqlDatabaseId; tableName = 'SessionMetric'
                    mappingRuleName = 'sessionmetric_json_map'; connectionName = 'existing-sessionmetric'
                } }
            )
        }
    }
    function New-MiningTestTopology {
        @{
            sources = @(@{ name = 'mining_custom_endpoint'; type = 'CustomEndpoint'; status = 'Running' })
            streams = @(
                @{ name = 'mining_main_stream'; type = 'DefaultStream'; status = 'Running'; inputNodes = @(@{ name = 'mining_custom_endpoint' }) }
                @{ name = 'mining_state_stream'; type = 'DerivedStream'; status = 'Paused'; inputNodes = @(@{ name = 'mining_state_filter' }) }
                @{ name = 'mining_telemetry_stream'; type = 'DerivedStream'; status = 'Paused'; inputNodes = @(@{ name = 'mining_telemetry_filter' }) }
            )
            operators = @(
                @{ name = 'mining_state_filter'; type = 'Filter'; inputNodes = @(@{ name = 'mining_main_stream' }); properties = @{ conditions = @(
                    @{ column = @{ node = 'mining_main_stream'; columnName = 'entityType'; columnPath = $null; expressionType = 'ColumnReference' }
                        operatorType = 'Equals'; value = @{ dataType = 'Nvarchar(max)'; value = 'PlantStateEvent'; expressionType = 'Literal' } }
                ) } }
                @{ name = 'mining_telemetry_filter'; type = 'Filter'; inputNodes = @(@{ name = 'mining_main_stream' }); properties = @{ conditions = @(
                    @{ column = @{ node = 'mining_main_stream'; columnName = 'entityType'; columnPath = $null; expressionType = 'ColumnReference' }
                        operatorType = 'Equals'; value = @{ dataType = 'Nvarchar(max)'; value = 'PlantTelemetry'; expressionType = 'Literal' } }
                ) } }
            )
            destinations = @(
                @{ name = 'mining_state_raw_ingestion'; type = 'Eventhouse'; status = 'Running'; inputNodes = @(@{ name = 'mining_state_stream' }); properties = @{
                    dataIngestionMode = 'DirectIngestion'; workspaceId = $script:MiningArguments.WorkspaceId
                    itemId = $script:MiningArguments.KqlDatabaseId; tableName = 'mining_PlantStateEvents'
                    mappingRuleName = 'mining_state_raw_json_map'; connectionName = 'existing-state'
                } }
                @{ name = 'mining_telemetry_raw_ingestion'; type = 'Eventhouse'; status = 'Running'; inputNodes = @(@{ name = 'mining_telemetry_stream' }); properties = @{
                    dataIngestionMode = 'DirectIngestion'; workspaceId = $script:MiningArguments.WorkspaceId
                    itemId = $script:MiningArguments.KqlDatabaseId; tableName = 'mining_TelemetryRaw'
                    mappingRuleName = 'mining_telemetry_raw_json_map'; connectionName = 'existing-telemetry'
                } }
            )
        }
    }
}

Describe 'Guarded Eventstream recovery' {
    BeforeEach {
        $script:Topology = New-TestTopology
        $global:EventstreamTestArguments = $script:Arguments
        $global:EventstreamTestTopology = $script:Topology
        $global:MiningCapacityState = 'Active'
        $global:MiningWorkspaceCapacity = 'bd00d528-b25d-4960-bd09-a70f8aa11e2c'
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -notcontains '--subscription' -or $args -notcontains $global:EventstreamTestArguments.SubscriptionId) {
                throw 'Explicit subscription missing.'
            }
            if ($args -contains 'get-access-token') {
                return (@{ accessToken = 'test-token'; tenant = $global:EventstreamTestArguments.TenantId } | ConvertTo-Json)
            }
            if ($args -contains 'resource') { return $global:MiningCapacityState }
            return (@{ id = $global:EventstreamTestArguments.SubscriptionId; tenantId = $global:EventstreamTestArguments.TenantId } | ConvertTo-Json)
        }
        Mock Invoke-WebRequest {
            if ($Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:EventstreamTestArguments.WorkspaceId)") {
                return @{ StatusCode = 200; Content = (@{ id = $global:EventstreamTestArguments.WorkspaceId; capacityId = $global:MiningWorkspaceCapacity } | ConvertTo-Json) }
            }
            if ($Method -eq 'POST') {
                foreach ($stream in $global:EventstreamTestTopology.streams) { $stream.status = 'Running' }
                return @{ StatusCode = 200; Content = '' }
            }
            return @{ StatusCode = 200; Content = ($global:EventstreamTestTopology | ConvertTo-Json -Depth 20) }
        }
        Mock Start-Sleep {}
    }
    AfterEach {
        Remove-Variable EventstreamTestArguments, EventstreamTestTopology, MiningCapacityState, MiningWorkspaceCapacity -Scope Global
    }

    It 'resumes once, preserves the last checkpoint by default, and verifies Running' {
        $result = & $script:ResumeScript @script:Arguments
        $result.Status | Should -Be 'Running'
        $result.Resumed.Count | Should -Be 2
        $result.IngestionVerified | Should -BeFalse
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'POST' -and $Uri -eq "https://api.fabric.microsoft.com/v1/workspaces/$($global:EventstreamTestArguments.WorkspaceId)/eventstreams/$($global:EventstreamTestArguments.EventstreamId)/resume" -and
            ($Body | ConvertFrom-Json).startType -eq 'WhenLastStopped'
        }

        Should -Invoke Invoke-WebRequest -Times 2 -Exactly -ParameterFilter { $Method -eq 'GET' }
    }

    It 'resumes only the exact Mining profile while preserving its checkpoint' {
        $global:EventstreamTestTopology = New-MiningTestTopology
        $global:EventstreamTestArguments = $script:MiningArguments
        $result = & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery
        $result.Status | Should -Be 'Running'
        $result.Resumed | Should -Contain 'mining_state_stream'
        $result.Resumed | Should -Contain 'mining_telemetry_stream'
        $result.IngestionVerified | Should -BeFalse
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'POST' -and ($Body | ConvertFrom-Json).startType -eq 'WhenLastStopped'
        }
    }

    It 'rejects a Mining mapping that points at a different raw schema' {
        $global:EventstreamTestTopology = New-MiningTestTopology
        $global:EventstreamTestArguments = $script:MiningArguments
        $global:EventstreamTestTopology.destinations[0].properties.mappingRuleName = 'wrong_mapping'
        { & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery } | Should -Throw '*Unexpected mining state Eventhouse reference*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'never resumes Mining under the default Triathlon profile' {
        $global:EventstreamTestTopology = New-MiningTestTopology
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*Unexpected Eventstream topology*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'defaults Mining to a read-only preflight' {
        $global:EventstreamTestArguments = $script:MiningArguments
        $global:EventstreamTestTopology = New-MiningTestTopology
        $result = & $script:ResumeScript @script:MiningArguments
        $result.Status | Should -Be 'PreflightPaused'
        $result.Paused.Count | Should -Be 2
        $result.IngestionVerified | Should -BeFalse
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'defers inactive capacity before any Fabric request' {
        $global:EventstreamTestArguments = $script:MiningArguments
        $global:MiningCapacityState = 'Paused'
        $result = & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery
        $result.Status | Should -Be 'DeferredCapacityNotActive'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
    }

    It 'fails closed on an unknown capacity state and forbids skipping the checkpoint' {
        $global:EventstreamTestArguments = $script:MiningArguments
        $global:MiningCapacityState = ''
        { & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery } | Should -Throw '*missing or unrecognized*'
        { & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery -StartType Now } | Should -Throw '*requires WhenLastStopped*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
    }

    It 'honors WhatIf for the explicitly enabled Mining write' {
        $global:EventstreamTestArguments = $script:MiningArguments
        $global:EventstreamTestTopology = New-MiningTestTopology
        $result = & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery -WhatIf
        $result.Status | Should -Be 'NotApplied'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'rejects a workspace on another capacity' {
        $global:EventstreamTestArguments = $script:MiningArguments
        $global:MiningWorkspaceCapacity = '00000000-0000-0000-0000-000000000099'
        { & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery } | Should -Throw '*not assigned*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'rejects a changed Mining filter or unexpected operator' {
        $global:EventstreamTestArguments = $script:MiningArguments
        $global:EventstreamTestTopology = New-MiningTestTopology
        $global:EventstreamTestTopology.operators[0].properties.conditions[0].value.value = 'PlantTelemetry'
        { & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery } | Should -Throw '*filter condition*'
        $global:EventstreamTestTopology = New-MiningTestTopology
        $global:EventstreamTestTopology.operators += @{ name = 'extra'; type = 'Filter' }
        { & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery } | Should -Throw '*Unexpected Mining operators*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'rejects a different Mining target' {
        $global:EventstreamTestArguments = $script:MiningArguments
        $arguments = $script:MiningArguments.Clone()
        $arguments.EventstreamId = '00000000-0000-0000-0000-000000000099'
        { & $script:ResumeScript @arguments -ApplyMiningRecovery } | Should -Throw '*approved exact scope*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
    }

    It 'rechecks capacity immediately before applying' {
        $global:EventstreamTestArguments = $script:MiningArguments
        $global:EventstreamTestTopology = New-MiningTestTopology
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -contains 'get-access-token') { return (@{ accessToken = 'test-token'; tenant = $global:EventstreamTestArguments.TenantId } | ConvertTo-Json) }
            if ($args -contains 'resource') {
                $global:MiningCapacityReads++
                if ($global:MiningCapacityReads -eq 1) { return 'Active' }
                return 'Paused'
            }
            return (@{ id = $global:EventstreamTestArguments.SubscriptionId; tenantId = $global:EventstreamTestArguments.TenantId } | ConvertTo-Json)
        }
        $global:MiningCapacityReads = 0
        try {
            $result = & $script:ResumeScript @script:MiningArguments -ApplyMiningRecovery
            $result.Status | Should -Be 'DeferredCapacityNotActive'
            Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
        } finally { Remove-Variable MiningCapacityReads -Scope Global }
    }

    It 'supports explicit Now without rewriting the definition or source' {
        & $script:ResumeScript @script:Arguments -StartType Now
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'POST' -and ($Body | ConvertFrom-Json).startType -eq 'Now' -and $Uri.AbsolutePath.EndsWith('/resume')
        }
    }

    It 'is idempotent when both derived streams are already Running' {
        foreach ($stream in $script:Topology.streams) { $stream.status = 'Running' }
        $result = & $script:ResumeScript @script:Arguments
        $result.Resumed.Count | Should -Be 0
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'does not mutate or report Running under WhatIf' {
        $result = & $script:ResumeScript @script:Arguments -WhatIf
        $result.Status | Should -Be 'NotApplied'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'rejects an unrelated supported source before any mutation' {
        $script:Topology.sources += @{ name = 'unrelated'; type = 'AzureEventHub'; status = 'Paused' }
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*Unexpected Eventstream topology*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'rejects a destination in another database' {
        $script:Topology.destinations[0].properties.itemId = '00000000-0000-0000-0000-000000000099'
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*Unexpected racesplit Eventhouse reference*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'rejects a broken destination input reference' {
        $script:Topology.destinations[1].inputNodes[0].name = 'unrelated_stream'
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*Unexpected sessionmetric Eventhouse reference*'
    }

    It 'refuses to repair a failed source or derived stream' {
        $script:Topology.sources[0].status = 'Failed'
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*must already be Running*'
        $script:Topology.sources[0].status = 'Running'
        $script:Topology.streams[1].status = 'Failed'
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*investigate before resuming*'
    }

    It 'surfaces destination warnings without claiming ingestion verification' {
        $script:Topology.destinations[0].status = 'Warning'
        $result = & $script:ResumeScript @script:Arguments -WarningVariable warnings
        $warnings.Count | Should -BeGreaterThan 0
        $result.IngestionVerified | Should -BeFalse
    }

    It 'stops on permission denial without disclosing the response body or retrying' {
        Mock Invoke-WebRequest {
            if ($Method -eq 'POST') { return @{ StatusCode = 403; Content = 'sensitive-service-body' } }
            return @{ StatusCode = 200; Content = ($global:EventstreamTestTopology | ConvertTo-Json -Depth 20) }
        }
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*HTTP 403*'
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter { $Method -eq 'POST' }
    }

    It 'rejects mismatched tenant before making Fabric requests' {
        Mock az {
            $global:LASTEXITCODE = 0
            return (@{ id = $global:EventstreamTestArguments.SubscriptionId; tenantId = 'wrong-tenant' } | ConvertTo-Json)
        }
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*requested tenant*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
    }

    It 'fails rather than declaring success when resume never reaches Running' {
        Mock Invoke-WebRequest {
            if ($Method -eq 'POST') { return @{ StatusCode = 200; Content = '' } }
            return @{ StatusCode = 200; Content = ($global:EventstreamTestTopology | ConvertTo-Json -Depth 20) }
        }
        { & $script:ResumeScript @script:Arguments } | Should -Throw '*Timed out*'
    }
}
