import { Router } from "express";
import { proxyStreamingBackendPost, type StreamingBackendProxyOptions } from "./proxy.js";

export function createSimulateRouter(options: StreamingBackendProxyOptions): Router {
  const router = Router();
  for (const action of ["trigger-session", "trigger-race", "cancel"]) {
    router.post(`/${action}`, async (req, res) => {
      await proxyStreamingBackendPost(
        req,
        res,
        options,
        () => new URL(`/api/simulate/${action}`, options.streamingBackendBaseUrl),
        req.body,
        "simulation_proxy_failed",
      );
    });
  }
  return router;
}
