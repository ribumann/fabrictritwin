import { MiningQueryError } from "../mining/read/bounded-query.js";
import type { ContinuousMiningRunRecord } from "../mining/run-coordinator.js";
import type { ContinuousIncidentSnapshot } from "./continuous-replay.js";

export type ContinuousIncidentOwner = Pick<
  ContinuousMiningRunRecord,
  "runId" | "startedAt" | "authorityUntil" | "phase" | "lifetime" | "contract"
>;

interface Dependencies {
  load(
    owner: ContinuousIncidentOwner,
    asOf: string,
    signal: AbortSignal,
  ): Promise<ContinuousIncidentSnapshot>;
  isCurrentOwner(owner: ContinuousIncidentOwner, signal: AbortSignal): Promise<boolean>;
  now(): number;
}

const MINUTE = 60_000;
const CACHE_MS = 30_000;
const MAX_AGE_MS = 180_000;

/** Coalesces expensive reads without treating a cached snapshot as proof of current ownership. */
export function createContinuousSnapshotService(dependencies: Dependencies) {
  let cached: { key: string; snapshot: ContinuousIncidentSnapshot; expires: number } | undefined;
  let pending:
    | {
        key: string;
        controller: AbortController;
        waiters: number;
        promise: Promise<ContinuousIncidentSnapshot>;
      }
    | undefined;

  function waitFor(
    job: NonNullable<typeof pending>,
    signal: AbortSignal,
  ): Promise<ContinuousIncidentSnapshot> {
    signal.throwIfAborted();
    job.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        signal.removeEventListener("abort", cancel);
        job.waiters--;
        return true;
      };
      const cancel = () => {
        if (!finish()) return;
        if (job.waiters === 0) job.controller.abort();
        reject(new MiningQueryError("cancelled", "Continuous incident request was cancelled."));
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      job.promise.then(
        (snapshot) => {
          if (finish()) resolve(snapshot);
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  return async (
    owner: ContinuousIncidentOwner,
    signal: AbortSignal,
  ): Promise<ContinuousIncidentSnapshot> => {
    signal.throwIfAborted();
    const requestedAt = dependencies.now();
    const start = Date.parse(owner.startedAt);
    const until = Date.parse(owner.authorityUntil);
    if (
      !Number.isFinite(requestedAt) ||
      !Number.isFinite(start) ||
      !Number.isFinite(until) ||
      owner.phase !== "running" ||
      until <= requestedAt
    ) {
      throw new MiningQueryError("upstream", "Continuous incident owner is unavailable.");
    }
    // Leave one minute for ingestion; this is not a completeness watermark.
    const end = start + (Math.floor((requestedAt - start) / MINUTE) - 1) * MINUTE;
    if (end - start < 20 * MINUTE) {
      throw new MiningQueryError("upstream", "Continuous incident evidence is warming up.");
    }
    const asOf = new Date(end).toISOString();
    const key = JSON.stringify([
      owner.runId,
      owner.lifetime.generation,
      owner.startedAt,
      owner.contract,
      asOf,
    ]);
    const validate = (result: ContinuousIncidentSnapshot, responseAt: number) => {
      const observed = Date.parse(result.sourceObservedAt);
      if (
        !Number.isFinite(responseAt) ||
        result.assessmentKind !== "rolling-event-time-advisory" ||
        result.runId !== owner.runId ||
        result.asOf !== asOf ||
        result.windowStart !== new Date(Math.max(start, end - 20 * MINUTE)).toISOString() ||
        !Number.isFinite(observed) ||
        observed < end ||
        observed > responseAt ||
        responseAt - end > MAX_AGE_MS ||
        until <= responseAt
      ) {
        throw new MiningQueryError("upstream", "Continuous incident evidence is stale or invalid.");
      }
    };
    let snapshot: ContinuousIncidentSnapshot;
    if (cached?.key === key && cached.expires > requestedAt) {
      snapshot = cached.snapshot;
    } else {
      if (pending && (pending.key !== key || pending.controller.signal.aborted)) {
        throw new MiningQueryError("upstream", "Continuous incident evidence is being refreshed.");
      }
      if (!pending) {
        const controller = new AbortController();
        const job = {
          key,
          controller,
          waiters: 0,
          promise: Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return dependencies.load(owner, asOf, controller.signal);
          }),
        };
        pending = job;
        job.promise = job.promise.then(
          (result) => {
            if (pending === job) pending = undefined;
            if (!controller.signal.aborted) {
              const receivedAt = dependencies.now();
              validate(result, receivedAt);
              cached = { key, snapshot: result, expires: receivedAt + CACHE_MS };
            }
            return result;
          },
          (error: unknown) => {
            if (pending === job) pending = undefined;
            throw error;
          },
        );
      }
      snapshot = await waitFor(pending, signal);
    }
    signal.throwIfAborted();
    const current = await dependencies.isCurrentOwner(owner, signal);
    signal.throwIfAborted();
    if (!current) {
      throw new MiningQueryError("upstream", "Continuous incident owner changed during the read.");
    }
    validate(snapshot, dependencies.now());
    signal.throwIfAborted();
    return structuredClone(snapshot);
  };
}
