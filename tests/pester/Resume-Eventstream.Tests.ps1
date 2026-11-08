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
}

Describe 'Guarded Eventstream recovery' {
    BeforeEach {
        $script:Topology = New-TestTopology
        $global:EventstreamTestArguments = $script:Arguments
        $global:EventstreamTestTopology = $script:Topology
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -notcontains '--subscription' -or $args -notcontains $global:EventstreamTestArguments.SubscriptionId) {
                throw 'Explicit subscription missing.'
            }
            if ($args -contains 'get-access-token') {
                return (@{ accessToken = 'test-token'; tenant = $global:EventstreamTestArguments.TenantId } | ConvertTo-Json)
            }
            return (@{ id = $global:EventstreamTestArguments.SubscriptionId; tenantId = $global:EventstreamTestArguments.TenantId } | ConvertTo-Json)
        }
        Mock Invoke-WebRequest {
            if ($Method -eq 'POST') {
                foreach ($stream in $global:EventstreamTestTopology.streams) { $stream.status = 'Running' }
                return @{ StatusCode = 200; Content = '' }
            }
            return @{ StatusCode = 200; Content = ($global:EventstreamTestTopology | ConvertTo-Json -Depth 20) }
        }
        Mock Start-Sleep {}
    }
    AfterEach {
        Remove-Variable EventstreamTestArguments, EventstreamTestTopology -Scope Global
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
