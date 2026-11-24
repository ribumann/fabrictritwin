# Architect: boundaries, data and decisions

[Lab](../README.md) | [Business walkthrough](business-user.md) | [Developer](developer.md)

This is a **learning lab**, not a production reference certification. Both
scenarios use generated data. The diagrams describe checked-in paths; a
deployment must separately prove its identities, routing, bindings and freshness.
Solid arrows are data/request paths; dotted arrows are optional integrations.
**View key:** L0 = system context and trust; L1 = containers/services;
L2 = scenario components and data flows. These are this lab's documentation levels.

## L0: system context and trust

```mermaid
flowchart LR
  Visitor["Public visitor"] --> Cockpit["One Cockpit: Triathlon / Mining"]
  Cockpit -->|"Workload identity; HTTPS / WSS"| Backend["Protected streaming backend"]
  Backend -->|"Workload identity; bounded reads"| Fabric["Private Microsoft Fabric"]
  Backend -.-> Foundry["Optional Foundry explanations"]
  Operator["Authorized operator"] -->|"Entra sign-in"| Fabric
  CI["GitHub Actions OIDC"] --> Azure["Azure app image deployment"]
```

**Public web access is not public Fabric access.** Cockpit constructs service
authentication, rather than forwarding visitor credentials. The backend checks
the caller, allowed athlete/plant/run and query bounds. Native Fabric views and
delegated tools require their own permissions and, where applicable, consent.

## L1: containers and integration

```mermaid
flowchart TB
  subgraph Azure["Azure hosting and private state"]
    UI["Cockpit / BFF: Container App"]
    API["Streaming backend: Container App"]
    MCP["Internal MCP tools: Container App"]
    Job["Simulator: Container Apps Job"]
    State["Private Blob run coordination"]
    UI -->|"Service token"| API
    API --> MCP
    API -->|"Mining lease / ETags / stop intent"| State
  end
  subgraph Fabric["Fabric workspace; separate scenario stores"]
    TH["Triathlon Eventstream"] --> TK["Triathlon Eventhouse"]
    MH["Mining telemetry Eventstream"] --> MK["Mining realtime KQL database"]
    CH["Mining connection Eventstream"] --> MK
    Lake["Lakehouse / OneLake"] -->|"History shortcuts"| TK
    Static["Mining catalog / ontology / topology report"]
  end
  Job -->|"Files + load notebook"| Lake
  API -->|"Triathlon events"| TH
  API -->|"Mining events; distinct secret"| MH
  API -->|"Connection observations; distinct secret"| CH
  API --> TK
  API --> MK
  MCP --> TK
  UI -.-> BI["Optional embedded Power BI"]
  API -.-> AI["Optional Foundry"]
```

The Eventstream backing endpoint is Fabric-managed. Do not model it as another
Azure Event Hubs service provisioned by this repository. Mining shares hosting
and potentially capacity/workspace, **not** the Triathlon stream/database.

## L2: Triathlon data and experience

```mermaid
flowchart LR
  Seed["Deterministic history generator"] --> Files["OneLake JSONL"]
  Files --> Notebook["Load-history notebook: MERGE"]
  Notebook --> Delta["Lakehouse Delta facts"]
  Delta --> Shortcut["Five OneLake shortcuts"]
  Shortcut --> KQL["KQL analyses / alerts"]
  Generator["Authorized session / race generator"] --> Stream["Eventstream routing"]
  Stream --> Live["SessionMetric / RaceSplit"]
  Live --> KQL
  Generator --> WS["In-process WebSocket delivery"]
  KQL --> Backend["Backend + MCP tools"]
  Backend --> UI["Triathlon Cockpit"]
  WS --> UI
```

Event time can be accelerated relative to wall time. Compare source timestamps,
receipt timestamps and scenario time deliberately. The live browser stream is
not an ingestion acknowledgement. Current live-run admission and stream state
are process-local, unlike Mining's durable coordination. The hosted lab therefore
uses one live backend replica: horizontal scaling can separate HTTP admission,
WebSocket delivery and in-memory race reads. This trades high availability for
consistent demo behavior until those responsibilities are externalized.

## L2: Mining data quality and run ownership

```mermaid
flowchart LR
  Catalog["Pinned plant catalog + publish profile"] --> Generator["Bounded D01 generator"]
  Lease["Blob lease + ETag + authority deadline"] --> Generator
  Generator --> Transport["Telemetry / state Eventstream"]
  Generator --> Flow["Connection Eventstream"]
  Flow --> FlowRaw["Raw v2 connection observations"]
  FlowRaw --> Live["Binding checks, deduplication / live KQL"]
  Live --> BFF["Bounded DTOs / public Cockpit"]
  Transport --> Raw["Raw telemetry / state"]
  Raw --> Validation["Catalog, shape, time and identity validation"]
  Validation --> Valid["Validated telemetry / state"]
  Validation --> Quarantine["Quarantine + reason codes"]
  Valid --> Queries["Latest / summary / trend functions"]
  Expected["Expected event ID sets"] --> Reconcile["Exact completed-run reconciliation"]
  Raw --> Reconcile
  Valid --> Reconcile
  Queries --> BFF["Bounded DTOs / public Cockpit"]
  Reconcile --> Incidents["Read-only reconciled incident evidence"]
```

