#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:OwnershipPath = Join-Path $PSScriptRoot '..\..\infra\fabric\mining-ontology\ownership.json'

function Get-MiningTextHash {
    param([Parameter(Mandatory)][AllowEmptyString()][string]$Text)
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
}

function ConvertTo-MiningJson {
    param([Parameter(Mandatory)]$Value)
    ConvertTo-Json -InputObject $Value -Depth 100 -Compress
}

function Get-MiningSortedRows {
    param([Parameter(Mandatory)][array]$Rows, [string[]]$Keys = @('id'))
    $sorted = [Collections.Generic.List[object]]::new()
    foreach ($row in $Rows) { $sorted.Add($row) }
    $sorted.Sort([Comparison[object]]{
        param($Left, $Right)
        foreach ($key in $Keys) {
            $comparison = [StringComparer]::Ordinal.Compare([string]$Left[$key], [string]$Right[$key])
            if ($comparison -ne 0) { return $comparison }
        }
        return 0
    })
    return ,$sorted.ToArray()
}

function Get-MiningGuid {
    param([Parameter(Mandatory)][string]$Name)
    $hex = Get-MiningTextHash "mining-D01-old-json-v1/$Name"
    # Stable UUID-shaped identifiers, with version/variant bits fixed.
    '{0}-{1}-5{2}-a{3}-{4}' -f $hex.Substring(0, 8), $hex.Substring(8, 4),
        $hex.Substring(13, 3), $hex.Substring(17, 3), $hex.Substring(20, 12)
}

function Read-MiningCatalog {
    param([Parameter(Mandatory)][string]$Path)
    $ownership = Get-Content -LiteralPath $script:OwnershipPath -Raw | ConvertFrom-Json -AsHashtable
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ownership.catalogSha256) {
        throw 'Unknown source catalog: bytes do not match the pinned D01 catalog hash.'
    }
    $catalog = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    if ($catalog.plant_id -cne 'D01' -or $catalog.schema_version -ne 1 -or
        $catalog.units -cne 'meters' -or $catalog.coordinates -cne 'right-handed-y-up') {
        throw 'Unsupported D01 catalog coordinates or schema.'
    }
    $expectedCounts = @{ modules = 24; equipment = 64; streams = 50; telemetry_tags = 56 }
    $index = @{}
    foreach ($kind in $expectedCounts.Keys) {
        if ($catalog[$kind].Count -ne $expectedCounts[$kind]) { throw "Invalid $kind count." }
        $index[$kind] = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
        foreach ($record in $catalog[$kind]) {
            if ([string]::IsNullOrWhiteSpace($record.id) -or -not $index[$kind].TryAdd($record.id, $record)) {
                throw "Duplicate or missing $kind identifier."
            }
        }
    }
    foreach ($module in $catalog.modules) {
        if ($module.line -cnotin @('A', 'B', 'C', 'shared') -or
            -not $module.id.StartsWith("D01.$($module.line).", [StringComparison]::Ordinal)) {
            throw 'Invalid module line ownership.'
        }
        foreach ($field in @('position', 'size', 'rotation')) {
            if ($module[$field].Count -ne 3) { throw "Invalid authored $field." }
            foreach ($number in $module[$field]) {
                if ($number -isnot [ValueType] -or -not [double]::IsFinite([double]$number)) {
                    throw "Invalid authored $field."
                }
                if ($field -eq 'size' -and $number -le 0) { throw 'Invalid authored size.' }
            }
        }
    }
    foreach ($equipment in $catalog.equipment) {
        if (-not $index.modules.ContainsKey($equipment.module_id)) { throw 'Dangling equipment module.' }
    }
    foreach ($tag in $catalog.telemetry_tags) {
        if (-not $index.modules.ContainsKey($tag.module_id) -or
            -not $index.equipment.ContainsKey($tag.equipment_id) -or
            $index.equipment[$tag.equipment_id].module_id -cne $tag.module_id -or
            $tag.value_type -cne 'double' -or [string]::IsNullOrWhiteSpace($tag.unit)) {
            throw 'Dangling or invalid tag contract.'
        }
    }
    foreach ($stream in $catalog.streams) {
        foreach ($end in @('source', 'target')) {
            $reference = $stream[$end]
            if (-not $index.modules.ContainsKey($reference.module_id)) { throw 'Dangling stream module.' }
            $ports = @($index.modules[$reference.module_id].ports | Where-Object { $_.id -ceq $reference.port_id })
            $direction = if ($end -eq 'source') { 'out' } else { 'in' }
            if ($ports.Count -ne 1 -or $ports[0].direction -cne $direction) {
                throw 'Dangling or reversed stream port.'
            }
        }
    }
    return $catalog
}

