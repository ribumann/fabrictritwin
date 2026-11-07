# Fabric triathlon twin

A Microsoft Fabric triathlon-training digital twin, with synthetic telemetry,
training analyses, alerts, and a Cockpit operator interface.

This is the initial public-release bootstrap, not the completed account-free
demo. Live execution currently requires your own Azure, Fabric and optional
Foundry/Power BI configuration. The Console is retained until a later, reviewed
Cockpit consolidation. No private deployment history or operational data is included.

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
Cloud validation results will be recorded in the first Copilot setup pull request.
These commands are not a claim that the baseline currently passes every check.

## Publication safety

Imported cloud workflows are quarantined in `.github/disabled-workflows` with
`.disabled` suffixes. They cannot run on push, schedule, or dispatch. Do not enable
them before reviewing inputs, secrets, OIDC, protected environments and deployment
targets. No cloud credentials are provisioned by cloning this repository.

New simulator jobs default to manual execution. Daily cloud scheduling requires
the explicit Bicep `enableSimulatorSchedule` opt-in after deployment configuration.
Supply your own Fabric capacity administrator; no tenant identity is preconfigured.

Nonpublic tooling, development provenance, private deployment notes and
account identifiers have been excluded. Test identifiers and hostnames are fictional.
See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency licensing.

## Release checklist

- [x] Publish fresh history with MIT licensing and dependency notices.
- [x] Keep imported cloud automation inactive and remove private deployment defaults.
- [ ] Land and verify Copilot cloud setup, reporting unavailable tools and baseline failures.
- [ ] Publish the complete portable configuration/identity inventory and contributor/security guidance.
- [ ] Add safe Actions CI and prove protected deployment before application changes.
- [ ] Provide an account-free synthetic demo using the same Cockpit.
- [ ] Consolidate the Console into the Cockpit with bounded anonymous race controls.
- [ ] Verify live Fabric/Foundry paths and document human consent/platform gates.
- [ ] Complete portable architecture, costs, recovery, demo and operator documentation.

Each remaining item is an independently reviewed, bounded pull request.
