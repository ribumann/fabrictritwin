#Requires -Version 7.0
<#
.SYNOPSIS
Triggers an on-demand live training session via the deployed Streaming Backend API.

.DESCRIPTION
Implements T074 (specs/001-triathlon-training-twin/tasks.md). This is a thin wrapper around the
Streaming Backend `POST /api/simulate/trigger-session` endpoint so workstation/CI callers use the
same trigger path as Cockpit.

Easy Auth bearer-token acquisition depends on the Entra app registration and deployment-specific
audience configuration, which is not derivable safely from this repository alone. For that reason
the script accepts an explicit `-BearerToken` parameter instead of guessing an auth flow.

.PARAMETER AthleteId
Athlete GUID whose live session should be simulated.

.PARAMETER Discipline
Training discipline: swim, bike, run, or strength.

.PARAMETER StreamingBackendBaseUrl
Base URL of the deployed Streaming Backend, for example `https://triathlon-streaming-backend...`.
If omitted, `STREAMING_BACKEND_BASE_URL` is used.

.PARAMETER BearerToken
Optional Easy Auth bearer token. Supply this for deployed environments protected by Entra ID.

.OUTPUTS
JSON written to stdout describing the trigger result.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$AthleteId,

    [Parameter(Mandatory)]
    [ValidateSet('swim', 'bike', 'run', 'strength')]
    [string]$Discipline,

    [string]$StreamingBackendBaseUrl = $env:STREAMING_BACKEND_BASE_URL,

    [string]$BearerToken
)

$ErrorActionPreference = 'Stop'

function Invoke-TriggerSession {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$AthleteId,

        [Parameter(Mandatory)]
        [string]$Discipline,

        [Parameter(Mandatory)]
        [string]$StreamingBackendBaseUrl,

        [string]$BearerToken
    )

    if ([string]::IsNullOrWhiteSpace($StreamingBackendBaseUrl)) {
        throw 'Parameter -StreamingBackendBaseUrl is required (or set STREAMING_BACKEND_BASE_URL).'
    }

    $uri = '{0}/api/simulate/trigger-session' -f $StreamingBackendBaseUrl.TrimEnd('/')
    $headers = @{
        'Content-Type' = 'application/json'
    }

    if (-not [string]::IsNullOrWhiteSpace($BearerToken)) {
        $headers['Authorization'] = "Bearer $BearerToken"
    }

    $body = @{
        athleteId  = $AthleteId
        discipline = $Discipline
    } | ConvertTo-Json -Depth 10

    return Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-TriggerSession -AthleteId $AthleteId -Discipline $Discipline -StreamingBackendBaseUrl $StreamingBackendBaseUrl -BearerToken $BearerToken
    $result | ConvertTo-Json -Depth 100
}
