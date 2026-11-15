#Requires -Version 7.5
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:CatalogModule = Import-Module (Join-Path $PSScriptRoot '..\mining-ontology\MiningOntology.psm1') -PassThru -Force

function Invoke-SnapshotShared {
    param(
        [ValidateSet('Get-MiningTextHash', 'ConvertTo-MiningCsv', 'ConvertTo-MiningLoadCsv',
            'Assert-MiningLivePrerequisites', 'Get-MiningTableState',
            'Send-MiningCsv', 'Invoke-MiningHttp', 'Assert-MiningHttpStatus', 'Wait-MiningOperation',
            'Save-MiningApplyReceipt', 'Invoke-MiningRecordedWrite')]
        [string]$Name,
        [object[]]$Arguments,
        [hashtable]$NamedArguments = @{}
    )
    & $script:CatalogModule { param($Name, $Arguments, $NamedArguments) & $Name @Arguments @NamedArguments } $Name $Arguments $NamedArguments
}

function Get-SnapshotHash([string]$Text) {
    Invoke-SnapshotShared Get-MiningTextHash @(,$Text)
}

function Get-SnapshotInstant($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$') {
        throw 'Snapshot timestamp must be an explicit UTC source string.'
    }
    $instant = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact($Value,
            [string[]]@("yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'"),
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$instant)) {
        throw 'Invalid snapshot timestamp.'
    }
    $instant
}

function Assert-SnapshotRun($Run, [string]$AsOfUtc) {
    $id = [guid]::Empty
    if (-not [guid]::TryParseExact($Run.runId, 'D', [ref]$id) -or $Run.runId -cne $id.ToString() -or
        $id -eq [guid]::Empty -or $Run.plantId -cne 'D01') {
        throw 'Snapshot requires an exact reviewed D01 run identity.'
    }
    $null = Get-SnapshotInstant $AsOfUtc
    if ($Run.contract.catalogVersion -cne 'sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce' -or
        $Run.contract.profileVersion -cne 'd01-publish-profile-v1' -or $Run.contract.evaluatorReplayVersion -ne 1 -or
        $Run.contract.Count -ne 3) { throw 'Unsupported reviewed source contract.' }
    foreach ($family in @('telemetry', 'state')) {
        $expected = $Run.expected[$family]
        if (($expected.count -isnot [long] -and $expected.count -isnot [int]) -or $expected.count -lt 1 -or $expected.count -gt 2000 -or
            $expected.hash -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid reviewed event identity expectation.' }
    }
}

function ConvertFrom-MiningSnapshotQuery {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Response, [ValidateRange(1, 2001)][int]$MaxRows = 2001)
    if (@($Response.Keys | Where-Object { $_ -cnotin @('Tables', 'Exceptions') }).Count -gt 0 -or
        ($Response.Contains('Exceptions') -and ($Response.Exceptions -isnot [array] -or $Response.Exceptions.Count -ne 0)) -or
        -not $Response.Contains('Tables') -or $Response.Tables.Count -ne 4) {
        throw 'Kusto query returned an embedded error, partial result or unsupported envelope.'
    }
    $tables = @()
    for ($index = 0; $index -lt 4; $index++) {
        $table = $Response.Tables[$index]
        if ($table.TableName -cne "Table_$index" -or $table.Rows.Count -gt $MaxRows -or
            @($table.Columns.ColumnName | Select-Object -Unique).Count -ne $table.Columns.Count) {
            throw 'Kusto query returned a truncated or malformed bounded table.'
        }
        $mapped = @(
            foreach ($values in $table.Rows) {
                if ($values.Count -ne $table.Columns.Count) { throw 'Malformed Kusto row.' }
                $row = [ordered]@{}
                for ($i = 0; $i -lt $values.Count; $i++) { $row[$table.Columns[$i].ColumnName] = $values[$i] }
                $row
            }
        )
        $tables += ,$mapped
    }
    # Match the repository's protected v1 envelope contract, including completion and table-of-contents proof.
    if ($tables[1].Count -ne 1 -or $tables[1][0].Value -isnot [string] -or
        ($tables[1][0].Value | ConvertFrom-Json -AsHashtable -DateKind String) -isnot [Collections.IDictionary] -or
        $tables[2].Count -lt 1 -or $tables[3].Count -ne 3) { throw 'Missing Kusto completion metadata.' }
    foreach ($status in $tables[2]) {
        if (($status.Severity -isnot [int] -and $status.Severity -isnot [long]) -or
            $status.Severity -lt 4 -or $status.Severity -gt 6 -or $status.StatusCode -ne 0) {
            throw 'Kusto query returned a partial failure or non-success status.'
        }
    }
    $kinds = @('QueryResult', 'QueryProperties', 'QueryStatus')
    $names = @('PrimaryResult', '@ExtendedProperties', 'QueryStatus')
    for ($index = 0; $index -lt 3; $index++) {
        $entry = $tables[3][$index]
        if ($entry.Ordinal -ne $index -or $entry.Kind -cne $kinds[$index] -or $entry.Name -cne $names[$index]) {
            throw 'Unsupported Kusto table of contents.'
        }
    }
    $tables[0]
}

