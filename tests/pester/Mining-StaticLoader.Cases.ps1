BeforeAll {
    function Read-TestReceipt($Path) { Get-Content -LiteralPath $Path | Select-Object -Last 1 | ConvertFrom-Json }

    function New-StaticTestClient($Plan, $Baseline) {
        $target = $Plan.target
        $state = @{
            calls = [Collections.Generic.List[object]]::new()
            files = @{}; directories = @{}; tables = @{}; definition = $Baseline
            definitionReads = 0; driftOnRead = 0; lostUpdateResponse = $false
            operationStatus = 'Succeeded'; operationHost = 'api.fabric.microsoft.com'
            metadataAccess = 1; rowAccess = 1; columnMapping = 'none'
            rowFault = ''; rejectedHeaders = $false; shortcuts = @(); continuation = ''
            definitionLro = $false; updateImmediate = $false; sqlLag = $false; columnFault = ''
            deltaFault = ''; createFailure = $false; loadFailure = $false
        }
        $request = {
            param($Request)
            $state.calls.Add($Request)
            $uri = [uri]$Request.uri
            $path = $uri.AbsolutePath
            $response = @{ statusCode = 200; headers = @{}; body = @{} }
            if ($path -match '/getDefinition$') {
                $state.definitionReads++
                if ($state.driftOnRead -eq $state.definitionReads) {
                    $state.definition = @{ parts = @($state.definition.parts) + @(@{ path = 'unrelated.json'; payload = 'e30='; payloadType = 'InlineBase64' }) }
                }
                if ($state.definitionLro) {
                    $response.statusCode = 202
                    $response.headers.Location = 'https://api.fabric.microsoft.com/v1/operations/00000000-0000-0000-0000-000000000020'
                } else { $response.body = @{ definition = $state.definition } }
            } elseif ($path -match '/updateDefinition$') {
                $state.definition = $Request.body.definition
                if ($state.lostUpdateResponse) { throw 'Simulated lost response after native update accepted.' }
                if (-not $state.updateImmediate) {
                    $response.statusCode = 202
                    $response.headers.Location = "https://$($state.operationHost)/v1/operations/00000000-0000-0000-0000-000000000010"
                }
            } elseif ($path -match '/schemas/dbo/tables/([^/]+)/load$') {
                if ($state.loadFailure) { $response.statusCode = 403; $response.body = @{ errorCode = 'InsufficientPrivileges' }; return $response }
                $state.tables[$Matches[1]] = $true
                $response.statusCode = 202
                $response.headers.Location = "https://$($state.operationHost)/v1/workspaces/$($target.WorkspaceId)/lakehouses/$($target.StaticLakehouseId)/operations/00000000-0000-0000-0000-000000000010"
            } elseif ($path -match '/operations/[^/]+/result$') {
                $response.body = @{ definition = $state.definition }
            } elseif ($path -match '/operations/') {
                if ($path -like '*lakehouses*') {
                    $number = switch ($state.operationStatus) { 'Succeeded' { 3 }; 'Running' { 2 }; 'Failed' { 4 }; default { $state.operationStatus } }
                    $response.body = @{ Status = $number; Error = $null }
                } else {
                    $response.body = @{ status = $(if ($state.operationStatus -eq 3) { 'Succeeded' } else { $state.operationStatus }) }
                }
            } elseif ($path -match '/shortcuts$') {
                $response.body = @{ value = $state.shortcuts; continuationToken = $state.continuation }
            } elseif ($path -match '/lakehouses/[^/]+$') {
                $response.body = @{
                    id = $target.StaticLakehouseId; workspaceId = $target.WorkspaceId; type = 'Lakehouse'; displayName = $target.SqlDatabase
                    properties = @{
                        defaultSchema = 'dbo'
                        sqlEndpointProperties = @{ id = $target.SqlEndpointId; connectionString = $target.SqlServer; provisioningStatus = 'Success' }
                    }
                }
            } elseif ($path -match '/items/[^/]+$') {
                $response.body = @{ id = $target.OntologyId; type = 'Ontology' }
            } elseif ($uri.Host -eq 'onelake.table.fabric.microsoft.com') {
                $name = $path.Split('.')[-1]
                if (-not $state.tables.ContainsKey($name)) { $response.statusCode = 404; return $response }
                $table = $Plan.tables | Where-Object name -CEQ $name
                $columns = @(@($table.csv | ConvertFrom-Csv)[0].PSObject.Properties.Name | ForEach-Object { @{ name = $_; type_name = 'STRING' } })
                if ($state.columnFault -eq 'duplicate') { $columns[-1] = $columns[0] }
                $response.body = @{
                    name = $name; schema_name = 'dbo'; catalog_name = $target.StaticLakehouseId
                    storage_location = "https://onelake.dfs.fabric.microsoft.com/$($target.WorkspaceId)/$($target.StaticLakehouseId)/Tables/dbo/$name"
                    columns = $columns
                }
            } elseif ($path -match '/_delta_log/\d{20}\.json$') {
                $response.body = [Text.Encoding]::UTF8.GetBytes('{"metaData":{"configuration":{"delta.columnMapping.mode":"' + $state.columnMapping + '"}}}')
            } elseif ($uri.Query -like '*resource=filesystem*') {
                $directory = [uri]::UnescapeDataString(($uri.Query -split 'directory=')[1].Split('&')[0])
                $response.body = @{ paths = @(@{ name = "$directory/00000000000000000000.json" }) }
                if ($state.deltaFault -eq 'checkpoint') { $response.body.paths += @{ name = "$directory/00000000000000000010.checkpoint.parquet" } }
                if ($state.deltaFault -eq 'gap') { $response.body.paths[0].name = "$directory/00000000000000000001.json" }
                if ($state.deltaFault -eq 'continuation') { $response.headers['x-ms-continuation'] = 'unread' }
            } elseif ($Request.method -eq 'HEAD') {
                if (-not $state.directories.ContainsKey($path)) { $response.statusCode = 404 }
            } elseif ($Request.method -eq 'PUT') {
                if ($state.createFailure) { $response.statusCode = 412; return $response }
                if ($uri.Query -eq '?resource=directory') { $state.directories[$path] = $true } else { $state.files[$path] = [byte[]]@() }
                $response.statusCode = 201
                if ($state.rejectedHeaders) { $response.headers['x-ms-rejected-headers'] = 'If-None-Match' }
            } elseif ($Request.method -eq 'PATCH') {
                if ($uri.Query -like '*action=append*') { $state.files[$path] = $Request.body; $response.statusCode = 202 }
            } elseif ($Request.method -eq 'GET') {
                if ($state.files.ContainsKey($path)) { $response.body = $state.files[$path] } else { $response.statusCode = 404 }
            } else { throw "Unexpected mock request: $($Request.method) $($Request.uri)" }
            return $response
        }.GetNewClosure()
        $query = {
            param($Sql)
            if ($Sql.Contains('DB_NAME()')) {
                return @{ database_name = $target.SqlDatabase; metadata_access = $state.metadataAccess; row_access = $state.rowAccess }
            }
            if ($Sql -match "AND \[name\] = '([^']+)'") {
                if ($state.tables.ContainsKey($Matches[1]) -and -not $state.sqlLag) { return @{ name = $Matches[1] } }
                return
            }
            if ($Sql.Contains('sys.security_predicates')) { return }
            if ($Sql -match 'FROM \[dbo\]\.\[([^\]]+)\]') {
                $table = $Plan.tables | Where-Object name -CEQ $Matches[1]
                $rows = @($table.csv | ConvertFrom-Csv | ForEach-Object {
                    $row = [ordered]@{}
                    foreach ($property in $_.PSObject.Properties) { $row[$property.Name] = $property.Value }
                    $row
                })
                if ($state.rowFault -eq 'extra') { $rows += $rows[0] }
                if ($state.rowFault -eq 'changed') { $rows[0][$rows[0].Keys[0]] = 'wrong' }
                if ($state.rowFault -eq 'typed') { $rows[0][$rows[0].Keys[0]] = 42 }
                if ($state.rowFault -eq 'duplicate' -and $rows.Count -gt 1) { $rows[1] = $rows[0] }
                [Array]::Reverse($rows)
                return $rows
            }
            throw "Unexpected mock SQL: $Sql"
        }.GetNewClosure()
        @{
            context = @{ tenantId = $target.TenantId; subscriptionId = $target.SubscriptionId; callerObjectId = $target.CallerObjectId }
            request = $request; query = $query; sleep = { param($Seconds) }; state = $state
        }
    }
}

