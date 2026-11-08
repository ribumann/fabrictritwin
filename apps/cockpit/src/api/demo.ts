import { Router } from "express";
import { proxyStreamingBackendGet, type StreamingBackendProxyOptions } from "./proxy.js";

export function createDemoRouter(options: StreamingBackendProxyOptions): Router {
  const router = Router();
  for (const action of ["context", "status", "session"]) {
    router.get(`/${action}`, async (req, res) => {
      await proxyStreamingBackendGet(
        req,
        res,
        options,
        () => new URL(`/api/demo/${action}`, options.streamingBackendBaseUrl),
        "demo_proxy_failed",
      );
    });
  }
  return router;
}
