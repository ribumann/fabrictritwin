/**
 * "Seed History" trigger action (T062) -- the Demo Control Console's minimal-UI button that
 * calls the Streaming Backend's `POST /api/simulate/seed-history` (T059) on the caller's
 * behalf, per `specs/001-triathlon-training-twin/contracts/streaming-backend-api.md`.
 *
 * The Console and the Streaming Backend are two separate Azure Container Apps, each with its
 * own Easy Auth sidecar (ADR-004). This module authenticates the outbound call using the
 * Console's own managed-identity app-only access token (`service-auth.ts`) -- without it the
 * Streaming Backend's Easy Auth sidecar rejects the call before it ever reaches that service's
 * T055 `requireAthleteAuthorization` middleware. This is a reasonable pattern for a single-tenant
 * demo where both Container Apps share the same Entra app registration/Easy Auth configuration
 * (ADR-004) -- it is not a general-purpose multi-tenant proxy.
 *
 * `athleteId` resolution: with only one seeded athlete today (FR-001), the button does not
 * need the operator to type an athleteId. `DEFAULT_ATHLETE_ID` (an env var populated at
 * deploy time, e.g. from the same seeded-athlete id used elsewhere) is used unless the
 * request body explicitly supplies one (useful for future multi-athlete UI, SC-007).
 */
import type { Request, Response } from "express";
import { buildServiceAuthHeaders } from "./service-auth.js";

export interface SeedHistoryActionOptions {
  /** Base URL of the Streaming Backend, e.g. `https://<app>.<region>.azurecontainerapps.io`. */
  streamingBackendBaseUrl: string;
  /** Injectable for tests; defaults to the global `fetch` (Node 20+ has it built in). */
  fetchImpl?: typeof fetch;
  /** Injectable default athleteId resolver; defaults to reading `DEFAULT_ATHLETE_ID`. */
  resolveDefaultAthleteId?: () => string | undefined;
  /** Injectable auth-header builder for tests; defaults to `buildServiceAuthHeaders`. */
  buildAuthHeaders?: () => Promise<Record<string, string>>;
}

function defaultResolveDefaultAthleteId(): string | undefined {
  return process.env.DEFAULT_ATHLETE_ID;
}

/**
 * Express handler factory for `POST /actions/seed-history`. Forwards to the Streaming
 * Backend and relays its status code and JSON body unchanged, so the browser sees the exact
 * `202`/`403`/`409` contract responses documented in streaming-backend-api.md.
 */
export function createSeedHistoryAction(options: SeedHistoryActionOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveDefaultAthleteId = options.resolveDefaultAthleteId ?? defaultResolveDefaultAthleteId;
  const buildAuthHeaders = options.buildAuthHeaders ?? buildServiceAuthHeaders;

  return async (req: Request, res: Response): Promise<void> => {
    const athleteId =
      (req.body as { athleteId?: string } | undefined)?.athleteId ?? resolveDefaultAthleteId();

    if (!athleteId) {
      res.status(400).json({
        error: {
          code: "missing_athlete_id",
          message: "No athleteId supplied and DEFAULT_ATHLETE_ID is not configured.",
        },
      });
      return;
    }

    try {
      const headers = await buildAuthHeaders();
      const upstream = await fetchImpl(
        new URL("/api/simulate/seed-history", options.streamingBackendBaseUrl),
        {
          method: "POST",
          headers,
          body: JSON.stringify({ athleteId }),
        },
      );
      const body = await upstream.json().catch(() => ({}));
      res.status(upstream.status).json(body);
    } catch (error) {
      res.status(502).json({
        error: {
          code: "streaming_backend_unreachable",
          message:
            error instanceof Error ? error.message : "Failed to reach the Streaming Backend.",
        },
      });
    }
  };
}
