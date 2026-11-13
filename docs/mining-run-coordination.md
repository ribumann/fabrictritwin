# Mining run coordination (source only)

The backend exposes gated read routes plus separately gated delegated start and
cancellation endpoints. The
[explicit default-off publisher runtime](mining-publisher-runtime.md) is a
separately callable integration, including the opt-in bounded final-flush contract.
It does not prove G3 authoritative hosted delivery or G8 live stop/ingestion. Existing
triathlon locks, routes, simulator jobs and `DEMO_PROFILE` behavior are unchanged.
No mining storage operation is performed merely by importing modules.

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
JWKS, Blob and curated reads and prevents subsequent reads. With the default host
composition, queries, incident persistence and the assistant are not connected:
context reports `readAvailable: false`, while data routes return explicit 503.
Start has its own default-off delegated boundary below; no acknowledgement
endpoint is available. Cancellation has a separate default-off delegated
boundary; viewer credentials never authorize either operation.
Do not enable these settings as a substitute for approving infrastructure or data access.

The unmounted query transport additionally requires
`MINING_EVENTHOUSE_QUERY_URI` and `MINING_EVENTHOUSE_DATABASE_NAME` to exactly
match the existing `EVENTHOUSE_QUERY_URI` and `EVENTHOUSE_DATABASE_NAME`, plus
`MINING_CURATED_SOURCE_VERSION=d01-validated-source-v1` and
`MINING_CURATED_QUERY_VERSION=d01-g5-query-v1`. These values are configuration,
not evidence of source readiness.

The query transport accepts public Azure Data Explorer (`*.kusto.windows.net`)
and native Fabric KQL (`*.kusto.fabric.microsoft.com`) query endpoints, never
ingestion endpoints. The exact configured target must still match both sets of
variables. Both endpoint types require public-cloud authentication metadata,
the same verified Kusto token resource and the explicitly selected managed
identity; there is no endpoint, identity or token-resource fallback.

The DTO mappers target the reviewed
G5 source contract, including the summary conflict fix in source PR #32 at
`4e5373d744057161f73888ac5d57ee0e6fdc8f07`. That source is not installed as native
functions in the hosted estate. A readiness control row or a successful scalar
query alone does not prove deployment, timestamp provenance, or writer approval.
No data route invokes the transport while those prerequisites and a truthful
current-incident evidence contract remain unverified.
The explicitly injectable `createMiningCuratedProvider` now composes these
mappers with the bounded transport and read-only persisted incident replay.
The production entrypoint can now compose it lazily through
`configuredMiningCuratedProvider`, **disabled by default and always omitted in
synthetic mode**. A trusted host must supply independently approved protected
configuration; the factory always uses the actual `createMiningNativeVerifier`,
not a no-op callback. This source change does not install configuration, issue
a receipt, deploy an image or activate mining.
Every request revalidates the downloaded canonical bytes, strict receipt schema,
approved target/run/source/semantic expectations, observation consistency and
fresh native verification before reading the matching incident journal or data.
Flags, successful scalar queries, a receipt's own claims, and test doubles are
not substitutes for that verifier. There is no readiness cache.

### Protected production read composition

Only literal `MINING_READ_ENABLED=true` selects the lazy live provider.
`MINING_READ_CONFIGURATION_JSON` is a private, independently approved host
document, not a browser/request parameter, downloaded receipt or runtime-generated
self-pin. Its maximum UTF-8 size is 16 KiB; the versioned structure rejects
unknown/missing fields, invalid IDs/hashes and duplicate/missing semantic
contracts:

| Field           | Contract                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | Exactly `1`.                                                                                                                                                                                                                                                   |
| `receiptPin`    | Lowercase SHA-256 of the approved canonical private receipt bytes.                                                                                                                                                                                             |
| `expectations`  | Exact `MiningReceiptExpectations`: authorized/canary run IDs, full target and source identity, canary/semantic fixture hashes and all five semantic contracts. Each contract contains only `functionName`, `assertionCount`, `resultRowCount`, `outputSha256`. |
| `native`        | Exactly `managedIdentityPrincipalId`, `eventstreamNativeDefinitionSha256`, `eventhouseNativeDefinitionSetSha256`, independently reviewed against the native v1 contracts below. The target is reused from protected expectations, never from downloaded proof. |

