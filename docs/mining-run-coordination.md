# Mining run coordination (source only)

The backend exposes a gated, read-only status endpoint; the coordinator is not
wired to HTTP actions, startup, or deployment. The
[explicit default-off publisher runtime](mining-publisher-runtime.md) is a
separately callable integration, including the opt-in bounded final-flush contract.
It does not prove G3 authoritative hosted delivery or G8 live stop/ingestion. Existing
triathlon locks, routes, simulator jobs and `DEMO_PROFILE` behavior are unchanged.
No storage operation is performed merely by importing the module.

## Read-only HTTP boundary

The backend's `/api/mining` routes are disabled unless `MINING_READ_ENABLED=true`
in the live profile. They require the existing signed bearer-token verification
configuration (`ASSISTANT_AUTH_TENANT_ID` and `ASSISTANT_AUTH_CLIENT_ID`), a
comma-separated `MINING_VIEWER_PRINCIPAL_IDS` allowlist of lowercase Entra object
UUIDs, and one independently approved lowercase UUID in `MINING_APPROVED_RUN_ID`.
The approval must explicitly bind `MINING_APPROVED_CATALOG_VERSION` to
`sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce`
and `MINING_APPROVED_PROFILE_VERSION` to `d01-publish-profile-v1`. These settings
record operator approval; they do not prove that the publisher used those versions.
`catalogVersion` in status and context is this approved expected contract scope,
not verified provenance of the publisher or run.
The approved run must also have a matching durable admission in the configured
mining-state store below. No Easy Auth header or athlete mapping grants access.
Invalid bearer tokens are rejected with 401; identity-provider verification
failures are logged and returned as 503 instead of being reported as invalid tokens.
Status and context perform read-only durable reads; publisher completion does not
prove ingestion. Rejected durable admissions return a distinct 409 rather than
being reported as absent. A single request deadline or client disconnect cancels ongoing
JWKS and Blob status reads and prevents subsequent reads. Queries, incident persistence and
the assistant are not connected: context reports `readAvailable: false`, while data
routes return explicit 503.
Start, cancel and acknowledgement remain unavailable without delegated authorization.
Do not enable these settings as a substitute for approving infrastructure or data access.

The unmounted query transport additionally requires
`MINING_EVENTHOUSE_QUERY_URI` and `MINING_EVENTHOUSE_DATABASE_NAME` to exactly
match the existing `EVENTHOUSE_QUERY_URI` and `EVENTHOUSE_DATABASE_NAME`, plus
`MINING_CURATED_SOURCE_VERSION=d01-validated-source-v1` and
`MINING_CURATED_QUERY_VERSION=d01-g5-query-v1`. These values are configuration,
not evidence of source readiness. The unmounted DTO mappers target the reviewed
G5 source contract, including the summary conflict fix in source PR #32 at
`4e5373d744057161f73888ac5d57ee0e6fdc8f07`. That source has not been compiled
or deployed to the hosted estate. A readiness control row or a successful scalar
query alone does not prove deployment, timestamp provenance, or writer approval.
No data route invokes the transport while those prerequisites and a truthful
current-incident evidence contract remain unverified.
The unmounted current-incident mapper uses `moduleId` for direct measurement or
rule context only. It leaves `affectedModuleIds` empty because the evaluator
does not model propagated impact or causation.
The source-only transport uses a single abort signal for bounded public-cloud
metadata discovery, the Container Apps loopback managed-identity broker, and the
query response. It requires `MINING_MANAGED_IDENTITY_CLIENT_ID` and the platform's
`IDENTITY_ENDPOINT` and `IDENTITY_HEADER`; it rejects unknown cloud metadata and
never falls back to another identity or token resource. This cancellation work does
not prove deployed query readiness or authorize a live query.

## Prerequisites and configuration

An authorized operator must first approve and provision one **private, dedicated**
`mining-state[-suffix]` container in the selected existing StorageV2 account.
Assign the existing backend managed identity **Storage Blob Data Contributor at
that container scope only**, or an approved equivalent permitting blob read,
create/write and lease acquire/renew/release. Do not grant account-wide roles,
reuse token-store paths, enable shared keys, or provide credentials to a browser.
Container creation and RBAC are not approved or performed by this source layer.

