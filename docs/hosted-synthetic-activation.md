# Existing-environment synthetic activation

This is an operator runbook, **not an executed deployment or an unattended script**.
Use it only in an approved maintenance window against the two exact existing
Container Apps. It deliberately interrupts the Cockpit and backend. The reviewed
runtime is PR #9 (merged at `61a0ab`; candidate
`5968e19f4d1bf05713388af79d69b9de37645a0d`). A later image needs its own exact-source
review and checks; a tag or that source SHA alone is not a deployed-image proof.
See [profile semantics](hosted-runtime-profiles.md).

## Preparation and approval record

Record the chosen tenant, subscription, resource group, app resource IDs,
current revision names/images, reviewed source SHA, two ACR manifest digests,
registry login server, operator identity and maintenance window in the private
release record. Do not commit environment identifiers, credentials, tokens,
secret dumps or customer data. Obtain the following gates together before writes:

| Gate                       | Exact consequence                                                                                                                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image publication          | Approved build identity may push only required repositories in the chosen registry; enable the protected publication path and approve its exact run/source. Reader alone cannot push in LegacyRegistryPermissions mode. |
| Runtime deployment         | Authorized operator may update and deactivate revisions of the two named apps, including the backend; Cockpit-only write permission is insufficient. Preserve existing identities and authentication.                   |
| Maintenance/profile switch | Cockpit downtime, backend termination of any unfinished runs, reset of in-memory state/quota, reviewed digest updates and synthetic backend min/max 1 are approved.                                                     |
| Public synthetic exposure  | Updating the Cockpit below reopens its existing public ingress. Approve this exact consequence and immediate verification/failure containment.                                                                          |

These are scoped release gates, not blanket Contributor/Owner access, registry
admin enabling, a new credential, or authority to change Easy Auth. Existing image
pull identities must already be able to pull the approved digests.

Use a fresh read-only preflight immediately before the window. This example uses
PowerShell and installed Azure CLI (`containerapp` commands); check their local
`--help` first. Never use `--debug`, transcript runtime responses, print tokens,
or echo the full environment/auth/secret snapshots.

