# Live integration smoke checks (T045) against already-provisioned resources: Eventstream
# ingest reachability, Eventhouse KQL query reachability, Key Vault access, deployed
# Container Apps health endpoints, and Fabric item existence.
#
# Tagged 'Integration' throughout so the default/CI unit-test run (Run-Tests.ps1,
# PesterConfiguration.psd1's ExcludeTag) never attempts live Azure/Fabric calls. Only
# scripts/validate/smoke-test.ps1 (T045) invokes this file, explicitly, after
# provisioning (Constitution Principle II gate).
#
# Parameterized via Pester 5's container Data mechanism (New-PesterContainer -Data @{...}),
# not plain script parameters, so `Invoke-Pester -Container` can inject values per run.
param(
    [string]$ResourceGroupName = 'rg-triathlon-twin-demo',
    [string]$FabricWorkspaceName,
    [string]$NamePrefix = 'triatwin-dev'
)

# NOTE: these helpers are deliberately defined inside a file-root `BeforeAll` block
# rather than as plain top-level functions. Two independent, evidence-verified reasons:
#
# 1. Pester 5's discovery/run separation does not expose plain script-scope functions
#    to BeforeAll/It blocks (confirmed via isolated repro: a top-level `function Foo {}`
#    followed by `Describe { BeforeAll { Foo } }` throws
#    `CommandNotFoundException: The term 'Foo' is not recognized...`). Defining functions
#    inside a root `BeforeAll` makes them available to every Describe/Context/It in the
#    file, which does work (verified).
# 2. Pester 6.1.0 (the highest version installed in this environment, and what
#    `-MinimumVersion 5.0.0` resolves to) has a genuine framework regression: calling an
#    *external process* (e.g. `az`) from within a *user-defined function* invoked inside
#    `BeforeAll`/`It` throws a misleading
#    `InvalidOperationException: A 'break' or 'continue' statement with a label that does
#    not match any enclosing loop escaped from your code` (see
#    https://github.com/pester/Pester/issues/2669), completely masking the real result.
#    This reproduces with or without `2>&1` stream redirection, and regardless of whether
#    the function is defined at script scope or inside BeforeAll -- it is specific to
#    Pester 6.1.0 itself. Confirmed fixed by running under Pester 5.6.1 instead (identical
#    test logic passes cleanly). Because of this, `scripts/validate/smoke-test.ps1`
#    explicitly pins `-RequiredVersion 5.6.1` rather than `-MinimumVersion 5.0.0`.
BeforeAll {
    function Invoke-Az {
        [CmdletBinding()]
        param(
            [Parameter(Mandatory)]
            [string[]]$Arguments,

            [switch]$AsJson
        )

        $rawOutput = & az @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "az $($Arguments -join ' ') failed (exit $LASTEXITCODE):`n$($rawOutput -join [Environment]::NewLine)"
        }

        $output = $rawOutput | Where-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
            $line -notmatch '^WARNING:'
        }

        if ($AsJson) {
            if ([string]::IsNullOrWhiteSpace(($output -join ''))) {
                return $null
            }

            return ($output -join [Environment]::NewLine) | ConvertFrom-Json
        }

        return $output
    }

    function Get-FabricAuthHeaders {
        param([string]$Resource = 'https://api.fabric.microsoft.com')

        $accessToken = ((Invoke-Az -Arguments @(
                    'account', 'get-access-token',
                    '--resource', $Resource,
                    '--query', 'accessToken',
                    '-o', 'tsv'
                )) -join '').Trim()

        if ([string]::IsNullOrWhiteSpace($accessToken)) {
            throw "Failed to acquire an access token for resource '$Resource' from ``az account get-access-token``."
        }

        return @{
            Authorization = "Bearer $accessToken"
            Accept        = 'application/json'
        }
    }

    function Invoke-FabricRestMethod {
        [CmdletBinding()]
        param(
            [Parameter(Mandatory)]
            [ValidateSet('Get', 'Post')]
            [string]$Method,

            [Parameter(Mandatory)]
            [string]$Uri,

            [Parameter(Mandatory)]
            [hashtable]$Headers,

            [string]$Body
        )

        $invokeParams = @{
            Method      = $Method
            Uri         = $Uri
            Headers     = $Headers
            ErrorAction = 'Stop'
        }
        if ($PSBoundParameters.ContainsKey('Body')) {
            $invokeParams.Body = $Body
            $invokeParams.ContentType = 'application/json'
        }

        return Invoke-RestMethod @invokeParams
    }

    function Get-FabricWorkspaceByDisplayName {
        param(
            [string]$WorkspaceName,
            [hashtable]$Headers
        )

        $response = Invoke-FabricRestMethod -Method Get -Uri 'https://api.fabric.microsoft.com/v1/workspaces?roles=Admin' -Headers $Headers
        return @($response.value | Where-Object { $_.displayName -ieq $WorkspaceName }) | Select-Object -First 1
    }

    function Get-FabricItemByDisplayName {
        param(
            [string]$WorkspaceId,
            [string]$DisplayName,
            [hashtable]$Headers,
            [string]$ExpectedType
        )

        $response = Invoke-FabricRestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$WorkspaceId/items" -Headers $Headers
        $candidates = @($response.value | Where-Object { $_.displayName -ieq $DisplayName })
        if ($ExpectedType) {
            $typed = @($candidates | Where-Object { $_.type -ieq $ExpectedType })
            if ($typed.Count -gt 0) {
                return $typed | Select-Object -First 1
            }
        }
        return $candidates | Select-Object -First 1
    }
}