Configuration is captured from the host environment at construction but is
validated only inside an authorized, durably admitted read. Missing/invalid
enabled configuration fails the mining request closed without preventing
triathlon startup. The run/catalog/profile must also match the approved
environment values, the protected Fabric tenant must match
`ASSISTANT_AUTH_TENANT_ID`, and the selected managed identity and exact query
configuration remain mandatory. The dedicated store must be explicitly enabled
and configured as below. There is no default storage account, principal, proof
pin or native hash.

The reader composes only storage reads, fresh native verification and bounded
queries. It does not create containers, take leases, publish runs or issue
proofs. No previous readiness is cached; each request repeats the proof/native
gates. Preserve the existing static-write approval, real exclusive-writer
window and separate bootstrap/activation requirements: setting these variables
does not fulfill them.

### Fresh native drift verification

`src/mining/read/native-verifier.ts` performs fresh, read-only Eventstream
`getDefinition` and native Kusto `.show database schema as csl script` requests.
It is wired only by the opt-in lazy production composition above and does not
issue a receipt, provision resources, install functions, grant permissions or
activate mining.
The host must supply independently protected `MiningNativeExpectations`: the
full exact target, selected managed identity's **principal object ID**, and both
native hashes. These must not be copied from the downloaded receipt. The full
receipt/run/source/semantic gates in `createMiningCuratedProvider` remain required.

The verifier first compares receipt/host targets and native pins without I/O.
It then validates public-cloud metadata and acquires separate Fabric/Kusto
audience tokens from the loopback broker using the selected client ID. Broker
response and token claims must match the configured client, protected principal,
tenant, audience and lifetime; the upstream services authenticate the tokens.
The live Fabric KQL item must also bind the protected item ID, Eventhouse
workspace, database display name and native query endpoint with `ReadWrite` type;
an inaccessible item or changed/shortcut binding fails closed.
There is no alternate identity, audience, endpoint or retry. Requests and their
bounded body reads share one nine-second deadline and caller cancellation;
a failure cancels siblings. Responses are limited to 16 KiB for metadata/tokens
and KQL item binding, and 1 MiB for each native export, with at most 1,000 script
rows. An HTTP 202 operation fails closed: the verifier does not follow `Location`, poll, cache a
previous success or exceed the enclosing HTTP deadline. Slow exports can
therefore keep reads unavailable even when the caller has sufficient permission.

The receipt's native hash fields use these explicit **v1 snapshot contracts**.
Collectors must use the exported hash helpers, not hash Git source or raw REST
envelopes:

- Eventstream: require unique safe `InlineBase64` part paths and a JSON object in
  `eventstream.json`; hash the exact decoded bytes of **every** returned part.
  Sort `{path, sha256}` entries by path using ordinal comparison, then SHA-256
  hash canonical UTF-8 JSON `{contract:"d01-native-eventstream-v1",parts:[...]}`.
  Formatting and any additional part count as drift.
- Eventhouse: request
  `.show database schema as csl script with (ShowObfuscatedStrings=false, IncludeSecuritySettings=true, IncludeEncodingPolicies=true, IncludeIngestionMappings=true) | project NativeDefinition=tostring(pack_all())`
  on the exact approved database. Require the complete V1 management envelope,
  its three-entry table of contents and successful query status; errors,
  warnings, truncation, missing status and unexpected result shapes fail closed.
  Extract each `DatabaseSchemaScript` string without trimming or reordering.
  Hash canonical UTF-8 JSON
  `{contract:"d01-native-kql-schema-v1",statements:[...]}`.

Canonical JSON uses the same recursive ordinal-key sorting and UTF-8 validation
as pinned receipts, without whitespace or a trailing newline. Native KQL export
includes table/function definitions, policies and mappings, not business rows.
Security settings are included; obfuscated credential strings are **never
revealed**, so this is not proof of hidden credential values. Neither export nor
tokens are logged by the verifier. Whole-database changes, including triathlon
schema changes, conservatively invalidate the pin. The two service observations
are point-in-time reads, not atomic deployment proof or an exclusive-writer lock.

