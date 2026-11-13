import { Router, type Request, type Response } from "express";
import type { JWTPayload } from "jose";
import { verifyMcpCallerClaimsWithErrors } from "../auth/mcp-caller.js";
import { configuredMiningStore } from "../mining/blob-store.js";
import { MiningRunCoordinator } from "../mining/run-coordinator.js";
import { MiningCoordinationError } from "../mining/store.js";
import { hasApprovedDelegatedOperatorClaims } from "./mining-delegated-auth.js";

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

interface Options {
  synthetic: boolean;
  env?: NodeJS.ProcessEnv;
  verifyClaims?: (req: Request, signal: AbortSignal) => Promise<JWTPayload | undefined>;
  stop?: (runId: string, signal: AbortSignal) => ReturnType<MiningRunCoordinator["requestStop"]>;
}

function error(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Delegated cancellation only. Never starts a run, acquires a lease or grants viewer tokens write authority. */
export function createMiningCancelRouter(options: Options): Router {
  const router = Router();
  const env = { ...(options.env ?? process.env) };
  const verify =
    options.verifyClaims ??
    ((req: Request, signal: AbortSignal) => verifyMcpCallerClaimsWithErrors(req, signal, env));
  router.post("/runs/cancel", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (options.synthetic || env.MINING_CANCEL_ENABLED !== "true") {
      error(res, 503, "mining_delegated_boundary_required", "Mining cancellation is not enabled.");
      return;
    }
    const operators = (env.MINING_CANCEL_OPERATOR_PRINCIPAL_IDS ?? "")
      .split(",")
      .map((id) => id.trim());
    const tenantId = env.ASSISTANT_AUTH_TENANT_ID;
    const runId = env.MINING_APPROVED_RUN_ID;
    const scope = env.MINING_CANCEL_DELEGATED_SCOPE;
    if (
      !guid.test(tenantId ?? "") ||
      !guid.test(env.ASSISTANT_AUTH_CLIENT_ID ?? "") ||
      !guid.test(env.MINING_MANAGED_IDENTITY_CLIENT_ID ?? "") ||
      !runId ||
      !runIdPattern.test(runId) ||
      !scope ||
      !scopePattern.test(scope) ||
      operators.some((id) => !guid.test(id))
    ) {
      error(
        res,
        503,
        "mining_cancel_configuration",
        "Protected cancellation configuration is incomplete or invalid.",
      );
      return;
    }
    const approvedTenantId = tenantId!;
    const approvedScope = scope!;
    const controller = new AbortController();
    const available = () => !controller.signal.aborted && !res.headersSent && !res.destroyed;
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed)
        error(
          res,
          503,
          "mining_cancel_outcome_unknown",
          "Cancellation exceeded its deadline. Inspect this run's status before retrying.",
        );
    }, 9_900);
    res.once("finish", () => clearTimeout(timer));
    res.once("close", () => {
      clearTimeout(timer);
      controller.abort();
    });
    let claims: JWTPayload | undefined;
    try {
      claims = await verify(req, controller.signal);
    } catch (cause) {
      console.error("[mining-cancel] Bearer verification failed", cause);
      if (available())
        error(res, 503, "mining_authentication_unavailable", "Bearer verification is unavailable.");
      return;
    }
    if (!available()) return;
    if (!claims) {
      error(
        res,
        401,
        "mining_authentication_required",
        "A verified delegated bearer token is required.",
      );
      return;
    }
    if (
      !hasApprovedDelegatedOperatorClaims({
        claims,
        operators,
        tenantId: approvedTenantId,
        scope: approvedScope,
      })
    ) {
      error(
        res,
        403,
        "mining_cancel_forbidden",
        "The caller lacks the approved operator and delegated scope.",
      );
      return;
    }
    const body: unknown = req.body;
    if (
      Object.keys(req.query).length ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("plantId" in body) ||
      body.plantId !== "D01" ||
      !("runId" in body) ||
      typeof body.runId !== "string" ||
      !runIdPattern.test(body.runId)
    ) {
      error(
        res,
        400,
        "invalid_mining_cancel",
        "Provide only D01 plantId and a canonical UUID runId.",
      );
      return;
    }
    if (body.runId !== runId) {
      error(res, 403, "mining_run_forbidden", "The requested run is not approved.");
      return;
    }
    try {
      const stop =
        options.stop ??
        ((id: string, signal: AbortSignal) => {
          const store = configuredMiningStore(env);
          if (!store)
            throw new MiningCoordinationError(
              "configuration",
              "Mining cancellation store is not configured.",
            );
          return new MiningRunCoordinator(store).requestStop(id, undefined, undefined, signal);
        });
      const result = await stop(runId, controller.signal);
      if (!available()) return;
      if (
        !result.accepted ||
        result.status.runId !== runId ||
        result.status.admission !== "accepted" ||
        !result.status.stopRequested
      ) {
        throw new MiningCoordinationError(
          "uncertain",
          "Cancellation returned inconsistent admission.",
        );
      }
      res.status(202).json({
        plantId: "D01",
        runId,
        stopRequested: result.status.stopRequested,
        publisherStatus: result.status.phase,
        ingestionStatus: "unknown",
      });
    } catch (cause) {
      console.error("[mining-cancel] Stop intent failed or needs reconciliation", cause);
      if (!available()) return;
      if (cause instanceof MiningCoordinationError && cause.code === "conflict") {
        error(
          res,
          409,
          "mining_admission_unavailable",
          "Cancellation requires a durable accepted run.",
        );
      } else {
        error(
          res,
          503,
          "mining_cancel_outcome_unknown",
          "Cancellation could not be confirmed. Inspect this run's status before retrying.",
        );
      }
    }
  });
  return router;
}
