import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { MiningCoordinationError, type MiningStore, type StoredDocument } from "../mining/store.js";
import {
  MiningIncidentEvaluator,
  type MiningIncidentTransition,
  type MiningReadingObservation,
  type MiningStateObservation,
  type MiningTag,
} from "./evaluator.js";
import {
  assertD01RunContract,
  createD01VersionedIncidentRun,
  type D01RunContract,
} from "./catalog.js";

type Observation = MiningReadingObservation | MiningStateObservation;
type Command =
  | { kind: "observe"; observation: Observation; receivedAt: string }
  | { kind: "evaluate"; asOf: string }
  | { kind: "ack"; incidentId: string; at: string };

export interface MiningIncidentRun {
  runId: string;
  startedAt: string;
  endsAt: string;
  tags: readonly MiningTag[];
  /** Present only for a prospective schema-2 journal; absent on legacy schema 1. */
  contract?: D01RunContract;
}

/**
 * Host-owned delegated boundary, NOT an environment flag or managed-identity grant.
 * checkRun must reject accepted stops, disconnects, revoked approval and wrong runs.
 */
export interface MiningIncidentAuthority {
  authorize(
    operation: "fresh" | "recover" | "acknowledge",
    run: MiningIncidentRun,
    signal: AbortSignal,
  ): Promise<void>;
  checkRun(run: MiningIncidentRun, signal: AbortSignal): Promise<void>;
}

/** Only strictly validated, curated, run-correlated G5 observations belong here. */
export interface MiningIncidentSource {
  read(input: {
    runId: string;
    asOf: string;
    signal: AbortSignal;
  }): Promise<{ observations: readonly Observation[]; receivedAt: string }>;
}

interface Head {
  schema: 1 | 2;
  binding: string;
  tail: string | null;
  pages: number;
  bytes: number;
}

interface Page {
  schema: 1 | 2;
  binding: string;
  previous: string | null;
  commands: Command[];
}

export interface MiningIncidentDependencies {
  store: MiningIncidentStore;
  authority: MiningIncidentAuthority;
  source: MiningIncidentSource;
  now?: () => number;
  monotonic?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

/** Uses the reader-owned optional cancellation contract without changing MiningStore. */
export interface MiningIncidentStore extends MiningStore {
  read(path: string, signal?: AbortSignal): Promise<StoredDocument | undefined>;
}

const MINUTE = 60_000;
const MAX_PAGE_BYTES = 16_384;
const MAX_JOURNAL_BYTES = 2_097_152;
const MAX_PAGES = 512;
const MAX_ACKS = 256;
const IO_TIMEOUT = 10_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function invalid(message: string): never {
  throw new MiningCoordinationError("invalid", message);
}

function utc(value: string): number {
  const at = Date.parse(value);
  if (!Number.isFinite(at) || new Date(at).toISOString() !== value)
    invalid("Incident journal requires canonical UTC.");
  return at;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Corrupt incident journal object.");
  return value as Record<string, unknown>;
}

function head(value: unknown, binding: string, schema: 1 | 2): Head {
  const row = object(value);
  if (
    Object.keys(row).sort().join() !== "binding,bytes,pages,schema,tail" ||
    row.schema !== schema ||
    row.binding !== binding ||
    (row.tail !== null && (typeof row.tail !== "string" || !/^[a-f0-9]{64}$/.test(row.tail))) ||
    !Number.isSafeInteger(row.pages) ||
    !Number.isSafeInteger(row.bytes) ||
    Number(row.pages) < 0 ||
    Number(row.pages) > MAX_PAGES ||
    Number(row.bytes) < 0 ||
    Number(row.bytes) > MAX_JOURNAL_BYTES ||
    (row.pages === 0) !== (row.tail === null) ||
    (row.pages === 0) !== (row.bytes === 0)
  )
    invalid("Incompatible/corrupt incident head or run/catalog binding.");
  return row as unknown as Head;
}

function definition(input: MiningIncidentRun): MiningIncidentRun {
  const run = structuredClone(input);
  if ("contract" in run) {
    try {
      assertD01RunContract(run.contract);
      const canonical = createD01VersionedIncidentRun({
        runId: run.runId,
        startedAt: run.startedAt,
        stopAt: run.endsAt,
        contract: run.contract,
      });
      if (JSON.stringify(run) !== JSON.stringify(canonical))
        invalid("Noncanonical versioned incident run/catalog binding.");
    } catch (cause) {
      throw new MiningCoordinationError("invalid", "Invalid versioned incident run binding.", {
        cause,
      });
    }
  }
  const start = utc(run.startedAt);
  const end = utc(run.endsAt);
  if (
    !run.runId ||
    run.runId.length > 256 ||
    end <= start ||
    end - start > 30 * MINUTE ||
    (end - start) % MINUTE !== 0 ||
    bytes(run) > MAX_PAGE_BYTES
  )
    invalid("Incident processing requires a bounded approved minute-relative run/catalog.");
  // Catalog iteration order participates in deterministic transition ordering.
  new MiningIncidentEvaluator(run.runId, run.startedAt, run.tags);
  return run;
}

class Replay {
  readonly evaluator: MiningIncidentEvaluator;
  readonly notifications = new Map<string, MiningIncidentTransition>();
  readonly acknowledgements = new Map<string, string>();
  lastMinute = -1;
  observations = 0;
  acks = 0;
  private lastArrival = -Infinity;

