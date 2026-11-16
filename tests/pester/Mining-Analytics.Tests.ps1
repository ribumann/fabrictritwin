BeforeAll {
    $script:root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $script:generator = Join-Path $script:root 'scripts\fabric\New-MiningAnalyticsDefinition.ps1'
    $script:safetyModule = Join-Path $script:root 'scripts\fabric\MiningAnalyticsSafety.psm1'
    Import-Module $script:safetyModule -Force
    $script:arguments = @{
        WorkspaceId = 'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
        LakehouseId = '0774df89-ff28-415b-be16-c31a1604cbf4'
        SemanticModelId = '11111111-2222-4333-8444-555555555555'
        DefinitionKind = 'All'
    }

    function Read-PartText($Request, [string]$Path) {
        $parts = @($Request.definition.parts | Where-Object path -CEQ $Path)
        if ($parts.Count -ne 1) { throw "Expected one definition part '$Path'." }
        [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[0].payload))
    }

    function Read-PartJson($Request, [string]$Path) {
        Read-PartText $Request $Path | ConvertFrom-Json -AsHashtable
    }
}

Describe 'Mining D01 native analytics definitions' {
    It 'creates DirectLake partitions for all twelve existing catalog tables' {
        $definition = & $script:generator @script:arguments
        $request = $definition.SemanticModelRequest
        $tableParts = @($request.definition.parts | Where-Object path -Like 'definition/tables/*.tmdl')

        $request.displayName | Should -BeExactly 'mining-d01-topology-semanticmodel'
        $tableParts | Should -HaveCount 12
        @($request.definition.parts.path | Select-Object -Unique) | Should -HaveCount $request.definition.parts.Count
        foreach ($part in $tableParts) {
            $text = Read-PartText $request $part.path
            $text | Should -Match 'mode: directLake'
            $text | Should -Match "schemaName: dbo"
            $text | Should -Match "expressionSource: 'Mining D01 DirectLake'"
            $text | Should -Match '(?m)^\t{3}entityName: mining_D01_'
            $text | Should -Not -Match '`t|`entity'
        }

        $expression = Read-PartText $request 'definition/expressions.tmdl'
        $expression | Should -Match ([regex]::Escape("https://onelake.dfs.fabric.microsoft.com/$($script:arguments.WorkspaceId)/$($script:arguments.LakehouseId)"))
    }

    It 'preserves both endpoint roles for each of the six catalog relationships' {
        $request = (& $script:generator @script:arguments).SemanticModelRequest
        $relationships = Read-PartText $request 'definition/relationships.tmdl'
        $expected = @(
            @('PlantHasLine_source_id', 'PlantHasLine.source_id', 'Plant.id'),
            @('PlantHasLine_target_id', 'PlantHasLine.target_id', 'Line.id'),
            @('LineHasModule_source_id', 'LineHasModule.source_id', 'Line.id'),
            @('LineHasModule_target_id', 'LineHasModule.target_id', 'Module.id'),
            @('ModuleHasEquipment_source_id', 'ModuleHasEquipment.source_id', 'Module.id'),
            @('ModuleHasEquipment_target_id', 'ModuleHasEquipment.target_id', 'Equipment.id'),
            @('EquipmentHasTag_source_id', 'EquipmentHasTag.source_id', 'Equipment.id'),
            @('EquipmentHasTag_target_id', 'EquipmentHasTag.target_id', 'Tag.id'),
            @('ModuleSendsStream_source_id', 'ModuleSendsStream.source_id', 'Module.id'),
            @('ModuleSendsStream_target_id', 'ModuleSendsStream.target_id', 'Stream.id'),
            @('StreamTargetsModule_source_id', 'StreamTargetsModule.source_id', 'Stream.id'),
            @('StreamTargetsModule_target_id', 'StreamTargetsModule.target_id', 'Module.id')
        )
        foreach ($relation in $expected) {
            $relationships | Should -Match "relationship $($relation[0])\s+fromColumn: $([regex]::Escape($relation[1]))\s+toColumn: $([regex]::Escape($relation[2]))"
        }
    }

    Describe 'Mining analytics deployment safety' {
        It 'reads every Fabric inventory page and rejects repeated item IDs' {
            $workspaceId = [guid]'db05aacb-bd7c-405a-a19b-90cc1c67d87b'
            $firstId = [guid]'11111111-2222-4333-8444-555555555555'
            $secondId = [guid]'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
            $calls = [System.Collections.Generic.List[string]]::new()
            $request = {
                param($Uri, $Headers)
                $calls.Add($Uri)
                if ($calls.Count -eq 1) {
                    return [pscustomobject]@{
                        value = @([pscustomobject]@{ id = $firstId; type = 'SemanticModel'; displayName = 'first' })
                        continuationUri = 'https://api.fabric.microsoft.com/v1/workspaces/next'
                    }
                }
                return [pscustomobject]@{
                    value = @([pscustomobject]@{ id = $secondId; type = 'Report'; displayName = 'second' })
                }
            }.GetNewClosure()

            $items = Get-MiningAnalyticsFabricItems -WorkspaceId $workspaceId -Headers @{} -Request $request
            $items | Should -HaveCount 2
            $calls | Should -HaveCount 2
            $calls[1] | Should -BeExactly 'https://api.fabric.microsoft.com/v1/workspaces/next'

            $duplicateRequest = {
                param($Uri, $Headers)
                if ($Uri.EndsWith('/items')) {
                    return [pscustomobject]@{
                        value = @([pscustomobject]@{ id = $firstId; type = 'SemanticModel'; displayName = 'again' })
                        continuationUri = 'https://api.fabric.microsoft.com/v1/workspaces/duplicate'
                    }
                }
                return [pscustomobject]@{
                    value = @([pscustomobject]@{ id = $firstId; type = 'SemanticModel'; displayName = 'again' })
                }
            }.GetNewClosure()
            { Get-MiningAnalyticsFabricItems -WorkspaceId $workspaceId -Headers @{} -Request $duplicateRequest } |
                Should -Throw '*repeated item ID*'

            $untrustedContinuation = {
                param($Uri, $Headers)
                [pscustomobject]@{
                    value = @()
                    continuationUri = 'https://example.invalid/items'
                }
            }
            { Get-MiningAnalyticsFabricItems -WorkspaceId $workspaceId -Headers @{} -Request $untrustedContinuation } |
                Should -Throw '*invalid continuation URI*'
        }

        It 'matches same-name items by type and rejects duplicate or wrong-type matches' {
            $item = [pscustomobject]@{
                id = '11111111-2222-4333-8444-555555555555'
                type = 'SemanticModel'
                displayName = 'Mining topology'
            }
            $endpoint = [pscustomobject]@{
                id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
                type = 'SQLEndpoint'
                displayName = 'Mining topology'
            }
            (Get-MiningAnalyticsMatchingItem -Items @($item, $endpoint) `
                    -DisplayName 'Mining topology' -Type 'SemanticModel').id |
                Should -BeExactly $item.id
            { Get-MiningAnalyticsMatchingItem -Items @($item, ($item | Select-Object *)) `
                    -DisplayName 'Mining topology' -Type 'SemanticModel' } |
                Should -Throw '*Multiple Fabric items*'
            { Get-MiningAnalyticsMatchingItem -Items @($item) `
                    -DisplayName 'Mining topology' -Type 'Report' } |
                Should -Throw '*expected ''Report''*'
            { Get-MiningAnalyticsMatchingItem -Items @($item) `
                    -DisplayName 'mining topology' -Type 'SemanticModel' } |
                Should -Throw '*differs in case*'
        }

        It 'requires a created item to have a new ID matching the create response' {
            $newItem = [pscustomobject]@{
                id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
                type = 'Report'
                displayName = 'Mining topology'
            }
            Assert-MiningAnalyticsCreatedItemIdentity -Item $newItem -ReturnedId $newItem.id `
                -PreimageItemIds @('11111111-2222-4333-8444-555555555555') `
                -DisplayName 'Mining topology' -Type 'Report' |
                Should -BeExactly $newItem.id
            { Assert-MiningAnalyticsCreatedItemIdentity -Item $newItem -ReturnedId $newItem.id `
                    -PreimageItemIds @($newItem.id) -DisplayName 'Mining topology' -Type 'Report' } |
                Should -Throw '*present before submission*'
            { Assert-MiningAnalyticsCreatedItemIdentity -Item $newItem -ReturnedId '11111111-2222-4333-8444-555555555555' `
                    -PreimageItemIds @() -DisplayName 'Mining topology' -Type 'Report' } |
                Should -Throw '*does not match*'
        }

        It 'compares the complete native definition while allowing JSON object-key normalization' {
            $expected = @{
                parts = @(
                    @{
                        path = 'definition/report.json'
                        payloadType = 'InlineBase64'
                        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"a":1,"b":{"c":true}}'))
                    },
                    @{
                        path = 'definition/model.tmdl'
                        payloadType = 'InlineBase64'
                        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("model Model`r`n    culture: en-US`r`n"))
                    }
                )
            }
            $actual = @{
                parts = @(
                    @{
                        path = 'definition/report.json'
                        payloadType = 'InlineBase64'
                        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("{`n  `"b`": { `"c`": true }, `"a`": 1`n}"))
                    },
                    @{
                        path = 'definition/model.tmdl'
                        payloadType = 'InlineBase64'
                        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("model Model`n    culture: en-US`n"))
                    }
                )
            }

            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test item' } |
                Should -Not -Throw
            $extraPart = @{
                parts = @($actual.parts) + @{
                    path = 'unexpected.json'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
                }
            }
            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $extraPart -Label 'test item' } |
                Should -Throw '*part set differs*'
            $actual.parts[1].payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("model Other`n"))
            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test item' } |
                Should -Throw "*native definition part 'definition/model.tmdl' differs*"
        }

        It 'rejects unverified content for a referenced Fabric report theme resource' {
            $reportText = '{"resourcePackages":[{"name":"SharedResources","type":"SharedResources","items":[{"name":"CY25SU12","path":"BaseThemes/CY25SU12.json","type":"BaseTheme"}]}]}'
            $expected = @{
                parts = @(@{
                    path = 'definition/report.json'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($reportText))
                })
            }
            $actual = @{
                parts = @(
                    @{
                        path = 'definition/report.json'
                        payloadType = 'InlineBase64'
                        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($reportText))
                    },
                    @{
                        path = 'StaticResources/SharedResources/BaseThemes/CY25SU12.json'
                        payloadType = 'InlineBase64'
                        payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{}'))
                    }
                )
            }

            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test report' } |
                Should -Throw '*part set differs*'
        }

        It 'allows Fabric to expand only the exact report binding for the selected workspace and model' {
            $modelId = '11111111-2222-4333-8444-555555555555'
            $expectedText = @{
                '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json'
                version = '4.0'
                datasetReference = @{ byConnection = @{ connectionString = "semanticmodelid=$modelId" } }
            } | ConvertTo-Json -Depth 10
            $actualText = @{
                '$schema' = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json'
                version = '4.0'
                datasetReference = @{
                    byConnection = @{
                        connectionString = "Data Source=powerbi://api.powerbi.com/v1.0/myorg/mining-workspace;initial catalog=mining-d01-topology-semanticmodel;integrated security=ClaimsToken;semanticmodelid=$modelId"
                    }
                }
            } | ConvertTo-Json -Depth 10
            $expected = @{
                parts = @(@{
                    path = 'definition.pbir'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($expectedText))
                })
            }
            $actual = @{
                parts = @(@{
                    path = 'definition.pbir'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actualText))
                })
            }

            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual `
                    -Label 'test report' -ExpectedWorkspaceName 'mining-workspace' `
                    -ExpectedSemanticModelName 'mining-d01-topology-semanticmodel' } |
                Should -Not -Throw
            $actualPbir = $actualText | ConvertFrom-Json -AsHashtable
            $actualPbir.datasetReference.byConnection.connectionString = $actualPbir.datasetReference.byConnection.connectionString.Replace(
                'mining-workspace', 'other-workspace')
            $actual.parts[0].payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
                    ($actualPbir | ConvertTo-Json -Depth 10)))
            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual `
                    -Label 'test report' -ExpectedWorkspaceName 'mining-workspace' `
                    -ExpectedSemanticModelName 'mining-d01-topology-semanticmodel' } |
                Should -Throw "*native definition part 'definition.pbir' has an unexpected dataset connection string*"
        }

        It 'allows only Fabric zeroing the platform logical ID during definition readback' {
            $expectedText = '{"metadata":{"type":"SemanticModel"},"config":{"version":"2.0","logicalId":"b620d1fa-42e5-5f38-9ee5-740a42324871"}}'
            $actualText = '{"config":{"logicalId":"00000000-0000-0000-0000-000000000000","version":"2.0"},"metadata":{"type":"SemanticModel"}}'
            $expected = @{
                parts = @(@{
                    path = '.platform'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($expectedText))
                })
            }
            $actual = @{
                parts = @(@{
                    path = '.platform'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actualText))
                })
            }

            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Not -Throw
            $actual.parts[0].payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
                    $actualText.Replace('00000000-0000-0000-0000-000000000000', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')))
            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Throw '*unexpected config.logicalId*'
        }

        It 'allows only the observed Fabric pbism version normalization' {
            $expected = @{
                parts = @(@{
                    path = 'definition.pbism'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"version":"5.0","settings":{"qnaEnabled":false}}'))
                })
            }
            $actual = @{
                parts = @(@{
                    path = 'definition.pbism'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"settings":{"qnaEnabled":false},"version":"4.2"}'))
                })
            }

            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Not -Throw
            $actual.parts[0].payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
                    '{"settings":{"qnaEnabled":false},"version":"4.1"}'))
            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Throw "*native definition part 'definition.pbism' differs*"
        }

        It 'normalizes only equivalent TMDL indentation and line endings' {
            $expectedText = @(
                'cultureInfo en-US'
                ''
                '    linguisticMetadata ='
                '            {'
                '              "Version": "1.0.0",'
                '              "Language": "en-US"'
                '            }'
                '        contentType: json'
            ) -join "`n"
            $actualText = @(
                'cultureInfo en-US'
                ''
                "`tlinguisticMetadata ="
                "`t`t`t{"
                "`t`t`t  `"Version`": `"1.0.0`","
                "`t`t`t  `"Language`": `"en-US`""
                "`t`t`t}"
                "`t`tcontentType: json"
                ''
                ''
            ) -join "`n"
            $expected = @{
                parts = @(@{
                    path = 'definition/cultures/en-US.tmdl'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($expectedText))
                })
            }
            $actual = @{
                parts = @(@{
                    path = 'definition/cultures/en-US.tmdl'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actualText))
                })
            }

            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Not -Throw
            $actual.parts[0].payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
                    $actualText.Replace("`t`t`t{", "`t`t{")))
            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Throw "*native definition part 'definition/cultures/en-US.tmdl' differs*"
        }

        It 'normalizes the observed Fabric ordering of summarized column metadata' {
            $expectedText = "table Line`n    column label`n        summarizeBy: none`n        lineageTag: 8bcc731a-1b6e-51f4-aa3a-889b093b3006`n        sourceColumn: label"
            $actualText = "table Line`r`n`tcolumn label`r`n`t`tlineageTag: 8bcc731a-1b6e-51f4-aa3a-889b093b3006`r`n`t`tsummarizeBy: none`r`n`t`tsourceColumn: label`r`n"
            $expected = @{
                parts = @(@{
                    path = 'definition/tables/Line.tmdl'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($expectedText))
                })
            }
            $actual = @{
                parts = @(@{
                    path = 'definition/tables/Line.tmdl'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actualText))
                })
            }

            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Not -Throw
            $actual.parts[0].payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
                    $actualText.Replace('summarizeBy: none', 'summarizeBy: sum')))
            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Throw "*native definition part 'definition/tables/Line.tmdl' differs*"
        }

        It 'allows Fabric to append only the referenced culture already present in the definition' {
            $expectedText = "model Model`n    culture: en-US`nannotation __PBI_TimeIntelligenceEnabled = 0`nannotation PBI_ProTooling = []`nref table Plant"
            $actualText = "model Model`r`n`tculture: en-US`r`nannotation __PBI_TimeIntelligenceEnabled = 0`r`n`r`nannotation PBI_ProTooling = []`r`nref table Plant`r`n`r`nref cultureInfo en-US`r`n`r`n"
            $expected = @{
                parts = @(@{
                    path = 'definition/model.tmdl'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($expectedText))
                })
            }
            $actual = @{
                parts = @(@{
                    path = 'definition/model.tmdl'
                    payloadType = 'InlineBase64'
                    payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($actualText))
                })
            }

            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Not -Throw
            $actual.parts[0].payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
                    $actualText.Replace('ref cultureInfo en-US', 'ref cultureInfo other')))
            { Assert-MiningAnalyticsDefinitionMatches -ExpectedDefinition $expected -ActualDefinition $actual -Label 'test model' } |
                Should -Throw "*native definition part 'definition/model.tmdl' differs*"
        }

        It 'keeps submitting and unresolved creates pending until an explicit terminal receipt exists' {
            $records = @(
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; desiredRequestSha256 = 'abc'; status = 'Submitting' },
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; desiredRequestSha256 = 'abc'; status = 'Unresolved'; operationId = 'operation-1' },
                [pscustomobject]@{ kind = 'Report'; displayName = 'report'; desiredRequestSha256 = 'def'; status = 'Submitting'; attemptId = 'attempt-2' }
            )

            $pending = @(Get-PendingMiningAnalyticsCreates -Records $records)
            $pending | Should -HaveCount 2
            @($pending.status) | Should -Contain 'Unresolved'
            @($pending.status) | Should -Contain 'Submitting'

            $resolved = @($records) + [pscustomobject]@{
                kind = 'SemanticModel'
                displayName = 'model'
                desiredRequestSha256 = 'abc'
                status = 'OperationFailed'
                operationId = 'operation-1'
            }
            @(Get-PendingMiningAnalyticsCreates -Records $resolved) | Should -HaveCount 1
        }

        It 'correlates legacy operation-success records that omitted the request hash' {
            $records = @(
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; desiredRequestSha256 = 'old-1'; status = 'Submitting' },
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; desiredRequestSha256 = 'old-1'; status = 'Unresolved'; operationId = 'failed-1' },
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; desiredRequestSha256 = 'old-2'; status = 'Submitting' },
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; desiredRequestSha256 = 'old-2'; status = 'Unresolved'; operationId = 'failed-2' },
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; desiredRequestSha256 = 'current'; status = 'Submitting' },
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; status = 'OperationSucceeded'; operationId = 'succeeded' },
                [pscustomobject]@{ kind = 'SemanticModel'; displayName = 'model'; desiredRequestSha256 = 'current'; status = 'Applied'; operationId = 'succeeded' }
            )

            $pending = @(Get-PendingMiningAnalyticsCreates -Records $records)
            $pending | Should -HaveCount 2
            @($pending.desiredRequestSha256) | Should -Contain 'old-1'
            @($pending.desiredRequestSha256) | Should -Contain 'old-2'
        }
    }

    It 'binds each report visual to a real DirectLake category and measure' {
        $definition = & $script:generator @script:arguments
        $request = $definition.ReportRequest
        $binding = Read-PartJson $request 'definition.pbir'
        $visualParts = @($request.definition.parts | Where-Object path -Like 'definition/pages/*/visuals/*/visual.json')

        $request.displayName | Should -BeExactly 'mining-d01-topology-report'
        $binding.datasetReference.byConnection.connectionString |
            Should -BeExactly "semanticmodelid=$($script:arguments.SemanticModelId)"
        $visualParts | Should -HaveCount 4
        foreach ($part in $visualParts) {
            $visual = Read-PartJson $request $part.path
            $visual.visual.visualType | Should -BeExactly 'clusteredBarChart'
            $visual.visual.query.queryState.Category.projections[0].field.Column.Property |
                Should -BeExactly 'label'
            $visual.visual.query.queryState.Y.projections.Count | Should -BeGreaterThan 0
            foreach ($projection in $visual.visual.query.queryState.Y.projections) {
                $projection.field.Measure.Expression.SourceRef.Entity | Should -BeExactly 'Plant'
                $projection.queryRef | Should -Match '^Plant\.'
            }
        }
    }

    It 'is deterministic and requires the actual report binding ID' {
        $first = & $script:generator @script:arguments | ConvertTo-Json -Depth 100 -Compress
        $second = & $script:generator @script:arguments | ConvertTo-Json -Depth 100 -Compress
        $first | Should -BeExactly $second

        $invalid = $script:arguments.Clone()
        $invalid.SemanticModelId = [guid]::Empty
        { & $script:generator @invalid } | Should -Throw '*semantic model ID*'
    }
}
