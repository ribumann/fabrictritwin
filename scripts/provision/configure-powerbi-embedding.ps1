#Requires -Version 7.0

[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9_.()-]+$')][string]$ResourceGroupName,
    [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]+$')][string]$CockpitAppName,
    [Parameter(Mandatory)][guid]$WorkspaceId,
    [Parameter(Mandatory)][guid]$ReportId,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][guid[]]$AllowedPrincipalIds,
    [guid]$ExpectedSemanticModelId,
    [switch]$ApproveTenantSettings,
    [switch]$TakeOverSemanticModel,
    [ValidateRange(30, 365)][int]$CredentialLifetimeDays = 180
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Tokens = @{}
$script:Changes = [System.Collections.Generic.List[string]]::new()

function Invoke-Az {
    param([string[]]$Arguments)
    $output = & az @Arguments --subscription $SubscriptionId --only-show-errors 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Azure CLI request failed. Sign in to the explicitly selected subscription/tenant and retry.' }
    return ($output -join "`n")
}

function Invoke-Service {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [ValidateSet('GET', 'POST', 'PATCH', 'PUT')][string]$Method = 'GET',
        [object]$Body,
        [hashtable]$Headers = @{},
        [switch]$IgnoreAlreadyExists
    )
    $script:LastRequestWasNoOp = $false
    $parsed = [uri]$Uri
    $resource = switch ($parsed.Host) {
        'management.azure.com' { 'https://management.azure.com/' }
        'graph.microsoft.com' { 'https://graph.microsoft.com/' }
        'api.powerbi.com' { 'https://analysis.windows.net/powerbi/api' }
        'api.fabric.microsoft.com' { 'https://api.fabric.microsoft.com' }
        default { throw 'Refusing an unrecognized API host.' }
    }
    if ($parsed.Scheme -ne 'https') { throw 'API requests require HTTPS.' }
    if (-not $script:Tokens.ContainsKey($resource)) {
        # Azure CLI makes --tenant and --subscription mutually exclusive; account.tenantId
        # was already checked against the required tenant before any API request.
        $token = Invoke-Az @('account', 'get-access-token', '--resource', $resource, '--query', 'accessToken', '-o', 'tsv')
        if ([string]::IsNullOrWhiteSpace($token)) { throw 'API access token acquisition returned no token.' }
        $script:Tokens[$resource] = $token
    }
    $requestHeaders = @{ Authorization = "Bearer $($script:Tokens[$resource])" }
    foreach ($key in $Headers.Keys) { $requestHeaders[$key] = $Headers[$key] }
    $arguments = @{
        Uri = $Uri; Method = $Method; Headers = $requestHeaders
        ContentType = 'application/json'; ErrorAction = 'Stop'
        TimeoutSec = 90; MaximumRedirection = 0; Verbose = $false; Debug = $false
    }
    if ($null -ne $Body) { $arguments.Body = ConvertTo-Json -InputObject $Body -Depth 50 -Compress }
    try {
        return Invoke-RestMethod @arguments
    } catch {
        # Graph's group-membership read can lag its own write path (observed live: a
        # successful add is not reflected by a subsequent /members read even with
        # ConsistencyLevel: eventual + $count=true). Callers that pre-check membership
        # before adding can still race this lag, so allow them to opt into treating the
        # resulting "already exists" conflict as a benign no-op rather than failing.
        $errorMessage = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
        if ($IgnoreAlreadyExists -and $errorMessage -match 'already exist') {
            $script:LastRequestWasNoOp = $true
            return $null
        }
        # PowerShell HTTP exceptions can contain request credentials and response bodies.
        throw "API request failed ($Method $($parsed.Host)$($parsed.AbsolutePath)). Check operator access and service prerequisites; credential details are suppressed."
    }
}

function Read-Collection {
    param([string]$Uri, [hashtable]$Headers = @{})
    $items = @()
    do {
        $page = Invoke-Service -Uri $Uri -Headers $Headers
        $items += @($page.value | Where-Object { $null -ne $_ })
        $Uri = if ($page.PSObject.Properties.Name -contains '@odata.nextLink') { $page.'@odata.nextLink' }
            elseif ($page.PSObject.Properties.Name -contains 'continuationUri') { $page.continuationUri }
            else { $null }
    } while ($Uri)
    return $items
}

