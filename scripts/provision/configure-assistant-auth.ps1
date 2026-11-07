#Requires -Version 7.0
<#
.SYNOPSIS
Reconciles delegated cockpit -> backend -> Foundry authentication (no user tokens).
.DESCRIPTION
Requires an explicitly selected subscription/tenant, Graph application, delegated-grant,
user-read and app-role-assignment administration, and ARM Container Apps/Storage deployment
permissions. Tenant policy forces allowSharedKeyAccess=false on every storage account, so the
token-store SAS is signed with a Microsoft Entra user-delegation key (`az storage container
generate-sas --auth-mode login --as-user`) instead of listServiceSas/the account key. Azure
hard-caps a user-delegation-signed SAS to at most 7 days from signing time regardless of the
requested lifetime, so TokenStoreSasLifetimeDays tops out at 7 and reruns must happen well
inside that window to keep the token store usable. It never signs in or changes CLI context.
The one right it grants is Storage Blob Delegator (mint a
user-delegation key only; no blob data access) to the explicit OperatorPrincipalId on the
dedicated token-store account it owns -- it changes no Key Vault/network policies and grants
no Fabric/Foundry roles.

CheckOnly/WhatIf perform reads only (including the read-only ARM listSecrets POST).
All generated passwords and SAS URLs remain in process memory and native ACA secrets.
Do not run under PowerShell tracing/debugging or HTTP body logging.

The dedicated app and storage account carry an ownership marker. Native secrets and the
assistantAuthCredentialKeyId tag bind installed credentials to their Graph key IDs.
Credential-version/expiry env settings deliberately create a revision when secrets rotate.
Only the previously installed owned credential is retired, after the replacement revision
and auth configuration are accepted. Ambiguous failures retain both credentials for safe
recovery on rerun; unmanaged/orphaned credentials are never bulk-deleted.

ConfigurationReady describes control-plane configuration, NOT end-user Fabric permission
or Conditional Access success. Foundation consumes the safe result and grants Foundry User;
actual user sign-in and a native Fabric query remain the release gate.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string[]]$AuthorizedUserObjectIds,
    [Parameter(Mandatory)][guid]$AthleteId,
    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [ValidatePattern('^[a-zA-Z0-9-]+$')][string]$NamePrefix = 'triatwin-dev',
    [string]$CockpitAppName,
    [string]$StreamingBackendAppName,
    [string]$CockpitContainerName = 'cockpit',
    [string]$BackendContainerName = 'streaming-backend',
    [string]$BackendAuthClientId,
    [ValidatePattern('^[a-z0-9]{3,24}$')][string]$TokenStoreStorageAccountName,
    [ValidatePattern('^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$')][string]$TokenStoreContainerName = 'assistant-tokens',
    [string]$OperatorPrincipalId,
    [string]$PublicNetworkPolicyAssignmentId = '',
    [ValidateRange(15,180)][int]$CredentialLifetimeDays = 180,
    # Azure CLI enforces "--expiry should be within 7 days from now" for a user-delegation-key
    # SAS (the only signing mode available once tenant policy forces allowSharedKeyAccess=false);
    # this is a hard platform cap, not a policy choice, so the range/default cannot exceed it.
    [ValidateRange(1,7)][int]$TokenStoreSasLifetimeDays = 7,
    [switch]$RotateCredentials,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$script:command = $PSCmdlet
$script:readOnly = $CheckOnly -or $WhatIfPreference
$script:pending = $false
$script:signInChanged = $false
$script:now = [DateTimeOffset]::UtcNow
$script:renewBefore = $script:now.AddDays(14)
# The token-store SAS tops out at a 7-day platform-enforced lifetime (far shorter than the
# 180-day app-credential default), so it needs its own early-renewal window: renew once less
# than a day of margin remains before the *configured* lifetime elapses, rather than reusing
# the 14-day app-credential window, which would make every freshly signed SAS look "due"
# immediately (its whole lifetime is shorter than that window).
$script:sasRenewBefore = $script:now.AddDays([Math]::Max($TokenStoreSasLifetimeDays - 1, 0))
$script:tokens = @{}
$script:etags = @{}
$graph = 'https://graph.microsoft.com/v1.0'
$arm = 'https://management.azure.com'
$acaApi = '2025-01-01'
$storageApi = '2023-05-01'
if (-not $CockpitAppName) { $CockpitAppName = "$NamePrefix-cockpit" }
if (-not $StreamingBackendAppName) { $StreamingBackendAppName = "$NamePrefix-streaming-backend" }
# Defaults to the sole configured human when unset -- this demo's operator (whoever runs
# this script under an already-signed-in az CLI session) and its one authorized end user
# are typically the same person. Grants only the Storage Blob Delegator role (mint a
# user-delegation key; no blob data access) so the token-store SAS can be signed with an
# Entra credential once tenant policy disables shared-key access on the storage account.
if (-not $OperatorPrincipalId) { $OperatorPrincipalId = $AuthorizedUserObjectIds[0] }
if ($SubscriptionId -eq [guid]::Empty -or $TenantId -eq [guid]::Empty -or $AthleteId -eq [guid]::Empty) {
    throw 'SubscriptionId, TenantId and AthleteId must be nonempty GUIDs.'
}
foreach ($name in @($ResourceGroupName, $CockpitAppName, $StreamingBackendAppName)) {
    if ($name -notmatch '^[a-zA-Z0-9_.()-]+$') { throw 'Resource names contain unsupported characters.' }
}
if ($TokenStoreContainerName -match '--') { throw 'TokenStoreContainerName cannot contain consecutive hyphens.' }
$rgId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName"
$cockpitId = "$rgId/providers/Microsoft.App/containerApps/$CockpitAppName"
$backendId = "$rgId/providers/Microsoft.App/containerApps/$StreamingBackendAppName"
$ownerHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
    [Text.Encoding]::UTF8.GetBytes($cockpitId.ToLowerInvariant()))).Substring(0,20).ToLowerInvariant()
$owner = "triatwin-assistant-auth:$ownerHash"
if (-not $TokenStoreStorageAccountName) { $TokenStoreStorageAccountName = "ast$ownerHash" }
$storageId = "$rgId/providers/Microsoft.Storage/storageAccounts/$TokenStoreStorageAccountName"
$containerId = "$storageId/blobServices/default/containers/$TokenStoreContainerName"
$cockpitUri = "$arm${cockpitId}?api-version=$acaApi"
$backendUri = "$arm${backendId}?api-version=$acaApi"
$cockpitAuthUri = "$arm$cockpitId/authConfigs/current?api-version=$acaApi"
$backendAuthUri = "$arm$backendId/authConfigs/current?api-version=$acaApi"
$storageUri = "$arm${storageId}?api-version=$storageApi"
$containerUri = "$arm${containerId}?api-version=$storageApi"
$credentialName = "$owner-client-secret"
$cockpitSecretName = 'assistant-easyauth-client-secret'
$backendSecretName = 'assistant-obo-client-secret'
$sasSecretName = 'assistant-token-store-sas'

