# Fabric triathlon twin

A Microsoft Fabric triathlon-training digital twin, with synthetic telemetry,
training analyses, alerts, and a Cockpit operator interface.

The same Cockpit supports an account-free synthetic demo and protected live
execution. Live execution requires your own Azure, Fabric and optional
Foundry/Power BI configuration. The legacy Console remains for a following,
narrow cleanup; no separate UI is needed for the synthetic demo.
No private deployment history or operational data is included.

## Account-free demo

Install Node.js 24 or newer (with npm), clone this repository, and run this one
command from its root on Windows, macOS, or Linux:

```text
node scripts/demo.mjs
```

The launcher restores the locked dependencies, builds the apps, starts one
synthetic backend and the **real Cockpit**, and waits for both health checks.
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
- [ ] Consolidate the Console into the Cockpit with bounded anonymous race controls.
- [ ] Verify live Fabric/Foundry paths and document human consent/platform gates.
- [ ] Complete portable architecture, costs, recovery, demo and operator documentation.

Each remaining item is an independently reviewed, bounded pull request.
