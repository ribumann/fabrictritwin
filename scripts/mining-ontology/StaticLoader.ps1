function Assert-MiningClientTarget {
    param($Target, $Client)
    foreach ($field in @('CallerObjectId', 'SqlEndpointId')) {
        $id = [guid]::Empty
        if (-not $Target.Contains($field) -or -not [guid]::TryParseExact($Target[$field], 'D', [ref]$id) -or $id -eq [guid]::Empty) {
            throw "Apply requires reviewed exact target $field."
        }
    }
    if (-not $Target.Contains('SqlServer') -or
        $Target.SqlServer -notmatch '^[a-z0-9-]+(?:\.datawarehouse\.fabric\.microsoft\.com|-datawarehouse\.pbidedicated\.windows\.net)$' -or
        -not $Target.Contains('SqlDatabase') -or [string]::IsNullOrWhiteSpace($Target.SqlDatabase)) {
        throw 'Apply requires a reviewed Fabric SQL server hostname and database.'
    }
    foreach ($entry in @(@('TenantId', 'tenantId'), @('SubscriptionId', 'subscriptionId'), @('CallerObjectId', 'callerObjectId'))) {
        if ($Client.context[$entry[1]] -ine $Target[$entry[0]]) { throw 'Client identity does not match the reviewed target.' }
    }
}

function New-MiningLiveClient {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Target)
    $context = @{ tenantId = $Target.TenantId; subscriptionId = $Target.SubscriptionId; callerObjectId = $Target.CallerObjectId }
    Assert-MiningClientTarget $Target @{ context = $context }
    $tokens = @{}
    foreach ($entry in @(@('Fabric', 'https://api.fabric.microsoft.com'), @('Storage', 'https://storage.azure.com/'), @('Sql', 'https://database.windows.net/'))) {
        $raw = & az account get-access-token --subscription $Target.SubscriptionId --resource $entry[1] --output json --only-show-errors
        if ($LASTEXITCODE -ne 0) { throw "Cannot obtain $($entry[0]) token from the selected Azure CLI profile; no sign-in or account switch attempted." }
        $token = ($raw -join "`n") | ConvertFrom-Json -AsHashtable
        $segments = $token.accessToken.Split('.')
        if ($segments.Count -ne 3) { throw 'Unsupported access-token encoding.' }
        $payload = $segments[1].Replace('-', '+').Replace('_', '/')
        $payload = $payload.PadRight($payload.Length + ((4 - $payload.Length % 4) % 4), '=')
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) | ConvertFrom-Json -AsHashtable
        if ($token.tenant -ine $Target.TenantId -or $claims.tid -ine $Target.TenantId -or
            $claims.oid -ine $Target.CallerObjectId -or $claims.aud.TrimEnd('/') -cne $entry[1].TrimEnd('/') -or
            [long]$claims.exp -lt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 600) {
            throw 'Token tenant, caller, audience or lifetime does not match the reviewed target.'
        }
        $tokens[$entry[0]] = $token.accessToken
    }
    $request = {
        param($Request)
        $handler = [Net.Http.HttpClientHandler]::new()
        $handler.AllowAutoRedirect = $false
        $http = [Net.Http.HttpClient]::new($handler)
        $http.Timeout = [TimeSpan]::FromSeconds(60)
        $message = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Request.method), $Request.uri)
        $message.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $tokens[$Request.audience])
        foreach ($key in $Request.headers.Keys) { $null = $message.Headers.TryAddWithoutValidation($key, [string]$Request.headers[$key]) }
        if ($null -ne $Request.body) {
            $bytes = if ($Request.body -is [byte[]]) { $Request.body } else {
                [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Request.body -Compress -Depth 100))
            }
            $message.Content = [Net.Http.ByteArrayContent]::new([byte[]]$bytes)
            $message.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new($Request.contentType)
        }
        try {
            $response = $http.SendAsync($message).GetAwaiter().GetResult()
            try {
                $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
                $headers = @{}
                foreach ($header in $response.Headers) { $headers[$header.Key] = $header.Value -join ',' }
                $body = if ($Request.responseType -eq 'Bytes') { $bytes } elseif ($bytes.Length -eq 0) { $null } else {
                    [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -AsHashtable
                }
                @{ statusCode = [int]$response.StatusCode; headers = $headers; body = $body }
            } finally { $response.Dispose() }
        } finally { $message.Dispose(); $http.Dispose() }
    }.GetNewClosure()
    $query = {
        param([string]$Sql)
        $builder = [Data.SqlClient.SqlConnectionStringBuilder]::new()
        $builder.DataSource = "tcp:$($Target.SqlServer),1433"
        $builder.InitialCatalog = $Target.SqlDatabase
        $builder.Encrypt = $true
        $builder.TrustServerCertificate = $false
        $builder.ConnectTimeout = 30
        $connection = [Data.SqlClient.SqlConnection]::new($builder.ConnectionString)
        $connection.AccessToken = $tokens.Sql
        try {
            $connection.Open()
            $command = $connection.CreateCommand()
            $command.CommandText = $Sql
            $command.CommandTimeout = 60
            try {
                $reader = $command.ExecuteReader()
                try {
                    $rows = [Collections.Generic.List[object]]::new()
                    while ($reader.Read()) {
                        $row = [ordered]@{}
                        for ($i = 0; $i -lt $reader.FieldCount; $i++) { $row[$reader.GetName($i)] = $reader.GetValue($i) }
                        $rows.Add($row)
                        if ($rows.Count -gt 2048) { throw 'SQL read exceeded the bounded catalog result limit.' }
                    }
                    return $rows.ToArray()
                } finally { $reader.Dispose() }
            } finally { $command.Dispose() }
        } finally { $connection.Dispose() }
    }.GetNewClosure()
    @{ context = $context; request = $request; query = $query; sleep = { param($Seconds) Start-Sleep -Seconds $Seconds } }
}

