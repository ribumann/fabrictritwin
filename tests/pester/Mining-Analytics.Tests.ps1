BeforeAll {
    $script:root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:generator = Join-Path $script:root 'scripts\fabric\New-MiningAnalyticsDefinition.ps1'
    $script:arguments = @{
        WorkspaceId = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
        LakehouseId = '0774df89-ff28-415b-be16-c31a1604cbf4'
        SemanticModelId = '11111111-2222-4333-8444-555555555555'
        DefinitionKind = 'All'
    }

    function Read-PartText($Request, [string]$Path) {
        $parts = @($Request.definition.parts | Where-Object path -CEQ $Path)
        if ($parts.Count -ne 1) { throw "Expected one definition part '$Path'." }
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[0].payload))
    }

    function Read-PartJson($Request, [string]$Path) {
        Read-PartText $Request $Path | ConvertFrom-Json -AsHashtable
    }
}

Describe 'Mining D01 native analytics definitions' {
    It 'creates DirectLake partitions for all twelve existing catalog tables' {
        $definition = & $script:generator @script:arguments
        $request = $definition.SemanticModelRequest
        $tableParts = @($request.definition.parts | Where-Object path -Like 'definition/tables/*.tmdl')

        $request.displayName | Should -BeExactly 'mining-d01-topology-semanticmodel'
        $tableParts | Should -HaveCount 12
        @($request.definition.parts.path | Select-Object -Unique) | Should -HaveCount $request.definition.parts.Count
        foreach ($part in $tableParts) {
            $text = Read-PartText $request $part.path
            $text | Should -Match 'mode: directLake'
            $text | Should -Match "schemaName: dbo"
            $text | Should -Match "expressionSource: 'Mining D01 DirectLake'"
            $text | Should -Match '(?m)^\t{3}entityName: mining_D01_'
            $text | Should -Not -Match '`t|`entity'
        }

        $expression = Read-PartText $request 'definition/expressions.tmdl'
        $expression | Should -Match ([regex]::Escape("https://onelake.dfs.fabric.microsoft.com/$($script:arguments.WorkspaceId)/$($script:arguments.LakehouseId)"))
    }

    It 'preserves both endpoint roles for each of the six catalog relationships' {
        $request = (& $script:generator @script:arguments).SemanticModelRequest
        $relationships = Read-PartText $request 'definition/relationships.tmdl'
        $expected = @(
            @('PlantHasLine_source_id', 'PlantHasLine.source_id', 'Plant.id'),
            @('PlantHasLine_target_id', 'PlantHasLine.target_id', 'Line.id'),
            @('LineHasModule_source_id', 'LineHasModule.source_id', 'Line.id'),
            @('LineHasModule_target_id', 'LineHasModule.target_id', 'Module.id'),
            @('ModuleHasEquipment_source_id', 'ModuleHasEquipment.source_id', 'Module.id'),
            @('ModuleHasEquipment_target_id', 'ModuleHasEquipment.target_id', 'Equipment.id'),
            @('EquipmentHasTag_source_id', 'EquipmentHasTag.source_id', 'Equipment.id'),
            @('EquipmentHasTag_target_id', 'EquipmentHasTag.target_id', 'Tag.id'),
            @('ModuleSendsStream_source_id', 'ModuleSendsStream.source_id', 'Module.id'),
            @('ModuleSendsStream_target_id', 'ModuleSendsStream.target_id', 'Stream.id'),
            @('StreamTargetsModule_source_id', 'StreamTargetsModule.source_id', 'Stream.id'),
            @('StreamTargetsModule_target_id', 'StreamTargetsModule.target_id', 'Module.id')
        )
        foreach ($relation in $expected) {
            $relationships | Should -Match "relationship $($relation[0])\s+fromColumn: $([regex]::Escape($relation[1]))\s+toColumn: $([regex]::Escape($relation[2]))"
        }
    }

    It 'binds each report visual to a real DirectLake category and measure' {
        $definition = & $script:generator @script:arguments
        $request = $definition.ReportRequest
        $binding = Read-PartJson $request 'definition.pbir'
        $visualParts = @($request.definition.parts | Where-Object path -Like 'definition/pages/*/visuals/*/visual.json')

        $request.displayName | Should -BeExactly 'mining-d01-topology-report'
        $binding.datasetReference.byConnection.connectionString |
            Should -BeExactly "semanticmodelid=$($script:arguments.SemanticModelId)"
        $visualParts | Should -HaveCount 4
        foreach ($part in $visualParts) {
            $visual = Read-PartJson $request $part.path
            $visual.visual.visualType | Should -BeExactly 'clusteredBarChart'
            $visual.visual.query.queryState.Category.projections[0].field.Column.Property |
                Should -BeExactly 'label'
            $visual.visual.query.queryState.Y.projections.Count | Should -BeGreaterThan 0
            foreach ($projection in $visual.visual.query.queryState.Y.projections) {
                $projection.field.Measure.Expression.SourceRef.Entity | Should -BeExactly 'Plant'
                $projection.queryRef | Should -Match '^Plant\.'
            }
        }
    }

    It 'is deterministic and requires the actual report binding ID' {
        $first = & $script:generator @script:arguments | ConvertTo-Json -Depth 100 -Compress
        $second = & $script:generator @script:arguments | ConvertTo-Json -Depth 100 -Compress
        $first | Should -BeExactly $second

        $invalid = $script:arguments.Clone()
        $invalid.SemanticModelId = [guid]::Empty
        { & $script:generator @invalid } | Should -Throw '*semantic model ID*'
    }
}
