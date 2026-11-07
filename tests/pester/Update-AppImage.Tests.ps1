#Requires -Version 7.0
BeforeAll {
    $script:UpdateScript = Join-Path $PSScriptRoot '..' '..' 'scripts' 'deploy' 'update-app-image.ps1'
    $script:Subscription = '00000000-0000-0000-0000-000000000000'
    $script:Digest = 'sha256:' + ('a' * 64)
    $script:Parameters = @{
        SubscriptionId = $script:Subscription
        ResourceGroupName = 'rg-example'
        NamePrefix = 'example-dev'
        RegistryName = 'exampledevacr'
        App = 'cockpit'
        ImageDigest = $script:Digest
    }
    function New-Workload {
        param([string]$App = 'cockpit')
        $type = if ($App -eq 'simulator') { 'jobs' } else { 'containerApps' }
        return @{
            id = "/subscriptions/$script:Subscription/resourceGroups/rg-example/providers/Microsoft.App/$type/example-dev-$App"
            identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ 'example-identity' = @{} } }
            properties = @{
                provisioningState = 'Succeeded'
                managedEnvironmentId = 'example-environment'
                configuration = @{
                    activeRevisionsMode = 'Single'
                    triggerType = 'Schedule'
                    scheduleTriggerConfig = @{ cronExpression = '0 3 * * *' }
                    secrets = @(@{ name = 'runtime-secret' })
                    registries = @(@{ server = 'exampledevacr.azurecr.io'; identity = 'example-identity' })
                    ingress = @{
                        targetPort = 3300
                        customDomains = @(@{ name = 'demo.example.net'; certificateId = 'example-certificate' })
                        traffic = @(@{ latestRevision = $true; weight = 100 })
                    }
                }
                template = @{
                    revisionSuffix = 'old-revision'
                    containers = @(@{
                        name = $App
                        image = "exampledevacr.azurecr.io/${App}:previous"
                        command = $null
                        args = $null
                        env = @(@{ name = 'TOKEN'; secretRef = 'runtime-secret' }, @{ name = 'RUNTIME_VALUE'; value = 'do-not-print-me' })
                        resources = @{ cpu = 0.5; memory = '1Gi' }
                    })
                    scale = @{ minReplicas = 1; maxReplicas = 1 }
                }
            }
        }
    }
}

