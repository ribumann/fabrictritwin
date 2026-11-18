import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";
import { MiningQueryError } from "./bounded-query.js";

export type MiningCrossRunMetric = "feed" | "density" | "vibration" | "water-energy";
export type MiningCrossRunBinMinutes = 1 | 5;

export interface MiningCrossRunTrendRequest {
  start: string;
  end: string;
  asOf: string;
  metric: MiningCrossRunMetric;
  binMinutes: MiningCrossRunBinMinutes;
}

export interface PreparedMiningCrossRunTrendQuery {
  csl: string;
  parameters: Readonly<Record<string, string>>;
  maximumRows: 1000;
  responseLimit: 1001;
}

const sourceContractVersion = "d01-validated-source-v1";
const maximumWindowMs = 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const metrics: readonly MiningCrossRunMetric[] = ["feed", "density", "vibration", "water-energy"];
const quote = (value: string) => JSON.stringify(value);

const tagRows = D01_PLANT_CATALOG.telemetry_tags
  .flatMap((tag) => {
    const line = tag.module_id.split(".")[1];
    const family =
      tag.metric === "ore_flow" && line !== "shared" && tag.module_id.endsWith(".crusher")
        ? "feed"
        : tag.metric === "medium_density"
          ? "density"
          : tag.metric === "vibration_rms" && tag.module_id.endsWith(".crusher")
            ? "vibration"
            : line === "shared" &&
                tag.module_id === "D01.shared.water" &&
                ["level", "water_flow"].includes(tag.metric)
              ? "water-energy"
              : line === "shared" &&
                  tag.module_id === "D01.shared.control" &&
                  tag.metric === "power"
                ? "water-energy"
                : null;
    if (!family) return [];
    return [
      `    ${[
        quote(tag.id),
        quote(tag.module_id),
        quote(tag.equipment_id),
        quote(tag.metric),
        quote(tag.unit),
        getD01TagIntervalSeconds(tag),
        quote(family),
        quote(D01_CATALOG_VERSION),
        quote(D01_PUBLISH_PROFILE_VERSION),
      ].join(", ")}`,
    ];
  })
  .join(",\n");

