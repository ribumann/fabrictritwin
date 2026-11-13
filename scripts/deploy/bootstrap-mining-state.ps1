#Requires -Version 7.2
<#
.SYNOPSIS
Plans or creates only a private mining-state container and its exact UAMI role.
.DESCRIPTION
No app writes, SAS, keys, account configuration, queries or runtime activation.
Default and WhatIf are read-only. Apply requires a reviewed digest of fresh state.
Apply also requires an externally coordinated writer-window reference and explicit
non-atomic acknowledgement; these inputs do not establish or verify a remote lock.
PrivatePlanPath is for an operator-controlled private filesystem, never Actions.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][guid]$TenantId,
    [Parameter(Mandatory)][guid]$CallerClientId,
    [Parameter(Mandatory)][guid]$CallerPrincipalId,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_.()-]{0,89}$')][string]$ResourceGroupName,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]{3,24}$')][string]$StorageAccountName,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$')][string]$ContainerName,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$')][string]$BackendAppName,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$')][string]$IdentityName,
    [Parameter(Mandatory)][guid]$IdentityClientId,
    [Parameter(Mandatory)][guid]$IdentityPrincipalId,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceRevision,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$ApprovedDigest,
    [string]$PrivatePlanPath,
    [guid]$PrivateReviewReaderClientId = [guid]::Empty,
    [guid]$PrivateReviewReaderPrincipalId = [guid]::Empty,
    [ValidateLength(0,1024)][string]$ExclusiveWriterWindowId,
    [switch]$AcknowledgeNonAtomicUpdate,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\provision\runtime-arm.ps1"
foreach ($id in @($SubscriptionId, $TenantId, $CallerClientId, $CallerPrincipalId, $IdentityClientId, $IdentityPrincipalId)) {
    if ($id -eq [guid]::Empty) { throw 'Explicit nonempty identity and directory identifiers are required.' }
}
if ($ContainerName.Contains('--')) { throw 'Container name cannot contain consecutive hyphens.' }
if ($PrivatePlanPath -and ($Apply -or $env:GITHUB_ACTIONS -eq 'true')) {
    throw 'Private plans are local preview only; never export raw state in Actions.'
}
if ($Apply -and -not $ApprovedDigest) { throw 'Apply requires a privately reviewed plan digest.' }
if ($ExclusiveWriterWindowId -match '[\x00-\x1f\x7f]') { throw 'Writer-window reference cannot contain control characters.' }
if ($Apply -and -not $WhatIfPreference -and (
    [string]::IsNullOrWhiteSpace($ExclusiveWriterWindowId) -or -not $AcknowledgeNonAtomicUpdate)) {
    throw 'Apply requires an externally recorded exclusive-writer window reference and explicit non-atomic acknowledgement; no lock is inferred.'
}
if ($Apply -and -not $WhatIfPreference -and (
    $env:GITHUB_ACTIONS -cne 'true' -or $env:GITHUB_REPOSITORY -cne 'ribumann/fabrictritwin' -or
    $env:GITHUB_REF -cne 'refs/heads/main' -or $env:GITHUB_SHA -cne $SourceRevision -or
    $env:GITHUB_RUN_ATTEMPT -cne '1' -or
    $env:GITHUB_WORKFLOW_REF -cne 'ribumann/fabrictritwin/.github/workflows/bootstrap-mining-state.yml@refs/heads/main')) {
    throw 'Apply is restricted to the protected main workflow; local use is preview only.'
}
$verifiedCallerClientId = $CallerClientId
$verifiedCallerPrincipalId = $CallerPrincipalId
if ($PrivateReviewReaderClientId -ne [guid]::Empty -or $PrivateReviewReaderPrincipalId -ne [guid]::Empty) {
    if (-not $PrivatePlanPath -or $Apply -or $PrivateReviewReaderClientId -eq [guid]::Empty -or
        $PrivateReviewReaderPrincipalId -eq [guid]::Empty) {
        throw 'A separately selected review reader requires both exact IDs and a local private preview; never apply.'
    }
    $verifiedCallerClientId = $PrivateReviewReaderClientId
    $verifiedCallerPrincipalId = $PrivateReviewReaderPrincipalId
}

