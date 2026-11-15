#Requires -Version 7.0
<#
.SYNOPSIS
    Read Mining ontology context or request a fixed, bounded Tag consumer check.
.DESCRIPTION
    Uses only the selected delegated Azure CLI identity and the public Fabric
    Ontology MCP endpoint. Does not sign in, register a server, refresh, or write.
    Native tool text is evidence supplied by the service, not a structured SQL trace.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$CallerObjectId,
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$OntologyId,
    [ValidateSet('ListEntities', 'ListRules', 'VerifyTags')][string]$Operation = 'ListEntities',
    [ValidateSet('mining_D01_Equipment', 'mining_D01_Line', 'mining_D01_Module',
        'mining_D01_Plant', 'mining_D01_Stream', 'mining_D01_Tag', IgnoreCase = $false)][string]$EntityName,
    [string]$AzureCliPythonPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
foreach ($id in @($TenantId, $SubscriptionId, $CallerObjectId, $WorkspaceId, $OntologyId)) {
    if ($id -eq [guid]::Empty) { throw 'Nonempty, explicitly selected scope and caller GUIDs are required.' }
}
if ($Operation -eq 'VerifyTags' -and $EntityName) {
    throw 'VerifyTags has a fixed mining_D01_Tag scope; EntityName is not accepted.'
}
$endpoint = "https://api.fabric.microsoft.com/v1/mcp/dataPlane/workspaces/$WorkspaceId/items/$OntologyId/ontologyEndpoint"
$audience = 'https://api.fabric.microsoft.com'

