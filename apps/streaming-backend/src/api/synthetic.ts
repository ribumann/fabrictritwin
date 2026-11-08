import { Router } from "express";
import type { TrainingDiscipline } from "@triathlon-twin/simulator";
import { SYNTHETIC_ATHLETE_ID } from "../services/synthetic-insights.js";
import { SyntheticRuntime } from "../services/synthetic-runtime.js";

const disciplines: readonly string[] = ["swim", "bike", "run", "strength"];
const forbidden = {
  error: { code: "forbidden", message: "Only the fixed synthetic context is available." },
};

/** Mounted only in the exact synthetic profile; no live routes are reachable. */
export function createSyntheticRouter(runtime: SyntheticRuntime): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("cache-control", "no-store");
    next();
  });

  router.get("/demo/context", (req, res) => {
    if (
      (req.query.athleteId !== undefined && req.query.athleteId !== SYNTHETIC_ATHLETE_ID) ||
      (req.query.raceId !== undefined && req.query.raceId !== runtime.race.raceId)
    ) {
      res.status(403).json(forbidden);
      return;
    }
    res.json(runtime.context());
  });
  router.get("/demo/status", (_req, res) =>
    res.json({ ...runtime.status(), provenance: runtime.provenance }),
  );
  router.get("/analyses/:athleteId", async (req, res) => {
    if (req.params.athleteId !== SYNTHETIC_ATHLETE_ID) {
      res.status(403).json(forbidden);
      return;
    }
    res.json(await runtime.insights.getAnalyses(SYNTHETIC_ATHLETE_ID));
  });
  router.get("/alerts/:athleteId", async (req, res) => {
    if (req.params.athleteId !== SYNTHETIC_ATHLETE_ID) {
      res.status(403).json(forbidden);
      return;
    }
    if (req.query.active !== undefined && req.query.active !== "true") {
      res.status(400).json({
        error: {
          code: "invalid_alert_filter",
          message: "Only ?active=true is currently supported.",
        },
      });
      return;
    }
    res.json(await runtime.insights.getActiveAlerts(SYNTHETIC_ATHLETE_ID));
  });
  router.get("/race/:raceId/live", (req, res) => {
    if (req.params.raceId !== runtime.race.raceId) {
      res.status(403).json(forbidden);
      return;
    }
    res.json({ ...runtime.raceState.getLiveView(runtime.race), provenance: runtime.provenance });
  });
  router.get("/race/:raceId/summary", (req, res) => {
    if (req.params.raceId !== runtime.race.raceId) {
      res.status(403).json(forbidden);
      return;
    }
    const summary = runtime.raceState.getSummary(runtime.race);
    if (!summary) {
      res.status(404).json({
        error: {
          code: "race_summary_unavailable",
          message: "Race summary is only available after a race simulation completes.",
        },
      });
      return;
    }
    res.json({ ...summary, provenance: runtime.provenance });
  });
  router.get("/demo/session", (_req, res) => res.json(runtime.session()));

  const start =
    (kind: "session" | "race") =>
    (req: import("express").Request, res: import("express").Response) => {
      if (
        req.body?.athleteId !== SYNTHETIC_ATHLETE_ID ||
        (kind === "race" && req.body?.raceId !== runtime.race.raceId)
      ) {
        res.status(403).json(forbidden);
        return;
      }
      if (kind === "session" && !disciplines.includes(req.body?.discipline)) {
        res.status(400).json({
          error: {
            code: "invalid_discipline",
            message: "Expected swim, bike, run, or strength.",
          },
        });
        return;
      }
      const result = runtime.start(kind, req.body?.discipline as TrainingDiscipline);
      if (result.outcome === "busy") {
        res.status(409).json({
          error: {
            code: "live_simulation_in_progress",
            message: "A synthetic simulation is already running.",
            runId: result.run.runId,
            kind: result.run.kind,
          },
        });
        return;
      }
      if (result.outcome === "rate-limited") {
        res.setHeader("Retry-After", String(result.retryAfter));
        res.status(429).json({
          error: {
            code: "rate_limited",
            message: "At most two starts per minute per backend process.",
          },
        });
        return;
      }
      res.status(202).json({ runId: result.run.runId, status: "started", kind });
    };
  router.post("/simulate/trigger-session", start("session"));
  router.post("/simulate/trigger-race", start("race"));
  router.post("/simulate/cancel", (req, res) => {
    const run = typeof req.body?.runId === "string" ? runtime.cancel(req.body.runId) : null;
    if (!run) {
      res
        .status(404)
        .json({ error: { code: "run_not_active", message: "No active run matches this ID." } });
      return;
    }
    res.json({ run });
  });
  router.post(["/assistant", "/assistant/ask"], async (req, res) => {
    if (req.body?.athleteId !== SYNTHETIC_ATHLETE_ID) {
      res.status(403).json(forbidden);
      return;
    }
    if (
      typeof req.body?.question !== "string" ||
      !req.body.question.trim() ||
      req.body.question.length > 2000
    ) {
      res.status(400).json({
        error: {
          code: "invalid_request",
          message: "Provide a question of at most 2000 characters.",
        },
      });
      return;
    }
    const analyses = await runtime.insights.getAnalyses(SYNTHETIC_ATHLETE_ID);
    res.json({
      answer: `Synthetic demo response (no LLM): recovery score ${analyses.recoveryScore ?? "unavailable"}; workload ratio ${analyses.acuteChronicWorkloadRatio ?? "unavailable"}. This fixed summary does not interpret your question and is not medical advice.`,
      groundedOn: [],
      respondedInMs: 0,
      provenance: runtime.provenance,
    });
  });
  return router;
}
