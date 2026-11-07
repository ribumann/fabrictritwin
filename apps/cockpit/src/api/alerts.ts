import { Router } from "express";
import type { Request, Response } from "express";
import {
  proxyStreamingBackendGet,
  type StreamingBackendProxyOptions,
} from "./proxy.js";

function getRequestedAthleteId(req: Request): string | undefined {
  return typeof req.params.athleteId === "string" ? req.params.athleteId : undefined;
}

export function createAlertsRouter(options: StreamingBackendProxyOptions): Router {
  const router = Router();

  router.get("/:athleteId", async (req: Request, res: Response): Promise<void> => {
    const athleteId = getRequestedAthleteId(req);
    if (!athleteId) {
      res.status(400).json({
        error: {
          code: "missing_athlete_id",
          message: "Request path must include athleteId.",
        },
      });
      return;
    }

    await proxyStreamingBackendGet(req, res, options, () => {
      const upstream = new URL(
        `/api/alerts/${encodeURIComponent(athleteId)}`,
        options.streamingBackendBaseUrl,
      );
      upstream.searchParams.set(
        "active",
        typeof req.query.active === "string" ? req.query.active : "true",
      );
      return upstream;
    }, "alerts_proxy_failed");
  });

  return router;
}
