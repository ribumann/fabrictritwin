BeforeAll {
    $script:consumer = Join-Path $PSScriptRoot '..\..\scripts\mining-ontology\Invoke-MiningOntologyMcp.ps1'
    function az { throw 'Tests must mock the selected CLI.' }
    function New-McpToken {
        $claims = @{
            tid = $script:scope.TenantId; oid = $script:scope.CallerObjectId
            aud = 'https://api.fabric.microsoft.com'; scp = 'user_impersonation'
            exp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 3600
        }
        switch ($script:tokenFault) {
            'tenant' { $claims.tid = [guid]::NewGuid().ToString() }
            'caller' { $claims.oid = [guid]::NewGuid().ToString() }
            'audience' { $claims.aud = 'https://example.invalid' }
            'expiry' { $claims.exp = 0 }
            'app' { $claims.idtyp = 'app' }
            'noScopes' { $claims.Remove('scp') }
        }
        $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($claims | ConvertTo-Json -Compress))).
            TrimEnd('=').Replace('+', '-').Replace('/', '_')
        "synthetic.$payload.signature"
    }
}

Describe 'Scoped read-only Mining Ontology MCP consumer' {
    BeforeEach {
        $script:scope = @{
            TenantId = '11111111-1111-4111-a111-111111111111'
            SubscriptionId = '22222222-2222-4222-a222-222222222222'
            CallerObjectId = '33333333-3333-4333-a333-333333333333'
            WorkspaceId = '44444444-4444-4444-a444-444444444444'
            OntologyId = '55555555-5555-4555-a555-555555555555'
        }
        $script:profileFault = ''
        $script:tokenFault = ''
        $script:fault = ''
        $script:calls = [Collections.Generic.List[object]]::new()
        $script:cliCalls = [Collections.Generic.List[object]]::new()
        Mock az {
            $script:cliCalls.Add(@($args))
            $global:LASTEXITCODE = 0
            if ($args[1] -eq 'show') {
                @{
                    tenantId = $(if ($script:profileFault -eq 'tenant') { [guid]::NewGuid().ToString() } else { $script:scope.TenantId })
                    id = $(if ($script:profileFault -eq 'subscription') { [guid]::NewGuid().ToString() } else { $script:scope.SubscriptionId })
                    user = @{ type = $(if ($script:profileFault -eq 'app') { 'servicePrincipal' } else { 'user' }) }
                } | ConvertTo-Json -Compress
            } elseif ($args[1] -eq 'get-access-token') {
                if ($script:tokenFault -eq 'denied') {
                    $global:LASTEXITCODE = 1
                    return 'PRIVATE_CLI_FAILURE'
                }
                @{ tenant = $script:scope.TenantId; accessToken = (New-McpToken) } | ConvertTo-Json -Compress
            } else { throw 'Unexpected CLI operation.' }
        }
        Mock Invoke-WebRequest {
            param($Method, $Uri, $Headers, $Body, $MaximumRedirection)
            $request = $Body | ConvertFrom-Json -AsHashtable
            $script:calls.Add(@{
                method = $Method; uri = $Uri; message = $request; redirectLimit = $MaximumRedirection
                session = $Headers['Mcp-Session-Id']; protocol = $Headers['MCP-Protocol-Version']
            })
            if ($script:fault -eq 'network') { throw "PRIVATE_TRANSPORT_FAILURE $($Headers.Authorization)" }
            $httpStatus = switch ($script:fault) {
                'redirect' { 307 }
                'unauthorized' { 401 }
                default { 200 }
            }
            $responseHeaders = @{ 'Content-Type' = @('application/json') }
            switch ($request.method) {
                'initialize' {
                    if ($script:fault -ne 'stateless') {
                        $responseHeaders['Mcp-Session-Id'] = @('synthetic-session')
                    }
                    $result = @{
                        protocolVersion = $(if ($script:fault -eq 'version') { 'unknown' } else { '2024-11-05' })
                        capabilities = @{ tools = @{} }; serverInfo = @{ name = 'fixture'; version = '1' }
                    }
                    if ($script:fault -eq 'negotiated') { $result.protocolVersion = '2025-03-26' }
                    if ($script:fault -eq 'capability') { $result.capabilities.Remove('tools') }
                    if ($script:fault -eq 'session') { $responseHeaders['Mcp-Session-Id'] = @("bad`r`nsession") }
                }
                'notifications/initialized' {
                    return @{
                        StatusCode = $(if ($script:fault -eq 'notification') { 200 } else { 202 })
                        Headers = $responseHeaders; Content = ''
                    }
                }
                'tools/list' {
                    $result = @{ tools = @(
                        @{ name = 'list_ontology_entities'; inputSchema = @{
                            type = 'object'; properties = @{ entityName = @{ type = 'string' } }
                        } },
                        @{ name = 'list_ontology_rules'; inputSchema = @{
                            type = 'object'; properties = @{ entityNames = @{ type = 'array'; items = @{ type = 'string' } } }
                        } },
                        @{ name = 'ask_ontology'; inputSchema = @{
                            type = 'object'; properties = @{ request = @{ type = 'string' } }; required = @('request')
                        } },
                        @{ name = 'update_ontology'; inputSchema = @{ type = 'object' } }
                    ) }
                    switch ($script:fault) {
                        'pagination' { $result.nextCursor = 'more' }
                        'missingTool' { $result.tools = @() }
                        'duplicateTool' { $result.tools += $result.tools[0] }
                        'schema' { $result.tools[0].inputSchema.properties.entityName.type = 'object' }
                        'required' { $result.tools[0].inputSchema.required = @('unexpected') }
                    }
                }
                'tools/call' {
                    $result = @{ isError = $false; content = @(@{ type = 'text'; text = 'native source/result text' }) }
                    switch ($script:fault) {
                        'toolError' { $result.isError = $true }
                        'errorType' { $result.isError = 'false' }
                        'empty' { $result.content = @() }
                        'image' { $result.content = @(@{ type = 'image'; data = 'unexpected' }) }
                        'tokenEcho' {
                            $result.content[0].text = "$($Headers.Authorization) synthetic-session"
                        }
                        'textFailure' { $result.content[0].text = 'Unable to resolve source; no query executed.' }
                    }
                }
                default { throw 'Unexpected RPC method.' }
            }
            $rpc = @{ jsonrpc = '2.0'; id = $request.id; result = $result }
            switch ($script:fault) {
                'rpcError' { $rpc.Remove('result'); $rpc.error = @{ code = -32603; message = 'PRIVATE_SERVICE_FAILURE' } }
                'id' { $rpc.id = 99 }
                'stringId' { $rpc.id = [string]$request.id }
                'jsonrpc' { $rpc.jsonrpc = '1.0' }
                'serverRequest' { $rpc.method = 'sampling/createMessage' }
            }
            $content = $rpc | ConvertTo-Json -Depth 20 -Compress
            if ($script:fault -eq 'sse') {
                $responseHeaders['Content-Type'] = @('text/event-stream; charset=utf-8')
                $content = ": heartbeat`n`nevent: message`ndata: $content`n`n"
            }
            if ($script:fault -eq 'duplicateResponse') {
                $responseHeaders['Content-Type'] = @('text/event-stream')
                $content = "data: $content`n`ndata: $content`n`n"
            }
            if ($script:fault -eq 'malformed') { $content = '{invalid' }
            if ($script:fault -eq 'oversized') { $content = [string]::new([char]0x00a3, 1048577) }
            if ($script:fault -eq 'contentType') { $responseHeaders['Content-Type'] = @('text/html') }
            @{ StatusCode = $httpStatus; Headers = $responseHeaders; Content = $content }
        }
    }

    It 'initializes, discovers and lists fully qualified entities on one pinned endpoint' {
        $value = . $script:consumer @script:scope -EntityName mining_D01_Tag
        $script:calls.message.method | Should -Be @('initialize', 'notifications/initialized', 'tools/list', 'tools/call')
        $script:calls[0].message.params.protocolVersion | Should -BeExactly '2024-11-05'
        $script:calls[1].message.Contains('id') | Should -BeFalse
        @($script:calls | Select-Object -ExpandProperty uri -Unique) | Should -Be @(
            "https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/$($script:scope.WorkspaceId)/items/$($script:scope.OntologyId)/ontologyEndpoint"
        )
        @($script:calls | Where-Object redirectLimit -NE 0).Count | Should -Be 0
        foreach ($call in $script:calls | Select-Object -Skip 1) { $call.session | Should -BeExactly 'synthetic-session' }
        $script:calls[3].message.params.name | Should -BeExactly 'list_ontology_entities'
        $script:calls[3].message.params.arguments.entityName | Should -BeExactly 'mining_D01_Tag'
        $value.content | Should -Be @('native source/result text')
        $value.evidenceKind | Should -BeExactly 'NativeToolTextNotStructuredExecutionTrace'
        $value.acceptanceVerified | Should -BeFalse
        $script:cliCalls.Count | Should -Be 2
        ($script:cliCalls | ForEach-Object { $_ -join ' ' }) -join ';' | Should -Not -Match 'login|account set|--subscription'
    }

    It 'supports SSE without treating comments as data' {
        $script:fault = 'sse'
        (. $script:consumer @script:scope).content | Should -Be @('native source/result text')
    }

    It 'propagates a supported negotiated protocol on subsequent requests' {
        $script:fault = 'negotiated'
        $null = . $script:consumer @script:scope
        foreach ($call in $script:calls | Select-Object -Skip 1) {
            $call.protocol | Should -BeExactly '2025-03-26'
        }
    }

    It 'supports a stateless server without inventing a session header' {
        $script:fault = 'stateless'
        $null = . $script:consumer @script:scope
        foreach ($call in $script:calls) { $call.session | Should -BeNullOrEmpty }
    }

    It 'can list rules with a typed entityNames array but cannot select arbitrary tools' {
        $null = . $script:consumer @script:scope -Operation ListRules -EntityName mining_D01_Module
        $call = $script:calls[-1].message.params
        $call.name | Should -BeExactly 'list_ontology_rules'
        $call.arguments.entityNames | Should -Be @('mining_D01_Module')
        { . $script:consumer @script:scope -Operation update_ontology } | Should -Throw
    }

    It 'uses only a fixed bounded read-only Tag request, never a caller prompt or connection override' {
        $null = . $script:consumer @script:scope -Operation verifytags
        $call = $script:calls[-1].message.params
        $call.name | Should -BeExactly 'ask_ontology'
        $call.arguments.request | Should -Match 'EXISTING declared SQL binding'
        $call.arguments.request | Should -Match 'WHERE rn <= 3'
        $call.arguments.request | Should -Match 'dbo\.mining_D01_Tag'
        $call.arguments.request | Should -Not -Match 'https://|datawarehouse\.fabric'
        { . $script:consumer @script:scope -Operation VerifyTags -EntityName mining_D01_Plant } | Should -Throw '*fixed*'
        { . $script:consumer @script:scope -Request 'make a change' } | Should -Throw
    }

    It 'refuses empty or malformed target GUIDs and unqualified entities before authentication' {
        $bad = $script:scope.Clone()
        $bad.OntologyId = [guid]::Empty
        { . $script:consumer @bad } | Should -Throw '*Nonempty*'
        $bad.OntologyId = 'https://evil.invalid/'
        { . $script:consumer @bad } | Should -Throw
        { . $script:consumer @script:scope -EntityName Tag } | Should -Throw
        { . $script:consumer @script:scope -EntityName MINING_D01_TAG } | Should -Throw
        $script:cliCalls.Count | Should -Be 0
        $script:calls.Count | Should -Be 0
    }

    It 'refuses a selected profile mismatch without signing in or sending HTTP' -ForEach @(
        @{ fault = 'tenant' }, @{ fault = 'subscription' }, @{ fault = 'app' }
    ) {
        $script:profileFault = $fault
        { . $script:consumer @script:scope } | Should -Throw '*pinned delegated user profile*'
        $script:cliCalls.Count | Should -Be 1
        $script:calls.Count | Should -Be 0
    }

    It 'refuses an invalid delegated credential before HTTP' -ForEach @(
        @{ fault = 'tenant' }, @{ fault = 'caller' }, @{ fault = 'audience' },
        @{ fault = 'expiry' }, @{ fault = 'app' }, @{ fault = 'noScopes' }
    ) {
        $script:tokenFault = $fault
        { . $script:consumer @script:scope } | Should -Throw '*token tenant, caller, audience, delegated scope or lifetime*'
        $script:calls.Count | Should -Be 0
    }

    It 'does not echo CLI errors or attempt fallback credentials' {
        $script:tokenFault = 'denied'
        $failure = try { . $script:consumer @script:scope } catch { $_.Exception.Message }
        $failure | Should -Match 'credential/metadata unavailable'
        $failure | Should -Not -Match 'PRIVATE_CLI_FAILURE'
        $script:cliCalls.Count | Should -Be 2
        $script:calls.Count | Should -Be 0
    }

    It 'fails closed on protocol, HTTP and discovery errors' -ForEach @(
        @{ fault = 'redirect' }, @{ fault = 'unauthorized' }, @{ fault = 'network' },
        @{ fault = 'rpcError' }, @{ fault = 'id' }, @{ fault = 'stringId' },
        @{ fault = 'jsonrpc' }, @{ fault = 'serverRequest' }, @{ fault = 'duplicateResponse' },
        @{ fault = 'malformed' },                 @{ fault = 'contentType' }, @{ fault = 'version' }, @{ fault = 'capability' },
        @{ fault = 'oversized' },
        @{ fault = 'session' }, @{ fault = 'notification' }, @{ fault = 'pagination' },
        @{ fault = 'missingTool' }, @{ fault = 'duplicateTool' }, @{ fault = 'schema' },
        @{ fault = 'required' }
    ) {
        $script:fault = $fault
        $failure = try { . $script:consumer @script:scope -EntityName mining_D01_Tag } catch { $_.Exception.Message }
        $failure | Should -BeOfType string
        $failure | Should -Not -Match 'PRIVATE_|synthetic\.|Bearer '
        $script:calls.Count | Should -BeGreaterThan 0
        $expectedCount = switch ($fault) {
            'notification' { 2 }
            { $_ -in @('pagination', 'missingTool', 'duplicateTool', 'schema', 'required') } { 3 }
            default { 1 }
        }
        $script:calls.Count | Should -Be $expectedCount
        @($script:calls | Where-Object { $_.message.method -eq 'tools/call' }).Count | Should -Be 0
    }

    It 'does not treat tool errors or missing/unsupported content as success' -ForEach @(
        @{ fault = 'toolError' }, @{ fault = 'errorType' }, @{ fault = 'empty' }, @{ fault = 'image' }
    ) {
        $script:fault = $fault
        { . $script:consumer @script:scope } | Should -Throw '*no consumer success inferred*'
        @($script:calls | Where-Object { $_.message.method -eq 'tools/call' }).Count | Should -Be 1
    }

    It 'redacts current access and session credentials if a service echoes them' {
        $script:fault = 'tokenEcho'
        $value = . $script:consumer @script:scope
        $value.content[0] | Should -Not -Match 'synthetic\.|synthetic-session'
        $value.content[0] | Should -Match '\[REDACTED\]'
    }

    It 'preserves textual source failure without claiming successful execution or acceptance' {
        $script:fault = 'textFailure'
        $value = . $script:consumer @script:scope -Operation VerifyTags
        $value.content | Should -Be @('Unable to resolve source; no query executed.')
        $value.acceptanceVerified | Should -BeFalse
    }
}