Fabric documents read **and write** permission as a prerequisite for the
read-only [Eventstream `getDefinition` operation](https://learn.microsoft.com/rest/api/fabric/eventstream/items/get-eventstream-definition);
[Kusto schema export](https://learn.microsoft.com/kusto/management/show-schema-database?view=microsoft-fabric)
requires database read/monitor access, and the
[KQL item binding read](https://learn.microsoft.com/rest/api/fabric/kqldatabase/items/get-kql-database)
requires item read access. An actual backend-identity probe on
2026-11-13 succeeded for all three reads without changing permissions: the
Eventstream returned three parts, the native schema returned 36 script rows
with successful management status, and a KQL item read matched the exact protected
ID/workspace/name/endpoint. Two consecutive schema exports had identical v1
snapshot hashes. This proves capability only, not mining
deployment or readiness. One earlier eight-second attempt timed out; the later
Eventstream response took about 8.4 seconds, so deadline availability still
requires live acceptance. No speculative role grant is warranted.

An explicitly composed reader still requires the router's signed viewer/run
authorization and a durable **accepted** run before proof or query reads. Missing,
corrupt or unassessed incident journals, failed native verification and malformed
query results return 503, not healthy data or a fallback. Status continues to
report ingestion as unknown: a source canary does not prove a full published run.
Overview joins catalog-first latest readings with a trailing five-minute summary
at one requested UTC `asOf`; the summary publishes its exact window. Module
health stays unknown unless a fresh source state explicitly establishes stopped;
no engineering normal bands or propagated incident impacts are invented.
Incidents retain the evaluator's actual assessment time; a request preceding
that time cannot silently receive a newer snapshot. Series retain their requested
bounded window, canonical tags, metric and bins. One HTTP deadline/disconnect
cancels proof, native verification, journal and query work; failure also cancels
the provider's sibling queries. No leases, evaluator recovery, acknowledgements,
publishers or other writes are started by a curated read.
The current-incident mapper uses `moduleId` for direct measurement or
rule context only. It leaves `affectedModuleIds` empty because the evaluator
does not model propagated impact or causation.
The transport uses a single abort signal for bounded public-cloud
metadata discovery, the Container Apps loopback managed-identity broker, and the
query response. It requires `MINING_MANAGED_IDENTITY_CLIENT_ID` and the platform's
`IDENTITY_ENDPOINT` and `IDENTITY_HEADER`; it rejects unknown cloud metadata and
never falls back to another identity or token resource. This cancellation work does
not prove deployed query readiness or authorize a live query.

## Delegated start boundary

`POST /api/mining/runs/start` remains disabled unless `MINING_START_ENABLED=true`
and synthetic mode is off. This endpoint is delegated-operator only and never
promotes viewer identities into write authority.

Approved configuration requires:

- Existing API tenant/client validation (`ASSISTANT_AUTH_TENANT_ID`,
  `ASSISTANT_AUTH_CLIENT_ID`) and explicit `MINING_MANAGED_IDENTITY_CLIENT_ID`.
- `MINING_START_OPERATOR_PRINCIPAL_IDS`: lowercase Entra **user** object UUIDs.
- `MINING_START_DELEGATED_SCOPE`: one exact delegated scope; test values are
  illustrative, not proof of installed Entra scope/consent.
- `MINING_APPROVED_RUN_ID`: exact lowercase UUIDv4 run approved for delegated start.

Request body is strict and bounded:
`{ plantId:"D01", runId:"<approved UUID>" }`.
The API does not accept query parameters or extra JSON keys.

A start call returns after durable admission only, with
`publisherStatus` and `ingestionStatus:"unknown"`; it does **not** wait for
sender completion or imply ingestion success. Observed retries remain idempotent
and never adopt a sender. Rejected/conflicting admission returns 409.

The route uses the supervised trusted host lifecycle: one local execution owner
at a time, explicit admission/completion split, joined transport/persistence
settlement on shutdown, and explicit failure logging for later reconciliation.
When the backend is the main process, SIGTERM/SIGINT start this shutdown path;
it stops new publisher admissions before closing HTTP and awaiting active work.
The host platform may still terminate an uncooperative process before settlement,
so shutdown does not prove delivery, ingestion, or rollback.
This source capability does not create a public operator start path, does not
apply deployment/host settings, and does not activate mining.

## Delegated cancellation boundary

`POST /api/mining/runs/cancel` remains disabled unless the live backend has
literal `MINING_CANCEL_ENABLED=true`. Synthetic mode always rejects it. A trusted
operator must separately approve/configure all of:

- The existing API's `ASSISTANT_AUTH_TENANT_ID` and `ASSISTANT_AUTH_CLIENT_ID`.
- `MINING_CANCEL_OPERATOR_PRINCIPAL_IDS`: comma-separated lowercase Entra **user**
  object UUIDs. There is no viewer/athlete/Easy Auth header fallback.
- `MINING_CANCEL_DELEGATED_SCOPE`: one exact delegated scope exposed/consented for
  this API. `Mining.Run.Cancel` in tests is illustrative, not an installed scope.
- `MINING_APPROVED_RUN_ID`: the exact approved UUIDv4 run. Cancellation does not
  depend on curated read/native readiness, which must not prevent a safe stop.
- The dedicated mining-state store configuration below, including explicit
  `MINING_MANAGED_IDENTITY_CLIENT_ID` and `MINING_RUN_COORDINATION_ENABLED=true`.

The API self-verifies bearer signature, issuer, audience and expiration and
requires the matching tenant, approved user object ID and exact `scp` membership.
App-only roles or `idtyp=app` are insufficient even if that identity is a viewer.
No Entra scope, consent, role assignment, host setting or private-state resource
is provisioned by this source. Before activation, confirm an existing suitable
delegated scope/client consent or arrange that manual Entra configuration through
an authorized administrator. The public Cockpit BFF still rejects cancellation:
it cannot exchange anonymous visitor access for operator authority.

The JSON body contains **only** `{ "plantId": "D01", "runId": "<approved UUID>" }`;
query parameters, extra fields, other plants and unapproved runs are rejected.
After authorization, the actual coordinator checks durable admission and
conditionally creates only that run's immutable stop intent. It never acquires,
renews or breaks a lease and never starts a publisher. HTTP 202 returns
`stopRequested`, the observed `publisherStatus`, and `ingestionStatus: "unknown"`.
Acceptance is **not** stopped acknowledgement or Fabric ingestion verification;
the current owner must observe intent and drain any already-admitted batch.

A single 9.9-second deadline/disconnect aborts authentication and pre-write
admission reads; an abort checked immediately before create prevents later
submission. An already-submitted immutable write may still commit. Deadline,
lost write response or failed post-write read returns an explicit unknown
outcome when connected, never success, rollback, takeover or automatic retry.
Inspect the **same run ID's status** before deciding whether another request is
necessary. This endpoint remains unactivated; deployment alone grants no write
approval or end-to-end mining acceptance.

## Prerequisites and configuration

An authorized operator must first approve and provision one **private, dedicated**
`mining-state[-suffix]` container in the selected existing StorageV2 account.
Assign the existing backend managed identity **Storage Blob Data Contributor at
that container scope only**, or an approved equivalent permitting blob read,
create/write and lease acquire/renew/release. Do not grant account-wide roles,
reuse token-store paths, enable shared keys, or provide credentials to a browser.
Container creation and RBAC are not approved or performed by this source layer.

The opt-in read composition calls `configuredMiningStore()` only after its
protected configuration checks; other callers must opt in explicitly:

| Variable                            | Contract                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `MINING_RUN_COORDINATION_ENABLED`   | Absent/`false`: disabled. Only `true` enables client construction.                                                                |
| `MINING_STATE_BLOB_ENDPOINT`        | Explicit HTTPS Azure public-cloud Blob account root, no query/credentials/path. No deployed-account default.                      |
| `MINING_STATE_CONTAINER`            | Dedicated `mining-state` or `mining-state-<suffix>` name.                                                                         |
| `MINING_MANAGED_IDENTITY_CLIENT_ID` | Explicit selected user-assigned MI client ID is mandatory for live reads; the store alone can use system-assigned MI when absent. |

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
transition. Current incident read mapping supports the exact persisted legacy
or version 2 definition; it does not add a contract to old runs or fall back
across journal versions.

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
