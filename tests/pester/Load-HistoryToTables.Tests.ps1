#Requires -Version 7.0

BeforeAll {
    $script:LoadScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'simulate' 'load-history-to-tables.ps1')).Path
}

Describe 'Load history notebook job' {
    BeforeEach {
        $global:DailyLoadTestState = @{
            JobStatus = 'Completed'
            TriggerStatus = 202
            TriggerLocation = 'https://api.fabric.microsoft.com/v1/workspaces/workspace-1/items/notebook-1/jobs/instances/job-1'
            RetryAfter = $null
        }
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -contains 'get-access-token') { return 'test-token' }
            throw "Unexpected az invocation: $args"
        }
        Mock Start-Sleep {}
        Mock Invoke-WebRequest {
            return @{
                StatusCode = $global:DailyLoadTestState.TriggerStatus
                Headers = @{ Location = $global:DailyLoadTestState.TriggerLocation; 'Retry-After' = $global:DailyLoadTestState.RetryAfter }
            }
        }
        Mock Invoke-RestMethod {
            param($Method, $Uri, $Headers, $Body, $ContentType)
            if ($Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces') {
                return @{ value = @(@{ id = 'workspace-1'; displayName = 'triatwin-dev-fabric' }) }
            }
            if ($Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces/workspace-1/items') {
                return @{ value = @(@{ id = 'notebook-1'; displayName = 'triatwin-dev-load-history-to-tables'; type = 'Notebook' }) }
            }
            if ($Uri -eq $global:DailyLoadTestState.TriggerLocation) {
                return @{ id = 'job-1'; status = $global:DailyLoadTestState.JobStatus; failureReason = @{ errorCode = 'UserAccessTokenException' } }
            }
            throw "Unexpected Fabric request: $Method $Uri"
        }
    }

    AfterEach {
        Remove-Variable -Name DailyLoadTestState -Scope Global
    }

    It 'submits typed parameters to the MI-supported release API and only succeeds after Completed' {
        $result = & $script:LoadScript -SubscriptionId 'target-subscription' -Environment 'test' -AthleteId 'athlete-1' | ConvertFrom-Json
        $result.Status | Should -Be 'Completed'
        Should -Invoke Invoke-WebRequest -Times 1 -Exactly -ParameterFilter {
            $Method -eq 'Post' -and
            $Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces/workspace-1/notebooks/notebook-1/jobs/execute/instances?beta=false' -and
            ($Body | ConvertFrom-Json).executionData.compute -eq 'Spark' -and
            @(($Body | ConvertFrom-Json).parameters | Where-Object { $_.name -eq 'environment' -and $_.value -eq 'test' -and $_.type -eq 'Text' }).Count -eq 1 -and
            @(($Body | ConvertFrom-Json).parameters | Where-Object { $_.name -eq 'athlete_id' -and $_.value -eq 'athlete-1' -and $_.type -eq 'Text' }).Count -eq 1
        }
        Should -Invoke az -Times 1 -Exactly -ParameterFilter {
            $args -contains 'get-access-token' -and $args -contains '--subscription' -and $args -contains 'target-subscription'
        }
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -contains 'set' -or $args -notcontains '--subscription' }
    }

    It 'does not submit a job or change the default Azure account during WhatIf' {
        $result = & $script:LoadScript -SubscriptionId 'target-subscription' -WhatIf | ConvertFrom-Json
        $result.Status | Should -Be 'WhatIfSkipped'
        Should -Invoke Invoke-RestMethod -Times 0 -Exactly -ParameterFilter { $Method -ne 'Get' }
        Should -Invoke Invoke-WebRequest -Times 0 -Exactly
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -contains 'set' -or $args -notcontains '--subscription' }
    }

    It 'propagates notebook terminal failure <Status>' -ForEach @(
        @{ Status = 'Failed' }, @{ Status = 'Cancelled' }, @{ Status = 'Deduped' }
    ) {
        $global:DailyLoadTestState.JobStatus = $Status
        { & $script:LoadScript -SubscriptionId 'target-subscription' } | Should -Throw "*status '$Status'*UserAccessTokenException*"
    }

    It 'fails when a submitted notebook never reaches a terminal state' {
        $global:DailyLoadTestState.JobStatus = 'InProgress'
        { & $script:LoadScript -SubscriptionId 'target-subscription' -TimeoutSeconds 1 } | Should -Throw '*Timed out*'
    }

    It 'honors Retry-After before the first status request' {
        $global:DailyLoadTestState.RetryAfter = '60'
        $result = & $script:LoadScript -SubscriptionId 'target-subscription' | ConvertFrom-Json
        $result.Status | Should -Be 'Completed'
        Should -Invoke Start-Sleep -Times 1 -Exactly -ParameterFilter { $Seconds -eq 60 }
    }

    It 'rejects submission without an accepted status' {
        $global:DailyLoadTestState.TriggerStatus = 200
        { & $script:LoadScript -SubscriptionId 'target-subscription' } | Should -Throw '*Expected HTTP 202*'
    }

    It 'rejects submission without a polling location' {
        $global:DailyLoadTestState.TriggerLocation = $null
        { & $script:LoadScript -SubscriptionId 'target-subscription' } | Should -Throw '*Location header*'
    }
}