function Write-Service {
    param([string]$Uri, [string]$Method, [object]$Body, [string]$Action, [switch]$IgnoreAlreadyExists)
    if ($PSCmdlet.ShouldProcess($Uri, $Action)) {
        $result = Invoke-Service -Uri $Uri -Method $Method -Body $Body -IgnoreAlreadyExists:$IgnoreAlreadyExists
        if (-not $script:LastRequestWasNoOp) { $script:Changes.Add($Action) }
        return $result
    }
    throw 'Configuration was not approved; no dependent operations will be attempted.'
}

function Get-Property {
    param([object]$Value, [string]$Name)
    if ($null -ne $Value -and $Value.PSObject.Properties.Name -contains $Name) { return $Value.$Name }
    return $null
}

function Set-ContainerConfiguration {
    param([hashtable]$Environment, [string]$Secret)
    # Re-read before each merge; never restore a stale image, auth configuration, or environment.
    $current = Invoke-Service -Uri $script:AppUri
    $configuration = $current.properties.configuration | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable
    $template = $current.properties.template | ConvertTo-Json -Depth 50 | ConvertFrom-Json -AsHashtable
    $containers = @($template.containers | Where-Object name -eq 'cockpit')
    if ($containers.Count -ne 1) { throw 'Expected exactly one cockpit container; refusing to update an ambiguous app.' }
    $container = $containers[0]
    $needsUpdate = [bool]$Secret -or @($container.env | Where-Object name -eq 'POWERBI_EMBED_TOKEN').Count -gt 0
    foreach ($name in $Environment.Keys) {
        $existing = @($container.env | Where-Object name -eq $name)
        $field = if ($name -eq 'POWERBI_CLIENT_SECRET') { 'secretRef' } else { 'value' }
        if ($existing.Count -ne 1 -or $existing[0][$field] -cne [string]$Environment[$name]) { $needsUpdate = $true }
    }
    if (-not $needsUpdate) { return }
    $secretList = Invoke-Service -Uri "$script:ArmRoot/listSecrets?api-version=2024-03-01" -Method POST
    $nextEnv = @($container.env | Where-Object { -not $Environment.ContainsKey($_.name) -and $_.name -ne 'POWERBI_EMBED_TOKEN' })
    foreach ($name in $Environment.Keys) {
        $entry = @{ name = $name }
        if ($name -eq 'POWERBI_CLIENT_SECRET') { $entry.secretRef = $Environment[$name] }
        else { $entry.value = [string]$Environment[$name] }
        $nextEnv += $entry
    }
    $container.env = $nextEnv
    $secrets = @($secretList.value | Where-Object name -ne 'powerbi-embed-token' | ForEach-Object {
        $entry = @{ name = $_.name }
        if (Get-Property $_ 'keyVaultUrl') {
            $entry.keyVaultUrl = $_.keyVaultUrl
            $entry.identity = $_.identity
        } else {
            $value = Get-Property $_ 'value'
            if ($null -eq $value) { throw 'A native secret value was not returned by listSecrets; refusing to overwrite it.' }
            $entry.value = $value
        }
        $entry
    })
    if ($Secret) {
        $secrets = @($secrets | Where-Object name -ne 'powerbi-client-secret')
        $secrets += @{ name = 'powerbi-client-secret'; value = $Secret }
    }
    $configuration.secrets = $secrets
    # A prior template PATCH (e.g. an auth credential rotation) leaves its explicit
    # revisionSuffix stored on the app; reusing that stale value here would make ARM
    # collide with the revision it already created. Always mint a fresh unique suffix.
    $template.revisionSuffix = "pbi-$([guid]::NewGuid().ToString('N').Substring(0,10))"
    Write-Service -Uri $script:AppUri -Method PATCH -Body @{
        properties = @{ configuration = $configuration; template = $template }
    } -Action 'Merge Power BI credential/environment into existing cockpit configuration' | Out-Null
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $state = (Invoke-Service -Uri $script:AppUri).properties.provisioningState
        if ($state -eq 'Succeeded') { return }
        if ($state -in @('Failed', 'Canceled')) { throw 'Cockpit configuration update failed.' }
        Start-Sleep -Seconds 5
    }
    throw 'Cockpit configuration update did not complete within five minutes.'
}