function ConvertTo-MiningCsv {
    param([Parameter(Mandatory)][array]$Rows)
    if ($Rows.Count -eq 0) { throw 'Empty catalog table.' }
    # Explicit LF and UTF-8 bytes make receipts independent of the host platform.
    (@($Rows | ForEach-Object { [pscustomobject]$_ } | ConvertTo-Csv) -join "`n") + "`n"
}

function New-MiningPart {
    param([string]$Path, $Value)
    [ordered]@{
        path = $Path
        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-MiningJson $Value)))
        payloadType = 'InlineBase64'
    }
}

function Get-MiningPartMap {
    param([Parameter(Mandatory)]$Definition)
    $map = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    foreach ($part in $Definition.parts) {
        if ([string]::IsNullOrWhiteSpace($part.path) -or -not $map.TryAdd($part.path, $part)) {
            throw 'Duplicate or missing definition part path.'
        }
        if ($part.payloadType -cne 'InlineBase64') { throw 'Unsupported definition payload type.' }
        $null = [Convert]::FromBase64String($part.payload)
    }
    if (-not $map.ContainsKey('.platform') -or -not $map.ContainsKey('definition.json')) {
        throw 'Not an OLD JSON ontology definition: required parts missing.'
    }
    $root = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($map['definition.json'].payload)) |
        ConvertFrom-Json -AsHashtable
    if ($root -isnot [Collections.IDictionary] -or $root.Count -ne 0) { throw 'Not an OLD JSON ontology definition.' }
    return ,$map
}

function Get-MiningDefinitionHash {
    param([Parameter(Mandatory)]$Definition)
    $map = Get-MiningPartMap $Definition
    $paths = [string[]]@($map.Keys)
    [Array]::Sort($paths, [StringComparer]::Ordinal)
    $parts = @($paths | ForEach-Object { $map[$_] })
    Get-MiningTextHash (ConvertTo-MiningJson ([ordered]@{ parts = $parts }))
}

function Assert-MiningTarget {
    param([Parameter(Mandatory)]$Target, [Parameter(Mandatory)]$Baseline)
    foreach ($field in @('TenantId', 'SubscriptionId', 'WorkspaceId', 'OntologyId', 'StaticLakehouseId', 'OntologyOutputLakehouseId')) {
        $id = [guid]::Empty
        if (-not $Target.Contains($field) -or -not [guid]::TryParseExact($Target[$field], 'D', [ref]$id) -or $id -eq [guid]::Empty) {
            throw "Invalid exact target $field."
        }
    }
    if (-not $Target.Contains('SourceSchema') -or $Target.SourceSchema -cne 'dbo' -or
        @($Target.OntologyId, $Target.StaticLakehouseId, $Target.OntologyOutputLakehouseId | Select-Object -Unique).Count -ne 3) {
        throw 'Invalid static source target: dbo and distinct source/output/ontology items required.'
    }
    $proof = $false
    foreach ($part in $Baseline.parts) {
        if ($part.path -cmatch '^EntityTypes/\d+/DataBindings/[^/]+\.json$') {
            $binding = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) |
                ConvertFrom-Json -AsHashtable
            $configuration = $binding.dataBindingConfiguration
            $source = $configuration.sourceTableProperties
            if ($configuration.dataBindingType -ceq 'NonTimeSeries' -and $source.sourceType -ceq 'LakehouseTable' -and
                $source.workspaceId -eq $Target.WorkspaceId -and $source.itemId -eq $Target.StaticLakehouseId -and
                $source.sourceSchema -ceq $Target.SourceSchema) { $proof = $true }
        }
    }
    if (-not $proof) { throw 'Static source target is not established by an existing native static binding.' }
}

