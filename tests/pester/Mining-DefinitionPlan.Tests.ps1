#Requires -Version 7.0
BeforeAll {
    $script:Planner = Join-Path $PSScriptRoot '..\..\scripts\fabric\plan-mining-definition.ps1'
    $script:Template = Join-Path $PSScriptRoot '..\..\infra\fabric\eventstream\eventstream.custom-endpoint.json'
    function Copy-Node($Node) {
        return ,($Node | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable)
    }
    function Write-Definition($Path, $Definition) {
        [IO.File]::WriteAllText($Path, ($Definition | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    }
    function Get-Hash($Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
}

Describe 'Offline mining definition plan' {
    BeforeEach {
        $script:ids = @{
            SubscriptionId = '00000000-0000-0000-0000-000000000001'
            TenantId = '00000000-0000-0000-0000-000000000002'
            WorkspaceId = '00000000-0000-0000-0000-000000000003'
            EventstreamId = '00000000-0000-0000-0000-000000000004'
            KqlDatabaseId = '00000000-0000-0000-0000-000000000005'
        }
        $raw = Get-Content -LiteralPath $script:Template -Raw
        $raw = $raw.Replace('{{EVENTHOUSE_WORKSPACE_ID}}', $script:ids.WorkspaceId).
            Replace('{{KQLDATABASE_ITEM_ID}}', $script:ids.KqlDatabaseId).
            Replace('{{SESSIONMETRIC_CONNECTION_NAME}}', 'triathlon-session').
            Replace('{{RACESPLIT_CONNECTION_NAME}}', 'triathlon-race')
        $script:baseline = $raw | ConvertFrom-Json -AsHashtable
        $script:desired = Copy-Node $script:baseline
        foreach ($route in @(
            @{ Prefix = 'mining_telemetry'; Entity = 'PlantTelemetry'; Table = 'mining_TelemetryRaw' },
            @{ Prefix = 'mining_state'; Entity = 'PlantStateEvent'; Table = 'mining_PlantStateEvents' }
        )) {
            $filter = Copy-Node $script:baseline.operators[0]
            $filter.name = "$($route.Prefix)_filter"
            $filter.properties.conditions[0].value.value = $route.Entity
            $stream = Copy-Node $script:baseline.streams[1]
            $stream.name = "$($route.Prefix)_stream"
            $stream.inputNodes[0].name = $filter.name
            $destination = Copy-Node $script:baseline.destinations[0]
            $destination.name = "$($route.Prefix)_direct_ingestion"
            $destination.inputNodes[0].name = $stream.name
            $destination.properties.tableName = $route.Table
            $destination.properties.mappingRuleName = "$($route.Prefix)_json_map"
            $destination.properties.connectionName = "$($route.Prefix)-connection"
            # The fixture does not establish a real mining input schema.
            $destination.Remove('inputSchemas')
            $script:desired.operators += $filter
            $script:desired.streams += $stream
            $script:desired.destinations += $destination
        }
        $script:baselinePath = Join-Path $TestDrive 'baseline.json'
        $script:currentPath = Join-Path $TestDrive 'current.json'
        $script:desiredPath = Join-Path $TestDrive 'desired.json'
        Write-Definition $script:baselinePath $script:baseline
        Write-Definition $script:currentPath $script:baseline
        Write-Definition $script:desiredPath $script:desired
        $script:arguments = $script:ids.Clone()
        $script:arguments.BaselinePath = $script:baselinePath
        $script:arguments.CurrentPath = $script:currentPath
        $script:arguments.DesiredPath = $script:desiredPath
        $script:arguments.BaselineSha256 = Get-Hash $script:baselinePath
        $script:arguments.DesiredSha256 = Get-Hash $script:desiredPath
        Mock Invoke-WebRequest { throw 'Unexpected network request.' }
    }

    It 'plans exactly the mining nodes without reporting hosted verification' {
        $result = & $script:Planner @script:arguments
        $result.Status | Should -Be 'ChangesPlannedOffline'
        $result.AddedNodes.Count | Should -Be 6
        $result.TargetVerified | Should -BeFalse
        $result.KqlVerified | Should -BeFalse
        $result.IngestionVerified | Should -BeFalse
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
    }

    It 'recognizes the exact desired snapshot as a no-op and verifies it offline' {
        Write-Definition $script:currentPath $script:desired
        $result = & $script:Planner @script:arguments
        $result.Status | Should -Be 'DefinitionMatchesOffline'
        $result.AddedNodes.Count | Should -Be 0
        (& $script:Planner @script:arguments -Mode Verify).Status | Should -Be 'DefinitionMatchesOffline'
    }

    It 'refuses a changed triathlon route and current drift' {
        $script:desired.destinations[0].properties.tableName = 'Other'
        Write-Definition $script:desiredPath $script:desired
        $script:arguments.DesiredSha256 = Get-Hash $script:desiredPath
        { & $script:Planner @script:arguments } | Should -Throw '*non-mining content*'
        $script:desired.destinations[0].properties.tableName = 'SessionMetric'
        Write-Definition $script:desiredPath $script:desired
        $script:arguments.DesiredSha256 = Get-Hash $script:desiredPath
        $script:baseline.sources[0].name = 'unexpected'
        Write-Definition $script:currentPath $script:baseline
        { & $script:Planner @script:arguments } | Should -Throw '*refusing drift*'
    }

    It 'refuses a wrong mining target or discriminator' {
        $script:desired.destinations[2].properties.itemId = '00000000-0000-0000-0000-000000000099'
        Write-Definition $script:desiredPath $script:desired
        $script:arguments.DesiredSha256 = Get-Hash $script:desiredPath
        { & $script:Planner @script:arguments } | Should -Throw '*mining destination*'
        $script:desired.destinations[2].properties.itemId = $script:ids.KqlDatabaseId
        $script:desired.operators[2].properties.conditions[0].value.value = 'SessionMetric'
        Write-Definition $script:desiredPath $script:desired
        $script:arguments.DesiredSha256 = Get-Hash $script:desiredPath
        { & $script:Planner @script:arguments } | Should -Throw '*mining discriminator*'
    }

    It 'rejects incomplete or extra mining topology' {
        $script:desired.streams = @($script:desired.streams | Where-Object { $_.name -ne 'mining_state_stream' })
        Write-Definition $script:desiredPath $script:desired
        $script:arguments.DesiredSha256 = Get-Hash $script:desiredPath
        { & $script:Planner @script:arguments } | Should -Throw '*unexpected topology*'
    }

    It 'rejects type or property-name case drift in the current snapshot' {
        $script:baseline.compatibilityLevel = 1.1
        Write-Definition $script:currentPath $script:baseline
        { & $script:Planner @script:arguments } | Should -Throw '*refusing drift*'
        $script:baseline.compatibilityLevel = '1.1'
        $script:baseline.Remove('compatibilityLevel')
        $script:baseline['CompatibilityLevel'] = '1.1'
        Write-Definition $script:currentPath $script:baseline
        { & $script:Planner @script:arguments } | Should -Throw '*refusing drift*'
    }

    It 'rejects unapproved hashes, uninstalled verification, and apply' {
        $script:arguments.DesiredSha256 = '0' * 64
        { & $script:Planner @script:arguments } | Should -Throw '*hash*'
        $script:arguments.DesiredSha256 = Get-Hash $script:desiredPath
        { & $script:Planner @script:arguments -Mode Verify } | Should -Throw '*does not match*'
        { & $script:Planner @script:arguments -Mode Apply } | Should -Throw '*Apply is blocked*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
    }
}

Describe 'Mining KQL ownership ledger' {
    BeforeAll {
        $script:SchemaPath = Join-Path $PSScriptRoot '..\..\infra\fabric\eventhouse\MiningSchema.kql'
        $script:SchemaText = Get-Content -LiteralPath $script:SchemaPath -Raw
        $script:Commands = @(Get-Content -LiteralPath $script:SchemaPath | Where-Object { $_ -match '^\.' })
    }

    It 'contains only the ten mining-owned tables and table-scoped policies' {
        $commands = $script:Commands
        $created = @($commands | Where-Object { $_ -match '^\.create table (mining_\w+) \(' } |
            ForEach-Object { [regex]::Match($_, '^\.create table (mining_\w+) \(').Groups[1].Value })
        $created | Should -HaveCount 10
        $created | Should -Contain 'mining_TelemetryRaw'
        $created | Should -Contain 'mining_PlantStateEvents'
        $created | Should -Contain 'mining_PlantCatalog'
        $created | Should -Contain 'mining_PublishProfile'
        $created | Should -Contain 'mining_SourceContract'
        $created | Should -Contain 'mining_ValidatedTelemetry'
        $created | Should -Contain 'mining_ValidatedState'
        $created | Should -Contain 'mining_Quarantine'
        $created | Should -Contain 'mining_AlertTransitions'
        $created | Should -Contain 'mining_IncidentLedger'
        foreach ($command in $commands) {
            $command | Should -Match '^\.((create|alter|alter-merge) table) mining_\w+ '
        }
        @($commands | Where-Object { $_ -match 'ingestion json mapping .*\$\W' }) | Should -HaveCount 2
        @($commands | Where-Object { $_ -match 'policy retention softdelete = 7d$' }) | Should -HaveCount 5
        @($commands | Where-Object { $_ -match 'policy retention softdelete = 30d$' }) | Should -HaveCount 2
        $script:SchemaText | Should -Match 'timestamp_raw:string'
    }

    It 'does not declare a database-wide retention or teardown command' {
        $script:Commands | Should -Not -Contain '.drop database'
        $script:Commands | Should -Not -Contain '.alter-merge database policy retention'
    }
}

Describe 'Offline mining source and query contracts (static checks only)' {
    BeforeAll {
        $root = Join-Path $PSScriptRoot '..\..\infra\fabric\eventhouse'
        $script:ValidationText = Get-Content -LiteralPath (Join-Path $root 'MiningValidation.kql') -Raw
        $script:QueriesText = Get-Content -LiteralPath (Join-Path $root 'MiningQueries.kql') -Raw
    }

    It 'gates curated dispositions on timestamp proof and exclusive writer approval' {
        $script:ValidationText | Should -Match 'd01-validated-source-v1'
        $script:ValidationText | Should -Match 'BLOCKED_RAW_TIMESTAMP_PROOF'
        $script:ValidationText | Should -Match 'BLOCKED_WRITER_APPROVAL'
        $script:ValidationText | Should -Match 'raw_timestamp_shape_verified'
        $script:ValidationText | Should -Match 'exclusive_writer_approved'
        $script:ValidationText | Should -Match 'timestamp_raw matches regex'
        $script:ValidationText | Should -Match 'disposition = case'
        $script:ValidationText | Should -Match '"QUARANTINED"'
        $script:ValidationText | Should -Match '"BLOCKED"'
        $script:ValidationText | Should -Match '"ACCEPTED"'
    }

    It 'retains v2 quality categories without converting uncertain to bad' {
        $script:ValidationText | Should -Match 'quality in \("good", "uncertain", "bad"\)'
        $script:QueriesText | Should -Match 'quality = iff\(event_conflict, string\(null\), quality\)'
        $script:QueriesText | Should -Match 'uncertain_count = countif\(quality == "uncertain"\)'
        $script:QueriesText | Should -Match 'bad_count = countif\(quality == "bad"\)'
        $script:QueriesText | Should -Match '"UNCERTAIN_QUALITY"'
        $script:QueriesText | Should -Match '"MIXED_NON_GOOD_QUALITY"'
    }

    It 'defines all five stable, mining-prefixed query signatures' {
        $script:QueriesText | Should -Match '(?s)mining_PlantLatest\(\s*plant_id:string,\s*run_id:string,\s*as_of_utc:datetime'
        $script:QueriesText | Should -Match '(?s)mining_PlantSummary\(\s*plant_id:string,\s*run_id:string,\s*window_start_utc:datetime,\s*window_end_utc:datetime'
        $script:QueriesText | Should -Match '(?s)mining_AssetTrend\(\s*plant_id:string,\s*run_id:string,\s*requested_module_id:string,\s*metric_family:string'
        $script:QueriesText | Should -Match '(?s)mining_ActiveIncidents\(\s*plant_id:string,\s*requested_run_id:string,\s*as_of_utc:datetime'
        $script:QueriesText | Should -Match '(?s)mining_CompareLines\(\s*plant_id:string,\s*run_id:string,\s*metric_family:string'
    }

    It 'maps AssetTrend families to canonical catalog metrics and keeps series separate' {
        $assetTrend = [regex]::Match(
            $script:QueriesText,
            '(?s)mining_AssetTrend\(.*?\.create-or-alter function with \(folder = "Mining/Queries"\) mining_ActiveIncidents'
        ).Value
        $assetTrend | Should -Match 'metric_family in \("feed", "density", "vibration", "water-energy"\)'
        $assetTrend | Should -Match 'requested_metric_family == "feed" and metric == "ore_flow"'
        $assetTrend | Should -Match 'requested_metric_family == "density" and metric == "medium_density"'
        $assetTrend | Should -Match 'requested_metric_family == "vibration" and metric == "vibration_rms"'
        $assetTrend | Should -Match 'requested_metric_family == "water-energy" and metric in \("water_flow", "power"\)'
        $assetTrend | Should -Match 'by module_id, tag_id, metric, unit, cadence_seconds,'
        $assetTrend | Should -Match 'metric_family = requested_metric_family'
    }

    It 'fails closed when the latest PlantSummary state event conflicts' {
        $deduplicatedState = [regex]::Match(
            $script:QueriesText,
            '(?s)mining_DeduplicatedState\(.*?\.create-or-alter function with \(folder = "Mining/Queries"\) mining_PlantLatest'
        ).Value
        $plantSummary = [regex]::Match(
            $script:QueriesText,
            '(?s)mining_PlantSummary\(.*?\.create-or-alter function with \(folder = "Mining/Queries"\) mining_AssetTrend'
        ).Value
        $deduplicatedState | Should -Match 'timestamp = max\(timestamp\)'
        $plantSummary | Should -Match '(?s)let state_source =\s*mining_DeduplicatedState\([^;]+\);'
        $plantSummary | Should -Not -Match '(?s)let state_source =\s*mining_DeduplicatedState\([^;]+\)\s*\|\s*where not\(event_conflict\)'
        $plantSummary | Should -Match '(?s)let state_by_minute =\s*state_source\s*\|\s*extend minute = bin\(timestamp - 1ms, 1m\)'
        $plantSummary | Should -Match '(?s)let state_latest_times =\s*state_by_minute.*?by scope_id, minute;'
        $plantSummary | Should -Match 'latest_conflict_count = countif\(event_conflict\)'
        $plantSummary | Should -Match '(?s)let state_bins =.*?where timestamp == latest_timestamp.*?where latest_conflict_count == 0'
        $plantSummary | Should -Match 'current_conflict_count = countif\(event_conflict\)'
        $plantSummary | Should -Match '(?s)let running_lines =.*?where timestamp == latest_timestamp.*?where current_conflict_count == 0'
        $plantSummary | Should -Match 'state_conflict_count == 0'
        $plantSummary | Should -Match 'conflicting_event_count = conflict_event_count \+ state_conflict_count'
        $plantSummary | Should -Match 'conflict_event_count > 0 or state_conflict_count > 0, "DUPLICATE_CONFLICT"'
    }

    It 'reads curated sources rather than raw dynamic tables' {
        $script:QueriesText | Should -Match 'mining_ValidatedTelemetry'
        $script:QueriesText | Should -Match 'mining_ValidatedState'
        $script:QueriesText | Should -Not -Match 'mining_TelemetryRaw'
        $script:QueriesText | Should -Not -Match 'mining_PlantStateEvents'
        $script:QueriesText | Should -Not -Match '\.set-or-append|\.append|\.ingest'
    }

    It 'preserves canonical CompareLines tags, units, metric families, and overflow status' {
        $compareLines = [regex]::Match($script:QueriesText, '(?s)mining_CompareLines\(.*$').Value
        $compareLines | Should -Match 'D01\.A\.crusher\.ore_flow'
        $compareLines | Should -Match 'D01\.B\.crusher\.ore_flow'
        $compareLines | Should -Match 'D01\.C\.crusher\.ore_flow'
        $compareLines | Should -Match 'D01\.A\.dms\.medium_density'
        $compareLines | Should -Match 'D01\.A\.crusher\.vibration_rms'
        $compareLines | Should -Match 'metric_ok = metric_family in \("feed", "density", "vibration"\)'
        $compareLines | Should -Match 'tag_id, metric, unit, metric_family'
        $compareLines | Should -Match 'row_count > 1000, "TOO_MANY_ROWS"'
        $compareLines | Should -Match 'row_count <= 1000'
        $compareLines | Should -Not -Match 'water-energy|line energy|hopper|sorter'
    }

    It 'uses half-open windows and interval-end binning for trend and summary coverage' {
        $script:QueriesText | Should -Match 'timestamp < window_end_utc'
        $script:QueriesText | Should -Match 'bin\(timestamp - 1ms, safe_bin_minutes \* 1m\)'
        $script:QueriesText | Should -Match 'minute = bin\(timestamp - 1ms, 1m\)'
        $script:QueriesText | Should -Match 'minute_coverage >= 0\.90'
        $script:QueriesText | Should -Match 'common_coverage = common_seconds / duration_seconds'
        $script:QueriesText | Should -Match 'common_coverage >= 0\.90 and common_feed >= 10\.0'
        $script:QueriesText | Should -Match '(?s)conflict_event_count > 0 or state_conflict_count > 0, "DUPLICATE_CONFLICT",\s*isnull\(feed_a_good\).*"NO_DATA"'
    }

    It 'keeps these static checks separate from hosted KQL validation' {
        $script:QueriesText | Should -Match 'No function reads a raw dynamic table'
    }
}
