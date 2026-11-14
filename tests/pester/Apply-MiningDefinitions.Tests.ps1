#Requires -Version 7.0

BeforeAll {
    $script:ApplyScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'fabric' 'apply-mining-definitions.ps1')).Path
    $script:SchemaPath = Join-Path $PSScriptRoot '..' '..' 'infra' 'fabric' 'eventhouse' 'MiningSchema.kql'
    $script:ValidationPath = Join-Path $PSScriptRoot '..' '..' 'infra' 'fabric' 'eventhouse' 'MiningValidation.kql'
    $script:QueriesPath = Join-Path $PSScriptRoot '..' '..' 'infra' 'fabric' 'eventhouse' 'MiningQueries.kql'
    $script:Ids = @{
        SubscriptionId = '00000000-0000-0000-0000-000000000001'
        TenantId = '00000000-0000-0000-0000-000000000002'
        WorkspaceId = '00000000-0000-0000-0000-000000000003'
        EventhouseId = '00000000-0000-0000-0000-000000000004'
        KqlDatabaseId = '00000000-0000-0000-0000-000000000005'
    }
    $script:TableDefinitions = @(
        [regex]::Matches(
            (Get-Content -LiteralPath $script:SchemaPath -Raw),
            '(?m)^\.create table (mining_\w+) \(([^)]+)\)\r?$'
        ) | ForEach-Object {
            [pscustomobject]@{
                Name = $_.Groups[1].Value
                Columns = @($_.Groups[2].Value.Split(',') | ForEach-Object {
                        $parts = $_.Trim().Split(':')
                        [pscustomobject]@{ Name = $parts[0]; CslType = $parts[1] }
                    })
            }
        }
    )
}