BeforeEach {
    $script:target.CallerObjectId = '00000000-0000-0000-0000-000000000008'
    $script:target.SqlEndpointId = '00000000-0000-0000-0000-000000000009'
    $script:target.SqlServer = 'fixture.datawarehouse.fabric.microsoft.com'
    $script:target.SqlDatabase = 'fixture_lakehouse'
    Write-Fixture $script:targetPath $script:target
    $script:arguments.TargetSha256 = Get-FixtureHash $script:targetPath
    $script:applyPlan = New-MiningOntologyPlan @script:arguments
    $script:bundle = Join-Path $TestDrive ([guid]::NewGuid().ToString())
    $null = Export-MiningOntologyPlan $script:applyPlan $script:bundle
    $script:client = New-StaticTestClient $script:applyPlan $script:baseline
    $script:applyArgs = @{
        PlanInputs = $script:arguments; BundleDirectory = $script:bundle
        ReviewedPlanSha256 = Get-FixtureHash (Join-Path $script:bundle 'plan.json')
        ReceiptPath = Join-Path $TestDrive "$([guid]::NewGuid()).receipt.json"
        ApproveStaticWrites = $true; AcknowledgeNonAtomicUpdate = $true; ExclusiveWriterWindowId = 'fixture-reviewed-window'
        Client = $script:client; MaxPolls = 2; PollSeconds = 0
    }
}

