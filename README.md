# Fabric triathlon twin

A Microsoft Fabric triathlon-training digital twin, with synthetic telemetry,
training analyses, alerts, and a Cockpit operator interface.

The same Cockpit supports an account-free synthetic demo and protected live
execution. Live execution requires your own Azure, Fabric and optional
Foundry/Power BI configuration. Cockpit is the only operator UI shipped by this
repository. Legacy Console source, provisioning, and release targets are retired.
This does not delete a previously deployed cloud Console app or identity; exact
cloud cleanup remains a separate, review-gated operation.
The [public Cockpit demo](https://ontologydemo.liberatetheinnerchild.net/)
remains cloud-connected to an existing Fabric environment and uses generated
synthetic data. This is different from the account-free
`DEMO_PROFILE=synthetic` local in-memory path below. The deployed legacy Console
is intentionally left running; source retirement does not retire the cloud app.
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

## D01 mining extension: live raw path, readiness gated

The repository also contains a separate Fabric-backed D01 mining extension.
Mining uses its own Eventstream, Eventhouse, KQL database, and raw tables in the
existing workspace and capacity; it does not share or modify the triathlon
Eventstream or database.

As of 14 November 2026, a bounded two-message canary reached the mining raw
telemetry and state tables. The raw `timestamp_raw` projection preserved the
sent UTC millisecond strings, and ingestion timestamps were present. Ten
mining-scoped KQL functions and seven retention policies have been deployed.
However, both validators currently return `BLOCKED_SOURCE_CONTRACT`; curated and
quarantine tables remain empty, and no raw-to-curated materialization is
enabled. Mining start, read, and cancel runtime paths remain default-off. The
public [Cockpit Mining view](https://ontologydemo.liberatetheinnerchild.net/mining)
is reachable, but it is not yet a live operational mining demo.
The account-free local synthetic demo remains triathlon-only; it does not
generate or display simulated mining data.

End-to-end mining still requires an explicit sole-writer decision and approval
for a private run-state Blob container with narrowly scoped access for the
backend identity. Its bootstrap also requires a separately protected
`azure-mining-bootstrap` environment and dedicated OIDC identity; the
unattended app-image deployment environment is not sufficient. Those gates are
not satisfied by the account-free synthetic triathlon demo or by the raw
canary. See the [mining architecture and dated
evidence](docs/release-architecture.md#isolated-d01-mining-path-readiness-gated)
and the [dependency and permission inventory](docs/dependencies-and-configuration.md).

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
- [x] Add Copilot cloud setup and credential-free CI; cloud availability and baseline limitations are documented separately.
- [x] Publish the portable configuration/identity inventory and contributor/security guidance.
- [x] Add credential-free Actions CI and guarded, manual image publication and deployment workflows.
- [x] Provide an account-free synthetic demo using the same Cockpit.
- [x] Consolidate the operator UI into Cockpit and retire the legacy Console from source and release configuration.
- [x] Record bounded live Fabric evidence and the remaining human consent/platform gates.
- [x] Document the live architecture, operator recovery, demo profiles and release handoff.
- [ ] Complete Fabric-backed D01 mining source-to-Cockpit acceptance after the required writer and private-state decisions.
- [ ] User acceptance testing of the actual serving public runtime.

The deployed legacy Console remains running; no cloud cleanup is required for
this release. Publication of an image, deployment of a revision and a successful
user acceptance test are separate events. The user owns final UAT; no further
automated release QA is planned. See the [operator handoff](docs/live-runtime-operations.md#release-operator-handoff)
and [dated evidence and limitations](docs/release-architecture.md#live-history-schema-and-telemetry-are-distinct-paths).