Describe 'apply-mining-definitions.ps1' {
    BeforeEach {
        $script:ParentEventhouseId = $script:Ids.EventhouseId
        $script:SchemaDriftTable = ''
        $script:WriteCommands = [System.Collections.Generic.List[string]]::new()
        $script:AppliedFunctions = [System.Collections.Generic.List[string]]::new()
        $script:ExistingTables = @($script:TableDefinitions.Name)
        $global:ApplyMiningIds = $script:Ids
        $global:ApplyMiningParentEventhouseId = $script:ParentEventhouseId
        $global:ApplyMiningTableDefinitions = $script:TableDefinitions
        $global:ApplyMiningSchemaDriftTable = $script:SchemaDriftTable
        $global:ApplyMiningWriteCommands = $script:WriteCommands
        $global:ApplyMiningAppliedFunctions = $script:AppliedFunctions
        $global:ApplyMiningExistingTables = $script:ExistingTables

        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -contains 'show') {
                return (@{ id = $global:ApplyMiningIds.SubscriptionId; tenantId = $global:ApplyMiningIds.TenantId } | ConvertTo-Json -Compress)
            }
            if ($args -contains 'get-access-token') { return 'mock-token' }
            throw "Unexpected az invocation: $args"
        }

        Mock Invoke-RestMethod {
            param($Method, $Uri, $Headers, $ContentType, $Body)
            if ($Method -eq 'Get') {
                if ($Uri -match '/workspaces/[^/]+$') {
                    return @{ id = $global:ApplyMiningIds.WorkspaceId }
                }
                if ($Uri -match '/workspaces/[^/]+/items$') {
                    return @{ value = @(
                            @{ id = $global:ApplyMiningIds.EventhouseId; type = 'Eventhouse'; displayName = 'mining-d01-eventhouse' },
                            @{ id = $global:ApplyMiningIds.KqlDatabaseId; type = 'KQLDatabase'; displayName = 'mining-d01-realtime' }
                        ) }
                }
                if ($Uri -match '/kqlDatabases/[^/]+$') {
                    return @{
                        id = $global:ApplyMiningIds.KqlDatabaseId
                        displayName = 'mining-d01-realtime'
                        properties = @{
                            parentEventhouseItemId = $global:ApplyMiningParentEventhouseId
                            queryServiceUri = 'https://mock.kusto.fabric.microsoft.com'
                        }
                    }
                }
                throw "Unexpected Fabric GET: $Uri"
            }

            $command = (ConvertFrom-Json $Body).csl
            $rows = [System.Collections.Generic.List[object]]::new()
            if ($command -eq '.show tables | project TableName') {
                foreach ($name in $global:ApplyMiningExistingTables) { [void]$rows.Add([object[]]@($name)) }
            }
            elseif ($command -match '^\.show table (mining_\w+) schema as json$') {
                $tableName = $Matches[1]
                $definition = $global:ApplyMiningTableDefinitions | Where-Object Name -CEQ $tableName
                $columns = if ($global:ApplyMiningSchemaDriftTable -ceq $tableName) {
                    @([pscustomobject]@{ Name = 'drifted'; CslType = 'string' })
                }
                else {
                    @($definition.Columns)
                }
                $schema = @{ OrderedColumns = $columns } | ConvertTo-Json -Compress -Depth 5
                [void]$rows.Add([object[]]@($tableName, $schema))
            }
            elseif ($command -match '^\.show table (mining_TelemetryRaw|mining_PlantStateEvents) ingestion mappings$') {
                $tableName = $Matches[1]
                $mappingName = if ($tableName -eq 'mining_TelemetryRaw') {
                    'mining_telemetry_raw_json_map'
                }
                else {
                    'mining_state_raw_json_map'
                }
                $mapping = '[{"column":"event","path":"$"},{"column":"timestamp_raw","path":"$.timestamp"}]'
                [void]$rows.Add([object[]]@($mappingName, 'application', $mapping))
            }
            elseif ($command -match '^\.show table (mining_TelemetryRaw|mining_PlantStateEvents) policy ingestiontime$') {
                [void]$rows.Add([object[]]@($Matches[1], 'ingestiontime', '{"IsEnabled":true}'))
            }
            elseif ($command -match '^\.show table (mining_\w+) policy retention$') {
                $tableName = $Matches[1]
                $retention = if ($tableName -in @('mining_AlertTransitions', 'mining_IncidentLedger')) {
                    '30.00:00:00'
                }
                else {
                    '7.00:00:00'
                }
                [void]$rows.Add([object[]]@($tableName, 'retention', (@{
                            SoftDeletePeriod = $retention
                            Recoverability = 'Enabled'
                        } | ConvertTo-Json -Compress)))
            }
            elseif ($command -eq '.show functions | project Name') {
                $names = @($global:ApplyMiningAppliedFunctions.ToArray())
                $functionRows = [object[][]]::new($names.Count)
                for ($index = 0; $index -lt $names.Count; $index++) {
                    $functionRows[$index] = [object[]]@($names[$index])
                }
                return [pscustomobject]@{
                    Tables = [object[]]@([pscustomobject]@{ Rows = $functionRows })
                }
            }
            elseif ($command -match '^\.alter table mining_\w+ policy retention ') {
                [void]$global:ApplyMiningWriteCommands.Add($command)
            }
            elseif ($command -match '^\.create-or-alter function\b') {
                [void]$global:ApplyMiningWriteCommands.Add($command)
                $name = [regex]::Match($command, '(?m)^\.create-or-alter function with \(folder = "[^"]+"\) (mining_\w+)\(').Groups[1].Value
                [void]$global:ApplyMiningAppliedFunctions.Add($name)
            }
            elseif ($command -match '^\.create-merge table mining_\w+ ') {
                [void]$global:ApplyMiningWriteCommands.Add($command)
            }
            else {
                throw "Unexpected Kusto command: $command"
            }

            return [pscustomobject]@{
                Tables = @([pscustomobject]@{ Rows = $rows.ToArray() })
            }
        }
    }

    It 'makes no writes or receipt during WhatIf, including when there are no missing tables' {
        $receipt = Join-Path $TestDrive 'whatif.jsonl'
        $result = & $script:ApplyScript @script:Ids -ReceiptPath $receipt -WhatIf

        $result.status | Should -Be 'WhatIf'
        $result.tablesToCreate | Should -HaveCount 0
        $result.readinessChanged | Should -BeFalse
        $result.materializationEnabled | Should -BeFalse
        $script:WriteCommands | Should -HaveCount 0
        Test-Path -LiteralPath $receipt | Should -BeFalse
    }

    It 'rejects a database attached to a different Eventhouse before writes' {
        $script:ParentEventhouseId = '00000000-0000-0000-0000-000000000099'
        $global:ApplyMiningParentEventhouseId = $script:ParentEventhouseId
        $receipt = Join-Path $TestDrive 'wrong-target.jsonl'

        { & $script:ApplyScript @script:Ids -ReceiptPath $receipt } |
            Should -Throw '*not bound to the selected mining Eventhouse*'
        $script:WriteCommands | Should -HaveCount 0
        Test-Path -LiteralPath $receipt | Should -BeFalse
    }

    It 'refuses schema drift before applying policies or functions' {
        $script:SchemaDriftTable = 'mining_TelemetryRaw'
        $global:ApplyMiningSchemaDriftTable = $script:SchemaDriftTable
        $receipt = Join-Path $TestDrive 'schema-drift.jsonl'

        { & $script:ApplyScript @script:Ids -ReceiptPath $receipt } |
            Should -Throw '*schema drift*'
        $script:WriteCommands | Should -HaveCount 0
        Test-Path -LiteralPath $receipt | Should -BeFalse
    }

    It 'applies and reads back the mining-scoped policies and all expected functions' {
        $receipt = Join-Path $TestDrive 'applied.jsonl'
        $result = $null
        $applyError = ''
        try {
            $result = & $script:ApplyScript @script:Ids -ReceiptPath $receipt
        }
        catch {
            $applyError = $_.Exception.Message
        }

        @($script:WriteCommands | Where-Object { $_ -match '^\.alter table .* policy retention ' }) |
            Should -HaveCount 7
        @($script:WriteCommands | Where-Object { $_ -match '^\.create-or-alter function\b' }) |
            Should -HaveCount 10
        $script:AppliedFunctions | Should -HaveCount 10
        $applyError | Should -BeNullOrEmpty
        $result.status | Should -Be 'DefinitionsAppliedReadinessGated'
        $records = @(Get-Content -LiteralPath $receipt | ForEach-Object { $_ | ConvertFrom-Json })
        $records[-1].status | Should -Be 'DefinitionsAppliedReadinessGated'
        $records[-1].readinessChanged | Should -BeFalse
        $records[-1].materializationEnabled | Should -BeFalse
    }
}