Describe 'Immutable scoped image updates' {
    BeforeEach {
        $script:Workload = New-Workload
        $global:ImageUpdateMockState = @{ Workload = $script:Workload; Digest = $script:Digest }
        Mock az {
            $global:LASTEXITCODE = 0
            if ($args -contains 'account') { return '{"id":"00000000-0000-0000-0000-000000000000"}' }
            if ($args -contains 'acr') {
                if ($args -contains 'repository') { return @{ digest = $global:ImageUpdateMockState.Digest } | ConvertTo-Json }
                return '{"loginServer":"exampledevacr.azurecr.io"}'
            }
            if ($args -contains 'update') {
                $state = $global:ImageUpdateMockState
                $state.Workload.properties.template.containers[0].image = "exampledevacr.azurecr.io/$($state.Workload.properties.template.containers[0].name)@$($state.Digest)"
                $state.Workload.properties.template.revisionSuffix = 'new-revision'
                return
            }
            return $global:ImageUpdateMockState.Workload | ConvertTo-Json -Depth 100
        }
    }

    It 'updates exactly the named container and preserves overlays, TLS, identity and schedules' {
        $result = & $script:UpdateScript @script:Parameters
        $result.Status | Should -Be 'Verified'
        $result.Image | Should -Be "exampledevacr.azurecr.io/cockpit@$script:Digest"
        ($result | ConvertTo-Json) | Should -Not -Match 'do-not-print-me|runtime-secret'
        Should -Invoke az -Times 1 -Exactly -ParameterFilter {
            $args -contains 'update' -and $args -contains '--container-name' -and $args -contains 'cockpit' -and
            $args -contains '--image' -and $args -contains '-o' -and $args -contains 'none'
        }
        Should -Invoke az -Times 0 -Exactly -ParameterFilter {
            $args -contains 'ingress' -or $args -contains 'set' -or $args -contains 'delete' -or
            $args -contains '--set-env-vars' -or $args -contains '--replace-env-vars' -or $args -contains '--yaml'
        }
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -notcontains '--subscription' }
    }

    It 'does not mutate during WhatIf and does not report success' {
        $result = & $script:UpdateScript @script:Parameters -WhatIf
        $result.Status | Should -Be 'NotApplied'
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -contains 'update' }
    }

    It 'does not create a revision for the same exact digest' {
        $script:Workload.properties.template.containers[0].image = "exampledevacr.azurecr.io/cockpit@$script:Digest"
        (& $script:UpdateScript @script:Parameters).Status | Should -Be 'Unchanged'
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -contains 'update' }
    }

    It 'updates the simulator job without starting or changing its schedule' {
        $script:Workload = New-Workload simulator
        $global:ImageUpdateMockState.Workload = $script:Workload
        & $script:UpdateScript @script:Parameters -App simulator
        Should -Invoke az -Times 1 -Exactly -ParameterFilter { $args -contains 'job' -and $args -contains 'update' }
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -contains 'start' -or $args -contains '--trigger-type' }
    }

    It 'rejects unsafe inputs before any Azure call' -ForEach @(
        @{ Name = 'ImageDigest'; Value = 'latest' }
        @{ Name = 'ImageDigest'; Value = ('sha256:' + ('A' * 64)) }
        @{ Name = 'App'; Value = 'console' }
        @{ Name = 'ResourceGroupName'; Value = '--other-option' }
        @{ Name = 'NamePrefix'; Value = "bad'; throw 'injected" }
        @{ Name = 'RegistryName'; Value = 'foreign.example.net' }
        @{ Name = 'SubscriptionId'; Value = '------------------------------------' }
    ) {
        $parameters = $script:Parameters.Clone()
        $parameters[$Name] = $Value
        { & $script:UpdateScript @parameters } | Should -Throw
        Should -Invoke az -Times 0 -Exactly
    }

    It 'rejects unsafe workload state before writes' -ForEach @(
        @{ Change = 'target' }
        @{ Change = 'bootstrap' }
        @{ Change = 'container' }
        @{ Change = 'sidecar' }
        @{ Change = 'command' }
        @{ Change = 'args' }
        @{ Change = 'port' }
        @{ Change = 'traffic' }
        @{ Change = 'provisioning' }
    ) {
        switch ($Change) {
            target { $script:Workload.id += '-other' }
            bootstrap { $script:Workload.properties.template.containers[0].image = 'mcr.microsoft.com/k8se/quickstart:latest' }
            container { $script:Workload.properties.template.containers[0].name = 'other' }
            sidecar { $script:Workload.properties.template.containers += @{ name = 'sidecar' } }
            command { $script:Workload.properties.template.containers[0].command = @('/bin/sh', '-c') }
            args { $script:Workload.properties.template.containers[0].args = @('exit 0') }
            port { $script:Workload.properties.configuration.ingress.targetPort = 80 }
            traffic { $script:Workload.properties.configuration.activeRevisionsMode = 'Multiple' }
            provisioning { $script:Workload.properties.provisioningState = 'Failed' }
        }
        { & $script:UpdateScript @script:Parameters } | Should -Throw
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -contains 'update' }
    }

    It 'stops on Azure read failure or denied permissions' {
        Mock az { $global:LASTEXITCODE = 1; return $null }
        { & $script:UpdateScript @script:Parameters } | Should -Throw '*Azure read failed*'
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -contains 'update' }
    }

    It 'rejects a mismatched subscription or registry' -ForEach @(
        @{ Response = '{"id":"11111111-1111-1111-1111-111111111111"}'; Service = 'account' }
        @{ Response = '{"loginServer":"foreign.azurecr.io"}'; Service = 'acr' }
        @{ Response = '{"digest":"sha256:wrong"}'; Service = 'repository' }
    ) {
        $global:ImageUpdateMockState.BadResponse = $Response
        $global:ImageUpdateMockState.BadService = $Service
        Mock az { $global:LASTEXITCODE = 0; return $global:ImageUpdateMockState.BadResponse } -ParameterFilter { $args -contains $global:ImageUpdateMockState.BadService }
        { & $script:UpdateScript @script:Parameters } | Should -Throw
        Should -Invoke az -Times 0 -Exactly -ParameterFilter { $args -contains 'update' }
    }

    It 'does not retry or claim success after an update failure' {
        Mock az { $global:LASTEXITCODE = 1 } -ParameterFilter { $args -contains 'update' }
        { & $script:UpdateScript @script:Parameters } | Should -Throw '*Image update failed*'
        Should -Invoke az -Times 1 -Exactly -ParameterFilter { $args -contains 'update' }
    }

    It 'detects a silently unsuccessful update' {
        Mock az { $global:LASTEXITCODE = 0 } -ParameterFilter { $args -contains 'update' }
        { & $script:UpdateScript @script:Parameters } | Should -Throw '*expected ready image was not verified*'
    }

    It 'detects configuration drift without logging values or automatically rolling back' {
        Mock az {
            $global:LASTEXITCODE = 0
            $state = $global:ImageUpdateMockState
            $state.Workload.properties.template.containers[0].image = "exampledevacr.azurecr.io/cockpit@$($state.Digest)"
            $state.Workload.properties.configuration.ingress.customDomains = @()
        } -ParameterFilter { $args -contains 'update' }
        { & $script:UpdateScript @script:Parameters } | Should -Throw '*preservation failed*'
        Should -Invoke az -Times 1 -Exactly -ParameterFilter { $args -contains 'update' }
    }
    AfterAll {
        Remove-Variable -Name ImageUpdateMockState -Scope Global
    }
}

