import type { Request, Response } from "express";
import { deriveGoalRaceId } from "@triathlon-twin/simulator";

function getTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getOptionalQueryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function createContextAction() {
  return (req: Request, res: Response): void => {
    const defaultAthleteId = getTrimmedEnv("DEFAULT_ATHLETE_ID") ?? null;
    const selectedAthleteId = getOptionalQueryString(req, "athleteId") ?? defaultAthleteId;
    const defaultRaceId = defaultAthleteId ? deriveGoalRaceId(defaultAthleteId) : null;
    const selectedRaceId =
      getOptionalQueryString(req, "raceId") ??
      (selectedAthleteId ? deriveGoalRaceId(selectedAthleteId) : null);

    res.status(200).json({
      defaultAthleteId,
      defaultRaceId,
      selectedAthleteId,
      selectedRaceId,
      assistantPanelAvailable: true,
      directMcpPanelAvailable: true,
    });
  };
}
