import type { Request, Response } from "express";
import { canViewPowerBi, isAnonymousVisitor, powerBiCaller } from "./powerbi-access.js";
import { createPowerBiService, PowerBiError, readPowerBiConfig, type PowerBiConfig } from "../services/powerbi.js";

export function createPowerBiEmbedConfigAction(options: {
  readConfig?: () => PowerBiConfig;
  createService?: typeof createPowerBiService;
} = {}) {
  let config: PowerBiConfig | undefined;
  let service: ReturnType<typeof createPowerBiService> | undefined;
  return async (req: Request, res: Response): Promise<void> => {
    res.set("Cache-Control", "private, no-store");
    res.set("Pragma", "no-cache");
    res.vary("Cookie");
    res.vary("Authorization");
    try {
      config ??= (options.readConfig ?? readPowerBiConfig)();
      // Anonymous visitors (no EasyAuth headers at all) skip straight to the MI-mode fallback:
      // the embed token below is always minted with Cockpit's OWN Power BI service-principal
      // identity, never the visitor's, so this endpoint never actually needs the visitor's
      // identity to call Power BI -- gating on it here was solely a demo-environment access
      // control. This mirrors the Athlete Assistant's anonymous MI-mode fallback (api/assistant.ts).
      // A visitor who DID present some identity signal still must pass the full checks below;
      // a malformed/wrong-tenant/non-allowlisted principal is a failed sign-in attempt, not an
      // anonymous visitor, and must surface an explicit 401/403.
      if (!isAnonymousVisitor(req)) {
        const caller = powerBiCaller(req);
        if (!caller) {
          res.status(401).json({ error: { code: "unauthorized", message: "Sign in to view this report." } });
          return;
        }
        if (!canViewPowerBi(caller, config)) {
          res.status(403).json({ error: { code: "forbidden", message: "Not authorized for this report." } });
          return;
        }
      }
      service ??= (options.createService ?? createPowerBiService)(config);
      res.status(200).json(await service.getEmbedConfig());
    } catch (error) {
      const code = error instanceof PowerBiError ? error.code : "upstream-failed";
      if (code === "not-configured") {
        res.status(503).json({
          status: "not-configured",
          message: "Power BI automatic embedding must be configured by the operator.",
        });
        return;
      }
      // Never serialize SDK errors or upstream bodies, which can contain credentials/tokens.
      console.warn(`[cockpit:powerbi] ${code}`);
      res.status(502).json({
        status: "unavailable",
        error: { code: `powerbi-${code}`, message: "Power BI report access is unavailable. Check the embedding identity, model connection, and service permissions." },
      });
    }
  };
}
