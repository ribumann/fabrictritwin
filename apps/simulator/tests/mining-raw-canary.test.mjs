import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertD01NumericTelemetryEvent, assertD01PlantStateEvent } from "../src/mining/events.ts";
import { buildMiningRawCanary } from "../../../scripts/fabric/build-mining-raw-canary.mjs";

const runId = "00000000-0000-4000-8000-000000000001";
const timestamp = "2026-01-15T12:00:00.123Z";

describe("offline mining raw-ingestion canary", () => {
  it("builds exactly two valid v2 messages and pins the exact transport bytes", () => {
    const packet = buildMiningRawCanary(runId, timestamp);
    const messages = packet.ndjson
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(messages).toEqual(packet.messages);
    expect(messages).toHaveLength(2);
    const { entityType: telemetryType, ...telemetry } = messages[0];
    const { entityType: stateType, ...state } = messages[1];
    expect(telemetryType).toBe("PlantTelemetry");
    expect(stateType).toBe("PlantStateEvent");
    expect(() => assertD01NumericTelemetryEvent(telemetry)).not.toThrow();
    expect(() => assertD01PlantStateEvent(state)).not.toThrow();
    expect(telemetry.event_id).toBe(
      "a49cfbfc2222aac3040a8adecfe8bb3775bc5501d3782830ebeac39035d5511a",
    );
    expect(state.event_id).toBe("322a2802a280929e5b715409a04651bc00172cceb0eb2d3fa1fe66813f106009");
    expect(packet.ndjsonSha256).toBe(createHash("sha256").update(packet.ndjson).digest("hex"));
    expect(packet.verificationQuerySha256).toBe(
      createHash("sha256").update(packet.verificationQuery).digest("hex"),
    );
  });

  it("pins the same run and exact timestamp in both messages and the read-only proof", () => {
    const packet = buildMiningRawCanary(runId, timestamp);
    expect(
      packet.messages.every(
        (message) => message.run_id === runId && message.timestamp === timestamp,
      ),
    ).toBe(true);
    expect(packet.verificationQuery).toContain(`expected_run_id = "${runId}"`);
    expect(packet.verificationQuery).toContain(`expected_timestamp = "${timestamp}"`);
    expect(packet.verificationQuery).toContain("timestamp_raw == expected_timestamp");
    expect(packet.verificationQuery).toContain('todatetime(event["timestamp"])');
    expect(packet.verificationQuery).not.toContain('gettype(event["timestamp"])');
    for (const message of packet.messages) {
      expect(packet.verificationQuery).toContain(message.event_id);
    }
    expect(packet.verificationQuery).toContain("join kind=leftouter observed");
    expect(packet.verificationQuery).not.toMatch(/^\s*\.(create|alter|set|append|drop)/m);
    expect(buildMiningRawCanary(runId, timestamp)).toEqual(packet);
  });

  it.each([
    ["run-id-injection'; .drop table x", timestamp],
    [runId.toUpperCase().replace("0000", "ABCD"), timestamp],
    [runId, "2026-02-30T12:00:00.123Z"],
    [runId, "2026-01-15T12:00:00Z"],
    [runId, "2026-01-15T13:00:00.123+01:00"],
    [runId, undefined],
  ])("rejects unsafe IDs and noncanonical timestamps (%s, %s)", (id, time) => {
    expect(() => buildMiningRawCanary(id, time)).toThrow();
  });
});
