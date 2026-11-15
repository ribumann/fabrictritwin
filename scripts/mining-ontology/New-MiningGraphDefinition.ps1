#Requires -Version 7.4
<#
.SYNOPSIS
    Prepare a catalog-backed graph from reviewed native Mining definition snapshots.
.DESCRIPTION
    Offline only. Preserves live lineage identities and unrelated graph parts.
    Accepted definitions and configured sources do not prove loaded graph instances.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CatalogPath,
    [Parameter(Mandatory)][Guid]$OntologyId,
    [Parameter(Mandatory)][string]$OntologyDefinitionPath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$OntologyDefinitionSha256,
    [Parameter(Mandatory)][string]$GraphPreimagePath,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$GraphPreimageSha256,
    [Parameter(Mandatory)][string]$OneLakeTablesPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'MiningOntology.psm1')
$catalogTables = New-MiningCatalogTables -CatalogPath $CatalogPath
$ownership = Get-Content (Join-Path $PSScriptRoot '..\..\infra\fabric\mining-ontology\ownership.json') -Raw |
    ConvertFrom-Json -AsHashtable
$guidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
if ($OntologyId -eq [Guid]::Empty -or
    $OneLakeTablesPath -cnotmatch "^https://onelake\.dfs\.fabric\.microsoft\.com/($guidPattern)/($guidPattern)/Tables$") {
    throw 'A nonempty ontology identity and exact observed OneLake tables root are required.'
}
$workspaceId = $Matches[1]
$lakehouseId = $Matches[2]
if ([Guid]$workspaceId -eq [Guid]::Empty -or [Guid]$lakehouseId -eq [Guid]::Empty) {
    throw 'OneLake workspace and Lakehouse identities must be nonempty.'
}
$graphTablesPath = "abfss://$workspaceId@onelake.dfs.fabric.microsoft.com/$lakehouseId/Tables/dbo"

