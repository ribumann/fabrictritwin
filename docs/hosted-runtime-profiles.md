# Hosted runtime profiles

This declarative safeguard does **not** activate a hosted synthetic demo. Deployment
requires reviewed compatible runtime images, separate deployment approval, and the
hosted proxy authentication fix described below. No cloud resources, permissions,
authentication policies, images, or public access are changed by publishing this PR.

## Explicit profiles

`infra/bicep/main.bicep` and its backend/Cockpit modules accept `demoProfile` with
exact values `live` (default) and `synthetic`. Invalid values fail template validation.

| Configuration | Live | Synthetic |
| --- | --- | --- |
| Backend and Cockpit `DEMO_PROFILE` | Omitted | `synthetic` on both |
| Backend min/max replicas | 1 / 3 | 1 / 1 |
| Backend revisions and traffic | Single; 100% latest | Single; 100% latest |
| Backend Easy Auth | Entra required, existing MI allowlist | Unchanged |
| Cockpit Easy Auth | Existing anonymous frontend with Entra provider | Unchanged |
| Identities, secrets, other workloads | Existing settings | Unchanged |

The runtime selects live when `DEMO_PROFILE` is unset; an empty or unknown value
fails startup. Profile selection is not an authentication bypass. Live retains
its cloud-backed paths and existing credential configuration. Synthetic uses
bounded in-memory sample application data, not Fabric/Foundry/Power BI data.

## Local versus hosted synthetic paths

The local synthetic path runs backend on port 3000 and the **one Cockpit UI**
on port 3300 without application data credentials. Browser REST/WebSocket calls
go through the Cockpit to `STREAMING_BACKEND_BASE_URL`.

Hosted synthetic uses the same application profile but must retain backend Entra
protection. Visitors need no account for synthetic application data; the hosting
operator still needs authorized Azure deployment access, and the Cockpit proxy
must use its existing managed identity for backend REST and WSS calls.
The template retains `AZURE_CLIENT_ID`, `STREAMING_BACKEND_SCOPE` and the backend
Cockpit MI allowlist for this purpose. Do not make the backend anonymous.

**Runtime dependency:** the original synthetic runtime suppressed proxy auth for
localhost. Hosted activation requires a reviewed runtime that acquires MI tokens
for every non-loopback synthetic upstream, on both REST and WebSocket paths.
That upstream must be HTTPS with `STREAMING_BACKEND_SCOPE` configured; missing scope
or non-loopback HTTP must fail startup, never fall back to anonymous access.
Only localhost, 127.0.0.1 and [::1] retain the credential-free local path.
A successful local smoke test
does not prove this protected hosted path works. New compatible images and hosted
verification are required before describing the demo as active.

## Admission and revision limitation

Synthetic admission is process-local: one run, no queue, bounded memory, and two
accepted starts per rolling minute per backend process. There is no distributed
lock or rate limiter. `minReplicas: 1`, `maxReplicas: 1`, Single revision mode and
100% latest-revision traffic prevent steady-state scale-out and traffic splitting.
They do **not** guarantee only one process during rolling replacement, restarts or
platform maintenance. Old/new revisions or replicas may overlap while draining,
and process restart resets in-memory history and admission limits.

Before changing images or profiles, quiesce public admission and drain/stop active
runs and connections through a separately approved operational procedure. Verify
the former backend is no longer serving before reopening admission on the replacement.
Do not promise a global rolling limit across replacement or expose multiple
backends behind the Cockpit without a future distributed admission design.

## Deployment preparation (not executed here)

For a separately reviewed direct Bicep deployment, include `"demoProfile":
{"value": "synthetic"}` in the existing ARM parameters JSON and supply a real,
reviewed `imageTag` that implements the synthetic and hosted MI contracts.
Use the existing authorized subscription/resource group and preserve all current
identity, secret, auth and runtime parameters; do not deploy with bootstrap images.
Compile without Azure changes:

```powershell
bicep build infra\bicep\main.bicep --outfile "$env:TEMP\hosted-profile-main.json"
```

`provision-azure-resources.ps1`, `provision-all.ps1` and
`configure-simulator-connections.ps1` accept explicit `-DemoProfile synthetic`
or `-DemoProfile live`. These are provisioning commands, **not** safe profile-switch
commands for the existing environment. They may provision Azure/Fabric/Entra state.
When omitted, existing backend/Cockpit profiles are read and inherited for any
missing counterpart, or live is used if neither exists. Existing workloads remain
bypassed by `preservedWorkloads`: their images/env/secrets/auth are never copied or
reset. An explicit profile mismatch, invalid retained profile, mixed profiles or
unsafe retained synthetic backend scale/revision/traffic fails rather than silently
ignoring the requested profile.

`deploy-container-apps.ps1` updates images and ingress ports only; it does not select
or reset profiles or change scaling/auth. Runtime connection overlays preserve
unowned environment variables. Therefore deploying an image alone does not convert
the existing live deployment to synthetic. An authorized existing-environment
profile change needs a scoped, separately reviewed runtime configuration update;
re-running provisioning with `-DemoProfile synthetic` intentionally refuses it.

Before exposure, verify both deployed images, both exact profile env values,
backend min/max 1, Single mode and latest-only traffic, no prior serving revision
or alternate job/process serving synthetic requests,
retained Entra/MI protection, anonymous Cockpit REST/WSS functionality through MI,
bounded admission and restart behavior. This PR adds no second UI and does not
retire or otherwise change existing workloads.
