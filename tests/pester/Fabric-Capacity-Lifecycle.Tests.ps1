#Requires -Version 7.0
<#
.SYNOPSIS
Pester tests for scripts/fabric/resume-capacity.ps1 (T036a) and
scripts/fabric/suspend-capacity.ps1 (T045a) -- implements T039a.

.DESCRIPTION
Tests both scripts as black boxes: invokes the real script file, but with the external `az`
CLI and `Start-Sleep` mocked, so no live Azure calls are made. Covers parameter validation
and both scripts' idempotency contracts (no-op when already in the target state; invoke the
control-plane action and poll when not).
#>

BeforeAll {
    $script:ResumeScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'fabric' 'resume-capacity.ps1')).Path
    $script:SuspendScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'fabric' 'suspend-capacity.ps1')).Path
}

Describe 'resume-capacity.ps1 (T036a)' {

    Context 'Explicit subscription isolation' {
        BeforeEach {
            $script:explicitReads = 0
            Mock az {
                $global:LASTEXITCODE = 0
                if ($args -notcontains '--subscription' -or $args -notcontains '00000000-0000-0000-0000-000000000123') { throw 'Missing requested subscription.' }
                if ($args[0] -eq 'account') { throw 'Must not consult or change the default account.' }
                if ($args[1] -eq 'show') {
                    $script:explicitReads++
                    if ($script:explicitReads -eq 1) { return 'Paused' }
                    return 'Active'
                }
            }
            Mock Start-Sleep {}
        }
        It 'uses the explicit subscription for resume and all polls without consulting the default account' {
            & $script:ResumeScript -SubscriptionId '00000000-0000-0000-0000-000000000123' -ResourceGroupName 'rg-triathlon-twin-demo' -CapacityName 'triatwindevfabriccap'
            Should -Invoke az -Times 1 -Exactly -ParameterFilter {
                $args -contains '/subscriptions/00000000-0000-0000-0000-000000000123/resourceGroups/rg-triathlon-twin-demo/providers/Microsoft.Fabric/capacities/triatwindevfabriccap'
            }
            Should -Invoke az -Times 0 -ParameterFilter { $args[0] -eq 'account' }
        }
        It 'makes no mutating capacity call under WhatIf' {
            & $script:ResumeScript -SubscriptionId '00000000-0000-0000-0000-000000000123' -ResourceGroupName 'rg-triathlon-twin-demo' -CapacityName 'triatwindevfabriccap' -WhatIf
            Should -Invoke az -Times 0 -ParameterFilter { $args -contains 'invoke-action' }
        }
        It 'surfaces failures instead of retrying in the default subscription' {
            Mock az { $global:LASTEXITCODE = 1; return 'Forbidden' }
            { & $script:ResumeScript -SubscriptionId '00000000-0000-0000-0000-000000000123' -ResourceGroupName 'rg-triathlon-twin-demo' -CapacityName 'triatwindevfabriccap' } | Should -Throw '*Failed to read*'
            Should -Invoke az -Times 1 -Exactly
        }
    }

    Context 'Parameter validation' {
        It 'throws when -ResourceGroupName is not supplied' {
            { & $script:ResumeScript -CapacityName 'triatwindevfabriccap' } | Should -Throw
        }

        It 'throws when -CapacityName is not supplied' {
            { & $script:ResumeScript -ResourceGroupName 'rg-triathlon-twin-demo' } | Should -Throw
        }
    }

    Context 'Idempotency: capacity already Active' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                # `az resource show ... --query properties.state -o tsv` -> already Active.
                $global:LASTEXITCODE = 0
                return 'Active'
            }
        }

        It 'no-ops without invoking the resume action' {
            & $script:ResumeScript -ResourceGroupName 'rg-triathlon-twin-demo' -CapacityName 'triatwindevfabriccap'
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter { $args -contains 'show' }
            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter { $args -contains 'invoke-action' }
        }
    }

    Context 'Capacity Paused: resumes and polls until Active' {
        BeforeAll {
            $script:callCount = 0
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                # Distinguish capacity-state reads (`az resource show ... --resource-type
                # Microsoft.Fabric/capacities`) from the unrelated `az account show` call used
                # to build $resourceId -- both contain 'show', but only the former should drive
                # the Paused -> Active poll sequence below.
                if ($args -contains 'resource' -and $args -contains 'show') {
                    $script:callCount++
                    # Paused on the first read, Active from the second read onward.
                    if ($script:callCount -eq 1) { return 'Paused' } else { return 'Active' }
                }
                if ($args -contains 'invoke-action') { return $null }
                if ($args -contains 'account' -and $args -contains 'show') { return '00000000-0000-0000-0000-000000000000' }
                return '00000000-0000-0000-0000-000000000000'
            }
            Mock -CommandName Start-Sleep -MockWith { }
        }

        It 'invokes the resume action and reports Active after polling' {
            & $script:ResumeScript -ResourceGroupName 'rg-triathlon-twin-demo' -CapacityName 'triatwindevfabriccap' -TimeoutSeconds 60
            Should -Invoke -CommandName az -ParameterFilter { $args -contains 'invoke-action' -and $args -contains 'resume' }
            # Two capacity-state reads (Paused, then Active) confirms the poll loop actually
            # re-checked state at least once rather than exiting after a single read.
            Should -Invoke -CommandName az -Times 2 -Exactly -ParameterFilter { $args -contains 'resource' -and $args -contains 'show' }
        }
    }

    Context 'Timeout: capacity never reports Active' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args -contains 'show' -and $args -contains 'Microsoft.Fabric/capacities') { return 'Paused' }
                return '00000000-0000-0000-0000-000000000000'
            }
            Mock -CommandName Start-Sleep -MockWith { }
        }

        It 'throws a timeout error' {
            { & $script:ResumeScript -ResourceGroupName 'rg-triathlon-twin-demo' -CapacityName 'triatwindevfabriccap' -TimeoutSeconds 15 } | Should -Throw '*Timed out*'
        }
    }
}

Describe 'suspend-capacity.ps1 (T045a)' {

    Context 'Parameter validation' {
        It 'throws when -ResourceGroupName is not supplied' {
            { & $script:SuspendScript -CapacityName 'triatwindevfabriccap' } | Should -Throw
        }

        It 'throws when -CapacityName is not supplied' {
            { & $script:SuspendScript -ResourceGroupName 'rg-triathlon-twin-demo' } | Should -Throw
        }
    }

    Context 'Idempotency: capacity already Paused' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                return 'Paused'
            }
        }

        It 'no-ops without invoking the suspend action' {
            & $script:SuspendScript -ResourceGroupName 'rg-triathlon-twin-demo' -CapacityName 'triatwindevfabriccap'
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter { $args -contains 'show' }
            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter { $args -contains 'invoke-action' }
        }
    }

    Context 'Capacity Active: invokes the suspend action' {
        BeforeAll {
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args -contains 'show' -and $args -contains 'Microsoft.Fabric/capacities') { return 'Active' }
                return '00000000-0000-0000-0000-000000000000'
            }
        }

        It 'invokes the suspend action' {
            & $script:SuspendScript -ResourceGroupName 'rg-triathlon-twin-demo' -CapacityName 'triatwindevfabriccap'
            Should -Invoke -CommandName az -ParameterFilter { $args -contains 'invoke-action' -and $args -contains 'suspend' }
        }
    }
}
