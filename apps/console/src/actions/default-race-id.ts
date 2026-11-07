/**
 * "Default Race ID" lookup (fix for the "Trigger Race requests a Race ID I don't know" UX bug) --
 * `GET /actions/default-race-id`, used by `public/index.html` to pre-fill the "Trigger Race"
 * prompt with a real, working raceId instead of leaving the operator to guess one.
 *
 * `seedHistory` (apps/simulator/src/services/seed-history.ts) always assigns the seeded athlete a
 * "goal race" whose id is a deterministic, pure function of `athleteId` (no caller in this repo
 * ever overrides it) -- `deriveGoalRaceId` recomputes that exact same id with no I/O, so this
 * action needs neither an authenticated round-trip to the Streaming Backend nor a Lakehouse read
 * just to answer "what raceId should I use?".
 *
 * `athleteId` resolution mirrors the other actions (`DEFAULT_ATHLETE_ID` env var, overridable by
 * an explicit `?athleteId=` query param for a future multi-athlete UI, SC-007).
 */
import type { Request, Response } from "express";
import { deriveGoalRaceId } from "@triathlon-twin/simulator";

export interface DefaultRaceIdActionOptions {
  /** Injectable default athleteId resolver; defaults to reading `DEFAULT_ATHLETE_ID`. */
  resolveDefaultAthleteId?: () => string | undefined;
}

function defaultResolveDefaultAthleteId(): string | undefined {
  return process.env.DEFAULT_ATHLETE_ID;
}

/** Express handler factory for `GET /actions/default-race-id`. */
export function createDefaultRaceIdAction(options: DefaultRaceIdActionOptions = {}) {
  const resolveDefaultAthleteId = options.resolveDefaultAthleteId ?? defaultResolveDefaultAthleteId;

  return (req: Request, res: Response): void => {
    const athleteId =
      (req.query.athleteId as string | undefined) ?? resolveDefaultAthleteId();

    if (!athleteId) {
      res.status(400).json({
        error: {
          code: "missing_athlete_id",
          message: "No athleteId supplied and DEFAULT_ATHLETE_ID is not configured.",
        },
      });
      return;
    }

    res.status(200).json({ athleteId, raceId: deriveGoalRaceId(athleteId) });
  };
}