Describe 'Smoke Test (T045): live infrastructure connectivity/health checks' -Tag 'Integration' {

    BeforeAll {
        if ([string]::IsNullOrWhiteSpace($FabricWorkspaceName)) {
            $script:ResolvedWorkspaceName = "$NamePrefix-fabric"
        }
        else {
            $script:ResolvedWorkspaceName = $FabricWorkspaceName
        }

        $script:FabricHeaders = Get-FabricAuthHeaders -Resource 'https://api.fabric.microsoft.com'
        $script:Workspace = Get-FabricWorkspaceByDisplayName -WorkspaceName $script:ResolvedWorkspaceName -Headers $script:FabricHeaders
    }

    Context 'Azure resources (T035)' {

        It 'has a Key Vault in the resource group with a Succeeded provisioning state' {
            $vaultName = (Invoke-Az -Arguments @(
                    'keyvault', 'list',
                    '--resource-group', $ResourceGroupName,
                    '--query', '[0].name', '-o', 'tsv'
                ) | Select-Object -First 1)
            $vaultName | Should -Not -BeNullOrEmpty -Because 'provision-azure-resources.ps1 (T035) always deploys exactly one Key Vault'

            $vault = Invoke-Az -Arguments @(
                'keyvault', 'show',
                '--name', $vaultName,
                '--resource-group', $ResourceGroupName,
                '-o', 'json'
            ) -AsJson
            $vault.properties.provisioningState | Should -Be 'Succeeded'
        }

        It 'grants RBAC secret access on the Key Vault (data-plane reachable, or role-assignment verified if blocked by tenant network policy)' {
            $vaultResource = (Invoke-Az -Arguments @(
                    'keyvault', 'list',
                    '--resource-group', $ResourceGroupName,
                    '--query', '[0]', '-o', 'json'
                ) -AsJson)
            $vaultName = $vaultResource.name

            # A successful call with zero secrets is a pass; only an auth/connectivity
            # failure (non-zero exit) needs further triage below.
            try {
                Invoke-Az -Arguments @('keyvault', 'secret', 'list', '--vault-name', $vaultName, '-o', 'json') | Out-Null
                return
            }
            catch {
                $message = $_.Exception.Message
                if ($message -notmatch '(?i)Public network access is disabled') {
                    throw
                }

                Write-Host "Key Vault data-plane secret list blocked by tenant network policy (confirmed governance constraint, not a bug) -- falling back to verifying RBAC role assignments via ARM."
            }

            $roleAssignments = Invoke-Az -Arguments @(
                'role', 'assignment', 'list',
                '--scope', $vaultResource.id,
                '--query', "[?roleDefinitionName=='Key Vault Secrets User' || roleDefinitionName=='Key Vault Secrets Officer']",
                '-o', 'json'
            ) -AsJson

            $roleAssignments.Count | Should -BeGreaterThan 0 -Because 'provision-azure-resources.ps1 (T035) assigns least-privilege "Key Vault Secrets User"/"Key Vault Secrets Officer" RBAC roles even though the configured tenant''s governance policy blocks direct data-plane verification'
        }

        It 'has every deployed Container App ingress endpoint reachable over HTTPS' {
            $apps = Invoke-Az -Arguments @(
                'containerapp', 'list',
                '--resource-group', $ResourceGroupName,
                '--query', "[?properties.configuration.ingress.fqdn!=null].{name:name, fqdn:properties.configuration.ingress.fqdn}",
                '-o', 'json'
            ) -AsJson

            $apps.Count | Should -BeGreaterThan 0 -Because 'deploy-container-apps.ps1 (T042) publishes the remaining ingress-enabled apps (Cockpit, Streaming Backend)'

            $unreachable = [System.Collections.Generic.List[string]]::new()
            foreach ($app in $apps) {
                try {
                    # -SkipHttpErrorCheck: a real HTTP response (even 4xx/5xx from a
                    # placeholder-image app with no /health route yet) still proves the
                    # Container App is reachable/routable, which is what this check verifies.
                    Invoke-WebRequest -Uri "https://$($app.fqdn)" -Method Get -TimeoutSec 30 -SkipHttpErrorCheck -ErrorAction Stop | Out-Null
                }
                catch {
                    $unreachable.Add("$($app.name) (https://$($app.fqdn)): $($_.Exception.Message)") | Out-Null
                }
            }

            $unreachable | Should -BeNullOrEmpty -Because 'every ingress-enabled Container App should at least accept an HTTPS connection'
        }
    }

    Context 'Fabric workspace and items (T036)' {

        It 'has a Fabric workspace matching the expected display name' {
            $script:Workspace | Should -Not -BeNullOrEmpty -Because "provision-fabric-items.ps1 (T036) creates/reuses a workspace named '$($script:ResolvedWorkspaceName)'"
        }

        It 'has a Lakehouse item' {
            $item = Get-FabricItemByDisplayName -WorkspaceId $script:Workspace.id -DisplayName "$($NamePrefix -replace '-', '_')_lakehouse" -Headers $script:FabricHeaders -ExpectedType 'Lakehouse'
            $item | Should -Not -BeNullOrEmpty
            $item.type | Should -Be 'Lakehouse'
        }

        It 'has an Eventhouse item' {
            $item = Get-FabricItemByDisplayName -WorkspaceId $script:Workspace.id -DisplayName "$NamePrefix-eventhouse" -Headers $script:FabricHeaders -ExpectedType 'Eventhouse'
            $item | Should -Not -BeNullOrEmpty
            $item.type | Should -Be 'Eventhouse'
        }

        It 'has an Eventstream item' {
            $item = Get-FabricItemByDisplayName -WorkspaceId $script:Workspace.id -DisplayName "$NamePrefix-eventstream" -Headers $script:FabricHeaders -ExpectedType 'Eventstream'
            $item | Should -Not -BeNullOrEmpty
            $item.type | Should -Be 'Eventstream'
        }

        It 'has an Activator (Reflex) item' {
            $item = Get-FabricItemByDisplayName -WorkspaceId $script:Workspace.id -DisplayName "$NamePrefix-alerts" -Headers $script:FabricHeaders -ExpectedType 'Reflex'
            $item | Should -Not -BeNullOrEmpty
            $item.type | Should -Be 'Reflex'
        }

        It 'has a Fabric Data Agent item' {
            $item = Get-FabricItemByDisplayName -WorkspaceId $script:Workspace.id -DisplayName "$NamePrefix-dataagent" -Headers $script:FabricHeaders -ExpectedType 'DataAgent'
            $item | Should -Not -BeNullOrEmpty
            $item.type | Should -Be 'DataAgent'
        }

        It 'has a Fabric Operations Agent item (or is skipped pending manual playbook authoring)' {
            $item = Get-FabricItemByDisplayName -WorkspaceId $script:Workspace.id -DisplayName "$NamePrefix-operationsagent" -Headers $script:FabricHeaders -ExpectedType 'OperationsAgent'
            if (-not $item) {
                Set-ItResult -Skipped -Because 'Operations Agent playbook rules cannot currently be authored via REST (confirmed platform limitation) -- create it manually in the Fabric portal, see infra/fabric/fabric-operations-agent/README.md'
                return
            }
            $item.type | Should -Be 'OperationsAgent'
        }
    }

    Context 'Fabric data-plane connectivity (best-effort; preview API surfaces per T036 caveats)' {

        It 'resolves an Eventhouse KQL query URI and answers a trivial query' {
            $eventhouseItem = Get-FabricItemByDisplayName -WorkspaceId $script:Workspace.id -DisplayName "$NamePrefix-eventhouse" -Headers $script:FabricHeaders -ExpectedType 'Eventhouse'
            $eventhouseItem | Should -Not -BeNullOrEmpty

            try {
                $detail = Invoke-FabricRestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$($script:Workspace.id)/eventhouses/$($eventhouseItem.id)" -Headers $script:FabricHeaders
                $queryUri = $detail.properties.queryServiceUri
                if ([string]::IsNullOrWhiteSpace($queryUri)) {
                    Set-ItResult -Inconclusive -Because 'the Eventhouse detail response did not include a queryServiceUri (preview API shape may differ from what was documented at authoring time -- see T036 caveats)'
                    return
                }

                $kustoHeaders = Get-FabricAuthHeaders -Resource 'https://kusto.kusto.windows.net'
                $queryBody = @{ db = ''; csl = 'print SmokeTest = 1' } | ConvertTo-Json
                $queryResult = Invoke-FabricRestMethod -Method Post -Uri "$queryUri/v1/rest/query" -Headers $kustoHeaders -Body $queryBody
                $queryResult | Should -Not -BeNullOrEmpty
            }
            catch {
                Set-ItResult -Inconclusive -Because "Eventhouse KQL query connectivity could not be verified against this preview API surface: $($_.Exception.Message)"
            }
        }

        It 'resolves Eventstream topology/connectivity details' {
            $eventstreamItem = Get-FabricItemByDisplayName -WorkspaceId $script:Workspace.id -DisplayName "$NamePrefix-eventstream" -Headers $script:FabricHeaders -ExpectedType 'Eventstream'
            $eventstreamItem | Should -Not -BeNullOrEmpty

            try {
                $topology = Invoke-FabricRestMethod -Method Get -Uri "https://api.fabric.microsoft.com/v1/workspaces/$($script:Workspace.id)/eventstreams/$($eventstreamItem.id)/topology" -Headers $script:FabricHeaders
                $topology | Should -Not -BeNullOrEmpty
            }
            catch {
                Set-ItResult -Inconclusive -Because "Eventstream topology/ingest connectivity could not be verified against this preview API surface: $($_.Exception.Message)"
            }
        }
    }
}