$rg = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName"
$storageId = "$rg/providers/Microsoft.Storage/storageAccounts/$StorageAccountName"
$containerId = "$storageId/blobServices/default/containers/$ContainerName"
$appId = "$rg/providers/Microsoft.App/containerApps/$BackendAppName"
$identityId = "$rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$IdentityName"
$roleId = "/subscriptions/$SubscriptionId/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe"
$blobEndpoint = "https://$StorageAccountName.blob.core.windows.net/"

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
    ConvertTo-Json -InputObject (Order-Value $Value) -Depth 100 -Compress
}

function Get-Digest($Value) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes((Get-CanonicalJson $Value)))).ToLowerInvariant()
}

# Stable per exact scope/principal/role, not a random assignment on each invocation.
$assignmentHash = Get-Digest "$($containerId.ToLowerInvariant())|$IdentityPrincipalId|$roleId"
$assignmentName = [guid]::ParseExact($assignmentHash.Substring(0,32), 'N').ToString()
$assignmentId = "$containerId/providers/Microsoft.Authorization/roleAssignments/$assignmentName"
$context = Get-RuntimeArmContext -SubscriptionId $SubscriptionId -TenantId $TenantId
function Assert-CallerToken([string]$Token) {
    try {
        $payload = $Token.Split('.')[1].Replace('-', '+').Replace('_', '/')
        $claims = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload.PadRight(
            $payload.Length + (4 - $payload.Length % 4) % 4, '='))) | ConvertFrom-Json -AsHashtable
    } catch { throw 'Token claims could not be inspected; no operations authorized.' }
    if ($claims.tid -ne "$TenantId" -or $claims.oid -ne "$verifiedCallerPrincipalId" -or
        ($claims.appid -ne "$verifiedCallerClientId" -and $claims.azp -ne "$verifiedCallerClientId") -or
        $claims.idtyp -eq 'user' -or $claims.scp) { throw 'Token is not the explicitly approved deployment caller.' }
}
Assert-CallerToken $context.Headers.Authorization.Substring(7)
$storageToken = Get-RuntimeAccessToken -SubscriptionId $SubscriptionId -TenantId $TenantId -Resource 'https://storage.azure.com/'
Assert-CallerToken $storageToken

function Invoke-Blob([string]$Method) {
    try {
        Invoke-WebRequest -Method $Method -Uri "${blobEndpoint}${ContainerName}?restype=container" -Headers @{
            Authorization = "Bearer $storageToken"; 'x-ms-version' = '2023-11-03'
            'x-ms-date' = [DateTime]::UtcNow.ToString('R'); 'x-ms-client-request-id' = [guid]::NewGuid().ToString()
        } -SkipHttpErrorCheck -Verbose:$false -Debug:$false -ErrorAction Stop
    } catch { throw 'Blob request failed without a response; a write outcome is unknown. Inspect private Azure audit records before retrying.' }
}

function Read-Arm($Id, $Version, [switch]$Optional) {
    try { Invoke-RuntimeArm -Context $context -ResourceId $Id -ApiVersion $Version -AllowNotFound:$Optional }
    catch { throw 'Exact ARM metadata read failed; no permission fallback or speculative grant is allowed.' }
}

function Assert-Role($Role) {
    if ($Role.id -ine "$containerId/providers/Microsoft.Authorization/roleAssignments/$($Role.name)" -or
        $Role.properties.scope -ine $containerId -or $Role.properties.principalId -ine "$IdentityPrincipalId" -or
        $Role.properties.roleDefinitionId -ine $roleId -or $Role.properties.principalType -ne 'ServicePrincipal' -or
        $Role.properties.condition -or $Role.properties.conditionVersion -or $Role.properties.delegatedManagedIdentityResourceId) {
        throw 'Existing role is not the exact unconditional container-scoped UAMI assignment.'
    }
}

