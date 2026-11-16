#Requires -Version 7.0
BeforeAll {
    $script:Generator = Join-Path $PSScriptRoot '..' '..' 'scripts' 'fabric' 'New-MiningDataAgentDefinition.ps1'
    $script:Workspace = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
    $script:Model = '34a2e63a-f3d3-4d8f-8d26-58f298d876be'
    $script:Definition = (& $script:Generator -WorkspaceId $script:Workspace -SemanticModelId $script:Model) | ConvertFrom-Json
    $script:Parts = @{}
    foreach ($part in $script:Definition.definition.parts) {
        $script:Parts[$part.path] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json
    }

    function Get-TestDataAgentSource($Definition) {
        $part = $Definition.definition.parts | Where-Object path -Like '*/datasource.json'
        return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json
    }

    function Get-TestDataAgentElements($Source) {
        foreach ($table in $Source.elements) {
            $table
            $table.children
        }
    }
}

Describe 'Mining data agent definition' {
    It 'emits only the config, draft stage, and canonical semantic-model source' {
        $script:Definition.definition.parts | Should -HaveCount 3
        foreach ($part in $script:Definition.definition.parts) {
            $part.payloadType | Should -BeExactly 'InlineBase64'
        }
        $script:Parts.Count | Should -Be 3
        $script:Parts.ContainsKey('Files/Config/data_agent.json') | Should -BeTrue
        $script:Parts.ContainsKey('Files/Config/draft/stage_config.json') | Should -BeTrue
        $script:Parts.ContainsKey('Files/Config/draft/semantic-model-Mining D01 topology semantic model/datasource.json') |
            Should -BeTrue
        @($script:Parts.Keys | Where-Object { $_ -match 'fewshots|semantic_model-|/published/|^\.platform$' }) |
            Should -HaveCount 0
    }

    It 'selects the semantic model and exposes relationship columns' {
        $source = $script:Parts['Files/Config/draft/semantic-model-Mining D01 topology semantic model/datasource.json']
        $source.artifactId | Should -Be $script:Model
        $source.workspaceId | Should -Be $script:Workspace
        $source.displayName | Should -BeExactly 'Mining D01 topology semantic model'
        $source.type | Should -BeExactly 'semantic_model'
        $script:Parts.ContainsKey("Files/Config/draft/semantic-model-$($source.displayName)/datasource.json") |
            Should -BeTrue
        $source.'$schema' | Should -BeExactly '1.0.0'
        $source.elements.Count | Should -Be 12
        $line = $source.elements | Where-Object display_name -eq 'Line'
        $line.is_selected | Should -BeTrue
        ($line.children | Where-Object display_name -eq 'parent_id').is_selected | Should -BeTrue
        $plant = $source.elements | Where-Object display_name -eq 'Plant'
        ($plant.children | Where-Object display_name -eq 'Plant count').type | Should -Be 'semantic_model.measure'
    }

    It 'retains schema versions and static relationship guidance without example queries' {
        $script:Parts['Files/Config/data_agent.json'].'$schema' | Should -BeExactly '2.1.0'
        $stage = $script:Parts['Files/Config/draft/stage_config.json']
        $stage.'$schema' | Should -BeExactly '1.0.0'
        $stage.aiInstructions | Should -Match 'static catalog, not live telemetry'
        $stage.aiInstructions | Should -Match 'Line\[parent_id\] identifies its Plant\[id\]'
        $stage.aiInstructions | Should -Match 'PlantHasLine\[source_id\] is the plant ID'
        $stage.aiInstructions | Should -Match 'PlantHasLine\[target_id\] is the line ID'
        $source = $script:Parts['Files/Config/draft/semantic-model-Mining D01 topology semantic model/datasource.json']
        $source.PSObject.Properties.Name | Should -Not -Contain 'userDescription'
        $source.PSObject.Properties.Name | Should -Not -Contain 'dataSourceInstructions'
        $source.PSObject.Properties.Name | Should -Not -Contain 'fewShots'
        $source.PSObject.Properties.Name | Should -Not -Contain 'query'
    }

    It 'provides required unique UUIDs for every table, column, and measure' {
        $source = Get-TestDataAgentSource $script:Definition
        $elements = @(Get-TestDataAgentElements $source)
        $elements | Should -HaveCount 62
        foreach ($element in $elements) {
            $element.id | Should -MatchExactly '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            ([guid]$element.id) | Should -Not -Be ([guid]::Empty)
        }
        @($elements.id | Sort-Object -Unique) | Should -HaveCount 62
        # Independently calculated UUIDv5 vectors lock down namespace, byte order,
        # target scope, parent path, and element kind.
        ($source.elements | Where-Object display_name -eq 'Plant').id |
            Should -BeExactly '51c451c1-275b-5a21-a82a-fe47cca71ac4'
        $line = $source.elements | Where-Object display_name -eq 'Line'
        ($line.children | Where-Object display_name -eq 'parent_id').id |
            Should -BeExactly 'ddcd71c5-d03c-59be-8f85-53ea68bbca5c'
        $plant = $source.elements | Where-Object display_name -eq 'Plant'
        ($plant.children | Where-Object display_name -eq 'Plant count').id |
            Should -BeExactly '12bbcc9c-cf3b-5835-8189-e2f8aa4fdf1e'
    }

    It 'keeps element IDs stable across repeated generation' {
        $repeat = & $script:Generator -WorkspaceId $script:Workspace -SemanticModelId $script:Model | ConvertFrom-Json
        $original = @(Get-TestDataAgentElements (Get-TestDataAgentSource $script:Definition))
        $repeated = @(Get-TestDataAgentElements (Get-TestDataAgentSource $repeat))
        ($repeated.id -join ',') | Should -BeExactly ($original.id -join ',')
    }

    It 'scopes element IDs to the exact <ChangedTarget> target' -ForEach @(
        @{ ChangedTarget = 'workspace' }
        @{ ChangedTarget = 'model' }
    ) {
        $workspace = $script:Workspace
        $model = $script:Model
        if ($ChangedTarget -eq 'workspace') { $workspace = '11111111-2222-4333-8444-555555555555' }
        else { $model = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
        $changed = & $script:Generator -WorkspaceId $workspace -SemanticModelId $model | ConvertFrom-Json
        $originalIds = @(Get-TestDataAgentElements (Get-TestDataAgentSource $script:Definition)).id
        $changedIds = @(Get-TestDataAgentElements (Get-TestDataAgentSource $changed)).id
        @($changedIds | Where-Object { $_ -in $originalIds }) | Should -HaveCount 0
    }
}