function Invoke-MiningHttp {
    param($Client, [string]$Method, [string]$Uri, [string]$Audience = 'Fabric', $Body = $null,
        $Headers = @{}, [string]$ResponseType = 'Json')
    $request = @{
        method = $Method; uri = $Uri; audience = $Audience; body = $Body; headers = $Headers
        responseType = $ResponseType; contentType = $(if ($Body -is [byte[]]) { 'application/octet-stream' } else { 'application/json' })
    }
    $result = & $Client.request $request
    if ($result -isnot [Collections.IDictionary] -or -not $result.Contains('statusCode') -or
        -not $result.Contains('headers') -or -not $result.Contains('body')) { throw 'Malformed HTTP client response.' }
    if ($result.headers.Contains('x-ms-rejected-headers') -and $result.headers['x-ms-rejected-headers']) {
        throw 'OneLake ignored request headers; write protection is unproven. Reconcile without retry.'
    }
    return $result
}

function Assert-MiningHttpStatus {
    param($Response, [int[]]$Allowed = @(200))
    if ([int]$Response.statusCode -notin $Allowed) {
        $code = if ($Response.body -is [Collections.IDictionary] -and $Response.body.Contains('errorCode')) { $Response.body.errorCode } else { 'Unspecified' }
        throw "Native API failed: HTTP $($Response.statusCode), code $code. No automatic write retry."
    }
}