$account = Invoke-Az @('account', 'show', '-o', 'json') | ConvertFrom-Json
if ($account.tenantId -ne "$TenantId" -or $account.id -ne "$SubscriptionId") {
    throw 'The selected subscription does not belong to the requested tenant.'
}
$script:ArmRoot = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.App/containerApps/$CockpitAppName"
$script:AppUri = "$script:ArmRoot`?api-version=2024-03-01"
$app = Invoke-Service -Uri $script:AppUri
$auth = Invoke-Service -Uri "$script:ArmRoot/authConfigs/current?api-version=2024-03-01"
if (-not $auth.properties.platform.enabled -or
    $auth.properties.globalValidation.unauthenticatedClientAction -notin @('RedirectToLoginPage', 'Return401') -or
    -not $auth.properties.identityProviders.azureActiveDirectory.enabled -or
    $auth.properties.identityProviders.azureActiveDirectory.registration.openIdIssuer -notlike "https://login.microsoftonline.com/$TenantId/*") {
    throw 'Enforced, tenant-matched Entra EasyAuth is required before embedding can be configured.'
}
$excluded = Get-Property $auth.properties.globalValidation 'excludedPaths'
if (@($excluded | Where-Object {
    $_ -and ('/api/powerbi/embed-config' -like $_ -or '/api/powerbi/embed-config/' -like $_)
}).Count -gt 0) {
    throw 'The Power BI endpoint must not be excluded from EasyAuth.'
}
$pbiBase = "https://api.powerbi.com/v1.0/myorg/groups/$WorkspaceId"
$report = Invoke-Service -Uri "$pbiBase/reports/$ReportId"
if ($report.id -ne "$ReportId" -or $report.reportType -ne 'PowerBIReport') { throw 'The configured report must be a Power BI report in the selected workspace.' }
$datasetId = [guid]$report.datasetId
if ($ExpectedSemanticModelId -and $ExpectedSemanticModelId -ne $datasetId) { throw 'Report datasetId does not match ExpectedSemanticModelId.' }
$dataset = Invoke-Service -Uri "$pbiBase/datasets/$datasetId"
if ($dataset.id -ne "$datasetId" -or $dataset.isEffectiveIdentityRequired -ne $false -or
    $dataset.isEffectiveIdentityRolesRequired -ne $false) { throw 'Only the approved single-athlete model without RLS/effective-identity requirements is supported.' }
$itemConnectionsUri = "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items/$datasetId/connections"
$bindings = @(Read-Collection -Uri $itemConnectionsUri)
if ($bindings.Count -ne 1 -or $bindings[0].connectionDetails.type -ne 'AzureDataLakeStorage') {
    throw 'Expected exactly one Direct Lake AzureDataLakeStorage source; no other connections will be changed.'
}
$sourcePath = $bindings[0].connectionDetails.path
$sourceUri = [uri]$sourcePath
if ($sourceUri.Scheme -ne 'https' -or $sourceUri.Host -ne 'onelake.dfs.fabric.microsoft.com' -or
    $sourceUri.AbsolutePath -notmatch "^/$WorkspaceId/[0-9a-fA-F-]{36}/$") {
    throw 'The model must use the exact OneLake source within the selected workspace.'
}
if ($WhatIfPreference) {
    $null = $PSCmdlet.ShouldProcess($CockpitAppName, 'Configure scoped Power BI identity, fixed connection, and automatic token environment')
    return [pscustomobject]@{
        Status = 'Planned'; WorkspaceId = "$WorkspaceId"; ReportId = "$ReportId"; SemanticModelId = "$datasetId"
        CredentialStorage = 'ContainerAppSecret'; Changes = @()
    }
}