function Get-State {
    $account = Read-Arm $storageId '2023-05-01'
    if ($account.id -ine $storageId -or $account.kind -cne 'StorageV2' -or
        $account.properties.provisioningState -cne 'Succeeded' -or
        $account.properties.allowSharedKeyAccess -cne $false -or
        $account.properties.allowBlobPublicAccess -cne $false -or
        $account.properties.primaryEndpoints.blob -cne $blobEndpoint) {
        throw 'Storage target, readiness, private-access policy or public-Azure endpoint mismatch.'
    }
    $app = Read-Arm $appId '2024-03-01'
    $identity = Read-Arm $identityId '2023-01-31'
    $attached = $app.identity.userAssignedIdentities
    if ($app.id -ine $appId -or $app.properties.provisioningState -cne 'Succeeded' -or
        $identity.id -ine $identityId -or $identity.properties.tenantId -ine "$TenantId" -or
        $identity.properties.clientId -ine "$IdentityClientId" -or $identity.properties.principalId -ine "$IdentityPrincipalId" -or
        -not $attached -or -not $attached.ContainsKey($identityId) -or
        $attached[$identityId].clientId -ine "$IdentityClientId" -or $attached[$identityId].principalId -ine "$IdentityPrincipalId") {
        throw 'Backend or explicitly selected attached UAMI validation failed; no principal fallback is allowed.'
    }
    $container = Read-Arm $containerId '2023-05-01' -Optional
    if ($container -and ($container.id -ine $containerId -or $container.properties.publicAccess -cne 'None' -or
        $container.properties.deleted -eq $true)) {
        throw 'Existing container is not the exact live private target; it will never be rewritten.'
    }
    $blob = Invoke-Blob HEAD
    if (($container -and [int]$blob.StatusCode -ne 200) -or
        (-not $container -and ([int]$blob.StatusCode -ne 404 -or
            [string]@($blob.Headers['x-ms-error-code'])[0] -cne 'ContainerNotFound'))) {
        throw 'Blob reachability/authorization or ARM/data-plane state mismatch; no network or permission fallback.'
    }
    $blobState = @{ status = [int]$blob.StatusCode; etag = [string]@($blob.Headers['ETag'])[0] }
    $roles = @()
    $next = $null
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    do {
        try {
            $page = Invoke-RuntimeArm -Context $context -ResourceId "$containerId/providers/Microsoft.Authorization/roleAssignments" `
                -ApiVersion '2022-04-01' -ContinuationUri $next
        } catch { throw 'Exact scoped RBAC inspection failed; stop and review bootstrap permissions.' }
        if ($null -eq $page.value) { throw 'RBAC collection returned no explicit value array.' }
        $roles += @($page.value | Where-Object { $_.properties.scope -ieq $containerId })
        $next = $page.nextLink
        if ($next -and -not $seen.Add($next)) { throw 'Repeated RBAC continuation; inspection is incomplete.' }
    } while ($next)
    $deterministic = Read-Arm $assignmentId '2022-04-01' -Optional
    if ($deterministic) { Assert-Role $deterministic }
    $matching = @($roles | Where-Object {
        $_.properties.principalId -ieq "$IdentityPrincipalId" -and $_.properties.roleDefinitionId -ieq $roleId
    })
    foreach ($role in $matching) { Assert-Role $role }
    if ($deterministic -and @($matching | Where-Object { $_.id -ieq $assignmentId }).Count -ne 1) {
        throw 'RBAC reads disagree; stop rather than assuming an absent assignment.'
    }
    @{
        source = $SourceRevision
        caller = @{ clientId = "$CallerClientId"; principalId = "$CallerPrincipalId"; tenantId = "$TenantId" }
        writeSafety = @{
            exclusiveWriterWindowId = $ExclusiveWriterWindowId
            acknowledgeNonAtomicUpdate = [bool]$AcknowledgeNonAtomicUpdate
            enforcement = 'ExternalOperatorWindowNotRemoteLock'
        }
        account = $account; backend = $app; identity = $identity; container = $container; blob = $blobState
        roles = @($roles | Sort-Object id); deterministicRole = $deterministic
        proposed = @{
            containerId = $containerId; endpoint = $blobEndpoint; publicAccess = 'None'
            principalId = "$IdentityPrincipalId"; roleDefinitionId = $roleId; assignmentId = $assignmentId
            createContainer = -not [bool]$container; createRole = $matching.Count -eq 0
            runtimeOverlay = 'Deferred-NoExactCAS'; runtimeActivation = $false
        }
    }
}

$state = Get-State
$digest = Get-Digest $state
if ($PrivatePlanPath) {
    # CreateNew refuses an existing path; the operator must secure its parent directory.
    $stream = [IO.File]::Open($PrivatePlanPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes((Get-CanonicalJson @{
            digest = $digest; plan = $state
            reviewReader = @{ clientId = "$verifiedCallerClientId"; principalId = "$verifiedCallerPrincipalId" }
        }))
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}
if (-not $Apply -or $WhatIfPreference) {
    return [PSCustomObject]@{ Digest = $digest; Scope = 'PrivateContainerAndContainerRoleOnly'; Status = 'Preview'; Overlay = 'Deferred' }
}
if ($digest -cne $ApprovedDigest) { throw 'Reviewed digest does not match fresh state/source/targets; preview and review again.' }
Write-Information "Mining bootstrap apply reviewed digest: $digest" -InformationAction Continue
if (-not $PSCmdlet.ShouldProcess('privately reviewed mining-state scope', 'Create only missing private container and exact container role')) {
    return [PSCustomObject]@{ Digest = $digest; Status = 'NotApplied' }
}
if ((Get-Digest (Get-State)) -cne $digest) { throw 'State drifted immediately before apply; no write submitted.' }

if ($state.proposed.createContainer) {
    # Blob Create Container is create-only: an existing name fails, never overwrites.
    Write-Information 'Mining bootstrap: container create submitting; outcome not yet verified.' -InformationAction Continue
    $response = Invoke-Blob PUT
    if ([int]$response.StatusCode -ne 201) {
        throw "Container create not confirmed (HTTP $([int]$response.StatusCode)); stop and inspect before a newly reviewed plan. No retry or rollback."
    }
    $afterContainer = Get-State
    if (-not $afterContainer.container) { throw 'Container create was accepted but not verified; stop and inspect. No retry or rollback.' }
    $expected = $state.Clone()
    $expected.container = $afterContainer.container
    $expected.blob = $afterContainer.blob
    $expected.proposed = $state.proposed.Clone()
    $expected.proposed.createContainer = $false
    if ((Get-Digest $expected) -cne (Get-Digest $afterContainer)) {
        throw 'Unexpected drift after container creation; partial outcome, no role write or rollback.'
    }
    $state = $afterContainer
    Write-Information 'Mining bootstrap: private container verified; role not yet applied.' -InformationAction Continue
}
if ($state.proposed.createRole) {
    if ((Get-Digest (Get-State)) -cne (Get-Digest $state)) { throw 'State drift before role write; partial outcome, stop and inspect.' }
    # RBAC PUT is create-or-update, not CAS. The recorded external writer window is required.
    Write-Information 'Mining bootstrap: exact role submitting; outcome not yet verified.' -InformationAction Continue
    try {
        Invoke-RuntimeArm -Context $context -Method PUT -ResourceId $assignmentId -ApiVersion '2022-04-01' -Body @{
            properties = @{ principalId = "$IdentityPrincipalId"; principalType = 'ServicePrincipal'; roleDefinitionId = $roleId }
        } | Out-Null
    } catch { throw 'Role write failed or outcome unknown; inspect the deterministic assignment privately before any retry. No rollback attempted.' }
    $afterRole = Get-State
    if ($afterRole.proposed.createRole -or -not $afterRole.deterministicRole) {
        throw 'Role write was submitted but not verified; stop and inspect. No retry or rollback.'
    }
    $expected = $state.Clone()
    $expected.roles = @($state.roles) + @($afterRole.deterministicRole)
    $expected.roles = @($expected.roles | Sort-Object id)
    $expected.deterministicRole = $afterRole.deterministicRole
    $expected.proposed = $state.proposed.Clone()
    $expected.proposed.createRole = $false
    if ((Get-Digest $expected) -cne (Get-Digest $afterRole)) {
        throw 'Unexpected drift after role write; partial outcome, stop and inspect. No rollback.'
    }
}
[PSCustomObject]@{ Digest = $digest; Scope = 'PrivateContainerAndContainerRoleOnly'; Status = 'BootstrapVerified'; Overlay = 'Deferred' }
