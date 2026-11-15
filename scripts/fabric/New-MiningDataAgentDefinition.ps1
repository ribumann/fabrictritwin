#Requires -Version 7.0
param(
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$SemanticModelId
)

$tables = @(
    'Plant', 'Line', 'Module', 'Equipment', 'Tag', 'Stream',
    'PlantHasLine', 'LineHasModule', 'ModuleHasEquipment', 'EquipmentHasTag',
    'ModuleSendsStream', 'StreamTargetsModule'
)
$measures = @(
    'Plant count', 'Line count', 'Module count', 'Equipment count', 'Tag count',
    'Stream count', 'Catalog relationship count', 'Modules per line',
    'Equipment per module', 'Tags per equipment', 'Outgoing streams per module',
    'Incoming streams per module', 'Tagged equipment', 'Equipment tag coverage'
)
$elements = foreach ($table in $tables) {
    $columns = if ($table -in @('Plant', 'Line', 'Module', 'Equipment', 'Tag', 'Stream')) {
        @('id', 'label', 'parent_id', 'unit')
    } else {
        @('source_id', 'target_id')
    }
    $children = @(
        foreach ($column in $columns) {
            @{ display_name = $column; type = 'semantic_model.column'; is_selected = $true; data_type = 'string' }
        }
        if ($table -eq 'Plant') {
            foreach ($measure in $measures) {
                @{ display_name = $measure; type = 'semantic_model.measure'; is_selected = $true }
            }
        }
    )
    @{ display_name = $table; type = 'semantic_model.table'; is_selected = $true; children = $children }
}

$config = @{ '$schema' = '2.1.0' }
$stage = @{
    '$schema' = '1.0.0'
    aiInstructions = 'Answer only from the Mining D01 topology semantic model. It is a static catalog, not live telemetry. Line[parent_id] identifies its Plant[id]. For line-to-plant questions match those IDs and return their labels; the shared line is also a catalog line. Do not invent data; state uncertainty.'
}
$source = @{
    '$schema' = '1.0.0'
    artifactId = "$SemanticModelId"
    workspaceId = "$WorkspaceId"
    displayName = 'Mining D01 topology semantic model'
    type = 'semantic_model'
    userDescription = 'Static Mining D01 topology catalog, not live telemetry.'
    dataSourceInstructions = 'Use the semantic model for static topology. Line[parent_id] matches Plant[id]; PlantHasLine[source_id] is the plant ID and [target_id] the line ID.'
    elements = @($elements)
}
$examples = @{
    '$schema' = '1.0.0'
    fewShots = @(@{
        id = 'a7ad0f20-c25d-49d5-9f4f-91db04354439'
        question = 'What are the names of the production lines and which plant do they belong to?'
        query = 'EVALUATE SELECTCOLUMNS(FILTER(CROSSJOIN(''Line'', ''Plant''), ''Line''[parent_id] = ''Plant''[id]), "Line", ''Line''[label], "Plant", ''Plant''[label], "Plant ID", ''Plant''[id])'
    })
}
$files = @(
    @{ path = 'Files/Config/data_agent.json'; value = $config },
    @{ path = 'Files/Config/draft/stage_config.json'; value = $stage },
    @{ path = 'Files/Config/draft/semantic_model-mining-d01-topology/datasource.json'; value = $source },
    @{ path = 'Files/Config/draft/semantic_model-mining-d01-topology/fewshots.json'; value = $examples }
)
$parts = foreach ($file in $files) {
    $json = $file.value | ConvertTo-Json -Depth 30 -Compress
    @{
        path = $file.path
        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
        payloadType = 'InlineBase64'
    }
}
@{ definition = @{ parts = @($parts) } } | ConvertTo-Json -Depth 30
