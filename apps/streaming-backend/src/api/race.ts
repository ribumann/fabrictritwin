import { Router } from "express";
import type { Request, Response } from "express";
import {
  forbiddenBody,
  resolveAuthorizedAthleteId,
  type ForbiddenErrorBody,
} from "../auth/authorization.js";
import {
  createRaceCatalog,
  raceStateStore,
  type LiveRaceViewResponse,
  type RaceCatalog,
  type RaceSummaryResponse,
  type RaceStateStore,
} from "../services/race-state.js";

type RaceRouteResponse =
  | LiveRaceViewResponse
  | RaceSummaryResponse
  | ForbiddenErrorBody
  | {
      error: {
        code:
          | "race_live_query_failed"
          | "race_summary_query_failed"
          | "race_summary_unavailable";
        message: string;
      };
    };

export interface CreateRaceRouterOptions {
  raceCatalog?: RaceCatalog;
  raceState?: RaceStateStore;
}

function getRequestedRaceId(req: Request): string | undefined {
  return typeof req.params.raceId === "string" ? req.params.raceId : undefined;
}

export function createRaceRouter(options: CreateRaceRouterOptions = {}): Router {
  const router = Router();
  const raceCatalog = options.raceCatalog ?? createRaceCatalog();
  const raceState = options.raceState ?? raceStateStore;

  router.get(
    "/:raceId/live",
    async (req: Request, res: Response<RaceRouteResponse>): Promise<void> => {
      const athleteId = resolveAuthorizedAthleteId(req);
      const raceId = getRequestedRaceId(req);

      if (!athleteId || !raceId) {
        res.status(403).json(forbiddenBody());
        return;
      }

      try {
        const race = await raceCatalog.findRaceForAthlete(athleteId, raceId);
        if (!race) {
          res.status(403).json(forbiddenBody());
          return;
        }

        res.status(200).json(raceState.getLiveView(race));
      } catch (error) {
        console.error("[streaming-backend] race live query failed", error);
        res.status(500).json({
          error: {
            code: "race_live_query_failed",
            message:
              error instanceof Error
                ? error.message
                : "Race live query failed.",
          },
        });
      }
    },
  );

  router.get(
    "/:raceId/summary",
    async (req: Request, res: Response<RaceRouteResponse>): Promise<void> => {
      const athleteId = resolveAuthorizedAthleteId(req);
      const raceId = getRequestedRaceId(req);

      if (!athleteId || !raceId) {
        res.status(403).json(forbiddenBody());
        return;
      }

      try {
        const race = await raceCatalog.findRaceForAthlete(athleteId, raceId);
        if (!race) {
          res.status(403).json(forbiddenBody());
          return;
        }

        const summary = raceState.getSummary(race);
        if (!summary) {
          res.status(404).json({
            error: {
              code: "race_summary_unavailable",
              message:
                "Race summary is only available after a race simulation completes.",
            },
          });
          return;
        }

        res.status(200).json(summary);
      } catch (error) {
        console.error("[streaming-backend] race summary query failed", error);
        res.status(500).json({
          error: {
            code: "race_summary_query_failed",
            message:
              error instanceof Error
                ? error.message
                : "Race summary query failed.",
          },
        });
      }
    },
  );

  return router;
}