Future runtime integration may call `configuredMiningStore()` explicitly:

| Variable                            | Contract                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MINING_RUN_COORDINATION_ENABLED`   | Absent/`false`: disabled. Only `true` enables client construction.                                           |
| `MINING_STATE_BLOB_ENDPOINT`        | Explicit HTTPS Azure public-cloud Blob account root, no query/credentials/path. No deployed-account default. |
| `MINING_STATE_CONTAINER`            | Dedicated `mining-state` or `mining-state-<suffix>` name.                                                    |
| `MINING_MANAGED_IDENTITY_CLIENT_ID` | Optional existing user-assigned MI client ID; absent uses system-assigned MI.                                |

ManagedIdentityCredential is intentional: no developer-credential, shared-key,
SAS, connection-string or local resource fallback. Configuration construction
does not validate live permission. The first actual storage operation reports
missing container (`prerequisite`), denied access (`unauthorized`) or service/read
failure explicitly. There is no `createIfNotExists` call, container enumeration
or provisioning code. SDK automatic retries are disabled: uncertain writes and
lease acquisition must be reconciled, not blindly retried.

## API for the later authorized runner

Import `MiningRunCoordinator` from `apps/streaming-backend/src/mining/run-coordinator.ts`
and construct it with the configured store. Authentication and plant/run
authorization **must be enforced by the future caller**; this is not a public API.

- `start({plantId:"D01", requestId, durationSeconds?, scenario?, seed?})`: requestId
  is a caller-retained lowercase UUID and is also the runId. Defaults are 1200
  seconds, `normal`, seed 1. Duration is a multiple of 5 from 5..1800 seconds, seed uint32.
  Scenarios: `normal`, `bearing-b`, `dms-c`, `shared-water-restriction`,
  `communication-gap`. Identity parameters are immutable for that request.
- Only a fresh, fully acknowledged admission returns `kind:"started"` with
  `run.startedAt`, `run.stopAt` and an ephemeral `owner`. Pass that exact runId,
  start UTC, duration, seed and scenario to the deterministic simulator.
  Retry returns `kind:"observed"` with durable status and **never an owner**,
  including after crash, expiry or uncertain acquisition. Conflicting start
  throws `conflict`. Do not launch a sender from status or recover an owner.
- `owner.runBatch(async signal => ...)` renews authority, conditionally persists
  lifecycle and checks stop before authorizing one batch. Await it, perform only
  that batch's bounded transport work inside the callback, honor its AbortSignal,
  and never detach network work or bypass the gate with internal retries.
  Event delivery uncertainty still requires event-ID reconciliation downstream.
- `owner.heartbeat()` must be awaited at least every 30 seconds between batches.
  Owner operations are serialized; concurrent calls fail explicitly, rather
  than queue work beyond stop. A batch that hangs beyond safe authority is aborted;
  it cannot authorize a later batch. No automatic simulator or evaluator starts.
- `requestStop(runId)` may run on another authorized replica. It persists an
  immutable stop intent **without acquiring/breaking the active lease**.
  `accepted:true` is not stopped acknowledgement. The owner observes intent on
  its next heartbeat/batch gate; stop and batch admission can race, allowing
  at most the single already-authorized/in-flight batch to drain.
- `owner.finish("publisher_complete" | "failed")` must be awaited after transport
  settles (including a failed callback). It acknowledges `stopped` when stop was
  observed, persists terminal state/history and releases the lease. A heartbeat
  or batch gate observing cancellation with no batch in flight also finalizes.
  `publisher_complete` means only sender lifecycle completion, **not Fabric
  ingestion or expected event counts**. Failed/uncertain terminal writes throw.
- `status(runId)` returns admission (`pending`, `accepted`, `rejected`), explicit
  lifecycle, stop intent and immutable run bounds, or undefined for no request.
  `admission_unknown`/`interrupted` are not successful starts or stopped
  acknowledgements. Status reads never renew a lease or start work.

## Prospective run contract and rollout

Fresh admissions persist a server-derived `contract` containing the supported
catalog version, publication profile version and `evaluatorReplayVersion: 1`.
It is written in a **version 2** plant envelope under the plant lease and ETag
before the accepted admission and owner are returned. The contract survives
heartbeats, finalization and version 2 history envelopes. The supported catalog
and profile content are pinned as well as their version labels. An unsupported
or malformed contract is rejected, not filled from current defaults.

Version 1 plant records and unwrapped history remain readable without a
contract: their catalog, profile and evaluator provenance is **unknown**.
There is no automatic conversion or certification. Version 2 state and history
are deliberately rejected by old schema-1 code instead of allowing an older
writer to discard the new fields. Before any separately approved activation,
coordinate the upgrade of **all** replicas, readers and rollback procedures;
do not roll back to schema-1 code against version 2 durable state. Disable new
admissions and drain/reconcile owners and uncertain writes before a coordinated
transition. Current incident read mapping does not support version 2.

The recorded contract is a source self-assertion, not independent proof of
operator authorization, deployed image identity, actual delivery or readiness.
Trusted run/version approval and source/deployment verification remain separate.

## Concurrency, failure and recovery

One leased `plants/D01.json` blob is the authoritative plant state shared by all
backend replicas/revisions. Every authoritative state write supplies **both
lease ID and ETag**. Blob leases last 60 seconds; local authority ends after 45
seconds measured conservatively from before acquisition/renewal, with monotonic
and wall-clock guards. The runner must use synchronized host clocks. A watchdog
aborts at lease authority expiry or the configured duration (never over 30
minutes), even during transport. Expired capabilities never renew themselves:
[Azure allows renewal of expired leases](https://learn.microsoft.com/azure/storage/blobs/storage-blob-lease-javascript),
but this module deliberately refuses resurrection.

`requests/<runId>.json` is a conditional-create admission receipt; separate
`stops/<runId>.json` is immutable stop intent. `history/<runId>.json` retains a
terminal or interrupted snapshot before another explicit run replaces plant
state. Records contain only bounded run parameters, IDs, timestamps and lifecycle;
no credentials, prompts or user identity. There is no automatic blob cleanup or
resource deletion. Establish an approved mining-only retention/cleanup policy
before prolonged use; never remove a live lease or pending request to force retry.

Expected BlobAlreadyExists/conditional-create conflicts and LeaseAlreadyPresent
are distinguished from auth/network failures. A 412 on fenced writes or rejected
lease renewal loses the capability immediately; unknown outcomes do too. Only
BlobNotFound is an absent blob; ContainerNotFound is a missing prerequisite.
Unknown 409/404 failures are not swallowed as contention/absence.

After an uncertain start, inspect the **same request/run ID**. An accepted run may
have no surviving sender; there is no takeover. Let the finite lease expire,
record interrupted/unknown status, and use a **new explicit request ID** only
after reconciling any already-authorized batch. A new explicit run may acquire
the expired plant lease but never resumes the old run. This does not provide
exactly-once transport or fence an external Eventstream itself: that requires the
runner's cooperative abort/batch contract and downstream stable-ID deduplication.

## Change ledger and rollback

| Target                   | Change                                                      | Permission/cost impact                                                | Rollback                                                                                                 |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Existing backend source  | New isolated mining module and official Blob SDK dependency | None while unwired/disabled                                           | Revert source layer                                                                                      |
| Existing storage account | Proposed one private mining-state container, not created    | Approval and container-scoped MI role required; small bounded records | Disable future mining caller; retain evidence, remove only mining-owned configuration after lease expiry |

Local checks use shared fake storage across independent coordinator instances and
mock SDK calls; no cloud writes, container reads or credentials are needed.
See [runtime operations](live-runtime-operations.md) for existing release
boundaries and [configuration](dependencies-and-configuration.md) for backend
configuration context. Authorized write wiring, runtime/auth activation, approved
container/RBAC, hosted concurrency/failure tests and Fabric ingestion proof
remain separate release gates.