function Wait-MiningOperation {
    param($Client, $Response, $Target, [int]$MaxPolls, [int]$PollSeconds, [switch]$ReadResult)
    Assert-MiningHttpStatus $Response @(200, 201, 202)
    if ($Response.statusCode -ne 202) { return $Response.body }
    $location = [uri]$Response.headers['Location']
    $guidPattern = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
    $general = "^/v1/operations/$guidPattern$"
    $scoped = "^/v1/workspaces/$($Target.WorkspaceId)/lakehouses/$($Target.StaticLakehouseId)/operations/$guidPattern$"
    if (-not $location.IsAbsoluteUri -or $location.Scheme -cne 'https' -or
        $location.Host -cne 'api.fabric.microsoft.com' -or $location.Port -ne 443 -or
        $location.UserInfo -or $location.Query -or $location.Fragment -or
        ($location.AbsolutePath -notmatch $general -and $location.AbsolutePath -notmatch $scoped)) {
        throw 'Untrusted or unsupported operation Location; reconcile the acknowledged operation without resubmission.'
    }
    for ($i = 0; $i -lt $MaxPolls; $i++) {
        $delay = $PollSeconds
        if ($Response.headers.Contains('Retry-After')) {
            $retry = 0
            if (-not [int]::TryParse($Response.headers['Retry-After'], [ref]$retry) -or $retry -lt 0 -or $retry -gt 30) {
                throw 'Unsupported operation Retry-After; reconcile without resubmission.'
            }
            $delay = [Math]::Max($delay, $retry)
        }
        & $Client.sleep $delay
        $Response = Invoke-MiningHttp $Client GET $location.AbsoluteUri
        Assert-MiningHttpStatus $Response
        $coreOperation = $location.AbsolutePath -match $general
        $status = if ($coreOperation) { [string]$Response.body.status } else { [string]$Response.body.Status }
        $success = if ($coreOperation) { @('Succeeded') } else { @('3') }
        $pending = if ($coreOperation) { @('NotStarted', 'Running') } else { @('1', '2') }
        if ($status -cin $success) {
            if ($ReadResult) {
                if ($location.AbsolutePath -notmatch $general) { throw 'Definition result needs a core operation result route.' }
                $result = Invoke-MiningHttp $Client GET "$($location.AbsoluteUri)/result"
                Assert-MiningHttpStatus $result
                return $result.body
            }
            return $Response.body
        }
        if ($status -cnotin $pending) { throw "Native operation terminated or is unsupported: $status. No write retry." }
    }
    throw 'Native operation polling limit exceeded; delivery is unresolved. Reconcile without resubmission.'
}

function Read-MiningLiveDefinition {
    param($Client, $Target, $MaxPolls, $PollSeconds)
    $response = Invoke-MiningHttp $Client POST "https://api.fabric.microsoft.com/v1/workspaces/$($Target.WorkspaceId)/items/$($Target.OntologyId)/getDefinition"
    $body = Wait-MiningOperation $Client $response $Target $MaxPolls $PollSeconds -ReadResult
    $null = Get-MiningPartMap $body.definition
    return $body.definition
}

