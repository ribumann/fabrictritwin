BeforeAll {
    $root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:graphGenerator = Join-Path $root 'scripts\mining-ontology\New-MiningGraphDefinition.ps1'
    $script:catalog = Join-Path $root 'apps\simulator\src\mining\plant-catalog.json'
    $script:ontologyId = [Guid]'b4f76927-6f3e-4141-b2d4-74893943a8d9'
    $script:tablesRoot = 'https://onelake.dfs.fabric.microsoft.com/11111111-1111-4111-a111-111111111111/22222222-2222-4222-a222-222222222222/Tables'
    $script:ontologyFixture = & (Join-Path $root 'scripts\mining-ontology\New-MiningTmdlDefinition.ps1') `
        -CatalogPath $script:catalog -SqlServer 'fixture.datawarehouse.fabric.microsoft.com' `
        -SqlDatabase 'mining_fixture' -LogicalId $script:ontologyId
    function New-TestPart([string]$Path, $Value) {
        @{
            path = $Path; payloadType = 'InlineBase64'
            payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 20)))
        }
    }
    function Read-TestPart($Definition, [string]$Path) {
        $part = $Definition.definition.parts | Where-Object path -CEQ $Path
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json -AsHashtable
    }
    $schemaRoot = 'https://developer.microsoft.com/json-schemas/fabric/item/graphIndex/definition'
    $script:graphFixture = @{ definition = @{ parts = @(
        (New-TestPart 'graphType.json' @{ '$schema' = "$schemaRoot/graphType/1.0.0/schema.json"; nodeTypes = $null; edgeTypes = $null }),
        (New-TestPart 'dataSources.json' @{ '$schema' = "$schemaRoot/dataSources/1.0.0/schema.json"; dataSources = $null }),
        (New-TestPart 'graphDefinition.json' @{ '$schema' = "$schemaRoot/graphDefinition/1.0.0/schema.json"; nodeTables = $null; edgeTables = $null }),
        (New-TestPart '.platform' @{ metadata = @{ type = 'GraphModel'; displayName = "mining_d01_ontology_graph_$($script:ontologyId.ToString('N'))" }; config = @{ logicalId = 'service-owned' } }),
        (New-TestPart 'graphSettings.json' @{ scalingConfiguration = @{ sku = @{ tier = 'small' } } }),
        (New-TestPart 'stylingConfiguration.json' @{ serviceOwned = $true })
    ) } }
    function Save-GraphFixture($Definition) {
        $Definition | ConvertTo-Json -Depth 30 | Set-Content $script:graphArguments.GraphPreimagePath
        $script:graphArguments.GraphPreimageSha256 = (Get-FileHash $script:graphArguments.GraphPreimagePath).Hash
    }
    function Change-OntologyPart([string]$Path, [string]$Old, [string]$New) {
        $definition = Get-Content $script:graphArguments.OntologyDefinitionPath -Raw | ConvertFrom-Json -AsHashtable
        $part = $definition.parts | Where-Object path -CEQ $Path
        $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload))
        $part.payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text.Replace($Old, $New)))
        $definition | ConvertTo-Json -Depth 30 | Set-Content $script:graphArguments.OntologyDefinitionPath
        $script:graphArguments.OntologyDefinitionSha256 = (Get-FileHash $script:graphArguments.OntologyDefinitionPath).Hash
    }
}