function New-MiningSnapshotBundle {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Run,
        [Parameter(Mandatory)][string]$AsOfUtc,
        [Parameter(Mandatory)][string]$CatalogPath,
        [Parameter(Mandatory)]$PublisherEvidence,
        [Parameter(Mandatory)][array]$Ingestion,
        [Parameter(Mandatory)][array]$Telemetry,
        [Parameter(Mandatory)][array]$State
    )
    Assert-SnapshotRun $Run $AsOfUtc
    if ($PublisherEvidence.plantId -cne 'D01' -or $PublisherEvidence.run.runId -cne $Run.runId -or
        $PublisherEvidence.run.admission -cne 'accepted' -or $PublisherEvidence.run.publisherStatus -cne 'publisher_complete' -or
        $PublisherEvidence.run.stopRequested -isnot [bool] -or $PublisherEvidence.run.stopRequested) {
        throw 'Durable publisher status does not prove this accepted completed run.'
    }
    # Reuse the catalog byte pin and referential-integrity validator before reading its tags.
    $null = New-MiningCatalogTables -CatalogPath $CatalogPath
    $catalog = Get-Content -LiteralPath $CatalogPath -Raw | ConvertFrom-Json -AsHashtable -DateKind String
    $catalogVersion = 'sha256:' + (Get-FileHash -LiteralPath $CatalogPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedFamilies = @('raw_telemetry', 'validated_telemetry', 'raw_state', 'validated_state', 'quarantine')
    if ($Ingestion.Count -ne 5 -or @($Ingestion.family | Select-Object -Unique).Count -ne 5) { throw 'Missing reconciliation family.' }
    foreach ($row in $Ingestion) {
        foreach ($key in @('event_count', 'copies', 'conflicting_ids')) {
            if (($row[$key] -isnot [long] -and $row[$key] -isnot [int]) -or $row[$key] -lt 0) { throw 'Malformed reconciliation count.' }
        }
        if ($row.family -cnotin $expectedFamilies -or $row.source_status -cne 'READY' -or $row.conflicting_ids -ne 0) {
            throw 'Source is not ready or contains conflicting event identities.'
        }
        $expected = if ($row.family -ceq 'quarantine') {
            @{ count = 0; hash = (Get-SnapshotHash '') }
        } elseif ($row.family.EndsWith('telemetry', [StringComparison]::Ordinal)) { $Run.expected.telemetry } else { $Run.expected.state }
        if ($row.event_count -ne $expected.count -or $row.event_ids_hash -cne $expected.hash -or $row.copies -lt $row.event_count) {
            throw 'Raw/validated event identities or quarantine do not reconcile with the reviewed run.'
        }
    }
    $asOf = Get-SnapshotInstant $AsOfUtc
    $observedTimes = [Collections.Generic.List[DateTimeOffset]]::new()
    $tags = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    foreach ($tag in $catalog.telemetry_tags) { $tags.Add($tag.id, $tag) }
    $tables = [Collections.Generic.List[object]]::new()
    $suffix = $Run.runId.Replace('-', '')
    foreach ($family in @('telemetry', 'state')) {
        $source = if ($family -ceq 'telemetry') { $Telemetry } else { $State }
        if ($source.Count -gt 2000) { throw 'Snapshot source exceeds the bounded extraction limit.' }
        $unique = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
        $fingerprints = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
        foreach ($row in $source) {
            $instant = Get-SnapshotInstant $row.timestamp
            $received = Get-SnapshotInstant $row.received_at
            if ($row.run_id -cne $Run.runId -or $row.plant_id -cne 'D01' -or
                $row.catalog_version -cne $catalogVersion -or $row.source_contract_version -cne 'd01-validated-source-v1' -or
                ($row.sequence -isnot [long] -and $row.sequence -isnot [int]) -or
                $row.sequence -lt 1 -or $row.sequence -gt 9007199254740991 -or
                $row.event_id -cne (Get-SnapshotHash "$($Run.runId):$($row.sequence)") -or
                $row.payload_fingerprint -cnotmatch '^[a-f0-9]{64}$' -or
                $instant -gt $asOf -or $received -gt $asOf -or
                $instant.Ticks % 10000 -ne 0) {
                throw 'Snapshot event identity, timestamp or source contract mismatch.'
            }
            $observedTimes.Add($instant)
            $fact = [ordered]@{
                plant_id = $row.plant_id; run_id = $row.run_id; event_id = $row.event_id
                sequence = [string]$row.sequence; event_time_utc = $instant.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                received_at_utc = $row.received_at; snapshot_as_of_utc = $AsOfUtc
                catalog_version = $row.catalog_version; source_contract_version = $row.source_contract_version
                payload_fingerprint = $row.payload_fingerprint
            }
            if ($family -ceq 'telemetry') {
                if (-not $tags.ContainsKey($row.tag_id)) { throw 'Unknown snapshot tag.' }
                $tag = $tags[$row.tag_id]
                $interval = if ($tag.metric -cin @('bearing_temperature', 'level', 'product_mass')) { 60 } else { 30 }
                if ($row.module_id -cne $tag.module_id -or $row.equipment_id -cne $tag.equipment_id -or
                    $row.unit -cne $tag.unit -or ($row.interval_seconds -isnot [int] -and $row.interval_seconds -isnot [long]) -or
                    $row.interval_seconds -ne $interval -or
                    $row.profile_version -cne 'd01-publish-profile-v1' -or
                    $row.quality -cnotin @('good', 'uncertain', 'bad') -or
                    ($row.value -isnot [double] -and $row.value -isnot [long] -and $row.value -isnot [int] -and $row.value -isnot [decimal]) -or
                    -not [double]::IsFinite([double]$row.value)) {
                    throw 'Telemetry does not match the pinned catalog and publishing profile.'
                }
                foreach ($key in @('module_id', 'equipment_id', 'tag_id', 'unit', 'quality', 'profile_version')) { $fact[$key] = $row[$key] }
                $fact.value = ([double]$row.value).ToString('R', [Globalization.CultureInfo]::InvariantCulture)
                $fact.interval_seconds = [string]$row.interval_seconds
                $fact.metric = $tag.metric
            } else {
                if ($row.scope_id -cnotin @('A', 'B', 'C', 'shared') -or
                    $row.state -cnotin @('starting', 'running', 'idle', 'stopped', 'fault') -or
                    $row.scheduled_running -isnot [bool]) { throw 'Invalid snapshot state contract.' }
                $fact.scope_id = $row.scope_id
                $fact.state = $row.state
                $fact.scheduled_running = $row.scheduled_running.ToString().ToLowerInvariant()
            }
            # Duplicate delivery may have another receipt time; all event payload fields must still match.
            $payload = [ordered]@{}
            foreach ($key in $fact.Keys) {
                if ($key -cne 'received_at_utc') { $payload[$key] = $fact[$key] }
            }
            $fingerprint = $payload | ConvertTo-Json -Depth 10 -Compress
            if ($unique.ContainsKey($row.event_id)) {
                if ($fingerprints[$row.event_id] -cne $fingerprint) { throw 'Conflicting duplicate snapshot event.' }
                if ($received -lt (Get-SnapshotInstant $unique[$row.event_id].received_at_utc)) {
                    $unique[$row.event_id] = $fact
                }
            } else {
                $unique.Add($row.event_id, $fact)
                $fingerprints.Add($row.event_id, $fingerprint)
            }
        }
        $ids = [string[]]@($unique.Keys)
        [Array]::Sort($ids, [StringComparer]::Ordinal)
        if ($ids.Count -ne $Run.expected[$family].count -or (Get-SnapshotHash ($ids -join "`n")) -cne $Run.expected[$family].hash) {
            throw 'Extracted exact event IDs do not match the reviewed run.'
        }
        $rows = @($ids | ForEach-Object { $unique[$_] })
        $csv = Invoke-SnapshotShared ConvertTo-MiningCsv @(,$rows)
        $tables.Add([ordered]@{
            name = "mining_D01_snapshot_v1_${suffix}_$family"; family = $family; csv = $csv
            keys = @('event_id')
            sha256 = Get-SnapshotHash $csv; rowCount = $rows.Count
            eventIdsHash = Get-SnapshotHash ($ids -join "`n")
        })
    }
    $times = @($observedTimes | Sort-Object)
    if (($times[-1] - $times[0]).TotalSeconds -gt 1800) { throw 'Observed event interval exceeds the supported bounded snapshot.' }
    [ordered]@{
        formatVersion = 1; kind = 'mining-historical-snapshot-v1'; run = $Run; asOfUtc = $AsOfUtc
        catalogVersion = $catalogVersion; tables = $tables.ToArray(); publisherEvidence = $PublisherEvidence
        observedEventStartUtc = $times[0].ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        observedEventEndUtc = $times[-1].ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    }
}

