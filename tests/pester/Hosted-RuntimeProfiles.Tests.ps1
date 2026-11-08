BeforeAll {
    $root = Join-Path $PSScriptRoot '..\..\infra\bicep'
    $script:Main = Get-Content (Join-Path $root 'main.bicep') -Raw
    $script:Backend = Get-Content (Join-Path $root 'modules\streaming-backend.bicep') -Raw
    $script:Cockpit = Get-Content (Join-Path $root 'modules\cockpit.bicep') -Raw
}

Describe 'Declarative hosted runtime profile safeguards' {
    It 'allows only explicit live and synthetic profiles with live as the default' {
        foreach ($source in @($script:Main, $script:Backend, $script:Cockpit)) {
            $source | Should -Match "@allowed\(\['live', 'synthetic'\]\)\s+param demoProfile string = 'live'"
        }
        ([regex]::Matches($script:Main, 'demoProfile: demoProfile')).Count | Should -Be 2
    }
    It 'omits DEMO_PROFILE in live and emits the exact synthetic value on both apps' {
        foreach ($source in @($script:Backend, $script:Cockpit)) {
            $source | Should -Match "demoProfile == 'synthetic' \? \[\s+\{ name: 'DEMO_PROFILE', value: 'synthetic' \}\s+\] : \[\]"
        }
    }
    It 'bounds synthetic backend replicas and routes only to the latest Single revision' {
        $script:Backend | Should -Match 'minReplicas: 1'
        $script:Backend | Should -Match "maxReplicas: demoProfile == 'synthetic' \? 1 : 3"
        $script:Backend | Should -Match "activeRevisionsMode: 'Single'"
        $script:Backend | Should -Match 'traffic: \[\s+\{\s+latestRevision: true\s+weight: 100'
    }
    It 'retains platform auth, backend MI authorization and secret references' {
        $script:Backend | Should -Match "unauthenticatedClientAction: 'RedirectToLoginPage'"
        $script:Backend | Should -Match 'cockpitManagedIdentityClientId'
        $script:Backend | Should -Match "secretRef: 'eventstream-eventhub-connection-string'"
        $script:Cockpit | Should -Match "unauthenticatedClientAction: 'AllowAnonymous'"
        $script:Cockpit | Should -Match "name: 'STREAMING_BACKEND_SCOPE'"
        $script:Cockpit | Should -Match "secretRef: 'powerbi-client-secret'"
        foreach ($source in @($script:Backend, $script:Cockpit)) {
            $source | Should -Match 'platform: \{\s+enabled: true'
            $source | Should -Match "type: 'UserAssigned'"
        }
    }
}
