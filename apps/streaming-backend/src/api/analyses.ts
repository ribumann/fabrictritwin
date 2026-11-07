import { Router } from "express";
import type { Request, Response } from "express";
import { requireAthleteAuthorization, type ForbiddenErrorBody } from "../auth/authorization.js";
import {
  createRealtimeInsightsService,
  type AthleteAnalysesResponse,
  type AthleteAnalysesService,
} from "../services/realtime-insights.js";

type AnalysesRouteResponse =
  | AthleteAnalysesResponse
  | ForbiddenErrorBody
  | {
      error: {
        code: "analyses_query_failed";
        message: string;
      };
    };

export interface CreateAnalysesRouterOptions {
  analysesService?: AthleteAnalysesService;
}

function getRequestedAthleteId(req: Request): string | undefined {
  return typeof req.params.athleteId === "string" ? req.params.athleteId : undefined;
}

export function createAnalysesRouter(options: CreateAnalysesRouterOptions = {}): Router {
  const router = Router();
  let defaultAnalysesService: AthleteAnalysesService | undefined;
  const getAnalysesService = (): AthleteAnalysesService => {
    defaultAnalysesService ??= options.analysesService ?? createRealtimeInsightsService();
    return defaultAnalysesService;
  };

  router.get(
    "/:athleteId",
    requireAthleteAuthorization(getRequestedAthleteId),
    async (req: Request, res: Response<AnalysesRouteResponse>): Promise<void> => {
      const athleteId = getRequestedAthleteId(req);
      if (!athleteId) {
        res.status(403).json({
          error: {
            code: "forbidden",
            message: "Not authorized for this athlete.",
          },
        });
        return;
      }

      try {
        res.status(200).json(await getAnalysesService().getAnalyses(athleteId));
      } catch (error) {
        console.error("[streaming-backend] analyses query failed", error);
        res.status(500).json({
          error: {
            code: "analyses_query_failed",
            message: error instanceof Error ? error.message : "Analyses query failed.",
          },
        });
      }
    },
  );

  return router;
}
