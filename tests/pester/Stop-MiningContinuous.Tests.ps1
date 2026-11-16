BeforeAll {
    $script:StopScript = Join-Path $PSScriptRoot '..\..\scripts\simulate\stop-mining-continuous.ps1'
    $script:Parameters = @{
        SubscriptionId = '11111111-1111-1111-1111-111111111111'
        TenantId = '22222222-2222-2222-2222-222222222222'
        CallerPrincipalId = '33333333-3333-4333-8333-333333333333'
        ResourceGroupName = 'rg-example'; StorageAccountName = 'examplestate'; ContainerName = 'mining-state-test'
        Generation = 'release-1'
    }
}
Describe 'Private continuous Mining stop' {
    BeforeEach {
        $global:StopMiningParameters = $script:Parameters
        $global:StopMiningHold = $null
        $global:StopMiningWrongTenant = $false
        $global:StopMiningUnknownWrite = $false
        $global:StopMiningWrongCaller = $false
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -contains 'get-access-token') {
                $claims = @{
                    tid = $global:StopMiningParameters.TenantId
                    oid = $(if ($global:StopMiningWrongCaller) { 'wrong' } else { $global:StopMiningParameters.CallerPrincipalId })
                } | ConvertTo-Json -Compress
                $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($claims)).TrimEnd('=').Replace('+','-').Replace('/','_')
                return @{ accessToken = "header.$payload.signature"; tenant = $global:StopMiningParameters.TenantId } | ConvertTo-Json
            }
            if ($args -contains 'storage') {
                return @{
                    id = "/subscriptions/$($global:StopMiningParameters.SubscriptionId)/resourceGroups/rg-example/providers/Microsoft.Storage/storageAccounts/examplestate"
                    primaryEndpoints = @{ blob = 'https://examplestate.blob.core.windows.net/' }
                } | ConvertTo-Json -Depth 4
            }
            return @{ id = $global:StopMiningParameters.SubscriptionId; tenantId = $(if ($global:StopMiningWrongTenant) { 'wrong' } else { $global:StopMiningParameters.TenantId }) } | ConvertTo-Json
        }
        Mock Invoke-WebRequest {
            param($Method, $Uri, $Headers, $Body)
            $Uri | Should -Be 'https://examplestate.blob.core.windows.net/mining-state-test/continuous/holds/release-1.json'
            if ($Method -eq 'PUT') {
                $Headers['If-None-Match'] | Should -Be '*'
                if ($global:StopMiningUnknownWrite) { throw 'private-test-token' }
                if ($global:StopMiningHold) { return @{ StatusCode = 412 } }
                $global:StopMiningHold = $Body
                return @{ StatusCode = 201 }
            }
            return @{ StatusCode = $(if ($global:StopMiningHold) { 200 } else { 404 }); Content = $global:StopMiningHold }
        }
    }
    It 'is read-only by default and confirms persistent intent, not completed sends' {
        (& $script:StopScript @Parameters).Status | Should -Be 'NoGenerationHold'
        Should -Invoke Invoke-WebRequest -Times 0 -ParameterFilter { $Method -eq 'PUT' }
        $result = & $script:StopScript @Parameters -Apply -Confirm:$false
        $result.Status | Should -Be 'StopIntentConfirmed'
        $result.DeliveryCompleted | Should -BeFalse
        $result.TargetUri | Should -Be 'https://examplestate.blob.core.windows.net/mining-state-test/continuous/holds/release-1.json'
        (& $script:StopScript @Parameters -Apply -Confirm:$false).Status | Should -Be 'StopIntentConfirmed'
        ($global:StopMiningHold | ConvertFrom-Json).generation | Should -Be 'release-1'
    }
    It 'rejects wrong caller tenant before storage writes and never logs an unknown-write token' {
        $global:StopMiningWrongTenant = $true
        { & $script:StopScript @Parameters -Apply -Confirm:$false } | Should -Throw '*subscription/tenant*'
        Should -Invoke Invoke-WebRequest -Times 0
        $global:StopMiningWrongTenant = $false
        $global:StopMiningUnknownWrite = $true
        try { & $script:StopScript @Parameters -Apply -Confirm:$false; throw 'Missing failure' }
        catch { $_.Exception.Message | Should -Match 'outcome is unknown'; $_.Exception.Message | Should -Not -Match 'private-test-token' }
    }
    It 'does not overwrite or accept malformed existing intent' {
        $global:StopMiningHold = '{"version":1,"plantId":"D01","generation":"release-foreign","requestedAt":"2026-01-01T00:00:00Z"}'
        { & $script:StopScript @Parameters -Apply -Confirm:$false } | Should -Throw '*does not match*'
        Should -Invoke Invoke-WebRequest -Times 1 -ParameterFilter { $Method -eq 'PUT' }
    }
    It 'pins the current authorized caller before reading or writing a hold' {
        $global:StopMiningWrongCaller = $true
        { & $script:StopScript @Parameters -Apply -Confirm:$false } | Should -Throw '*caller/tenant*'
        Should -Invoke Invoke-WebRequest -Times 0
    }
}