function New-MiningOntologyPlan {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$CatalogPath,
        [Parameter(Mandatory)][string]$BaselinePath,
        [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$BaselineSha256,
        [Parameter(Mandatory)][string]$CurrentPath,
        [Parameter(Mandatory)][string]$TargetPath,
        [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$TargetSha256
    )
    foreach ($entry in @(@($BaselinePath, $BaselineSha256), @($TargetPath, $TargetSha256))) {
        if ((Get-FileHash -LiteralPath $entry[0] -Algorithm SHA256).Hash -ine $entry[1]) {
            throw 'Reviewed input hash mismatch.'
        }
    }
    $catalog = Read-MiningCatalog $CatalogPath
    $ownership = Get-Content -LiteralPath $script:OwnershipPath -Raw | ConvertFrom-Json -AsHashtable
    $baseline = Get-Content -LiteralPath $BaselinePath -Raw | ConvertFrom-Json -AsHashtable
    $current = Get-Content -LiteralPath $CurrentPath -Raw | ConvertFrom-Json -AsHashtable
    $target = Get-Content -LiteralPath $TargetPath -Raw | ConvertFrom-Json -AsHashtable
    $baselineMap = Get-MiningPartMap $baseline
    $currentMap = Get-MiningPartMap $current
    Assert-MiningTarget $target $baseline
    $rows = @{}
    foreach ($type in $ownership.entityTypes) { $rows[$type.name] = [Collections.Generic.List[object]]::new() }
    $plantMetadata = [ordered]@{}
    $catalogKeys = [string[]]@($catalog.Keys)
    [Array]::Sort($catalogKeys, [StringComparer]::Ordinal)
    foreach ($key in $catalogKeys) {
        if ($key -cnotin @('modules', 'equipment', 'streams', 'telemetry_tags')) { $plantMetadata[$key] = $catalog[$key] }
    }
    $rows.Plant.Add([ordered]@{ id = 'D01'; label = $catalog.name; parent_id = ''; unit = $catalog.units; metadata_json = ConvertTo-MiningJson $plantMetadata })
    foreach ($line in @('A', 'B', 'C', 'shared')) {
        $rows.Line.Add([ordered]@{ id = "D01.$line"; label = $line; parent_id = 'D01'; unit = ''; metadata_json = ConvertTo-MiningJson ([ordered]@{ plant_id = 'D01'; line = $line }) })
    }
    foreach ($module in $catalog.modules) {
        $rows.Module.Add([ordered]@{ id = $module.id; label = $module.label; parent_id = "D01.$($module.line)"; unit = $catalog.units; metadata_json = ConvertTo-MiningJson $module })
    }
    foreach ($equipment in $catalog.equipment) {
        $rows.Equipment.Add([ordered]@{ id = $equipment.id; label = $equipment.name; parent_id = $equipment.module_id; unit = ''; metadata_json = ConvertTo-MiningJson $equipment })
    }
    foreach ($tag in $catalog.telemetry_tags) {
        $rows.Tag.Add([ordered]@{ id = $tag.id; label = $tag.metric; parent_id = $tag.equipment_id; unit = $tag.unit; metadata_json = ConvertTo-MiningJson $tag })
    }
    foreach ($stream in $catalog.streams) {
        $rows.Stream.Add([ordered]@{ id = $stream.id; label = $stream.id; parent_id = $stream.source.module_id; unit = $catalog.units; metadata_json = ConvertTo-MiningJson $stream })
    }
    $parts = [Collections.Generic.List[object]]::new()
    $tables = [Collections.Generic.List[object]]::new()
    $types = @{}
    $reservedIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $reservedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($type in $ownership.entityTypes) {
        $types[$type.name] = $type
        $null = $reservedIds.Add($type.id)
        $null = $reservedNames.Add("mining_D01_$($type.name)")
        $properties = @()
        $bindings = @()
        $columns = @('id', 'label', 'parent_id', 'unit', 'metadata_json')
        $suffixes = @('Id', 'Label', 'Parent', 'Unit', 'Metadata')
        for ($i = 0; $i -lt $columns.Count; $i++) {
            $propertyId = ([long]$type.propertyBase + $i + 1).ToString([Globalization.CultureInfo]::InvariantCulture)
            $propertyName = "mining$($type.name)$($suffixes[$i])"
            $null = $reservedIds.Add($propertyId)
            $null = $reservedNames.Add($propertyName)
            $properties += [ordered]@{ id = $propertyId; name = $propertyName; valueType = 'String' }
            $bindings += [ordered]@{ sourceColumnName = $columns[$i]; targetPropertyId = $propertyId }
        }
        $entity = [ordered]@{
            id = $type.id; namespace = 'usertypes'; name = "mining_D01_$($type.name)"
            namespaceType = 'Custom'; visibility = 'Visible'
            entityIdParts = @($properties[0].id); displayNamePropertyId = $properties[1].id
            properties = $properties; timeseriesProperties = @()
        }
        $parts.Add((New-MiningPart "EntityTypes/$($type.id)/definition.json" $entity))
        $tableName = "mining_D01_$($type.name)"
        $source = [ordered]@{
            sourceType = 'LakehouseTable'; workspaceId = $target.WorkspaceId
            itemId = $target.StaticLakehouseId; sourceTableName = $tableName; sourceSchema = $target.SourceSchema
        }
        $bindingId = Get-MiningGuid "binding/$($type.name)"
        $null = $reservedIds.Add($bindingId)
        $parts.Add((New-MiningPart "EntityTypes/$($type.id)/DataBindings/$bindingId.json" ([ordered]@{
            id = $bindingId
            dataBindingConfiguration = [ordered]@{ dataBindingType = 'NonTimeSeries'; propertyBindings = $bindings; sourceTableProperties = $source }
        })))
        $tableRows = Get-MiningSortedRows $rows[$type.name].ToArray()
        $csv = ConvertTo-MiningCsv $tableRows
        $tables.Add([ordered]@{ name = $tableName; rowCount = $tableRows.Count; sha256 = Get-MiningTextHash $csv; csv = $csv })
    }
    foreach ($relationship in $ownership.relationships) {
        $null = $reservedIds.Add($relationship.id)
        $null = $reservedNames.Add("mining_D01_$($relationship.name)")
        $parts.Add((New-MiningPart "RelationshipTypes/$($relationship.id)/definition.json" ([ordered]@{
            id = $relationship.id; namespace = 'usertypes'; namespaceType = 'Custom'
            name = "mining_D01_$($relationship.name)"
            source = @{ entityTypeId = $types[$relationship.source].id }
            target = @{ entityTypeId = $types[$relationship.target].id }
        })))
        $links = if ($relationship.name -eq 'ModuleSendsStream') {
            @($catalog.streams | ForEach-Object { [ordered]@{ source_id = $_.source.module_id; target_id = $_.id } })
        } elseif ($relationship.name -eq 'StreamTargetsModule') {
            @($catalog.streams | ForEach-Object { [ordered]@{ source_id = $_.id; target_id = $_.target.module_id } })
        } else {
            @($rows[$relationship.target].ToArray() | ForEach-Object { [ordered]@{ source_id = $_.parent_id; target_id = $_.id } })
        }
        $links = Get-MiningSortedRows $links -Keys @('source_id', 'target_id')
        $tableName = "mining_D01_$($relationship.name)"
        $csv = ConvertTo-MiningCsv $links
        $tables.Add([ordered]@{ name = $tableName; rowCount = $links.Count; sha256 = Get-MiningTextHash $csv; csv = $csv })
        $contextId = Get-MiningGuid "context/$($relationship.name)"
        $null = $reservedIds.Add($contextId)
        $parts.Add((New-MiningPart "RelationshipTypes/$($relationship.id)/Contextualizations/$contextId.json" ([ordered]@{
            id = $contextId
            dataBindingTable = [ordered]@{
                workspaceId = $target.WorkspaceId; itemId = $target.StaticLakehouseId
                sourceTableName = $tableName; sourceSchema = $target.SourceSchema; sourceType = 'LakehouseTable'
            }
            sourceKeyRefBindings = @([ordered]@{ sourceColumnName = 'source_id'; targetPropertyId = ([long]$types[$relationship.source].propertyBase + 1).ToString() })
            targetKeyRefBindings = @([ordered]@{ sourceColumnName = 'target_id'; targetPropertyId = ([long]$types[$relationship.target].propertyBase + 1).ToString() })
        })))
    }
    $owned = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    foreach ($part in $parts) { $owned.Add($part.path, $part) }
    foreach ($part in $baseline.parts) {
        if ($owned.ContainsKey($part.path)) {
            if ((ConvertTo-MiningJson $part) -cne (ConvertTo-MiningJson $owned[$part.path])) { throw "Owned part collision: $($part.path)" }
            continue
        }
        if ($part.path -cmatch '^(EntityTypes|RelationshipTypes)/(\d+)/') {
            if ($reservedIds.Contains($Matches[2])) { throw "Unowned part in reserved type: $($part.path)" }
            $node = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload)) | ConvertFrom-Json -AsHashtable
            $identifiers = @($node)
            if ($node.Contains('properties')) { $identifiers += @($node.properties) }
            if ($node.Contains('timeseriesProperties')) { $identifiers += @($node.timeseriesProperties) }
            if ($node.Contains('untypedProperties')) { $identifiers += @($node.untypedProperties) }
            foreach ($identifier in $identifiers) {
                if (($identifier.Contains('id') -and $reservedIds.Contains([string]$identifier.id)) -or
                    ($identifier.Contains('name') -and $reservedNames.Contains([string]$identifier.name))) {
                    throw "Unowned identifier collision: $($part.path)"
                }
            }
        }
    }
    $merged = [Collections.Generic.List[object]]::new()
    foreach ($part in $baseline.parts) { $merged.Add($part) }
    foreach ($part in $parts) {
        if (-not $baselineMap.ContainsKey($part.path)) { $merged.Add($part) }
    }
    $desired = [ordered]@{ parts = @($merged.ToArray()) }
    $baselineHash = Get-MiningDefinitionHash $baseline
    $currentHash = Get-MiningDefinitionHash $current
    $desiredHash = Get-MiningDefinitionHash $desired
    if ($currentHash -cne $baselineHash -and $currentHash -cne $desiredHash) { throw 'Current definition drift; refusing additive plan.' }
    $requests = @($tables | ForEach-Object {
        [ordered]@{
            table = $_.name
            metadataUri = "https://onelake.table.fabric.microsoft.com/delta/$($target.WorkspaceId)/$($target.StaticLakehouseId)/api/2.1/unity-catalog/tables/$($target.StaticLakehouseId).$($target.SourceSchema).$($_.name)"
            method = 'POST'
            uri = "https://api.fabric.microsoft.com/v1/workspaces/$($target.WorkspaceId)/lakehouses/$($target.StaticLakehouseId)/schemas/$($target.SourceSchema)/tables/$($_.name)/load?beta=true"
            body = [ordered]@{
                relativePath = "Files/mining-D01/$($_.sha256)/$($_.name).csv"
                pathType = 'File'; mode = 'Overwrite'; recursive = $false
                formatOptions = [ordered]@{ format = 'Csv'; header = $true; delimiter = ',' }
            }
        }
    })
    [ordered]@{
        owner = $ownership.owner; status = $(if ($currentHash -ceq $desiredHash) { 'DefinitionMatchesOffline' } else { 'ChangesPlannedOffline' })
        catalogSha256 = $ownership.catalogSha256; targetSha256 = $TargetSha256.ToLowerInvariant()
        baselineSha256 = $BaselineSha256.ToLowerInvariant(); currentDefinitionSha256 = $currentHash; desiredDefinitionSha256 = $desiredHash
        addedParts = @($parts | Where-Object { -not $currentMap.ContainsKey($_.path) } | ForEach-Object { $_.path })
        target = $target; tables = @($tables.ToArray()); loadRequests = $requests; definition = $desired
        liveVerified = $false; staticRowsVerified = $false; timeSeriesBound = $false
        blockers = @(
            'BLOCKED: live schema-aware managed-table metadata, column-mapping checks, permissions, CSV upload/load and row/hash verification are required before definition update.',
            'BLOCKED: no validated curated mining Eventhouse table with tag_id, timestamp, value and unit columns has been established; raw event:dynamic is not a time-series binding.',
            'BLOCKED: no atomic compare-and-swap is documented for ontology updateDefinition; exclusive-writer coordination and a fresh live preimage check are required.'
        )
    }
}

