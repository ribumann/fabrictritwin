#Requires -Version 7.0
<#
.SYNOPSIS
Pester tests for scripts/teardown/teardown-all.ps1 (T046).

.DESCRIPTION
Exercises the real teardown script as a black box while mocking the Azure CLI, Fabric REST
API, and interactive confirmation prompt. Covers idempotency, ordering, WhatIf behavior, and
the extra typed-confirmation bypass for unattended runs.
#>

BeforeAll {
    $script:TeardownScript = (Resolve-Path (Join-Path $PSScriptRoot '..' '..' 'scripts' 'teardown' 'teardown-all.ps1')).Path
    $script:SubscriptionId = '00000000-0000-0000-0000-000000000123'
    $script:ResourceGroupName = 'rg-triathlon-twin-demo'
    $script:WorkspaceName = 'triathlon-twin-ws'
    $script:WorkspaceId = '11111111-2222-3333-4444-555555555555'
    $script:FabricToken = 'fabric-access-token'
}

Describe 'teardown-all.ps1 (T046)' {
    Context 'Parameter validation' {
        It 'throws when -SubscriptionId is not supplied' {
            { & $script:TeardownScript -ResourceGroupName $script:ResourceGroupName -FabricWorkspaceName $script:WorkspaceName } | Should -Throw
        }

        It 'throws when -ResourceGroupName is not supplied' {
            { & $script:TeardownScript -SubscriptionId $script:SubscriptionId -FabricWorkspaceName $script:WorkspaceName } | Should -Throw
        }

        It 'throws when -FabricWorkspaceName is not supplied' {
            { & $script:TeardownScript -SubscriptionId $script:SubscriptionId -ResourceGroupName $script:ResourceGroupName } | Should -Throw
        }
    }

    Context 'Idempotency: resource group does not exist' {
        BeforeEach {
            $global:T046_OperationLog = [System.Collections.ArrayList]::new()
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'show') { return "{`"id`":`"$($script:SubscriptionId)`"}" }
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'get-access-token') { return 'abc123' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists') { return 'false' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'delete') { [void]$global:T046_OperationLog.Add('resource-group-delete'); return $null }
                throw "Unexpected az invocation: $($args -join ' ')"
            }
            Mock -CommandName Invoke-RestMethod -MockWith {
                param($Method, $Uri, $Headers, $ErrorAction)
                if ($Method -eq 'Get' -and $Uri -like 'https://api.fabric.microsoft.com/v1/workspaces*') {
                    return [PSCustomObject]@{ value = @() }
                }
                throw "Unexpected Invoke-RestMethod invocation: $Method $Uri"
            }
            Mock -CommandName Read-Host -MockWith {
                throw 'Read-Host should not be called when nothing exists to delete.'
            }
        }

        It 'does not invoke az group delete and exits without error' {
            $result = & $script:TeardownScript -SubscriptionId $script:SubscriptionId -ResourceGroupName $script:ResourceGroupName -FabricWorkspaceName $script:WorkspaceName -Confirm:$false

            $result.ResourceGroupDeleted | Should -BeFalse
            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'delete'
            }
        }
    }

    Context 'Idempotency: Fabric workspace does not exist' {
        BeforeEach {
            $global:T046_OperationLog = [System.Collections.ArrayList]::new()
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'show') { return "{`"id`":`"$($script:SubscriptionId)`"}" }
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'get-access-token') { return 'abc123' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists') { return 'false' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'delete') { [void]$global:T046_OperationLog.Add('resource-group-delete'); return $null }
                throw "Unexpected az invocation: $($args -join ' ')"
            }
            Mock -CommandName Invoke-RestMethod -MockWith {
                param($Method, $Uri, $Headers, $ErrorAction)
                if ($Method -eq 'Get' -and $Uri -like 'https://api.fabric.microsoft.com/v1/workspaces*') {
                    return [PSCustomObject]@{ value = @() }
                }
                throw "Unexpected Invoke-RestMethod invocation: $Method $Uri"
            }
            Mock -CommandName Read-Host -MockWith {
                throw 'Read-Host should not be called when nothing exists to delete.'
            }
        }

        It 'does not invoke the Fabric DELETE call and exits without error' {
            $result = & $script:TeardownScript -SubscriptionId $script:SubscriptionId -ResourceGroupName $script:ResourceGroupName -FabricWorkspaceName $script:WorkspaceName -Confirm:$false

            $result.FabricWorkspaceDeleted | Should -BeFalse
            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter {
                $Method -eq 'Delete'
            }
        }
    }

    Context 'Happy path: both resources exist' {
        BeforeEach {
            $global:T046_OperationLog = [System.Collections.ArrayList]::new()
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'show') { return "{`"id`":`"$($script:SubscriptionId)`"}" }
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'get-access-token') { return 'abc123' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists') { return 'true' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'delete') { [void]$global:T046_OperationLog.Add('resource-group-delete'); return $null }
                throw "Unexpected az invocation: $($args -join ' ')"
            }
            Mock -CommandName Invoke-RestMethod -MockWith {
                param($Method, $Uri, $Headers, $ErrorAction)
                if ($Method -eq 'Get' -and $Uri -like 'https://api.fabric.microsoft.com/v1/workspaces*') {
                    return [PSCustomObject]@{
                        value = @([PSCustomObject]@{
                                id          = '11111111-2222-3333-4444-555555555555'
                                displayName = 'triathlon-twin-ws'
                                type        = 'Workspace'
                            })
                    }
                }
                if ($Method -eq 'Delete' -and $Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces/11111111-2222-3333-4444-555555555555') {
                    [void]$global:T046_OperationLog.Add('workspace-delete')
                    return $null
                }
                throw "Unexpected Invoke-RestMethod invocation: $Method $Uri"
            }
            Mock -CommandName Read-Host -MockWith {
                throw 'Read-Host should not be called when -Force is supplied.'
            }
        }

        It 'deletes the Fabric workspace and the resource group exactly once, in that order' {
            $result = & $script:TeardownScript -SubscriptionId $script:SubscriptionId -ResourceGroupName $script:ResourceGroupName -FabricWorkspaceName $script:WorkspaceName -Force -Confirm:$false

            $result.FabricWorkspaceDeleted | Should -BeTrue
            $result.ResourceGroupDeleted | Should -BeTrue
            @($global:T046_OperationLog) | Should -Be @('workspace-delete', 'resource-group-delete')

            Should -Invoke -CommandName Invoke-RestMethod -Times 1 -Exactly -ParameterFilter {
                $Method -eq 'Delete' -and $Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces/11111111-2222-3333-4444-555555555555'
            }
            Should -Invoke -CommandName az -Times 1 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'delete'
            }
        }
    }

    Context 'WhatIf mode' {
        BeforeEach {
            $global:T046_OperationLog = [System.Collections.ArrayList]::new()
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'show') { return "{`"id`":`"$($script:SubscriptionId)`"}" }
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'get-access-token') { return 'abc123' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists') { return 'true' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'delete') { [void]$global:T046_OperationLog.Add('resource-group-delete'); return $null }
                throw "Unexpected az invocation: $($args -join ' ')"
            }
            Mock -CommandName Invoke-RestMethod -MockWith {
                param($Method, $Uri, $Headers, $ErrorAction)
                if ($Method -eq 'Get' -and $Uri -like 'https://api.fabric.microsoft.com/v1/workspaces*') {
                    return [PSCustomObject]@{
                        value = @([PSCustomObject]@{
                                id          = '11111111-2222-3333-4444-555555555555'
                                displayName = 'triathlon-twin-ws'
                                type        = 'Workspace'
                            })
                    }
                }
                if ($Method -eq 'Delete' -and $Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces/11111111-2222-3333-4444-555555555555') {
                    [void]$global:T046_OperationLog.Add('workspace-delete')
                    return $null
                }
                throw "Unexpected Invoke-RestMethod invocation: $Method $Uri"
            }
            Mock -CommandName Read-Host -MockWith {
                throw 'Read-Host must not be called under -WhatIf.'
            }
        }

        It 'makes no mutating calls at all' {
            $result = & $script:TeardownScript -SubscriptionId $script:SubscriptionId -ResourceGroupName $script:ResourceGroupName -FabricWorkspaceName $script:WorkspaceName -WhatIf

            $result.FabricWorkspaceDeleted | Should -BeFalse
            $result.ResourceGroupDeleted | Should -BeFalse
            Should -Invoke -CommandName Invoke-RestMethod -Times 0 -Exactly -ParameterFilter {
                $Method -eq 'Delete'
            }
            Should -Invoke -CommandName az -Times 0 -Exactly -ParameterFilter {
                $args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'delete'
            }
            Should -Invoke -CommandName Read-Host -Times 0 -Exactly
        }
    }

    Context 'Force bypass' {
        BeforeEach {
            $global:T046_OperationLog = [System.Collections.ArrayList]::new()
            Mock -CommandName az -MockWith {
                $global:LASTEXITCODE = 0
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'show') { return "{`"id`":`"$($script:SubscriptionId)`"}" }
                if ($args.Count -ge 2 -and $args[0] -eq 'account' -and $args[1] -eq 'get-access-token') { return 'abc123' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'exists') { return 'true' }
                if ($args.Count -ge 2 -and $args[0] -eq 'group' -and $args[1] -eq 'delete') { [void]$global:T046_OperationLog.Add('resource-group-delete'); return $null }
                throw "Unexpected az invocation: $($args -join ' ')"
            }
            Mock -CommandName Invoke-RestMethod -MockWith {
                param($Method, $Uri, $Headers, $ErrorAction)
                if ($Method -eq 'Get' -and $Uri -like 'https://api.fabric.microsoft.com/v1/workspaces*') {
                    return [PSCustomObject]@{
                        value = @([PSCustomObject]@{
                                id          = '11111111-2222-3333-4444-555555555555'
                                displayName = 'triathlon-twin-ws'
                                type        = 'Workspace'
                            })
                    }
                }
                if ($Method -eq 'Delete' -and $Uri -eq 'https://api.fabric.microsoft.com/v1/workspaces/11111111-2222-3333-4444-555555555555') {
                    [void]$global:T046_OperationLog.Add('workspace-delete')
                    return $null
                }
                throw "Unexpected Invoke-RestMethod invocation: $Method $Uri"
            }
            Mock -CommandName Read-Host -MockWith {
                throw 'Read-Host should not run when -Force is supplied.'
            }
        }

        It 'bypasses the typed confirmation prompt when -Force -Confirm:$false are supplied' {
            & $script:TeardownScript -SubscriptionId $script:SubscriptionId -ResourceGroupName $script:ResourceGroupName -FabricWorkspaceName $script:WorkspaceName -Force -Confirm:$false | Out-Null

            Should -Invoke -CommandName Read-Host -Times 0 -Exactly
        }
    }
}