A lease enforces one admitted writer; it does not create exactly-once transport.
The hosted run-independent connection path does not use a Fabric run pin or
per-run connection reconciliation; its live reads deduplicate by tag and
sample time. Expected IDs, distinct/copy counts and conflict checks establish
bounded ingestion evidence for the run-scoped legacy and pinned-v1 paths.
Continuous operation remains supported as an explicit
operator-managed alternative; it must not be relabeled as a completed finite run.

## Full data architecture

| Layer                | Triathlon                                                                           | Mining                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Domain source        | Athlete, training block/phase/session, race, recovery, sleep, nutrition, equipment  | Plant D01, 24 modules, equipment, 56 tags, streams, pinned publish profile            |
| History / catalog    | Generated JSONL -> notebook MERGE -> Lakehouse Delta                                | Versioned JSON catalog; separate static Lakehouse/ontology/topology projections       |
| Transport            | `entityType`-routed session and race envelopes                                      | Separate telemetry/state and connection Eventstreams                                  |
| Raw/event facts      | `SessionMetric`, `RaceSplit`                                                        | `mining_TelemetryRaw`, `mining_PlantStateEvents`, `mining_ConnectionMeasurementRaw`   |
| Validated / rejected | Typed telemetry mappings and query logic                                            | Legacy validated/quarantine tables; v1 connection validated/quarantine tables         |
| Serving              | KQL functions/materialized views, history shortcuts; optional semantic model/report | Run-scoped telemetry reads; run-free v2 latest/trend reads from raw connection events |
| Operations           | Process-local stream/run state                                                      | Private Blob admission, plant lease, immutable generation holds and incident journals |
| Retention            | Inspect deployed table/Delta policies; no blanket lifecycle guarantee               | Schema declares 7-day raw/validated/quarantine and 30-day alert/incident retention    |

```mermaid
erDiagram
  ATHLETE ||--o{ TRAINING_BLOCK : plans
  TRAINING_BLOCK ||--o{ TRAINING_SESSION : contains
  TRAINING_SESSION ||--o{ SESSION_METRIC : records
  RACE ||--o{ RACE_SPLIT : records
  PLANT ||--o{ MODULE : contains
  MODULE ||--o{ EQUIPMENT : identifies
  EQUIPMENT ||--o{ TAG : exposes
  MINING_RUN ||--o{ TELEMETRY_EVENT : scopes
  TAG ||--o{ TELEMETRY_EVENT : measures
  MINING_RUN ||--o{ STATE_EVENT : scopes
  PLANT ||--o{ STREAM : contains
  STREAM ||--o{ MEASUREMENT_BINDING : defines
  MEASUREMENT_BINDING ||--o{ CONNECTION_OBSERVATION : identifies
```

The ER diagram is conceptual, not a claim that Kusto enforces relational foreign
keys. V2 connection observations are not scoped by a run ID on the wire.
Canonical field definitions and compatibility rules are linked in the
[Developer contract map](developer.md#contracts-and-models).

![Native Fabric ontology editor: retained static model capture from 15 November, not live telemetry binding](screenshots/fabric-ontology-editor-2026-11-15.png)

The [capture gallery](screenshots.md) separates public operational views from
private Fabric operator views and their sign-in requirements.

## Key decisions and trade-offs

| Decision                                    | Why                                                            | Cost / limitation                                                         |
| ------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| One public Cockpit, two domain entries      | Reuse hosting/authentication without mixing domain permissions | Shared release and hosting blast radius                                   |
| Eventhouse serving over bounded KQL         | Near-real-time evidence and explicit query limits              | Capacity, ingestion lag, query throttling and update-policy correctness   |
| Lakehouse history plus Eventhouse shortcuts | Avoid another copied historical serving store                  | Shortcut/schema/freshness dependency                                      |
| Static ontology separate from telemetry     | Useful topology without claiming unsupported binding           | No accepted native full-property/time-series ontology binding             |
| Mining Blob lease and immutable holds       | Cross-replica single-writer authority and durable stop intent  | Coordination complexity; ambiguous operations require reconciliation      |
| Workload identities / OIDC                  | Avoid browser secrets and cloud passwords in CI                | Tenant configuration, exact audiences and permissions must be established |
| Account-free local profile                  | Reproducible Triathlon onboarding                              | In-memory, single-process; not Fabric or Mining evidence                  |
| Bounded Foundry evidence                    | Explain approved results, not arbitrary public KQL             | Optional model cost, availability and generated-answer risk               |

## Architecture debt and limits

| Debt                                                    | Consequence                                                           | Sensible next acceptance gate                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Triathlon process-local admission/stream state          | Replicas or restarts can split observations; no environment-wide lock | Shared admission and durable run/result protocol                        |
| Capacity-cycle Eventstream recovery is manual           | A source may run while derived routes remain paused                   | Scoped topology probe, approved repair, fresh exact-run receipts        |
| Native Operations Agent remains unconfigured            | No accepted autonomous native rule/actions path                       | Read back correct generated rules and prove a dry-run action            |
| Static ontology, no live telemetry binding              | Topology exploration is not live ontology processing                  | Supported binding plus timestamped end-to-end proof                     |
| Optional report/delegated features are tenant-sensitive | Item creation is not interactive/authentication acceptance            | Browser UAT with intended user/account and least privilege              |
| No production SLA, failover or no-loss guarantee        | Demo can become unavailable or stale                                  | Capacity/cost policy, SLOs, load/failure testing and recovery ownership |

Older milestone diagrams and dated evidence are retained in
[release architecture](release-architecture.md) and the [operations runbook](live-runtime-operations.md).
They are diagnostic references, not the current onboarding path.