function Copy-Object($Value) {
    if ($null -eq $Value) { return $null }
    return ConvertFrom-Json -AsHashtable -InputObject (ConvertTo-Json -InputObject $Value -Depth 100 -Compress)
}

function Get-CanonicalJson($Value) {
    function Order-Value($Item) {
        if ($Item -is [System.Collections.IDictionary]) {
            $ordered = [ordered]@{}
            foreach ($key in @($Item.Keys | Sort-Object -CaseSensitive)) { $ordered[$key] = Order-Value $Item[$key] }
            return $ordered
        }
        if ($Item -is [array]) { return ,@($Item | ForEach-Object { Order-Value $_ }) }
        return $Item
    }
    return ConvertTo-Json -InputObject (Order-Value $Value) -Depth 100 -Compress
}

function Test-Same($Left, $Right) { return (Get-CanonicalJson $Left) -ceq (Get-CanonicalJson $Right) }

function Read-Expiry($Value) {
    if ($Value -is [DateTimeOffset]) { return $Value.ToUniversalTime() }
    if ($Value -is [DateTime]) { return ([DateTimeOffset]::new($Value)).ToUniversalTime() }
    return [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
}

function Confirm-Change([string]$Target, [string]$Action) {
    $script:pending = $true
    if ($CheckOnly) { return $false }
    return $script:command.ShouldProcess($Target, $Action)
}

function Invoke-Az {
    param([string[]]$Arguments)
    $output = & az @Arguments --only-show-errors 2>&1
    if ($LASTEXITCODE -ne 0) {
        if ($Arguments[0] -eq 'deployment') {
            $diagnostic = $output -join "`n"
            $constraints = @(
                'Microsoft.Storage/storageAccounts/allowSharedKeyAccess'
                'Microsoft.Storage/storageAccounts/publicNetworkAccess'
                'Microsoft.Storage/storageAccounts/networkAcls.defaultAction'
            ) | Where-Object { $diagnostic.Contains($_) }
            $code = if ($diagnostic -match 'RequestDisallowedByPolicy') { 'RequestDisallowedByPolicy' } else { 'DeploymentFailed' }
            # Only allow-listed policy field names leave the process, never raw CLI error text.
            throw "Token-store deployment failed ($code). Reported constrained fields: $($constraints -join ', '). This non-VNet design requires publicNetworkAccess=Enabled and networkAcls.defaultAction=Allow; allowSharedKeyAccess may be true or false since access is signed with a Microsoft Entra user-delegation key, not the account key. Review the assistant-auth deployment policy evaluation; coordinate redesign, never bypass policy. Raw output suppressed."
        }
        if ($Arguments[0] -eq 'storage' -and $Arguments -contains 'generate-sas') {
            throw 'Token store user-delegation SAS signing failed. Verify the operator identity has the Storage Blob Delegator role (or broader) on the token-store account -- see operatorPrincipalId in assistant-auth-token-store.bicep. Raw CLI output was suppressed.'
        }
        throw 'Azure CLI failed. Verify explicit subscription/tenant access and deployment permissions. Raw CLI output was suppressed.'
    }
    return ($output -join "`n")
}

function Invoke-Api {
    param(
        [ValidateSet('GET','POST','PATCH','PUT','DELETE')][string]$Method = 'GET',
        [string]$Uri, $Body, [string]$Action = 'Update assistant authentication',
        [switch]$AllowNotFound, [switch]$ReadSecrets, [string]$ETag
    )
    $parsed = [uri]$Uri
    if ($parsed.Scheme -ne 'https' -or $parsed.Host -notin @('management.azure.com','graph.microsoft.com')) {
        throw 'Refusing to send credentials to an unexpected REST endpoint.'
    }
    if ($ReadSecrets -and ($Method -ne 'POST' -or $Uri -notmatch '/listSecrets\?api-version=')) {
        throw 'Only ARM listSecrets is a read-only POST.'
    }
    if ($Method -ne 'GET' -and -not $ReadSecrets -and -not (Confirm-Change $parsed.AbsolutePath $Action)) {
        return $null
    }
    $headers = @{ Authorization = "Bearer $($script:tokens[$parsed.Host])" }
    if ($ETag) { $headers['If-Match'] = $ETag }
    # Microsoft Graph rejects advanced query filters (e.g. the `any()` lambda operator used
    # against multi-valued properties such as servicePrincipalNames) with HTTP 400
    # Request_UnsupportedQuery unless ConsistencyLevel: eventual is present; harmless to send
    # on every Graph GET, including simple equality filters.
    if ($Method -eq 'GET' -and $parsed.Host -eq 'graph.microsoft.com' -and $Uri -match '\$filter=') {
        $headers['ConsistencyLevel'] = 'eventual'
    }
    $arguments = @{
        Method = $Method; Uri = $Uri; Headers = $headers; ErrorAction = 'Stop'
        Verbose = $false; Debug = $false; ResponseHeadersVariable = 'responseHeaders'
    }
    if ($null -ne $Body) {
        $arguments.Body = ConvertTo-Json -InputObject $Body -Depth 100 -Compress
        $arguments.ContentType = 'application/json'
    } elseif ($Method -in @('POST', 'PUT', 'PATCH')) {
        # ARM action endpoints invoked with no request payload (e.g. listSecrets) still reject a
        # POST that omits Content-Type with HTTP 415 Unsupported Media Type; send an explicit
        # empty JSON object so the server accepts the mutating/action verb with no real body.
        $arguments.Body = '{}'
        $arguments.ContentType = 'application/json'
    }
    try {
        $response = Invoke-RestMethod @arguments
        $result = Copy-Object $response
        if ($responseHeaders -and $responseHeaders['ETag']) {
            $script:etags[$Uri] = [string]@($responseHeaders['ETag'])[0]
        } elseif ($result -and $result.etag) { $script:etags[$Uri] = [string]$result.etag }
        else { $script:etags.Remove($Uri) }
        return $result
    } catch {
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        if ($AllowNotFound -and $status -eq 404) { return $null }
        # Never propagate ErrorDetails, request/response bodies, exception data or inner exceptions.
        $code = 'Unknown'
        try {
            $details = ConvertFrom-Json -AsHashtable -InputObject $_.ErrorDetails.Message
            if ($details.error.code -match '^[a-zA-Z0-9_.-]{1,80}$') { $code = $details.error.code }
        } catch { }
        $hint = if ($parsed.Host -eq 'graph.microsoft.com') {
            'Verify Graph Application.ReadWrite.All, User.Read.All, DelegatedPermissionGrant.ReadWrite.All and AppRoleAssignment.ReadWrite.All with an authorized Entra administrator; do not self-elevate.'
        } else {
            'Verify ARM permissions and policy. Token store requires publicNetworkAccess=Enabled, networkAcls.defaultAction=Allow and a container-scoped HTTPS user-delegation SAS (allowSharedKeyAccess may be true or false). Do not bypass policy or modify Key Vault; coordinate a private-network redesign if blocked.'
        }
        throw "Assistant auth REST $Method failed (HTTP $status, code $code). $hint Existing credentials are retained; rerun after resolving the constraint."
    }
}

function Get-Collection([string]$Uri) {
    $items = @()
    do {
        $page = Invoke-Api -Uri $Uri
        $items += @($page.value)
        $Uri = $page['@odata.nextLink']
    } while ($Uri)
    return ,$items
}

function Find-Single([string]$Collection, [string]$Filter, [switch]$Optional) {
    $items = Get-Collection "$graph/${Collection}?`$filter=$([uri]::EscapeDataString($Filter))"
    if ($items.Count -gt 1) { throw "Ambiguous Graph $Collection discovery; refusing to change any matching object." }
    if ($items.Count -eq 0 -and -not $Optional) { throw "Required Graph $Collection object was not found." }
    if ($items.Count -eq 1) { return $items[0] }
    return $null
}

function Assert-Resource($Resource, [string]$Id) {
    if ($Resource -and $Resource.id -ine $Id) { throw 'ARM returned an unexpected resource identity; refusing mutation.' }
}

function Set-GraphFields([string]$Uri, [hashtable]$Fields, $Expected) {
    $before = Invoke-Api -Uri $Uri
    if ($Expected) {
        foreach ($key in $Fields.Keys) {
            if (-not (Test-Same $before[$key] $Expected[$key])) {
                throw 'Concurrent Graph change detected during permission merge; rerun without concurrent provisioners.'
            }
        }
    }
    $delta = @{}
    foreach ($key in $Fields.Keys) {
        if (-not (Test-Same $before[$key] $Fields[$key])) { $delta[$key] = $Fields[$key] }
    }
    if ($delta.Count -eq 0) { return $before }
    $again = Invoke-Api -Uri $Uri
    if (-not (Test-Same $before $again)) { throw 'Concurrent Graph change detected; rerun without concurrent provisioners.' }
    $null = Invoke-Api -Method PATCH -Uri $Uri -Body $delta -ETag $script:etags[$Uri]
    if ($script:readOnly) { return $before }
    $after = Invoke-Api -Uri $Uri
    foreach ($key in $delta.Keys) {
        if (-not (Test-Same $after[$key] $delta[$key])) { throw 'Graph configuration readback did not match; existing credentials retained.' }
    }
    return $after
}

function Ensure-Permission([string]$ApplicationId, [string]$ResourceAppId, [string]$ScopeId) {
    $uri = "$graph/applications/$ApplicationId"
    $application = Invoke-Api -Uri $uri
    $permissions = @((Copy-Object $application.requiredResourceAccess) | Where-Object { $null -ne $_ })
    $entries = @($permissions | Where-Object { $_.resourceAppId -eq $ResourceAppId })
    if ($entries.Count -gt 1) { throw 'Ambiguous requiredResourceAccess entries; refusing to overwrite permissions.' }
    if ($entries.Count -eq 0) {
        $permissions += @{ resourceAppId = $ResourceAppId; resourceAccess = @(@{ id = $ScopeId; type = 'Scope' }) }
    } elseif (@($entries[0].resourceAccess | Where-Object { $_.id -eq $ScopeId -and $_.type -eq 'Scope' }).Count -eq 0) {
        $entries[0].resourceAccess = @($entries[0].resourceAccess) + @{ id = $ScopeId; type = 'Scope' }
    } else { return }
    $null = Set-GraphFields $uri @{ requiredResourceAccess = $permissions } $application
}

function Ensure-Consent([string]$ClientSpId, [string]$ResourceSpId, [string]$UserId) {
    # Microsoft Graph's oauth2PermissionGrants endpoint only reliably supports a $filter on
    # clientId alone; a compound filter (resourceId/consentType/principalId) fails closed with
    # HTTP 400 Request_UnsupportedQuery. Fetch by clientId and match the rest client-side.
    $candidates = Get-Collection "$graph/oauth2PermissionGrants?`$filter=$([uri]::EscapeDataString("clientId eq '$ClientSpId'"))"
    $matches = @($candidates | Where-Object {
        $_.resourceId -eq $ResourceSpId -and $_.consentType -eq 'Principal' -and $_.principalId -eq $UserId
    })
    if ($matches.Count -gt 1) { throw 'Ambiguous Graph oauth2PermissionGrants discovery; refusing to change any matching object.' }
    $grant = if ($matches.Count -eq 1) { $matches[0] } else { $null }
    if (-not $grant) {
        $null = Invoke-Api -Method POST -Uri "$graph/oauth2PermissionGrants" -Body @{
            clientId = $ClientSpId; resourceId = $ResourceSpId; principalId = $UserId
            consentType = 'Principal'; scope = 'user_impersonation'
        } -Action 'Grant explicit human delegated user_impersonation consent (not tenant-wide)'
    } elseif ('user_impersonation' -notin @($grant.scope -split '\s+')) {
        $scopes = @(@($grant.scope -split '\s+' | Where-Object { $_ }) + 'user_impersonation' | Select-Object -Unique)
        $null = Set-GraphFields "$graph/oauth2PermissionGrants/$($grant.id)" @{ scope = $scopes -join ' ' } $grant
    }
}

function Get-NativeSecrets([string]$Id) {
    $response = Invoke-Api -Method POST -Uri "$arm$Id/listSecrets?api-version=$acaApi" -ReadSecrets
    return ,@($response.value | Where-Object { $null -ne $_ })
}

function Get-Container($App, [string]$Name) {
    $containers = @($App.properties.template.containers | Where-Object { $_.name -eq $Name })
    if ($containers.Count -ne 1) { throw "Expected exactly one application container named '$Name'." }
    return $containers[0]
}

function Merge-HumanMap($Container) {
    $envEntries = @($Container.env | Where-Object { $_.name -eq 'ATHLETE_PRINCIPAL_MAP' })
    if ($envEntries.Count -gt 1 -or ($envEntries.Count -eq 1 -and $envEntries[0].secretRef)) {
        throw 'ATHLETE_PRINCIPAL_MAP must be one explicit nonsecret JSON object.'
    }
    $map = @{}
    if ($envEntries.Count -eq 1 -and $envEntries[0].value) {
        try { $map = ConvertFrom-Json -AsHashtable -InputObject $envEntries[0].value }
        catch { throw 'ATHLETE_PRINCIPAL_MAP is invalid JSON; refusing to replace it.' }
        if ($map -isnot [System.Collections.IDictionary]) { throw 'ATHLETE_PRINCIPAL_MAP must be a JSON object.' }
    }
    foreach ($id in $humanMap.Keys) {
        $equivalentKeys = @($map.Keys | Where-Object {
            $mappedId = [guid]::Empty
            [guid]::TryParse([string]$_, [ref]$mappedId) -and $mappedId.ToString() -eq $id
        })
        foreach ($key in $equivalentKeys) {
            if ($map[$key] -ine $humanMap[$id]) {
                throw "Conflicting athlete mapping for explicitly authorized user $id; refusing to overwrite it."
            }
        }
        foreach ($key in $equivalentKeys) { $null = $map.Remove($key) }
        $map[$id] = $humanMap[$id]
    }
    return Get-CanonicalJson $map
}

function Get-CredentialState($Application, $App, $Secrets, [string]$SecretName) {
    $installedKey = $App.tags.assistantAuthCredentialKeyId
    $matches = @($Application.passwordCredentials | Where-Object { $_.keyId -eq $installedKey -and $_.displayName -eq $credentialName })
    $native = @($Secrets | Where-Object { $_.name -eq $SecretName -and $_.value -and -not $_.keyVaultUrl })
    $expiry = $null
    if ($matches.Count -eq 1) { $expiry = Read-Expiry $matches[0].endDateTime }
    return @{
        KeyId = $installedKey; Expires = $expiry
        Due = $RotateCredentials -or $native.Count -ne 1 -or -not $expiry -or $expiry -lt $script:renewBefore
        PreviousKeyId = if ($matches.Count -eq 1) { $installedKey } else { $null }
        ApplicationId = $Application.id; Value = $null
    }
}

function New-OwnedCredential($State) {
    if (-not $State.Due) { return }
    $expiry = $script:now.AddDays($CredentialLifetimeDays)
    $created = Invoke-Api -Method POST -Uri "$graph/applications/$($State.ApplicationId)/addPassword" -Body @{
        passwordCredential = @{ displayName = $credentialName; endDateTime = $expiry.ToString('o') }
    } -Action 'Create replacement owned credential; retain previous until ACA accepts it'
    if ($created) {
        if (-not $created.secretText -or -not $created.keyId) { throw 'Graph did not return a complete new credential; existing credentials retained.' }
        $State.KeyId = $created.keyId
        $State.Expires = Read-Expiry $created.endDateTime
        $State.Value = $created.secretText
    }
}

function Get-SasState($Secrets) {
    $state = @{ Due = $true; Expires = $null; Value = $null }
    $native = @($Secrets | Where-Object { $_.name -eq $sasSecretName -and $_.value -and -not $_.keyVaultUrl })
    if ($native.Count -ne 1) { return $state }
    try {
        $url = [uri]$native[0].value
        $query = @{}
        foreach ($pair in $url.Query.TrimStart('?').Split('&')) {
            $kv = $pair.Split('=', 2)
            if ($kv.Count -eq 2) {
                if ($query.ContainsKey($kv[0])) { return $state }
                $query[$kv[0]] = [uri]::UnescapeDataString($kv[1])
            }
        }
        if ($url.Scheme -ne 'https' -or $url.Host -ne "$TokenStoreStorageAccountName.blob.core.windows.net" -or
            $url.AbsolutePath -cne "/$TokenStoreContainerName" -or $query.sr -cne 'c' -or
            $query.sp -cne 'rwd' -or $query.spr -cne 'https' -or -not $query.sig -or
            $query.ss -or $query.srt) { return $state }
        $state.Expires = Read-Expiry $query.se
        if ($query.st -and (Read-Expiry $query.st) -gt $script:now) { return $state }
        $state.Due = $RotateCredentials -or $state.Expires -lt $script:sasRenewBefore
    } catch { }
    return $state
}

function Assert-Storage($Account, $Container) {
    if ($Account.tags.assistantAuthOwner -cne $owner) {
        throw 'Token-store account is not owned by this cockpit auth configuration; choose a dedicated account name.'
    }
    $p = $Account.properties
    if ($p.publicNetworkAccess -ne 'Enabled') { throw 'Token store constraint: publicNetworkAccess must be Enabled for non-VNet ACA. Coordinate redesign; do not bypass policy.' }
    if ($p.networkAcls.defaultAction -ne 'Allow') { throw 'Token store constraint: networkAcls.defaultAction must be Allow for non-VNet ACA. Coordinate redesign; do not bypass policy.' }
    if ($p.sasPolicy.expirationAction -eq 'Block' -and $p.sasPolicy.sasExpirationPeriod) {
        $maximum = [TimeSpan]::Parse($p.sasPolicy.sasExpirationPeriod, [Globalization.CultureInfo]::InvariantCulture)
        if ($maximum -lt [TimeSpan]::FromDays($TokenStoreSasLifetimeDays).Add([TimeSpan]::FromMinutes(5))) {
            throw "Token store constraint: sasPolicy.sasExpirationPeriod=$($p.sasPolicy.sasExpirationPeriod) with expirationAction=Block is shorter than the requested SAS validity (including five-minute clock skew). Choose a compliant lifetime or coordinate redesign; do not change policy."
        }
    }
    if ($Account.kind -ne 'StorageV2' -or $p.minimumTlsVersion -ne 'TLS1_2' -or
        $p.supportsHttpsTrafficOnly -ne $true -or $p.allowBlobPublicAccess -ne $false) {
        throw 'Token store must be StorageV2, TLS1_2, HTTPS-only, allowBlobPublicAccess=false. Refusing to modify an existing noncompliant account.'
    }
    if ($Container -and $Container.properties.publicAccess -ne 'None') { throw 'Token store container publicAccess must be None; refusing anonymous storage.' }
}

function Ensure-OperatorDelegatorRole([string]$StorageId, [string]$PrincipalId) {
    # Least-privilege: mints a user-delegation key only (used below to sign the token-store
    # SAS). Grants no read/write/delete access to blob data. Checked by principal+role rather
    # than by assignment name: the Bicep deployment (assistant-auth-token-store.bicep) may
    # already have created an equivalent assignment under its own ARM guid()-derived name on
    # a fresh account, and ARM enforces uniqueness on the (principal, role, scope) triple
    # regardless of assignment name -- a name-only idempotency check would otherwise collide
    # with RoleAssignmentExists (409) on every first-time deployment.
    if (-not $PrincipalId) { return }
    $roleDefinitionId = "/subscriptions/$SubscriptionId/providers/Microsoft.Authorization/roleDefinitions/db58b8e5-c6ad-4a2a-8342-4190687cbf4a"
    $filter = [uri]::EscapeDataString("principalId eq '$PrincipalId'")
    $existing = Invoke-Api -Uri "$arm$StorageId/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&`$filter=$filter"
    if (@($existing.value | Where-Object { $_.properties.roleDefinitionId -ieq $roleDefinitionId }).Count -gt 0) { return }
    $seed = [Security.Cryptography.MD5]::HashData([Text.Encoding]::UTF8.GetBytes("$StorageId|$PrincipalId|$roleDefinitionId"))
    $assignmentName = [Guid]::new($seed)
    $uri = "$arm$StorageId/providers/Microsoft.Authorization/roleAssignments/$assignmentName`?api-version=2022-04-01"
    $null = Invoke-Api -Method PUT -Uri $uri -Body @{
        properties = @{ principalId = $PrincipalId; roleDefinitionId = $roleDefinitionId; principalType = 'User' }
    } -Action 'Grant operator Storage Blob Delegator (mint user-delegation key only; no blob data access) on the token-store account'
}

function Ensure-Storage($Account, $Container, [string]$Location) {
    if ($Account) {
        Assert-Storage $Account $Container
        Ensure-OperatorDelegatorRole $storageId $OperatorPrincipalId
    }
    if ($Account -and $Container) { return }
    $freshAccount = Invoke-Api -Uri $storageUri -AllowNotFound
    $freshContainer = Invoke-Api -Uri $containerUri -AllowNotFound
    if (-not (Test-Same $Account $freshAccount) -or -not (Test-Same $Container $freshContainer)) {
        throw 'Concurrent token-store resource change detected; rerun without concurrent provisioners.'
    }
    if (-not (Confirm-Change $storageId 'Deploy dedicated HTTPS/private-container token store (no policy bypass)')) { return }
    if ($Account) {
        # Do not redeploy account network/properties when only the private container is missing.
        $null = Invoke-Api -Method PUT -Uri $containerUri -Body @{ properties = @{ publicAccess = 'None' } }
    } else {
        $template = Join-Path $PSScriptRoot '..\..\infra\bicep\assistant-auth-token-store.bicep'
        $null = Invoke-Az -Arguments @(
            'deployment','group','create','--subscription',"$SubscriptionId",'--resource-group',$ResourceGroupName,
            '--name',"assistant-auth-$ownerHash",'--template-file',$template,
            '--parameters',"storageAccountName=$TokenStoreStorageAccountName","containerName=$TokenStoreContainerName",
            "owner=$owner","location=$Location","operatorPrincipalId=$OperatorPrincipalId",
            "publicNetworkPolicyAssignmentId=$PublicNetworkPolicyAssignmentId",'--output','none'
        )
    }
    $created = Invoke-Api -Uri $storageUri
    $createdContainer = Invoke-Api -Uri $containerUri
    Assert-Resource $created $storageId
    Assert-Resource $createdContainer $containerId
    Assert-Storage $created $createdContainer
    Ensure-OperatorDelegatorRole $storageId $OperatorPrincipalId
}

function Wait-ContainerApp([string]$Uri) {
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $app = Invoke-Api -Uri $Uri
        $p = $app.properties
        if ($p.provisioningState -in @('Failed','Canceled')) { throw 'Container App revision failed; previous Graph credentials retained. Inspect platform revision events, then rerun.' }
        if ($p.provisioningState -eq 'Succeeded' -and $p.latestRevisionName -and $p.latestReadyRevisionName -eq $p.latestRevisionName) { return $app }
        Start-Sleep -Seconds 5
    }
    throw 'Container App replacement revision was not ready within five minutes; both credentials retained for recovery.'
}