  constructor(private readonly run: MiningIncidentRun) {
    this.evaluator = new MiningIncidentEvaluator(run.runId, run.startedAt, run.tags);
  }

  apply(command: Command): void {
    const row = object(command);
    if (command.kind === "observe") {
      if (Object.keys(row).sort().join() !== "kind,observation,receivedAt")
        invalid("Corrupt incident observation command.");
      const received = utc(command.receivedAt);
      if (received < this.lastArrival) invalid("Incident receipt order moved backwards.");
      if (utc(command.observation.timestamp) > utc(this.run.endsAt))
        invalid("Incident observation is outside the approved run.");
      this.lastArrival = received;
      if (++this.observations > 4096) invalid("Incident journal observation budget exceeded.");
      this.evaluator.observe(command.observation, command.receivedAt);
    } else if (command.kind === "evaluate") {
      if (Object.keys(row).sort().join() !== "asOf,kind")
        invalid("Corrupt incident evaluation command.");
      const at = utc(command.asOf);
      const minute = (at - utc(this.run.startedAt)) / MINUTE;
      if (minute !== this.lastMinute + 1 || at > utc(this.run.endsAt))
        invalid("Incident journal skipped/repeated a run minute.");
      for (const transition of this.evaluator.evaluate(command.asOf)) {
        if (this.notifications.has(transition.eventId))
          invalid("Duplicate incident notification identity.");
        this.notifications.set(transition.eventId, transition);
      }
      this.lastMinute = minute;
    } else if (command.kind === "ack") {
      if (Object.keys(row).sort().join() !== "at,incidentId,kind")
        invalid("Corrupt incident acknowledgement command.");
      const at = utc(command.at);
      if (
        at < this.lastArrival ||
        this.acknowledgements.has(command.incidentId) ||
        ++this.acks > MAX_ACKS
      )
        invalid("Invalid/repeated incident acknowledgement order or budget.");
      this.lastArrival = at;
      this.evaluator.acknowledge(command.incidentId, command.at);
      this.acknowledgements.set(command.incidentId, command.at);
    } else invalid("Unknown incident journal command.");
  }
}

const headPath = (runId: string) => `incidents/D01/${digest(runId)}/head.json`;
const pagePath = (path: string, hash: string) => path.replace("head.json", `${hash}.json`);

async function loadJournal(
  run: MiningIncidentRun,
  checkpoint: Head,
  read: (path: string) => Promise<StoredDocument | undefined>,
): Promise<{ journal: Command[]; state: Replay }> {
  let tail = checkpoint.tail;
  let total = 0;
  const pages: Page[] = [];
  for (let index = 0; index < checkpoint.pages; index++) {
    if (!tail) invalid("Truncated incident journal.");
    const stored = await read(pagePath(headPath(run.runId), tail));
    if (!stored || digest(stored.value) !== tail) invalid("Missing/corrupt incident journal page.");
    const row = object(stored.value);
    if (
      Object.keys(row).sort().join() !== "binding,commands,previous,schema" ||
      row.schema !== checkpoint.schema ||
      row.binding !== checkpoint.binding ||
      !Array.isArray(row.commands) ||
      !row.commands.length ||
      row.commands.length > 4383 ||
      (row.previous !== null &&
        (typeof row.previous !== "string" || !/^[a-f0-9]{64}$/.test(row.previous))) ||
      bytes(row) > MAX_PAGE_BYTES
    )
      invalid("Incompatible/corrupt incident journal page.");
    total += bytes(row);
    if (total > MAX_JOURNAL_BYTES) invalid("Incident journal byte budget exceeded.");
    const page = row as unknown as Page;
    pages.push(page);
    tail = page.previous;
  }
  if (tail !== null || total !== checkpoint.bytes) invalid("Incident journal chain mismatch.");
  const journal = pages.reverse().flatMap((page) => page.commands);
  if (journal.length > 4383) invalid("Incident command budget exceeded.");
  const state = new Replay(run);
  for (const command of journal) state.apply(command);
  if (journal.length && journal.at(-1)?.kind === "observe")
    invalid("Incident head points at an incomplete minute.");
  return { journal, state };
}

function snapshot(run: MiningIncidentRun, state: Replay) {
  return {
    runId: run.runId,
    binding: digest(run),
    asOf:
      state.lastMinute < 0
        ? null
        : new Date(utc(run.startedAt) + state.lastMinute * MINUTE).toISOString(),
    incidents: state.evaluator.active(),
    assessments: state.evaluator.activeAssessments(),
  };
}

function outbox(state: Replay, afterId?: string, limit = 100): MiningIncidentTransition[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    invalid("Incident outbox page size must be 1..100.");
  const rows = [...state.notifications.values()];
  const index = afterId ? rows.findIndex((row) => row.eventId === afterId) : -1;
  if (afterId && index < 0) invalid("Unknown incident outbox cursor.");
  return structuredClone(rows.slice(index + 1, index + 1 + limit));
}

/** Pure persisted read: no leases, source reads, recovery, mutation or ingestion-proof claim. */
export async function readMiningIncidentJournal(
  store: Pick<MiningIncidentStore, "read">,
  input: MiningIncidentRun,
  options: { signal?: AbortSignal; afterId?: string; limit?: number } = {},
) {
  const run = definition(input);
  const read = async (path: string) => {
    options.signal?.throwIfAborted();
    const document = await store.read(path, options.signal);
    options.signal?.throwIfAborted();
    return document;
  };
  const document = await read(headPath(run.runId));
  if (!document) return undefined;
  const checkpoint = head(document.value, digest(run), run.contract ? 2 : 1);
  const { state } = await loadJournal(run, checkpoint, read);
  return { ...snapshot(run, state), notifications: outbox(state, options.afterId, options.limit) };
}

/**
 * Unmounted/default-off. Only explicit trusted fresh/recover operations acquire authority.
 * The leased head is the sole commit point; immutable pages alone have no effects.
 */
export class MiningIncidentRuntime {
  private readonly cancellation = new AbortController();
  private readonly leaseId = randomUUID();
  private readonly path: string;
  private readonly binding: string;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly deadline: number;
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private journal: Command[] = [];
  private state: Replay;
  private checkpoint: Head;
  private etag = "";
  private busy = false;
  private acquired = false;
  private closePromise?: Promise<void>;