It 'uploads schema-scoped static CSVs, verifies every row and preserves the full unrelated native definition' {
    $result = Invoke-MiningStaticApply @script:applyArgs
    $result.status | Should -BeExactly 'VerifiedStaticDefinition'
    $result.tables | Should -HaveCount 12
    $result.staticRowsVerified | Should -BeTrue
    $result.definitionVerified | Should -BeTrue
    $result.timeSeriesBound | Should -BeFalse
    $result.activeInstancesVerified | Should -BeFalse
    $result.nonAtomic | Should -BeTrue
    $result.rollback | Should -Match 'No automatic rollback or CAS'
    $writes = @($script:client.state.calls | Where-Object { $_.method -eq 'POST' -and $_.uri -like '*updateDefinition' })
    $writes | Should -HaveCount 1
    $writes[0].body.Keys | Should -Be @('definition')
    foreach ($part in $script:baseline.parts) {
        $actual = $writes[0].body.definition.parts | Where-Object path -CEQ $part.path
        ($actual | ConvertTo-Json -Compress) | Should -BeExactly ($part | ConvertTo-Json -Compress)
    }
    $loads = @($script:client.state.calls | Where-Object { $_.uri -like '*load?beta=true' })
    $loads | Should -HaveCount 12
    foreach ($load in $loads) {
        $load.uri | Should -Match "/lakehouses/$($script:target.StaticLakehouseId)/schemas/dbo/tables/mining_D01_[A-Za-z]+/load\?beta=true$"
        $load.body.mode | Should -BeExactly 'Overwrite'
        $load.body.pathType | Should -BeExactly 'File'
        $load.body.formatOptions.header | Should -BeTrue
    }
    $creates = @($script:client.state.calls | Where-Object method -EQ 'PUT')
    foreach ($create in $creates) { $create.headers['If-None-Match'] | Should -BeExactly '*' }
    $disk = Read-TestReceipt $script:applyArgs.ReceiptPath
    $disk.preimage.parts.Count | Should -Be $script:baseline.parts.Count
    $disk.operations.status | Select-Object -Unique | Should -BeExactly 'Succeeded'
}

It 'does no additional writes on a second apply after verifying real rows and definition again' {
    $null = Invoke-MiningStaticApply @script:applyArgs
    $count = $script:client.state.calls.Count
    $second = Invoke-MiningStaticApply @script:applyArgs
    $second.status | Should -BeExactly 'VerifiedStaticDefinition'
    $new = @($script:client.state.calls | Select-Object -Skip $count)
    @($new | Where-Object { $_.method -notin @('GET', 'HEAD') -and $_.uri -notlike '*getDefinition' }) | Should -HaveCount 0
    $new.Count | Should -BeGreaterThan 12
}

