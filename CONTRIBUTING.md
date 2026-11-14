# Contributing

Thank you for helping improve the Fabric triathlon twin. The repository is
licensed under MIT; see [`LICENSE`](LICENSE) and
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Local checks

Use Node.js 24 or newer, npm, PowerShell 7, and Pester 5.6.1:

```powershell
npm ci --registry=https://registry.npmjs.org
npm run build
npm test
npm run lint
npm run format
pwsh -File tests/pester/Run-Tests.ps1
```

The Pester runner is for mock/unit tests and excludes live `Integration` tests.
Azure CLI with Bicep is needed only to compile infrastructure templates; Docker
is needed only to build images. See
[`docs/dependencies-and-configuration.md`](docs/dependencies-and-configuration.md)
for the live cloud prerequisites and configuration boundaries.

Credential-free `ci.yml` runs on every pull request and on pushes to `main`,
covering the build, JavaScript tests, lint, formatting, mock PowerShell tests,
and Bicep compilation. The separate Copilot setup workflow runs only when its
own file changes and on manual dispatch; it verifies runner tooling and setup
capabilities. Neither workflow deploys cloud resources or validates live
Azure/Fabric access.

## Changes involving cloud resources

Keep pull requests focused and explain the resource, identity, permission,
network, and cost impact of infrastructure or provisioning changes. Do not use
real tenant IDs, principal IDs, hostnames, tokens, SAS strings, client secrets,
or deployment outputs in examples or test fixtures. Use fictional values only
when a sample is necessary.

Do not run live provisioning, credential setup, tenant-setting changes, scheduled
jobs, or teardown as part of ordinary local tests. These operations need an
explicitly selected tenant/subscription and resource scope, review of the exact
target, and any required human/admin approval. Never weaken TLS validation,
bypass policy denials, or add broad roles as a shortcut. Keep operational
workflows disabled until their permissions, OIDC trust, inputs, environments,
and deployment targets have been separately reviewed.

## Pull requests

Describe the user-visible or operational change, list the relevant checks and
their outcomes, and call out any checks not run or external prerequisites. Do
not claim a live test from a build or mock test. Avoid unrelated formatting or
generated files.
