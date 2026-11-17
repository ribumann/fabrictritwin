import { MiningQueryError } from "../mining/read/bounded-query.js";
import { assertD01RunContract, createD01IncidentRun } from "./catalog.js";
import { replayContinuousIncidentSnapshot } from "./continuous-replay.js";
import {
  readContinuousIncidentWindow,
  type ContinuousIncidentSourceDependencies,
} from "./continuous-source.js";
import {
  createContinuousSnapshotService,
  type ContinuousIncidentOwner,
} from "./continuous-snapshot-service.js";

export function createContinuousIncidentProvider(
  source: ContinuousIncidentSourceDependencies,
  isCurrentOwner: (owner: ContinuousIncidentOwner, signal: AbortSignal) => Promise<boolean>,
) {
  return createContinuousSnapshotService({
    now: source.now,
    isCurrentOwner,
    async load(owner, asOf, signal) {
      assertD01RunContract(owner.contract);
      const run = createD01IncidentRun({
        runId: owner.runId,
        startedAt: owner.startedAt,
        stopAt: asOf,
      });
      const result = await readContinuousIncidentWindow(run, asOf, source, signal);
      if (
        !result.observations.some((item) => item.kind === "state") ||
        !result.observations.some((item) => item.kind === "reading")
      ) {
        throw new MiningQueryError("upstream", "Continuous incident evidence is incomplete.");
      }
      return replayContinuousIncidentSnapshot({
        runId: owner.runId,
        runStartedAt: owner.startedAt,
        asOf,
        sourceObservedAt: result.sourceObservedAt,
        tags: run.tags,
        observations: result.observations,
      });
    },
  });
}
