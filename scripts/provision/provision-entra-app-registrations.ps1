#Requires -Version 7.0

[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$AppDisplayNamePrefix = 'triatwin-dev',
    [string]$FabricCapacityAdminUpn = 'admin@example.invalid',
    [string[]]$RedirectUris = @(),
    [string]$TenantId
)

$ErrorActionPreference = 'Stop'

# Microsoft Graph's well-known application ID + the "User.Read" delegated permission ID
# (Sign in and read user profile) -- the minimal Graph permission every interactive Entra
# sign-in needs, matching what the Entra portal adds by default for a new app registration.
$graphResourceAppId = '00000003-0000-0000-c000-000000000000'
$userReadScopeId = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'

# Microsoft's first-party "Azure CLI" public client app ID (well-known, tenant-agnostic --
# https://learn.microsoft.com/en-us/troubleshoot/azure/entra/entra-id/governance/verify-first-party-apps-sign-in#application-ids-of-commonly-used-microsoft-applications).
# Pre-authorized below for the Easy Auth app's own delegated scope so any caller running
# `az account get-access-token` (or get-bearer-token.ps1's device-code flow, which uses this
# same client ID) can acquire a token without an interactive admin-consent prompt.
$azureCliClientId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'

# Fixed GUID for the Easy Auth app's own "user_impersonation" delegated scope. Must stay
# stable across re-runs (Graph treats a changed scope ID as a delete+recreate, which would
# invalidate the preAuthorizedApplications entry that references it below).
$userImpersonationScopeId = '53d326ba-123b-4567-a854-6205d5ea8896'

function Assert-GraphModule {
    param([string]$ModuleName)
    if (-not (Get-Module -ListAvailable -Name $ModuleName)) {
        Write-Host "Installing missing module '$ModuleName' (CurrentUser scope)..."
        Install-Module -Name $ModuleName -Scope CurrentUser -Force -AllowClobber
    }
    Import-Module -Name $ModuleName -ErrorAction Stop
}

function Connect-GraphIfNeeded {
    param([string]$TenantId)

    $context = Get-MgContext
    if ($context) {
        Write-Host "Already connected to Microsoft Graph as $($context.Account) (tenant $($context.TenantId))."
        return
    }

    # Reuse the already-authenticated `az` CLI session's token rather than starting a fresh
    # Connect-MgGraph interactive/WAM browser sign-in. The default interactive flow requires a
    # native window handle (`InteractiveBrowserCredential authentication failed: A window handle
    # must be configured`), which is unavailable in headless/remote CLI sessions and in GitHub
    # Actions runners -- exactly the environments this script must run in for CI/CD (Principle
    # IV). `az` is already required to be logged in for every other step in this script chain
    # (provision-azure-resources.ps1's Assert-AzureContext), so requesting a Graph-scoped token
    # from that same session works identically for an interactively-logged-in operator and for
    # an OIDC-authenticated CI service principal, with no extra sign-in prompt either way.
    Write-Host 'Connecting to Microsoft Graph by reusing the current az CLI session (no separate interactive sign-in)...'
    $tokenArgs = @('account', 'get-access-token', '--resource', 'https://graph.microsoft.com', '--query', 'accessToken', '-o', 'tsv')
    if ($TenantId) {
        $tokenArgs += @('--tenant', $TenantId)
    }
    $graphToken = ((& az @tokenArgs) -join '').Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($graphToken)) {
        throw "Failed to acquire a Microsoft Graph access token via 'az account get-access-token --resource https://graph.microsoft.com'. Ensure 'az login' (or the CI OIDC login step) has completed, and that the signed-in principal has been granted Graph 'Application.ReadWrite.All' and 'User.Read.All' permissions with admin consent."
    }

    Connect-MgGraph -AccessToken (ConvertTo-SecureString $graphToken -AsPlainText -Force) -NoWelcome | Out-Null
}