function New-MiningSnapshotDefinitions {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Bundle, [Parameter(Mandatory)][hashtable]$Target,
        [Parameter(Mandatory)][guid]$SemanticModelId)
    if ($SemanticModelId -eq [guid]::Empty -or $Target.SqlServer -cnotmatch '^[a-z0-9-]+\.datawarehouse\.fabric\.microsoft\.com$' -or
        $Target.SqlDatabase -cnotmatch '^[A-Za-z][A-Za-z0-9_]{0,122}$') { throw 'Invalid exact semantic source target.' }
    $modelParts = [Collections.Generic.List[object]]::new()
    $reportParts = [Collections.Generic.List[object]]::new()
    function Add-Part($Parts, $Path, $Text) {
        $Parts.Add(@{ path = $Path; payloadType = 'InlineBase64'; payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text)) })
    }
    function Add-JsonPart($Parts, $Path, $Value) { Add-Part $Parts $Path ($Value | ConvertTo-Json -Compress -Depth 80) }
    Add-Part $modelParts 'definition.pbism' '{"$schema":"https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json","version":"4.2","settings":{}}'
    Add-Part $modelParts 'definition/database.tmdl' "database`n`tcompatibilityLevel: 1604`n"
    Add-Part $modelParts 'definition/expressions.tmdl' "expression SnapshotSource =`n`t`tlet`n`t`t    Source = Sql.Database(`"$($Target.SqlServer)`", `"$($Target.SqlDatabase)`")`n`t`tin`n`t`t    Source`n"
    $model = "model Model`n`tculture: en-US`n`tdefaultPowerBIDataSourceVersion: powerBI_V3`n`tsourceQueryCulture: en-US`n`tdirectLakeBehavior: directLakeOnly`n`n"
    foreach ($table in $Bundle.tables) {
        $entity = if ($table.family -ceq 'telemetry') { 'Telemetry' } else { 'State' }
        $model += "ref table $entity`n"
        $columns = @(@($table.csv | ConvertFrom-Csv)[0].PSObject.Properties.Name)
        $lineage = [guid]::ParseExact((Get-SnapshotHash "mining-snapshot-v1/$($table.name)").Substring(0, 32), 'N')
        $text = "table $entity`n`tlineageTag: $lineage`n"
        $text += "`n`tmeasure '$entity Event Count' = COUNTROWS('$entity')`n`t`tformatString: #,##0`n"
        if ($entity -ceq 'Telemetry') {
            $text += "`n`tmeasure 'Reading Value' = IF(HASONEVALUE('Telemetry'[tag_id]) && HASONEVALUE('Telemetry'[unit]), AVERAGEX('Telemetry', VALUE('Telemetry'[value])))`n`t`tformatString: 0.000`n"
        }
        foreach ($column in $columns) {
            $text += "`n`tcolumn $column`n`t`tdataType: string`n`t`tsummarizeBy: none`n`t`tsourceColumn: $column`n"
        }
        $text += "`n`tpartition $entity = entity`n`t`tmode: directLake`n`t`tsource`n`t`t`tentityName: $($table.name)`n`t`t`tschemaName: dbo`n`t`t`texpressionSource: SnapshotSource`n"
        Add-Part $modelParts "definition/tables/$entity.tmdl" $text
    }
    Add-Part $modelParts 'definition/model.tmdl' $model
    $root = Join-Path $PSScriptRoot '..\..\infra\fabric\powerbi-report'
    if ([string]::IsNullOrWhiteSpace($Target.WorkspaceName)) { throw 'Report definition requires the verified workspace name.' }
    $connection = [Data.Common.DbConnectionStringBuilder]::new()
    $connection['Data Source'] = "powerbi://api.powerbi.com/v1.0/myorg/$($Target.WorkspaceName)"
    $connection['initial catalog'] = "mining-d01-snapshot-$($Bundle.run.runId.Replace('-', ''))-semanticmodel"
    $connection['integrated security'] = 'ClaimsToken'
    $connection['semanticmodelid'] = "$SemanticModelId"
    Add-JsonPart $reportParts 'definition.pbir' @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json'
        version = '4.0'; datasetReference = @{ byConnection = @{ connectionString = $connection.ConnectionString } }
    }
    foreach ($path in @('definition\version.json', 'definition\report.json')) {
        Add-Part $reportParts ($path.Replace('\', '/')) (Get-Content (Join-Path $root $path) -Raw)
    }
    Add-JsonPart $reportParts 'definition/pages/pages.json' @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json'
        pageOrder = @('snapshot'); activePageName = 'snapshot'
    }
    Add-JsonPart $reportParts 'definition/pages/snapshot/page.json' @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.3.0/schema.json'
        name = 'snapshot'; displayName = 'Historical Mining snapshot'; displayOption = 'FitToPage'; height = 900; width = 1440
    }
    function Field($Entity, $Property, [switch]$Measure) {
        $kind = if ($Measure) { 'Measure' } else { 'Column' }
        @{ $kind = @{ Expression = @{ SourceRef = @{ Entity = $Entity } }; Property = $Property } }
    }
    function Projection($Entity, $Property, [switch]$Measure) {
        @{ field = (Field $Entity $Property -Measure:$Measure); queryRef = "$Entity.$Property" }
    }
    function Visual($Name, $Type, $Title, $Query, $X, $Y, $Width, $Height) {
        Add-JsonPart $reportParts "definition/pages/snapshot/visuals/$Name/visual.json" @{
            '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.5.0/schema.json'
            name = $Name; position = @{ x = $X; y = $Y; z = $Y; width = $Width; height = $Height; tabOrder = $Y }
            visual = @{
                visualType = $Type; query = @{ queryState = $Query }; drillFilterOtherVisuals = $true
                visualContainerObjects = @{
                    title = @(@{ properties = @{ show = @{ expr = @{ Literal = @{ Value = 'true' } } }
                        text = @{ expr = @{ Literal = @{ Value = "'$($Title.Replace("'", "''"))'" } } } } })
                }
            }
        }
    }
    Visual 'provenance' 'tableEx' "Historical snapshot; observed $($Bundle.observedEventStartUtc) to $($Bundle.observedEventEndUtc); not live" @{
        Values = @{ projections = @('run_id', 'snapshot_as_of_utc', 'event_time_utc' | ForEach-Object { Projection 'Telemetry' $_ }) }
    } 24 20 1392 190
    Visual 'eventtime' 'tableEx' 'Observed readings by tag, unit and UTC event time (select a tag to filter)' @{
        Values = @{ projections = @(
            (Projection 'Telemetry' 'event_time_utc'), (Projection 'Telemetry' 'tag_id'),
            (Projection 'Telemetry' 'unit'), (Projection 'Telemetry' 'Reading Value' -Measure)
        ) }
    } 24 234 890 360
    Visual 'state' 'tableEx' 'Actual state events by scope and event time' @{
        Values = @{ projections = @('scope_id', 'event_time_utc', 'state', 'scheduled_running' | ForEach-Object { Projection 'State' $_ }) }
    } 938 234 478 360
    Visual 'readings' 'tableEx' 'Validated telemetry evidence (select a tag or event)' @{
        Values = @{ projections = @('tag_id', 'metric', 'unit', 'quality', 'value', 'event_time_utc', 'event_id' | ForEach-Object { Projection 'Telemetry' $_ }) }
    } 24 618 1392 258
    [ordered]@{ semanticModel = @{ parts = $modelParts.ToArray() }; report = @{ parts = $reportParts.ToArray() } }
}

function Invoke-SnapshotHttp($Client, $Method, $Uri, $Audience = 'Fabric', $Body = $null) {
    $response = Invoke-SnapshotShared Invoke-MiningHttp @($Client, $Method, $Uri, $Audience, $Body)
    if ($response.statusCode -notin @(200, 201, 202)) {
        $detail = $response.body | ConvertTo-Json -Depth 20 -Compress
        $retry = if ($response.headers.Contains('Retry-After')) { $response.headers['Retry-After'] } else { 'not supplied' }
        throw "Native request failed: HTTP $($response.statusCode); Retry-After=$retry; $detail"
    }
    if ($response.body -is [Collections.IDictionary] -and $response.body.Contains('error')) {
        throw "Native request returned embedded error: $($response.body.error | ConvertTo-Json -Depth 20 -Compress)"
    }
    $response
}

function Get-MiningSnapshotCapture {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Run, [Parameter(Mandatory)][string]$AsOfUtc,
        [Parameter(Mandatory)]$Client, [Parameter(Mandatory)][uri]$KustoEndpoint,
        [Parameter(Mandatory)][string]$KustoDatabase,
        [Parameter(Mandatory)][uri]$PublisherStatusUri)
    Assert-SnapshotRun $Run $AsOfUtc
    if ($KustoEndpoint.AbsoluteUri -cnotmatch '^https://[a-z0-9-]+(?:\.[a-z0-9-]+)*\.kusto\.fabric\.microsoft\.com/$' -or
        $KustoDatabase -cnotmatch '^[a-zA-Z0-9_-]{1,128}$') { throw 'Unsupported exact Kusto target.' }
    $queries = [ordered]@{
        ingestion = "mining_RunIngestion('D01', '$($Run.runId)', datetime($AsOfUtc))"
        telemetry = "mining_ValidatedTelemetry | where plant_id == 'D01' and run_id == '$($Run.runId)' and received_at <= datetime($AsOfUtc) | take 2001"
        state = "mining_ValidatedState | where plant_id == 'D01' and run_id == '$($Run.runId)' and received_at <= datetime($AsOfUtc) | take 2001"
    }
    $capture = [ordered]@{
        run = $Run; asOfUtc = $AsOfUtc; kustoEndpoint = $KustoEndpoint.AbsoluteUri
        kustoDatabase = $KustoDatabase; queries = $queries; publisherStatusUri = $PublisherStatusUri.AbsoluteUri
    }
    if ($PublisherStatusUri.Scheme -cne 'https' -or $PublisherStatusUri.UserInfo -or $PublisherStatusUri.Query -or
        $PublisherStatusUri.AbsolutePath -cne '/api/mining/demo/runs/status') { throw 'Unsupported reviewed public publisher status URL.' }
    # This public endpoint receives no bearer token. It supplies lifecycle evidence, not telemetry values.
    $status = Invoke-WebRequest $PublisherStatusUri.AbsoluteUri -MaximumRedirection 0 -SkipHttpErrorCheck
    if ($status.StatusCode -ne 200) { throw "Public publisher status failed: HTTP $($status.StatusCode)." }
    $capture.publisherEvidence = $status.Content | ConvertFrom-Json -AsHashtable -DateKind String
    foreach ($key in $queries.Keys) {
        $response = Invoke-SnapshotHttp $Client POST "$($KustoEndpoint.AbsoluteUri)v1/rest/query" Kusto @{ db = $KustoDatabase; csl = $queries[$key] }
        $capture[$key] = @(ConvertFrom-MiningSnapshotQuery $response.body)
    }
    $capture
}

function Get-SnapshotItems($Client, $Target) {
    $items = [Collections.Generic.List[object]]::new()
    $base = "https://api.fabric.microsoft.com/v1/workspaces/$($Target.WorkspaceId)/items"
    $uri = $base
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    do {
        if (-not $seen.Add($uri) -or $seen.Count -gt 100) { throw 'Item inventory pagination did not terminate.' }
        $page = (Invoke-SnapshotHttp $Client GET $uri).body
        if (-not $page.Contains('value')) { throw 'Incomplete item inventory.' }
        foreach ($item in $page.value) { $items.Add($item) }
        $uri = if ($page.Contains('continuationToken') -and $page.continuationToken) {
            $base + '?continuationToken=' + [uri]::EscapeDataString($page.continuationToken)
        } elseif ($page.Contains('continuationUri') -and $page.continuationUri) {
            throw 'Inventory supplied a continuation URI without its token; no writes permitted.'
        } else { $null }
    } while ($uri)
    $items.ToArray()
}

function Assert-SnapshotDefinition($Client, $Target, $Id, $Expected) {
    $response = Invoke-SnapshotHttp $Client POST "https://api.fabric.microsoft.com/v1/workspaces/$($Target.WorkspaceId)/items/$Id/getDefinition"
    $body = Invoke-SnapshotShared Wait-MiningOperation @($Client, $response, $Target, 60, 2) @{ ReadResult = $true }
    $actual = @{}
    foreach ($part in $body.definition.parts) {
        if ($actual.ContainsKey($part.path) -or $part.payloadType -cne 'InlineBase64') { throw 'Malformed live definition.' }
        $actual[$part.path] = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload))
    }
    foreach ($part in $Expected.parts) {
        if (-not $actual.ContainsKey($part.path)) { throw "Missing live definition part: $($part.path)." }
        $expectedText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part.payload))
        # Service normalizes JSON whitespace/property order; TMDL is compared without line-ending differences.
        if ($part.path.EndsWith('.json') -or $part.path -in @('definition.pbir', 'definition.pbism')) {
            $left = $expectedText | ConvertFrom-Json -AsHashtable -DateKind String
            $right = $actual[$part.path] | ConvertFrom-Json -AsHashtable -DateKind String
            $equal = Test-SnapshotObjectEqual $left $right
        } else {
            $equal = $expectedText.Replace("`r`n", "`n").Trim() -ceq $actual[$part.path].Replace("`r`n", "`n").Trim()
        }
        if (-not $equal) { throw "Live definition drift: $($part.path). Existing items are never updated." }
    }
    $extra = @($actual.Keys | Where-Object { $_ -cnotin @($Expected.parts.path) -and $_ -cne '.platform' })
    $sharedTheme = 'StaticResources/SharedResources/BaseThemes/CY25SU12.json'
    if ($sharedTheme -cin $extra -and 'definition/report.json' -cin $Expected.parts.path) {
        # Fabric expands the referenced shared theme; pin its reviewed native bytes, not arbitrary resources.
        if ((Get-SnapshotHash $actual[$sharedTheme].Replace("`r`n", "`n").Trim()) -cne
            '67802632b6a9543cb5aa35b7132fd444923934e98f8672d1fe917e6a9cbd05a8') {
            throw 'Live shared base theme drift. Existing items are never updated.'
        }
        $extra = @($extra | Where-Object { $_ -cne $sharedTheme })
    }
    if ($extra.Count) { throw "Unexpected live definition parts: $($extra -join ', ')." }
}

