# Protected image-update deployment

GitHub Actions is the normal remote validation/deployment entry point. `CI` runs
build, Vitest, ESLint, formatting, Pester mock tests and Bicep compilation on PRs
and main pushes without Azure credentials. Existing PowerShell scripts remain
reusable; imported provisioning, teardown, image-build and scheduling workflows
remain quarantined. This foundation intentionally does not enable them.

`Deploy one existing app image` is a **manual, main-only** workflow. Its default
`deploy: false` performs read-only preflight; an update also requires
`deploy: true`, an enabled environment and environment approval. It updates one
existing `cockpit`, `streaming-backend`, `mcp-tools` app or `simulator` job, never
Console. Supply an existing, reviewed `sha256:<64 lowercase hex>` digest from
that app's repository in the configured ACR. There is no tag fallback, Docker
build, image push, resource creation/deletion, job start or capacity resume.

## Administrator prerequisites (not provisioned by this change)

Create the `azure-deploy` GitHub environment **before enabling it**. Configure
required reviewers, prevent self-review, disable administrator bypass where
available, and allow only the protected `main` deployment branch. Protect main
with required CI and independent review; do not enable this workflow if the
repository's plan cannot enforce these controls. Environment naming in YAML
alone is not protection.

Set environment variables (identifiers, never client secrets):

| Variable | Meaning |
| --- | --- |
| `DEPLOYMENT_ENABLED` | Exact `true` only after scope, identity and protection review |
| `AZURE_DEPLOY_CLIENT_ID` | A separate deployment identity, not the Reader canary |
| `AZURE_DEPLOY_TENANT_ID` | Target resource directory |
| `AZURE_DEPLOY_SUBSCRIPTION_ID` | Explicit approved subscription |
| `AZURE_DEPLOY_RESOURCE_GROUP` | Existing app/ACR resource group |
| `AZURE_DEPLOY_NAME_PREFIX` | Existing workload prefix |
| `AZURE_DEPLOY_REGISTRY_NAME` | Existing public-Azure ACR name |

Use GitHub issuer `https://token.actions.githubusercontent.com` and audience
`api://AzureADTokenExchange`. Before granting deployment rights, confirm the
new environment's actual subject with a trusted, read-only OIDC canary. This
repository has observed immutable-ID subjects; the expected subject for the new
environment is
`repo:ribumann@46997953/fabrictritwin@1449513330:environment:azure-deploy`.
That expectation is **not yet a verified azure-deploy token**. Never use a
wildcard or a name-only replacement, and never broaden the existing
`azure-canary` Reader identity.

Minimum proposed grants, subject to administrator/provider verification:

| Surface | Proposed permission and scope |
| --- | --- |
| ARM | Read subscription metadata; read the exact ACR resource |
| ARM app | `Microsoft.App/containerApps/read` and `/write` on each approved app only |
| ARM job | `Microsoft.App/jobs/read` and `/write` on the simulator job only, if approved |
| ACR data | Manifest read for the selected repositories: `AcrPull` on legacy RBAC registries, or repository-conditioned `Container Registry Repository Reader` for ABAC registries |
| Runtime pulls | Preserve each existing workload managed identity and its pull permissions |
| Entra/Graph, Fabric, DNS, Key Vault data, Foundry | No new permissions; no calls/writes from this workflow |

ARM does not provide an image-field-only write role: an app/job write grant can
modify other resource fields even though this script does not. Treat the
deployment identity and main workflow as privileged. Do not grant subscription
or resource-group Contributor/Owner. ACR metadata reads are data-plane access;
ARM Reader alone does not prove them. Federated login success does not prove
runtime image-pull access or live Fabric functionality.

## Preservation and failure behavior

`update-app-image.ps1` checks the exact resource ID, readiness, ACR manifest,
container name, existing non-bootstrap image, expected app port and Single
revision mode. Command/argument overrides and sidecars require separate review.
It uses only `az containerapp [job] update --container-name ... --image ...`;
it never reapplies Bicep or mutates ingress, secret overlays, environment values,
identity, scale, authentication, traffic rules, domains or schedules.

Afterward it verifies the digest/readiness and compares non-image configuration
in memory without logging runtime values. Revision suffix changes are expected.
No-op and WhatIf results are labelled `Unchanged` and `NotApplied`, not deployed.
Failure/timeout is not success and is not blindly retried or automatically
rolled back. A configuration mismatch occurs **after a write** and needs scoped
operator inspection. Serialize other configuration work too; Actions concurrency
only serializes this workflow, not portal or external operators.

Custom-domain DNS/CNAME, managed certificate binding, custom Entra callback and
authConfig are not rewritten. Before and after an approved live update, the
operator must verify the canonical HTTPS hostname, certificate, custom-origin
sign-in callback and same-origin API/WebSocket routes, as well as revision
health and secret-reference/identity preservation. Updating a simulator image
preserves an existing schedule; it does not pause scheduled executions.
Fabric capacity may be paused; HTTP reachability or ARM success is not a live
integration test. First bootstrap, ingress repair, multi-revision traffic changes,
TLS/DNS reconciliation and infrastructure recreation need separate approval/work.

For local read-only preflight:

```powershell
./scripts/deploy/update-app-image.ps1 `
  -SubscriptionId '<approved-subscription-id>' `
  -ResourceGroupName 'rg-example' -NamePrefix 'example-dev' `
  -RegistryName 'exampledevacr' -App cockpit `
  -ImageDigest 'sha256:<approved-64-character-digest>' -WhatIf
```

Do not dispatch a real update until the coordinator has approved the exact
resource IDs, proposed write and permissions, configured the environment and
verified its OIDC subject. Image provenance and application compatibility are
operator approval requirements; a digest pins content but does not certify it.
