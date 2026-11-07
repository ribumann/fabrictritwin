import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createAthleteAssistantDataService } from "../src/services/athlete-assistant-data.js";

const ATHLETE_ID = "11111111-1111-4111-8111-111111111111";

describe("Eventhouse query contracts", () => {
  it("brackets the reserved date column throughout recovery and sleep queries", async () => {
    const queryRows = vi.fn(async (_query: string) => []);
    const service = createAthleteAssistantDataService({ queryExecutor: { queryRows } });

    await service.getRecoveryTrend(ATHLETE_ID, 7);

    const dateQueries = queryRows.mock.calls.map(([query]) => query).filter((query) => query.includes("latestDate"));
    expect(dateQueries).toHaveLength(2);
    for (const query of dateQueries) {
      expect(query).toContain("| project ['date'],");
      expect(query).toContain("| order by ['date'] asc");
      expect(query).not.toMatch(/\b(?:project|order by) date\b/);
    }
  });

  it("sorts phase candidates before taking one and brackets the recent-session date alias", async () => {
    const queryRows = vi.fn(async (_query: string) => []);
    const service = createAthleteAssistantDataService({ queryExecutor: { queryRows } });

    await service.getTrainingLoad(ATHLETE_ID);

    const queries = queryRows.mock.calls.map(([query]) => query);
    expect(queries.find((query) => query.includes("containsAsOf"))).toContain(
      "| order by containsAsOf desc, endDate desc | take 1 | project phase",
    );
    expect(queries.find((query) => query.includes("top 3"))).toContain("['date'] = plannedDate");
  });

  it("keeps the numeric drift column distinct from arg_max's timestamp output", () => {
    const schema = readFileSync(new URL("../../../infra/fabric/eventhouse/DatabaseSchema.kql", import.meta.url), "utf8");
    expect(schema).toContain(
      "| summarize arg_max(timestamp, paceDriftPct), consecutiveOffPlanSplits = countif(abs(paceDriftPct) > 10.0) by raceId, leg",
    );
    expect(schema).not.toContain("paceDriftPct = arg_max(");
  });
});
