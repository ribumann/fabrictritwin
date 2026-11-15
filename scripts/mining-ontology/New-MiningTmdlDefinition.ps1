#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CatalogPath,
    [Parameter(Mandatory)][string]$SqlServer,
    [Parameter(Mandatory)][string]$SqlDatabase,
    [Parameter(Mandatory)][guid]$LogicalId
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($SqlServer -cnotmatch '^[a-z0-9-]+\.datawarehouse\.fabric\.microsoft\.com$' -or
    $SqlDatabase -cnotmatch '^[A-Za-z][A-Za-z0-9_]{0,122}$' -or $LogicalId -eq [guid]::Empty) {
    throw 'Exact Fabric SQL hostname, Lakehouse name and nonempty logical ID are required.'
}
Import-Module (Join-Path $PSScriptRoot 'MiningOntology.psm1') -Force
$tables = New-MiningCatalogTables -CatalogPath $CatalogPath
$ownership = Get-Content (Join-Path $PSScriptRoot '..\..\infra\fabric\mining-ontology\ownership.json') -Raw |
    ConvertFrom-Json
$parts = [Collections.Generic.List[object]]::new()
function Add-Part([string]$Path, [string]$Text) {
    $parts.Add([ordered]@{
        path = $Path
        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))
        payloadType = 'InlineBase64'
    })
}
function Get-Lineage([string]$Name) {
    $hash = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("mining-D01-tmdl-v1/$Name"))
    $hex = [Convert]::ToHexString($hash).ToLowerInvariant()
    '{0}-{1}-5{2}-a{3}-{4}' -f $hex.Substring(0, 8), $hex.Substring(8, 4),
        $hex.Substring(13, 3), $hex.Substring(17, 3), $hex.Substring(20, 12)
}
$platform = [ordered]@{
    metadata = @{ type = 'Ontology'; displayName = 'mining_d01_ontology' }
    config = @{ version = '2.0'; logicalId = $LogicalId.ToString() }
}
Add-Part '.platform' ($platform | ConvertTo-Json -Depth 5 -Compress)
Add-Part 'database.tmdl' "database`n`tcompatibilityLevel: 1000000`n"
Add-Part 'namespaces/default.tmdl' "namespace default`n`tlineageTag: default`n"
Add-Part 'expressions.tmdl' @"
expression DatabaseQuery =
        let
            database = Sql.Database("$SqlServer", "$SqlDatabase")
        in
            database

"@
$model = [Collections.Generic.List[string]]::new()
$model.Add('model Model')
$model.Add('')
foreach ($table in $tables) {
    $name = $table.name
    $columns = @(($table.csv | ConvertFrom-Csv | Select-Object -First 1).PSObject.Properties.Name)
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add("table $name")
    $lines.Add("`tlineageTag: $(Get-Lineage "table/$name")")
    foreach ($column in $columns) {
        $lines.Add("`n`tcolumn $column")
        $lines.Add("`t`tdataType: string")
        $lines.Add("`t`tlineageTag: $(Get-Lineage "column/$name/$column")")
        $lines.Add("`t`tsourceColumn: $column")
    }
    $lines.Add("`n`tpartition $name = entity")
    $lines.Add("`t`tmode: directLake")
    $lines.Add("`t`tsource")
    $lines.Add("`t`t`tentityName: $name")
    $lines.Add("`t`t`tschemaName: dbo")
    $lines.Add("`t`t`texpressionSource: DatabaseQuery")
    Add-Part "tables/$name.tmdl" (($lines -join "`n") + "`n")
    $model.Add("ref table $name")
    if ($columns -cnotcontains 'id') { continue }
    $entity = [Collections.Generic.List[string]]::new()
    $entity.Add("entity $name")
    $entity.Add("`tlineageTag: $(Get-Lineage "entity/$name")")
    $entity.Add("`tbackingTable: $name")
    $entity.Add("`tkeyProperty: id")
    foreach ($column in $columns) {
        $entity.Add("`n`tproperty $column")
        $entity.Add("`t`tdataType: string")
        $entity.Add("`t`tlineageTag: $(Get-Lineage "property/$name/$column")")
        $entity.Add("`n`t`tbackingConfiguration")
        $entity.Add("`t`t`tvalueColumn: $name.$column")
    }
    Add-Part "entities/$name.tmdl" (($entity -join "`n") + "`n")
    $model.Add("ref entity $name")
}
$relationships = [Collections.Generic.List[string]]::new()
$entityRelationships = [Collections.Generic.List[string]]::new()
foreach ($link in $ownership.relationships) {
    $name = "mining_D01_$($link.name)"
    foreach ($end in @('source', 'target')) {
        $relationships.Add("relationship ${name}_$end")
        $relationships.Add("`tfromColumn: ${name}.${end}_id")
        $relationships.Add("`ttoColumn: mining_D01_$($link.$end).id")
        $relationships.Add('')
    }
    $entityRelationships.Add("entityRelationship $name")
    $entityRelationships.Add("`tlineageTag: $(Get-Lineage "relationship/$name")")
    $entityRelationships.Add("`tfromEntity: mining_D01_$($link.source)")
    $entityRelationships.Add("`ttoEntity: mining_D01_$($link.target)")
    $entityRelationships.Add("`n`tbackingConfiguration")
    $entityRelationships.Add("`t`ttype: table")
    $entityRelationships.Add("`t`ttable: $name")
    $entityRelationships.Add("`t`tfromRelationship: ${name}_source")
    $entityRelationships.Add("`t`ttoRelationship: ${name}_target")
    $entityRelationships.Add('')
}
Add-Part 'relationships.tmdl' ($relationships -join "`n")
Add-Part 'entityRelationships.tmdl' ($entityRelationships -join "`n")
$model.Add('ref namespace default')
Add-Part 'model.tmdl' (($model -join "`n") + "`n")
[ordered]@{ parts = $parts.ToArray() }
