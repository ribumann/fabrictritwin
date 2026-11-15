#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$LakehouseId,
    [guid]$SemanticModelId,
    [ValidateSet('SemanticModel', 'Report', 'All')][string]$DefinitionKind = 'All'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($WorkspaceId -eq [guid]::Empty -or $LakehouseId -eq [guid]::Empty -or
    ($DefinitionKind -in @('Report', 'All') -and $SemanticModelId -eq [guid]::Empty)) {
    throw 'Nonempty workspace and Lakehouse IDs are required; report definitions also require a semantic model ID.'
}

$semanticModelName = 'mining-d01-topology-semanticmodel'
$reportName = 'mining-d01-topology-report'
$pageId = '4f6e8c2a1b3d5e7f9012'

function Get-LineageTag {
    param([Parameter(Mandatory)][string]$Name)
    $bytes = [Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes("mining-D01-topology-v1/$Name"))
    $hex = [Convert]::ToHexString($bytes).ToLowerInvariant()
    return ('{0}-{1}-5{2}-a{3}-{4}' -f $hex.Substring(0, 8), $hex.Substring(8, 4),
        $hex.Substring(13, 3), $hex.Substring(17, 3), $hex.Substring(20, 12))
}

function Add-Part {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Parts,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Text
    )
    $Parts.Add([ordered]@{
        path        = $Path
        payload     = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))
        payloadType = 'InlineBase64'
    })
}

function Add-JsonPart {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Parts,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][object]$Value
    )
    Add-Part -Parts $Parts -Path $Path -Text ($Value | ConvertTo-Json -Depth 100)
}

$tables = @(
    @{ Name = 'Plant'; Entity = 'mining_D01_Plant'; Columns = @('id', 'label', 'parent_id', 'unit') },
    @{ Name = 'Line'; Entity = 'mining_D01_Line'; Columns = @('id', 'label', 'parent_id', 'unit') },
    @{ Name = 'Module'; Entity = 'mining_D01_Module'; Columns = @('id', 'label', 'parent_id', 'unit') },
    @{ Name = 'Equipment'; Entity = 'mining_D01_Equipment'; Columns = @('id', 'label', 'parent_id', 'unit') },
    @{ Name = 'Tag'; Entity = 'mining_D01_Tag'; Columns = @('id', 'label', 'parent_id', 'unit') },
    @{ Name = 'Stream'; Entity = 'mining_D01_Stream'; Columns = @('id', 'label', 'parent_id', 'unit') },
    @{ Name = 'PlantHasLine'; Entity = 'mining_D01_PlantHasLine'; Columns = @('source_id', 'target_id') },
    @{ Name = 'LineHasModule'; Entity = 'mining_D01_LineHasModule'; Columns = @('source_id', 'target_id') },
    @{ Name = 'ModuleHasEquipment'; Entity = 'mining_D01_ModuleHasEquipment'; Columns = @('source_id', 'target_id') },
    @{ Name = 'EquipmentHasTag'; Entity = 'mining_D01_EquipmentHasTag'; Columns = @('source_id', 'target_id') },
    @{ Name = 'ModuleSendsStream'; Entity = 'mining_D01_ModuleSendsStream'; Columns = @('source_id', 'target_id') },
    @{ Name = 'StreamTargetsModule'; Entity = 'mining_D01_StreamTargetsModule'; Columns = @('source_id', 'target_id') }
)