function Test-SnapshotObjectEqual($Left, $Right) {
    if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
    if ($Left -is [Collections.IDictionary]) {
        if ($Right -isnot [Collections.IDictionary] -or $Left.Count -ne $Right.Count) { return $false }
        foreach ($key in $Left.Keys) {
            if (-not $Right.Contains($key) -or -not (Test-SnapshotObjectEqual $Left[$key] $Right[$key])) { return $false }
        }
        return $true
    }
    if ($Left -is [array]) {
        if ($Right -isnot [array] -or $Left.Count -ne $Right.Count) { return $false }
        for ($i = 0; $i -lt $Left.Count; $i++) {
            if (-not (Test-SnapshotObjectEqual $Left[$i] $Right[$i])) { return $false }
        }
        return $true
    }
    if ($Left -is [string] -or $Right -is [string]) {
        return $Left -is [string] -and $Right -is [string] -and $Left -ceq $Right
    }
    if ($Left -is [bool] -or $Right -is [bool]) {
        return $Left -is [bool] -and $Right -is [bool] -and $Left -eq $Right
    }
    if ($Left -is [ValueType] -and $Right -is [ValueType]) { return [decimal]$Left -eq [decimal]$Right }
    $false
}

function Get-SnapshotTableState($Client, $Target, $Table, $Request) {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        try {
            return Invoke-SnapshotShared Get-MiningTableState @($Client, $Target, $Table, $Request)
        } catch {
            if ($_.Exception.Message -cne "Metadata/SQL visibility disagrees for $($Table.name); wait for endpoint synchronization and verify.") { throw }
            if ($attempt -eq 59) { throw }
            & $Client.sleep 2
        }
    }
}

