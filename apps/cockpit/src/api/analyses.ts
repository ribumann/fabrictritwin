import { Router } from "express";
import type { Request, Response } from "express";
import {
  proxyStreamingBackendGet,
  type StreamingBackendProxyOptions,
} from "./proxy.js";

function getRequestedAthleteId(req: Request): string | undefined {
  return typeof req.params.athleteId === "string" ? req.params.athleteId : undefined;
}

export function createAnalysesRouter(options: StreamingBackendProxyOptions): Router {
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

    await proxyStreamingBackendGet(
      req,
      res,
      options,
      () => new URL(`/api/analyses/${encodeURIComponent(athleteId)}`, options.streamingBackendBaseUrl),
      "analyses_proxy_failed",
    );
  });

  return router;
}