$measures = @(
    @{ Name = 'Plant count'; Formula = "DISTINCTCOUNT('Plant'[id])"; Format = '#,##0' },
    @{ Name = 'Line count'; Formula = "DISTINCTCOUNT('Line'[id])"; Format = '#,##0' },
    @{ Name = 'Module count'; Formula = "DISTINCTCOUNT('Module'[id])"; Format = '#,##0' },
    @{ Name = 'Equipment count'; Formula = "DISTINCTCOUNT('Equipment'[id])"; Format = '#,##0' },
    @{ Name = 'Tag count'; Formula = "DISTINCTCOUNT('Tag'[id])"; Format = '#,##0' },
    @{ Name = 'Stream count'; Formula = "DISTINCTCOUNT('Stream'[id])"; Format = '#,##0' },
    @{ Name = 'Catalog relationship count'; Formula = "COUNTROWS('PlantHasLine') + COUNTROWS('LineHasModule') + COUNTROWS('ModuleHasEquipment') + COUNTROWS('EquipmentHasTag') + COUNTROWS('ModuleSendsStream') + COUNTROWS('StreamTargetsModule')"; Format = '#,##0' },
    @{ Name = 'Modules per line'; Formula = "DISTINCTCOUNT('LineHasModule'[target_id])"; Format = '#,##0' },
    @{ Name = 'Equipment per module'; Formula = "DISTINCTCOUNT('ModuleHasEquipment'[target_id])"; Format = '#,##0' },
    @{ Name = 'Tags per equipment'; Formula = "DISTINCTCOUNT('EquipmentHasTag'[target_id])"; Format = '#,##0' },
    @{ Name = 'Outgoing streams per module'; Formula = "DISTINCTCOUNT('ModuleSendsStream'[target_id])"; Format = '#,##0' },
    @{ Name = 'Incoming streams per module'; Formula = "DISTINCTCOUNT('StreamTargetsModule'[source_id])"; Format = '#,##0' },
    @{ Name = 'Tagged equipment'; Formula = "DISTINCTCOUNT('EquipmentHasTag'[source_id])"; Format = '#,##0' },
    @{ Name = 'Equipment tag coverage'; Formula = "DIVIDE([Tagged equipment], [Equipment count], 0)"; Format = '0.0%' }
)

$relationships = @(
    @{ Table = 'PlantHasLine'; Column = 'source_id'; Entity = 'Plant' },
    @{ Table = 'PlantHasLine'; Column = 'target_id'; Entity = 'Line' },
    @{ Table = 'LineHasModule'; Column = 'source_id'; Entity = 'Line' },
    @{ Table = 'LineHasModule'; Column = 'target_id'; Entity = 'Module' },
    @{ Table = 'ModuleHasEquipment'; Column = 'source_id'; Entity = 'Module' },
    @{ Table = 'ModuleHasEquipment'; Column = 'target_id'; Entity = 'Equipment' },
    @{ Table = 'EquipmentHasTag'; Column = 'source_id'; Entity = 'Equipment' },
    @{ Table = 'EquipmentHasTag'; Column = 'target_id'; Entity = 'Tag' },
    @{ Table = 'ModuleSendsStream'; Column = 'source_id'; Entity = 'Module' },
    @{ Table = 'ModuleSendsStream'; Column = 'target_id'; Entity = 'Stream' },
    @{ Table = 'StreamTargetsModule'; Column = 'source_id'; Entity = 'Stream' },
    @{ Table = 'StreamTargetsModule'; Column = 'target_id'; Entity = 'Module' }
)

$requests = [ordered]@{}
if ($DefinitionKind -in @('SemanticModel', 'All')) {
    $parts = [System.Collections.Generic.List[object]]::new()
    $platform = @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json'
        metadata = @{
            type = 'SemanticModel'
            displayName = $semanticModelName
            description = 'DirectLake semantic model for the verified static Mining D01 catalog topology; it does not represent live telemetry.'
        }
        config = @{ version = '2.0'; logicalId = 'b620d1fa-42e5-5f38-9ee5-740a42324871' }
    }
    Add-JsonPart $parts '.platform' $platform
    Add-JsonPart $parts 'definition.pbism' @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json'
        version = '5.0'
        settings = @{ qnaEnabled = $false }
    }
    Add-Part $parts 'definition/database.tmdl' "database`n`tcompatibilityLevel: 1604`n"
    Add-Part $parts 'definition/cultures/en-US.tmdl' @'
cultureInfo en-US

    linguisticMetadata =
            {
              "Version": "1.0.0",
              "Language": "en-US"
            }
        contentType: json
'@
    Add-Part $parts 'definition/expressions.tmdl' @"
expression 'Mining D01 DirectLake' =
        let
            Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/$WorkspaceId/$LakehouseId", [HierarchicalNavigation=true])
        in
            Source

    annotation PBI_IncludeFutureArtifacts = False
