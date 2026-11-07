import { Router } from "express";
import type { Request, Response } from "express";
import { proxyStreamingBackendGet, type StreamingBackendProxyOptions } from "./proxy.js";

function getRequestedRaceId(req: Request): string | undefined {
  return typeof req.params.raceId === "string" ? req.params.raceId : undefined;
}

export function createRaceRouter(options: StreamingBackendProxyOptions): Router {
  const router = Router();

  router.get("/:raceId/live", async (req: Request, res: Response): Promise<void> => {
    const raceId = getRequestedRaceId(req);
    if (!raceId) {
      res.status(400).json({
        error: {
          code: "missing_race_id",
          message: "Request path must include raceId.",
        },
      });
      return;
    }

    await proxyStreamingBackendGet(
      req,
      res,
      options,
      () =>
        new URL(`/api/race/${encodeURIComponent(raceId)}/live`, options.streamingBackendBaseUrl),
      "race_live_proxy_failed",
    );
  });

  router.get("/:raceId/summary", async (req: Request, res: Response): Promise<void> => {
    const raceId = getRequestedRaceId(req);
    if (!raceId) {
      res.status(400).json({
        error: {
          code: "missing_race_id",
          message: "Request path must include raceId.",
        },
      });
      return;
    }

    await proxyStreamingBackendGet(
      req,
      res,
      options,
      () =>
        new URL(`/api/race/${encodeURIComponent(raceId)}/summary`, options.streamingBackendBaseUrl),
      "race_summary_proxy_failed",
    );
  });

  return router;
}