function Assert-MiningLivePrerequisites {
    param($Client, $Target, $Tables)
    Assert-MiningClientTarget $Target $Client
    $base = "https://api.fabric.microsoft.com/v1/workspaces/$($Target.WorkspaceId)"
    $response = Invoke-MiningHttp $Client GET "$base/lakehouses/$($Target.StaticLakehouseId)"
    Assert-MiningHttpStatus $response
    $lakehouse = $response.body
    if ($lakehouse.id -ine $Target.StaticLakehouseId -or $lakehouse.workspaceId -ine $Target.WorkspaceId -or
        $lakehouse.type -cne 'Lakehouse' -or $lakehouse.properties.defaultSchema -cne 'dbo' -or
        $lakehouse.displayName -cne $Target.SqlDatabase -or
        $lakehouse.properties.sqlEndpointProperties.id -ine $Target.SqlEndpointId -or
        $lakehouse.properties.sqlEndpointProperties.provisioningStatus -cne 'Success' -or
        $lakehouse.properties.sqlEndpointProperties.connectionString -cne $Target.SqlServer) {
        throw 'Live schema-enabled source Lakehouse/SQL endpoint does not match the reviewed target.'
    }
    $response = Invoke-MiningHttp $Client GET "$base/items/$($Target.OntologyId)"
    Assert-MiningHttpStatus $response
    if ($response.body.id -ine $Target.OntologyId -or $response.body.type -cne 'Ontology') { throw 'Live ontology target mismatch.' }
    # A complete shortcut inventory, not a not-found response, proves local paths are not redirected.
    $response = Invoke-MiningHttp $Client GET "$base/items/$($Target.StaticLakehouseId)/shortcuts"
    Assert-MiningHttpStatus $response
    if (-not $response.body.Contains('value') -or
        ($response.body.Contains('continuationToken') -and $response.body.continuationToken) -or
        ($response.body.Contains('continuationUri') -and $response.body.continuationUri)) {
        throw 'Shortcut inventory is incomplete; no writes permitted.'
    }
    foreach ($shortcut in $response.body.value) {
        $path = "$($shortcut.path)/$($shortcut.name)".TrimEnd('/')
        if ($path -ieq 'Tables/dbo' -or
            @($Tables | Where-Object { $path -ieq "Tables/dbo/$($_.name)" }).Count -gt 0 -or
            $path -imatch '^Files/mining-D01(?:/|$)') {
            throw 'A shortcut overlaps the static table or upload namespace; no writes permitted.'
        }
    }
    $rows = @(& $Client.query @"
SELECT DB_NAME() AS database_name,
 HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS metadata_access,
 HAS_PERMS_BY_NAME('dbo', 'SCHEMA', 'SELECT') AS row_access;
"@)
    if ($rows.Count -ne 1 -or $rows[0].database_name -cne $Target.SqlDatabase -or
        $rows[0].metadata_access -ne 1 -or $rows[0].row_access -ne 1) {
        throw 'SQL verification requires exact database, complete metadata visibility and dbo SELECT; no permission changes attempted.'
    }
}

function Get-MiningTableState {
    param($Client, $Target, $Table, $Request)
    $response = Invoke-MiningHttp $Client GET $Request.metadataUri Storage
    $name = $Table.name
    $presence = @(& $Client.query "SELECT [name] FROM sys.tables WHERE schema_id = SCHEMA_ID('dbo') AND [name] = '$name';")
    if ($response.statusCode -eq 404 -and $presence.Count -eq 0) { return @{ exists = $false } }
    Assert-MiningHttpStatus $response
    if ($presence.Count -ne 1 -or $presence[0].name -cne $name) { throw "Metadata/SQL visibility disagrees for $name; wait for endpoint synchronization and verify." }
    $metadata = $response.body
    $root = "$($Target.StaticLakehouseId)/Tables/dbo/$name"
    $https = "https://onelake.dfs.fabric.microsoft.com/$($Target.WorkspaceId)/$root"
    $abfs = "abfss://$($Target.WorkspaceId)@onelake.dfs.fabric.microsoft.com/$root"
    if ($metadata.name -cne $name -or $metadata.schema_name -cne 'dbo' -or
        $metadata.catalog_name -ine $Target.StaticLakehouseId -or
        $metadata.storage_location.TrimEnd('/') -cnotin @($https, $abfs)) { throw "Not an exact local native table: $name." }
    $expected = @($Table.csv | ConvertFrom-Csv)
    $columns = [string[]]@($expected[0].PSObject.Properties.Name)
    if ($metadata.columns.Count -ne $columns.Count -or
        @($metadata.columns.name | Select-Object -Unique).Count -ne $columns.Count) { throw "Unexpected static columns for $name." }
    foreach ($column in $metadata.columns) {
        if ($column.name -cnotin $columns -or $column.type_name -inotmatch '^(STRING|VARCHAR|NVARCHAR)$') { throw "Unsupported static column for $name." }
    }
    $directory = [uri]::EscapeDataString("$root/_delta_log")
    $log = Invoke-MiningHttp $Client GET "https://onelake.dfs.fabric.microsoft.com/$($Target.WorkspaceId)?resource=filesystem&directory=$directory&recursive=false" Storage
    Assert-MiningHttpStatus $log
    if ($log.headers.Contains('x-ms-continuation') -and $log.headers['x-ms-continuation']) { throw 'Delta log inventory exceeds the supported bound.' }
    if (@($log.body.paths | Where-Object { $_.name -match '\.checkpoint\.' }).Count -gt 0) {
        throw 'Checkpointed tables require a separate reviewed Delta reader; no native definition write permitted.'
    }
    $files = @($log.body.paths | Where-Object { $_.name -cmatch "/_delta_log/\d{20}\.json$" } | Sort-Object name)
    if ($files.Count -eq 0 -or $files.Count -gt 128) { throw 'Complete bounded JSON Delta history is required; checkpoint-only tables need a separate reviewed reader.' }
    $configuration = $null
    for ($i = 0; $i -lt $files.Count; $i++) {
        $expectedPath = "$root/_delta_log/$($i.ToString('D20', [Globalization.CultureInfo]::InvariantCulture)).json"
        if ($files[$i].name -cne $expectedPath) { throw 'Delta history has a gap; current column mapping cannot be proved.' }
        $data = Invoke-MiningHttp $Client GET "https://onelake.dfs.fabric.microsoft.com/$($Target.WorkspaceId)/$expectedPath" Storage -ResponseType Bytes
        Assert-MiningHttpStatus $data
        foreach ($line in [Text.Encoding]::UTF8.GetString([byte[]]$data.body).Split("`n", [StringSplitOptions]::RemoveEmptyEntries)) {
            $action = $line | ConvertFrom-Json -AsHashtable
            if ($action.Contains('metaData')) { $configuration = $action.metaData.configuration }
        }
    }
    if ($null -eq $configuration -or
        ($configuration.Contains('delta.columnMapping.mode') -and $configuration['delta.columnMapping.mode'] -cne 'none')) {
        throw "Column-mapped or unproven Delta source: $name."
    }
    $policies = @(& $Client.query "SELECT sp.object_id FROM sys.security_predicates sp JOIN sys.security_policies p ON p.object_id = sp.object_id WHERE p.is_enabled = 1 AND sp.target_object_id = OBJECT_ID('dbo.$name');")
    if ($policies.Count -ne 0) { throw "Row-level security prevents full static verification: $name." }
    $select = ($columns | ForEach-Object { "[$_]" }) -join ','
    $rows = @(& $Client.query "SELECT TOP ($($Table.rowCount + 1)) $select FROM [dbo].[$name];")
    $normalized = @($rows | ForEach-Object {
        $row = [ordered]@{}
        foreach ($column in $columns) {
            if (-not $_.Contains($column) -or ($null -ne $_[$column] -and $_[$column] -isnot [DBNull] -and $_[$column] -isnot [string])) {
                throw "Non-string or absent static value in $name."
            }
            $row[$column] = if ($null -eq $_[$column] -or $_[$column] -is [DBNull]) { '' } else { $_[$column] }
        }
        $row
    })
    if ($normalized.Count -ne $Table.rowCount) { throw "Static row count mismatch: $name." }
    $keys = if ($columns -ccontains 'id') { @('id') } else { @('source_id', 'target_id') }
    $hash = Get-MiningTextHash (ConvertTo-MiningCsv (Get-MiningSortedRows $normalized -Keys $keys))
    if ($hash -cne $Table.sha256) { throw "Static row content mismatch: $name. Existing tables are never overwritten." }
    @{ exists = $true; rowCount = $normalized.Count; sha256 = $hash; deltaVersionsRead = $files.Count }
}

function Save-MiningApplyReceipt {
    param($Stream, $Receipt)
    $Receipt.updatedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-MiningJson $Receipt) + "`n")
    $Stream.Position = $Stream.Length
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush($true)
}