function Export-MiningOntologyPlan {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Plan, [Parameter(Mandatory)][string]$OutputDirectory)
    if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory already exists; preserve the reviewed bundle.' }
    $null = New-Item -ItemType Directory -Path $OutputDirectory
    foreach ($table in $Plan.tables) {
        [IO.File]::WriteAllText((Join-Path $OutputDirectory "$($table.name).csv"), $table.csv, [Text.UTF8Encoding]::new($false))
    }
    $definitionPath = Join-Path $OutputDirectory 'definition.json'
    [IO.File]::WriteAllText($definitionPath, (ConvertTo-MiningJson $Plan.definition), [Text.UTF8Encoding]::new($false))
    $receipt = [ordered]@{}
    foreach ($key in $Plan.Keys) {
        if ($key -notin @('definition', 'tables')) { $receipt[$key] = $Plan[$key] }
    }
    $receipt.tables = @($Plan.tables | ForEach-Object { [ordered]@{ name = $_.name; rowCount = $_.rowCount; sha256 = $_.sha256 } })
    $receipt.definitionFileSha256 = (Get-FileHash -LiteralPath $definitionPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'plan.json'), (ConvertTo-MiningJson $receipt), [Text.UTF8Encoding]::new($false))
    $receipt
}

Export-ModuleMember -Function New-MiningOntologyPlan, Export-MiningOntologyPlan
