import { performance } from "node:perf_hooks";

type Scenario = "triathlon-session" | "triathlon-race" | "mining";
type Run = { scenario: Scenario; runId: string };
export type Timeline = Run & {
  sampleTime: string;
  emittedAt: string;
  eventCount: number;
  eventId?: string;
  raceId?: string;
};

export function traceTwinAdmission(run: Run, requestStartedAt: number): void {
  console.info(
    JSON.stringify({
      telemetry: "twin-latency-v1",
      stage: "admission",
      ...run,
      at: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - requestStartedAt),
    }),
  );
}

export async function traceTwinSend<T>(timeline: Timeline, send: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const sendStartedAt = new Date().toISOString();
  let outcome: "acknowledged" | "unconfirmed" = "unconfirmed";
  try {
    const result = await send();
    outcome = "acknowledged";
    return result;
  } finally {
    console.info(
      JSON.stringify({
        telemetry: "twin-latency-v1",
        stage: "send",
        ...timeline,
        sendStartedAt,
        completedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - started),
        outcome,
      }),
    );
  }
}