function Read-MiningApplyReceipt {
    param([string]$Path)
    $text = [IO.File]::ReadAllText($Path)
    if (-not $text.EndsWith("`n", [StringComparison]::Ordinal)) {
        throw 'Prior receipt has an incomplete journal record; reconcile its preserved complete records without retrying.'
    }
    $lines = $text.Split("`n", [StringSplitOptions]::RemoveEmptyEntries)
    if ($lines.Count -eq 0) { throw 'Prior receipt is empty; reconcile without retrying.' }
    $lines[-1] | ConvertFrom-Json -AsHashtable
}

function Invoke-MiningRecordedWrite {
    param($Client, $Method, $Uri, $Audience, $Body, $Headers, $Receipt, $Stream, $Target, $MaxPolls, $PollSeconds)
    $entry = [ordered]@{ method = $Method; uri = $Uri; status = 'SubmittedOutcomeUnknown'; operationLocation = $null }
    $Receipt.operations.Add($entry)
    Save-MiningApplyReceipt $Stream $Receipt
    $response = Invoke-MiningHttp $Client $Method $Uri $Audience $Body $Headers
    $entry.status = "AcknowledgedHttp$($response.statusCode)"
    if ($response.headers.Contains('Location')) { $entry.operationLocation = $response.headers['Location'] }
    Save-MiningApplyReceipt $Stream $Receipt
    if ($Audience -eq 'Storage') {
        $allowed = if ($Method -eq 'PUT') { @(201) } elseif ($Uri.Contains('action=append')) { @(202) } else { @(200) }
        Assert-MiningHttpStatus $response $allowed
    } else {
        $null = Wait-MiningOperation $Client $response $Target $MaxPolls $PollSeconds
    }
    $entry.status = 'Succeeded'
    Save-MiningApplyReceipt $Stream $Receipt
}

