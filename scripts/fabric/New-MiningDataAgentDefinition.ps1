#Requires -Version 7.0
param(
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$SemanticModelId
)

function Get-MiningDataAgentElementId {
    param([Parameter(Mandatory)][string]$Name)
    # UUIDv5 in the standard URL namespace: stable, target-scoped definition IDs,
    # not semantic model lineage tags or cloud item IDs.
    $namespace = [Convert]::FromHexString('6ba7b8119dad11d180b400c04fd430c8')
    $nameBytes = [Text.Encoding]::UTF8.GetBytes(
        "mining-d01-data-agent-elements/v1/$WorkspaceId/$SemanticModelId/$Name")
    $hash = [Security.Cryptography.SHA1]::HashData([byte[]]($namespace + $nameBytes))
    $hash[6] = ($hash[6] -band 0x0f) -bor 0x50
    $hash[8] = ($hash[8] -band 0x3f) -bor 0x80
    $hex = [Convert]::ToHexString($hash, 0, 16).ToLowerInvariant()
    return ('{0}-{1}-{2}-{3}-{4}' -f $hex.Substring(0, 8), $hex.Substring(8, 4),
        $hex.Substring(12, 4), $hex.Substring(16, 4), $hex.Substring(20, 12))
}

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
            @{
                id = Get-MiningDataAgentElementId "column/$table/$column"
                display_name = $column; type = 'semantic_model.column'; is_selected = $true; data_type = 'string'
            }
        }
        if ($table -eq 'Plant') {
            foreach ($measure in $measures) {
                @{
                    id = Get-MiningDataAgentElementId "measure/$table/$measure"
                    display_name = $measure; type = 'semantic_model.measure'; is_selected = $true
                }
            }
        }
    )
    @{
        id = Get-MiningDataAgentElementId "table/$table"
        display_name = $table; type = 'semantic_model.table'; is_selected = $true; children = $children
    }
}

$config = @{ '$schema' = '2.1.0' }
$stage = @{
    '$schema' = '1.0.0'
    aiInstructions = 'Answer only from the Mining D01 topology semantic model. It is a static catalog, not live telemetry. Line[parent_id] identifies its Plant[id]. PlantHasLine[source_id] is the plant ID and PlantHasLine[target_id] is the line ID. For line-to-plant questions match those IDs and return their labels; the shared line is also a catalog line. Do not invent data; state uncertainty.'
}
$sourceDisplayName = 'Mining D01 topology semantic model'
$source = @{
    '$schema' = '1.0.0'
    artifactId = "$SemanticModelId"
    workspaceId = "$WorkspaceId"
    displayName = $sourceDisplayName
    type = 'semantic_model'
    elements = @($elements)
}
# Semantic-model folders use the source display name verbatim, not a slug.
# Semantic-model sources do not support source instructions/descriptions or
# example queries (fewshots.json).
$files = @(
    @{ path = 'Files/Config/data_agent.json'; value = $config },
    @{ path = 'Files/Config/draft/stage_config.json'; value = $stage },
    @{ path = "Files/Config/draft/semantic-model-$sourceDisplayName/datasource.json"; value = $source }
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