function ConvertTo-SnapshotParquet([string]$Csv, [string]$PythonExecutable) {
    $inputPath = [IO.Path]::GetTempFileName()
    $outputPath = [IO.Path]::GetTempFileName()
    try {
        [IO.File]::WriteAllText($inputPath, $Csv, [Text.UTF8Encoding]::new($false))
        $writer = Join-Path $PSScriptRoot 'write-mining-snapshot-parquet.py'
        & $PythonExecutable $writer $inputPath $outputPath
        if ($LASTEXITCODE -ne 0) { throw 'Schema-preserving Parquet generation failed; no upload or load submitted.' }
        return ,([IO.File]::ReadAllBytes($outputPath))
    } finally {
        Remove-Item -LiteralPath $inputPath, $outputPath -Force
    }
}

function Invoke-MiningSnapshotDeployment {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Bundle, [Parameter(Mandatory)][hashtable]$Target,
        [Parameter(Mandatory)]$Client, [Parameter(Mandatory)][string]$ReceiptPath,
        [ValidateSet('Apply', 'Verify')][string]$Mode = 'Verify',
        [string]$PythonExecutable = 'python')
    if (Test-Path -LiteralPath $ReceiptPath) { throw 'Receipt exists. Reconcile its operations read-only; never blindly resubmit.' }
    Invoke-SnapshotShared Assert-MiningLivePrerequisites @($Client, $Target, $Bundle.tables) @{ CatalogOnly = $true }
    $workspace = (Invoke-SnapshotHttp $Client GET "https://api.fabric.microsoft.com/v1/workspaces/$($Target.WorkspaceId)").body
    if ($workspace.id -ine $Target.WorkspaceId -or [string]::IsNullOrWhiteSpace($workspace.displayName)) {
        throw 'Live workspace identity/name is incomplete.'
    }
    $definitionTarget = @{} + $Target
    $definitionTarget.WorkspaceName = $workspace.displayName
    $inventory = @(Get-SnapshotItems $Client $Target)
    $suffix = $Bundle.run.runId.Replace('-', '')
    $names = @{ SemanticModel = "mining-d01-snapshot-$suffix-semanticmodel"; Report = "mining-d01-snapshot-$suffix-report" }
    $receipt = [ordered]@{
        formatVersion = 1; status = 'Prepared'; kind = $Bundle.kind; runId = $Bundle.run.runId
        asOfUtc = $Bundle.asOfUtc; observedEventStartUtc = $Bundle.observedEventStartUtc; observedEventEndUtc = $Bundle.observedEventEndUtc
        target = $Target; operations = [Collections.Generic.List[object]]::new()
        tables = @(); items = @{}; verification = @{}; portalVisualVerification = 'Not performed'
    }
    $stream = [IO.FileStream]::new([IO.Path]::GetFullPath($ReceiptPath), 'CreateNew', 'ReadWrite', 'None')
    try {
        Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
        foreach ($table in $Bundle.tables) {
            if ($table.name -cne "mining_D01_snapshot_v1_${suffix}_$($table.family)" -or $table.family -cnotin @('telemetry', 'state')) {
                throw 'Table is outside the isolated snapshot namespace.'
            }
            $request = @{
                metadataUri = "https://onelake.table.fabric.microsoft.com/delta/$($Target.WorkspaceId)/$($Target.StaticLakehouseId)/api/2.1/unity-catalog/tables/$($Target.StaticLakehouseId).dbo.$($table.name)"
                uri = "https://api.fabric.microsoft.com/v1/workspaces/$($Target.WorkspaceId)/lakehouses/$($Target.StaticLakehouseId)/schemas/dbo/tables/$($table.name)/load?beta=true"
                body = $null
            }
            $state = Get-SnapshotTableState $Client $Target $table $request
            if (-not $state.exists) {
                if ($Mode -ceq 'Verify') { throw 'Snapshot facts do not exist; verify mode performs no writes.' }
                [byte[]]$bytes = ConvertTo-SnapshotParquet $table.csv $PythonExecutable
                $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
                $upload = @{ contentBytes = $bytes; sha256 = $hash }
                $request.body = @{
                    relativePath = "Files/mining-D01/$hash/$($table.name).parquet"; pathType = 'File'
                    mode = 'Overwrite'; recursive = $false; formatOptions = @{ format = 'Parquet' }
                }
                Invoke-SnapshotShared Send-MiningCsv @($Client, $Target, $upload, $request, $receipt, $stream, 60, 2)
                $fresh = Get-SnapshotTableState $Client $Target $table $request
                if ($fresh.exists) { throw 'Snapshot table appeared concurrently; no overwrite submitted.' }
                Invoke-SnapshotShared Invoke-MiningRecordedWrite @($Client, 'POST', $request.uri, 'Fabric', $request.body, @{}, $receipt, $stream, $Target, 60, 2)
                $state = Get-SnapshotTableState $Client $Target $table $request
                if (-not $state.exists) { throw 'Loaded facts not yet visible. Reconcile read-only; do not reload.' }
            }
            $receipt.tables += @{ name = $table.name; rowCount = $state.rowCount; sha256 = $state.sha256; eventIdsHash = $table.eventIdsHash }
            Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
        }
        foreach ($type in @('SemanticModel', 'Report')) {
            $matches = @($inventory | Where-Object { $_.displayName -ieq $names[$type] })
            if ($matches.Count -gt 1 -or ($matches.Count -eq 1 -and $matches[0].type -cne $type)) { throw 'Ambiguous or wrong-type snapshot item.' }
            $modelId = if ($type -ceq 'Report') { [guid]$receipt.items.SemanticModel } else { [guid]'00000000-0000-0000-0000-000000000001' }
            $definitions = New-MiningSnapshotDefinitions $Bundle $definitionTarget $modelId
            $definition = if ($type -ceq 'Report') { $definitions.report } else { $definitions.semanticModel }
            if ($matches.Count -eq 0) {
                if ($Mode -ceq 'Verify') { throw "Missing snapshot $type; verify mode performs no writes." }
                $entry = [ordered]@{ method = 'POST'; type = $type; displayName = $names[$type]; status = 'SubmittedOutcomeUnknown'; operationLocation = $null }
                $receipt.operations.Add($entry)
                Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
                $body = @{ type = $type; displayName = $names[$type]; description = "Historical D01 run $($Bundle.run.runId); as of $($Bundle.asOfUtc); not live telemetry."; definition = $definition }
                $response = Invoke-SnapshotHttp $Client POST "https://api.fabric.microsoft.com/v1/workspaces/$($Target.WorkspaceId)/items" Fabric $body
                $entry.status = "AcknowledgedHttp$($response.statusCode)"
                if ($response.headers.Contains('Location')) { $entry.operationLocation = $response.headers.Location }
                Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
                $null = Invoke-SnapshotShared Wait-MiningOperation @($Client, $response, $Target, 60, 2)
                $inventory = @(Get-SnapshotItems $Client $Target)
                $matches = @($inventory | Where-Object { $_.displayName -ieq $names[$type] -and $_.type -ceq $type })
                if ($matches.Count -ne 1) { throw 'Acknowledged item not uniquely inventoried; reconcile without resubmitting.' }
                $entry.status = 'Succeeded'
            }
            $receipt.items[$type] = $matches[0].id
            Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
            Assert-SnapshotDefinition $Client $Target $matches[0].id $definition
        }
        $modelId = $receipt.items.SemanticModel
        $powerBi = "https://api.powerbi.com/v1.0/myorg/groups/$($Target.WorkspaceId)"
        if ($Mode -ceq 'Apply') {
            $entry = [ordered]@{
                method = 'POST'; type = 'Refresh'; status = 'SubmittedOutcomeUnknown'; operationLocation = $null
                submittedAtUtc = [DateTimeOffset]::UtcNow.ToString('O'); responseMetadata = @{}
            }
            $receipt.operations.Add($entry)
            Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
            $refresh = Invoke-SnapshotHttp $Client POST "$powerBi/datasets/$modelId/refreshes" PowerBi @{ notifyOption = 'NoNotification' }
            $entry.status = "AcknowledgedHttp$($refresh.statusCode)"
            foreach ($header in @('x-ms-request-id', 'RequestId', 'ActivityId', 'Location', 'Retry-After', 'Date')) {
                if ($refresh.headers.Contains($header)) { $entry.responseMetadata[$header] = $refresh.headers[$header] }
            }
            Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
            $refreshId = if ($refresh.headers.Contains('x-ms-request-id')) { $refresh.headers['x-ms-request-id'] } else { '' }
            if ($refresh.headers.Contains('Location')) {
                $location = [uri]$refresh.headers.Location
                if ($location.Scheme -cne 'https' -or $location.Host -cne 'api.powerbi.com' -or $location.Port -ne 443 -or
                    $location.AbsolutePath -cnotmatch "^/v1.0/myorg/groups/$($Target.WorkspaceId)/datasets/$modelId/refreshes/([a-fA-F0-9-]{36})$") {
                    throw 'Untrusted refresh location; reconcile without resubmitting.'
                }
                $refreshId = $Matches[1]
                $entry.operationLocation = $location.AbsoluteUri
            }
            $id = [guid]::Empty
            if (-not [guid]::TryParseExact($refreshId, 'D', [ref]$id)) { throw 'Refresh identity is unknown; reconcile without resubmitting.' }
            $entry.refreshId = $refreshId
            Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
            $completed = $false
            $pollDelay = 3
            if ($refresh.headers.Contains('Retry-After')) {
                $retry = 0
                if (-not [int]::TryParse($refresh.headers['Retry-After'], [ref]$retry) -or $retry -lt 0 -or $retry -gt 300) {
                    throw 'Unsupported refresh Retry-After; reconcile without resubmitting.'
                }
                $pollDelay = [Math]::Max($pollDelay, $retry)
            }
            for ($i = 0; $i -lt 60; $i++) {
                & $Client.sleep $pollDelay
                $history = (Invoke-SnapshotHttp $Client GET "$powerBi/datasets/$modelId/refreshes?`$top=20" PowerBi).body
                $exact = @($history.value | Where-Object { $_.requestId -ieq $refreshId })
                if ($exact.Count -eq 1 -and $exact[0].status -ceq 'Completed') { $completed = $true; break }
                if ($exact.Count -gt 1 -or ($exact.Count -eq 1 -and $exact[0].status -cnotin @('Unknown', 'InProgress', 'NotStarted'))) {
                    throw "Snapshot refresh failed: $($exact | ConvertTo-Json -Depth 20 -Compress)"
                }
            }
            if (-not $completed) { throw 'Snapshot refresh completion is unresolved; no retry submitted.' }
            $entry.status = 'Completed'
            $receipt.verification.refresh = $exact[0]
        } else {
            $history = (Invoke-SnapshotHttp $Client GET "$powerBi/datasets/$modelId/refreshes?`$top=1" PowerBi).body
            if ($history.value.Count -ne 1 -or $history.value[0].status -cne 'Completed') { throw 'Latest snapshot refresh is not complete.' }
            $id = [guid]::Empty
            if (-not [guid]::TryParseExact($history.value[0].requestId, 'D', [ref]$id)) { throw 'Completed refresh has no exact request identity.' }
            $receipt.verification.refresh = $history.value[0]
        }
        $report = (Invoke-SnapshotHttp $Client GET "$powerBi/reports/$($receipt.items.Report)" PowerBi).body
        if ($report.datasetId -ine $modelId) { throw 'Report is not bound to the exact snapshot model.' }
        $queries = [ordered]@{
            counts = "EVALUATE ROW(`"telemetry`", COUNTROWS('Telemetry'), `"state`", COUNTROWS('State'))"
            telemetry = "EVALUATE SUMMARIZECOLUMNS('Telemetry'[event_time_utc], 'Telemetry'[tag_id], 'Telemetry'[unit], `"Reading Value`", 'Telemetry'[Reading Value], `"Event Count`", 'Telemetry'[Telemetry Event Count])"
            state = "EVALUATE SUMMARIZECOLUMNS('State'[scope_id], 'State'[event_time_utc], 'State'[state], 'State'[scheduled_running], `"Event Count`", 'State'[State Event Count])"
            telemetryIds = "EVALUATE SELECTCOLUMNS('Telemetry', `"event_id`", 'Telemetry'[event_id])"
            stateIds = "EVALUATE SELECTCOLUMNS('State', `"event_id`", 'State'[event_id])"
        }
        foreach ($key in $queries.Keys) {
            $result = (Invoke-SnapshotHttp $Client POST "$powerBi/datasets/$modelId/executeQueries" PowerBi @{
                queries = @(@{ query = $queries[$key] }); serializerSettings = @{ includeNulls = $true }
            }).body
            if ($result.Contains('error') -or $result.results.Count -ne 1 -or $result.results[0].Contains('error') -or
                $result.results[0].tables.Count -ne 1 -or $result.results[0].tables[0].Contains('error')) {
                throw 'Semantic query returned an embedded error or incomplete table.'
            }
            $rows = @($result.results[0].tables[0].rows)
            if ($key -ceq 'counts') {
                if ($rows.Count -ne 1 -or $rows[0]['[telemetry]'] -ne $Bundle.run.expected.telemetry.count -or
                    $rows[0]['[state]'] -ne $Bundle.run.expected.state.count) { throw 'Native semantic fact counts differ.' }
            } elseif ($key.EndsWith('Ids', [StringComparison]::Ordinal)) {
                $family = $key.Replace('Ids', '')
                $ids = [string[]]@($rows | ForEach-Object { $_['[event_id]'] })
                [Array]::Sort($ids, [StringComparer]::Ordinal)
                if ($ids.Count -ne $Bundle.run.expected[$family].count -or
                    (Get-SnapshotHash ($ids -join "`n")) -cne $Bundle.run.expected[$family].hash) { throw 'Native semantic event identities differ.' }
            } else {
                $table = @($Bundle.tables | Where-Object family -CEQ $key)[0]
                $sourceRows = @($table.csv | ConvertFrom-Csv)
                $columns = if ($key -ceq 'telemetry') { @('event_time_utc', 'tag_id', 'unit') } else { @('scope_id', 'event_time_utc', 'state', 'scheduled_running') }
                $entity = if ($key -ceq 'telemetry') { 'Telemetry' } else { 'State' }
                $expectedRows = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
                foreach ($sourceRow in $sourceRows) {
                    $identity = @($columns | ForEach-Object { $sourceRow.$_ }) | ConvertTo-Json -Compress
                    if ($expectedRows.ContainsKey($identity)) {
                        if ($key -ceq 'telemetry' -and $expectedRows[$identity].row.value -cne $sourceRow.value) {
                            throw 'Source has ambiguous reading values within a visual group; no visual acceptance claimed.'
                        }
                        $expectedRows[$identity].count++
                    } else { $expectedRows.Add($identity, @{ row = $sourceRow; count = 1 }) }
                }
                if ($rows.Count -ne $expectedRows.Count) { throw 'Visual-shaped semantic result has missing or extra source groups.' }
                foreach ($row in $rows) {
                    $identity = @($columns | ForEach-Object { $row["$entity[$_]"] }) | ConvertTo-Json -Compress
                    if (-not $expectedRows.ContainsKey($identity)) { throw 'Visual-shaped result dimensions differ from actual snapshot facts.' }
                    $group = $expectedRows[$identity]
                    if ($row['[Event Count]'] -ne $group.count) { throw 'Visual-shaped event multiplicity differs from actual snapshot facts.' }
                    $sourceRow = $group.row
                    if ($key -ceq 'telemetry' -and ($null -eq $row['[Reading Value]'] -or
                        [double]$row['[Reading Value]'] -ne [double]::Parse($sourceRow.value, [Globalization.CultureInfo]::InvariantCulture))) {
                        throw 'Visual-shaped reading values differ from actual snapshot facts.'
                    }
                    $null = $expectedRows.Remove($identity)
                }
                if ($expectedRows.Count -ne 0) { throw 'Visual-shaped result omitted source groups.' }
            }
            $receipt.verification[$key] = @{ query = $queries[$key]; rowCount = $rows.Count; rows = $rows }
        }
        $receipt.status = 'VerifiedNativeSnapshot'
        Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
        $receipt
    } catch {
        $receipt.status = 'NeedsReconciliation'
        $receipt.error = $_.Exception.Message
        Invoke-SnapshotShared Save-MiningApplyReceipt @($stream, $receipt)
        throw
    } finally { $stream.Dispose() }
}