function Set-ContainerApp([string]$Uri, [string]$Id, [string]$ContainerName, [hashtable]$Env, [hashtable]$NewSecrets, $Credential, [switch]$MergeMap) {
    $before = Invoke-Api -Uri $Uri
    Assert-Resource $before $Id
    if ($before.properties.provisioningState -ne 'Succeeded') { throw 'Container App has an in-flight or failed deployment; retry after it is stable.' }
    $secrets = Get-NativeSecrets $Id
    $payload = @{ properties = @{
        configuration = Copy-Object $before.properties.configuration
        template = Copy-Object $before.properties.template
    }; tags = if ($before.tags) { Copy-Object $before.tags } else { @{} } }
    $container = Get-Container @{ properties = $payload.properties } $ContainerName
    if ($MergeMap) { $Env.ATHLETE_PRINCIPAL_MAP = @{ value = Merge-HumanMap $container } }
    if ($Credential.KeyId) {
        $payload.tags.assistantAuthCredentialKeyId = $Credential.KeyId
        $Env.ASSISTANT_AUTH_CREDENTIAL_KEY_ID = @{ value = $Credential.KeyId }
    }
    $existingEnv = @($container.env | Where-Object { $null -ne $_ })
    if (@($existingEnv.name | Group-Object | Where-Object Count -gt 1).Count -gt 0) { throw 'Duplicate environment variable names; refusing destructive merge.' }
    $container.env = @(
        foreach ($entry in $existingEnv) {
            if ($Env.ContainsKey($entry.name)) { @{ name = $entry.name } + $Env[$entry.name] }
            else { $entry }
        }
        foreach ($name in @($Env.Keys | Sort-Object)) {
            if ($name -notin $existingEnv.name) { @{ name = $name } + $Env[$name] }
        }
    )
    # Compare secret-bearing state only in memory. Preserve native values and KV reference identities.
    $allSecrets = @()
    foreach ($secret in @($before.properties.configuration.secrets | Where-Object { $null -ne $_ })) {
        if ($NewSecrets.ContainsKey($secret.name)) { continue }
        if ($secret.keyVaultUrl) { $allSecrets += $secret; continue }
        $found = @($secrets | Where-Object { $_.name -eq $secret.name })
        if ($found.Count -ne 1 -or $null -eq $found[0].value) { throw 'Cannot preserve an existing native ACA secret; verify listSecrets permission.' }
        $allSecrets += @{ name = $secret.name; value = $found[0].value }
    }
    foreach ($name in $NewSecrets.Keys) { $allSecrets += @{ name = $name; value = $NewSecrets[$name] } }
    $payload.properties.configuration.secrets = $allSecrets
    $current = Copy-Object $before
    $current.properties.configuration.secrets = @($allSecrets | ForEach-Object {
        $name = $_.name
        if ($NewSecrets.ContainsKey($name)) {
            $old = @($secrets | Where-Object { $_.name -eq $name })
            if ($old.Count -eq 1) { $old[0] }
        } else { $_ }
    })
    $same = (Test-Same $current.properties.configuration $payload.properties.configuration) -and
        (Test-Same $before.properties.template $payload.properties.template) -and (Test-Same $before.tags $payload.tags)
    if ($same) { return $before }
    if (-not (Test-Same $before.properties.template $payload.properties.template)) {
        # Reusing a rollout's explicit suffix would collide with its existing revision.
        $payload.properties.template.revisionSuffix = "auth-$([guid]::NewGuid().ToString('N').Substring(0,10))"
    }
    $again = Invoke-Api -Uri $Uri
    if (-not (Test-Same $before $again) -or -not (Test-Same $secrets (Get-NativeSecrets $Id))) {
        throw 'Concurrent Container App change detected before PATCH; rerun without concurrent provisioners.'
    }
    $null = Invoke-Api -Method PATCH -Uri $Uri -Body $payload -ETag $script:etags[$Uri] -Action 'Merge native secrets, explicit mapping and assistant env; preserve image, MI, other secrets and configuration'
    if ($script:readOnly) { return $before }
    $after = Wait-ContainerApp $Uri
    $afterSecrets = Get-NativeSecrets $Id
    $actualConfig = Copy-Object $after.properties.configuration
    $actualConfig.secrets = @($allSecrets | ForEach-Object {
        $expected = $_
        $stored = @($afterSecrets | Where-Object { $_.name -eq $expected.name })
        if ($expected.keyVaultUrl) {
            @($after.properties.configuration.secrets | Where-Object { $_.name -eq $expected.name })[0]
        } elseif ($stored.Count -eq 1) { @{ name = $expected.name; value = $stored[0].value } }
    })
    $mismatches = @()
    if (-not (Test-Same $after.properties.template $payload.properties.template)) { $mismatches += 'template' }
    if (-not (Test-Same $actualConfig $payload.properties.configuration)) { $mismatches += 'configuration' }
    if (-not (Test-Same $after.tags $payload.tags)) { $mismatches += 'tags' }
    if (-not (Test-Same $before.identity $after.identity)) { $mismatches += 'identity' }
    if (-not (Test-Same @($after.properties.configuration.secrets.name | Sort-Object) @($allSecrets.name | Sort-Object))) {
        $mismatches += 'secret names'
    }
    if ($mismatches.Count) {
        throw "Unexpected Container App readback mutation ($($mismatches -join ', ')); both Graph credentials retained. Inspect changes before rerun."
    }
    return $after
}

