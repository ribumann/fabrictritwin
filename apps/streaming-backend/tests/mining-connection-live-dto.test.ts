import { describe, expect, it } from "vitest";
import { toD01ConnectionMeasurementBindingRecords } from "@triathlon-twin/simulator/mining";
import {
  mapLiveConnectionLatest,
  mapLiveConnectionTrend,
} from "../src/mining/read/connection-live-dto.js";

const bindings = toD01ConnectionMeasurementBindingRecords();
const binding = bindings[0]!;
const asOf = "2026-01-01T00:01:00.000Z";

describe("run-independent flow results", () => {
  it("shows a received observation and marks every missing measurement independently", () => {
    const data = mapLiveConnectionLatest(asOf, [
      {
        MeasurementTagId: binding.measurement_tag_id,
        SampleTime: "2026-01-01T00:00:50.000Z",
        ReceiptTime: "2026-01-01T00:00:55.000Z",
        Value: 12,
        Quality: "good",
      },
    ]);
    expect(data).not.toHaveProperty("runId");
    expect(data.readings).toHaveLength(bindings.length);
    expect(
      data.readings.find((item) => item.measurementTagId === binding.measurement_tag_id),
    ).toMatchObject({ status: "OK", value: 12 });
    expect(data.readings.filter((item) => item.status === "MISSING")).toHaveLength(
      bindings.length - 1,
    );
  });

  it("retains delayed and uncertain measurements without presenting them as current", () => {
    const data = mapLiveConnectionLatest(asOf, [
      {
        MeasurementTagId: binding.measurement_tag_id,
        SampleTime: "2026-01-01T00:00:20.000Z",
        ReceiptTime: "2026-01-01T00:00:40.000Z",
        Value: 10,
        Quality: "uncertain",
      },
    ]);
    expect(data.readings[0]).toMatchObject({ status: "UNCERTAIN_QUALITY", stale: true });
  });

  it("fills missing time windows without inventing zero readings", () => {
    const data = mapLiveConnectionTrend(
      {
        start: "2026-01-01T00:00:00.000Z",
        end: asOf,
        streamIds: [binding.stream_id],
        windowSeconds: 30,
      },
      [
        {
          MeasurementTagId: binding.measurement_tag_id,
          WindowStart: "2026-01-01T00:00:00.000Z",
          SampleCount: 2,
          BadSampleCount: 0,
          UncertainSampleCount: 0,
          Value: 11,
        },
      ],
    );
    const points = data.points.filter(
      (point) => point.measurementTagId === binding.measurement_tag_id,
    );
    expect(points[0]).toMatchObject({ state: "PARTIAL", value: 11, samples: 2 });
    expect(points[1]).toMatchObject({ state: "MISSING", value: null, samples: 0 });
    expect(data).not.toHaveProperty("runId");
  });
});