"@

    $modelLines = [System.Collections.Generic.List[string]]::new()
    $modelLines.Add('model Model')
    $modelLines.Add('    culture: en-US')
    $modelLines.Add('    defaultPowerBIDataSourceVersion: powerBI_V3')
    $modelLines.Add('    sourceQueryCulture: en-US')
    $modelLines.Add('    dataAccessOptions')
    $modelLines.Add('        legacyRedirects')
    $modelLines.Add('        returnErrorValuesAsNull')
    $modelLines.Add('')
    $modelLines.Add('annotation __PBI_TimeIntelligenceEnabled = 0')
    $modelLines.Add('annotation PBI_ProTooling = ["DirectLakeOnOneLakeInWeb", "WebModelingEdit"]')
    $modelLines.Add('')
    foreach ($table in $tables) { $modelLines.Add("ref table $($table.Name)") }
    Add-Part $parts 'definition/model.tmdl' (($modelLines -join "`n") + "`n")

    $relationshipLines = [System.Collections.Generic.List[string]]::new()
    foreach ($relationship in $relationships) {
        $name = "$($relationship.Table)_$($relationship.Column)"
        $relationshipLines.Add("relationship $name")
        $relationshipLines.Add("`tfromColumn: $($relationship.Table).$($relationship.Column)")
        $relationshipLines.Add("`ttoColumn: $($relationship.Entity).id")
        $relationshipLines.Add('')
    }
    Add-Part $parts 'definition/relationships.tmdl' ($relationshipLines -join "`n")

    foreach ($table in $tables) {
        $lines = [System.Collections.Generic.List[string]]::new()
        $lines.Add("table $($table.Name)")
        $lines.Add("`tlineageTag: $(Get-LineageTag "table/$($table.Name)")")
        if ($table.Name -eq 'Plant') {
            foreach ($measure in $measures) {
                $lines.Add('')
                $lines.Add("`tmeasure '$($measure.Name)' = $($measure.Formula)")
                $lines.Add("`t`tformatString: $($measure.Format)")
                $lines.Add("`t`tlineageTag: $(Get-LineageTag "measure/$($measure.Name)")")
            }
        }
        foreach ($column in $table.Columns) {
            $lines.Add('')
            $lines.Add("`tcolumn $column")
            $lines.Add("`t`tdataType: string")
            if ($column -eq 'id') { $lines.Add("`t`tisKey") }
            $lines.Add("`t`tsummarizeBy: none")
            $lines.Add("`t`tlineageTag: $(Get-LineageTag "column/$($table.Name)/$column")")
            $lines.Add("`t`tsourceColumn: $column")
        }
        $lines.Add('')
        $lines.Add("`tpartition $($table.Name) = entity")
        $lines.Add("`t`tmode: directLake")
        $lines.Add("`t`tsource")
        $lines.Add("`t`t`tentityName: $($table.Entity)")
        $lines.Add("`t`t`tschemaName: dbo")
        $lines.Add("`t`t`texpressionSource: 'Mining D01 DirectLake'")
        Add-Part $parts "definition/tables/$($table.Name).tmdl" (($lines -join "`n") + "`n")
    }

    $requests.SemanticModelRequest = [ordered]@{
        displayName = $semanticModelName
        definition = @{ parts = $parts.ToArray() }
    }
}

