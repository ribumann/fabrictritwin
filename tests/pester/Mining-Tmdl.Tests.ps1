BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:generator = Join-Path $root 'scripts\mining-ontology\New-MiningTmdlDefinition.ps1'
    $script:arguments = @{
        CatalogPath = Join-Path $root 'apps\simulator\src\mining\plant-catalog.json'
        SqlServer = 'fixture.datawarehouse.fabric.microsoft.com'
        SqlDatabase = 'mining_fixture'
        LogicalId = 'b4f76927-6f3e-4141-b2d4-74893943a8d9'
    }
    function Read-Parts($Definition) {
        $result = @{}
        foreach ($part in $Definition.parts) {
            $result[$part.path] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload))
        }
        $result
    }
}

Describe 'Mining current-experience ontology' {
    It 'binds every pinned catalog column to the same native table and entity property' {
        $definition = & $script:generator @script:arguments
        $parts = Read-Parts $definition
        $tables = New-MiningCatalogTables -CatalogPath $script:arguments.CatalogPath
        foreach ($table in $tables) {
            $tmdl = $parts["tables/$($table.name).tmdl"]
            $tmdl | Should -Match "entityName: $($table.name)\b"
            $tmdl | Should -Match 'schemaName: dbo'
            $columns = @(($table.csv | ConvertFrom-Csv | Select-Object -First 1).PSObject.Properties.Name)
            foreach ($column in $columns) {
                $tmdl | Should -Match "sourceColumn: $column\b"
                if ($columns -contains 'id') {
                    $parts["entities/$($table.name).tmdl"] |
                        Should -Match "valueColumn: $($table.name)\.$column\b"
                }
            }
        }
        $parts['expressions.tmdl'] | Should -Match 'Sql.Database\("fixture.datawarehouse.fabric.microsoft.com", "mining_fixture"\)'
    }

    It 'preserves directed source and target bindings for each real catalog junction' {
        $parts = Read-Parts (& $script:generator @script:arguments)
        $relations = @(
            @('PlantHasLine', 'Plant', 'Line'),
            @('LineHasModule', 'Line', 'Module'),
            @('ModuleHasEquipment', 'Module', 'Equipment'),
            @('EquipmentHasTag', 'Equipment', 'Tag'),
            @('ModuleSendsStream', 'Module', 'Stream'),
            @('StreamTargetsModule', 'Stream', 'Module')
        )
        foreach ($r in $relations) {
            $name = "mining_D01_$($r[0])"
            $parts['relationships.tmdl'] | Should -Match "relationship ${name}_source\s+fromColumn: $name\.source_id\s+toColumn: mining_D01_$($r[1])\.id"
            $parts['relationships.tmdl'] | Should -Match "relationship ${name}_target\s+fromColumn: $name\.target_id\s+toColumn: mining_D01_$($r[2])\.id"
            $parts['entityRelationships.tmdl'] | Should -Match "fromEntity: mining_D01_$($r[1])\s+toEntity: mining_D01_$($r[2])"
        }
    }

    It 'is reproducible and rejects endpoint or expression injection before generating parts' {
        (& $script:generator @script:arguments | ConvertTo-Json -Depth 8 -Compress) |
            Should -BeExactly (& $script:generator @script:arguments | ConvertTo-Json -Depth 8 -Compress)
        $bad = $script:arguments.Clone()
        $bad.SqlServer = 'https://fixture.datawarehouse.fabric.microsoft.com'
        { & $script:generator @bad } | Should -Throw '*Exact Fabric SQL hostname*'
        $bad.SqlServer = $script:arguments.SqlServer
        $bad.SqlDatabase = 'name"), malicious'
        { & $script:generator @bad } | Should -Throw '*Exact Fabric SQL hostname*'
    }
}
