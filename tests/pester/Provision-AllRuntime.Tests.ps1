BeforeAll {
    . (Join-Path $PSScriptRoot 'Runtime-Fixtures.ps1')
    $script:Orchestrator = Join-Path $TestDrive 'provision-all.ps1'
    Copy-Item (Join-Path $PSScriptRoot '..\..\scripts\provision\provision-all.ps1') $script:Orchestrator
    $stub = @'
[CmdletBinding(SupportsShouldProcess)]
param(
    $SubscriptionId, $TenantId, $ResourceGroupName, $NamePrefix, $Location, $FabricLocation,
    $FoundryLocation, $FabricCapacityAdminUpn, $ImageTag, $SimulatorDailyScheduleCron,
    $DefaultAthleteId, $FabricCapacityName, $FabricWorkspaceName, $FabricWorkspaceId,
    $AuthorizedUserObjectIds, $AthleteId, $CockpitAppName, $WorkspaceId, $ReportId,
    $AllowedPrincipalIds, $ApproveTenantSettings, $FabricDataAgentId, $FabricConnectionName,
    $AssistantAuthResult, $PowerBiEmbeddingResult, $FabricConnectionId, $ModelDeploymentName
)
$name = $MyInvocation.MyCommand.Name
$global:ProvisionCalls.Add(@{ Name = $name; Params = $PSBoundParameters; WhatIf = [bool]$WhatIfPreference })
switch ($name) {
    'provision-azure-resources.ps1' { return @{ FabricCapacityName = 'capacity' } }
    'provision-fabric-items.ps1' { return @{ FabricWorkspaceId = $global:RuntimeFixture.WorkspaceId; Items = @(@{ LogicalName = 'DataAgent'; Id = $global:RuntimeFixture.AgentId }) } }
    'configure-assistant-auth.ps1' { return $global:RuntimeFixture.AuthResult }
    'configure-powerbi-embedding.ps1' { return @{ Status = 'Configured'; WorkspaceId = $global:RuntimeFixture.WorkspaceId; RuntimeValidated = $true } }
    default { return @{ ConfigurationReady = -not $WhatIfPreference } }
}
'@
    foreach ($name in @('provision-azure-resources.ps1', 'provision-fabric-items.ps1', 'configure-simulator-connections.ps1', 'configure-assistant-auth.ps1', 'configure-powerbi-embedding.ps1', 'configure-runtime-connections.ps1')) {
        [IO.File]::WriteAllText((Join-Path $TestDrive $name), $stub)
    }
}

Describe 'Full provisioning runtime ordering' {
    BeforeEach {
        New-RuntimeFixture
        $global:ProvisionCalls = [System.Collections.Generic.List[object]]::new()
        $f = $global:RuntimeFixture
        $script:Params = @{
            SubscriptionId = $f.SubscriptionId; TenantId = $f.TenantId; DefaultAthleteId = $f.AthleteId
            ConfigureRuntime = $true; AuthorizedUserObjectIds = @($f.UserOid)
            ConfigurePowerBiEmbedding = $true; PowerBiReportId = $f.AgentId
            PowerBiAllowedPrincipalIds = @($f.UserOid)
        }
    }
    It 'creates foundation and Fabric before credential overlays and final runtime wiring' {
        $result = & $script:Orchestrator @script:Params
        $global:ProvisionCalls.Name | Should -Be @(
            'provision-azure-resources.ps1', 'provision-fabric-items.ps1', 'configure-simulator-connections.ps1',
            'configure-assistant-auth.ps1', 'configure-powerbi-embedding.ps1', 'configure-runtime-connections.ps1'
        )
        foreach ($call in $global:ProvisionCalls) { $call.Params.SubscriptionId | Should -Be $global:RuntimeFixture.SubscriptionId }
        $last = $global:ProvisionCalls[-1].Params
        $last.AssistantAuthResult.CockpitAuthClientId | Should -Be $global:RuntimeFixture.CockpitClientId
        $last.PowerBiEmbeddingResult.RuntimeValidated | Should -BeTrue
        $last.FabricDataAgentId | Should -Be $global:RuntimeFixture.AgentId
        $result.RuntimeConnections.ConfigurationReady | Should -BeTrue
    }
    It 'propagates WhatIf through every nested setup step' {
        $result = & $script:Orchestrator @script:Params -WhatIf
        @($global:ProvisionCalls | Where-Object { -not $_.WhatIf }).Count | Should -Be 0
        $result.RuntimeConnections.ConfigurationReady | Should -BeFalse
    }
    It 'requires an explicit tenant and athlete before any setup calls' {
        $script:Params.Remove('TenantId')
        { & $script:Orchestrator @script:Params } | Should -Throw '*requires explicit*'
        $global:ProvisionCalls.Count | Should -Be 0
    }
    It 'keeps legacy foundation-only behavior without invoking optional credential scripts' {
        & $script:Orchestrator -SubscriptionId $global:RuntimeFixture.SubscriptionId | Out-Null
        $global:ProvisionCalls.Count | Should -Be 3
    }
}