if ($DefinitionKind -in @('Report', 'All')) {
    $parts = [System.Collections.Generic.List[object]]::new()
    $platform = @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json'
        metadata = @{
            type = 'Report'
            displayName = $reportName
            description = 'Catalog topology report for the static Mining D01 Lakehouse source; no realtime telemetry is implied.'
        }
        config = @{ version = '2.0'; logicalId = '5b1d0a2c-f7a1-5a8e-bf64-04f7efb66d81' }
    }
    Add-JsonPart $parts '.platform' $platform
    Add-JsonPart $parts 'definition.pbir' @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json'
        version = '4.0'
        datasetReference = @{
            byConnection = @{ connectionString = "semanticmodelid=$SemanticModelId" }
        }
    }
    Add-JsonPart $parts 'definition/report.json' @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.1.0/schema.json'
        themeCollection = @{
            baseTheme = @{
                name = 'CY25SU12'
                reportVersionAtImport = @{ visual = '2.5.0'; report = '3.1.0'; page = '2.3.0' }
                type = 'SharedResources'
            }
        }
        resourcePackages = @(@{
            name = 'SharedResources'
            type = 'SharedResources'
            items = @(@{ name = 'CY25SU12'; path = 'BaseThemes/CY25SU12.json'; type = 'BaseTheme' })
        })
        settings = @{
            useStylableVisualContainerHeader = $true
            defaultFilterActionIsDataFilter = $true
            defaultDrillFilterOtherVisuals = $true
            allowChangeFilterTypes = $true
            allowInlineExploration = $true
            useEnhancedTooltips = $true
            useDefaultAggregateDisplayName = $true
        }
    }
    Add-JsonPart $parts 'definition/version.json' @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json'
        version = '2.0.0'
    }
    Add-JsonPart $parts 'definition/pages/pages.json' @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json'
        pageOrder = @($pageId)
        activePageName = $pageId
    }
    Add-JsonPart $parts "definition/pages/$pageId/page.json" @{
        '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.0.0/schema.json'
        name = $pageId
        displayName = 'D01 Catalog Topology'
        displayOption = 'FitToPage'
        height = 900
        width = 1600
    }

    $visualDefinitions = @(
        @{ Id = '5a7b9c1d3e4f608172a1'; Title = 'Modules by processing line'; Subtitle = 'Direct catalog links from each line to its modules'; CategoryTable = 'Line'; Measure = 'Modules per line'; X = 20; Y = 20; Width = 760; Height = 390 },
        @{ Id = '6b8c0d2e4f5a718293b2'; Title = 'Equipment by module'; Subtitle = 'Direct catalog links from each module to its equipment'; CategoryTable = 'Module'; Measure = 'Equipment per module'; X = 820; Y = 20; Width = 760; Height = 390 },
        @{ Id = '7c9d1e3f50618293a4c3'; Title = 'Tags by equipment'; Subtitle = 'Direct catalog links from each equipment item to its tags'; CategoryTable = 'Equipment'; Measure = 'Tags per equipment'; X = 20; Y = 430; Width = 760; Height = 390 },
        @{ Id = '8d0e2f4152637485b6d4'; Title = 'Process streams by module'; Subtitle = 'Outgoing and incoming process-stream links in the catalog'; CategoryTable = 'Module'; Measures = @('Outgoing streams per module', 'Incoming streams per module'); X = 820; Y = 430; Width = 760; Height = 390 }
    )

    foreach ($visualDefinition in $visualDefinitions) {
        $measureNames = if ($visualDefinition.ContainsKey('Measures')) {
            @($visualDefinition.Measures)
        } else {
            @($visualDefinition.Measure)
        }
        $measureProjections = @($measureNames | ForEach-Object {
                @{
                    field = @{
                        Measure = @{
                            Expression = @{ SourceRef = @{ Entity = 'Plant' } }
                            Property = $_
                        }
                    }
                    queryRef = "Plant.$_"
                }
            })
        $visual = @{
            '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.5.0/schema.json'
            name = $visualDefinition.Id
            position = @{
                x = $visualDefinition.X
                y = $visualDefinition.Y
                z = [array]::IndexOf($visualDefinitions.Id, $visualDefinition.Id) * 1000
                height = $visualDefinition.Height
                width = $visualDefinition.Width
                tabOrder = [array]::IndexOf($visualDefinitions.Id, $visualDefinition.Id) * 1000
            }
            visual = @{
                visualType = 'clusteredBarChart'
                query = @{
                    queryState = @{
                        Category = @{
                            projections = @(@{
                                field = @{
                                    Column = @{
                                        Expression = @{ SourceRef = @{ Entity = $visualDefinition.CategoryTable } }
                                        Property = 'label'
                                    }
                                }
                                queryRef = "$($visualDefinition.CategoryTable).label"
                                active = $true
                            })
                        }
                        Y = @{ projections = $measureProjections }
                    }
                }
                objects = @{
                    legend = @(@{ properties = @{ position = @{ expr = @{ Literal = @{ Value = "'Top'" } } } } })
                }
                visualContainerObjects = @{
                    title = @(@{ properties = @{
                                show = @{ expr = @{ Literal = @{ Value = 'true' } } }
                                text = @{ expr = @{ Literal = @{ Value = "'$($visualDefinition.Title)'" } } }
                                fontSize = @{ expr = @{ Literal = @{ Value = '12D' } } }
                            } })
                    subTitle = @(@{ properties = @{
                                   show = @{ expr = @{ Literal = @{ Value = 'true' } } }
                                   text = @{ expr = @{ Literal = @{ Value = "'$($visualDefinition.Subtitle)'" } } }
                                   fontSize = @{ expr = @{ Literal = @{ Value = '9D' } } }
                               } })
                    border = @(@{ properties = @{
                                   show = @{ expr = @{ Literal = @{ Value = 'true' } } }
                                   radius = @{ expr = @{ Literal = @{ Value = '5D' } } }
                               } })
                }
                drillFilterOtherVisuals = $true
            }
        }
        Add-JsonPart $parts "definition/pages/$pageId/visuals/$($visualDefinition.Id)/visual.json" $visual
    }

    $requests.ReportRequest = [ordered]@{
        displayName = $reportName
        definition = @{ parts = $parts.ToArray() }
    }
}

[pscustomobject]$requests