function Set-AuthConfig([string]$Uri, [scriptblock]$Merge) {
    $before = Invoke-Api -Uri $Uri -AllowNotFound
    Assert-Resource $before ([uri]$Uri).AbsolutePath
    $properties = if ($before) { Copy-Object $before.properties } else { @{} }
    & $Merge $properties
    if ($before -and (Test-Same $before.properties $properties)) { return }
    $again = Invoke-Api -Uri $Uri -AllowNotFound
    if (-not (Test-Same $before $again)) { throw 'Concurrent authConfig change detected; rerun without concurrent provisioners.' }
    $null = Invoke-Api -Method PUT -Uri $Uri -Body @{ properties = $properties } -ETag $script:etags[$Uri] -Action 'Merge EasyAuth configuration with delegated login/token store'
    if ($script:readOnly) { return }
    $after = Invoke-Api -Uri $Uri
    if (-not (Test-Same $after.properties $properties)) { throw 'AuthConfig readback did not match; existing credentials retained.' }
    $script:signInChanged = $true
}

function Ensure-Path([System.Collections.IDictionary]$Object, [string[]]$Path) {
    foreach ($part in $Path) {
        if (-not $Object[$part]) { $Object[$part] = @{} }
        $Object = $Object[$part]
    }
    return $Object
}

