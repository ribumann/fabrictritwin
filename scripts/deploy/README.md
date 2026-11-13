# Protected image-update deployment

GitHub Actions is the normal remote validation/deployment entry point. `CI` runs
build, Vitest, ESLint, formatting, Pester mock tests and Bicep compilation on PRs
and main pushes without Azure credentials. Existing PowerShell scripts remain
reusable; imported provisioning, teardown, image-build and scheduling workflows
remain quarantined. This foundation intentionally does not enable them.

`Container images (build only)` separately builds and smoke-tests all four current
production images on PRs, main pushes and manual dispatch. See
[the build-only contract](../../tests/containers/README.md). It has no registry
push, Azure identity or deployment step.

`Publish one approved app image` is a **manual, main-only** workflow using the
separate `azure-build` environment. `publish: false` verifies the actual OIDC
subject, exchanges the token and reads ACR metadata, without building, logging
into the registry or requiring push permission. It works while `PUBLISH_ENABLED`
is unset or `false`. `publish: true` additionally requires `PUBLISH_ENABLED` to be
exactly `true` and environment approval for each job. The selected image is built
and smoke-tested before Azure login, then pushed to its matching repository with
the full main commit SHA as its tag. The retired Console is not a build or
publication target.

The summary records the source revision, app and digest returned by Docker's
push. Supply that digest, not the tag or local image ID, to the deployment
workflow. Tags can be moved and a revision label is not a signed attestation;
review the run, source and digest together. Never assume a rebuild is
byte-identical. If a push succeeds but digest capture fails, inspect the registry
before retrying; failure is not proof that no manifest was written.

### Build environment prerequisites

Before any dispatch, create `azure-build` with required independent reviewers,
no self-approval or administrator bypass where available, and protected `main`
as its only allowed deployment branch. Protect main with required checks and
independent review. If the repository plan cannot enforce these controls, do
not enable publication. Environment naming alone is not protection.

Set `AZURE_BUILD_CLIENT_ID`, `AZURE_BUILD_TENANT_ID`,
`AZURE_BUILD_SUBSCRIPTION_ID`, and `AZURE_BUILD_REGISTRY_NAME` as environment
variables. Set `PUBLISH_ENABLED` to exact `true` only after the actual preflight,
review and explicit authorization; leave it unset or `false` otherwise.
No client secret or registry admin credential is used.