It 'requires target-bound explicit approvals before even contacting the injected client' {
    $script:applyArgs.ApproveStaticWrites = $false
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*Explicit*approval*'
    $script:client.state.calls | Should -HaveCount 0
    $script:applyArgs.ApproveStaticWrites = $true
    $script:applyArgs.ExclusiveWriterWindowId = ''
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*exclusive-writer*'
    $script:client.state.calls | Should -HaveCount 0
}

It 'rejects changed reviewed bytes, forged routes and tampered CSV files before any network call' {
    $path = Join-Path $script:bundle 'plan.json'
    Add-Content -LiteralPath $path -Value ' '
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*byte hash*'
    $script:applyArgs.ReviewedPlanSha256 = Get-FixtureHash $path
    $forged = Get-Content $path -Raw | ConvertFrom-Json -AsHashtable
    $forged.loadRequests[0].uri = 'https://example.invalid/overwrite-athlete'
    Write-Fixture $path $forged
    $script:applyArgs.ReviewedPlanSha256 = Get-FixtureHash $path
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*authoritative*'
    $script:client.state.calls | Should -HaveCount 0
}

It 'rejects caller mismatch, incomplete inventories and unproved row/metadata permissions before writes' {
    $script:client.context.callerObjectId = '00000000-0000-0000-0000-000000000099'
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*identity*'
    $script:client.context.callerObjectId = $script:target.CallerObjectId
    $script:client.state.continuation = 'unread-page'
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*inventory*incomplete*'
    $script:client.state.continuation = ''
    $script:client.state.metadataAccess = 0
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*metadata visibility*'
    @($script:client.state.calls | Where-Object method -IN @('PUT', 'PATCH')) | Should -HaveCount 0
}

It 'rejects shortcut redirects of owned schemas while ignoring unrelated athlete shortcuts' {
    $script:client.state.shortcuts = @(@{ path = 'Tables'; name = 'dbo' })
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*shortcut overlaps*'
    $script:client.state.shortcuts = @(@{ path = 'Tables/dbo'; name = 'AthleteArchive' })
    (Invoke-MiningStaticApply @script:applyArgs).status | Should -BeExactly 'VerifiedStaticDefinition'
}