function Remove-PreviousCredential($State, $App, [string]$Uri, [string]$Id, [string]$SecretName) {
    if (-not $State.Value -or -not $State.PreviousKeyId -or $State.PreviousKeyId -eq $State.KeyId) { return }
    if ($App.properties.configuration.activeRevisionsMode -ne 'Single') {
        Write-Warning 'Previous owned credential retained: multiple-revision traffic may still use it. Drain old revisions before credential cleanup.'
        return
    }
    $fresh = Invoke-Api -Uri $Uri
    $installed = @((Get-NativeSecrets $Id) | Where-Object { $_.name -eq $SecretName })
    if (-not (Test-Same $fresh $App) -or $installed.Count -ne 1 -or $installed[0].value -cne $State.Value) {
        throw 'Concurrent Container App change before credential retirement; both credentials retained. Rerun after deployments stabilize.'
    }
    $application = Invoke-Api -Uri "$graph/applications/$($State.ApplicationId)"
    $old = @($application.passwordCredentials | Where-Object { $_.keyId -eq $State.PreviousKeyId -and $_.displayName -eq $credentialName })
    if ($old.Count -eq 1) {
        $null = Invoke-Api -Method POST -Uri "$graph/applications/$($State.ApplicationId)/removePassword" -Body @{
            keyId = $State.PreviousKeyId
        } -Action 'Retire only previously installed owned credential after replacement acceptance'
    }
}

