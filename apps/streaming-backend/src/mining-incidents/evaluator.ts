import { createHash } from "node:crypto";

type Scope = "A" | "B" | "C" | "shared";
type Rule =
  "crusher-bearing" | "dms-condition" | "shared-water" | "unplanned-stop" | "telemetry-stale";
type Quality = "good" | "uncertain" | "bad";
type PlantState = "starting" | "running" | "idle" | "stopped" | "fault";

export interface MiningTag {
  tagId: string;
  moduleId: string;
  scopeId: Scope;
  unit: string;
  intervalSeconds: 30 | 60;
}

interface Observation {
  runId: string;
  eventId: string;
  timestamp: string;
  /** Actual curated ingestion_time() provenance only; receipt time is not a substitute. */
  ingestionTime?: string | null;
}

export interface MiningReadingObservation extends Observation {
  kind: "reading";
  tagId: string;
  value: number;
  unit: string;
  quality: Quality;
  intervalSeconds: 30 | 60;
}

export interface MiningStateObservation extends Observation {
  kind: "state";
  scopeId: Scope;
  state: PlantState;
  scheduledRunning: boolean;
  sequence: number;
}

export interface MiningIncident {
  incidentId: string;
  ruleId: Rule;
  scopeId: string;
  severity: "warning" | "high";
  raisedAt: string;
  clearedAt: string | null;
  acknowledgedAt: string | null;
  verification: "verified" | "unverified";
}

export interface MiningIncidentTransition {
  eventId: string;
  runId: string;
  plantId: "D01";
  timestamp: string;
  transition: "raised" | "escalated" | "cleared";
  incident: MiningIncident;
  evidence: MiningIncidentEvidence[];
  stateEvidence: Array<MiningStateObservation & { ingestionTime: string | null }>;
  freshness: {
    lastValidAt: string | null;
    intervalSeconds: 30 | 60;
    staleAfterSeconds: number;
  } | null;
  evidenceWindow: { start: string; end: string } | null;
}

export interface MiningIncidentEvidence {
  eventId: string;
  tagId: string;
  value: number;
  unit: string;
  timestamp: string;
  quality: Quality;
  ingestionTime: string | null;
}

export interface MiningIncidentAssessment {
  runId: string;
  plantId: "D01";
  catalogHash: string;
  assessedAt: string;
  incident: MiningIncident;
  holdKind: "breach" | "recovery" | null;
  holdWindow: { start: string; end: string } | null;
  evidenceWindow: { start: string; end: string };
  evidence: MiningIncidentEvidence[];
  stateEvidence: Array<MiningStateObservation & { ingestionTime: string | null }>;
  freshness: MiningIncidentTransition["freshness"];
}

interface Span {
  start: number;
  end: number;
}

const MINUTE = 60_000;
const SCOPES: Scope[] = ["A", "B", "C", "shared"];

function utc(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Mining evidence requires canonical UTC timestamps.");
  }
  return parsed;
}

function common(...spans: Array<Span | undefined>): Span | undefined {
  if (spans.some((span) => !span)) return undefined;
  const present = spans.filter((span): span is Span => span !== undefined);
  const start = Math.max(...present.map((span) => span.start));
  const end = Math.min(...present.map((span) => span.end));
  return end > start ? { start, end } : undefined;
}

function held(span: Span | undefined, minutes: number): boolean {
  return span !== undefined && span.end - span.start >= minutes * MINUTE;
}

/**
 * Advisory state machine over curated observations, never simulator scenario truth.
 * The authorized runtime owns persistence, minute scheduling and notifications.
 */
export class MiningIncidentEvaluator {
  private readonly tags = new Map<string, MiningTag>();
  private readonly readings = new Map<string, MiningReadingObservation[]>();
  private readonly states = new Map<Scope, MiningStateObservation[]>();
  private readonly events = new Map<string, string>();
  private readonly incidents = new Map<string, MiningIncident>();
  private readonly assessments = new Map<string, MiningIncidentAssessment>();
  private readonly holdFloor = new Map<string, number>();
  private readonly startedAt: number;
  private readonly catalogHash: string;
  private evaluatedAt = -Infinity;

