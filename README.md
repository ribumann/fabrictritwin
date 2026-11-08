# Fabric triathlon twin

A Microsoft Fabric triathlon-training digital twin, with synthetic telemetry,
training analyses, alerts, and a Cockpit operator interface.

The same Cockpit supports an account-free synthetic demo and protected live
execution. Live execution requires your own Azure, Fabric and optional
Foundry/Power BI configuration. Cockpit is the only operator UI shipped by this
repository. Legacy Console source, provisioning, and release targets are retired.
This does not delete a previously deployed cloud Console app or identity; exact
cloud cleanup remains a separate, review-gated operation.
The public runtime demo remains cloud-connected to an existing Fabric environment
and uses generated synthetic data. This is different from the account-free
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
- [ ] User acceptance testing of the actual serving public runtime.

The deployed legacy Console remains running; no cloud cleanup is required for
this release. Publication of an image, deployment of a revision and a successful
user acceptance test are separate events. The user owns final UAT; no further
automated release QA is planned. See the [operator handoff](docs/live-runtime-operations.md#release-operator-handoff)
and [dated evidence and limitations](docs/release-architecture.md#live-history-schema-and-telemetry-are-distinct-paths).
