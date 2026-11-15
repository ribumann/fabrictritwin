#Requires -Version 7.0
BeforeAll {
    $script:Generator = Join-Path $PSScriptRoot '..' '..' 'scripts' 'fabric' 'New-MiningDataAgentDefinition.ps1'
    $script:Workspace = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
    $script:Model = '34a2e63a-f3d3-4d8f-8d26-58f298d876be'
    $definition = (& $script:Generator -WorkspaceId $script:Workspace -SemanticModelId $script:Model) | ConvertFrom-Json
    $script:Parts = @{}
    foreach ($part in $definition.definition.parts) {
        $script:Parts[$part.path] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json
    }
}

Describe 'Mining data agent definition' {
    It 'selects the semantic model and exposes relationship columns' {
        $source = $script:Parts['Files/Config/draft/semantic_model-mining-d01-topology/datasource.json']
        $source.artifactId | Should -Be $script:Model
        $source.workspaceId | Should -Be $script:Workspace
        $source.type | Should -Be 'semantic_model'
        $source.elements.Count | Should -Be 12
        $line = $source.elements | Where-Object display_name -eq 'Line'
        $line.is_selected | Should -BeTrue
        ($line.children | Where-Object display_name -eq 'parent_id').is_selected | Should -BeTrue
        $plant = $source.elements | Where-Object display_name -eq 'Plant'
        ($plant.children | Where-Object display_name -eq 'Plant count').type | Should -Be 'semantic_model.measure'
    }

    It 'includes a relationship example and clearly describes static data' {
        $example = $script:Parts['Files/Config/draft/semantic_model-mining-d01-topology/fewshots.json'].fewShots[0]
        $example.query | Should -Match "'Line'\[parent_id\] = 'Plant'\[id\]"
        $stage = $script:Parts['Files/Config/draft/stage_config.json']
        $stage.aiInstructions | Should -Match 'static catalog, not live telemetry'
    }
}
