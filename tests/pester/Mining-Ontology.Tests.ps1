#Requires -Version 7.0
BeforeAll {
    $script:modulePath = Join-Path $PSScriptRoot '..\..\scripts\mining-ontology\MiningOntology.psm1'
    $script:planner = Join-Path $PSScriptRoot '..\..\scripts\mining-ontology\plan.ps1'
    Import-Module $script:modulePath -Force
    function Write-Fixture($Path, $Value) {
        [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 100 -Compress), [Text.UTF8Encoding]::new($false))
    }
    function New-Part($Path, $Value) {
        [ordered]@{
            path = $Path
            payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Value -Depth 100 -Compress)))
            payloadType = 'InlineBase64'
        }
    }
    function Read-Part($Plan, $Path) {
        $part = $Plan.definition.parts | Where-Object { $_.path -ceq $Path }
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json -AsHashtable
    }
    function Get-FixtureHash($Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }
}

Describe 'D01 additive OLD JSON ontology source' {
    BeforeEach {
        $script:catalogPath = Join-Path $TestDrive 'catalog.json'
        $script:baselinePath = Join-Path $TestDrive 'baseline.json'
        $script:currentPath = Join-Path $TestDrive 'current.json'
        $script:targetPath = Join-Path $TestDrive 'target.json'
        $script:target = [ordered]@{
            TenantId = '00000000-0000-0000-0000-000000000001'
            SubscriptionId = '00000000-0000-0000-0000-000000000002'
            WorkspaceId = '00000000-0000-0000-0000-000000000003'
            OntologyId = '00000000-0000-0000-0000-000000000004'
            StaticLakehouseId = '00000000-0000-0000-0000-000000000005'
            OntologyOutputLakehouseId = '00000000-0000-0000-0000-000000000006'
            SourceSchema = 'dbo'
        }
        $script:catalog = [ordered]@{
            schema_version = 1; plant_id = 'D01'; name = 'Fixture plant'
            units = 'meters'; coordinates = 'right-handed-y-up'
            modules = @(); equipment = @(); telemetry_tags = @(); streams = @()
        }
        for ($i = 0; $i -lt 24; $i++) {
            $line = @('A', 'B', 'C', 'shared')[[int][Math]::Floor($i / 6)]
            $script:catalog.modules += [ordered]@{
                id = "D01.$line.module$i"; line = $line; label = "Module $i"
                position = @($i, 1, 0); size = @(2, 2, 2); rotation = @(0, 0, 0)
                ports = @(@{ id = 'in'; direction = 'in' }, @{ id = 'out'; direction = 'out' })
                geometry_evidence = 'authored-fixture-not-engineering-truth'
            }
        }
        for ($i = 0; $i -lt 64; $i++) {
            $module = $script:catalog.modules[$i % 24]
            $script:catalog.equipment += [ordered]@{
                id = "$($module.id).equipment$i"; module_id = $module.id
                name = "Equipment $i"; geometry = 'logical-child-no-independent-geometry'
            }
        }
        for ($i = 0; $i -lt 56; $i++) {
            $equipment = $script:catalog.equipment[$i]
            $script:catalog.telemetry_tags += [ordered]@{
                id = "$($equipment.module_id).metric$i"; module_id = $equipment.module_id
                equipment_id = $equipment.id; metric = "metric$i"; value_type = 'double'; unit = 'Cel'
            }
        }
        for ($i = 0; $i -lt 50; $i++) {
            $script:catalog.streams += [ordered]@{
                id = "process-$i"
                source = @{ module_id = $script:catalog.modules[$i % 24].id; port_id = 'out' }
                target = @{ module_id = $script:catalog.modules[($i + 1) % 24].id; port_id = 'in' }
                material = 'ore'; transport = 'belt'; route_points_m = @(@(0, 1, 0), @(1, 1, 0))
            }
        }
        $script:athletePart = New-Part 'EntityTypes/20000000000001/definition.json' ([ordered]@{
            id = '20000000000001'; name = 'Athlete'; properties = @(@{ id = '21000000000001'; name = 'athleteId' })
        })
        $script:baseline = [ordered]@{ parts = @(
            (New-Part '.platform' @{ metadata = @{ type = 'Ontology'; displayName = 'Existing' } }),
            (New-Part 'definition.json' @{}),
            $script:athletePart,
            (New-Part 'EntityTypes/20000000000001/DataBindings/athlete.json' @{
                id = '00000000-0000-0000-0000-000000000007'
                dataBindingConfiguration = @{
                    dataBindingType = 'NonTimeSeries'
                    sourceTableProperties = @{
                        sourceType = 'LakehouseTable'; workspaceId = $script:target.WorkspaceId
                        itemId = $script:target.StaticLakehouseId; sourceSchema = 'dbo'; sourceTableName = 'Athlete'
                    }
                }
            }),
            (New-Part 'EntityTypes/20000000000001/Documents/private.json' @{ url = 'https://example.invalid/unchanged' })
        ) }
        # Non-canonical whitespace inside an unrelated payload must survive exactly.
        $script:baseline.parts[4].payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("{`r`n  `"url`": `"https://example.invalid/unchanged`"`r`n}"))
        Write-Fixture $script:catalogPath $script:catalog
        Write-Fixture $script:baselinePath $script:baseline
        Write-Fixture $script:currentPath $script:baseline
        Write-Fixture $script:targetPath $script:target
        $script:arguments = @{
            CatalogPath = $script:catalogPath; BaselinePath = $script:baselinePath
            BaselineSha256 = Get-FixtureHash $script:baselinePath
            CurrentPath = $script:currentPath; TargetPath = $script:targetPath
            TargetSha256 = Get-FixtureHash $script:targetPath
        }
        # Only the synthetic fixture's byte pin is substituted; validation/production pinning remain real.
        Mock Get-FileHash -ModuleName MiningOntology {
            if ($LiteralPath -eq $script:catalogPath) {
                @{ Hash = '0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce' }
            } else {
                Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256
            }
        }
        Mock Invoke-WebRequest { throw 'Unexpected network request.' }
        Mock Invoke-RestMethod { throw 'Unexpected network request.' }
    }

    It 'generates deterministic native parts and the exact catalog counts without telemetry copies' {
        $first = New-MiningOntologyPlan @script:arguments
        $second = New-MiningOntologyPlan @script:arguments
        $first.desiredDefinitionSha256 | Should -BeExactly $second.desiredDefinitionSha256
        ($first | ConvertTo-Json -Depth 100 -Compress) | Should -BeExactly ($second | ConvertTo-Json -Depth 100 -Compress)
        $first.addedParts | Should -HaveCount 24
        $first.tables | Should -HaveCount 12
        foreach ($entry in @{ Plant = 1; Line = 4; Module = 24; Equipment = 64; Tag = 56; Stream = 50; PlantHasLine = 4; LineHasModule = 24; ModuleHasEquipment = 64; EquipmentHasTag = 56; ModuleSendsStream = 50; StreamTargetsModule = 50 }.GetEnumerator()) {
            ($first.tables | Where-Object name -eq "mining_D01_$($entry.Key)").rowCount | Should -Be $entry.Value
        }
        $first.timeSeriesBound | Should -BeFalse
        $first.staticRowsVerified | Should -BeFalse
        $first.liveVerified | Should -BeFalse
        $first.blockers -join ' ' | Should -Match 'curated mining Eventhouse'
        Should -Invoke Invoke-WebRequest -Times 0
        Should -Invoke Invoke-RestMethod -Times 0
    }

    It 'preserves all athlete and unowned parts including their byte payloads' {
        $plan = New-MiningOntologyPlan @script:arguments
        for ($i = 0; $i -lt $script:baseline.parts.Count; $i++) {
            ($plan.definition.parts[$i] | ConvertTo-Json -Compress) |
                Should -BeExactly ($script:baseline.parts[$i] | ConvertTo-Json -Compress)
        }
    }

    It 'preserves authored spatial/stream metadata and units and creates no readings for untagged children' {
        $plan = New-MiningOntologyPlan @script:arguments
        $modules = ($plan.tables | Where-Object name -eq 'mining_D01_Module').csv | ConvertFrom-Csv
        $module = $modules | Where-Object id -eq 'D01.A.module0'
        $metadata = $module.metadata_json | ConvertFrom-Json
        $metadata.position | Should -Be @(0, 1, 0)
        $metadata.size | Should -Be @(2, 2, 2)
        $metadata.geometry_evidence | Should -BeExactly 'authored-fixture-not-engineering-truth'
        $tags = @(($plan.tables | Where-Object name -eq 'mining_D01_Tag').csv | ConvertFrom-Csv)
        $tags.unit | Select-Object -Unique | Should -BeExactly 'Cel'
        $tags.parent_id | Should -Not -Contain $script:catalog.equipment[63].id
        $streams = ($plan.tables | Where-Object name -eq 'mining_D01_Stream').csv | ConvertFrom-Csv
        ($streams[0].metadata_json | ConvertFrom-Json).route_points_m | Should -HaveCount 2
        ($plan.tables | Where-Object name -eq 'mining_D01_ModuleSendsStream').csv |
            Should -Match '"D01.A.module0","process-0"'
    }

    It 'uses unique native IDs, GUID bindings, and property-key references' {
        $plan = New-MiningOntologyPlan @script:arguments
        $ids = @()
        foreach ($part in $plan.definition.parts | Where-Object { $_.path -match '^(EntityTypes/41001|RelationshipTypes/43001)' }) {
            $node = Read-Part $plan $part.path
            $ids += $node.id
            if ($node.Contains('properties')) {
                $ids += $node.properties.id
                $node.entityIdParts[0] | Should -Be $node.properties[0].id
                $node.timeseriesProperties | Should -HaveCount 0
            }
            if ($node.Contains('dataBindingConfiguration') -or $node.Contains('dataBindingTable')) {
                { [guid]::Parse($node.id) } | Should -Not -Throw
            }
        }
        @($ids | Select-Object -Unique).Count | Should -Be $ids.Count
    }

    It 'uses only schema-enabled exact source routes with the documented CSV body' {
        $plan = New-MiningOntologyPlan @script:arguments
        foreach ($request in $plan.loadRequests) {
            $request.uri | Should -BeExactly "https://api.fabric.microsoft.com/v1/workspaces/$($script:target.WorkspaceId)/lakehouses/$($script:target.StaticLakehouseId)/schemas/dbo/tables/$($request.table)/load?beta=true"
            $request.metadataUri | Should -Match '/api/2.1/unity-catalog/tables/.+\.dbo\.mining_D01_'
            $request.uri | Should -Not -Match $script:target.OntologyOutputLakehouseId
            $request.body.mode | Should -BeExactly 'Overwrite'
            $request.body.relativePath | Should -Match '^Files/mining-D01/[a-f0-9]{64}/mining_D01_\w+\.csv$'
            $request.body.formatOptions.format | Should -BeExactly 'Csv'
            $request.body.formatOptions.header | Should -BeTrue
        }
    }

    It 'exports reproducible CSV receipts and refuses overwriting a reviewed bundle' {
        $plan = New-MiningOntologyPlan @script:arguments
        $output = Join-Path $TestDrive 'bundle'
        $receipt = Export-MiningOntologyPlan $plan $output
        foreach ($table in $receipt.tables) {
            $path = Join-Path $output "$($table.name).csv"
            (Get-FixtureHash $path).ToLowerInvariant() | Should -BeExactly $table.sha256
            @(Import-Csv -LiteralPath $path).Count | Should -Be $table.rowCount
        }
        (Get-FixtureHash (Join-Path $output 'definition.json')).ToLowerInvariant() | Should -BeExactly $receipt.definitionFileSha256
        { Export-MiningOntologyPlan $plan $output } | Should -Throw '*already exists*'
    }

    It 'has an idempotent second plan and verifies the desired snapshot offline' {
        $plan = New-MiningOntologyPlan @script:arguments
        Write-Fixture $script:currentPath $plan.definition
        $second = New-MiningOntologyPlan @script:arguments
        $second.status | Should -BeExactly 'DefinitionMatchesOffline'
        $second.addedParts | Should -HaveCount 0
        $second.desiredDefinitionSha256 | Should -BeExactly $plan.desiredDefinitionSha256
        # A new baseline after installation remains an exact no-op too.
        Write-Fixture $script:baselinePath $plan.definition
        $script:arguments.BaselineSha256 = Get-FixtureHash $script:baselinePath
        (New-MiningOntologyPlan @script:arguments).addedParts | Should -HaveCount 0
    }

    It 'is deterministic in fresh processes and across cultures' {
        $argumentJson = ConvertTo-Json -InputObject $script:arguments -Compress
        $command = @'
Import-Module '__MODULE__' -Force
& (Get-Module MiningOntology) {
    function script:Get-FileHash {
        param($LiteralPath, $Algorithm)
        if ($LiteralPath -eq '__CATALOG__') {
            @{ Hash = '0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce' }
        } else {
            Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
        }
    }
}
$arguments = '__ARGUMENTS__' | ConvertFrom-Json -AsHashtable
[Globalization.CultureInfo]::CurrentCulture = '__CULTURE__'
(New-MiningOntologyPlan @arguments).desiredDefinitionSha256
'@
        $command = $command.Replace('__MODULE__', $script:modulePath.Replace("'", "''")).
            Replace('__CATALOG__', $script:catalogPath.Replace("'", "''")).
            Replace('__ARGUMENTS__', $argumentJson.Replace("'", "''"))
        $hashes = @()
        foreach ($culture in @('en-US', 'tr-TR')) {
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command.Replace('__CULTURE__', $culture)))
            $hashes += & (Get-Process -Id $PID).Path -NoProfile -NonInteractive -EncodedCommand $encoded
            $LASTEXITCODE | Should -Be 0
        }
        $hashes | Should -HaveCount 2
        $hashes[0] | Should -BeExactly $hashes[1]
    }

    It 'rejects unknown catalog bytes and unreviewed baseline/target hashes' {
        Mock Get-FileHash -ModuleName MiningOntology { @{ Hash = ('0' * 64) } } -ParameterFilter { $LiteralPath -eq $script:catalogPath }
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*Unknown source catalog*'
        $script:arguments.BaselineSha256 = 'f' * 64
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*input hash*'
        $script:arguments.BaselineSha256 = Get-FixtureHash $script:baselinePath
        $script:arguments.TargetSha256 = 'f' * 64
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*input hash*'
    }

    It 'rejects dangling and reversed catalog links and wrong counts' {
        $script:catalog.telemetry_tags[0].equipment_id = 'unknown'
        Write-Fixture $script:catalogPath $script:catalog
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*tag contract*'
        $script:catalog.telemetry_tags[0].equipment_id = $script:catalog.equipment[0].id
        $script:catalog.streams[0].target.port_id = 'out'
        Write-Fixture $script:catalogPath $script:catalog
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*stream port*'
        $script:catalog.streams = $script:catalog.streams[0..48]
        Write-Fixture $script:catalogPath $script:catalog
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*streams count*'
    }

    It 'rejects output Lakehouse substitution, foreign source, and non-dbo routes' {
        $script:target.StaticLakehouseId = $script:target.OntologyOutputLakehouseId
        Write-Fixture $script:targetPath $script:target
        $script:arguments.TargetSha256 = Get-FixtureHash $script:targetPath
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*distinct*'
        $script:target.StaticLakehouseId = '00000000-0000-0000-0000-000000000099'
        Write-Fixture $script:targetPath $script:target
        $script:arguments.TargetSha256 = Get-FixtureHash $script:targetPath
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*not established*'
        $script:target.SourceSchema = '../Athlete'
        Write-Fixture $script:targetPath $script:target
        $script:arguments.TargetSha256 = Get-FixtureHash $script:targetPath
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*dbo*'
    }

    It 'rejects current drift, duplicate parts, and changed owned parts' {
        $plan = New-MiningOntologyPlan @script:arguments
        $plan.definition.parts[0].payload = 'e30='
        Write-Fixture $script:currentPath $plan.definition
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*drift*'
        $script:baseline.parts += $script:baseline.parts[0]
        Write-Fixture $script:baselinePath $script:baseline
        $script:arguments.BaselineSha256 = Get-FixtureHash $script:baselinePath
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*Duplicate*'
    }

    It 'rejects integer/property/name collisions in unrelated native types' {
        $script:baseline.parts += New-Part 'EntityTypes/888/definition.json' @{
            id = '888'; name = 'Other'; properties = @(@{ id = '42001000000101'; name = 'otherProperty' })
        }
        Write-Fixture $script:baselinePath $script:baseline
        $script:arguments.BaselineSha256 = Get-FixtureHash $script:baselinePath
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*identifier collision*'
        $script:baseline.parts[-1] = New-Part 'EntityTypes/888/definition.json' @{ id = '888'; name = 'mining_D01_Plant' }
        Write-Fixture $script:baselinePath $script:baseline
        $script:arguments.BaselineSha256 = Get-FixtureHash $script:baselinePath
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*identifier collision*'
        $script:baseline.parts[-1] = New-Part 'EntityTypes/888/definition.json' @{
            id = '888'; name = 'Other'; untypedProperties = @(@{ id = '42001000000101'; name = 'otherProperty' })
        }
        Write-Fixture $script:baselinePath $script:baseline
        $script:arguments.BaselineSha256 = Get-FixtureHash $script:baselinePath
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*identifier collision*'
        $script:baseline.parts[-1] = New-Part 'EntityTypes/41001000000001/definition.json' @{ id = '41001000000001'; name = 'Other' }
        Write-Fixture $script:baselinePath $script:baseline
        $script:arguments.BaselineSha256 = Get-FixtureHash $script:baselinePath
        { New-MiningOntologyPlan @script:arguments } | Should -Throw '*Owned part collision*'
    }

    It 'blocks first and repeated apply and refuses verifying an uninstalled snapshot without any network calls' {
        # Script reimports the module: install its fixture hash mock again in that module scope.
        Mock Import-Module {} -ParameterFilter { $Name -like '*MiningOntology.psm1' }
        { & $script:planner @script:arguments -Mode Verify } | Should -Throw '*does not match*'
        { & $script:planner @script:arguments -Mode Apply } | Should -Throw '*Apply is blocked*'
        $plan = New-MiningOntologyPlan @script:arguments
        Write-Fixture $script:currentPath $plan.definition
        (& $script:planner @script:arguments -Mode Verify).status | Should -BeExactly 'DefinitionMatchesOffline'
        { & $script:planner @script:arguments -Mode Apply } | Should -Throw '*Apply is blocked*'
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
        Should -Invoke Invoke-RestMethod -Times 0 -Exactly
    }
}