$graph = 'https://graph.microsoft.com/v1.0'
$displayName = "$CockpitAppName-powerbi-embedding"
$marker = 'fabrictritwin-powerbi:' + [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($script:ArmRoot.ToLowerInvariant())))
$applications = @(Read-Collection -Uri "$graph/applications?`$filter=displayName eq '$displayName'")
if ($applications.Count -gt 1) { throw 'Duplicate embedding app names; resolve the ambiguity without changing unrelated apps.' }
if ($applications.Count -eq 0) {
    $application = Write-Service -Uri "$graph/applications" -Method POST -Body @{
        displayName = $displayName; signInAudience = 'AzureADMyOrg'; tags = @($marker)
    } -Action 'Create dedicated Power BI application without API permission grants'
} else {
    $application = $applications[0]
    if (@($application.tags) -notcontains $marker) { throw 'Existing app is not owned by this cockpit embedding configuration.' }
}
$clientId = $application.appId
$principals = @(Read-Collection -Uri "$graph/servicePrincipals?`$filter=appId eq '$clientId'")
if ($principals.Count -gt 1) { throw 'Ambiguous embedding service principal.' }
$sp = if ($principals.Count -eq 1) { $principals[0] } else {
    Write-Service -Uri "$graph/servicePrincipals" -Method POST -Body @{ appId = $clientId } -Action 'Create embedding service principal'
}
$groupName = "$displayName-allowed"
$groups = @(Read-Collection -Uri "$graph/groups?`$filter=displayName eq '$groupName'")
if ($groups.Count -gt 1) { throw 'Duplicate embedding security group names.' }
$group = if ($groups.Count -eq 1) {
    if ($groups[0].description -ne $marker -or -not $groups[0].securityEnabled) { throw 'Existing group is not the dedicated embedding security group.' }
    $groups[0]
} else {
    Write-Service -Uri "$graph/groups" -Method POST -Body @{
        displayName = $groupName; description = $marker; securityEnabled = $true
        mailEnabled = $false; mailNickname = "$CockpitAppName-powerbi"
    } -Action 'Create dedicated embedding security group'
}
# Microsoft Graph's plain /members list can silently omit service-principal members
# (returns an empty page) unless an eventually-consistent, advanced query is requested;
# both the ConsistencyLevel header AND $count=true are required together, otherwise the
# idempotency check below false-negatives and re-attempts an already-satisfied add.
$members = @(Read-Collection -Uri "$graph/groups/$($group.id)/members?`$count=true" -Headers @{ ConsistencyLevel = 'eventual' })
if (@($members | Where-Object id -eq $sp.id).Count -eq 0) {
    # Defense in depth against the read/write lag documented above: if the add still
    # races a not-yet-visible prior add, treat Graph's "already exist" conflict as a
    # benign no-op instead of failing the whole run.
    Write-Service -Uri "$graph/groups/$($group.id)/members/`$ref" -Method POST -Body @{
        '@odata.id' = "$graph/directoryObjects/$($sp.id)"
    } -Action 'Add only the embedding service principal to its security group' -IgnoreAlreadyExists | Out-Null
}