/** Cross-run window read; uses the existing fixed source-readiness contract. */
export const miningCrossRunTrendQuery = `
declare query_parameters(plant:string, start:datetime, end:datetime, asof:datetime,
    metric:string, bin_minutes:int);
let source_status = toscalar(mining_SourceReadiness() | project status);
let tags = datatable(tag_id:string, expected_module_id:string, expected_equipment_id:string,
    expected_metric:string, expected_unit:string, cadence_seconds:long, metric_family:string,
    catalog_version:string, profile_version:string) [
${tagRows}
];
let selected_tags = tags
    | where metric_family == metric
    | project tag_id, expected_module_id, expected_equipment_id, expected_metric,
        expected_unit, cadence_seconds, metric_family,
        tags_catalog_version=catalog_version, tags_profile_version=profile_version;
let epoch = datetime(1970-01-01T00:00:00Z);
let raw = materialize(
    mining_ValidatedTelemetry
    | where source_status == "READY" and plant_id == plant and received_at <= asof
        and timestamp >= start and timestamp < end
        and tag_id in (selected_tags | project tag_id)
    | project plant_id, run_id, event_id, sequence, timestamp, received_at, module_id,
        equipment_id, tag_id, value, unit, quality, interval_seconds, catalog_version,
        profile_version, source_contract_version, payload_fingerprint
);
let identities = mining_ValidatedTelemetry
    | where plant_id == plant and received_at <= asof
    | join kind=leftsemi (raw | distinct run_id, event_id) on run_id, event_id
    | summarize fingerprints=make_set(payload_fingerprint, 2), tags=make_set(tag_id, 2),
        times=make_set(tostring(timestamp), 2), sequences=make_set(sequence, 2),
        modules=make_set(module_id, 2), equipment=make_set(equipment_id, 2),
        values=make_set(value, 2), units=make_set(unit, 2), qualities=make_set(quality, 2),
        intervals=make_set(interval_seconds, 2), catalogs=make_set(catalog_version, 2),
        profiles=make_set(profile_version, 2), contracts=make_set(source_contract_version, 2)
        by run_id, event_id;
let event_rows = raw
    | join kind=inner identities on run_id, event_id
    | extend event_conflict = array_length(fingerprints) != 1 or array_length(tags) != 1
        or array_length(times) != 1 or array_length(sequences) != 1
        or array_length(modules) != 1 or array_length(equipment) != 1
        or array_length(values) != 1 or array_length(units) != 1
        or array_length(qualities) != 1 or array_length(intervals) != 1
        or array_length(catalogs) != 1 or array_length(profiles) != 1
        or array_length(contracts) != 1
    | summarize event_conflict=max(toint(event_conflict)), module_id=take_any(module_id),
        equipment_id=take_any(equipment_id), sequence=take_any(sequence), value=take_any(value),
        unit=take_any(unit), quality=take_any(quality), interval_seconds=take_any(interval_seconds),
        catalog_version=take_any(catalog_version), profile_version=take_any(profile_version),
        source_contract_version=take_any(source_contract_version), received_at=min(received_at)
        by plant_id, run_id, event_id, tag_id, timestamp
    | join kind=inner selected_tags on tag_id
    | extend sample_conflict = event_conflict != 0
        or module_id != expected_module_id or equipment_id != expected_equipment_id
        or unit != expected_unit or interval_seconds != cadence_seconds
        or catalog_version != tags_catalog_version or profile_version != tags_profile_version
        or source_contract_version != ${quote(sourceContractVersion)}
        or quality !in ("good", "uncertain", "bad") or isnull(value);
let samples = event_rows
    | summarize event_count=count(), sample_conflict=max(toint(sample_conflict)),
        module_id=take_any(module_id), equipment_id=take_any(equipment_id),
        metric=take_any(expected_metric), unit=take_any(expected_unit),
        cadence_seconds=max(cadence_seconds), metric_family=take_any(metric_family),
        catalog_version=take_any(tags_catalog_version), profile_version=take_any(tags_profile_version),
        value=take_any(value), quality=take_any(quality), received_at=min(received_at)
        by plant_id, run_id, tag_id, timestamp
    | extend sample_conflict = event_count != 1 or sample_conflict != 0,
        phase_ms=tolong(datetime_diff("millisecond", timestamp, epoch))
            % (cadence_seconds * 1000);
let schedule = samples
    | where not(sample_conflict)
    | summarize segment_start=min(timestamp), segment_last=max(timestamp),
        phase_min=min(phase_ms), phase_max=max(phase_ms), cadence_seconds=max(cadence_seconds)
        by run_id, tag_id;
let owners = schedule
    | project tag_id, run_a=run_id, first_a=segment_start,
        end_a=datetime_add("second", toint(cadence_seconds), segment_last);
let overlapping_owners = owners
    | join kind=inner (
        schedule
        | project tag_id, run_b=run_id, first_b=segment_start,
            end_b=datetime_add("second", toint(cadence_seconds), segment_last)
    ) on tag_id
    | where run_a != run_b and first_a < end_b and first_b < end_a
    | summarize by run_id=run_a, tag_id
    | extend ambiguous_owner=true;
let bins = samples
    | extend bin_start_utc=bin_at(timestamp, bin_minutes * 1m, start)
    | summarize sample_count=count(), good_count=countif(quality == "good" and not(sample_conflict)),
        uncertain_count=countif(quality == "uncertain" and not(sample_conflict)),
        bad_count=countif(quality == "bad" and not(sample_conflict)),
        conflict_count=countif(sample_conflict), first_sample_time=min(timestamp),
        last_sample_time=max(timestamp), first_received_at=min(received_at),
        last_received_at=max(received_at), sample_times=make_set(timestamp, 32),
        good_average=avgif(value, quality == "good" and not(sample_conflict)),
        cadence_seconds=max(cadence_seconds), metric_family=take_any(metric_family),
        metric=take_any(metric), module_id=take_any(module_id),
        equipment_id=take_any(equipment_id), unit=take_any(unit),
        catalog_version=take_any(catalog_version), profile_version=take_any(profile_version)
        by plant_id, run_id, tag_id, bin_start_utc;
let bounded = bins
    | join kind=leftouter schedule on run_id, tag_id
    | join kind=leftouter overlapping_owners on run_id, tag_id
    | extend ambiguous_owner=coalesce(ambiguous_owner, false),
        cadence_conflict=isnull(segment_start) or phase_min != phase_max
            or sample_count > 32;
let coverage = bounded
    | extend natural_bin_end=bin_start_utc + bin_minutes * 1m,
        segment_end=datetime_add("second", toint(cadence_seconds), segment_last)
    | extend bin_end=iff(natural_bin_end < end, natural_bin_end, end)
    | extend coverage_start=iff(bin_start_utc > segment_start, bin_start_utc, segment_start),
        coverage_end=iff(bin_end < segment_end, bin_end, segment_end)
    | extend interval=toint(cadence_seconds * 1000),
        phase=tolong(datetime_diff("millisecond", segment_start, epoch))
            % (cadence_seconds * 1000),
        low_ms=tolong(datetime_diff("millisecond", coverage_start, epoch)),
        high_ms=tolong(datetime_diff("millisecond", coverage_end, epoch))
    | extend first_due_ms=low_ms + ((phase - (low_ms % interval) + interval) % interval)
    | extend expected_samples=iff(not(cadence_conflict) and high_ms > low_ms,
            iff(first_due_ms >= high_ms, long(0),
                1 + tolong((high_ms - 1 - first_due_ms) * 1.0 / interval)),
            long(null))
    | extend cadence_conflict=cadence_conflict
        or (isnotnull(expected_samples) and sample_count > expected_samples)
    | extend coverage_complete=segment_start <= bin_start_utc and segment_end >= bin_end
    | extend coverage=iff(isnull(expected_samples) or expected_samples == 0
            or sample_count > expected_samples, real(null),
            todouble(good_count) / todouble(expected_samples))
    | extend status=case(conflict_count > 0, "CONFLICT",
            cadence_conflict or (isnotnull(expected_samples) and sample_count > expected_samples),
                "CADENCE_CONFLICT",
            ambiguous_owner, "AMBIGUOUS_OWNER",
            isnull(expected_samples) or expected_samples == 0 or not(coverage_complete),
                "COVERAGE_UNKNOWN",
            good_count == expected_samples and sample_count == expected_samples, "OBSERVED",
            good_count > 0, "PARTIAL",
            bad_count > 0 or uncertain_count > 0, "NON_GOOD",
            "GAP")
    | extend value=iff(status == "OBSERVED", good_average, real(null)),
        quality=case(conflict_count > 0, "conflict",
            good_count > 0 and (bad_count > 0 or uncertain_count > 0), "mixed",
            bad_count > 0 and uncertain_count > 0, "mixed",
            bad_count > 0, "bad", uncertain_count > 0, "uncertain",
            good_count > 0, "good", "missing")
    | project row_kind="point", source_status, plant_id, run_id,
        metric_family, start_utc=start, end_utc=end, as_of_utc=asof,
        source_contract_version=${quote(sourceContractVersion)}, metric, tag_id,
        module_id, equipment_id, unit, cadence_seconds, catalog_version, profile_version,
        bin_start_utc, first_sample_time, last_sample_time, first_received_at, last_received_at,
        sample_times, sample_count, expected_samples, good_count, uncertain_count, bad_count,
        conflict_count, coverage, quality, status, ambiguous_owner, cadence_conflict,
        coverage_complete, value;
let blocked = print row_kind="control", source_status=source_status, plant_id=plant, metric_family=metric,
    start_utc=start, end_utc=end, as_of_utc=asof
    | where isnull(source_status) or source_status != "READY";
union kind=outer coverage, blocked
| order by bin_start_utc asc, run_id asc, tag_id asc
| take 1001
`;