It 'rejects existing wrong/extra/duplicate/typed rows rather than overwrite any existing source table' {
    foreach ($table in $script:applyPlan.tables) { $script:client.state.tables[$table.name] = $true }
    foreach ($fault in @('changed', 'extra', 'typed', 'duplicate')) {
        $script:client.state.rowFault = $fault
        { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*static*'
    }
    @($script:client.state.calls | Where-Object { $_.method -notin @('GET', 'HEAD') -and $_.uri -notlike '*getDefinition' }) | Should -HaveCount 0
}

It 'rejects mapped or unproved Delta tables before ontology mutation' {
    $script:client.state.tables[$script:applyPlan.tables[0].name] = $true
    $script:client.state.columnMapping = 'name'
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*Column-mapped*'
    Test-Path -LiteralPath $script:applyArgs.ReceiptPath | Should -BeFalse
}

It 'refuses live definition drift before uploads and drift after loads before native update' {
    $script:client.state.driftOnRead = 1
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*preimage drift*'
    @($script:client.state.calls | Where-Object method -EQ 'PUT') | Should -HaveCount 0
    $script:client.state.definition = $script:baseline
    $script:client.state.driftOnRead = 3
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*changed before submission*'
    @($script:client.state.calls | Where-Object uri -LIKE '*updateDefinition') | Should -HaveCount 0
    (Read-TestReceipt $script:applyArgs.ReceiptPath).status | Should -BeExactly 'NeedsReconciliation'
}

It 'refuses untrusted polling destinations without leaking requests or resubmitting a load' {
    $script:client.state.operationHost = 'example.invalid'
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*Untrusted*Location*'
    @($script:client.state.calls | Where-Object uri -LIKE 'https://example.invalid*') | Should -HaveCount 0
    @($script:client.state.calls | Where-Object uri -LIKE '*load?beta=true') | Should -HaveCount 1
}

It 'bounds native polling and persists the operation location without retrying its write' {
    $script:client.state.operationStatus = 'Running'
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*polling limit exceeded*'
    $receipt = Read-TestReceipt $script:applyArgs.ReceiptPath
    $receipt.operations[-1].operationLocation | Should -Match '/operations/'
    $count = $script:client.state.calls.Count
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*Prior apply outcome is unresolved*'
    $script:client.state.calls.Count | Should -Be $count
}

It 'stops when OneLake ignores conditional-create headers and records the uncertain outcome' {
    $script:client.state.rejectedHeaders = $true
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*ignored request headers*'
    $receipt = Read-TestReceipt $script:applyArgs.ReceiptPath
    $receipt.operations[-1].status | Should -BeExactly 'SubmittedOutcomeUnknown'
    @($script:client.state.calls | Where-Object method -EQ 'PUT') | Should -HaveCount 1
}

It 'reconciles an accepted update with lost response using read-only verification and never resends' {
    $script:client.state.lostUpdateResponse = $true
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*lost response*'
    $receipt = Read-TestReceipt $script:applyArgs.ReceiptPath
    $receipt.operations[-1].status | Should -BeExactly 'SubmittedOutcomeUnknown'
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*unresolved*'
    $script:applyArgs.Mode = 'Verify'
    $script:applyArgs.ReceiptPath = Join-Path $TestDrive 'readonly-reconciliation.json'
    $script:applyArgs.ApproveStaticWrites = $false
    $script:applyArgs.AcknowledgeNonAtomicUpdate = $false
    (Invoke-MiningStaticApply @script:applyArgs).status | Should -BeExactly 'VerifiedStaticDefinition'
    @($script:client.state.calls | Where-Object uri -LIKE '*updateDefinition') | Should -HaveCount 1
}

It 'treats numeric schema-load success as terminal and never requires a telemetry contract' {
    $script:client.state.operationStatus = 3
    (Invoke-MiningStaticApply @script:applyArgs).timeSeriesBound | Should -BeFalse
    @($script:client.state.calls | Where-Object uri -MATCH 'Eventhouse|Kusto|Telemetry') | Should -HaveCount 0
}

It 'follows asynchronous definition result routes and supports immediate definition update success' {
    $script:client.state.definitionLro = $true
    $script:client.state.updateImmediate = $true
    (Invoke-MiningStaticApply @script:applyArgs).definitionVerified | Should -BeTrue
    @($script:client.state.calls | Where-Object uri -MATCH '/operations/[^/]+/result$').Count | Should -BeGreaterThan 1
}

It 'stops on conditional-create conflict without append, flush or retry' {
    $script:client.state.createFailure = $true
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*HTTP 412*'
    @($script:client.state.calls | Where-Object method -EQ 'PUT') | Should -HaveCount 1
    @($script:client.state.calls | Where-Object method -EQ 'PATCH') | Should -HaveCount 0
}

It 'records native permission failure as an error without attempting roles or duplicate loads' {
    $script:client.state.loadFailure = $true
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*HTTP 403*InsufficientPrivileges*'
    @($script:client.state.calls | Where-Object uri -LIKE '*load?beta=true') | Should -HaveCount 1
    @($script:client.state.calls | Where-Object uri -MATCH 'role|permission|updateDefinition') | Should -HaveCount 0
    (Read-TestReceipt $script:applyArgs.ReceiptPath).status | Should -BeExactly 'NeedsReconciliation'
}

It 'refuses duplicate columns, incomplete Delta histories and SQL lag without any overwrite' {
    $script:client.state.tables[$script:applyPlan.tables[0].name] = $true
    $script:client.state.columnFault = 'duplicate'
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*Unexpected static columns*'
    $script:client.state.columnFault = ''
    foreach ($fault in @('checkpoint', 'gap', 'continuation')) {
        $script:client.state.deltaFault = $fault
        { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*Delta*'
    }
    $script:client.state.deltaFault = ''
    $script:client.state.sqlLag = $true
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*visibility disagrees*'
    @($script:client.state.calls | Where-Object method -EQ 'PUT') | Should -HaveCount 0
}

It 'checks individual CSV bundle bytes as well as plan bytes' {
    Add-Content -LiteralPath (Join-Path $script:bundle "$($script:applyPlan.tables[0].name).csv") -Value 'unexpected'
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*bundle content drift*'
    $script:client.state.calls | Should -HaveCount 0
}

It 'preserves flushed preimages in an append-only journal and blocks a torn final record' {
    $null = Invoke-MiningStaticApply @script:applyArgs
    $records = @(Get-Content -LiteralPath $script:applyArgs.ReceiptPath)
    $records.Count | Should -BeGreaterThan 12
    ($records[0] | ConvertFrom-Json).status | Should -BeExactly 'Prepared'
    ($records[0] | ConvertFrom-Json).preimage.parts.Count | Should -Be $script:baseline.parts.Count
    $stream = [IO.File]::OpenWrite($script:applyArgs.ReceiptPath)
    try {
        $stream.Position = $stream.Length
        $stream.Write([Text.Encoding]::UTF8.GetBytes('{"torn":'), 0, 8)
    } finally { $stream.Dispose() }
    $count = $script:client.state.calls.Count
    { Invoke-MiningStaticApply @script:applyArgs } | Should -Throw '*incomplete journal*'
    $script:client.state.calls.Count | Should -Be $count
    (Get-Content -LiteralPath $script:applyArgs.ReceiptPath -TotalCount 1) | Should -BeExactly $records[0]
}

It 'constructs the real encrypted SqlClient connection string without connecting' {
    $value = & (Get-Module MiningOntology) {
        param($Target)
        Get-MiningSqlConnectionString $Target
    } $script:target
    $builder = [Data.SqlClient.SqlConnectionStringBuilder]::new($value)
    $builder['Data Source'] | Should -BeExactly "tcp:$($script:target.SqlServer),1433"
    $builder['Initial Catalog'] | Should -BeExactly $script:target.SqlDatabase
    $builder['Encrypt'] | Should -BeTrue
    $builder['TrustServerCertificate'] | Should -BeFalse
    $builder['Connect Timeout'] | Should -Be 30
    $builder['Integrated Security'] | Should -BeFalse
    $builder['User ID'] | Should -BeNullOrEmpty
    $builder['Password'] | Should -BeNullOrEmpty
}

It 'validates native client token tenant, caller, audience and lifetime without sign-in or account switching' {
    $script:tokenFault = ''
    Mock az -ModuleName MiningOntology {
        $resourceIndex = [Array]::IndexOf($args, '--resource')
        $audience = $args[$resourceIndex + 1]
        $claims = @{
            tid = $script:target.TenantId; oid = $script:target.CallerObjectId; aud = $audience
            exp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600
        }
        switch ($script:tokenFault) {
            'tenant' { $claims.tid = '00000000-0000-0000-0000-000000000099' }
            'caller' { $claims.oid = '00000000-0000-0000-0000-000000000099' }
            'audience' { $claims.aud = 'https://example.invalid' }
            'expiry' { $claims.exp = 0 }
        }
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($claims | ConvertTo-Json -Compress))).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        @{ tenant = $script:target.TenantId; accessToken = "fixture.$payload.not-a-signature" } | ConvertTo-Json -Compress
        $global:LASTEXITCODE = 0
    }
    $native = New-MiningLiveClient $script:target
    $native.context.callerObjectId | Should -BeExactly $script:target.CallerObjectId
    $native.request | Should -BeOfType ([scriptblock])
    $native.query | Should -BeOfType ([scriptblock])
    Should -Invoke az -ModuleName MiningOntology -Times 3 -Exactly
    foreach ($fault in @('tenant', 'caller', 'audience', 'expiry')) {
        $script:tokenFault = $fault
        { New-MiningLiveClient $script:target } | Should -Throw '*Token tenant, caller, audience or lifetime*'
    }
    Should -Invoke az -ModuleName MiningOntology -Times 7 -Exactly
    $script:client.state.calls | Should -HaveCount 0
}
