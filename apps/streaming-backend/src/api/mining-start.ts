import { Router, type Request, type Response } from "express";
import type { JWTPayload } from "jose";
import { verifyMcpCallerClaimsWithErrors } from "../auth/mcp-caller.js";
import { MiningPublisherHost, type MiningPublisherExecution } from "../mining/publisher-host.js";
import { configuredMiningPublisherRuntime } from "../mining/publisher-runtime.js";
import type { MiningPublisherAdmission } from "../mining/publisher-runtime.js";
import type { StartMiningRun } from "../mining/run-coordinator.js";
import { MiningCoordinationError } from "../mining/store.js";
import { hasApprovedDelegatedOperatorClaims } from "./mining-delegated-auth.js";

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const scopePattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
interface StartBody {
  plantId: "D01";
  runId: string;
}

interface Options {
  synthetic: boolean;
  env?: NodeJS.ProcessEnv;
  host?: MiningPublisherHost;
  verifyClaims?: (req: Request, signal: AbortSignal) => Promise<JWTPayload | undefined>;
  start?: (body: StartBody, signal: AbortSignal) => MiningPublisherExecution;
}

function error(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

function mapPublisherStatus(admission: MiningPublisherAdmission) {
  const { status } = admission;
  if (status.admission === "pending") return "admission_pending";
  if (status.admission === "rejected") return "rejected";
  if (status.phase === "admission_unknown") return "admission_unknown";
  if (status.phase === "stopping" || (status.phase === "running" && status.stopRequested)) {
    return "stop_requested";
  }
  return status.phase;
}

function parseStartBody(body: unknown): StartBody | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 2) return undefined;
  for (const key of keys) {
    if (key !== "plantId" && key !== "runId") return undefined;
  }
  if (
    !("plantId" in body) ||
    value.plantId !== "D01" ||
    !("runId" in body) ||
    typeof value.runId !== "string" ||
    !runIdPattern.test(value.runId)
  ) {
    return undefined;
  }
  return {
    plantId: value.plantId as "D01",
    runId: value.runId as string,
  };
}

/** Delegated start only. Never grants viewer access and does not imply ingestion completion. */
export function createMiningStartRouter(options: Options): Router {
  const router = Router();
  const env = { ...(options.env ?? process.env) };
  const verify =
    options.verifyClaims ??
    ((req: Request, signal: AbortSignal) => verifyMcpCallerClaimsWithErrors(req, signal, env));
  const host =
    options.host ?? new MiningPublisherHost(() => configuredMiningPublisherRuntime({ ...env }));
  const start =
    options.start ??
    ((body: StartBody, signal: AbortSignal): MiningPublisherExecution =>
      host.start(
        {
          plantId: "D01",
          requestId: body.runId,
        } satisfies StartMiningRun,
        signal,
      ));
  router.post("/runs/start", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (options.synthetic || env.MINING_START_ENABLED !== "true") {
      error(res, 503, "mining_delegated_boundary_required", "Mining start is not enabled.");
      return;
    }
    const operators = (env.MINING_START_OPERATOR_PRINCIPAL_IDS ?? "")
      .split(",")
      .map((id) => id.trim());
    const tenantId = env.ASSISTANT_AUTH_TENANT_ID;
    const runId = env.MINING_APPROVED_RUN_ID;
    const scope = env.MINING_START_DELEGATED_SCOPE;
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
        "mining_start_configuration",
        "Protected start configuration is incomplete or invalid.",
      );
      return;
    }
    const approvedTenantId = tenantId!;
    const approvedScope = scope!;
    const body = parseStartBody(req.body);
    if (!body || Object.keys(req.query).length) {
      error(
        res,
        400,
        "invalid_mining_start",
        "Provide only D01 plantId and a canonical UUID runId.",
      );
      return;
    }
    if (body.runId !== runId) {
      error(res, 403, "mining_run_forbidden", "The requested run is not approved.");
      return;
    }
    const controller = new AbortController();
    const available = () => !controller.signal.aborted && !res.headersSent && !res.destroyed;
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent && !res.destroyed) {
        error(
          res,
          503,
          "mining_start_outcome_unknown",
          "Start admission exceeded its deadline. Inspect this run's status before retrying.",
        );
      }
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
      console.error("[mining-start] Bearer verification failed", cause);
      if (available()) {
        error(res, 503, "mining_authentication_unavailable", "Bearer verification is unavailable.");
      }
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
        "mining_start_forbidden",
        "The caller lacks the approved operator and delegated scope.",
      );
      return;
    }
    let execution: MiningPublisherExecution;
    try {
      execution = start(body, controller.signal);
    } catch (cause) {
      if (cause instanceof MiningCoordinationError && cause.code === "conflict") {
        error(res, 409, "mining_start_in_progress", "A local mining start is already in progress.");
      } else if (cause instanceof MiningCoordinationError && cause.code === "configuration") {
        error(res, 503, "mining_start_configuration", "Mining start is not configured.");
      } else {
        error(
          res,
          503,
          "mining_start_outcome_unknown",
          "Start admission could not be started. Inspect this run's status before retrying.",
        );
      }
      return;
    }
    try {
      const admission = await execution.admission;
      if (!available()) return;
      if (admission.status.runId !== runId || admission.status.phase === "admission_unknown") {
        error(
          res,
          503,
          "mining_start_outcome_unknown",
          "Start admission could not be confirmed. Inspect this run's status before retrying.",
        );
        return;
      }
      if (admission.status.admission === "pending") {
        error(
          res,
          503,
          "mining_start_outcome_unknown",
          "Start admission is still pending. Inspect this run's status before retrying.",
        );
        return;
      }
      if (admission.status.admission === "rejected") {
        error(res, 409, "mining_admission_unavailable", "Mining admission was rejected.");
        return;
      }
      res.status(202).json({
        plantId: "D01",
        runId,
        admission: admission.kind,
        publisherStatus: mapPublisherStatus(admission),
        ingestionStatus: "unknown",
      });
    } catch (cause) {
      console.error("[mining-start] Admission failed or needs reconciliation", cause);
      if (!available()) return;
      if (cause instanceof MiningCoordinationError && cause.code === "conflict") {
        error(res, 409, "mining_admission_unavailable", "Mining admission is unavailable.");
      } else if (cause instanceof MiningCoordinationError && cause.code === "invalid") {
        error(res, 400, "invalid_mining_start", "Mining start request is invalid.");
      } else {
        error(
          res,
          503,
          "mining_start_outcome_unknown",
          "Start admission could not be confirmed. Inspect this run's status before retrying.",
        );
      }
    }
  });
  return router;
}
