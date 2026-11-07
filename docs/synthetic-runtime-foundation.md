# Synthetic history and runtime

The Streaming Backend supports an account-free, in-memory synthetic runtime
when explicitly selected. This is demonstration data, not real athlete data or
medical advice. Live authorization and live routes remain unchanged.

## Explicit provider selection

`DEMO_PROFILE=synthetic` selects the synthetic-only backend routes, stream and
in-memory insights provider. The only synthetic athlete is
`11111111-1111-4111-8111-111111111111`. The profile must match exactly. Unset
means `live`; `live` preserves Eventhouse behavior. Empty/unknown values fail
explicitly, and live configuration/query failures never fall back to synthetic
data. Supplying a live query executor in the synthetic profile is rejected.

The provider needs no Azure/Fabric account, credential, storage, or outbound
network. It seeds one bounded 112-day history in memory from the incumbent
periodization, metrics, and anomaly generators. The default reference date is
fixed at `2026-09-07` and the seed is `DEFAULT_HISTORY_SEED`; library callers can
supply a valid date and unsigned 32-bit seed. It does not cache arbitrary athlete
IDs, write cloud data, or mutate the seed when queries run. Restarting recreates
the same data.

Synthetic REST and WebSocket reads accept only the fixed athlete and seeded goal
race, regardless of principal headers. The synthetic server does not mount live
routers or expose the live MCP bridge. Live mode retains its existing athlete
authorization; do not expose live simulation endpoints as anonymous controls.

Responses carry `provenance.source = "synthetic"`, seed, reference date, and a
human-readable label. Streamed alerts additionally carry `context.source =
"synthetic"` and synthetic detail text. Live response shapes are unchanged.
Consumers must display provenance before presenting these responses publicly.

## Synthetic runtime contract and limits

`GET /api/demo/context` returns the fixed `athleteId`, `raceId`, matching
`defaultAthleteId`, `selectedAthleteId`, `defaultRaceId` and `selectedRaceId`,
assistant and MCP availability, provenance, capabilities, `simulationNote`,
`runtime`, and up to 28 `{date, trainingLoad}` daily history points. Loads are
the sum of duration multiplied by RPE for completed sessions on each populated
day; days with no completed session are omitted.

`GET /api/demo/status` returns the runtime object directly, plus provenance.
It contains `runId`, `kind`, `status` (`idle`, `running`, `completed`, `failed`,
or `cancelled`), `progressPct`, `retryAfterSeconds`, `summary`, `error`,
`activeRun`, up to ten `recentRuns`, `maxStartsPerMinute`, `scope` and
`persistence`. For the latest completed race, `summary` has the existing race
summary shape; for a completed session it is `{session, sampleCount,
latestMetric}`. Otherwise it is null. `GET /api/demo/session` returns
`{session, metrics, provenance}` with the most recent session and bounded samples.
Session objects in both responses use `source: "synthetic"`; the simulator's
internal `"live"` generator source is not presented as real athlete data.

Start via `POST /api/simulate/trigger-session` (`{athleteId, discipline}`) or
`POST /api/simulate/trigger-race` (`{athleteId, raceId}`). A successful start
returns `202 {runId,status:"started",kind}`. `POST /api/simulate/cancel`
accepts `{runId}`. There is one active run and no queue; concurrent starts
return 409. At most two starts are accepted in a rolling minute, with 429 and
`Retry-After` when exhausted. Sixteen deterministic points are emitted over
about 15 seconds. The stream retains metric, race split and session status frames
and adds a terminal `simulationStatus` frame. Failures are logged and surfaced;
closing the server cancels any active run.

All state, limits, locks, telemetry, run history and summaries are **in memory
and process-local**, not distributed or durable. Multiple processes have
independent limits and state; restarting clears them. The assistant at
`POST /api/assistant` or `/api/assistant/ask` returns a fixed summary labelled
no LLM, without cloud calls; direct MCP is unavailable.

## Reusable dataset and calculations

`generateSeedHistoryDataset({ athleteId, referenceDate, seed? })` is exported by
`@triathlon-twin/simulator`. It returns the same typed athlete, plan, races,
equipment, health, nutrition, telemetry, and injected anomalies used by live
`seedHistory`, without invoking the persistence/publishing service. An explicit
valid `YYYY-MM-DD` date is mandatory; there is no wall-clock default. Each call
returns independent data. Importing the package loads SDK modules but does not
construct Azure credentials/clients or perform network operations.

The synthetic insights provider derives workload ratio, recovery score, sleep
debt, taper index, and live-session nutrition adequacy using the history-backed
formula semantics in `infra/fabric/eventhouse/DatabaseSchema.kql` (including
averaging populated training days and sample HRV standard deviation). These are
demonstration calculations, not medical advice or a replacement for Eventhouse
execution. Nutrition adequacy is null when the snapshot has no live session.
ACWR, overdue-session, and fueling alerts are derived from the snapshot with the
existing thresholds. The fixed reference date is the overdue-session clock.
Without live telemetry it does not fabricate sustained-high-HR or race-drift
alerts.

## Verification and remaining work

Credential-free Vitest coverage exercises deterministic bounded model output,
invalid inputs, isolation from live defaults/failures, preserved route auth,
explicit REST errors, provenance, and alert-listener deduplication. The provider
tests stub the DefaultAzureCredential, DataLakeServiceClient and Kusto Client
constructors to throw and forbid `https.request` and `fetch`.

Synthetic runtime integration tests exercise real HTTP and WebSocket requests,
identity isolation, limits, cancellation, completion, failures and shutdown.
The real-server test exercises anonymous HTTP and WebSocket requests, session
and race starts, cancellation, assistant and shutdown while forbidding `fetch`,
`https.request`, and construction of DefaultAzureCredential,
DataLakeServiceClient, EventHubProducerClient and Kusto Client. Provider tests
also forbid credential, OneLake and Kusto constructors and HTTPS/fetch. These
tests are not hosted end-to-end verification or a blanket network sandbox; they
do not intercept every Azure constructor or network API. No Azure resources are
needed or changed by the synthetic runtime.
