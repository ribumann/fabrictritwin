# Cockpit domain views

The existing `/` triathlon entry, APIs, synthetic profile, assistant and live controls
are unchanged. `/mining` is a separate domain entry with its own scripts, state and
styles. It shares the existing host, visual tokens and authenticated BFF helpers.
It is **not a live-integrated twin or hosted acceptance evidence**.

## Mining source prerequisites

The canonical simulator package (PR #21, source `ce4a727`) must be present before
building. Catalog data is copied from `apps/simulator/src/mining/plant-catalog.json`,
never reauthored here. The catalog version is
`sha256:0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce`.
The pinned spec is `ribumann/3d-scene-toolchain@60e98f44f12a8abc0ddf13eadc1c12b3ae35798e`.

The committed local plant assets are authored parametric meshes under the upstream
MIT license. `npm run prepare:mining-assets --workspace apps/cockpit` explicitly
rematerializes them from the canonical receipt URLs and verifies every SHA-256.
Normal builds and runtime never download assets or use an external viewer/CDN.
The build rechecks the catalog and every required geometry receipt. Three.js is
pinned to `0.187.0`, copied locally with its MIT notice, and loaded only by mining.
WebGL failure retains the canonical top projection and keyboard object list.
For isolated pre-merge packaging only, `MINING_CATALOG_DIR` can point at an
extracted canonical commit's `src/mining` directory; production builds use the
simulator package in this repository. The build hashes and publishes the original
catalog bytes without newline conversion or semantic JSON canonicalization.

## Integration boundary

Exact response types are in `src/mining/contract.ts`; the backend must return them
and independently enforce plant/run authorization and all resource limits.
All JSON uses camelCase. The public demo exposes only its approved run, not
foreign-run browsing. Athlete IDs and athlete permissions are not mining grants.

| GET `/api/mining/` path | Backend contract                                  | Inputs                                                                             |
| ----------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `context`               | `MiningContext`                                   | none; backend-selected approved run, catalog version, capabilities                 |
| `overview`              | `MiningOverview` (`PlantLatest` + `PlantSummary`) | `plantId=D01`, approved `runId`, optional replay `asOf` UTC                        |
| `trends`                | `MiningSeries` (`AssetTrend`)                     | plant/run, canonical `moduleId`, `metric`, `start`, `end`, `binMinutes`, `maxRows` |
| `incidents`             | `MiningIncidents` (`ActiveIncidents`)             | plant/run, optional replay `asOf`                                                  |
| `compare-lines`         | `MiningSeries` (`CompareLines`)                   | plant/run, `metric`, `start`, `end`, `binMinutes`, `maxRows`                       |
| `runs/status`           | `MiningRun`                                       | plant/run                                                                          |

Metric families are `feed`, `density`, `vibration`, `water-energy`. Bins are 1 or
5 minutes; maximum window 24 hours, maximum 1000 result rows, 1 MiB response,
10-second request timeout. The backend must enforce the same limits, canonical
joins, UTC semantics and bound query parameters, never concatenate user KQL.
Chart `seriesId` values are exact canonical tag IDs with their catalog units,
not arbitrary line labels. `MiningSeries.moduleId` echoes the requested module
for AssetTrend and is null for CompareLines. Response windows, metric, bin size,
tag/module joins and replay incident `asOf` must match the request.
Trend requests require explicit start/end, metric, binMinutes and maxRows
(and moduleId for AssetTrend); omission cannot delegate unbounded defaults.
Overview must include all 24 modules and all 56 tag rows, including missing/bad
observations; absent observations are null/unknown, not zero. KPI coverage is
0–1, water/energy ratios require at least 90% common coverage, and the backend
applies startup/feed denominator rules. Its summary window defaults to 15 minutes.
`uncertain` quality remains distinct from `bad` but is never usable as a good
reading, KPI, status, or chart sample; unsupported quality is not treated as good.
Replay freshness is evaluated at `asOf`; latest provenance timestamps are UTC.
`normalBand` is a demo normal band, never the catalog's broad simulation envelope.
Every run-scoped response includes `plantId`, `runId` and `catalogVersion`;
cross-run/catalog responses are rejected, including late arrivals after a switch.
The Cockpit's pinned catalog version is an approved expected scope, not verified
publisher provenance; a matching response does not prove which catalog the
publisher actually used.
Publisher statuses preserve `admission_pending`, `admission_unknown`,
`interrupted` and `publisher_complete` without inventing terminal success.
Incident responses have at most 20 active records with retained unverified state,
rule/scope IDs and separate acknowledgment/clear timestamps. Current qualifying
hold bounds are nullable as a pair; null means there is no current qualifying hold.
The bounded evidence window remains required and is not a substitute for an active hold.
Evidence `ingestionTime` may be null; the UI renders it as unknown and never
substitutes evaluator or response-receipt time.

The BFF constructs its own service-auth headers for reads, ignoring all browser
authorization/principal headers. It uses only the existing viewer-scoped Cockpit
identity. Synthetic profile mining reads return 503, not athlete demo samples.
POST `runs/start`, `runs/cancel` and `assistant` always return explicit 503 until
a verified human delegated boundary and separate backend mining authorization
are implemented. Hidden/disabled buttons are not the authorization boundary.
No ingress, EasyAuth exemptions, credentials or identity grants are added.

Backend 401/403/query errors propagate explicitly. A 404/503 leaves the account-free
geometry shell usable with unknown telemetry. Identical reads reuse 15-second
cache/in-flight work; overview polls every 30 seconds, charts/incidents every
60 seconds, hidden tabs abort/pause and replay never polls. Reopening never
starts a run. Publisher and ingestion completion are separate statuses, as are
stop requested and stopped. The assistant makes no cost-incurring calls; only
explicitly configured `https://app.fabric.microsoft.com` query/agent links appear.

## Remaining release gates

Connect backend routes to the approved-run/read authorization, five bounded query
functions and incident evidence; verify the exact DTO and catalog version.
Configure supported native Fabric query/data-agent links under user permissions
if available. Human delegated run/assistant authorization remains a separate gate.
Then use the existing protected release lanes and verify actual hosted normal,
fault/stale, replay and stop behavior. Local source/browser checks are not this
proof. Rollback is the prior Cockpit image; no infrastructure or data teardown.

`npm run dev --workspace apps/cockpit` prepares the same validated generated
catalog/vendor files before starting the existing source watcher. Mining CSS/JS
remain source-served in dev; catalog data still has only the simulator source.
