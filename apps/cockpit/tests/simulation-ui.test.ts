import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src/ui/public/app.js", import.meta.url), "utf8");
const tree = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function helper(name: string): string {
  const node = tree.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node) throw new Error(`Missing UI helper ${name}`);
  return node.getText(tree);
}

function harness() {
  const field = () => ({
    textContent: "",
    disabled: false,
    hidden: false,
    value: 0,
    innerHTML: "",
  });
  const context = {
    elements: {
      startSession: field(),
      startRace: field(),
      cancelSimulation: field(),
      simulationDiscipline: { ...field(), value: "bike" },
      simulationStatus: field(),
      simulationCooldown: field(),
      simulationProgress: field(),
      simulationFeedback: field(),
      sessionSummary: field(),
      telemetryStatus: field(),
    },
    state: {
      synthetic: true,
      athleteId: "fixed",
      raceId: "race",
      simulationPending: false,
      retryUntil: 0,
      runtime: null as null | Record<string, unknown>,
      previousRunStatus: null,
    },
    fetchJson: vi.fn(),
    postJson: vi.fn(),
    refreshRaceLive: vi.fn(),
    refreshRaceSummary: vi.fn(),
    refreshAnalyses: vi.fn(),
    refreshAlerts: vi.fn(),
    renderTelemetry: vi.fn(),
    setDefinitionList: vi.fn(),
    humanizeKey: (value: string) => value,
    formatMcpCellValue: (value: unknown) => value,
    updateSimulationControls: undefined as undefined | (() => void),
    refreshSimulationStatus: undefined as undefined | (() => Promise<void>),
    triggerSimulation: undefined as undefined | ((action: string) => Promise<void>),
    Date,
  };
  runInNewContext(
    [
      helper("updateSimulationControls"),
      helper("refreshSimulationStatus"),
      helper("triggerSimulation"),
    ].join("\n"),
    context,
  );
  return context;
}

describe("Cockpit simulation controls", () => {
  it("disables starts during an active shared run and during cooldown", () => {
    const context = harness();
    context.state.runtime = { runId: "run", status: "running", progressPct: 50 };
    context.updateSimulationControls?.();
    expect(context.elements.startRace.disabled).toBe(true);
    expect(context.elements.cancelSimulation.hidden).toBe(false);
    expect(context.elements.simulationProgress.value).toBe(50);
    context.state.runtime = { status: "completed" };
    context.state.retryUntil = Date.now() + 30_000;
    context.updateSimulationControls?.();
    expect(context.elements.startSession.disabled).toBe(true);
    expect(context.elements.simulationStatus.textContent).toBe("completed");
    expect(context.elements.simulationCooldown.textContent).toMatch(/available in/);
  });

  it("keeps rate-limit feedback and does not silently resubmit", async () => {
    const context = harness();
    context.postJson.mockResolvedValue({
      response: new Response(null, { status: 429, headers: { "retry-after": "40" } }),
      parsedBody: { error: { message: "Retry in 40 seconds." } },
    });
    context.fetchJson.mockResolvedValue({ runtime: { status: "idle" } });
    await context.triggerSimulation?.("trigger-race");
    expect(context.postJson).toHaveBeenCalledTimes(1);
    expect(context.elements.simulationFeedback.textContent).toBe("Retry in 40 seconds.");
    expect(context.elements.startRace.disabled).toBe(true);
    expect(context.state.simulationPending).toBe(false);
  });

  it("blocks new starts when the shared runtime cannot be verified", async () => {
    const context = harness();
    context.fetchJson.mockRejectedValue(new Error("Connection lost"));
    await context.refreshSimulationStatus?.();
    expect(context.elements.startRace.disabled).toBe(true);
    expect(context.elements.simulationFeedback.textContent).toContain("do not assume it stopped");
  });

  it("refreshes completion views only when terminal state changes", async () => {
    const context = harness();
    context.fetchJson.mockResolvedValue({
      runtime: { runId: "run", status: "completed", kind: "race" },
    });
    await context.refreshSimulationStatus?.();
    await context.refreshSimulationStatus?.();
    expect(context.refreshRaceSummary).toHaveBeenCalledTimes(1);
    expect(context.elements.simulationFeedback.textContent).toContain("completed");
  });

  it.each(["cancelled", "failed"])(
    "marks session telemetry %s without a fabricated summary",
    async (status) => {
      const context = harness();
      context.fetchJson.mockResolvedValue({
        runtime: { runId: "run", status, kind: "session", summary: null },
      });
      await context.refreshSimulationStatus?.();
      expect(context.elements.telemetryStatus.textContent).toBe(status);
      expect(context.renderTelemetry).toHaveBeenCalled();
      expect(context.setDefinitionList).not.toHaveBeenCalled();
    },
  );
});