function New-Result($CockpitClientId, $CockpitCredential, $BackendCredential, $Sas, [bool]$Ready) {
    function Format-Expiry($Date) { if ($Date) { return $Date.ToUniversalTime().ToString('o') }; return $null }
    return [pscustomobject]@{
        SchemaVersion = 1; SubscriptionId = "$SubscriptionId"; TenantId = "$TenantId"; ResourceGroupName = $ResourceGroupName
        BackendAuthClientId = $BackendAuthClientId; CockpitAuthClientId = $CockpitClientId
        CockpitAppName = $CockpitAppName; StreamingBackendAppName = $StreamingBackendAppName
        AuthorizedAthletePrincipalMap = [pscustomobject]$humanMap; FoundryUserPrincipalIds = @($humanMap.Keys | Sort-Object)
        TokenStoreStorageAccountName = $TokenStoreStorageAccountName; TokenStoreContainerName = $TokenStoreContainerName
        SecretReferences = [pscustomobject]@{ CockpitClientSecret = $cockpitSecretName; BackendClientSecret = $backendSecretName; TokenStoreSas = $sasSecretName }
        Expiry = [pscustomobject]@{
            CockpitClientSecretExpiresOn = Format-Expiry $CockpitCredential.Expires
            BackendClientSecretExpiresOn = Format-Expiry $BackendCredential.Expires
            TokenStoreSasExpiresOn = Format-Expiry $Sas.Expires
        }
        ConfigurationReady = $Ready
        UserSignInRequired = -not $Ready -or $script:signInChanged
        NeedsRenewal = [bool]($CockpitCredential.Due -or $BackendCredential.Due -or $Sas.Due)
    }
}

