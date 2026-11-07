#Requires -Version 7.0
<#
.SYNOPSIS
Triggers an on-demand live race simulation via the deployed Streaming Backend API.

.DESCRIPTION
Implements T074 (specs/001-triathlon-training-twin/tasks.md). This is a thin wrapper around the
Streaming Backend `POST /api/simulate/trigger-race` endpoint so workstation/CI callers use the
same trigger path as the Demo Control Console UI.

Easy Auth bearer-token acquisition depends on the Entra app registration and deployment-specific
audience configuration, which is not derivable safely from this repository alone. For that reason
the script accepts an explicit `-BearerToken` parameter instead of guessing an auth flow.

.PARAMETER AthleteId
Athlete GUID whose race should be simulated.

.PARAMETER RaceId
Race GUID to simulate.

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
    [string]$RaceId,

    [string]$StreamingBackendBaseUrl = $env:STREAMING_BACKEND_BASE_URL,

    [string]$BearerToken
)

$ErrorActionPreference = 'Stop'

function Invoke-TriggerRace {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$AthleteId,

        [Parameter(Mandatory)]
        [string]$RaceId,

        [Parameter(Mandatory)]
        [string]$StreamingBackendBaseUrl,

        [string]$BearerToken
    )

    if ([string]::IsNullOrWhiteSpace($StreamingBackendBaseUrl)) {
        throw 'Parameter -StreamingBackendBaseUrl is required (or set STREAMING_BACKEND_BASE_URL).'
    }

    $uri = '{0}/api/simulate/trigger-race' -f $StreamingBackendBaseUrl.TrimEnd('/')
    $headers = @{
        'Content-Type' = 'application/json'
    }

    if (-not [string]::IsNullOrWhiteSpace($BearerToken)) {
        $headers['Authorization'] = "Bearer $BearerToken"
    }

    $body = @{
        athleteId = $AthleteId
        raceId    = $RaceId
    } | ConvertTo-Json -Depth 10

    return Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body
}

if ($MyInvocation.InvocationName -ne '.') {
    $result = Invoke-TriggerRace -AthleteId $AthleteId -RaceId $RaceId -StreamingBackendBaseUrl $StreamingBackendBaseUrl -BearerToken $BearerToken
    $result | ConvertTo-Json -Depth 100
}
