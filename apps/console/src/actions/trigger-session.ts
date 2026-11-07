/**
 * "Trigger Session" / "Trigger Race" actions (T076) -- the Demo Control Console's minimal-UI
 * buttons that call the Streaming Backend's `POST /api/simulate/trigger-session` and
 * `POST /api/simulate/trigger-race` (T071/T072) on the caller's behalf, per
 * `specs/001-triathlon-training-twin/contracts/streaming-backend-api.md`.
 *
 * Mirrors `actions/seed-history.ts` (T062) exactly: authenticates to the Streaming Backend using
 * the Console's own managed-identity app-only token (see `service-auth.ts` for the full
 * rationale), without which Easy Auth rejects the call outright -- and forwards the upstream
 * status code/body unchanged so the browser sees the exact `202`/`403`/`409`/`422` contract
 * responses.
 *
 * `athleteId` resolution: same single-athlete default (`DEFAULT_ATHLETE_ID`) as T062, overridable
 * by an explicit `athleteId` in the request body (future multi-athlete UI, SC-007).
 */
import type { Request, Response } from "express";
import { buildServiceAuthHeaders } from "./service-auth.js";

export interface TriggerActionOptions {
  /** Base URL of the Streaming Backend, e.g. `https://<app>.<region>.azurecontainerapps.io`. */
  streamingBackendBaseUrl: string;
  /** Injectable for tests; defaults to the global `fetch` (Node 20+ has it built in). */
  fetchImpl?: typeof fetch;
  /** Injectable default athleteId resolver; defaults to reading `DEFAULT_ATHLETE_ID`. */
  resolveDefaultAthleteId?: () => string | undefined;
  /** Injectable auth-header builder for tests; defaults to `buildServiceAuthHeaders`. */
  buildAuthHeaders?: () => Promise<Record<string, string>>;
}

/** Discriminated result from `buildBody`: either the request body to forward, or a local validation error. */
type BuildBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

function defaultResolveDefaultAthleteId(): string | undefined {
  return process.env.DEFAULT_ATHLETE_ID;
}


/**
 * Shared forwarding logic for both trigger actions: resolves the athleteId, forwards the Easy
 * Auth headers, POSTs the built body to `path` on the Streaming Backend, and relays the response
 * unchanged. `buildBody` receives the resolved `athleteId` so each action can add its own
 * additional fields (`discipline` or `raceId`) on top of it, and can report a local validation
 * failure (e.g. missing `raceId`) without ever calling the Streaming Backend.
 */
function createTriggerAction(
  options: TriggerActionOptions,
  path: string,
  buildBody: (req: Request, athleteId: string) => BuildBodyResult,
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveDefaultAthleteId = options.resolveDefaultAthleteId ?? defaultResolveDefaultAthleteId;
  const buildAuthHeaders = options.buildAuthHeaders ?? buildServiceAuthHeaders;

  return async (req: Request, res: Response): Promise<void> => {
    const athleteId = (req.body as { athleteId?: string } | undefined)?.athleteId ?? resolveDefaultAthleteId();

    if (!athleteId) {
      res.status(400).json({
        error: {
          code: "missing_athlete_id",
          message: "No athleteId supplied and DEFAULT_ATHLETE_ID is not configured.",
        },
      });
      return;
    }

    const bodyResult = buildBody(req, athleteId);
    if (!bodyResult.ok) {
      res.status(bodyResult.status).json({
        error: { code: bodyResult.code, message: bodyResult.message },
      });
      return;
    }

    try {
      const headers = await buildAuthHeaders();
      const upstream = await fetchImpl(new URL(path, options.streamingBackendBaseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(bodyResult.body),
      });
      const body = await upstream.json().catch(() => ({}));
      res.status(upstream.status).json(body);
    } catch (error) {
      res.status(502).json({
        error: {
          code: "streaming_backend_unreachable",
          message: error instanceof Error ? error.message : "Failed to reach the Streaming Backend.",
        },
      });
    }
  };
}

/**
 * Express handler factory for `POST /actions/trigger-session`. `discipline` defaults to `"run"`
 * unless the request body supplies one of `swim|bike|run|strength` (per the contract's request
 * shape); the minimal console UI's button does not expose a discipline picker today, so this
 * default lets a single click work while still allowing a future UI/CLI caller to be explicit.
 */
export function createTriggerSessionAction(options: TriggerActionOptions) {
  return createTriggerAction(options, "/api/simulate/trigger-session", (req, athleteId) => {
    const discipline = (req.body as { discipline?: string } | undefined)?.discipline ?? "run";
    return { ok: true, body: { athleteId, discipline } };
  });
}

/**
 * Express handler factory for `POST /actions/trigger-race`. `raceId` must be supplied in the
 * request body -- unlike `athleteId`, there is no single-default fallback since a race must
 * reference a specific seeded Race entity.
 */
export function createTriggerRaceAction(options: TriggerActionOptions) {
  return createTriggerAction(options, "/api/simulate/trigger-race", (req, athleteId) => {
    const raceId = (req.body as { raceId?: string } | undefined)?.raceId;
    if (!raceId) {
      return {
        ok: false,
        status: 400,
        code: "missing_race_id",
        message: "Request body must supply raceId.",
      };
    }
    return { ok: true, body: { athleteId, raceId } };
  });
}
