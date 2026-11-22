import {
  D01_CONNECTION_PROFILE_VERSION,
  createD01ConnectionEventId,
  createD01SharedFlowSimulation,
  toD01ConnectionMeasurementBindingRecords,
  type D01ConnectionMeasurementEvent,
} from "@triathlon-twin/simulator/mining";
import { createMiningConnectionRunProfilePin, type MiningRunStatus } from "../run-coordinator.js";
import { createD01SharedFlowRunContract } from "../../mining-incidents/catalog.js";
import { MiningQueryError } from "./bounded-query.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const pageSize = 200;

function validatedRun(status: MiningRunStatus) {
  const run = status.run;
  if (
    status.admission !== "accepted" ||
    status.phase !== "publisher_complete" ||
    status.stopRequested ||
    !run ||
    status.runId !== run.runId ||
    !("profileVersion" in run) ||
    run.profileVersion !== D01_CONNECTION_PROFILE_VERSION ||
    run.phase !== "publisher_complete" ||
    run.scenario !== "normal" ||
    run.seed !== 1 ||
    !uuid.test(run.runId) ||
    !Number.isInteger(run.durationSeconds) ||
    run.durationSeconds < 5 ||
    run.durationSeconds > 1800 ||
    run.durationSeconds % 5 !== 0 ||
    !Number.isFinite(Date.parse(run.startedAt)) ||
    Date.parse(run.stopAt) - Date.parse(run.startedAt) !== run.durationSeconds * 1000
  ) {
    throw new MiningQueryError(
      "invalid",
      "Expected connection events require a completed normal shared-flow run.",
    );
  }
  createMiningConnectionRunProfilePin(run);
  createD01SharedFlowRunContract();
  return run;
}

/** Expected IDs for a completed normal profile, not proof of receipt or validation. */
export function* expectedConnectionEventBatches(status: MiningRunStatus): Generator<string[]> {
  const run = validatedRun(status);
  const total = (run.durationSeconds / 5) * toD01ConnectionMeasurementBindingRecords().length;
  for (let first = 1; first <= total; first += pageSize) {
    const last = Math.min(total, first + pageSize - 1);
    yield Array.from({ length: last - first + 1 }, (_, offset) =>
      createD01ConnectionEventId(run.runId, first + offset),
    );
  }
}

/** Rebuild the pinned normal schedule, including its values, in bounded pages. */
export function* expectedConnectionObservationBatches(
  status: MiningRunStatus,
): Generator<D01ConnectionMeasurementEvent[]> {
  const run = validatedRun(status);
  const start = Date.parse(run.startedAt);
  const simulation = createD01SharedFlowSimulation(
    {
      runId: run.runId,
      startedAt: new Date(start),
      durationSeconds: run.durationSeconds,
      shutdownAtSeconds: run.shutdownAtSeconds,
      drainDownSeconds: run.drainDownSeconds,
    },
    () => Date.parse(run.stopAt),
  );
  let page: D01ConnectionMeasurementEvent[] = [];
  for (let seconds = 5; seconds <= run.durationSeconds; seconds += 5) {
    for (const event of simulation.step(new Date(start + seconds * 1000)).observations) {
      page.push(event);
      if (page.length === pageSize) {
        yield page;
        page = [];
      }
    }
  }
  if (page.length) yield page;
}