function New-MiningSnapshotClient {
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Target, [string]$AzureCliPython)
    if ($AzureCliPython) {
        $client = & $script:CatalogModule {
            param($Target, $Executable)
            function az { & $Executable -IBm azure.cli @args }
            New-MiningLiveClient $Target
        } $Target $AzureCliPython
    } else { $client = New-MiningLiveClient $Target }
    $tokens = @{}
    foreach ($entry in @(@('Kusto', 'https://kusto.kusto.windows.net'), @('PowerBi', 'https://analysis.windows.net/powerbi/api'))) {
        $arguments = @('account', 'get-access-token', '--subscription', $Target.SubscriptionId, '--resource', $entry[1], '--output', 'json', '--only-show-errors')
        $raw = if ($AzureCliPython) { & $AzureCliPython -IBm azure.cli @arguments } else { & az @arguments }
        if ($LASTEXITCODE -ne 0) { throw 'Cannot acquire selected source token. No account switch attempted.' }
        $token = ($raw -join "`n") | ConvertFrom-Json -AsHashtable
        $payload = $token.accessToken.Split('.')[1].Replace('-', '+').Replace('_', '/')
        $payload = $payload.PadRight($payload.Length + ((4 - $payload.Length % 4) % 4), '=')
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json -AsHashtable
        if ($claims.tid -ine $Target.TenantId -or $claims.oid -ine $Target.CallerObjectId -or
            $token.tenant -ine $Target.TenantId -or $claims.aud.TrimEnd('/') -cne $entry[1].TrimEnd('/') -or
            [long]$claims.exp -lt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 600) {
            throw 'Token does not match the reviewed tenant, caller, audience or lifetime.'
        }
        $tokens[$entry[0]] = $token.accessToken
    }
    $baseRequest = $client.request
    $client.request = {
        param($Request)
        if ($Request.audience -cnotin @('Kusto', 'PowerBi')) { return & $baseRequest $Request }
        $uri = [uri]$Request.uri
        $validHost = if ($Request.audience -ceq 'PowerBi') {
            $uri.Host -ceq 'api.powerbi.com'
        } else { $uri.Host -ceq ([uri]$Target.KustoEndpoint).Host }
        if (-not $validHost -or $uri.Scheme -cne 'https' -or $uri.Port -ne 443 -or $uri.UserInfo) { throw 'Unexpected token destination.' }
        $handler = [Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $http = [Net.Http.HttpClient]::new($handler)
        $http.Timeout = [TimeSpan]::FromSeconds(60)
        $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Request.method), $uri)
        $message.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $tokens[$Request.audience])
        if ($null -ne $Request.body) {
            $message.Content = [Net.Http.StringContent]::new(($Request.body | ConvertTo-Json -Depth 100 -Compress), [Text.Encoding]::UTF8, 'application/json')
        }
        try {
            $response = $http.SendAsync($message).GetAwaiter().GetResult()
            try {
                $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                $headers = @{}
                foreach ($header in $response.Headers) { $headers[$header.Key] = $header.Value -join ',' }
                $body = if ([string]::IsNullOrWhiteSpace($text)) { $null } else {
                    try { $text | ConvertFrom-Json -AsHashtable -DateKind String } catch { @{ message = $text } }
                }
                @{ statusCode = [int]$response.StatusCode; headers = $headers; body = $body }
            } finally { $response.Dispose() }
        } finally { $message.Dispose(); $http.Dispose() }
    }.GetNewClosure()
    $client
}

Export-ModuleMember -Function ConvertFrom-MiningSnapshotQuery, New-MiningSnapshotBundle, New-MiningSnapshotDefinitions,
    Get-MiningSnapshotCapture, Invoke-MiningSnapshotDeployment, New-MiningSnapshotClient