Describe 'Mining native catalog graph' {
    BeforeEach {
        $script:graphArguments = @{
            CatalogPath = $script:catalog; OntologyId = $script:ontologyId
            OntologyDefinitionPath = Join-Path $TestDrive 'ontology.json'
            GraphPreimagePath = Join-Path $TestDrive 'graph.json'
            OneLakeTablesPath = $script:tablesRoot
        }
        $script:ontologyFixture | ConvertTo-Json -Depth 30 | Set-Content $script:graphArguments.OntologyDefinitionPath
        $script:graphArguments.OntologyDefinitionSha256 = (Get-FileHash $script:graphArguments.OntologyDefinitionPath).Hash
        Save-GraphFixture $script:graphFixture
    }

    It 'uses native lineage keys, directed endpoint mappings and the exact ABFSS catalog sources' {
        $definition = & $script:graphGenerator @script:graphArguments
        $type = Read-TestPart $definition 'graphType.json'
        $binding = Read-TestPart $definition 'graphDefinition.json'
        $sources = (Read-TestPart $definition 'dataSources.json').dataSources
        $type.nodeTypes.Count | Should -Be 6
        $type.edgeTypes.Count | Should -Be 6
        $sources.Count | Should -Be 12
        foreach ($source in $sources) {
            $source.properties.path | Should -BeExactly "abfss://11111111-1111-4111-a111-111111111111@onelake.dfs.fabric.microsoft.com/22222222-2222-4222-a222-222222222222/Tables/dbo/$($source.name)"
        }
        foreach ($table in $binding.nodeTables) {
            $entityPart = $script:ontologyFixture.parts | Where-Object path -CEQ "entities/$($table.dataSourceName).tmdl"
            $tablePart = $script:ontologyFixture.parts | Where-Object path -CEQ "tables/$($table.dataSourceName).tmdl"
            [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($entityPart.payload)) |
                Should -Match "\tlineageTag: $($table.nodeTypeAlias)\b"
            [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($tablePart.payload)) |
                Should -Match "\tlineageTag: $($table.id)\b"
        }
        foreach ($table in $binding.edgeTables) {
            $table.sourceNodeKeyColumns | Should -Be @('source_id')
            $table.destinationNodeKeyColumns | Should -Be @('target_id')
            $table.edgeIdMapping | Should -Be @('source_id', 'target_id')
            @($table.propertyMappings | ForEach-Object { "$($_.propertyName):$($_.sourceColumn)" }) |
                Should -Be @('source_id:source_id', 'target_id:target_id')
        }
        $send = $type.edgeTypes | Where-Object { $_.labels -contains 'mining_D01_ModuleSendsStream' }
        $receive = $type.edgeTypes | Where-Object { $_.labels -contains 'mining_D01_StreamTargetsModule' }
        $send.sourceNodeType.alias | Should -BeExactly $receive.destinationNodeType.alias
        $send.destinationNodeType.alias | Should -BeExactly $receive.sourceNodeType.alias
    }

    It 'preserves service metadata and accepts semantically identical normalized readback' {
        $definition = & $script:graphGenerator @script:graphArguments
        foreach ($path in @('.platform', 'graphSettings.json', 'stylingConfiguration.json')) {
            ($definition.definition.parts | Where-Object path -CEQ $path).payload |
                Should -BeExactly ($script:graphFixture.definition.parts | Where-Object path -CEQ $path).payload
        }
        $graphType = Read-TestPart $definition 'graphType.json'
        $part = $definition.definition.parts | Where-Object path -CEQ 'graphType.json'
        $part.payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($graphType | ConvertTo-Json -Depth 20)))
        Save-GraphFixture $definition
        $again = & $script:graphGenerator @script:graphArguments
        (Read-TestPart $again 'graphDefinition.json' | ConvertTo-Json -Depth 20 -Compress) |
            Should -BeExactly (Read-TestPart $definition 'graphDefinition.json' | ConvertTo-Json -Depth 20 -Compress)
        $drift = Read-TestPart $definition 'dataSources.json'
        $drift.dataSources[0].properties.path += '/different'
        $definition.definition.parts = @($definition.definition.parts | Where-Object path -CNE 'dataSources.json') +
            @(New-TestPart 'dataSources.json' $drift)
        Save-GraphFixture $definition
        { & $script:graphGenerator @script:graphArguments } | Should -Throw '*Existing graph configuration differs*'
    }

    It 'adds every catalog-backed property without changing graph identities or edges' {
        $legacy = & $script:graphGenerator @script:graphArguments
        $sourcesPart = $legacy.definition.parts | Where-Object path -CEQ 'dataSources.json'
        $sources = Read-TestPart $legacy 'dataSources.json'
        $sourcesPart.payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($sources | ConvertTo-Json -Depth 20)))
        Save-GraphFixture $legacy
        $expanded = & $script:graphGenerator @script:graphArguments -IncludeAllProperties
        $oldType = Read-TestPart $legacy 'graphType.json'
        $newType = Read-TestPart $expanded 'graphType.json'
        $oldBinding = Read-TestPart $legacy 'graphDefinition.json'
        $newBinding = Read-TestPart $expanded 'graphDefinition.json'
        ($newType.edgeTypes | ConvertTo-Json -Depth 20 -Compress) |
            Should -BeExactly ($oldType.edgeTypes | ConvertTo-Json -Depth 20 -Compress)
        ($newBinding.edgeTables | ConvertTo-Json -Depth 20 -Compress) |
            Should -BeExactly ($oldBinding.edgeTables | ConvertTo-Json -Depth 20 -Compress)
        foreach ($node in $newType.nodeTypes) {
            $oldNode = $oldType.nodeTypes | Where-Object alias -CEQ $node.alias
            $table = $newBinding.nodeTables | Where-Object nodeTypeAlias -CEQ $node.alias
            $oldTable = $oldBinding.nodeTables | Where-Object nodeTypeAlias -CEQ $node.alias
            $oldNode | Should -Not -BeNullOrEmpty
            $table.id | Should -BeExactly $oldTable.id
            $node.properties.name | Should -Contain 'metadata_json'
            foreach ($property in $node.properties) {
                $property.type | Should -BeExactly 'STRING'
                @($table.propertyMappings | Where-Object {
                    $_.propertyName -ceq $property.name -and $_.sourceColumn -ceq $property.name
                }).Count | Should -Be 1
            }
        }
        foreach ($path in @('dataSources.json', '.platform', 'graphSettings.json', 'stylingConfiguration.json')) {
            ($expanded.definition.parts | Where-Object path -CEQ $path).payload |
                Should -BeExactly ($legacy.definition.parts | Where-Object path -CEQ $path).payload
        }
        Save-GraphFixture $expanded
        $again = & $script:graphGenerator @script:graphArguments -IncludeAllProperties
        (Read-TestPart $again 'graphType.json' | ConvertTo-Json -Depth 20 -Compress) |
            Should -BeExactly (Read-TestPart $expanded 'graphType.json' | ConvertTo-Json -Depth 20 -Compress)
    }

    It 'refuses a changed existing graph or an unverified additional property mapping' {
        $legacy = & $script:graphGenerator @script:graphArguments
        $changed = Read-TestPart $legacy 'graphDefinition.json'
        $changed.edgeTables[0].sourceNodeKeyColumns = @('target_id')
        $legacy.definition.parts = @($legacy.definition.parts | Where-Object path -CNE 'graphDefinition.json') +
            @(New-TestPart 'graphDefinition.json' $changed)
        Save-GraphFixture $legacy
        { & $script:graphGenerator @script:graphArguments -IncludeAllProperties } |
            Should -Throw '*Existing graph configuration differs*'
        Save-GraphFixture $script:graphFixture
        Change-OntologyPart 'entities/mining_D01_Tag.tmdl' 'valueColumn: mining_D01_Tag.unit' 'valueColumn: mining_D01_Tag.id'
        { & $script:graphGenerator @script:graphArguments -IncludeAllProperties } |
            Should -Throw '*Unresolved graph property mining_D01_Tag.unit*'
    }

    It 'refuses a partially expanded graph definition' {
        $legacy = & $script:graphGenerator @script:graphArguments
        Save-GraphFixture $legacy
        $expanded = & $script:graphGenerator @script:graphArguments -IncludeAllProperties
        $legacy.definition.parts = @($legacy.definition.parts | Where-Object path -CNE 'graphType.json') +
            @($expanded.definition.parts | Where-Object path -CEQ 'graphType.json')
        Save-GraphFixture $legacy
        { & $script:graphGenerator @script:graphArguments -IncludeAllProperties } |
            Should -Throw '*inconsistent projection states*'
    }

    It 'rejects snapshot drift and off-target metadata or source roots before producing a definition' {
        $bad = $script:graphArguments.Clone()
        $bad.GraphPreimageSha256 = '0' * 64
        { & $script:graphGenerator @bad } | Should -Throw '*snapshot changed*'
        $bad = $script:graphArguments.Clone()
        $bad.OneLakeTablesPath += '?redirect=elsewhere'
        { & $script:graphGenerator @bad } | Should -Throw '*exact observed OneLake*'
        $bad.OneLakeTablesPath = $script:tablesRoot.Replace('11111111-1111-4111-a111-111111111111', [Guid]::Empty.ToString())
        { & $script:graphGenerator @bad } | Should -Throw '*must be nonempty*'
        $bad = $script:graphArguments.Clone()
        $bad.OntologyId = [Guid]::NewGuid()
        { & $script:graphGenerator @bad } | Should -Throw '*selected Mining-owned*'
    }

    It 'rejects reversed relationships and changed physical endpoint bindings' {
        Change-OntologyPart 'entityRelationships.tmdl' "fromEntity: mining_D01_Module`n" "fromEntity: mining_D01_Stream`n"
        { & $script:graphGenerator @script:graphArguments } | Should -Throw '*reversed Mining relationship*'
        $script:ontologyFixture | ConvertTo-Json -Depth 30 | Set-Content $script:graphArguments.OntologyDefinitionPath
        Change-OntologyPart 'tables/mining_D01_StreamTargetsModule.tmdl' 'sourceColumn: target_id' 'sourceColumn: source_id'
        { & $script:graphGenerator @script:graphArguments } | Should -Throw '*Unresolved graph endpoint*'
    }
}
