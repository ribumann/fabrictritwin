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
    It 'contains only the four owned tables and table-scoped policies' {
        $path = Join-Path $PSScriptRoot '..\..\infra\fabric\eventhouse\MiningSchema.kql'
        $commands = @(Get-Content -LiteralPath $path | Where-Object { $_ -match '^\.' })
        $created = @($commands | Where-Object { $_ -match '^\.create table (mining_\w+) \(' } |
            ForEach-Object { [regex]::Match($_, '^\.create table (mining_\w+) \(').Groups[1].Value })
        $created | Should -HaveCount 4
        $created | Should -Contain 'mining_TelemetryRaw'
        $created | Should -Contain 'mining_PlantStateEvents'
        $created | Should -Contain 'mining_PlantCatalog'
        $created | Should -Contain 'mining_AlertTransitions'
        foreach ($command in $commands) {
            $command | Should -Match '^\.((create|alter|alter-merge) table) mining_\w+ '
        }
        @($commands | Where-Object { $_ -match 'ingestion json mapping .*\$\W' }) | Should -HaveCount 2
        @($commands | Where-Object { $_ -match 'policy retention softdelete = 7d$' }) | Should -HaveCount 2
        @($commands | Where-Object { $_ -match 'policy retention softdelete = 30d$' }) | Should -HaveCount 1
    }
}
