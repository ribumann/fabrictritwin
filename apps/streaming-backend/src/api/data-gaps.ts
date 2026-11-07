import { Router } from "express";
import type { Request, Response } from "express";
import { requireAthleteAuthorization, type ForbiddenErrorBody } from "../auth/authorization.js";
import {
  createDataGapStatusService,
  type DataGapStatusResponse,
  type DataGapStatusService,
} from "../services/daily-gap-status.js";

type DataGapsRouteResponse =
  | DataGapStatusResponse
  | ForbiddenErrorBody
  | {
      error: {
        code: "data_gap_query_failed";
        message: string;
      };
    };

export interface CreateDataGapsRouterOptions {
  dataGapStatusService?: DataGapStatusService;
}

function getRequestedAthleteId(req: Request): string | undefined {
  return typeof req.params.athleteId === "string" ? req.params.athleteId : undefined;
}

export function createDataGapsRouter(options: CreateDataGapsRouterOptions = {}): Router {
  const router = Router();
  let defaultService: DataGapStatusService | undefined;
  const getService = (): DataGapStatusService => {
    defaultService ??= options.dataGapStatusService ?? createDataGapStatusService();
    return defaultService;
  };

  router.get(
    "/:athleteId",
    requireAthleteAuthorization(getRequestedAthleteId),
    async (req: Request, res: Response<DataGapsRouteResponse>): Promise<void> => {
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
        res.status(200).json(await getService().getStatus(athleteId));
      } catch (error) {
        console.error("[streaming-backend] data-gap query failed", error);
        res.status(500).json({
          error: {
            code: "data_gap_query_failed",
            message: error instanceof Error ? error.message : "Data-gap query failed.",
          },
        });
      }
    },
  );

  return router;
}