  constructor(
    private readonly runId: string,
    startedAt: string,
    tags: readonly MiningTag[],
  ) {
    this.startedAt = utc(startedAt);
    if (!runId || tags.length === 0 || tags.length > 56)
      throw new Error("Invalid mining run/catalog.");
    for (const tag of tags) {
      if (
        this.tags.has(tag.tagId) ||
        !tag.tagId.startsWith(`D01.${tag.scopeId}.`) ||
        !tag.moduleId ||
        !tag.unit ||
        !SCOPES.includes(tag.scopeId) ||
        ![30, 60].includes(tag.intervalSeconds)
      ) {
        throw new Error("Invalid or duplicate mining catalog tag.");
      }
      this.tags.set(tag.tagId, { ...tag });
    }
    this.catalogHash = createHash("sha256").update(JSON.stringify(tags)).digest("hex");
  }

  observe(
    observation: MiningReadingObservation | MiningStateObservation,
    receivedAt: string,
  ): void {
    const time = utc(observation.timestamp);
    const received = utc(receivedAt);
    if (observation.ingestionTime != null && utc(observation.ingestionTime) > received) {
      throw new Error("Mining ingestion provenance cannot be later than receipt.");
    }
    if (
      observation.runId !== this.runId ||
      !["reading", "state"].includes(observation.kind) ||
      !observation.eventId ||
      observation.eventId.length > 256 ||
      time < this.startedAt ||
      time > received ||
      time > this.startedAt + 30 * MINUTE
    ) {
      throw new Error("Invalid mining observation identity or time.");
    }
    const body = JSON.stringify(
      observation.kind === "reading"
        ? [
            observation.runId,
            observation.eventId,
            observation.timestamp,
            observation.kind,
            observation.tagId,
            observation.value,
            observation.unit,
            observation.quality,
            observation.intervalSeconds,
            observation.ingestionTime ?? null,
          ]
        : [
            observation.runId,
            observation.eventId,
            observation.timestamp,
            observation.kind,
            observation.scopeId,
            observation.state,
            observation.scheduledRunning,
            observation.sequence,
            observation.ingestionTime ?? null,
          ],
    );
    const prior = this.events.get(observation.eventId);
    if (prior !== undefined) {
      if (body !== prior) throw new Error("Conflicting mining event ID.");
      return;
    }
    if (this.events.size >= 4096) throw new Error("Mining run evidence budget exceeded.");
    if (observation.kind === "reading") {
      const tag = this.tags.get(observation.tagId);
      if (
        !tag ||
        tag.unit !== observation.unit ||
        tag.intervalSeconds !== observation.intervalSeconds ||
        !Number.isFinite(observation.value) ||
        !["good", "uncertain", "bad"].includes(observation.quality)
      ) {
        throw new Error("Mining reading does not match the catalog/quality contract.");
      }
      const rows = this.readings.get(tag.tagId) ?? [];
      if (rows.some((row) => row.timestamp === observation.timestamp)) {
        throw new Error("Conflicting mining tag timestamp.");
      }
      rows.push({ ...observation });
      rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      this.readings.set(tag.tagId, rows);
      if (rows.at(-1)?.eventId === observation.eventId && observation.quality !== "good") {
        this.invalidateProcess(tag.scopeId, [tag.tagId], time);
      }
    } else {
      if (
        !SCOPES.includes(observation.scopeId) ||
        !["starting", "running", "idle", "stopped", "fault"].includes(observation.state) ||
        typeof observation.scheduledRunning !== "boolean" ||
        !Number.isSafeInteger(observation.sequence) ||
        observation.sequence < 0
      ) {
        throw new Error("Invalid mining state observation.");
      }
      const rows = this.states.get(observation.scopeId) ?? [];
      if (
        rows.some(
          (row) => row.timestamp === observation.timestamp && row.sequence === observation.sequence,
        )
      ) {
        throw new Error("Conflicting mining state timestamp.");
      }
      rows.push({ ...observation });
      rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence);
      this.states.set(observation.scopeId, rows);
      if (rows.at(-1)?.eventId === observation.eventId && observation.state !== "running") {
        this.invalidateProcess(
          observation.scopeId,
          [...this.tags.values()]
            .filter((tag) => tag.scopeId === observation.scopeId)
            .map((tag) => tag.tagId),
          time,
        );
      }
    }
    this.events.set(observation.eventId, body);
  }

  evaluate(asOf: string): MiningIncidentTransition[] {
    const at = utc(asOf);
    if (
      at < this.startedAt ||
      at > this.startedAt + 30 * MINUTE ||
      (at - this.startedAt) % MINUTE !== 0 ||
      at < this.evaluatedAt
    ) {
      throw new Error("Mining evaluation requires forward minute boundaries.");
    }
    if (at === this.evaluatedAt) return [];
    this.evaluatedAt = at;
    const transitions: MiningIncidentTransition[] = [];
    for (const tag of this.tags.values()) {
      const latest = this.readingRows(tag.tagId, at).at(-1);
      if (
        !latest ||
        latest.quality !== "good" ||
        at - utc(latest.timestamp) >= tag.intervalSeconds * 1000 ||
        !this.stateSpan(tag.scopeId, at, (row) => row.state === "running")
      ) {
        this.holdFloor.set(tag.tagId, at);
      }
    }

    for (const scope of ["A", "B", "C"] as const) {
      const vibration = `D01.${scope}.crusher.vibration_rms`;
      const temperature = `D01.${scope}.crusher.bearing_temperature`;
      const density = `D01.${scope}.dms.medium_density`;
      const pressure = `D01.${scope}.dms.feed_pressure`;
      const rmsHigh = this.processSpan(vibration, at, (value) => value > 4.5);
      const temperatureHigh = this.processSpan(temperature, at, (value) => value > 75);
      const bearingClear = common(
        this.processSpan(vibration, at, (value) => value < 3.8),
        this.processSpan(temperature, at, (value) => value < 70),
      );
      this.update(
        transitions,
        "crusher-bearing",
        scope,
        at,
        held(rmsHigh, 2),
        held(bearingClear, 3),
        held(common(rmsHigh, temperatureHigh), 2) ? "high" : "warning",
        [vibration, temperature],
        held(rmsHigh, 2) ? rmsHigh : bearingClear,
        { breach: rmsHigh, recovery: bearingClear },
      );
      const dmsBad = this.eitherProcessSpan(
        [
          { tagId: density, predicate: (value) => value < 2800 || value > 3100 },
          { tagId: pressure, predicate: (value) => value < 200 || value > 400 },
        ],
        at,
      );
      const dmsClear = common(
        this.processSpan(density, at, (value) => value >= 2850 && value <= 3050),
        this.processSpan(pressure, at, (value) => value >= 230 && value <= 370),
      );
      this.update(
        transitions,
        "dms-condition",
        scope,
        at,
        held(dmsBad, 2),
        held(dmsClear, 3),
        "warning",
        [density, pressure],
        held(dmsBad, 2) ? dmsBad : dmsClear,
        { breach: dmsBad, recovery: dmsClear },
      );
      const stopped = this.stateSpan(
        scope,
        at,
        (state) => state.scheduledRunning && ["stopped", "fault"].includes(state.state),
      );
      const running = this.stateSpan(scope, at, (state) => state.state === "running");
      this.update(
        transitions,
        "unplanned-stop",
        scope,
        at,
        held(stopped, 2),
        held(running, 2),
        "warning",
        [],
        held(stopped, 2) ? stopped : running,
        { breach: stopped, recovery: running },
        stopped !== undefined || running !== undefined,
      );
    }
    const water = "D01.shared.water.level";
    const waterLow = this.processSpan(water, at, (value) => value < 25);
    const waterClear = this.processSpan(water, at, (value) => value > 35);
    this.update(
      transitions,
      "shared-water",
      "shared",
      at,
      held(waterLow, 2),
      held(waterClear, 3),
      "high",
      [water],
      held(waterLow, 2) ? waterLow : waterClear,
      { breach: waterLow, recovery: waterClear },
    );

    for (const tag of this.tags.values()) {
      const rows = this.readingRows(tag.tagId, at);
      const lastGood = rows.filter((row) => row.quality === "good").at(-1);
      const stale =
        at - (lastGood ? utc(lastGood.timestamp) : this.startedAt) >=
        (3 * tag.intervalSeconds + 15) * 1000;
      const active = this.incidents.get(`telemetry-stale:${tag.tagId}`);
      const recovered = rows.slice(-2);
      const clear =
        recovered.length === 2 &&
        recovered.every(
          (row) =>
            row.quality === "good" &&
            utc(row.timestamp) > utc(active?.raisedAt ?? asOf) &&
            at - utc(row.timestamp) < (3 * tag.intervalSeconds + 15) * 1000,
        ) &&
        utc(recovered[1].timestamp) - utc(recovered[0].timestamp) === tag.intervalSeconds * 1000;
      this.update(
        transitions,
        "telemetry-stale",
        tag.tagId,
        at,
        stale,
        clear,
        "warning",
        [tag.tagId],
        undefined,
        {},
        true,
        {
          lastValidAt: lastGood?.timestamp ?? null,
          intervalSeconds: tag.intervalSeconds,
          staleAfterSeconds: 3 * tag.intervalSeconds + 15,
        },
      );
    }
    for (const scope of SCOPES) {
      const rows = [
        ...new Map(this.stateRows(scope, at).map((row) => [row.timestamp, row])).values(),
      ];
      const latest = rows.at(-1);
      const stale = at - (latest ? utc(latest.timestamp) : this.startedAt) >= 195_000;
      const active = this.incidents.get(`telemetry-stale:state:${scope}`);
      const recovered = rows.slice(-2);
      const clear =
        recovered.length === 2 &&
        recovered.every(
          (row) =>
            utc(row.timestamp) > utc(active?.raisedAt ?? asOf) && at - utc(row.timestamp) < 195_000,
        ) &&
        utc(recovered[1].timestamp) - utc(recovered[0].timestamp) <= MINUTE;
      this.update(
        transitions,
        "telemetry-stale",
        `state:${scope}`,
        at,
        stale,
        clear,
        "warning",
        [],
        undefined,
        {},
        true,
        {
          lastValidAt: latest?.timestamp ?? null,
          intervalSeconds: 60,
          staleAfterSeconds: 195,
        },
      );
    }
    return transitions;
  }

  active(): MiningIncident[] {
    return [...this.incidents.values()]
      .filter((incident) => !incident.clearedAt)
      .map((incident) => ({ ...incident }));
  }

  /** Current evaluated proof, not a reconstruction from the last transition/outbox page. */
  activeAssessments(): MiningIncidentAssessment[] {
    return [...this.assessments.entries()].flatMap(([key, assessment]) => {
      const incident = this.incidents.get(key);
      return incident && !incident.clearedAt
        ? [structuredClone({ ...assessment, incident: { ...incident } })]
        : [];
    });
  }

  acknowledge(incidentId: string, timestamp: string): void {
    const at = utc(timestamp);
    const incident = [...this.incidents.values()].find((item) => item.incidentId === incidentId);
    if (!incident || incident.clearedAt || at < utc(incident.raisedAt)) {
      throw new Error(
        "Cannot acknowledge an unknown/cleared mining incident or a prior timestamp.",
      );
    }
    incident.acknowledgedAt ??= timestamp;
  }

  private readingRows(tagId: string, at: number): MiningReadingObservation[] {
    return (this.readings.get(tagId) ?? []).filter((row) => utc(row.timestamp) <= at);
  }

  private invalidateProcess(scope: Scope, tagIds: string[], at: number): void {
    for (const tagId of tagIds) {
      this.holdFloor.set(tagId, Math.max(this.holdFloor.get(tagId) ?? -Infinity, at));
    }
    for (const incident of this.incidents.values()) {
      if (
        !incident.clearedAt &&
        incident.scopeId === scope &&
        tagIds.some((tagId) => {
          if (incident.ruleId === "crusher-bearing")
            return [
              `D01.${scope}.crusher.vibration_rms`,
              `D01.${scope}.crusher.bearing_temperature`,
            ].includes(tagId);
          if (incident.ruleId === "dms-condition")
            return [`D01.${scope}.dms.medium_density`, `D01.${scope}.dms.feed_pressure`].includes(
              tagId,
            );
          return incident.ruleId === "shared-water" && tagId === "D01.shared.water.level";
        })
      ) {
        incident.verification = "unverified";
        const assessment = this.assessments.get(`${incident.ruleId}:${incident.scopeId}`);
        if (assessment) {
          assessment.holdKind = null;
          assessment.holdWindow = null;
        }
      }
    }
  }

  private stateRows(scope: Scope, at: number): MiningStateObservation[] {
    return (this.states.get(scope) ?? []).filter((row) => utc(row.timestamp) <= at);
  }

  private stateSpan(
    scope: Scope,
    at: number,
    predicate: (state: MiningStateObservation) => boolean,
  ): Span | undefined {
    const rows = this.stateRows(scope, at);
    const latest = rows.at(-1);
    if (!latest || at - utc(latest.timestamp) >= 195_000 || !predicate(latest)) return undefined;
    let start = utc(latest.timestamp);
    for (let index = rows.length - 2; index >= 0; index--) {
      const row = rows[index];
      if (!predicate(row) || start - utc(row.timestamp) >= 195_000) break;
      start = utc(row.timestamp);
    }
    return { start, end: at };
  }

  private processSpan(
    tagId: string,
    at: number,
    predicate: (value: number) => boolean,
  ): Span | undefined {
    const tag = this.tags.get(tagId);
    if (!tag) return undefined;
    const running = this.stateSpan(tag.scopeId, at, (row) => row.state === "running");
    if (!running) return undefined;
    const rows = this.readingRows(tagId, at);
    const latest = rows.at(-1);
    const interval = tag.intervalSeconds * 1000;
    if (!latest || at - utc(latest.timestamp) >= interval) return undefined;
    const end = utc(latest.timestamp);
    const readyAt = Math.max(running.start + 2 * MINUTE, this.holdFloor.get(tagId) ?? -Infinity);
    const snapshot = tagId.endsWith(".bearing_temperature") || tagId.endsWith(".level");
    let start = end;
    let expected = end;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      const time = utc(row.timestamp);
      if (
        row.quality !== "good" ||
        !predicate(row.value) ||
        time !== expected ||
        (snapshot ? time : time - interval) < readyAt
      )
        break;
      start = snapshot ? time : time - interval;
      expected = time - interval;
    }
    return end > start ? { start, end } : undefined;
  }

  private eitherProcessSpan(
    conditions: Array<{ tagId: string; predicate: (value: number) => boolean }>,
    at: number,
  ): Span | undefined {
    const spans: Span[] = [];
    let currentEnd = -Infinity;
    for (const { tagId, predicate } of conditions) {
      const tag = this.tags.get(tagId);
      if (!tag) continue;
      const running = this.stateSpan(tag.scopeId, at, (row) => row.state === "running");
      if (!running) continue;
      const interval = tag.intervalSeconds * 1000;
      const readyAt = Math.max(running.start + 2 * MINUTE, this.holdFloor.get(tagId) ?? -Infinity);
      for (const row of this.readingRows(tagId, at)) {
        const end = utc(row.timestamp);
        if (row.quality !== "good" || !predicate(row.value) || end - interval < readyAt) continue;
        spans.push({ start: end - interval, end });
        if (at - end < interval) currentEnd = Math.max(currentEnd, end);
      }
    }
    spans.sort((a, b) => a.start - b.start);
    let combined: Span | undefined;
    for (const span of spans) {
      if (combined && span.start <= combined.end) {
        combined.end = Math.max(combined.end, span.end);
      } else {
        combined = { ...span };
      }
    }
    return combined && combined.end === currentEnd ? combined : undefined;
  }

  private update(
    output: MiningIncidentTransition[],
    ruleId: Rule,
    scopeId: string,
    at: number,
    raise: boolean,
    clear: boolean,
    severity: MiningIncident["severity"],
    tagIds: string[],
    span: Span | undefined,
    current: { breach?: Span; recovery?: Span },
    verified?: boolean,
    freshness?: MiningIncidentTransition["freshness"],
  ): void {
    const key = `${ruleId}:${scopeId}`;
    let incident = this.incidents.get(key);
    const active = incident && !incident.clearedAt;
    const currentGood =
      verified ??
      tagIds.every((tagId) => {
        return this.processSpan(tagId, at, () => true) !== undefined;
      });
    let transition: MiningIncidentTransition["transition"] | undefined;
    if (!active && raise) {
      incident = {
        incidentId: this.id(`${key}:raised:${at}`),
        ruleId,
        scopeId,
        severity,
        raisedAt: new Date(at).toISOString(),
        clearedAt: null,
        acknowledgedAt: null,
        verification: currentGood ? "verified" : "unverified",
      };
      this.incidents.set(key, incident);
      transition = "raised";
    } else if (active && incident) {
      incident.verification = currentGood ? "verified" : "unverified";
      if (clear) {
        incident.clearedAt = new Date(at).toISOString();
        transition = "cleared";
      } else if (raise && severity === "high" && incident.severity !== "high") {
        incident.severity = "high";
        transition = "escalated";
      }
    } else return;
    if (!incident) throw new Error("Missing mining incident transition state.");
    const hold = current.breach ?? current.recovery;
    this.assessments.set(key, {
      runId: this.runId,
      plantId: "D01",
      catalogHash: this.catalogHash,
      assessedAt: new Date(at).toISOString(),
      incident: { ...incident },
      holdKind: hold ? (current.breach ? "breach" : "recovery") : null,
      holdWindow: hold
        ? { start: new Date(hold.start).toISOString(), end: new Date(hold.end).toISOString() }
        : null,
      ...this.evidence(tagIds, scopeId, at, {
        start: Math.max(this.startedAt, at - 3 * MINUTE),
        end: at,
      }),
      freshness: freshness ?? null,
    });
    if (!transition) return;
    const evidenceSpan = span
      ? { start: Math.max(span.start, span.end - 3 * MINUTE), end: span.end }
      : { start: Math.max(this.startedAt, at - 3 * MINUTE), end: at };
    output.push({
      eventId: this.id(`${key}:${transition}:${at}`),
      runId: this.runId,
      plantId: "D01",
      timestamp: new Date(at).toISOString(),
      transition,
      incident: { ...incident },
      ...this.evidence(tagIds, scopeId, at, evidenceSpan),
      freshness: freshness ?? null,
    });
  }

  private evidence(
    tagIds: string[],
    scopeId: string,
    at: number,
    evidenceSpan: Span,
  ): Pick<MiningIncidentAssessment, "evidence" | "stateEvidence" | "evidenceWindow"> {
    const stateScopes = new Set(
      tagIds.flatMap((tagId) => {
        const tag = this.tags.get(tagId);
        return tag ? [tag.scopeId] : [];
      }),
    );
    const stateScope = SCOPES.find((scope) => scopeId === scope || scopeId === `state:${scope}`);
    if (stateScope) stateScopes.add(stateScope);
    return {
      evidence: tagIds.flatMap((tagId) => {
        const rows = this.readingRows(tagId, at);
        const selected = rows.filter(
          (row) =>
            (tagId.endsWith(".bearing_temperature") || tagId.endsWith(".level")
              ? utc(row.timestamp) >= evidenceSpan.start
              : utc(row.timestamp) > evidenceSpan.start) && utc(row.timestamp) <= evidenceSpan.end,
        );
        return selected.map((row) => ({
          eventId: row.eventId,
          tagId,
          value: row.value,
          unit: row.unit,
          timestamp: row.timestamp,
          quality: row.quality,
          ingestionTime: row.ingestionTime ?? null,
        }));
      }),
      stateEvidence: [...stateScopes].flatMap((scope) =>
        this.stateRows(scope, at)
          .filter(
            (row) =>
              utc(row.timestamp) >= evidenceSpan.start && utc(row.timestamp) <= evidenceSpan.end,
          )
          .map((row) => ({ ...row, ingestionTime: row.ingestionTime ?? null })),
      ),
      evidenceWindow: {
        start: new Date(evidenceSpan.start).toISOString(),
        end: new Date(evidenceSpan.end).toISOString(),
      },
    };
  }

  private id(value: string): string {
    return createHash("sha256").update(`${this.runId}:${value}`).digest("hex");
  }
}