if (@($members | Where-Object id -ne $sp.id).Count -gt 0) {
    throw 'The dedicated embedding group contains unexpected members; refusing to expand their access.'
}
$fabric = 'https://api.fabric.microsoft.com/v1'
$tenantPolicy = [System.Collections.Generic.List[object]]::new()
$tenantSettingsRequired = [System.Collections.Generic.List[string]]::new()
foreach ($title in @('Embed content in apps', 'Service principals can call Fabric public APIs')) {
    # Re-read immediately before a possible update; no undocumented ETag scheme is assumed.
    $settings = @(Read-Collection -Uri "$fabric/admin/tenantsettings")
    $matches = @($settings | Where-Object title -eq $title)
    if ($matches.Count -ne 1) { throw "Cannot uniquely resolve tenant setting '$title' from the service metadata." }
    $setting = $matches[0]
    $enabledGroups = @((Get-Property $setting 'enabledSecurityGroups') | Where-Object { $_ })
    $excludedGroups = @((Get-Property $setting 'excludedSecurityGroups') | Where-Object { $_ })
    if ($excludedGroups.Count -gt 0) {
        throw "Tenant setting '$title' has exclusions. An administrator must verify effective group membership; exclusions will not be removed."
    }
    if ($setting.enabled -and $enabledGroups.Count -eq 0) {
        $tenantPolicy.Add(@{ Title = $title; Scope = 'ExistingOrganizationPolicyUnchanged' })
        continue
    }
    if ($setting.enabled -and @($enabledGroups | Where-Object graphId -eq $group.id).Count -eq 1) {
        $tenantPolicy.Add(@{ Title = $title; Scope = 'DedicatedGroup' })
        continue
    }
    if (-not $setting.canSpecifySecurityGroups) { throw "Tenant setting '$title' does not support scoped group grants." }
    if (-not $ApproveTenantSettings) {
        $tenantSettingsRequired.Add($title)
        continue
    }
    $updatedGroups = @($enabledGroups | Where-Object graphId -ne $group.id)
    $updatedGroups += @{ graphId = $group.id; name = $groupName }
    # Enabling a disabled setting for previously listed groups would grant unrelated access.
    if (-not $setting.enabled -and $enabledGroups.Count -gt 0) {
        throw "Disabled tenant setting '$title' has existing group policy; explicit administrator reconciliation is required."
    }
    $update = @{ enabled = $true; enabledSecurityGroups = $updatedGroups }
    foreach ($field in @('excludedSecurityGroups', 'delegateToCapacity', 'delegateToDomain', 'delegateToWorkspace', 'properties')) {
        if ($setting.PSObject.Properties.Name -contains $field) { $update[$field] = $setting.$field }
    }
    $settingName = [uri]::EscapeDataString($setting.settingName)
    Write-Service -Uri "$fabric/admin/tenantsettings/$settingName/update" -Method POST -Body $update `
        -Action "Approve '$title' for only the dedicated embedding group (preserving existing policy)" | Out-Null
    $verified = @(Read-Collection -Uri "$fabric/admin/tenantsettings" | Where-Object settingName -eq $setting.settingName)
    if ($verified.Count -ne 1 -or -not $verified[0].enabled -or
        @((Get-Property $verified[0] 'enabledSecurityGroups') | Where-Object graphId -eq $group.id).Count -ne 1) {
        throw "Tenant setting '$title' update was not confirmed; rerun after propagation."
    }
    $tenantPolicy.Add(@{ Title = $title; Scope = 'DedicatedGroup' })
}
if ($tenantSettingsRequired.Count -gt 0) {
    return [pscustomobject]@{
        Status = 'TenantSettingsRequired'; RuntimeValidated = $false
        WorkspaceId = "$WorkspaceId"; ReportId = "$ReportId"; SemanticModelId = "$datasetId"
        ClientId = $clientId; ServicePrincipalId = $sp.id; SecurityGroupId = $group.id
        RequiredTenantSettings = $tenantSettingsRequired.ToArray(); TenantPolicy = $tenantPolicy.ToArray()
        Changes = $script:Changes.ToArray()
    }
}

$rolesUri = "$fabric/workspaces/$WorkspaceId/roleAssignments"
$roles = @(Read-Collection -Uri $rolesUri | Where-Object { $_.principal.id -eq $sp.id })
if ($roles.Count -gt 1) { throw 'Ambiguous workspace role assignments for the embedding identity.' }
if ($roles.Count -eq 0) {
    Write-Service -Uri $rolesUri -Method POST -Body @{
        principal = @{ id = $sp.id; type = 'ServicePrincipal' }; role = 'Member'
    } -Action 'Grant embedding service principal Member access to the selected workspace' | Out-Null
} elseif ($roles[0].role -notin @('Member', 'Admin')) {
    Write-Service -Uri "$rolesUri/$($roles[0].id)" -Method PATCH -Body @{ role = 'Member' } `
        -Action 'Set embedding service principal workspace role to Member' | Out-Null
}

# Discover the real connector schema instead of applying the SQL Direct Lake sample to OneLake.
$types = @(Read-Collection -Uri "$fabric/connections/supportedConnectionTypes?showAllCreationMethods=true")
$connector = @($types | Where-Object type -eq 'AzureDataLakeStorage')
if ($connector.Count -ne 1 -or 'ServicePrincipal' -notin $connector[0].supportedCredentialTypes) {
    throw 'The live OneLake connector does not advertise ServicePrincipal credentials.'
}
$methods = @($connector[0].creationMethods | Where-Object {
    $_.name -eq 'AzureDataLakeStorage' -and
    @($_.parameters | Where-Object { $_.name -in @('server', 'path') -and $_.dataType -eq 'Text' }).Count -eq 2 -and
    @($_.parameters | Where-Object { $_.required -and $_.name -notin @('server', 'path') }).Count -eq 0
})
if ($methods.Count -ne 1) { throw 'OneLake connector creation parameters differ from the supported server/path contract.' }
$encryptionTypes = $connector[0].supportedConnectionEncryptionTypes
$connectionEncryption = if ('Encrypted' -in $encryptionTypes) { 'Encrypted' }
    elseif ('NotEncrypted' -in $encryptionTypes) { 'NotEncrypted' }
    else { throw 'Unsupported connector encryption capability.' }