Configure a separate identity with issuer
`https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, and the exact immutable subject
`repo:ribumann@46997953/fabrictritwin@1449513330:environment:azure-build`.
Run and review `publish: false` first; it checks the actual subject and Azure
exchange rather than assuming a name-only subject. A successful exchange does
not establish write access. Registry metadata lookup requires ARM read on the
specific existing ACR and may additionally require subscription-level registry
discovery/read metadata, depending on Azure CLI behavior and policy; diagnose a
denial rather than broadening permissions blindly.

After preflight and separate approval, propose `AcrPush` at the exact registry
for an RBAC registry, or a repository-conditioned
`Container Registry Repository Writer` for an ABAC registry, scoped to approved
app repositories. Check the registry's permission mode and applicable role
requirements first. No registry admin, Owner, Contributor, runtime deployment,
Fabric or Entra write permissions are required. The workflow never deploys,
starts jobs or creates infrastructure. The protected environment and trusted
main source remain security boundaries because registry write access can also
modify tags. Both jobs use the same build identity: after write access is granted,
the preflight still performs only reads but its token is no longer read-only.

`Deploy one existing app image` is a **manual, main-only** workflow. Its default
`deploy: false` performs read-only preflight; an update also requires
`deploy: true`, an enabled environment and environment approval. It updates one
existing `cockpit`, `streaming-backend`, `mcp-tools` app or `simulator` job. Supply
an existing, reviewed `sha256:<64 lowercase hex>` digest from
that app's repository in the configured ACR. There is no tag fallback, Docker
build, image push, resource creation/deletion, job start or capacity resume.
These repository changes do not delete any pre-existing Console cloud resources
or authorization state; that exact-scope cleanup is separate and review-gated.

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

## Protected mining private-state bootstrap (separate release item)

`Prepare private mining state` is manual, main-only and uses the same protected
`azure-deploy` environment and deployment concurrency group. **This source change
does not authorize a dispatch or any cloud write.** Keep
`MINING_STATE_BOOTSTRAP_ENABLED` unset or `false` until native environment
protection, private target review and explicit write authorization are complete.
Require independent reviewers, no self-approval/bypass and main-only deployment
branches as described above; do not enable this on a repository plan that cannot
enforce those controls.
The reusable script also rejects non-WhatIf apply outside the expected main
workflow context. Local use is preview-only. Context checks prevent accidental
misuse; native GitHub protections and narrowly federated Azure authorization,
not caller-set environment strings, remain the security boundary.

The script defaults to read-only preview. It validates the exact tenant,
subscription and deployment service principal; the existing ready StorageV2
account must already disable shared-key and public-blob access. It verifies the
existing backend and the **explicitly selected attached UAMI**, including its
resource ID, tenant, client ID and principal ID. It probes the selected Blob
endpoint with Entra HEAD requests to frontload network and read-access failures.
It reads container and scoped role metadata, including pagination; a denied or
ambiguous read is a blocker, not evidence that a resource is absent. All targets
are in the explicitly configured resource group in public Azure.

An approved apply may create only the missing dedicated private container and
grant `Storage Blob Data Contributor` to that UAMI **at that container scope**.
The [Blob Create Container API](https://learn.microsoft.com/en-us/rest/api/storageservices/create-container)
fails if the name exists; it cannot overwrite container settings. An existing
live private container is retained without modifying metadata or ACLs. Existing
exact unconditional assignments are retained even under a different assignment
name; new assignments use a deterministic name derived from scope, principal and
role. A conflicting deterministic assignment or conditional matching role stops
the operation. Inherited grants are not created, changed or represented as a
least-privilege audit of the estate.

### Protected environment variables

Reuse `AZURE_DEPLOY_CLIENT_ID`, `AZURE_DEPLOY_TENANT_ID`,
`AZURE_DEPLOY_SUBSCRIPTION_ID` and `AZURE_DEPLOY_RESOURCE_GROUP`. Do not put
actual target identifiers, snapshots or private plan files in public source,
issues, PRs or Actions artifacts. Additional **environment-level** variables:

| Variable | Required value |
| --- | --- |
| `MINING_STATE_CALLER_PRINCIPAL_ID` | Exact object ID of the deployment service principal, not the backend |
| `MINING_STATE_ACTOR_ID` | Numeric GitHub account ID of the authorized dispatching operator |
| `MINING_STATE_STORAGE_ACCOUNT` | Explicit existing StorageV2 account name |
| `MINING_STATE_CONTAINER` | Dedicated mining-state container name, never a shared/token container |
| `MINING_STATE_BACKEND_APP` | Exact existing streaming-backend app name |
| `MINING_STATE_IDENTITY_NAME` | Explicit existing attached UAMI resource name |
| `MINING_STATE_IDENTITY_CLIENT_ID` | That UAMI's expected client ID |
| `MINING_STATE_IDENTITY_PRINCIPAL_ID` | That UAMI's expected principal ID |
| `MINING_STATE_APPROVED_DIGEST` | Lowercase 64-hex digest of the privately reviewed exact plan; apply only |
| `MINING_STATE_BOOTSTRAP_ENABLED` | Exact `true` only after separate authorization; apply only |
| `MINING_STATE_EXCLUSIVE_WRITER_WINDOW_ID` | Private reference to the externally recorded, approved exclusive-writer window; not a lock |
| `MINING_STATE_ACKNOWLEDGE_NON_ATOMIC_UPDATE` | Exact `true` acknowledges non-atomic writes and the operator's external exclusion responsibility |

Both preview and apply require environment approval. The workflow verifies the
actual immutable-ID OIDC subject for `azure-deploy`, issuer, audience, repository
and owner IDs, actor ID, main ref, exact workflow path and source SHA before login.
Azure tokens must match the pinned deployment caller as well as tenant. The
environment subject expectation still needs actual canary verification; this
change does not prove a federated exchange or grant any rights. Reruns are
rejected: use a new dispatch, approvals and fresh preview after inspection.

### Permission and network review before authorization

Use the existing approved deployment identity only after reviewing its exact
rights. It needs account/app/UAMI/container metadata reads, scoped RBAC reads,
and Blob container properties read on the exact selected target. Missing
container previews require an authenticated `404 ContainerNotFound`; network
denials, firewall failures, other 404s and inaccessible metadata stop explicitly.
Hosted-runner reachability is not assumed. No firewall, private endpoint,
account policy or identity is altered to obtain access.

For an authorized create, the caller needs
`Microsoft.Storage/storageAccounts/blobServices/containers/write` for the
selected container and `Microsoft.Authorization/roleAssignments/write` at that
container scope. Have an administrator verify whether the exact child-scoped
grants, including creation of an absent child and Blob authorization, are
supported by the actual provider/policy. Never automatically broaden a denial
to account/RG/subscription Contributor, Owner, User Access Administrator or Blob
Data Contributor. Consider a custom role or administrator-managed conditions
constraining RBAC writes to the approved role and principal; the service's
authorization boundary, not the script, limits a compromised identity.
No Entra writes, account keys, SAS/delegation keys or secret values are required.
Existing OIDC and write capabilities are **untested**, not deployment-ready.

### Private plan review and apply

1. Prepare the exact main checkout and protected variables; keep all activation
   flags off. Dispatch with `apply: false` only after authorization for reads.
   The public summary contains only digest, fixed scope and status, never a raw
   plan or runtime configuration. Approval of a preview is not write approval.
   Before the final reviewed preview, record the external exclusive-writer window
   and non-atomic acknowledgement in the protected variables. Preview works
   without them, but its different digest cannot authorize a later window.
2. In an independently secured operator session, run
   `bootstrap-mining-state.ps1` (PowerShell 7.2+) with those exact values
   and `-SourceRevision (git rev-parse HEAD) -PrivatePlanPath <private-new-file>`.
   All target arguments are mandatory; there is no principal-selection fallback.
   Use an access-controlled directory outside the repository and synced/public
   artifact stores. The script refuses overwrites and private exports in Actions.
   The private file includes raw account/backend/UAMI/container/RBAC metadata,
   including runtime references: restrict access and retention accordingly.
   Use the approved deployment caller, or explicitly select an **already
   authorized service-principal read identity** with both
   `-PrivateReviewReaderClientId` and `-PrivateReviewReaderPrincipalId`. These
   options work only with a local private preview, never apply or Actions, and
   do not acquire credentials or grant permissions. Tokens must match that
   explicit reader; its IDs are recorded separately in private review evidence.
   The plan still pins the approved deployment caller, so independent private
   review does not require exporting a GitHub OIDC token or adding local
   credentials to an OIDC-only deployment identity.
   Also supply the same `-ExclusiveWriterWindowId` and
   `-AcknowledgeNonAtomicUpdate` values as the protected environment; both are
   inside the reviewed state/digest, not a digest-exempt approval overlay.
3. Independently review that file's exact targets, proposed create/no-op
   operations, caller, source and digest. Its digest must match the Actions
   preview. Store that digest in `MINING_STATE_APPROVED_DIGEST`, then authorize
   enablement separately. A digest is a binding, not permission or an attestation.
4. Dispatch `apply: true` with the same digest in `approved_digest`. Obtain native
   environment approval for this apply after reviewing its source and inputs.
   The script re-reads state, requires exact digest equality and checks again
   immediately before each write. Changed source, target, app settings, identity,
   account or scoped role metadata requires a new preview and private review.
   Do not reuse the original digest after a partial apply.

The local private preview and Actions preview must use consistent PowerShell/API
serialization, expected deployment caller and source. The review reader's identity
is evidence outside the plan digest, not a write authorization. There is deliberately no public plan
download, artifact upload, digest override or blind retry path.

### Non-atomic boundaries and explicit exclusions

Container creation and RBAC assignment are **not atomic** across resources.
Fresh reads detect drift but cannot lock the backend, UAMI, account or other
operators. In particular, role assignment PUT is **create-or-update, not
create-only or CAS**. A conditional assignment with the same deterministic ID,
principal and role could appear between the last read and PUT; the unconditional
write could remove its condition, and post-read verification cannot prevent or
prove the absence of that race.

Therefore every non-WhatIf apply requires an externally recorded
`ExclusiveWriterWindowId` and explicit `AcknowledgeNonAtomicUpdate`, checked
before fresh apply preflight or any write. The record must identify the exact
targets, principal/role, responsible operators and approved interval, covering
fresh apply preflight, **both** container and RBAC writes and all reconciliation.
The operator must actually coordinate and maintain exclusion of portal, scripts,
automation and any other identity able to mutate these resources/assignments.
Required independent environment approval must review that private record and
its coverage of the proposed run. If that exclusion cannot be established or is
lost/expired, do not approve/start or continue apply; inspect any submitted write.
The script does not contact the external window system, verify its validity,
acquire a remote lock or enforce exclusion. A nonempty reference, digest,
acknowledgement, Actions concurrency or approval alone **does not establish an
exclusive window**. No actual window is supplied or implied by this source.
Changing the window or acknowledgement invalidates the reviewed digest and
requires another private preview/review. Neither value appears in public logs
or summaries; the reference remains in the private plan and protected config.

Between writes, only the newly created private container is accepted as expected
drift; other changes stop before RBAC. After RBAC, verify the exact assignment and
unchanged remaining metadata. Propagation delay can cause verification to fail
after a successful write: that is an unverified/partial outcome, not permission
to retry. The workflow has no automatic retries, rollback or deletion.

Safe digest and phase-status messages remain in run logs as minimal evidence.
On failure, preserve/review private Azure audit records and current exact
container/assignment state before a new preview; never paste raw diagnostics into
public logs. Public errors suppress service bodies and private targets, so they
cannot establish that no write occurred. A failed or timed-out run may have
created the container or role.

**Runtime overlay is deferred.** The current settings helper cannot provide an
exact ETag/CAS contract for updating only `MINING_STATE_BLOB_ENDPOINT` and
`MINING_STATE_CONTAINER`. This workflow therefore makes **no app write**: no
full-app PUT/PATCH, image, env, secret, identity, ingress or revision changes.
Runtime, publisher and analytics flags stay default-off and unchanged.
Coordination, ingestion, incidents, queries, Fabric, ontology and simulator
activation are excluded. `BootstrapVerified` describes control-plane state only,
not role propagation, runtime Blob access, private networking readiness, mining
hosted proof, deployment or a functioning Azure/Fabric environment.