function Set-EasyAuthApiConfiguration {
    <#
    .SYNOPSIS
    Ensures the Easy Auth app exposes a delegated scope, pre-authorizes the Azure CLI's
    first-party client for it, and requests v2.0-format access tokens.

    .DESCRIPTION
    Without this, no CLI/script caller can acquire a bearer token for `trigger-session.ps1` /
    `trigger-race.ps1` at all: an app registration with zero exposed `oauth2PermissionScopes`
    has nothing for any client -- even Microsoft's own first-party Azure CLI app -- to be
    consented to, so `az account get-access-token --resource api://<appId>` fails with
    AADSTS65001 (consent_required). Pre-authorizing the well-known Azure CLI client ID for the
    new scope bypasses that interactive-consent requirement entirely.

    `RequestedAccessTokenVersion = 2` is required so that genuine v2.0-endpoint token requests
    (see get-bearer-token.ps1's device-code flow) come back with an `iss` claim
    (`https://login.microsoftonline.com/{tenant}/v2.0`) matching Easy Auth's configured
    `openIdIssuer` (the streaming-backend module uses the v2.0 issuer format).
    NOTE: `az account get-access-token` (both `--resource` and `--scope` forms) is documented
    to always return v1.0-format tokens regardless of this setting, and Windows' WAM broker
    additionally caches that v1 token outside `az cache purge`'s reach
    (https://github.com/Azure/azure-cli/issues/24206) -- use get-bearer-token.ps1's
    device-code flow instead when a genuine Easy-Auth-protected bearer token is needed.
    #>
    param(
        [Parameter(Mandatory)][string]$ApplicationObjectId,
        [Parameter(Mandatory)][string]$AppId
    )

    Write-Host "Ensuring '$AppId' exposes the 'user_impersonation' scope and requests v2.0 access tokens..."
    Update-MgApplication -ApplicationId $ApplicationObjectId -Api @{
        Oauth2PermissionScopes = @(
            @{
                Id                      = $userImpersonationScopeId
                AdminConsentDescription = "Allow the application to access $AppId on behalf of the signed-in user."
                AdminConsentDisplayName = "Access $AppId"
                IsEnabled               = $true
                Type                    = 'User'
                UserConsentDescription  = "Allow the application to access $AppId on your behalf."
                UserConsentDisplayName  = "Access $AppId"
                Value                   = 'user_impersonation'
            }
        )
        RequestedAccessTokenVersion = 2
    }

    # PreAuthorizedApplications must reference an already-existing scope ID, so this has to be
    # a separate follow-up PATCH -- Graph rejects a single combined request that references a
    # scope not yet present on the object ("Permission Id that cannot be found in the
    # AppPermissions sets").
    Write-Host "Pre-authorizing the Azure CLI client ($azureCliClientId) for that scope (avoids AADSTS65001 consent_required)..."
    Update-MgApplication -ApplicationId $ApplicationObjectId -Api @{
        PreAuthorizedApplications = @(
            @{
                AppId                  = $azureCliClientId
                DelegatedPermissionIds = @($userImpersonationScopeId)
            }
        )
    }
}

function Get-OrNewEasyAuthApplication {
    param(
        [string]$DisplayName,
        [string[]]$RedirectUris
    )

    $existing = Get-MgApplication -Filter "displayName eq '$DisplayName'" -ConsistencyLevel eventual -CountVariable existingCount
    if ($existing) {
        Write-Host "App registration '$DisplayName' already exists (appId=$($existing.AppId)) -- reusing."
        if ($RedirectUris.Count -gt 0) {
            $currentUris = @($existing.Web.RedirectUris)
            $mergedUris = @($currentUris + $RedirectUris | Select-Object -Unique)
            if (($mergedUris | Sort-Object) -join ',' -ne ($currentUris | Sort-Object) -join ',') {
                Write-Host "Updating redirect URIs on '$DisplayName': $($mergedUris -join ', ')"
                Update-MgApplication -ApplicationId $existing.Id -Web @{ RedirectUris = $mergedUris }
            }
        }
        Set-EasyAuthApiConfiguration -ApplicationObjectId $existing.Id -AppId $existing.AppId
        return $existing
    }

    Write-Host "Creating app registration '$DisplayName'..."
    $appParams = @{
        DisplayName    = $DisplayName
        SignInAudience = 'AzureADMyOrg'
        Web            = @{
            RedirectUris          = $RedirectUris
            ImplicitGrantSettings = @{ EnableIdTokenIssuance = $true }
        }
        RequiredResourceAccess = @(
            @{
                ResourceAppId  = $graphResourceAppId
                ResourceAccess = @(
                    @{ Id = $userReadScopeId; Type = 'Scope' }
                )
            }
        )
    }
    $app = New-MgApplication @appParams

    # The Application ID URI (used as the Easy Auth `allowedAudiences` entry) can only be
    # set once the app's AppId is known, so this is a required follow-up update, not
    # optional. Safe to re-run (Update-MgApplication is idempotent for the same value).
    Update-MgApplication -ApplicationId $app.Id -IdentifierUris @("api://$($app.AppId)")
    Set-EasyAuthApiConfiguration -ApplicationObjectId $app.Id -AppId $app.AppId

    return $app
}

function Get-OrNewServicePrincipal {
    param([string]$AppId)

    $existing = Get-MgServicePrincipal -Filter "appId eq '$AppId'"
    if ($existing) {
        Write-Host "Service principal for appId $AppId already exists -- reusing."
        return $existing
    }

    Write-Host "Creating service principal for appId $AppId..."
    return New-MgServicePrincipal -AppId $AppId
}

Assert-GraphModule -ModuleName 'Microsoft.Graph.Applications'
Assert-GraphModule -ModuleName 'Microsoft.Graph.Users'
Assert-GraphModule -ModuleName 'Microsoft.Graph.Authentication'

Connect-GraphIfNeeded -TenantId $TenantId

$easyAuthDisplayName = "$AppDisplayNamePrefix-easyauth"

if ($PSCmdlet.ShouldProcess($easyAuthDisplayName, 'Create or update Entra app registration')) {
    $app = Get-OrNewEasyAuthApplication -DisplayName $easyAuthDisplayName -RedirectUris $RedirectUris
    $servicePrincipal = Get-OrNewServicePrincipal -AppId $app.AppId
}
else {
    $app = Get-MgApplication -Filter "displayName eq '$easyAuthDisplayName'"
    $servicePrincipal = if ($app) { Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'" } else { $null }
}

Write-Host "Resolving admin UPN '$FabricCapacityAdminUpn' to an Entra object ID..."
$adminUser = Get-MgUser -UserId $FabricCapacityAdminUpn -ErrorAction Stop

$context = Get-MgContext

$result = [PSCustomObject]@{
    AuthClientId          = $app.AppId
    AuthClientObjectId    = $app.Id
    AuthServicePrincipalId = $servicePrincipal.Id
    AdminObjectId         = $adminUser.Id
    TenantId              = $context.TenantId
}

Write-Host ''
Write-Host 'Entra app registration provisioning complete:'
Write-Host "  AuthClientId (Bicep 'authClientId')                     : $($result.AuthClientId)"
Write-Host "  AdminObjectId (Bicep 'foundryUserPrincipalIds' entry)    : $($result.AdminObjectId)"

return $result