function requestTime(value: unknown, now: number): number {
  if (typeof value !== "string" || !utc.test(value)) {
    throw new MiningQueryError("invalid", "Mining cross-run windows require canonical UTC times.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed > now) {
    throw new MiningQueryError("invalid", "Mining cross-run windows must be valid and nonfuture.");
  }
  return parsed;
}

/** Builds only a fixed-catalog, parameterized read over validated telemetry. */
export function prepareMiningCrossRunTrendQuery(
  input: MiningCrossRunTrendRequest,
  now: () => number = Date.now,
): PreparedMiningCrossRunTrendQuery {
  if (typeof input !== "object" || input === null) {
    throw new MiningQueryError("invalid", "Invalid mining cross-run trend scope.");
  }
  const current = now();
  if (!Number.isFinite(current)) {
    throw new MiningQueryError("invalid", "Mining query clock must be finite.");
  }
  const start = requestTime(input.start, current);
  const end = requestTime(input.end, current);
  const asOf = requestTime(input.asOf, current);
  if (
    !metrics.includes(input.metric) ||
    (input.binMinutes !== 1 && input.binMinutes !== 5) ||
    end <= start ||
    end - start > maximumWindowMs ||
    asOf < end ||
    (input.binMinutes === 1 && end - start > 5 * 60 * 60 * 1000)
  ) {
    throw new MiningQueryError("invalid", "Invalid mining cross-run trend scope.");
  }
  return {
    csl: miningCrossRunTrendQuery,
    parameters: {
      plant: "'D01'",
      start: `datetime(${input.start})`,
      end: `datetime(${input.end})`,
      asof: `datetime(${input.asOf})`,
      metric: `'${input.metric}'`,
      bin_minutes: String(input.binMinutes),
    },
    maximumRows: 1000,
    responseLimit: 1001,
  };
}

export const miningCrossRunTrendSourceContractVersion = sourceContractVersion;
export const isMiningRunId = (value: unknown): value is string =>
  typeof value === "string" && uuid.test(value);
