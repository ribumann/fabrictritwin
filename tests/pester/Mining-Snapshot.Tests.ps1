BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\..\scripts\fabric\MiningSnapshot.psm1') -Force
    $script:catalogPath = Join-Path $PSScriptRoot '..\..\apps\simulator\src\mining\plant-catalog.json'
    function Get-TestHash([string]$Text) {
        [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
    }
    function New-TestKustoEnvelope($Primary) {
        @{
            Tables = @(
                $Primary,
                @{ TableName = 'Table_1'; Columns = @(@{ ColumnName = 'Value' }); Rows = @(,@('{}')) },
                @{ TableName = 'Table_2'; Columns = @(@{ ColumnName = 'Severity' }, @{ ColumnName = 'StatusCode' }); Rows = @(,@(4, 0)) },
                @{ TableName = 'Table_3'; Columns = @(@{ ColumnName = 'Ordinal' }, @{ ColumnName = 'Kind' }, @{ ColumnName = 'Name' })
                    Rows = @(@(0, 'QueryResult', 'PrimaryResult'), @(1, 'QueryProperties', '@ExtendedProperties'), @(2, 'QueryStatus', 'QueryStatus')) }
            )
        }
    }
    function New-SnapshotTestInput {
        $catalog = Get-Content $script:catalogPath -Raw | ConvertFrom-Json -AsHashtable
        $tag = $catalog.telemetry_tags[0]
        $run = @{
            runId = '00000000-0000-4000-8000-000000000001'; plantId = 'D01'
            expected = @{}
            contract = @{
                catalogVersion = 'sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce'
                profileVersion = 'd01-publish-profile-v1'; evaluatorReplayVersion = 1
            }
        }
        $telemetryId = Get-TestHash "$($run.runId):1"
        $stateId = Get-TestHash "$($run.runId):2"
        $run.expected.telemetry = @{ count = 1; hash = Get-TestHash $telemetryId }
        $run.expected.state = @{ count = 1; hash = Get-TestHash $stateId }
        $version = 'sha256:' + (Get-FileHash $script:catalogPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $telemetry = @{
            plant_id = 'D01'; run_id = $run.runId; event_id = $telemetryId; sequence = 1
            timestamp = '2026-01-01T00:00:30.000Z'; received_at = '2026-01-01T00:00:31.1234567Z'
            module_id = $tag.module_id; equipment_id = $tag.equipment_id; tag_id = $tag.id; value = 12.345
            unit = $tag.unit; quality = 'good'; interval_seconds = 30; catalog_version = $version
            profile_version = 'd01-publish-profile-v1'; source_contract_version = 'd01-validated-source-v1'
            payload_fingerprint = 'a' * 64
        }
        if ($tag.metric -cin @('bearing_temperature', 'level', 'product_mass')) { $telemetry.interval_seconds = 60 }
        $state = @{
            plant_id = 'D01'; run_id = $run.runId; event_id = $stateId; sequence = 2
            timestamp = '2026-01-01T00:00:00.000Z'; received_at = '2026-01-01T00:00:31.1234567Z'
            scope_id = 'A'; state = 'running'; scheduled_running = $true; catalog_version = $version
            source_contract_version = 'd01-validated-source-v1'; payload_fingerprint = 'b' * 64
        }
        $ingestion = @('raw_telemetry', 'validated_telemetry', 'raw_state', 'validated_state', 'quarantine' | ForEach-Object {
            $family = $_
            $expectation = if ($family -eq 'quarantine') { @{ count = 0; hash = Get-TestHash '' } } elseif ($family.EndsWith('telemetry')) {
                $run.expected.telemetry
            } else { $run.expected.state }
            @{ family = $family; source_status = 'READY'; conflicting_ids = 0
                event_count = $expectation.count; event_ids_hash = $expectation.hash; copies = $expectation.count }
        })
        @{ Run = $run; AsOfUtc = '2026-01-01T00:01:00.000Z'; CatalogPath = $script:catalogPath
            PublisherEvidence = @{ plantId = 'D01'; run = @{ runId = $run.runId; admission = 'accepted'; publisherStatus = 'publisher_complete'; stopRequested = $false } }
            Ingestion = $ingestion; Telemetry = @($telemetry); State = @($state) }
    }
}

Describe 'Reconciled immutable Mining snapshots' {
    It 'preserves source values, both exact event families, event time and explicit as-of labels' {
        $input = New-SnapshotTestInput
        $bundle = New-MiningSnapshotBundle @input
        $bundle.tables.Count | Should -Be 2
        $bundle.tables[0].rowCount | Should -Be 1
        $row = $bundle.tables[0].csv | ConvertFrom-Csv
        $row.event_id | Should -BeExactly $input.Telemetry[0].event_id
        $row.value | Should -BeExactly '12.345'
        $row.received_at_utc | Should -BeExactly '2026-01-01T00:00:31.1234567Z'
        $row.snapshot_as_of_utc | Should -BeExactly $input.AsOfUtc
        $row.event_time_utc | Should -BeExactly $input.Telemetry[0].timestamp
        $bundle.tables[0].name | Should -Match '^mining_D01_snapshot_v1_[a-f0-9]{32}_telemetry$'
        $bundle.tables[0].keys | Should -Be @('event_id')
    }

    It 'deduplicates identical delivery while retaining the earliest actual receipt' {
        $input = New-SnapshotTestInput
        $copy = $input.Telemetry[0].Clone()
        $copy.received_at = '2026-01-01T00:00:32.0000000Z'
        $input.Telemetry += $copy
        $bundle = New-MiningSnapshotBundle @input
        $bundle.tables[0].rowCount | Should -Be 1
        ($bundle.tables[0].csv | ConvertFrom-Csv).received_at_utc | Should -BeExactly $input.Telemetry[0].received_at
    }

    It 'rejects <fault> before any native request' -TestCases @(
        @{ fault = 'wrong exact event set' }, @{ fault = 'quarantine' }, @{ fault = 'conflicting source identities' }
        @{ fault = 'conflicting duplicate payload' }, @{ fault = 'wrong catalog join' }
        @{ fault = 'wrong profile interval' }, @{ fault = 'future receipt' }, @{ fault = 'unbounded extraction' }
        @{ fault = 'incomplete publisher' }, @{ fault = 'non-finite reading' }, @{ fault = 'invalid state' }
        @{ fault = 'submillisecond event time' }, @{ fault = 'wrong contract' }
    ) {
        param($fault)
        $input = New-SnapshotTestInput
        switch ($fault) {
            'wrong exact event set' { $input.Run.expected.telemetry.hash = 'c' * 64 }
            'quarantine' { $input.Ingestion[4].event_count = 1 }
            'conflicting source identities' { $input.Ingestion[1].conflicting_ids = 1 }
            'conflicting duplicate payload' { $copy = $input.Telemetry[0].Clone(); $copy.value = 99; $input.Telemetry += $copy }
            'wrong catalog join' { $input.Telemetry[0].module_id = 'wrong' }
            'wrong profile interval' { $input.Telemetry[0].interval_seconds = 10 }
            'future receipt' { $input.Telemetry[0].received_at = '2026-01-01T00:02:00.000Z' }
            'unbounded extraction' { $input.Telemetry = @($input.Telemetry[0]) * 2001 }
            'incomplete publisher' { $input.PublisherEvidence.run.publisherStatus = 'running' }
            'non-finite reading' { $input.Telemetry[0].value = [double]::NaN }
            'invalid state' { $input.State[0].state = 'invented' }
            'submillisecond event time' { $input.Telemetry[0].timestamp = '2026-01-01T00:00:29.0000001Z' }
            'wrong contract' { $input.Telemetry[0].source_contract_version = 'unknown' }
        }
        { New-MiningSnapshotBundle @input } | Should -Throw
    }

    It 'creates stable native definitions with isolated sources and no cross-unit aggregation' {
        $input = New-SnapshotTestInput
        $bundle = New-MiningSnapshotBundle @input
        $target = @{ SqlServer = 'example.datawarehouse.fabric.microsoft.com'; SqlDatabase = 'mining_test'; WorkspaceName = 'snapshot-test' }
        $id = [guid]'00000000-0000-4000-8000-000000000099'
        $first = New-MiningSnapshotDefinitions $bundle $target $id
        $second = New-MiningSnapshotDefinitions $bundle $target $id
        foreach ($part in $first.semanticModel.parts) {
            $other = $second.semanticModel.parts | Where-Object path -CEQ $part.path
            $part.payload | Should -BeExactly $other.payload
        }
        $telemetry = $first.semanticModel.parts | Where-Object path -EQ 'definition/tables/Telemetry.tmdl'
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($telemetry.payload))
        $text | Should -Match "HASONEVALUE\('Telemetry'\[tag_id\]\)"
        $text | Should -Match "HASONEVALUE\('Telemetry'\[unit\]\)"
        $text | Should -Match 'mode: directLake'
        $text | Should -Match $bundle.tables[0].name
        $measureNames = @($first.semanticModel.parts | Where-Object path -Like 'definition/tables/*' | ForEach-Object {
            $tableText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_.payload))
            [regex]::Matches($tableText, "measure '([^']+)'") | ForEach-Object { $_.Groups[1].Value }
        })
        @($measureNames | Select-Object -Unique).Count | Should -Be $measureNames.Count
        $binding = $first.report.parts | Where-Object path -EQ 'definition.pbir'
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($binding.payload)) | Should -Match "semanticmodelid=$id"
        @($first.report.parts | Where-Object path -Like '*/visual.json').Count | Should -Be 4
        foreach ($part in $first.report.parts) {
            $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json -AsHashtable
            $json.Contains('$schema') | Should -BeTrue -Because "$($part.path) must identify its native import schema"
        }
    }
}