function Send-MiningCsv {
    param($Client, $Target, $Table, $Request, $Receipt, $Stream, $MaxPolls, $PollSeconds)
    $root = "https://onelake.dfs.fabric.microsoft.com/$($Target.WorkspaceId)/$($Target.StaticLakehouseId)"
    $uri = "$root/$($Request.body.relativePath)"
    $response = Invoke-MiningHttp $Client GET $uri Storage -ResponseType Bytes
    if ($response.statusCode -eq 200) {
        $bytes = [byte[]]$response.body
        if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant() -cne $Table.sha256) {
            throw 'Existing content-addressed CSV differs; it will not be overwritten.'
        }
        return
    }
    Assert-MiningHttpStatus $response @(404)
    $headers = @{ 'x-ms-version' = '2023-08-03'; 'If-None-Match' = '*' }
    foreach ($directory in @('Files/mining-D01', "Files/mining-D01/$($Table.sha256)")) {
        $head = Invoke-MiningHttp $Client HEAD "$root/$directory" Storage -ResponseType Bytes
        if ($head.statusCode -eq 404) {
            Invoke-MiningRecordedWrite $Client PUT "$root/${directory}?resource=directory" Storage ([byte[]]@()) $headers $Receipt $Stream $Target $MaxPolls $PollSeconds
        } else { Assert-MiningHttpStatus $head }
    }
    Invoke-MiningRecordedWrite $Client PUT "${uri}?resource=file" Storage ([byte[]]@()) $headers $Receipt $Stream $Target $MaxPolls $PollSeconds
    $bytes = [Text.Encoding]::UTF8.GetBytes($Table.csv)
    Invoke-MiningRecordedWrite $Client PATCH "${uri}?action=append&position=0" Storage $bytes @{ 'x-ms-version' = '2023-08-03' } $Receipt $Stream $Target $MaxPolls $PollSeconds
    Invoke-MiningRecordedWrite $Client PATCH "${uri}?action=flush&position=$($bytes.Length)&close=true" Storage ([byte[]]@()) @{ 'x-ms-version' = '2023-08-03' } $Receipt $Stream $Target $MaxPolls $PollSeconds
    $readback = Invoke-MiningHttp $Client GET $uri Storage -ResponseType Bytes
    Assert-MiningHttpStatus $readback
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([byte[]]$readback.body)).ToLowerInvariant() -cne $Table.sha256) {
        throw 'CSV readback does not match reviewed bytes; no table load submitted.'
    }
}