Describe 'Deployment workflow safety contract' {
    BeforeAll {
        $root = Join-Path $PSScriptRoot '..' '..'
        $script:Workflow = Get-Content (Join-Path $root '.github' 'workflows' 'deploy-app-image.yml') -Raw
        $script:CI = Get-Content (Join-Path $root '.github' 'workflows' 'ci.yml') -Raw
    }
    It 'allows only manual main-branch deployment to an explicit protected environment' {
        $script:Workflow | Should -Match 'workflow_dispatch:'
        $script:Workflow | Should -Not -Match '(?m)^\s+(push|pull_request|pull_request_target|schedule|workflow_run):'
        $script:Workflow | Should -Match "github.repository == 'ribumann/fabrictritwin' && github.ref == 'refs/heads/main'"
        $script:Workflow | Should -Match 'environment: azure-deploy'
        $script:Workflow | Should -Match "DEPLOYMENT_ENABLED -cne 'true'"
        $script:Workflow | Should -Match "APPLY_DEPLOYMENT -cne 'true'"
        $script:Workflow | Should -Match 'default: false'
        $script:Workflow | Should -Match 'persist-credentials: false'
        $script:Workflow | Should -Not -Match 'secrets\.|AZURE_CANARY|build-and-push|deploy-container-apps'
    }
    It 'never interpolates dispatch or environment text into executable shell code' {
        $runBlocks = [regex]::Matches($script:Workflow, '(?ms)^        run: \|\r?\n(.*?)(?=^      -|\z)')
        $runBlocks.Count | Should -Be 2
        foreach ($block in $runBlocks) {
            $block.Groups[1].Value | Should -Not -Match '\$\{\{'
        }
    }
    It 'validates pull requests without OIDC or deployment privileges' {
        $script:CI | Should -Match 'pull_request:'
        $script:CI | Should -Match 'Run-Tests.ps1'
        $script:CI | Should -Match 'npm run build'
        $script:CI | Should -Match 'az bicep build'
        $script:CI | Should -Not -Match 'id-token:|azure/login|environment:|secrets\.'
    }
}
