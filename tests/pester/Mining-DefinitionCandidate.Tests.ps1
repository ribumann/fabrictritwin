#Requires -Version 7.0
BeforeAll {
    $script:Generator = Join-Path $PSScriptRoot '..\..\scripts\fabric\new-mining-definition-candidate.ps1'
    $script:Template = Join-Path $PSScriptRoot '..\..\infra\fabric\eventstream\eventstream.custom-endpoint.json'
    function Encode($text) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }
    function Write-Json($path, $value) {
        [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
    }
    function New-Columns([string[]]$names) {
        return ,@($names | ForEach-Object { @{ name = $_; type = 'Nvarchar(max)'; fields = $null; items = $null } })
    }
}

Describe 'Review-only mining definition candidate' {
    BeforeEach {
        $script:ids = @{
            SubscriptionId = '00000000-0000-0000-0000-000000000001'
            TenantId = '00000000-0000-0000-0000-000000000002'
            WorkspaceId = '00000000-0000-0000-0000-000000000003'
            EventstreamId = '00000000-0000-0000-0000-000000000004'
            KqlDatabaseId = '00000000-0000-0000-0000-000000000005'
        }
        $raw = (Get-Content $script:Template -Raw).Replace('{{EVENTHOUSE_WORKSPACE_ID}}', $script:ids.WorkspaceId).
            Replace('{{KQLDATABASE_ITEM_ID}}', $script:ids.KqlDatabaseId).
            Replace('{{SESSIONMETRIC_CONNECTION_NAME}}', 'triathlon-session').
            Replace('{{RACESPLIT_CONNECTION_NAME}}', 'triathlon-race')
        $script:original = $raw | ConvertFrom-Json -AsHashtable
        $script:original.streams = @($script:original.streams[2], $script:original.streams[0], $script:original.streams[1])
        $script:original['fixtureTimestamp'] = '2024-01-01T00:00:00+02:00'
        $script:envelope = @{ definition = @{ parts = @(
            @{ path = 'eventstreamProperties.json'; payloadType = 'InlineBase64'; payload = (Encode '{"retentionTimeInDays":1}') },
            @{ path = 'eventstream.json'; payloadType = 'InlineBase64'; payload = (Encode ($script:original | ConvertTo-Json -Depth 100)) },
            @{ path = '.platform'; payloadType = 'InlineBase64'; payload = (Encode '{"metadata":"unchanged"}') }
        ) } }
        $common = @('entityType', 'schema_version', 'run_id', 'event_id', 'sequence', 'timestamp', 'plant_id')
        $script:schemas = @{
            telemetry = New-Columns ($common + @('interval_seconds', 'module_id', 'equipment_id', 'tag_id', 'value', 'unit', 'quality'))
            state = New-Columns ($common + @('scope_id', 'scheduled_running', 'state'))
        }
        $script:baseline = Join-Path $TestDrive 'baseline.json'
        $script:schemaPath = Join-Path $TestDrive 'schemas.json'
        $script:output = Join-Path $TestDrive ("candidate-{0}.json" -f [guid]::NewGuid())
        Write-Json $script:baseline $script:envelope
        Write-Json $script:schemaPath $script:schemas
        $script:arguments = $script:ids.Clone()
        $script:arguments.BaselinePath = $script:baseline
        $script:arguments.BaselineSha256 = (Get-FileHash $script:baseline -Algorithm SHA256).Hash
        $script:arguments.InputSchemasPath = $script:schemaPath
        $script:arguments.OutputPath = $script:output
        $script:arguments.TelemetryConnectionName = 'mining-telemetry'
        $script:arguments.StateConnectionName = 'mining-state'
        Mock Invoke-WebRequest { throw 'Unexpected network request.' }
    }

    It 'preserves all preimage parts and node order while generating separate v2 routes' {
        $result = & $script:Generator @script:arguments
        $result.Status | Should -Be 'CandidateForReviewOnly'
        $result.RawPreservationVerified | Should -BeFalse
        $result.ApplySupported | Should -BeFalse
        $result.CandidateSha256 | Should -Be (Get-FileHash $script:output -Algorithm SHA256).Hash
        $candidate = Get-Content $script:output -Raw | ConvertFrom-Json -AsHashtable
        $candidate.definition.parts[0] | ConvertTo-Json -Compress | Should -Be ($script:envelope.definition.parts[0] | ConvertTo-Json -Compress)
        $candidate.definition.parts[2] | ConvertTo-Json -Compress | Should -Be ($script:envelope.definition.parts[2] | ConvertTo-Json -Compress)
        $topology = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($candidate.definition.parts[1].payload)) | ConvertFrom-Json -AsHashtable -DateKind String
        $topology.fixtureTimestamp | Should -BeExactly '2024-01-01T00:00:00+02:00'
        @($topology.streams | Select-Object -First 3 -ExpandProperty name) | Should -Be @($script:original.streams.name)
        $topology.destinations[0].inputSchemas[0].schema.columns.Count | Should -Be 9
        $topology.destinations[1].inputSchemas[0].schema.columns.Count | Should -Be 9
        $topology.destinations[2].inputSchemas[0].schema.columns.Count | Should -Be 14
        $topology.destinations[3].inputSchemas[0].schema.columns.Count | Should -Be 10
        $topology.operators[2].properties.conditions[0].value.value | Should -Be 'PlantTelemetry'
        $topology.operators[3].properties.conditions[0].value.value | Should -Be 'PlantStateEvent'
        foreach ($kind in @('streams', 'operators', 'destinations')) {
            $topology[$kind] = @($topology[$kind] | Where-Object { $_.name -cnotlike 'mining_*' })
        }
        ($topology | ConvertTo-Json -Depth 100 -Compress) |
            Should -BeExactly ($script:original | ConvertTo-Json -Depth 100 -Compress)
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
    }

    It 'refuses a changed hash, missing wire field, and reused connection name' {
        $script:arguments.BaselineSha256 = '0' * 64
        { & $script:Generator @script:arguments } | Should -Throw '*hash*'
        $script:arguments.BaselineSha256 = (Get-FileHash $script:baseline -Algorithm SHA256).Hash
        $script:schemas.telemetry = @($script:schemas.telemetry | Where-Object name -ne 'value')
        Write-Json $script:schemaPath $script:schemas
        { & $script:Generator @script:arguments } | Should -Throw '*wire fields*'
        $script:schemas.telemetry += @{ name = 'value'; type = 'Float'; fields = $null; items = $null }
        Write-Json $script:schemaPath $script:schemas
        $script:arguments.StateConnectionName = 'triathlon-race'
        { & $script:Generator @script:arguments } | Should -Throw '*Connection names*'
        Test-Path $script:output | Should -BeFalse
    }

    It 'refuses an altered triathlon topology and will not overwrite a candidate' {
        $script:original.destinations[0].properties.tableName = 'unexpected'
        $script:envelope.definition.parts[1].payload = Encode ($script:original | ConvertTo-Json -Depth 100)
        Write-Json $script:baseline $script:envelope
        $script:arguments.BaselineSha256 = (Get-FileHash $script:baseline -Algorithm SHA256).Hash
        { & $script:Generator @script:arguments } | Should -Throw '*triathlon destination*'
        Test-Path $script:output | Should -BeFalse
        $script:original.destinations[0].properties.tableName = 'SessionMetric'
        $script:envelope.definition.parts[1].payload = Encode ($script:original | ConvertTo-Json -Depth 100)
        Write-Json $script:baseline $script:envelope
        $script:arguments.BaselineSha256 = (Get-FileHash $script:baseline -Algorithm SHA256).Hash
        $null = & $script:Generator @script:arguments
        $before = (Get-FileHash $script:output -Algorithm SHA256).Hash
        { & $script:Generator @script:arguments } | Should -Throw
        (Get-FileHash $script:output -Algorithm SHA256).Hash | Should -Be $before
    }
}
