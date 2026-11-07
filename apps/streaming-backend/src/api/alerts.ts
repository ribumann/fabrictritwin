import { Router } from "express";
import type { Request, Response } from "express";
import { requireAthleteAuthorization, type ForbiddenErrorBody } from "../auth/authorization.js";
import {
  createRealtimeInsightsService,
  type ActiveAlertsResponse,
  type ActiveAlertsService,
} from "../services/realtime-insights.js";

interface InvalidAlertFilterErrorBody {
  error: {
    code: "invalid_alert_filter";
    message: "Only ?active=true is currently supported.";
  };
}

type AlertsRouteResponse =
  | ActiveAlertsResponse
  | ForbiddenErrorBody
  | InvalidAlertFilterErrorBody
  | {
      error: {
        code: "alerts_query_failed";
        message: string;
      };
    };

export interface CreateAlertsRouterOptions {
  alertsService?: ActiveAlertsService;
}

function getRequestedAthleteId(req: Request): string | undefined {
  return typeof req.params.athleteId === "string" ? req.params.athleteId : undefined;
}

function hasSupportedActiveFilter(req: Request): boolean {
  const active = req.query.active;
  return active === undefined || active === "true";
}

export function createAlertsRouter(options: CreateAlertsRouterOptions = {}): Router {
  const router = Router();
  let defaultAlertsService: ActiveAlertsService | undefined;
  const getAlertsService = (): ActiveAlertsService => {
    defaultAlertsService ??= options.alertsService ?? createRealtimeInsightsService();
    return defaultAlertsService;
  };

  router.get(
    "/:athleteId",
    requireAthleteAuthorization(getRequestedAthleteId),
    async (req: Request, res: Response<AlertsRouteResponse>): Promise<void> => {
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

      if (!hasSupportedActiveFilter(req)) {
        res.status(400).json({
          error: {
            code: "invalid_alert_filter",
            message: "Only ?active=true is currently supported.",
          },
        });
        return;
      }

      try {
        res.status(200).json(await getAlertsService().getActiveAlerts(athleteId));
      } catch (error) {
        console.error("[streaming-backend] alerts query failed", error);
        res.status(500).json({
          error: {
            code: "alerts_query_failed",
            message: error instanceof Error ? error.message : "Alerts query failed.",
          },
        });
      }
    },
  );

  return router;
}
