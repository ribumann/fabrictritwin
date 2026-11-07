#Requires -Version 7.0
<#
.SYNOPSIS
Pester tests for scripts/deploy/build-and-push-images.ps1 (T041) and
scripts/deploy/deploy-container-apps.ps1 (T042) -- implements T043.

.DESCRIPTION
Tests both scripts as black boxes: invokes the real script file, but with the external `az`
CLI mocked, so no live Azure calls or Docker/ACR builds are made. Follows the same pattern
validated in tests/pester/Fabric-Capacity-Lifecycle.Tests.ps1 (T039a).
#>

BeforeAll {
    $script:BuildScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'deploy' 'build-and-push-images.ps1')).Path
    $script:DeployScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'deploy' 'deploy-container-apps.ps1')).Path
}

Describe 'Deployment subscription isolation' {
    BeforeAll {
        Mock -CommandName az -MockWith {
            $global:LASTEXITCODE = 0
            if ($args -contains 'account' -and $args -contains 'show') {
                if ($args -contains '--subscription') {
                    return '{"id":"00000000-0000-0000-0000-000000000000"}'
                }
                return '{"id":"11111111-1111-1111-1111-111111111111"}'
            }
            if ($args -contains 'acr' -and $args -contains 'show') {
                return 'triatwindevacr.azurecr.io'
            }
            return $null
        }
    }

    It 'scopes every build call without changing a different default subscription' {
        & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' -Apps 'simulator'
        Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter { $args -contains 'acr' -and $args -contains 'build' }
        Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
            $args -notcontains '--subscription' -or $args -notcontains '00000000-0000-0000-0000-000000000000'
        }
        Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter { $args -contains 'account' -and $args -contains 'set' }
    }

    It 'scopes registry, app, ingress and job deployment calls without changing the default' {
        & $script:DeployScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1'
        Should -Invoke -CommandName az -Times 9 -Exactly -ParameterFilter { $args -contains 'update' }
        Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
            $args -notcontains '--subscription' -or $args -notcontains '00000000-0000-0000-0000-000000000000'
        }
        Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter { $args -contains 'account' -and $args -contains 'set' }
    }

    It 'makes no mutations during either dry run, including account selection' {
        & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' -WhatIf
        & $script:DeployScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' -WhatIf
        Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
            $args -contains 'build' -or $args -contains 'update' -or $args -contains 'set'
        }
        Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
            $args -notcontains '--subscription' -or $args -notcontains '00000000-0000-0000-0000-000000000000'
        }
    }

    It 'fails before building or deploying if the requested account is unavailable' {
        Mock -CommandName az -MockWith {
            $global:LASTEXITCODE = 1
            return $null
        } -ParameterFilter { $args -contains 'account' -and $args -contains 'show' }
        { & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' } | Should -Throw '*Failed to read Azure subscription*'
        { & $script:DeployScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' } | Should -Throw '*Failed to read Azure subscription*'
        Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter { $args -contains 'acr' -or $args -contains 'containerapp' -or $args -contains 'set' }
    }
}

Describe 'build-and-push-images.ps1 (T041)' {

    Context 'Parameter validation' {
        It 'throws when -SubscriptionId is not supplied' {
            { & $script:BuildScript -ImageTag 'v1' } | Should -Throw
        }

        It 'throws when -ImageTag is not supplied' {
            { & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' } | Should -Throw
        }

        It 'rejects an app name outside the known set' {
            { & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' -Apps 'not-a-real-app' } | Should -Throw
        }
    }

    Context 'Builds all five apps by default' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args -contains 'show' -and $args -contains 'account') {
                    return '{"id":"00000000-0000-0000-0000-000000000000"}'
                }
                return $null
            }
        }

        It 'invokes az acr build once per app (5 times, incl. cockpit)' {
            & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1'
            Should -Invoke -CommandName az -Times 5 -Exactly -ParameterFilter { $args -contains 'build' -and $args -contains 'acr' }
        }
    }

    Context 'Builds a single app when -Apps is restricted' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args -contains 'show' -and $args -contains 'account') {
                    return '{"id":"00000000-0000-0000-0000-000000000000"}'
                }
                return $null
            }
        }

        It 'invokes az acr build exactly once, for console' {
            & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' -Apps 'console'
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter { $args -contains 'build' -and $args -contains 'acr' }
        }
    }

    Context 'Returns build metadata for each app' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args -contains 'show' -and $args -contains 'account') {
                    return '{"id":"00000000-0000-0000-0000-000000000000"}'
                }
                return $null
            }
        }

        It 'returns one result object per app with the expected image name' {
            $result = & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' -Apps 'mcp-tools'
            $result.AppName | Should -Be 'mcp-tools'
            $result.ImageName | Should -Be 'mcp-tools:v1'
        }
    }

    Context '-WhatIf does not build anything' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args -contains 'show' -and $args -contains 'account') {
                    return '{"id":"00000000-0000-0000-0000-000000000000"}'
                }
                return $null
            }
        }

        It 'does not invoke az acr build' {
            & $script:BuildScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' -WhatIf
            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter { $args -contains 'build' -and $args -contains 'acr' }
        }
    }
}

Describe 'deploy-container-apps.ps1 (T042)' {

    Context 'Parameter validation' {
        It 'throws when -SubscriptionId is not supplied' {
            { & $script:DeployScript -ImageTag 'v1' } | Should -Throw
        }

        It 'throws when -ImageTag is not supplied' {
            { & $script:DeployScript -SubscriptionId '00000000-0000-0000-0000-000000000000' } | Should -Throw
        }
    }

    Context 'Rolls all five apps/job by default' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args -contains 'show' -and $args -contains 'account') {
                    return '{"id":"00000000-0000-0000-0000-000000000000"}'
                }
                if ($args -contains 'show' -and $args -contains 'acr') {
                    return 'triatwindevacr.azurecr.io'
                }
                return $null
            }
        }

        It 'updates the four Container Apps (image + ingress target-port each) and the one Job (5 total)' {
            & $script:DeployScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1'
            Should -Invoke -CommandName az -Times 4 -Exactly -ParameterFilter { $args -contains 'containerapp' -and $args -contains 'update' -and $args -notcontains 'job' -and $args -notcontains 'ingress' }
            Should -Invoke -CommandName az -Times 4 -Exactly -ParameterFilter { $args -contains 'containerapp' -and $args -contains 'ingress' -and $args -contains 'update' }
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter { $args -contains 'containerapp' -and $args -contains 'job' -and $args -contains 'update' }
        }
    }

    Context 'Rolls a single app when -Apps is restricted' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args -contains 'show' -and $args -contains 'account') {
                    return '{"id":"00000000-0000-0000-0000-000000000000"}'
                }
                if ($args -contains 'show' -and $args -contains 'acr') {
                    return 'triatwindevacr.azurecr.io'
                }
                return $null
            }
        }

        It 'updates only the simulator job' {
            $result = & $script:DeployScript -SubscriptionId '00000000-0000-0000-0000-000000000000' -ImageTag 'v1' -Apps 'simulator'
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter { $args -contains 'containerapp' -and $args -contains 'job' -and $args -contains 'update' }
            $result.ResourceType | Should -Be 'containerappjob'
            $result.ImageName | Should -Be 'triatwindevacr.azurecr.io/simulator:v1'
        }
    }
}