function Invoke-SelectedAzureCli {
    param([string[]]$Arguments)
    try {
        $raw = if ($AzureCliPythonPath) {
            & $AzureCliPythonPath -IBm azure.cli @Arguments 2>$null
        } else {
            & az @Arguments 2>$null
        }
        if ($LASTEXITCODE -ne 0) { throw 'CLI failed.' }
        $value = ($raw -join "`n") | ConvertFrom-Json -AsHashtable
        if ($value -isnot [Collections.IDictionary]) { throw 'Unsupported CLI response.' }
        return $value
    } catch {
        throw 'Selected Azure CLI credential/metadata unavailable. No sign-in, identity fallback or account switch attempted.'
    }
}
$profile = Invoke-SelectedAzureCli -Arguments @('account', 'show', '--output', 'json', '--only-show-errors')
if ($profile.tenantId -ine $TenantId.ToString() -or $profile.id -ine $SubscriptionId.ToString() -or
    $profile.user.type -ine 'user') {
    throw 'Selected Azure CLI tenant/subscription is not the pinned delegated user profile.'
}
$accessToken = $null
$sessionId = $null
try {
    $credential = Invoke-SelectedAzureCli -Arguments @(
        'account', 'get-access-token', '--resource', $audience, '--output', 'json', '--only-show-errors'
    )
    try {
        $accessToken = [string]$credential.accessToken
        $segments = $accessToken.Split('.')
        if ($segments.Count -ne 3) { throw 'Unsupported token.' }
        $payload = $segments[1].Replace('-', '+').Replace('_', '/')
        $payload = $payload.PadRight($payload.Length + ((4 - $payload.Length % 4) % 4), '=')
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload)) |
            ConvertFrom-Json -AsHashtable
        if ($credential.tenant -ine $TenantId.ToString() -or $claims.tid -ine $TenantId.ToString() -or
            $claims.oid -ine $CallerObjectId.ToString() -or $claims.aud.TrimEnd('/') -cne $audience -or
            -not $claims.Contains('scp') -or [string]::IsNullOrWhiteSpace($claims.scp) -or
            ($claims.Contains('idtyp') -and $claims.idtyp -ceq 'app') -or
            [long]$claims.exp -lt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 600) {
            throw 'Pinned delegated token mismatch.'
        }
    } catch {
        throw 'Fabric token tenant, caller, audience, delegated scope or lifetime is invalid. No alternate identity attempted.'
    }
    $credential = $null
    $claims = $null
    $protocolVersion = '2024-11-05'

    function Invoke-OntologyRpc {
        param([string]$Method, [Collections.IDictionary]$Parameters, [int]$Id)
        $headers = @{
            Authorization = "Bearer $accessToken"
            Accept = 'application/json, text/event-stream'
            'MCP-Protocol-Version' = $protocolVersion
        }
        if ($sessionId) { $headers['Mcp-Session-Id'] = $sessionId }
        $message = @{ jsonrpc = '2.0'; method = $Method; params = $Parameters }
        if ($Id -gt 0) { $message.id = $Id }
        try {
            $response = Invoke-WebRequest -Method Post -Uri $endpoint -Headers $headers `
                -Body (ConvertTo-Json -InputObject $message -Depth 20 -Compress) `
                -ContentType 'application/json' -MaximumRedirection 0 -TimeoutSec 120 -SkipHttpErrorCheck
        } catch {
            throw "Ontology MCP transport failed during $Method. No redirect, retry or identity fallback attempted."
        }
        if ($Id -eq 0) {
            if ($response.StatusCode -ne 202 -or -not [string]::IsNullOrWhiteSpace($response.Content)) {
                throw 'Ontology MCP initialized notification was not acknowledged with empty HTTP 202.'
            }
            return
        }
        if ($response.StatusCode -ne 200) {
            throw "Ontology MCP $Method returned HTTP $([int]$response.StatusCode). No retry attempted."
        }
        # Invoke-WebRequest has already buffered the body; this bounds parsing, not receipt.
        if ([Text.Encoding]::UTF8.GetByteCount($response.Content) -gt 2097152) {
            throw 'Ontology MCP response exceeded the supported parsing bound.'
        }
        $contentType = [string]($response.Headers['Content-Type'] -join ',')
        try {
            $messages = @()
            if ($contentType -match '^application/json(?:;|$)') {
                $messages = @(ConvertFrom-Json -InputObject $response.Content -AsHashtable -NoEnumerate)
            } elseif ($contentType -match '^text/event-stream(?:;|$)') {
                foreach ($event in ($response.Content -replace "`r`n", "`n") -split "`n`n") {
                    $data = @($event -split "`n" | Where-Object { $_ -cmatch '^data:' } |
                        ForEach-Object { $_.Substring(5).TrimStart(' ') })
                    if ($data.Count -gt 0) {
                        $messages += ,(ConvertFrom-Json -InputObject ($data -join "`n") -AsHashtable -NoEnumerate)
                    }
                }
            } else { throw 'Unsupported content type.' }
            $matched = @()
            foreach ($reply in $messages) {
                if ($reply -isnot [Collections.IDictionary] -or $reply.jsonrpc -cne '2.0' -or
                    $reply.Contains('method')) { throw 'Unexpected server request, notification or batch.' }
                if (-not $reply.Contains('id') -or ($reply.id -isnot [long] -and $reply.id -isnot [int]) -or
                    $reply.id -ne $Id) { throw 'Response ID mismatch.' }
                $matched += ,$reply
            }
            if ($matched.Count -ne 1) { throw 'Missing or duplicate response.' }
            $rpc = $matched[0]
            if ($rpc.Contains('error')) {
                throw 'JSON-RPC error.'
            }
            if (-not $rpc.Contains('result') -or $rpc.result -isnot [Collections.IDictionary]) {
                throw 'Missing result.'
            }
        } catch {
            throw "Invalid or failed Ontology MCP JSON-RPC response during $Method; service error details withheld."
        }
        if ($Method -ceq 'initialize' -and $response.Headers.ContainsKey('Mcp-Session-Id')) {
            $newSessionId = [string]($response.Headers['Mcp-Session-Id'] -join '')
            if ($newSessionId -cnotmatch '^[\x21-\x7e]{1,512}$') { throw 'Invalid Ontology MCP session header.' }
        } else { $newSessionId = $sessionId }
        @{ result = $rpc.result; sessionId = $newSessionId }
    }

    $initialized = Invoke-OntologyRpc 'initialize' @{
        protocolVersion = $protocolVersion
        capabilities = @{}
        clientInfo = @{ name = 'mining-ontology-readonly'; version = '1.0' }
    } 1
    if ($initialized.result.protocolVersion -cnotin @('2024-11-05', '2025-03-26') -or
        -not $initialized.result.Contains('capabilities') -or
        -not $initialized.result.capabilities.Contains('tools')) {
        throw 'Ontology MCP did not negotiate the supported protocol and tools capability.'
    }
    $protocolVersion = $initialized.result.protocolVersion
    $sessionId = $initialized.sessionId
    Invoke-OntologyRpc 'notifications/initialized' @{} 0
    $discovered = Invoke-OntologyRpc 'tools/list' @{} 2
    if ($discovered.result.Contains('nextCursor') -and $discovered.result.nextCursor) {
        throw 'Ontology MCP tool inventory is incomplete; no tool invoked.'
    }
    $toolName = switch ($Operation) {
        'ListEntities' { 'list_ontology_entities' }
        'ListRules' { 'list_ontology_rules' }
        'VerifyTags' { 'ask_ontology' }
    }
    $tools = @($discovered.result.tools | Where-Object { $_.name -ceq $toolName })
    if ($tools.Count -ne 1 -or $tools[0].inputSchema.type -cne 'object') {
        throw 'Required read-only Ontology MCP tool is missing, duplicated or incompatible.'
    }
    $arguments = @{}
    if ($Operation -eq 'VerifyTags') {
        $arguments.request = @'
Read-only verification of the EXISTING declared SQL binding for mining_D01_Tag.
Do not propose or perform changes, replace sources, override ONT_ALM markers,
or substitute graph, DAX or a manually supplied connection.
Using that declared source, execute only this bounded SELECT and report the
executed SQL, resolved source and returned rows. If unavailable, report the failure:
WITH base AS (
 SELECT COUNT(*) OVER () AS TotalRows, id AS TagKey, unit AS EngineeringUnit,
 ROW_NUMBER() OVER (ORDER BY id) AS rn FROM dbo.mining_D01_Tag
)
SELECT TotalRows, TagKey, EngineeringUnit FROM base WHERE rn <= 3 ORDER BY rn
'@
    } elseif ($EntityName) {
        if ($Operation -eq 'ListEntities') { $arguments.entityName = $EntityName }
        else { $arguments.entityNames = @($EntityName) }
    }
    $schema = $tools[0].inputSchema
    foreach ($key in $arguments.Keys) {
        $expectedType = if ($key -ceq 'entityNames') { 'array' } else { 'string' }
        if (-not $schema.Contains('properties') -or -not $schema.properties.Contains($key) -or
            $schema.properties[$key].type -cne $expectedType -or
            ($expectedType -ceq 'array' -and $schema.properties[$key].items.type -cne 'string')) {
            throw 'Read-only Ontology MCP tool arguments do not match the discovered schema.'
        }
    }
    if ($schema.Contains('required')) {
        foreach ($key in $schema.required) {
            if (-not $arguments.Contains($key)) { throw 'Unprovided required tool argument; no tool invoked.' }
        }
    }
    $called = Invoke-OntologyRpc 'tools/call' @{ name = $toolName; arguments = $arguments } 3
    $result = $called.result
    if ($result.Contains('isError') -and ($result.isError -isnot [bool] -or $result.isError)) {
        throw 'Ontology MCP tool reported an error; no consumer success inferred.'
    }
    if (-not $result.Contains('content') -or $result.content -isnot [array] -or $result.content.Count -eq 0) {
        throw 'Ontology MCP tool returned no content; no consumer success inferred.'
    }
    $text = @(
        foreach ($block in $result.content) {
            if ($block.type -cne 'text' -or $block.text -isnot [string]) {
                throw 'Unsupported Ontology MCP tool content; no consumer success inferred.'
            }
            $value = $block.text.Replace($accessToken, '[REDACTED]')
            if ($sessionId) { $value = $value.Replace($sessionId, '[REDACTED]') }
            $value
        }
    )
    [pscustomobject]@{
        workspaceId = $WorkspaceId.ToString()
        ontologyId = $OntologyId.ToString()
        operation = $Operation
        tool = $toolName
        evidenceKind = 'NativeToolTextNotStructuredExecutionTrace'
        content = $text
        acceptanceVerified = $false
    }
} finally {
    $accessToken = $null
    $sessionId = $null
    $credential = $null
    $claims = $null
    $segments = $null
    $payload = $null
}