Describe 'Kusto envelope fail-closed behavior' {
    It 'reads only a complete bounded primary table' {
        $response = New-TestKustoEnvelope @{ TableName = 'Table_0'; Columns = @(@{ ColumnName = 'value' }); Rows = @(,@(5)) }
        $rows = @(ConvertFrom-MiningSnapshotQuery $response)
        $rows.Count | Should -Be 1
        $rows[0].value | Should -Be 5
    }

    Describe 'Shared native fact row verification' {
        It 'uploads opaque Parquet bytes without JSON array conversion' {
            $target = @{ WorkspaceId = '00000000-0000-4000-8000-000000000010'; StaticLakehouseId = '00000000-0000-4000-8000-000000000011' }
            [byte[]]$source = @(80, 65, 82, 49, 0, 255, 128)
            $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($source)).ToLowerInvariant()
            $state = @{ source = $source; written = $false; appended = $false }
            $request = {
                param($Request)
                $response = @{ statusCode = 200; headers = @{}; body = $null }
                if ($Request.method -eq 'GET') {
                    if ($state.written) { $response.body = $state.source } else { $response.statusCode = 404 }
                } elseif ($Request.method -eq 'HEAD') { $response.statusCode = 404 } elseif ($Request.method -eq 'PUT') {
                    $response.statusCode = 201
                } elseif ($Request.uri.Contains('action=append')) {
                    if ($Request.body -isnot [byte[]] -or $Request.contentType -cne 'application/octet-stream') { throw 'Binary payload was converted to a JSON array.' }
                    $state.appended = $true
                    $response.statusCode = 202
                } elseif ($Request.uri.Contains('action=flush')) { $state.written = $true }
                $response
            }.GetNewClosure()
            $client = @{ request = $request; sleep = {} }
            $stream = [IO.FileStream]::new((Join-Path $TestDrive 'binary-upload.jsonl'), 'CreateNew', 'ReadWrite', 'None')
            try {
                & (Get-Module MiningSnapshot) {
                    param($Client, $Target, $Source, $Hash, $Stream)
                    Invoke-SnapshotShared Send-MiningCsv @(
                        $Client, $Target, @{ contentBytes = $Source; sha256 = $Hash },
                        @{ body = @{ relativePath = "Files/mining-D01/$Hash/snapshot.parquet" } },
                        @{ operations = [Collections.Generic.List[object]]::new() }, $Stream, 2, 0
                    )
                } $client $target $source $hash $stream
            } finally { $stream.Dispose() }
            $state.appended | Should -BeTrue
            $state.written | Should -BeTrue
        }

        It 'verifies event-ID-sorted fact bytes regardless of SQL row order' {
            $target = @{ WorkspaceId = '00000000-0000-4000-8000-000000000010'; StaticLakehouseId = '00000000-0000-4000-8000-000000000011'; SqlDatabase = 'mining_test' }
            $name = 'mining_D01_snapshot_test_telemetry'
            $csv = "`"event_id`",`"value`"`n`"a`",`"1.25`"`n`"b`",`"2.5`"`n"
            $table = @{ name = $name; csv = $csv; sha256 = Get-TestHash $csv; rowCount = 2; keys = @('event_id') }
            $root = "$($target.StaticLakehouseId)/Tables/dbo/$name"
            $metadata = @{
                name = $name; schema_name = 'dbo'; catalog_name = $target.StaticLakehouseId
                storage_location = "https://onelake.dfs.fabric.microsoft.com/$($target.WorkspaceId)/$root"
                columns = @(@{ name = 'event_id'; type_name = 'STRING' }, @{ name = 'value'; type_name = 'STRING' })
            }
            $request = {
                param($Request)
                $body = if ($Request.uri.Contains('unity-catalog')) { $metadata } elseif ($Request.uri.Contains('resource=filesystem')) {
                    @{ paths = @(@{ name = "$root/_delta_log/00000000000000000000.json" }) }
                } else { [Text.Encoding]::UTF8.GetBytes('{"metaData":{"configuration":{}}}') }
                @{ statusCode = 200; headers = @{}; body = $body }
            }.GetNewClosure()
            $query = {
                param($Sql)
                if ($Sql.Contains('FROM sys.tables')) { return @{ name = $name } }
                if ($Sql.Contains('security_predicates')) { return }
                @{ event_id = 'b'; value = '2.5' }
                @{ event_id = 'a'; value = '1.25' }
            }.GetNewClosure()
            $client = @{ request = $request; query = $query }
            $result = & (Get-Module MiningSnapshot) {
                param($Client, $Target, $Table)
                Invoke-SnapshotShared Get-MiningTableState @($Client, $Target, $Table, @{ metadataUri = 'https://onelake.table.fabric.microsoft.com/unity-catalog' })
            } $client $target $table
            $result.exists | Should -BeTrue
            $result.sha256 | Should -BeExactly $table.sha256
        }
    }

    Describe 'Native snapshot publication acceptance' {
        BeforeEach {
            $input = New-SnapshotTestInput
            $script:bundle = New-MiningSnapshotBundle @input
            $script:target = @{
                WorkspaceId = '00000000-0000-4000-8000-000000000010'
                StaticLakehouseId = '00000000-0000-4000-8000-000000000011'
                SqlServer = 'example.datawarehouse.fabric.microsoft.com'; SqlDatabase = 'mining_test'
                WorkspaceName = 'snapshot-test'
            }
            $modelId = '00000000-0000-4000-8000-000000000012'
            $reportId = '00000000-0000-4000-8000-000000000013'
            $refreshId = '00000000-0000-4000-8000-000000000014'
            $defs = New-MiningSnapshotDefinitions $script:bundle $script:target $modelId
            $suffix = $script:bundle.run.runId.Replace('-', '')
            $script:native = @{
                modelId = $modelId; reportId = $reportId; refreshId = $refreshId; target = $script:target
                definitions = @{ $modelId = $defs.semanticModel; $reportId = $defs.report }
                items = @(
                    @{ id = $modelId; type = 'SemanticModel'; displayName = "mining-d01-snapshot-$suffix-semanticmodel" },
                    @{ id = $reportId; type = 'Report'; displayName = "mining-d01-snapshot-$suffix-report" }
                )
                telemetry = @($script:bundle.tables[0].csv | ConvertFrom-Csv)
                state = @($script:bundle.tables[1].csv | ConvertFrom-Csv)
                calls = [Collections.Generic.List[object]]::new()
                fault = ''; paginated = $false
            }
            $state = $script:native
            $request = {
                param($Request)
                $state.calls.Add($Request)
                $uri = [uri]$Request.uri
                $response = @{ statusCode = 200; headers = @{}; body = @{} }
                if ($uri.AbsolutePath -ceq "/v1/workspaces/$($state.target.WorkspaceId)") {
                    $response.body = @{ id = $state.target.WorkspaceId; displayName = $state.target.WorkspaceName }
                } elseif ($uri.AbsolutePath -match '/items$' -and $Request.method -eq 'GET') {
                    if ($state.paginated -and -not $uri.Query) {
                        $response.body = @{ value = @(); continuationToken = 'next-page' }
                    } else { $response.body = @{ value = $state.items } }
                } elseif ($uri.AbsolutePath -match '/items$' -and $Request.method -eq 'POST') {
                    throw 'Response lost after create may have been accepted.'
                } elseif ($uri.AbsolutePath -match '/items/([^/]+)/getDefinition$') {
                    $response.body = @{ definition = $state.definitions[$Matches[1]] }
                } elseif ($uri.AbsolutePath -match '/refreshes$') {
                    if ($Request.method -eq 'POST') {
                        $response.statusCode = 202
                        $response.headers.Location = "https://api.powerbi.com/v1.0/myorg/groups/$($state.target.WorkspaceId)/datasets/$($state.modelId)/refreshes/$($state.refreshId)"
                        if ($state.fault -eq 'unknown-refresh') {
                            $response.headers = @{ RequestId = 'correlation-only'; Date = 'Sun, 15 Nov 2026 18:02:39 GMT'; Authorization = 'must-not-persist' }
                        }
                    } else {
                        $status = if ($state.fault -eq 'refresh') { 'Failed' } else { 'Completed' }
                        $response.body = @{ value = @(@{ requestId = $state.refreshId; status = $status }) }
                    }
                } elseif ($uri.AbsolutePath -match '/reports/') {
                    $response.body = @{ datasetId = $state.modelId }
                } elseif ($uri.AbsolutePath -match '/executeQueries$') {
                    if ($state.fault -eq 'embedded') {
                        $response.body = @{ results = @(@{ error = @{ code = 'QueryExecutionError' } }) }
                    } else {
                        $query = $Request.body.queries[0].query
                        $rows = if ($query.Contains('ROW(')) { @(@{ '[telemetry]' = $state.telemetry.Count; '[state]' = $state.state.Count }) } elseif ($query.Contains('SELECTCOLUMNS')) {
                            $values = if ($query.Contains("'Telemetry'")) { $state.telemetry } else { $state.state }
                            @($values | ForEach-Object { @{ '[event_id]' = $(if ($state.fault -eq 'identities') { 'f' * 64 } else { $_.event_id }) } })
                        } elseif ($query.Contains("'Telemetry'")) {
                            @($state.telemetry | ForEach-Object { @{
                                '[Event Count]' = 1; '[Reading Value]' = $(if ($state.fault -eq 'values') { 999.0 } else { [double]$_.value })
                                'Telemetry[event_time_utc]' = $_.event_time_utc; 'Telemetry[tag_id]' = $_.tag_id; 'Telemetry[unit]' = $_.unit
                            } })
                        } else {
                            $values = if ($state.fault -in @('grouped-state', 'state-count')) { @($state.state[0]) } else { $state.state }
                            @($values | ForEach-Object { @{
                            '[Event Count]' = $(if ($state.fault -eq 'grouped-state') { $state.state.Count } else { 1 })
                            'State[scope_id]' = $_.scope_id; 'State[event_time_utc]' = $_.event_time_utc
                            'State[state]' = $_.state; 'State[scheduled_running]' = $_.scheduled_running
                        } }) }
                        $response.body = @{ results = @(@{ tables = @(@{ rows = $rows }) }) }
                    }
                } else { throw "Unexpected simulated request $($Request.method) $uri" }
                $response
            }.GetNewClosure()
            $script:client = @{ request = $request; sleep = {} }
            Mock -ModuleName MiningSnapshot Invoke-SnapshotShared -ParameterFilter { $Name -eq 'Assert-MiningLivePrerequisites' } -MockWith {}
            Mock -ModuleName MiningSnapshot Invoke-SnapshotShared -ParameterFilter { $Name -eq 'Get-MiningTableState' } -MockWith {
                @{ exists = $true; rowCount = $Arguments[2].rowCount; sha256 = $Arguments[2].sha256 }
            }
            $script:receiptPath = Join-Path $TestDrive "$([guid]::NewGuid()).jsonl"
        }

        It 'verifies exact model/report definitions, refresh, visual-shaped results and both identity sets' {
            $receipt = Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath -Mode Apply
            $receipt.status | Should -BeExactly 'VerifiedNativeSnapshot'
            $receipt.verification.telemetry.rowCount | Should -Be 1
            $receipt.verification.stateIds.rowCount | Should -Be 1
            $receipt.portalVisualVerification | Should -BeExactly 'Not performed'
            @($script:native.calls | Where-Object { $_.method -eq 'POST' -and $_.uri -match '/refreshes$' }).Count | Should -Be 1
            { Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath -Mode Apply } | Should -Throw '*Receipt exists*'
        }

        It 'uses all inventory pages and performs no mutating request during read-only verification' {
            $script:native.paginated = $true
            $receipt = Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath -Mode Verify
            $receipt.status | Should -BeExactly 'VerifiedNativeSnapshot'
            $receipt.verification.refresh.requestId | Should -BeExactly $script:native.refreshId
            @($script:native.calls | Where-Object { $_.method -eq 'POST' -and $_.uri -notmatch '/(getDefinition|executeQueries)$' }).Count | Should -Be 0
        }

        It 'journals safe metadata and never retries a refresh with unknown operation identity' {
            $script:native.fault = 'unknown-refresh'
            { Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath -Mode Apply } |
                Should -Throw '*Refresh identity is unknown*'
            $receipt = Get-Content $script:receiptPath | Select-Object -Last 1 | ConvertFrom-Json -AsHashtable
            $operation = @($receipt.operations | Where-Object type -CEQ 'Refresh')[0]
            $operation.responseMetadata.RequestId | Should -BeExactly 'correlation-only'
            $operation.responseMetadata.Contains('Authorization') | Should -BeFalse
            @($script:native.calls | Where-Object { $_.method -eq 'POST' -and $_.uri -match '/refreshes$' }).Count | Should -Be 1
        }

        It 'reconciles repeated actual state observations without losing event multiplicity: <fault>' -TestCases @(
            @{ fault = 'grouped-state'; succeeds = $true }, @{ fault = 'state-count'; succeeds = $false }
        ) {
            param($fault, $succeeds)
            $copy = $script:native.state[0].PSObject.Copy()
            $copy.event_id = Get-TestHash "$($script:bundle.run.runId):3"
            $script:native.state += $copy
            $ids = [string[]]$script:native.state.event_id
            [Array]::Sort($ids, [StringComparer]::Ordinal)
            $script:bundle.run.expected.state = @{ count = 2; hash = Get-TestHash ($ids -join "`n") }
            $table = $script:bundle.tables[1]
            $table.csv = (($script:native.state | ConvertTo-Csv -NoTypeInformation) -join "`n") + "`n"
            $table.rowCount = 2
            $table.sha256 = Get-TestHash $table.csv
            $table.eventIdsHash = $script:bundle.run.expected.state.hash
            $script:native.fault = $fault
            if ($succeeds) {
                $receipt = Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath
                $receipt.verification.state.rowCount | Should -Be 1
                $receipt.verification.stateIds.rowCount | Should -Be 2
            } else {
                { Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath } |
                    Should -Throw '*multiplicity*'
            }
        }

        It 'does not claim completion for <fault>' -TestCases @(
            @{ fault = 'refresh' }, @{ fault = 'embedded' }, @{ fault = 'identities' }, @{ fault = 'values' }
        ) {
            param($fault)
            $script:native.fault = $fault
            { Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath -Mode Apply } | Should -Throw
            $receipt = Get-Content $script:receiptPath | Select-Object -Last 1 | ConvertFrom-Json
            $receipt.status | Should -BeExactly 'NeedsReconciliation'
        }

        It 'journals an unknown create once and refuses resubmission' {
            $script:native.items = @()
            { Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath -Mode Apply } | Should -Throw '*Response lost*'
            $receipt = Get-Content $script:receiptPath | Select-Object -Last 1 | ConvertFrom-Json
            $receipt.operations[0].status | Should -BeExactly 'SubmittedOutcomeUnknown'
            { Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath -Mode Apply } | Should -Throw '*Receipt exists*'
            @($script:native.calls | Where-Object { $_.method -eq 'POST' -and $_.uri -match '/items$' }).Count | Should -Be 1
        }

        It 'rejects type-changing report definition drift before refreshing anything' {
            $part = $script:native.definitions[$script:native.reportId].parts | Where-Object path -EQ 'definition/pages/snapshot/page.json'
            $page = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json -AsHashtable
            $page.width = [string]$page.width
            $part.payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($page | ConvertTo-Json -Compress)))
            { Invoke-MiningSnapshotDeployment $script:bundle $script:target $script:client $script:receiptPath -Mode Apply } | Should -Throw '*definition drift*'
            @($script:native.calls | Where-Object { $_.method -eq 'POST' -and $_.uri -match '/refreshes$' }).Count | Should -Be 0
        }
    }

    It 'rejects HTTP200 embedded errors, partial status tables, and malformed rows' {
        foreach ($response in @(
            @{ error = @{ code = 'partial' }; Tables = @() },
            @{ Exceptions = @('partial'); Tables = @() },
            @{ Tables = @(@{ TableName = 'QueryStatus'; Columns = @(); Rows = @() }) },
            @{ Tables = @(@{ TableName = 'Table_0'; Columns = @(@{ ColumnName = 'value' }); Rows = @(,@(5, 6)) }) }
        )) {
            { ConvertFrom-MiningSnapshotQuery $response } | Should -Throw
        }
        $failed = New-TestKustoEnvelope @{ TableName = 'Table_0'; Columns = @(@{ ColumnName = 'value' }); Rows = @(,@(5)) }
        $failed.Tables[2].Rows[0][0] = 3
        { ConvertFrom-MiningSnapshotQuery $failed } | Should -Throw '*partial failure*'
    }
}