# NotEncrypted is the advertised OneLake connector option, not HTTP: the source URL stays HTTPS.
$sources = @(Read-Collection -Uri "$pbiBase/datasets/$datasetId/datasources")
if ($sources.Count -ne 1 -or $sources[0].datasourceType -ne 'AzureDataLakeStorage' -or
    "https://$($sources[0].connectionDetails.server)$($sources[0].connectionDetails.path)" -cne $sourcePath) {
    throw 'Power BI and Fabric disagree on the exact OneLake source; no connection will be changed.'
}

$app = Invoke-Service -Uri $script:AppUri
$containers = @($app.properties.template.containers | Where-Object name -eq 'cockpit')
if ($containers.Count -ne 1) { throw 'Expected exactly one cockpit container.' }
$envEntries = @($containers[0].env)
$storedClientId = @($envEntries | Where-Object name -eq 'POWERBI_CLIENT_ID' | ForEach-Object value)
$storedKeyId = @($envEntries | Where-Object name -eq 'POWERBI_CREDENTIAL_KEY_ID' | ForEach-Object value)
$passwords = @((Get-Property $application 'passwordCredentials') | Where-Object {
    $_.keyId -in $storedKeyId -and [datetimeoffset]$_.endDateTime -gt [datetimeoffset]::UtcNow.AddDays(14)
})
$secretList = Invoke-Service -Uri "$script:ArmRoot/listSecrets?api-version=2024-03-01" -Method POST
$storedSecret = @($secretList.value | Where-Object name -eq 'powerbi-client-secret')
$rotated = $false
if ($storedClientId.Count -eq 1 -and $storedClientId[0] -eq $clientId -and
    $passwords.Count -eq 1 -and $storedSecret.Count -eq 1 -and (Get-Property $storedSecret[0] 'value')) {
    $clientSecret = $storedSecret[0].value
    $credentialExpiresOn = $passwords[0].endDateTime
    $credentialKeyId = $passwords[0].keyId
} else {
    $password = Write-Service -Uri "$graph/applications/$($application.id)/addPassword" -Method POST -Body @{
        passwordCredential = @{
            displayName = 'fabrictritwin-powerbi'
            endDateTime = [datetimeoffset]::UtcNow.AddDays($CredentialLifetimeDays).ToString('o')
        }
    } -Action 'Create or renew expiring embedding credential'
    $clientSecret = $password.secretText
    $credentialExpiresOn = $password.endDateTime
    $credentialKeyId = $password.keyId
    if (-not $clientSecret) { throw 'Embedding credential creation returned no secret.' }
    Set-ContainerConfiguration -Secret $clientSecret -Environment @{
        POWERBI_CLIENT_ID = $clientId
        POWERBI_CREDENTIAL_KEY_ID = $password.keyId
        POWERBI_CLIENT_SECRET = 'powerbi-client-secret'
    }
    $rotated = $true
}
$credentialDetails = @{
    singleSignOnType = 'None'; connectionEncryption = $connectionEncryption
    credentials = @{
        credentialType = 'ServicePrincipal'; tenantId = "$TenantId"
        servicePrincipalClientId = $clientId; servicePrincipalSecret = $clientSecret
    }
}
$storedConnectionName = @($envEntries | Where-Object name -eq 'POWERBI_CONNECTION_NAME' | ForEach-Object value)
if ($storedConnectionName.Count -gt 1) { throw 'Ambiguous connection creation intent.' }
if ($storedConnectionName.Count -eq 1 -and $storedConnectionName[0]) {
    $connectionName = $storedConnectionName[0]
    if ($connectionName -notmatch "^$CockpitAppName-$datasetId-[0-9a-f]{32}$") {
        throw 'Recorded connection creation intent belongs to a different report model.'
    }
} else {
    # Persist an unguessable, scoped intent before creation. A retry can recover a successful
    # create whose response/ownership write was interrupted, without trusting a generic name.
    $connectionName = "$CockpitAppName-$datasetId-$([guid]::NewGuid().ToString('N'))"
    Set-ContainerConfiguration -Environment @{ POWERBI_CONNECTION_NAME = $connectionName }
}
$connections = @(Read-Collection -Uri "$fabric/connections" | Where-Object displayName -eq $connectionName)
if ($connections.Count -gt 1) { throw 'Duplicate fixed-identity connection names; refusing an ambiguous rebind.' }
$connectionCreated = $connections.Count -eq 0
if ($connectionCreated) {
    $connection = Write-Service -Uri "$fabric/connections" -Method POST -Body @{
        connectivityType = 'ShareableCloud'; displayName = $connectionName; privacyLevel = 'Organizational'
        connectionDetails = @{
            type = 'AzureDataLakeStorage'; creationMethod = $methods[0].name
            parameters = @(
                @{ dataType = 'Text'; name = 'server'; value = $sourceUri.GetLeftPart([UriPartial]::Authority) }
                @{ dataType = 'Text'; name = 'path'; value = $sources[0].connectionDetails.path }
            )
        }
        credentialDetails = $credentialDetails
    } -Action 'Create fixed-identity cloud connection for the exact OneLake source'
} else {
    $connection = Invoke-Service -Uri "$fabric/connections/$($connections[0].id)"
    if ($connection.connectivityType -ne 'ShareableCloud' -or
        $connection.connectionDetails.type -ne 'AzureDataLakeStorage' -or
        $connection.connectionDetails.path -cne $sourcePath) { throw 'Existing connection does not match the exact OneLake source.' }
    $ownedConnectionId = @($envEntries | Where-Object name -eq 'POWERBI_CONNECTION_ID' | ForEach-Object value)
    if ($ownedConnectionId.Count -gt 1 -or ($ownedConnectionId.Count -eq 1 -and
        $ownedConnectionId[0] -and $ownedConnectionId[0] -ne $connection.id)) {
        throw 'Recorded connection ownership conflicts with the scoped creation intent.'
    }
    $connectionKeyId = @($envEntries | Where-Object name -eq 'POWERBI_CONNECTION_CREDENTIAL_KEY_ID' | ForEach-Object value)
    if ($rotated -or $connectionKeyId.Count -ne 1 -or $connectionKeyId[0] -ne $credentialKeyId -or
        $connection.credentialDetails.singleSignOnType -ne 'None' -or
        $connection.credentialDetails.credentialType -ne 'ServicePrincipal') {
        Write-Service -Uri "$fabric/connections/$($connection.id)" -Method PATCH -Body @{
            connectivityType = 'ShareableCloud'; credentialDetails = $credentialDetails
        } -Action 'Renew the dedicated connection credential without changing its source' | Out-Null
    }
}
$connectionId = $connection.id
$createdOrUpdated = Invoke-Service -Uri "$fabric/connections/$connectionId"
if ($createdOrUpdated.connectivityType -ne 'ShareableCloud' -or
    $createdOrUpdated.connectionDetails.type -ne 'AzureDataLakeStorage' -or
    $createdOrUpdated.connectionDetails.path -cne $sourcePath -or
    $createdOrUpdated.credentialDetails.singleSignOnType -ne 'None' -or
    $createdOrUpdated.credentialDetails.credentialType -ne 'ServicePrincipal') {
    throw 'The fixed connection does not match the exact HTTPS OneLake source and service-principal configuration; the model will not be rebound.'
}
# Commit the applied credential version only after Fabric accepted it. ACA credential reuse
# does not prove a previous Fabric update completed, so each retry reconciles both versions.
Set-ContainerConfiguration -Environment @{
    POWERBI_CONNECTION_ID = $connectionId
    POWERBI_CONNECTION_CREDENTIAL_KEY_ID = $credentialKeyId
}
$connectionRolesUri = "$fabric/connections/$connectionId/roleAssignments"
$connectionRoles = @(Read-Collection -Uri $connectionRolesUri | Where-Object { $_.principal.id -eq $sp.id })
if ($connectionRoles.Count -eq 0) {
    Write-Service -Uri $connectionRolesUri -Method POST -Body @{
        principal = @{ id = $sp.id; type = 'ServicePrincipal' }; role = 'User'
    } -Action 'Grant embedding service principal User access to the fixed connection' | Out-Null
}
if ((Get-Property $bindings[0] 'id') -ne $connectionId -or $bindings[0].connectivityType -ne 'ShareableCloud') {
    if ($TakeOverSemanticModel) {
        Write-Service -Uri "$pbiBase/datasets/$datasetId/Default.TakeOver" -Method POST `
            -Action 'Explicitly transfer only the selected model ownership to the provisioning operator' | Out-Null
    }
    Write-Service -Uri "$fabric/workspaces/$WorkspaceId/semanticModels/$datasetId/bindConnection" -Method POST -Body @{
        connectionBinding = @{
            id = $connectionId; connectivityType = 'ShareableCloud'
            connectionDetails = @{ type = 'AzureDataLakeStorage'; path = $sourcePath }
        }
    } -Action 'Bind only the report model exact OneLake source (operator must already own model)' | Out-Null
}
$bound = @(Read-Collection -Uri $itemConnectionsUri)
$confirmed = Invoke-Service -Uri "$fabric/connections/$connectionId"
if ($bound.Count -ne 1 -or $bound[0].id -ne $connectionId -or
    $bound[0].connectionDetails.path -cne $sourcePath -or
    $confirmed.credentialDetails.singleSignOnType -ne 'None' -or
    $confirmed.credentialDetails.credentialType -ne 'ServicePrincipal') {
    throw 'Fixed-identity connection binding was not confirmed.'
}

if (-not $PSCmdlet.ShouldProcess($ReportId, 'Validate V2 scoped embed token issuance using the dedicated identity')) {
    throw 'Runtime token validation was not approved.'
}
try {
    $identityToken = Invoke-RestMethod -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
        -Method POST -ContentType 'application/x-www-form-urlencoded' -Body @{
            grant_type = 'client_credentials'; client_id = $clientId; client_secret = $clientSecret
            scope = 'https://analysis.windows.net/powerbi/api/.default'
        } -TimeoutSec 60 -MaximumRedirection 0 -Verbose:$false -Debug:$false -ErrorAction Stop
    $validationToken = Invoke-RestMethod -Uri 'https://api.powerbi.com/v1.0/myorg/GenerateToken' `
        -Method POST -ContentType 'application/json' -Headers @{ Authorization = "Bearer $($identityToken.access_token)" } `
        -Body (@{
            reports = @(@{ id = "$ReportId"; allowEdit = $false })
            datasets = @(@{ id = "$datasetId" }); lifetimeInMinutes = 10
        } | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 60 -MaximumRedirection 0 -Verbose:$false -Debug:$false -ErrorAction Stop
    if (-not $validationToken.token -or [datetimeoffset]$validationToken.expiration -le [datetimeoffset]::UtcNow.AddMinutes(3)) {
        throw 'Invalid validation token.'
    }
} catch {
    throw 'Dedicated identity V2 token validation failed. Check tenant/workspace propagation and fixed connection permissions; no token details are exposed.'
}
Set-ContainerConfiguration -Environment @{
    POWERBI_TENANT_ID = "$TenantId"; POWERBI_CLIENT_ID = $clientId
    POWERBI_CLIENT_SECRET = 'powerbi-client-secret'; POWERBI_WORKSPACE_ID = "$WorkspaceId"
    POWERBI_REPORT_ID = "$ReportId"; POWERBI_SEMANTIC_MODEL_ID = "$datasetId"
    POWERBI_ALLOWED_PRINCIPAL_IDS = (($AllowedPrincipalIds | ForEach-Object { "$_" } | Sort-Object -Unique) -join ',')
    POWERBI_CONNECTION_ID = $connectionId
}
$clientSecret = $null
$identityToken = $null
$validationToken = $null
return [pscustomobject]@{
    Status = 'Configured'; RuntimeValidated = $true; ReportRenderingValidated = $false
    WorkspaceId = "$WorkspaceId"; ReportId = "$ReportId"; SemanticModelId = "$datasetId"
    ClientId = $clientId; ServicePrincipalId = $sp.id; SecurityGroupId = $group.id
    ConnectionId = $connectionId; CredentialStorage = 'ContainerAppSecret'; CredentialExpiresOn = $credentialExpiresOn
    TenantPolicy = $tenantPolicy.ToArray(); Changes = $script:Changes.ToArray()
}
