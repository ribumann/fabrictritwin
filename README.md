# Fabric triathlon twin

A Microsoft Fabric triathlon-training digital twin, with synthetic telemetry,
training analyses, alerts, and a Cockpit operator interface.

The same Cockpit supports an account-free synthetic demo and protected live
execution. Live execution requires your own Azure, Fabric and optional
Foundry/Power BI configuration. Cockpit is the only operator UI shipped by this
repository. Legacy Console source, provisioning, and release targets are retired.
This does not delete a previously deployed cloud Console app or identity; exact
cloud cleanup remains a separate, review-gated operation.
No private deployment history or operational data is included.

## Account-free demo

Install Node.js 24 or newer (with npm), clone this repository, and run this one
command from its root on Windows, macOS, or Linux:

```text
node scripts/demo.mjs
```

The launcher restores the locked dependencies, builds the apps, starts one
synthetic backend and the **real Cockpit**, and waits up to 60 seconds per service
for both health checks.
Open **http://localhost:3300**. No Azure/Fabric/Foundry credentials, Docker,
PowerShell, sign-in, or cloud resources are needed. Initial package restoration
needs internet access. Ports 3000 and 3300 must be free. Ctrl+C stops both services;
a startup or runtime process failure stops its companion and exits unsuccessfully.

Read the labelled synthetic training chart, analyses and alerts; choose **Start
session** or **Start race**, watch streamed telemetry, and read the completion
summary. All visitors share one active run, with no queue and at most two starts
per minute. A conflict or rate limit gives retry feedback. **Cancel run** ends a
synthetic run without fabricating a finished race summary. The assistant is a
labelled deterministic explanation, not a Foundry model/LLM. Power BI and MCP are
live-only, not hidden synthetic substitutes.

State and limits are local to **one backend process**. This is not distributed
admission control: never deploy multiple synthetic backend replicas without
first adding shared admission/storage. Restart resets runs, limits, and seeded
history. There is no resume, replay queue, cloud ingestion or durable result
storage. `DEMO_PROFILE=synthetic` is an exact opt-in for both services; unset
preserves live defaults and authorization. See
[synthetic runtime details](docs/synthetic-runtime-foundation.md).

For hosted synthetic use, keep the backend's service-authentication boundary:
set the Cockpit's `STREAMING_BACKEND_BASE_URL` to the backend's HTTPS origin and
configure the existing `STREAMING_BACKEND_SCOPE` for its managed identity.
Only HTTP loopback (`localhost`, `127.0.0.1`, or `[::1]`) bypasses service-token
acquisition for the local demo. A non-loopback HTTP upstream or a hosted HTTPS
upstream without a scope fails at startup; it never retries anonymously.

## Fabric-connected public runtime

Keep `DEMO_PROFILE` unset (or `live`) to use the existing Fabric configuration.
The same Cockpit exposes **Start session** and **Start race**: choose/apply an
athlete above, and use the derived goal race or an explicit seeded race ID.
Starts use the Cockpit's existing managed identity and backend athlete allowlist;
they do not require forwarding a visitor's token or opening backend Easy Auth.
Seeded history is required; missing history returns 422 and unauthorized context
returns 403. No public seed/admin action is provided.

Nothing runs until a visitor selects Start. These are simulator-generated
demonstrations delivered through the **real configured Eventstream publisher**,
not sensor readings or the account-free synthetic profile. Sessions emit 36
samples over about 70 seconds; races emit 48 splits over about 47 seconds using
the selected race's catalog distance. Invalid/foreign races are denied before
publication. The Cockpit displays actual
stream lifecycle, received session metrics and race summaries. Publisher
completion is **not** proof of downstream Fabric ingestion.
**Active alerts (N)** is collapsed by default; select it to read the unchanged
alert details. Refresh updates the real returned count without closing an open
disclosure. Loading/unavailable states are not reported as zero alerts.

Live admission rejects concurrent runs with 409 **per backend process**. It has
no synthetic two-per-minute quota, cancellation, persisted session summary,
distributed lock, or stream replay. Session summaries describe samples received
in the current browser, not a complete durable audit. Disconnection/reload or
restart can lose run observations; a timeout is not proof that a start failed.
Multiple backend replicas can split control requests, streams and race state;
there is no environment-wide single-run guarantee. UAT and ingestion evidence
must use the actual deployed configuration; local/synthetic proof cannot replace
them. Leave any existing deployed Console running until separately authorized
to retire it; source consolidation does not delete its cloud resource.

## Development

Use Node.js 24 or newer, npm, PowerShell 7 and Pester 5.6.1:

```powershell
npm ci --registry=https://registry.npmjs.org
npm run build
npm test
npm run lint
npm run format
pwsh -File tests/pester/Run-Tests.ps1
```

The default Pester runner excludes live `Integration` tests. Azure CLI and Bicep
are required for infrastructure compilation; Docker is required for image builds.
The Copilot setup pull request records cloud validation results. These commands
are not a claim that every optional live integration is ready.
See [contributing guidance](CONTRIBUTING.md) and the
[dependency, configuration, identity, network, and resource inventory](docs/dependencies-and-configuration.md)
before attempting a live deployment.

## Publication safety

Imported cloud workflows are quarantined in `.github/disabled-workflows` with
`.disabled` suffixes. They cannot run on push, schedule, or dispatch. Do not enable
them before reviewing inputs, secrets, OIDC, protected environments and deployment
targets. No cloud credentials are provisioned by cloning this repository.

New simulator jobs default to manual execution. Daily cloud scheduling requires
the explicit Bicep `enableSimulatorSchedule` opt-in after deployment configuration.
Supply your own Fabric capacity administrator; no tenant identity is preconfigured.

The new [protected image-update pipeline](scripts/deploy/README.md) is manual,
main-only and disabled until an administrator configures and enables its protected
environment. It deploys one approved existing ACR digest without reprovisioning
resources or resetting runtime configuration. PR/push CI has no cloud credentials.

Nonpublic tooling, development provenance, private deployment notes and
account identifiers have been excluded. Test identifiers and hostnames are fictional.
See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licensing.
See [security reporting guidance](SECURITY.md) for vulnerability disclosures.

## Release checklist

- [x] Publish fresh history with MIT licensing and dependency notices.
- [x] Keep imported cloud automation inactive and remove private deployment defaults.
- [ ] Land and verify Copilot cloud setup, reporting unavailable tools and baseline failures.
- [x] Publish the portable configuration/identity inventory and contributor/security guidance.
- [ ] Add safe Actions CI and prove protected deployment before application changes.
- [x] Provide an account-free synthetic demo using the same Cockpit.
- [x] Consolidate the operator UI into Cockpit and retire the legacy Console from source and release configuration.
- [ ] Inventory and separately approve cleanup of any pre-existing cloud Console app, identity, and stale callback/authorization entries.
- [ ] Verify live Fabric/Foundry paths and document human consent/platform gates.
- [ ] Complete portable architecture, costs, recovery, demo and operator documentation.

Each remaining item is an independently reviewed, bounded pull request.