function Read-ReviewedParts([string]$Path, [string]$Hash) {
    $bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $Path).Path)
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)) -ine $Hash) {
        throw "Reviewed definition snapshot changed: $Path"
    }
    $definition = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json -AsHashtable
    if ($definition.ContainsKey('definition')) { $definition = $definition.definition }
    $parts = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    foreach ($part in $definition.parts) {
        if ([string]::IsNullOrWhiteSpace($part.path) -or !$parts.TryAdd($part.path, $part) -or
            $part.payloadType -cne 'InlineBase64') {
            throw 'Duplicate, missing or unsupported definition part.'
        }
        $null = [Convert]::FromBase64String($part.payload)
    }
    return ,$parts
}
function Read-PartText($Parts, [string]$Path) {
    if (!$Parts.ContainsKey($Path)) { throw "Required native part missing: $Path" }
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Parts[$Path].payload))
}
$identities = [Collections.Generic.HashSet[Guid]]::new()
function Read-Lineage([string]$Text) {
    $tags = [regex]::Matches($Text, "(?m)^\tlineageTag: ($guidPattern)\r?$")
    if ($tags.Count -ne 1) { throw 'Exactly one native lineage identity is required.' }
    $id = [Guid]$tags[0].Groups[1].Value
    if ($id -eq [Guid]::Empty -or !$identities.Add($id)) { throw 'Empty or colliding native lineage identity.' }
    $id.ToString('D')
}
$ontology = Read-ReviewedParts $OntologyDefinitionPath $OntologyDefinitionSha256
$graph = Read-ReviewedParts $GraphPreimagePath $GraphPreimageSha256
$platform = Read-PartText $graph '.platform' | ConvertFrom-Json -AsHashtable
if ($platform.metadata.type -cne 'GraphModel' -or
    $platform.metadata.displayName -cne "mining_d01_ontology_graph_$($OntologyId.ToString('N'))") {
    throw 'Graph preimage is not the selected Mining-owned ontology graph.'
}
$nodes = @()
$nodeTables = @()
$edges = @()
$edgeTables = @()
$sources = @()
$aliases = @{}
foreach ($type in $ownership.entityTypes) {
    $name = "mining_D01_$($type.name)"
    $entity = Read-PartText $ontology "entities/$name.tmdl"
    $table = Read-PartText $ontology "tables/$name.tmdl"
    if ($entity -notmatch "(?m)^\tbackingTable: $name\r?$" -or
        $entity -notmatch '(?m)^\tkeyProperty: id\r?$' -or
        $table -notmatch '(?m)^\s+schemaName: dbo\r?$' -or
        $table -notmatch "(?m)^\s+entityName: $name\r?$") {
        throw "Missing approved catalog binding for $name."
    }
    foreach ($column in @('id', 'label')) {
        $columnBody = [regex]::Match($table, "(?ms)^\tcolumn $column\r?\n(.*?)(?=^\tcolumn |^\tpartition |\z)").Groups[1].Value
        $propertyBody = [regex]::Match($entity, "(?ms)^\tproperty $column\r?\n(.*?)(?=^\tproperty |\z)").Groups[1].Value
        if ($columnBody -notmatch "(?m)^\t\tsourceColumn: $column\r?$" -or
            $columnBody -notmatch '(?m)^\t\tdataType: string\r?$' -or
            $propertyBody -notmatch "(?m)^\t\t\tvalueColumn: $name\.$column\r?$" -or
            $propertyBody -notmatch '(?m)^\t\tdataType: string\r?$') {
            throw "Unresolved graph property $name.$column."
        }
    }
    $aliases[$name] = Read-Lineage $entity
    $nodes += @{
        alias = $aliases[$name]; labels = @($name); primaryKeyProperties = @('id')
        properties = @(@{ name = 'id'; type = 'STRING' }, @{ name = 'label'; type = 'STRING' })
    }
    $nodeTables += @{
        id = (Read-Lineage $table); nodeTypeAlias = $aliases[$name]; dataSourceName = $name
        propertyMappings = @(
            @{ propertyName = 'id'; sourceColumn = 'id' },
            @{ propertyName = 'label'; sourceColumn = 'label' }
        )
    }
    $sources += @{ name = $name; type = 'DeltaTable'; properties = @{ path = "$graphTablesPath/$name" } }
}
$relationshipText = Read-PartText $ontology 'entityRelationships.tmdl'
$relationships = [regex]::Matches(
    $relationshipText, '(?ms)^entityRelationship (?<name>mining_D01_\w+)\r?\n(?<body>.*?)(?=^entityRelationship |\z)'
)
if ($relationships.Count -ne $ownership.relationships.Count) { throw 'Unexpected Mining relationship set.' }
foreach ($relation in $ownership.relationships) {
    $name = "mining_D01_$($relation.name)"
    $matchesForName = @($relationships | Where-Object { $_.Groups['name'].Value -ceq $name })
    if ($matchesForName.Count -ne 1) { throw "Missing or duplicate Mining relationship $name." }
    $body = $matchesForName[0].Groups['body'].Value
    $from = "mining_D01_$($relation.source)"
    $to = "mining_D01_$($relation.target)"
    $table = Read-PartText $ontology "tables/$name.tmdl"
    if ($body -notmatch "(?m)^\tfromEntity: $from\r?$" -or
        $body -notmatch "(?m)^\ttoEntity: $to\r?$" -or
        $body -notmatch "(?m)^\t\ttable: $name\r?$" -or
        $table -notmatch '(?m)^\s+schemaName: dbo\r?$' -or
        $table -notmatch "(?m)^\s+entityName: $name\r?$" -or
        $table -notmatch '(?m)^\tcolumn source_id\r?$' -or
        $table -notmatch '(?m)^\tcolumn target_id\r?$') {
        throw "Unresolved or reversed Mining relationship $name."
    }
    foreach ($column in @('source_id', 'target_id')) {
        $columnBody = [regex]::Match($table, "(?ms)^\tcolumn $column\r?\n(.*?)(?=^\tcolumn |^\tpartition |\z)").Groups[1].Value
        if ($columnBody -notmatch "(?m)^\t\tsourceColumn: $column\r?$" -or
            $columnBody -notmatch '(?m)^\t\tdataType: string\r?$') {
            throw "Unresolved graph endpoint $name.$column."
        }
    }
    $alias = Read-Lineage $body
    $edges += @{
        alias = $alias; labels = @($name)
        properties = @(@{ name = 'source_id'; type = 'STRING' }, @{ name = 'target_id'; type = 'STRING' })
        sourceNodeType = @{ alias = $aliases[$from] }; destinationNodeType = @{ alias = $aliases[$to] }
    }
    $edgeTables += @{
        id = (Read-Lineage $table); edgeTypeAlias = $alias; dataSourceName = $name
        propertyMappings = @(
            @{ propertyName = 'source_id'; sourceColumn = 'source_id' },
            @{ propertyName = 'target_id'; sourceColumn = 'target_id' }
        )
        edgeIdMapping = @('source_id', 'target_id')
        sourceNodeKeyColumns = @('source_id'); destinationNodeKeyColumns = @('target_id')
    }
    $sources += @{ name = $name; type = 'DeltaTable'; properties = @{ path = "$graphTablesPath/$name" } }
}
if (@($catalogTables | Where-Object { $_.name -cnotin $sources.name }).Count -ne 0) {
    throw 'Graph sources do not match the pinned catalog table set.'
}
$schemaRoot = 'https://developer.microsoft.com/json-schemas/fabric/item/graphIndex/definition'
$replacements = @{
    'graphType.json' = @{ '$schema' = "$schemaRoot/graphType/1.0.0/schema.json"; nodeTypes = $nodes; edgeTypes = $edges }
    'dataSources.json' = @{ '$schema' = "$schemaRoot/dataSources/1.0.0/schema.json"; dataSources = $sources }
    'graphDefinition.json' = @{ '$schema' = "$schemaRoot/graphDefinition/1.0.0/schema.json"; nodeTables = $nodeTables; edgeTables = $edgeTables }
}
$parts = @()
foreach ($part in $graph.Values) {
    if ($replacements.ContainsKey($part.path)) {
        $json = $replacements[$part.path] | ConvertTo-Json -Depth 20 -Compress
        $old = Read-PartText $graph $part.path | ConvertFrom-Json -AsHashtable
        $empty = @{}
        foreach ($key in $replacements[$part.path].Keys) {
            $empty[$key] = if ($key -ceq '$schema') { $replacements[$part.path][$key] } else { $null }
        }
        $oldNode = [System.Text.Json.Nodes.JsonNode]::Parse(($old | ConvertTo-Json -Depth 20 -Compress))
        $desiredNode = [System.Text.Json.Nodes.JsonNode]::Parse($json)
        $emptyNode = [System.Text.Json.Nodes.JsonNode]::Parse(($empty | ConvertTo-Json -Depth 20 -Compress))
        if (![System.Text.Json.Nodes.JsonNode]::DeepEquals($oldNode, $desiredNode) -and
            ![System.Text.Json.Nodes.JsonNode]::DeepEquals($oldNode, $emptyNode)) {
            throw "Existing graph configuration differs from the reviewed Mining contract: $($part.path)"
        }
        $parts += @{
            path = $part.path; payloadType = 'InlineBase64'
            payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
        }
    } else { $parts += $part }
}
foreach ($path in $replacements.Keys) {
    if (!$graph.ContainsKey($path)) { throw "Required native graph part missing: $path" }
}
@{ definition = @{ parts = $parts } }
