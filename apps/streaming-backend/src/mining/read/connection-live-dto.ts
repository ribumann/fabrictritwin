import {
  D01_CATALOG_VERSION,
  toD01ConnectionMeasurementBindingRecords,
} from "@triathlon-twin/simulator/mining";
import { MiningQueryError } from "./bounded-query.js";

type Row = Record<string, unknown>;

function time(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new MiningQueryError("malformed", "Invalid live flow timestamp.");
  }
  return Date.parse(value);
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MiningQueryError("malformed", "Invalid live flow value.");
  }
  return value;
}

function integer(value: unknown): number {
  const parsed = number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MiningQueryError("malformed", "Invalid live flow count.");
  }
  return parsed;
}

export function mapLiveConnectionLatest(asOf: string, rows: Row[]) {
  const cutoff = time(asOf);
  const bindings = toD01ConnectionMeasurementBindingRecords();
  const byTag = new Map(bindings.map((binding) => [binding.measurement_tag_id, binding]));
  const observed = new Map<string, Row>();
  for (const row of rows) {
    const tag = row.MeasurementTagId;
    if (typeof tag !== "string" || !byTag.has(tag) || observed.has(tag)) {
      throw new MiningQueryError("malformed", "Invalid or duplicate live flow tag.");
    }
    if (
      time(row.SampleTime) > cutoff ||
      time(row.ReceiptTime) > cutoff ||
      !["good", "uncertain", "bad"].includes(String(row.Quality))
    ) {
      throw new MiningQueryError("malformed", "Invalid live flow observation.");
    }
    number(row.Value);
    observed.set(tag, row);
  }
  return {
    plantId: "D01",
    catalogVersion: D01_CATALOG_VERSION,
    asOf,
    readings: bindings.map((binding) => {
      const row = observed.get(binding.measurement_tag_id);
      const stale = row ? cutoff - time(row.SampleTime) > 15_000 : false;
      const quality = row ? String(row.Quality) : "missing";
      return {
        streamId: binding.stream_id,
        measurementTagId: binding.measurement_tag_id,
        source: binding.source,
        target: binding.target,
        quantity: binding.quantity,
        basis: binding.basis,
        unit: binding.unit,
        nominalCapacity: binding.nominal_capacity.value,
        origin: binding.origin,
        value: row ? number(row.Value) : null,
        quality,
        status: !row
          ? "MISSING"
          : quality === "bad"
            ? "BAD_QUALITY"
            : quality === "uncertain"
              ? "UNCERTAIN_QUALITY"
              : stale
                ? "STALE"
                : "OK",
        sampleTime: row?.SampleTime ?? null,
        receiptTime: row?.ReceiptTime ?? null,
        stale,
      };
    }),
  };
}

export function mapLiveConnectionTrend(
  input: { start: string; end: string; streamIds: readonly string[]; windowSeconds: 30 | 60 },
  rows: Row[],
) {
  const start = time(input.start);
  const end = time(input.end);
  const size = input.windowSeconds * 1_000;
  const first = Math.floor(start / size) * size;
  const last = Math.floor(end / size) * size;
  const bindings = toD01ConnectionMeasurementBindingRecords().filter((binding) =>
    input.streamIds.includes(binding.stream_id),
  );
  const byTag = new Map(bindings.map((binding) => [binding.measurement_tag_id, binding]));
  const cells = new Map<string, Row>();
  for (const row of rows) {
    const tag = row.MeasurementTagId;
    const window = time(row.WindowStart);
    const key = `${String(tag)}:${window}`;
    if (
      typeof tag !== "string" ||
      !byTag.has(tag) ||
      window < first ||
      window > last ||
      window % size !== 0 ||
      cells.has(key)
    ) {
      throw new MiningQueryError("malformed", "Invalid live flow trend cell.");
    }
    cells.set(key, row);
  }
  const expectedSamples = input.windowSeconds / 5;
  const points = bindings.flatMap((binding) => {
    const result = [];
    for (let window = first; window <= last; window += size) {
      const row = cells.get(`${binding.measurement_tag_id}:${window}`);
      const samples = row ? integer(row.SampleCount) : 0;
      const bad = row ? integer(row.BadSampleCount) : 0;
      const uncertain = row ? integer(row.UncertainSampleCount) : 0;
      const value = samples > 0 ? number(row?.Value) : null;
      const complete =
        window >= start && window + size <= end && samples >= expectedSamples && !bad && !uncertain;
      result.push({
        streamId: binding.stream_id,
        measurementTagId: binding.measurement_tag_id,
        quantity: binding.quantity,
        unit: binding.unit,
        windowStart: new Date(window).toISOString(),
        windowEnd: new Date(window + size).toISOString(),
        value,
        samples,
        expectedSamples,
        coverage: Math.min(1, samples / expectedSamples),
        quality: bad
          ? "bad"
          : uncertain
            ? "uncertain"
            : !samples
              ? "missing"
              : complete
                ? "good"
                : "partial",
        state: complete ? "COMPLETE" : !samples && !bad && !uncertain ? "MISSING" : "PARTIAL",
        complete,
      });
    }
    return result;
  });
  return {
    plantId: "D01",
    catalogVersion: D01_CATALOG_VERSION,
    start: input.start,
    end: input.end,
    points,
  };
}