  private constructor(
    private readonly run: MiningIncidentRun,
    private readonly dependencies: MiningIncidentDependencies,
  ) {
    this.binding = digest(run);
    this.path = headPath(run.runId);
    this.now = dependencies.now ?? Date.now;
    this.monotonic = dependencies.monotonic ?? (() => performance.now());
    this.deadline = this.monotonic() + 31 * MINUTE;
    this.wait = dependencies.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }));
    this.state = new Replay(run);
    this.checkpoint = {
      schema: run.contract ? 2 : 1,
      binding: this.binding,
      tail: null,
      pages: 0,
      bytes: 0,
    };
  }

  static async open(
    input: MiningIncidentRun,
    mode: "fresh" | "recover",
    dependencies: MiningIncidentDependencies,
    cancellation?: AbortSignal,
  ): Promise<MiningIncidentRuntime> {
    if (!["fresh", "recover"].includes(mode))
      invalid("Explicit incident activation mode required.");
    const runtime = new MiningIncidentRuntime(definition(input), dependencies);
    if (cancellation) {
      const cancel = () => {
        runtime.cancellation.abort(cancellation.reason);
      };
      cancellation.addEventListener("abort", cancel, { once: true });
      runtime.cancellation.signal.addEventListener(
        "abort",
        () => cancellation.removeEventListener("abort", cancel),
        { once: true },
      );
      if (cancellation.aborted) runtime.cancellation.abort(cancellation.reason);
    }
    try {
      await runtime.io((signal) => dependencies.authority.authorize(mode, runtime.run, signal));
      await runtime.check();
      const existing = await runtime.read(runtime.path);
      if (mode === "fresh") {
        if (existing || !(await dependencies.store.create(runtime.path, runtime.checkpoint)))
          throw new MiningCoordinationError(
            "conflict",
            "Incident run already exists; explicitly recover.",
          );
      } else if (!existing) invalid("Cannot recover a missing incident journal.");
      runtime.alive();
      if (!(await dependencies.store.acquire(runtime.path, runtime.leaseId)))
        throw new MiningCoordinationError("conflict", "Another incident processor owns this run.");
      runtime.acquired = true;
      runtime.alive();
      const stored = await runtime.read(runtime.path);
      if (!stored) invalid("Incident head disappeared.");
      runtime.checkpoint = head(stored.value, runtime.binding, runtime.checkpoint.schema);
      runtime.etag = stored.etag;
      await runtime.restore();
      await runtime.check();
      await runtime.renew();
      return runtime;
    } catch (error) {
      await runtime.close().catch((cleanup: unknown) => {
        throw new AggregateError([error, cleanup], "Incident activation and lease cleanup failed.");
      });
      throw error;
    }
  }

  /** Read committed local state only; does not activate, recover, evaluate or query Fabric. */
  snapshot() {
    this.alive();
    return snapshot(this.run, this.state);
  }

  /** Durable availability, not a claim of delivery. No reminders or external sends. */
  outbox(afterId?: string, limit = 100) {
    this.alive();
    return outbox(this.state, afterId, limit);
  }

  async processMinute(asOf: string): Promise<void> {
    return this.exclusive(async () => {
      const minute = (utc(asOf) - utc(this.run.startedAt)) / MINUTE;
      if (
        !Number.isInteger(minute) ||
        minute < 0 ||
        utc(asOf) > utc(this.run.endsAt) ||
        utc(asOf) > this.now()
      )
        invalid("Incident minute is outside the real approved run interval.");
      await this.check();
      await this.renew();
      if (minute <= this.state.lastMinute) return;
      if (minute !== this.state.lastMinute + 1)
        invalid("Incident processing cannot skip a minute.");
      const batch = await this.io((signal) =>
        this.dependencies.source.read({ runId: this.run.runId, asOf, signal }),
      );
      this.alive();
      if (
        !Array.isArray(batch.observations) ||
        batch.observations.length > 4096 ||
        utc(batch.receivedAt) < utc(asOf) ||
        utc(batch.receivedAt) > this.now()
      )
        invalid("Invalid curated incident receipt/batch.");
      const commands: Command[] = batch.observations.map((observation) => ({
        kind: "observe",
        observation: structuredClone(observation),
        receivedAt: batch.receivedAt,
      }));
      commands.push({ kind: "evaluate", asOf });
      await this.commit(commands);
    });
  }

  async acknowledge(incidentId: string, at: string): Promise<void> {
    return this.exclusive(async () => {
      await this.io((signal) =>
        this.dependencies.authority.authorize("acknowledge", this.run, signal),
      );
      await this.check();
      await this.renew();
      if (utc(at) > this.now()) invalid("Incident acknowledgement is in the future.");
      if (this.state.acknowledgements.has(incidentId)) return;
      await this.commit([{ kind: "ack", incidentId, at }]);
    });
  }

  /** Explicit caller-owned loop. Recovery replays missed minutes, never invents observations. */
  async runScheduled(): Promise<void> {
    try {
      const last = (utc(this.run.endsAt) - utc(this.run.startedAt)) / MINUTE;
      for (let minute = this.state.lastMinute + 1; minute <= last; minute++) {
        const due = utc(this.run.startedAt) + minute * MINUTE;
        while (this.now() < due) {
          await this.check();
          await this.renew();
          await this.io((signal) => this.wait(Math.min(15_000, due - this.now()), signal), 20_000);
        }
        await this.processMinute(new Date(due).toISOString());
      }
    } finally {
      await this.close();
    }
  }

  /** Abort synchronously, release the actual commit fence, and never retry unknown writes. */
  close(): Promise<void> {
    this.cancellation.abort(new MiningCoordinationError("cancelled", "Incident processor closed."));
    if (this.acquired)
      this.closePromise ??= this.dependencies.store.release(this.path, this.leaseId);
    return this.closePromise ?? Promise.resolve();
  }

  private alive(): void {
    this.cancellation.signal.throwIfAborted();
    if (this.monotonic() >= this.deadline)
      throw new MiningCoordinationError(
        "cancelled",
        "Incident activation exceeded its 31-minute lifetime.",
      );
  }

  private async io<T>(work: (signal: AbortSignal) => Promise<T>, timeout = IO_TIMEOUT): Promise<T> {
    this.alive();
    const remaining = Math.max(1, Math.ceil(Math.min(timeout, this.deadline - this.monotonic())));
    const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(remaining)]);
    // Await actual settlement; never release authority around an unobserved background write.
    const result = await work(signal);
    signal.throwIfAborted();
    this.alive();
    return result;
  }

  private async read(path: string) {
    return this.io((signal) => this.dependencies.store.read(path, signal));
  }

  private async check(): Promise<void> {
    await this.io((signal) => this.dependencies.authority.checkRun(this.run, signal));
  }

  private async renew(): Promise<void> {
    await this.io(() => this.dependencies.store.renew(this.path, this.leaseId));
  }

  private async exclusive(work: () => Promise<void>): Promise<void> {
    this.alive();
    if (this.busy)
      throw new MiningCoordinationError("conflict", "Incident operation already in flight.");
    this.busy = true;
    try {
      await work();
    } catch (error) {
      await this.close().catch((cleanup: unknown) => {
        throw new AggregateError([error, cleanup], "Incident operation and cleanup failed.");
      });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private async restore(): Promise<void> {
    const { state, journal } = await loadJournal(this.run, this.checkpoint, async (path) => {
      await this.renew();
      return this.read(path);
    });
    this.state = state;
    this.journal = journal;
  }

  private async commit(commands: Command[]): Promise<void> {
    const candidate = new Replay(this.run);
    for (const command of [...this.journal, ...commands]) candidate.apply(command);
    let next = { ...this.checkpoint };
    const staged: Page[] = [];
    let page: Page = {
      schema: next.schema,
      binding: this.binding,
      previous: next.tail,
      commands: [],
    };
    const seal = () => {
      staged.push(page);
      next = {
        ...next,
        tail: digest(page),
        pages: next.pages + 1,
        bytes: next.bytes + bytes(page),
      };
      page = { schema: next.schema, binding: this.binding, previous: next.tail, commands: [] };
    };
    for (const command of commands) {
      page.commands.push(command);
      if (bytes(page) > MAX_PAGE_BYTES) {
        page.commands.pop();
        if (page.commands.length) seal();
        page.commands.push(command);
        if (bytes(page) > MAX_PAGE_BYTES)
          invalid("Incident command exceeds storage document limit.");
      }
    }
    if (page.commands.length) seal();
    if (next.pages > MAX_PAGES || next.bytes > MAX_JOURNAL_BYTES)
      invalid("Incident journal storage budget exceeded.");
    for (const item of staged) {
      await this.check();
      const path = pagePath(this.path, digest(item));
      if (!(await this.io(() => this.dependencies.store.create(path, item)))) {
        const existing = await this.read(path);
        if (!existing || digest(existing.value) !== digest(item))
          invalid("Conflicting immutable incident page.");
      }
    }
    await this.check();
    await this.renew();
    this.alive();
    // Both conditions apply to THIS leased blob, not an unrelated lock blob.
    let etag: string;
    try {
      etag = await this.io(() =>
        this.dependencies.store.write(this.path, next, this.etag, this.leaseId),
      );
    } catch (error) {
      if (error instanceof MiningCoordinationError && error.code === "lease_lost") throw error;
      throw new MiningCoordinationError(
        "uncertain",
        "Incident head commit is unconfirmed; explicitly recover before any retry.",
        { cause: error },
      );
    }
    this.alive();
    this.etag = etag;
    this.checkpoint = next;
    this.journal.push(...commands);
    this.state = candidate;
  }
}