function Invoke-MiningStaticApply {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][hashtable]$PlanInputs,
        [Parameter(Mandatory)][string]$BundleDirectory,
        [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ReviewedPlanSha256,
        [Parameter(Mandatory)][string]$ReceiptPath,
        [ValidateSet('Apply', 'Verify')][string]$Mode = 'Apply',
        [switch]$ApproveStaticWrites, [switch]$AcknowledgeNonAtomicUpdate,
        [string]$ExclusiveWriterWindowId,
        $Client,
        [ValidateRange(1, 60)][int]$MaxPolls = 20,
        [ValidateRange(0, 30)][int]$PollSeconds = 2
    )
    if ($Mode -eq 'Apply' -and (-not $ApproveStaticWrites -or -not $AcknowledgeNonAtomicUpdate -or
        [string]::IsNullOrWhiteSpace($ExclusiveWriterWindowId))) {
        throw 'Explicit static-write approval and non-atomic exclusive-writer window acknowledgment are required.'
    }
    $plan = New-MiningOntologyPlan @PlanInputs
    $planPath = Join-Path $BundleDirectory 'plan.json'
    if ((Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash -ine $ReviewedPlanSha256) { throw 'Reviewed plan byte hash mismatch.' }
    $reviewed = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json -AsHashtable
    if ((ConvertTo-MiningJson $reviewed) -cne (ConvertTo-MiningJson (Get-MiningPlanReceipt $plan))) { throw 'Reviewed bundle differs from authoritative regenerated plan.' }
    $files = @(@{ path = 'definition.json'; sha256 = $reviewed.definitionFileSha256 }) +
        @($plan.tables | ForEach-Object { @{ path = "$($_.name).csv"; sha256 = $_.sha256 } })
    foreach ($file in $files) {
        if ((Get-FileHash -LiteralPath (Join-Path $BundleDirectory $file.path) -Algorithm SHA256).Hash -ine $file.sha256) { throw 'Reviewed bundle content drift.' }
    }
    $prior = $null
    if (Test-Path -LiteralPath $ReceiptPath) {
        if ($Mode -eq 'Verify') { throw 'Use a new receipt path for read-only reconciliation evidence.' }
        $prior = Read-MiningApplyReceipt $ReceiptPath
        if ($prior.reviewedPlanSha256 -ine $ReviewedPlanSha256 -or $prior.targetSha256 -cne $plan.targetSha256) { throw 'Receipt belongs to another reviewed target/plan.' }
        if ($Mode -eq 'Apply' -and $prior.status -cne 'VerifiedStaticDefinition') {
            throw 'Prior apply outcome is unresolved; use read-only Verify and review its receipt. Never resubmit blindly.'
        }
    }
    if ($null -eq $Client) { $Client = New-MiningLiveClient $plan.target }
    Assert-MiningLivePrerequisites $Client $plan.target $plan.tables
    $live = Read-MiningLiveDefinition $Client $plan.target $MaxPolls $PollSeconds
    $preimageHash = Get-MiningDefinitionHash $live
    if ($preimageHash -cne $plan.currentDefinitionSha256 -and $preimageHash -cne $plan.desiredDefinitionSha256) { throw 'Live ontology preimage drift; no writes permitted.' }
    $states = @()
    for ($i = 0; $i -lt $plan.tables.Count; $i++) {
        $states += Get-MiningTableState $Client $plan.target $plan.tables[$i] $plan.loadRequests[$i]
    }
    $complete = @($states | Where-Object { -not $_.exists }).Count -eq 0 -and $preimageHash -ceq $plan.desiredDefinitionSha256
    if ($prior -and -not $complete) { throw 'Prior receipt is not consistent with live state; reconcile without writing.' }
    if ($Mode -eq 'Verify' -and -not $complete) { throw 'Static deployment is incomplete; no writes performed.' }
    $receipt = [ordered]@{
        formatVersion = 1; status = 'Prepared'; reviewedPlanSha256 = $ReviewedPlanSha256.ToLowerInvariant()
        targetSha256 = $plan.targetSha256; target = $plan.target; catalogSha256 = $plan.catalogSha256
        exclusiveWriterWindowId = $ExclusiveWriterWindowId; nonAtomic = $true
        preimageSha256 = $preimageHash; preimage = $live; desiredDefinitionSha256 = $plan.desiredDefinitionSha256
        addedPartPaths = $plan.addedParts
        operations = [Collections.Generic.List[object]]::new(); tables = [Collections.Generic.List[object]]::new()
        staticRowsVerified = $false; definitionVerified = $false; timeSeriesBound = $false; activeInstancesVerified = $false
        rollback = 'No automatic rollback or CAS. Quiesce writers, reconcile each recorded operation, and review restoring this full preimage only after fresh hash/ownership checks. Never drop existing source tables; newly loaded catalog tables and Files/mining-D01 paths remain recorded residuals.'
    }
    if ($prior) { return $prior }
    $stream = [IO.FileStream]::new([IO.Path]::GetFullPath($ReceiptPath), [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        Save-MiningApplyReceipt $stream $receipt
        for ($i = 0; $i -lt $plan.tables.Count; $i++) {
            $table = $plan.tables[$i]
            $request = $plan.loadRequests[$i]
            $tableReceipt = [ordered]@{ name = $table.name; preexisting = $states[$i].exists; sourceFile = $request.body.relativePath; status = 'NotLoaded' }
            $receipt.tables.Add($tableReceipt)
            Save-MiningApplyReceipt $stream $receipt
            if (-not $states[$i].exists) {
                Send-MiningCsv $Client $plan.target $table $request $receipt $stream $MaxPolls $PollSeconds
                $fresh = Get-MiningTableState $Client $plan.target $table $request
                if ($fresh.exists) { throw 'Table appeared during upload; no overwrite submitted.' }
                Invoke-MiningRecordedWrite $Client POST $request.uri Fabric $request.body @{} $receipt $stream $plan.target $MaxPolls $PollSeconds
            }
            $state = Get-MiningTableState $Client $plan.target $table $request
            if (-not $state.exists) { throw 'Loaded table not visible yet; verify after SQL synchronization, do not reload.' }
            $tableReceipt.status = 'RowsVerified'
            $tableReceipt.rowCount = $state.rowCount
            $tableReceipt.sha256 = $state.sha256
            Save-MiningApplyReceipt $stream $receipt
        }
        $receipt.staticRowsVerified = $true
        $fresh = Read-MiningLiveDefinition $Client $plan.target $MaxPolls $PollSeconds
        if ((Get-MiningDefinitionHash $fresh) -cne $preimageHash) { throw 'Ontology changed before submission; static data remains recorded but no definition write submitted.' }
        if (-not $complete) {
            if ($preimageHash -cne $plan.desiredDefinitionSha256) {
                Invoke-MiningRecordedWrite $Client POST "https://api.fabric.microsoft.com/v1/workspaces/$($plan.target.WorkspaceId)/items/$($plan.target.OntologyId)/updateDefinition" Fabric @{ definition = $plan.definition } @{} $receipt $stream $plan.target $MaxPolls $PollSeconds
            }
        }
        $verified = Read-MiningLiveDefinition $Client $plan.target $MaxPolls $PollSeconds
        if ((Get-MiningDefinitionHash $verified) -cne $plan.desiredDefinitionSha256) { throw 'Definition postimage mismatch; reconcile, never resend or restore automatically.' }
        $receipt.definitionVerified = $true
        $receipt.status = 'VerifiedStaticDefinition'
        Save-MiningApplyReceipt $stream $receipt
        return $receipt
    } catch {
        $receipt.status = 'NeedsReconciliation'
        $receipt.error = $_.Exception.Message
        Save-MiningApplyReceipt $stream $receipt
        throw
    } finally { $stream.Dispose() }
}
