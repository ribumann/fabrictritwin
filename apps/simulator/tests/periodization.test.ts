import { describe, expect, it } from "vitest";
import { addDays, formatDate, getInclusiveDayCount } from "../src/generators/date-utils.js";
import { createTrainingPlan } from "./fixtures.js";

describe("generatePeriodizedTrainingPlan", () => {
  it("creates four contiguous phases spanning the full 16-week block", () => {
    const { trainingBlock, phases } = createTrainingPlan();

    expect(phases).toHaveLength(4);
    expect(phases.map((phase) => phase.phase)).toEqual(["Base", "Build", "Peak", "Taper"]);
    expect(phases[0]?.startDate).toBe(trainingBlock.startDate);
    expect(phases.at(-1)?.endDate).toBe(trainingBlock.endDate);

    for (let index = 1; index < phases.length; index += 1) {
      const previous = phases[index - 1]!;
      const current = phases[index]!;

      expect(current.startDate).toBe(formatDate(addDays(previous.endDate, 1)));
      expect(previous.endDate < current.startDate).toBe(true);
    }

    const totalDays = phases.reduce(
      (sum, phase) => sum + getInclusiveDayCount(phase.startDate, phase.endDate),
      0,
    );

    expect(totalDays).toBe(112);
  });

  it("creates a deterministic weekly schedule for the full history window", () => {
    const first = createTrainingPlan();
    const second = createTrainingPlan();

    expect(first.sessions).toHaveLength(112);
    expect(first.sessions.every((session) => session.status === "completed")).toBe(true);
    expect(first.sessions.every((session) => session.source === "seeded")).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