```powershell
$ErrorActionPreference = 'Stop'
$Sub = '<approved-subscription-id>'
$Rg = '<approved-resource-group>'
$Backend = '<exact-existing-backend-name>'
$Cockpit = '<exact-existing-cockpit-name>'
$BackendImage = '<verified-registry>/streaming-backend@sha256:<64-lowercase-hex>'
$CockpitImage = '<verified-registry>/cockpit@sha256:<64-lowercase-hex>'
$Suffix = '<new-unique-approved-release-suffix>'

function Read-AzJson {
    param([string[]]$Arguments, [switch]$List)
    $raw = az @Arguments --only-show-errors -o json
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($raw -join "`n"))) {
        throw 'Azure read failed; stop without further writes.'
    }
    $Json = ($raw -join "`n").Trim()
    if ($List -and (-not $Json.StartsWith('[') -or -not $Json.EndsWith(']'))) {
        throw 'Expected a JSON list, not null/object/scalar; stop.'
    }
    $Parsed = $Json | ConvertFrom-Json
    if ($List) {
        foreach ($Item in $Parsed) {
            if ($null -eq $Item -or [string]::IsNullOrWhiteSpace($Item.name)) {
                throw 'Invalid revision/replica list entry; stop.'
            }
            if ($Arguments -contains 'revision' -and
                $Item.properties.active -isnot [bool]) {
                throw 'Revision active state was not verified; stop.'
            }
        }
    } elseif ($null -eq $Parsed -or $Parsed -isnot [PSCustomObject]) {
        throw 'Expected an Azure resource object; stop.'
    }
    return $Parsed
}
function Write-Az {
    param([string[]]$Arguments)
    az @Arguments --only-show-errors -o none
    if ($LASTEXITCODE -ne 0) { throw 'Azure write failed; inspect before retry.' }
}
$Account = Read-AzJson @('account', 'show', '--subscription', $Sub)
if ($Account.id -ne $Sub) { throw 'Unexpected subscription.' }
$Before = @{}
$AuthBefore = @{}
$OldRevisions = @{}
foreach ($App in @($Cockpit, $Backend)) {
    $Scope = @('--subscription', $Sub, '--resource-group', $Rg, '--name', $App)
    $Before[$App] = Read-AzJson (@('containerapp', 'show') + $Scope)
    $AuthBefore[$App] = Read-AzJson (@('containerapp', 'auth', 'show') + $Scope)
    $OldRevisions[$App] = @(Read-AzJson -List -Arguments
        (@('containerapp', 'revision', 'list', '--all') + $Scope))
}
```

Manually compare these in-memory records to the approved target record, without
printing their contents. Stop for drift, failed reads or pending ARM operations.
Require the exact IDs/tenant; `Succeeded`; Single revision mode; latest-only 100%
traffic; one expected application container; expected ports (backend 3000,
Cockpit 3300); no command/argument override; and no foreign/bootstrap image.
Inspect **all** revisions, including inactive ones and labels, not just latest.
Record their names for subsequent zero-replica checks. Verify current profile on
both is either unset/live or a consistent existing synthetic profile; reject
empty/unknown/mixed values. For an existing synthetic profile also require min/max 1.

Resolve and verify both immutable digests in the exact registry/repositories using
`az acr repository show --subscription ... --name ... --image 'repository@sha256:...'`.
Compare returned digests to the approved manifest record. Successful build checks
do not establish that a digest has been published. Stop if publication/pull access
cannot be verified; do not substitute `latest` or deploy a bootstrap image.

Confirm retained backend Easy Auth requires Entra and retains the Cockpit service
identity allowlist. Cockpit visitors remain anonymous; Cockpit-to-backend is not
anonymous. Require existing `STREAMING_BACKEND_BASE_URL` to be the exact backend
HTTPS origin, nonempty existing `STREAMING_BACKEND_SCOPE`, and existing
`AZURE_CLIENT_ID` on both apps. Preserve their actual values, all secret references,
registry credentials, connections, domains, ingress and scale rules. Do not
replace environment arrays, export resolved secrets, or fabricate an MI principal.

## Stop and prove the old serving processes are gone

There is no separate application admission-disable/maintenance API. A maintenance
banner, traffic weight change or closing one browser is **not** an admission gate.
Deactivating all Cockpit revisions first closes this UI/proxy path and disconnects
its streams. Coordinate other authorized backend callers/jobs separately; this
runbook does not stop live ingestion jobs or change Fabric. If those callers can
create backend runs during the window, stop here until their owners quiesce them.

Use an already authorized operator path, if available, to finish/cancel a run before
shutdown. Do not borrow the Cockpit's identity or weaken backend auth to inspect it.
Live runs and cloud side effects are not cancelled by the synthetic cancel route.
Without an authorized drain observation, record **hard stop**, not graceful drain;
the window approval must cover unfinished runs/disconnected sockets. A fixed sleep
is not evidence of completion.

```powershell
function Assert-Stopped {
    param([string]$App)
    $Scope = @('--subscription', $Sub, '--resource-group', $Rg, '--name', $App)
    $Deadline = [DateTime]::UtcNow.AddMinutes(5)
    do {
        $Revisions = @(Read-AzJson -List -Arguments
            (@('containerapp', 'revision', 'list', '--all') + $Scope))
        foreach ($Old in $OldRevisions[$App]) {
            if ($Old.name -notin $Revisions.name) {
                throw 'Former revision disappeared; investigate rather than infer it stopped.'
            }
        }
        $Stopped = @($Revisions | Where-Object { $_.properties.active -eq $true }).Count -eq 0
        foreach ($Revision in $Revisions) {
            $Replicas = @(Read-AzJson -List -Arguments (@('containerapp', 'replica', 'list',
                '--revision', $Revision.name) + $Scope))
            if ($Replicas.Count -ne 0) { $Stopped = $false }
        }
        if ($Stopped) { return }
        Start-Sleep -Seconds 5
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw 'Old revisions/replicas did not stop; no replacement is permitted.'
}
foreach ($App in @($Cockpit, $Backend)) {
    $Scope = @('--subscription', $Sub, '--resource-group', $Rg, '--name', $App)
    # Re-read before each app's shutdown, not just the preparation snapshot.
    $Revisions = @(Read-AzJson -List -Arguments
        (@('containerapp', 'revision', 'list', '--all') + $Scope))
    foreach ($Revision in $Revisions | Where-Object { $_.properties.active -eq $true }) {
        Write-Az (@('containerapp', 'revision', 'deactivate',
            '--revision', $Revision.name) + $Scope)
    }
    Assert-Stopped $App
}
```

Each successful list must return an array, even if empty; denial, 404, timeout or
an unexpected shape is not zero replicas. Compare re-read revision names to the
snapshot and investigate unexplained additions/disappearances. Require all former
revision names inactive and zero replicas, including any formerly labelled/direct
revision routes. Verify the Cockpit's canonical domain no longer serves the UI and
its existing WebSocket connections are closed. A failed HTTP request alone is not
process-stop proof. Recheck the backend immediately before its update. If Single
mode deactivation is rejected by this environment, abort: do not change to Multiple
mode, disable ingress/auth, or assume a rolling update is safe.

## Scoped replacement, backend first

The following is the actual profile-conversion mechanism: existing CLI update
flags add only `DEMO_PROFILE` while preserving other env entries. One backend
update combines the reviewed image, profile and min/max 1; it may start the new
revision immediately. Both old apps must already satisfy the stop gate.
Do not use provisioning (which intentionally rejects conversion) or the
image-only updater (which intentionally preserves the profile).

```powershell
Assert-Stopped $Cockpit
Assert-Stopped $Backend
Write-Az @('containerapp', 'update', '--subscription', $Sub, '--resource-group', $Rg,
    '--name', $Backend, '--container-name', 'streaming-backend',
    '--image', $BackendImage, '--set-env-vars', 'DEMO_PROFILE=synthetic',
    '--min-replicas', '1', '--max-replicas', '1', '--revision-suffix', $Suffix)
```

Before updating Cockpit, read app/revision/replica/auth state again. Require backend
`Succeeded`, exactly the approved digest/profile, Single, min/max 1, latest100%;
exactly one active ready revision with exactly one running application replica;
and every former revision inactive/zero replicas. Record exact new revision name.
Do not infer readiness from command exit, `/healthz`, or `latestRevisionName`.
Compare retained configuration and identities to `$Before`, and auth to
`$AuthBefore`, using a private semantic diff. The **only** approved template
differences are image, `DEMO_PROFILE`, backend min/max and revision suffix;
ignore service-generated status/timestamps, not configuration. Unexpected changes,
labels serving an old revision, extra replicas or auth drift halt exposure.

An anonymous direct backend application request must still be denied (401 or
configured login redirect, never application data); do not follow redirects and
mistake a login page for success. The unchanged backend boundary remains mandatory.
Keep the Cockpit stopped until these checks pass.

```powershell
Assert-Stopped $Cockpit
Write-Az @('containerapp', 'update', '--subscription', $Sub, '--resource-group', $Rg,
    '--name', $Cockpit, '--container-name', 'cockpit',
    '--image', $CockpitImage, '--set-env-vars', 'DEMO_PROFILE=synthetic',
    '--revision-suffix', $Suffix)
```

This second write reopens the approved public Cockpit; there is no claim of a
hidden pre-exposure browser test. Require the corresponding image/profile,
Single/latest100%, retained min/max 1, one ready revision/replica and all former
Cockpit revisions inactive/zero replicas. Repeat both apps' preserved-state/auth
comparison and old-backend-zero checks. Never reactivate a former synthetic
backend alongside its replacement.

## Immediate hosted acceptance and failure containment

At the canonical Cockpit domain, use a fresh unsigned-in desktop and mobile browser:
labelled synthetic context/history/analyses/alerts; real session/race starts,
REST results and WSS frames; completion summaries; cancellation with no fabricated
finish; deterministic non-LLM assistant; concurrent 409 and two-per-minute 429
with positive Retry-After; invalid athlete denied. Use actual routes from
`/api/context`, not pathless `/api/analyses` or `/api/alerts`. Capture redacted
screenshots/results and actual browser version. Verify no live data/cloud fallback.
Exercise the proxy without injecting any browser Authorization header: success
behind unchanged backend Easy Auth is required evidence for hosted MI REST/WSS.
Local tests do not provide that evidence.

Observe one active backend replica during runs, no former replicas, and expected
readiness/provenance. Controlled restart resets state/quota and loses unfinished
runs; test it only as an approved additional downtime event using the same stop
gate, not an overlapping restart. One replica is not a distributed-lock guarantee
during platform maintenance; retain this limitation in the release record.

On failure or unknown delivery, halt further updates. Deactivate the **currently**
active Cockpit revisions first, then backend revisions, and repeat the stop gate;
record partial state rather than success and do not blindly retry. Do not call
restart or reactivate old revisions to conceal failure. A separately approved
rollback uses the same outage/zero-replica procedure: restore the recorded live
digest and remove only `DEMO_PROFILE` with `--remove-env-vars DEMO_PROFILE`
(or restore its recorded explicit live value), restore recorded backend min/max,
verify preserved config/auth, then restore Cockpit. Do not restore full exported
ARM documents or overwrite secrets/connections.

## Command provenance

CLI flags were inspected without writes on Azure CLI 2.92.0 with its existing
containerapp extension. Syntax inspection is not deployed operational proof.
[Microsoft revision management](https://learn.microsoft.com/en-us/azure/container-apps/revisions-manage)
documents that deactivation stops all replicas and revision-scope updates create
new revisions. [CLI update](https://learn.microsoft.com/en-us/cli/azure/containerapp#az-containerapp-update)
documents additive env updates and replica/image flags. No new script, CI,
provisioning, access policy or cloud resource is introduced by this document.
