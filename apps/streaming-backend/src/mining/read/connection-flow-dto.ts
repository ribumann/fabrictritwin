import {
  D01_CATALOG_VERSION,
  D01_CONNECTION_MEASUREMENT_CATALOG_VERSION,
  D01_CONNECTION_PROFILE_VERSION,
  toD01ConnectionMeasurementBindingRecords,
} from "@triathlon-twin/simulator/mining";
import { MiningQueryError } from "./bounded-query.js";

type Row = Record<string, unknown>;
type Binding = ReturnType<typeof toD01ConnectionMeasurementBindingRecords>[number];

const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const eventId = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new MiningQueryError("malformed", message);
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !utc.test(value)) return fail("Invalid flow timestamp.");
  const parsed = Date.parse(value);
  const normalized = value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0").slice(0, 3)}Z`,
  );
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== normalized) {
    return fail("Invalid flow timestamp.");
  }
  return parsed;
}

function instantKey(value: unknown): string {
  timestamp(value);
  if (typeof value !== "string") return fail("Invalid flow timestamp.");
  return value.replace(
    /(?:\.(\d{1,7}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(7, "0")}Z`,
  );
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0) {
    return fail("Invalid flow count.");
  }
  return value;
}

function selectedBindings(streamIds: readonly string[]): Map<string, Binding> {
  const bindings = toD01ConnectionMeasurementBindingRecords();
  const streams = new Set(bindings.map((item) => item.stream_id));
  if (
    !Array.isArray(streamIds) ||
    new Set(streamIds).size !== streamIds.length ||
    streamIds.some((id) => !streams.has(id))
  ) {
    throw new MiningQueryError("invalid", "Invalid flow stream selection.");
  }
  return new Map(
    bindings
      .filter((item) => !streamIds.length || streamIds.includes(item.stream_id))
      .map((item) => [item.measurement_tag_id, item]),
  );
}

function checkScope(row: Row, runId: string): void {
  if (
    row.RunId !== runId ||
    row.CatalogVersion !== D01_CATALOG_VERSION ||
    row.MeasurementCatalogVersion !== D01_CONNECTION_MEASUREMENT_CATALOG_VERSION ||
    row.ProfileVersion !== D01_CONNECTION_PROFILE_VERSION
  ) {
    fail("Flow result does not match the requested run and versions.");
  }
}

function bindingFor(row: Row, bindings: Map<string, Binding>): Binding {
  const binding =
    typeof row.MeasurementTagId === "string" ? bindings.get(row.MeasurementTagId) : undefined;
  if (
    !binding ||
    row.StreamId !== binding.stream_id ||
    row.Quantity !== binding.quantity ||
    row.Basis !== binding.basis ||
    row.Unit !== binding.unit
  ) {
    return fail("Flow result does not match its catalog binding.");
  }
  return binding;
}

function checkControl(rows: Row[], runId: string): void {
  if (rows.length === 1 && ["INVALID_REQUEST", "TRUNCATED"].includes(String(rows[0].Status))) {
    checkScope(rows[0], runId);
    throw new MiningQueryError(
      rows[0].Status === "TRUNCATED" ? "overflow" : "upstream",
      `Flow query returned ${String(rows[0].Status)}.`,
    );
  }
}

function finiteValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fail("Invalid flow value.");
  }
  return value;
}

export function mapConnectionLatest(
  input: { runId: string; runStartedAt: string; asOf: string; streamIds: readonly string[] },
  rows: Row[],
) {
  const cutoff = timestamp(input.asOf);
  const started = timestamp(input.runStartedAt);
  if (started > cutoff) return fail("Flow run starts after its cutoff.");
  const bindings = selectedBindings(input.streamIds);
  checkControl(rows, input.runId);
  if (rows.length !== bindings.size) return fail("Incomplete flow latest result.");
  const seen = new Set<string>();
  const readings = rows.map((row) => {
    checkScope(row, input.runId);
    const binding = bindingFor(row, bindings);
    if (seen.has(binding.measurement_tag_id)) return fail("Duplicate flow binding.");
    seen.add(binding.measurement_tag_id);
    const duplicates = count(row.DuplicateCount);
    const conflicts = count(row.ConflictCount);
    if (typeof row.IsStale !== "boolean") return fail("Invalid flow freshness.");
    const missing = row.Status === "MISSING";
    const conflict = row.Status === "DUPLICATE_CONFLICT";
    if (
      ![
        "OK",
        "MISSING",
        "STALE",
        "BAD_QUALITY",
        "UNCERTAIN_QUALITY",
        "DUPLICATE_CONFLICT",
      ].includes(String(row.Status))
    ) {
      return fail("Invalid flow latest status.");
    }
    if (missing) {
      if (
        row.Quality !== "missing" ||
        row.Value !== null ||
        row.SampleTime !== null ||
        row.ReceiptTime !== null ||
        row.EventId !== "" ||
        row.Sequence !== null ||
        row.IsStale ||
        duplicates !== 0 ||
        conflicts !== 0
      ) {
        return fail("Invalid missing flow observation.");
      }
    } else {
      const sample = timestamp(row.SampleTime);
      if (
        instantKey(row.SampleTime) > instantKey(input.asOf) ||
        instantKey(row.ReceiptTime) > instantKey(input.asOf) ||
        sample < started ||
        sample < cutoff - 86_400_000
      ) {
        return fail("Flow observation is outside its evidence cutoff.");
      }
      if (
        (!row.IsStale && cutoff - sample >= 16_000) ||
        (row.IsStale && cutoff - sample < 15_000)
      ) {
        return fail("Inconsistent flow freshness.");
      }
      if (
        (conflict && (row.Value !== null || row.Quality !== "conflict" || conflicts < 1)) ||
        (!conflict &&
          (conflicts !== 0 ||
            typeof row.EventId !== "string" ||
            !eventId.test(row.EventId) ||
            count(row.Sequence) < 1))
      ) {
        return fail("Invalid flow observation identity or conflict.");
      }
      if (!conflict) finiteValue(row.Value);
      const expected =
        row.Quality === "bad"
          ? "BAD_QUALITY"
          : row.Quality === "uncertain"
            ? "UNCERTAIN_QUALITY"
            : row.Quality === "good"
              ? row.IsStale
                ? "STALE"
                : "OK"
              : "";
      if (!conflict && row.Status !== expected) return fail("Inconsistent flow quality.");
    }
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
      value: row.Value as number | null,
      quality: row.Quality as string,
      status: row.Status as string,
      sampleTime: row.SampleTime as string | null,
      receiptTime: row.ReceiptTime as string | null,
      eventId: row.EventId as string,
      sequence: row.Sequence as number | null,
      stale: row.IsStale,
      duplicates,
      conflicts,
    };
  });
  return {
    plantId: "D01" as const,
    catalogVersion: D01_CATALOG_VERSION,
    runId: input.runId,
    runStartedAt: input.runStartedAt,
    asOf: input.asOf,
    readings,
  };
}

export function mapConnectionTrend(
  input: {
    runId: string;
    runStartedAt: string;
    start: string;
    end: string;
    streamIds: readonly string[];
    windowSeconds: 30 | 60;
  },
  rows: Row[],
) {
  const start = timestamp(input.start);
  const end = timestamp(input.end);
  const anchor = timestamp(input.runStartedAt);
  if (
    start < anchor ||
    end <= start ||
    end - start > 86_400_000 ||
    ![30, 60].includes(input.windowSeconds)
  ) {
    throw new MiningQueryError("invalid", "Invalid flow trend window.");
  }
  const bindings = selectedBindings(input.streamIds);
  checkControl(rows, input.runId);
  const windowMs = input.windowSeconds * 1000;
  const first =
    anchor + Math.floor((start - anchor - (start > anchor ? 1 : 0)) / windowMs) * windowMs;
  const last = anchor + Math.floor((end - anchor - 1) / windowMs) * windowMs;
  const windows = (last - first) / windowMs + 1;
  if (rows.length !== bindings.size * windows) return fail("Incomplete flow trend result.");
  const seen = new Set<string>();
  const points = rows.map((row) => {
    checkScope(row, input.runId);
    const binding = bindingFor(row, bindings);
    const windowStart = timestamp(row.WindowStart);
    const windowEnd = timestamp(row.WindowEnd);
    const key = `${binding.measurement_tag_id}:${windowStart}`;
    if (
      seen.has(key) ||
      windowStart < first ||
      windowStart > last ||
      (windowStart - anchor) % windowMs !== 0 ||
      windowEnd !== windowStart + windowMs
    ) {
      return fail("Invalid flow trend cell.");
    }
    seen.add(key);
    const samples = count(row.SampleCount);
    const expected = input.windowSeconds / 5;
    const observed = count(row.ObservedTickCount);
    const bad = count(row.BadSampleCount);
    const uncertain = count(row.UncertainSampleCount);
    const duplicates = count(row.DuplicateCount);
    const conflicts = count(row.ConflictCount);
    if (
      row.ExpectedSampleCount !== expected ||
      samples > expected ||
      samples + bad + uncertain > observed ||
      typeof row.Coverage !== "number" ||
      Math.abs(row.Coverage - samples / expected) > 1e-9 ||
      row.WindowClosed !== windowEnd <= end ||
      typeof row.IsComplete !== "boolean"
    ) {
      return fail("Invalid flow trend coverage.");
    }
    if (samples === 0 && row.Value !== null) return fail("Invalid flow trend value.");
    if (samples > 0) finiteValue(row.Value);
    const complete = windowEnd <= end && samples === expected && !bad && !uncertain && !conflicts;
    if (row.IsComplete !== complete) return fail("Inconsistent flow trend completeness.");
    const state = conflicts
      ? "CONFLICT"
      : windowEnd > end
        ? "OPEN_WINDOW"
        : !observed
          ? "MISSING"
          : !samples
            ? "UNUSABLE"
            : complete
              ? "COMPLETE"
              : "PARTIAL";
    const quality = conflicts
      ? "conflict"
      : bad
        ? "bad"
        : uncertain
          ? "uncertain"
          : !samples
            ? "missing"
            : samples === expected
              ? "good"
              : "partial";
    if (row.Status !== state || row.WindowState !== state || row.Quality !== quality) {
      return fail("Inconsistent flow trend state.");
    }
    if (row.LastSampleTime !== null) {
      const sample = instantKey(row.LastSampleTime);
      if (
        sample < instantKey(input.start) ||
        sample <= instantKey(row.WindowStart) ||
        sample > instantKey(input.end) ||
        sample > instantKey(row.WindowEnd)
      ) {
        return fail("Invalid flow trend sample time.");
      }
    } else if (observed) return fail("Missing flow trend sample time.");
    if (row.LastReceiptTime !== null) {
      if (instantKey(row.LastReceiptTime) > instantKey(input.end)) {
        return fail("Invalid flow trend receipt time.");
      }
    } else if (observed) return fail("Missing flow trend receipt time.");
    return {
      streamId: binding.stream_id,
      measurementTagId: binding.measurement_tag_id,
      quantity: binding.quantity,
      unit: binding.unit,
      windowStart: row.WindowStart as string,
      windowEnd: row.WindowEnd as string,
      value: row.Value as number | null,
      samples,
      expectedSamples: expected,
      coverage: row.Coverage,
      quality: row.Quality as string,
      state,
      complete,
      duplicates,
      conflicts,
      lastSampleTime: row.LastSampleTime as string | null,
      lastReceiptTime: row.LastReceiptTime as string | null,
    };
  });
  return {
    plantId: "D01" as const,
    catalogVersion: D01_CATALOG_VERSION,
    runId: input.runId,
    runStartedAt: input.runStartedAt,
    start: input.start,
    end: input.end,
    points,
  };
}
