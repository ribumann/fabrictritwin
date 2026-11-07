#Requires -Version 7.0

[CmdletBinding()]
param(
    [string]$TenantId = 'dee4515b-50c3-59a0-a184-3a6a4039cb31',

    [string]$ClientAppId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46',

    [Parameter(Mandatory)]
    [string]$AudienceAppId
)

$ErrorActionPreference = 'Stop'

$scope = "api://$AudienceAppId/.default offline_access"
$deviceCodeResponse = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/devicecode" -Body @{
    client_id = $ClientAppId
    scope     = $scope
}

Write-Host $deviceCodeResponse.message -ForegroundColor Cyan

$intervalSeconds = [Math]::Max(1, [int]$deviceCodeResponse.interval)
$deadline = (Get-Date).AddSeconds([int]$deviceCodeResponse.expires_in)
$tokenResponse = $null

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $intervalSeconds
    try {
        $tokenResponse = Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" -Body @{
            grant_type  = 'urn:ietf:params:oauth:grant-type:device_code'
            client_id   = $ClientAppId
            device_code = $deviceCodeResponse.device_code
        }
        break
    }
    catch {
        $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json
        if ($errorBody.error -eq 'authorization_pending') {
            continue
        }
        if ($errorBody.error -eq 'slow_down') {
            $intervalSeconds += 5
            continue
        }
        throw "Device code flow failed: $($errorBody.error) - $($errorBody.error_description)"
    }
}

if (-not $tokenResponse) {
    throw 'Device code expired before sign-in was completed. Re-run this script and complete the sign-in step promptly.'
}

Write-Output $tokenResponse.access_token