$account = Invoke-Az -Arguments @('account','show','--subscription',"$SubscriptionId",'--output','json') | ConvertFrom-Json -AsHashtable
if ($account.id -ine "$SubscriptionId" -or $account.tenantId -ine "$TenantId") { throw 'Azure CLI subscription/tenant does not match the explicit target; no changes made.' }
foreach ($resource in @('https://graph.microsoft.com','https://management.azure.com/')) {
    $token = Invoke-Az -Arguments @('account','get-access-token','--subscription',"$SubscriptionId",'--resource',$resource,'--output','json') | ConvertFrom-Json -AsHashtable
    if ($token.tenant -ine "$TenantId" -or $token.subscription -ine "$SubscriptionId" -or -not $token.accessToken) {
        throw 'Access token subscription/tenant does not match the explicit target; no changes made.'
    }
    $script:tokens[([uri]$resource).Host] = $token.accessToken
}
$humanMap = @{}
foreach ($id in $AuthorizedUserObjectIds) {
    $parsedId = [guid]::Empty
    if (-not [guid]::TryParse($id, [ref]$parsedId) -or $parsedId -eq [guid]::Empty) { throw 'AuthorizedUserObjectIds must contain only explicit human user GUIDs.' }
    $id = $parsedId.ToString()
    $user = Invoke-Api -Uri "$graph/users/${id}?`$select=id,accountEnabled,userType"
    if ($user.id -ine $id -or $user.accountEnabled -ne $true -or $user.userType -notin @('Member','Guest')) {
        throw "Authorized principal $id must resolve to an enabled Graph human user."
    }
    $humanMap[$id] = "$AthleteId"
}
$cockpit = Invoke-Api -Uri $cockpitUri -AllowNotFound
$backend = Invoke-Api -Uri $backendUri -AllowNotFound
Assert-Resource $cockpit $cockpitId
Assert-Resource $backend $backendId
$backendAuth = Invoke-Api -Uri $backendAuthUri -AllowNotFound
Assert-Resource $backendAuth "$backendId/authConfigs/current"
if (-not $cockpit -or -not $backend -or -not $backendAuth) {
    if (-not $script:readOnly) { throw 'Provision the base cockpit/backend Container Apps and backend EasyAuth before configuring delegated auth.' }
    $null = Confirm-Change $rgId 'After base ACA provisioning: resolve backend audience, create confidential cockpit app, assign explicit users, grant delegated consent, deploy token store and merge native secrets/auth/env'
    return New-Result $null @{ Due = $true } @{ Due = $true } @{ Due = $true } $false
}
$actualClientId = $backendAuth.properties.identityProviders.azureActiveDirectory.registration.clientId
if (-not $actualClientId -or -not [guid]::TryParse($actualClientId, [ref]([guid]::Empty))) { throw 'Backend EasyAuth must expose its actual API client ID.' }
if ($BackendAuthClientId -and $BackendAuthClientId -ine $actualClientId) { throw 'BackendAuthClientId conflicts with the live backend EasyAuth client ID; refusing audience migration.' }
$BackendAuthClientId = $actualClientId
$issuer = $backendAuth.properties.identityProviders.azureActiveDirectory.registration.openIdIssuer
if (-not $issuer -or $issuer.TrimEnd('/') -ine "https://login.microsoftonline.com/$TenantId/v2.0") { throw 'Backend EasyAuth issuer must match the explicitly selected tenant and v2.0 endpoint.' }
$fqdn = $cockpit.properties.configuration.ingress.fqdn
if (-not $fqdn -or $fqdn -notmatch '^[a-zA-Z0-9.-]+\.azurecontainerapps\.io$') { throw 'Cockpit must have a platform HTTPS ingress FQDN for its exact EasyAuth callback.' }
$callback = "https://$fqdn/.auth/login/aad/callback"
$null = Merge-HumanMap (Get-Container $backend $BackendContainerName)
$null = Get-Container $cockpit $CockpitContainerName
$backendApplication = Find-Single 'applications' "appId eq '$BackendAuthClientId'"
$backendSp = Find-Single 'servicePrincipals' "appId eq '$BackendAuthClientId'"
$backendScopes = @($backendApplication.api.oauth2PermissionScopes | Where-Object { $_.value -eq 'user_impersonation' -and $_.isEnabled })
if ($backendScopes.Count -ne 1) { throw 'Existing backend API must expose enabled user_impersonation; do not replace its API registration.' }
$foundrySp = Find-Single 'servicePrincipals' "servicePrincipalNames/any(n:n eq 'https://ai.azure.com')"
$foundryScopes = @($foundrySp.oauth2PermissionScopes | Where-Object { $_.value -eq 'user_impersonation' -and $_.isEnabled })
if ($foundryScopes.Count -ne 1) { throw 'Foundry service principal must expose enabled user_impersonation for https://ai.azure.com.' }
$storage = Invoke-Api -Uri $storageUri -AllowNotFound
$tokenContainer = Invoke-Api -Uri $containerUri -AllowNotFound
Assert-Resource $storage $storageId
Assert-Resource $tokenContainer $containerId
if ($storage) { Assert-Storage $storage $tokenContainer }
$displayName = "$NamePrefix-assistant-easyauth"
$cockpitApplication = Find-Single 'applications' "displayName eq '$displayName'" -Optional
if ($cockpitApplication -and ($owner -notin @($cockpitApplication.tags) -or $cockpitApplication.appId -eq $BackendAuthClientId)) {
    throw 'Dedicated cockpit app discovery matched an unowned/shared application; refusing takeover.'
}
if (-not $cockpitApplication) {
    $cockpitApplication = Invoke-Api -Method POST -Uri "$graph/applications" -Body @{
        displayName = $displayName; signInAudience = 'AzureADMyOrg'; tags = @($owner)
        web = @{ redirectUris = @($callback); implicitGrantSettings = @{ enableIdTokenIssuance = $true; enableAccessTokenIssuance = $false } }
    } -Action 'Create dedicated single-tenant confidential cockpit application'
    if (-not $cockpitApplication) {
        $null = Confirm-Change $cockpitId 'Assign explicit human users; grant cockpit-to-backend and backend-to-Foundry Principal consent; install owned credentials, HTTPS token-store SAS and delegated EasyAuth'
        Ensure-Storage $storage $tokenContainer $cockpit.location
        return New-Result $null @{ Due = $true } @{ Due = $true } @{ Due = $true } $false
    }
}
$cockpitClientId = $cockpitApplication.appId
$web = if ($cockpitApplication.web) { Copy-Object $cockpitApplication.web } else { @{} }
$web.redirectUris = @($callback)
# Secret-backed EasyAuth uses hybrid login and still requires ID-token issuance.
$web.implicitGrantSettings = @{ enableIdTokenIssuance = $true; enableAccessTokenIssuance = $false }
$cockpitApplication = Set-GraphFields "$graph/applications/$($cockpitApplication.id)" @{ signInAudience = 'AzureADMyOrg'; web = $web; isFallbackPublicClient = $false } $cockpitApplication
$cockpitSp = Find-Single 'servicePrincipals' "appId eq '$cockpitClientId'" -Optional
if (-not $cockpitSp) {
    $cockpitSp = Invoke-Api -Method POST -Uri "$graph/servicePrincipals" -Body @{ appId = $cockpitClientId; appRoleAssignmentRequired = $true } -Action 'Create dedicated cockpit enterprise application requiring explicit user assignment'
}
if ($cockpitSp) {
    $null = Set-GraphFields "$graph/servicePrincipals/$($cockpitSp.id)" @{ appRoleAssignmentRequired = $true }
    $assignments = Get-Collection "$graph/servicePrincipals/$($cockpitSp.id)/appRoleAssignedTo"
    foreach ($userId in $humanMap.Keys) {
        if (@($assignments | Where-Object { $_.principalId -eq $userId }).Count -eq 0) {
            $null = Invoke-Api -Method POST -Uri "$graph/servicePrincipals/$($cockpitSp.id)/appRoleAssignedTo" -Body @{
                principalId = $userId; resourceId = $cockpitSp.id; appRoleId = '00000000-0000-0000-0000-000000000000'
            } -Action 'Assign explicitly configured human to cockpit enterprise application'
        }
    }
}
Ensure-Permission $cockpitApplication.id $BackendAuthClientId $backendScopes[0].id
Ensure-Permission $backendApplication.id $foundrySp.appId $foundryScopes[0].id
foreach ($userId in $humanMap.Keys) {
    if ($cockpitSp) { Ensure-Consent $cockpitSp.id $backendSp.id $userId }
    Ensure-Consent $backendSp.id $foundrySp.id $userId
}
Ensure-Storage $storage $tokenContainer $cockpit.location
$cockpitSecrets = Get-NativeSecrets $cockpitId
$backendSecrets = Get-NativeSecrets $backendId
$cockpitCredential = Get-CredentialState $cockpitApplication $cockpit $cockpitSecrets $cockpitSecretName
$backendCredential = Get-CredentialState $backendApplication $backend $backendSecrets $backendSecretName
$sas = Get-SasState $cockpitSecrets
New-OwnedCredential $cockpitCredential
New-OwnedCredential $backendCredential
if ($sas.Due) {
    $expiry = $script:now.AddDays($TokenStoreSasLifetimeDays)
    $start = $script:now.AddMinutes(-5)
    if (Confirm-Change $storageId "Sign $TokenStoreSasLifetimeDays-day-or-shorter container-only read/write/delete HTTPS token-store user-delegation SAS") {
        $sasArguments = @(
            'storage','container','generate-sas','--subscription',"$SubscriptionId",
            '--account-name',$TokenStoreStorageAccountName,
            '--name',$TokenStoreContainerName,'--permissions','rwd','--https-only',
            '--auth-mode','login','--as-user',
            '--start',$start.ToString('yyyy-MM-ddTHH:mm:ssZ'),'--expiry',$expiry.ToString('yyyy-MM-ddTHH:mm:ssZ'),
            '-o','tsv'
        )
        # A Storage Blob Delegator role assignment just created above (Ensure-OperatorDelegatorRole)
        # can take a few minutes to propagate through Azure RBAC; retry rather than fail a
        # first-ever run against a brand-new assignment.
        $sasToken = $null
        for ($attempt = 1; $attempt -le 6; $attempt++) {
            try { $sasToken = Invoke-Az -Arguments $sasArguments; break }
            catch { if ($attempt -ge 6) { throw }; Start-Sleep -Seconds 15 }
        }
        if (-not $sasToken) { throw 'Storage user-delegation SAS signing returned no token.' }
        $sas.Value = "https://$TokenStoreStorageAccountName.blob.core.windows.net/${TokenStoreContainerName}?$($sasToken.Trim().TrimStart('?'))"
        $sas.Expires = $expiry
    }
}
$backendEnv = @{
    ASSISTANT_AUTH_TENANT_ID = @{ value = "$TenantId" }
    ASSISTANT_AUTH_CLIENT_ID = @{ value = $BackendAuthClientId }
    ASSISTANT_AUTH_ALLOWED_CLIENT_ID = @{ value = $cockpitClientId }
    ASSISTANT_AUTH_CLIENT_SECRET = @{ secretRef = $backendSecretName }
}
$cockpitEnv = @{
    ASSISTANT_AUTH_TENANT_ID = @{ value = "$TenantId" }
    ASSISTANT_AUTH_BACKEND_CLIENT_ID = @{ value = $BackendAuthClientId }
}
if ($sas.Expires) { $cockpitEnv.ASSISTANT_AUTH_TOKEN_STORE_EXPIRY_VERSION = @{ value = $sas.Expires.ToUnixTimeSeconds().ToString() } }
$newBackendSecrets = @{}
$newCockpitSecrets = @{}
if ($backendCredential.Value) { $newBackendSecrets[$backendSecretName] = $backendCredential.Value }
if ($cockpitCredential.Value) { $newCockpitSecrets[$cockpitSecretName] = $cockpitCredential.Value }
if ($sas.Value) { $newCockpitSecrets[$sasSecretName] = $sas.Value }
$backend = Set-ContainerApp $backendUri $backendId $BackendContainerName $backendEnv $newBackendSecrets $backendCredential -MergeMap
$cockpit = Set-ContainerApp $cockpitUri $cockpitId $CockpitContainerName $cockpitEnv $newCockpitSecrets $cockpitCredential
Set-AuthConfig $backendAuthUri {
    param($p)
    $policy = Ensure-Path $p @('identityProviders','azureActiveDirectory','validation','defaultAuthorizationPolicy')
    $policy.allowedApplications = @(@($policy.allowedApplications | Where-Object { $_ }) + $cockpitClientId | Select-Object -Unique)
    if ($policy.allowedPrincipals.identities) {
        $policy.allowedPrincipals.identities = @(
            @($policy.allowedPrincipals.identities) + @($humanMap.Keys | Sort-Object) | Select-Object -Unique)
    }
}
Set-AuthConfig $cockpitAuthUri {
    param($p)
    $platform = Ensure-Path $p @('platform')
    $platform.enabled = $true
    $globalValidation = Ensure-Path $p @('globalValidation')
    $globalValidation.unauthenticatedClientAction = 'RedirectToLoginPage'
    $globalValidation.redirectToProvider = 'azureActiveDirectory'
    $aad = Ensure-Path $p @('identityProviders','azureActiveDirectory')
    $aad.enabled = $true
    $registration = Ensure-Path $aad @('registration')
    $registration.clientId = $cockpitClientId
    $registration.openIdIssuer = "https://login.microsoftonline.com/$TenantId/v2.0"
    $registration.clientSecretSettingName = $cockpitSecretName
    $validation = Ensure-Path $aad @('validation')
    $validation.allowedAudiences = @($cockpitClientId, "api://$cockpitClientId")
    if ($validation.defaultAuthorizationPolicy.allowedApplications) {
        $validation.defaultAuthorizationPolicy.allowedApplications = @(
            @($validation.defaultAuthorizationPolicy.allowedApplications) + $cockpitClientId | Select-Object -Unique)
    }
    if ($validation.defaultAuthorizationPolicy.allowedPrincipals.identities) {
        $validation.defaultAuthorizationPolicy.allowedPrincipals.identities = @(
            @($validation.defaultAuthorizationPolicy.allowedPrincipals.identities) + @($humanMap.Keys | Sort-Object) | Select-Object -Unique)
    }
    $login = Ensure-Path $aad @('login')
    $login.loginParameters = @("scope=openid profile email offline_access api://$BackendAuthClientId/user_impersonation")
    $store = Ensure-Path $p @('login','tokenStore')
    $store.enabled = $true
    $blob = Ensure-Path $store @('azureBlobStorage')
    $blob.sasUrlSettingName = $sasSecretName
    $http = Ensure-Path $p @('httpSettings')
    $http.requireHttps = $true
}
if (-not $script:readOnly) {
    Remove-PreviousCredential $backendCredential $backend $backendUri $backendId $backendSecretName
    Remove-PreviousCredential $cockpitCredential $cockpit $cockpitUri $cockpitId $cockpitSecretName
    $cockpitCredential.Due = $false
    $backendCredential.Due = $false
    $sas.Due = $false
}
$ready = if ($script:readOnly) { -not $script:pending } else { $true }
New-Result $cockpitClientId $cockpitCredential $backendCredential $sas $ready
