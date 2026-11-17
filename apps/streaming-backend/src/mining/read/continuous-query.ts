import {
  D01_CATALOG_VERSION,
  D01_PLANT_CATALOG,
  D01_PUBLISH_PROFILE_VERSION,
  getD01TagIntervalSeconds,
} from "@triathlon-twin/simulator/mining";

const sourceContractVersion = "d01-validated-source-v1";
const feedTagIds = ["D01.A.crusher.ore_flow", "D01.B.crusher.ore_flow", "D01.C.crusher.ore_flow"];
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const tagRows = D01_PLANT_CATALOG.telemetry_tags
  .map(
    (tag) =>
      `    ${[
        quote(tag.id),
        quote(tag.module_id),
        quote(tag.equipment_id),
        quote(tag.unit),
        getD01TagIntervalSeconds(tag),
        quote(D01_CATALOG_VERSION),
        quote(D01_PUBLISH_PROFILE_VERSION),
      ].join(", ")}`,
  )
  .join(",\n");
const feedRows = feedTagIds.map((tagId) => `    ${quote(tagId)}`).join(",\n");

/** Fixed current window over the existing validated, fingerprint-deduplicated contract. */
export const continuousThroughputQuery = `
declare query_parameters(plant:string, run:string, asof:datetime);
let source_status = toscalar(mining_SourceReadiness() | project status);
let source_contract_version = ${quote(sourceContractVersion)};
let tags = datatable(tag_id:string, expected_module_id:string, expected_equipment_id:string,
    expected_unit:string, cadence_seconds:long, catalog_version:string, profile_version:string) [
${tagRows}
];
let feed_tags = datatable(tag_id:string) [
${feedRows}
];
let telemetry = materialize(
    mining_DeduplicatedTelemetry(plant, run, asof - 10m, asof)
    | where received_at <= asof and tag_id in (tags | project tag_id)
);
let max_timestamp_by_tag = telemetry
    | summarize max_timestamp=max(timestamp) by tag_id;
let max_sequence_by_tag = telemetry
    | join kind=inner max_timestamp_by_tag on tag_id
    | where timestamp == max_timestamp
    | summarize max_sequence=max(sequence) by tag_id;
let tag_candidates = telemetry
    | join kind=inner max_timestamp_by_tag on tag_id
    | where timestamp == max_timestamp
    | join kind=inner max_sequence_by_tag on tag_id
    | where sequence == max_sequence;
let tag_candidate_summary = tag_candidates
    | summarize candidate_count=count(), candidate_conflicts=countif(event_conflict),
        candidate_timestamp=max(timestamp),
        candidate_received_at=iff(count() == 1 and countif(event_conflict) == 0,
            min(received_at), datetime(null)),
        candidate_sequence=iff(count() == 1 and countif(event_conflict) == 0,
            max(sequence), long(null)),
        candidate_event_id=iff(count() == 1 and countif(event_conflict) == 0,
            any(event_id), ""),
        candidate_module_id=iff(count() == 1 and countif(event_conflict) == 0,
            any(module_id), ""),
        candidate_equipment_id=iff(count() == 1 and countif(event_conflict) == 0,
            any(equipment_id), ""),
        candidate_value=iff(count() == 1 and countif(event_conflict) == 0,
            any(value), real(null)),
        candidate_quality=iff(count() == 1 and countif(event_conflict) == 0,
            any(quality), ""),
        candidate_unit=iff(count() == 1 and countif(event_conflict) == 0,
            any(unit), ""),
        candidate_interval=iff(count() == 1 and countif(event_conflict) == 0,
            max(interval_seconds), long(null))
        by tag_id;
let tag_latest = tag_candidate_summary
    | extend latest_conflict = candidate_count != 1 or candidate_conflicts != 0
    | project tag_id,
        latest_timestamp=iff(latest_conflict, datetime(null), candidate_timestamp),
        latest_received_at=iff(latest_conflict, datetime(null), candidate_received_at),
        latest_sequence=iff(latest_conflict, long(null), candidate_sequence),
        latest_event_id=iff(latest_conflict, "", candidate_event_id),
        latest_module_id=iff(latest_conflict, "", candidate_module_id),
        latest_equipment_id=iff(latest_conflict, "", candidate_equipment_id),
        latest_value=iff(latest_conflict, real(null), candidate_value),
        latest_quality=iff(latest_conflict, "", candidate_quality),
        latest_unit=iff(latest_conflict, "", candidate_unit),
        latest_interval_seconds=iff(latest_conflict, long(null), candidate_interval),
        latest_conflict;
let latest_samples = feed_tags
    | join kind=leftouter tag_latest on tag_id
    | project tag_id, latest_timestamp, latest_received_at, latest_quality, latest_conflict;
let cutoff = toscalar(latest_samples
    | summarize tag_count=countif(isnotnull(latest_timestamp)), watermark=min(latest_timestamp)
    | project iff(tag_count == 3, watermark, datetime(null)));
let window = telemetry
    | where tag_id in (feed_tags | project tag_id) and timestamp > cutoff - 5m and timestamp <= cutoff
    | summarize sample_count=count(), distinct_timestamps=array_length(make_set(timestamp, 11)),
        usable_samples=countif(quality == "good" and not(event_conflict) and isnotnull(value)
            and unit == "t/h" and interval_seconds == 30),
        average_value=avgif(value, quality == "good" and not(event_conflict)),
        first_sample=min(timestamp), last_sample=max(timestamp),
        window_received_at=max(received_at)
        by tag_id;
let aligned_max_timestamp = telemetry
    | where tag_id in (feed_tags | project tag_id) and timestamp <= cutoff
    | summarize aligned_max_timestamp=max(timestamp) by tag_id;
let aligned_max_sequence = telemetry
    | join kind=inner aligned_max_timestamp on tag_id
    | where timestamp == aligned_max_timestamp
    | summarize aligned_max_sequence=max(sequence) by tag_id;
let aligned_candidates = telemetry
    | join kind=inner aligned_max_timestamp on tag_id
    | where timestamp == aligned_max_timestamp
    | join kind=inner aligned_max_sequence on tag_id
    | where sequence == aligned_max_sequence;
let aligned = aligned_candidates
    | summarize aligned_count=count(), aligned_conflicts=countif(event_conflict),
        aligned_time=iff(count() == 1 and countif(event_conflict) == 0,
            max(timestamp), datetime(null)),
        aligned_received_at=iff(count() == 1 and countif(event_conflict) == 0,
            min(received_at), datetime(null)),
        aligned_sequence=iff(count() == 1 and countif(event_conflict) == 0,
            max(sequence), long(null)),
        aligned_event_id=iff(count() == 1 and countif(event_conflict) == 0,
            any(event_id), ""),
        aligned_value=iff(count() == 1 and countif(event_conflict) == 0,
            any(value), real(null)),
        aligned_quality=iff(count() == 1 and countif(event_conflict) == 0,
            any(quality), ""),
        aligned_unit=iff(count() == 1 and countif(event_conflict) == 0,
            any(unit), ""),
        aligned_interval=iff(count() == 1 and countif(event_conflict) == 0,
            max(interval_seconds), long(null))
        by tag_id
    | extend aligned_conflict = aligned_count != 1 or aligned_conflicts != 0
    | project tag_id,
        sample_time=iff(aligned_conflict, datetime(null), aligned_time),
        received_at=iff(aligned_conflict, datetime(null), aligned_received_at),
        sequence=iff(aligned_conflict, long(null), aligned_sequence),
        event_id=iff(aligned_conflict, "", aligned_event_id),
        value=iff(aligned_conflict, real(null), aligned_value),
        quality=iff(aligned_conflict, "", aligned_quality),
        unit=iff(aligned_conflict, "", aligned_unit),
        interval_seconds=iff(aligned_conflict, long(null), aligned_interval),
        event_conflict=aligned_conflict;
let tag_rows = tags
    | join kind=leftouter tag_latest on tag_id
    | join kind=leftouter window on tag_id
    | join kind=leftouter aligned on tag_id
    | project source_status, plant_id=plant, run_id=run, as_of_utc=asof,
        watermark=cutoff, window_start=cutoff-5m, row_kind="tag",
        catalog_version, profile_version, source_contract_version, tag_id,
        module_id=expected_module_id, equipment_id=expected_equipment_id,
        unit=expected_unit, cadence_seconds,
        latest_timestamp, latest_received_at, latest_sequence, latest_event_id,
        latest_module_id, latest_equipment_id, latest_value, latest_quality, latest_unit,
        latest_interval_seconds, latest_conflict=coalesce(latest_conflict, false),
        sample_time, received_at, sequence, event_id, value, quality, interval_seconds,
        event_conflict=coalesce(event_conflict, false),
        sample_count=coalesce(sample_count, long(0)),
        distinct_timestamps=coalesce(distinct_timestamps, long(0)),
        usable_samples=coalesce(usable_samples, long(0)),
        average_value, first_sample, last_sample, window_received_at,
        scope_id="", state="", scheduled_running=bool(null),
        state_timestamp=datetime(null), state_received_at=datetime(null),
        state_sequence=long(null), state_event_id="", state_conflict=bool(false);
let state_events = materialize(
    mining_DeduplicatedState(plant, run, asof - 10m, asof)
    | where received_at <= asof and scope_id in ("A", "B", "C")
);
let max_state_timestamp_by_scope = state_events
    | summarize max_state_timestamp=max(timestamp) by scope_id;
let max_state_sequence_by_scope = state_events
    | join kind=inner max_state_timestamp_by_scope on scope_id
    | where timestamp == max_state_timestamp
    | summarize max_state_sequence=max(sequence) by scope_id;
let state_candidates = state_events
    | join kind=inner max_state_timestamp_by_scope on scope_id
    | where timestamp == max_state_timestamp
    | join kind=inner max_state_sequence_by_scope on scope_id
    | where sequence == max_state_sequence;
let state_candidate_summary = state_candidates
    | summarize candidate_count=count(), candidate_conflicts=countif(event_conflict),
        candidate_timestamp=max(timestamp),
        candidate_received_at=iff(count() == 1 and countif(event_conflict) == 0,
            min(received_at), datetime(null)),
        candidate_sequence=iff(count() == 1 and countif(event_conflict) == 0,
            max(sequence), long(null)),
        candidate_event_id=iff(count() == 1 and countif(event_conflict) == 0,
            any(event_id), ""),
        candidate_state=iff(count() == 1 and countif(event_conflict) == 0,
            any(state), ""),
        candidate_scheduled_running=iff(count() == 1 and countif(event_conflict) == 0,
            any(scheduled_running), bool(null))
        by scope_id;
let state_latest = state_candidate_summary
    | extend state_conflict = candidate_count != 1 or candidate_conflicts != 0
    | project scope_id,
        state_timestamp=iff(state_conflict, datetime(null), candidate_timestamp),
        state_received_at=iff(state_conflict, datetime(null), candidate_received_at),
        state_sequence=iff(state_conflict, long(null), candidate_sequence),
        state_event_id=iff(state_conflict, "", candidate_event_id),
        state=iff(state_conflict, "", candidate_state),
        scheduled_running=iff(state_conflict, bool(null), candidate_scheduled_running),
        state_conflict;
let line_scopes = datatable(scope_id:string) ["A", "B", "C"];
let state_rows = line_scopes
    | join kind=leftouter state_latest on scope_id
    | project source_status, plant_id=plant, run_id=run, as_of_utc=asof,
        watermark=cutoff, window_start=cutoff-5m, row_kind="state",
        catalog_version=${quote(D01_CATALOG_VERSION)}, profile_version="",
        source_contract_version, tag_id="", module_id="", equipment_id="", unit="",
        cadence_seconds=long(null), latest_timestamp=datetime(null), latest_received_at=datetime(null),
        latest_sequence=long(null), latest_event_id="", latest_module_id="", latest_equipment_id="",
        latest_value=real(null), latest_quality="", latest_unit="", latest_interval_seconds=long(null),
        latest_conflict=bool(false), sample_time=datetime(null), received_at=datetime(null),
        sequence=long(null), event_id="", value=real(null), quality="", interval_seconds=long(null),
        event_conflict=bool(false), sample_count=long(0), distinct_timestamps=long(0),
        usable_samples=long(0), average_value=real(null), first_sample=datetime(null),
        last_sample=datetime(null), window_received_at=datetime(null),
        scope_id, state, scheduled_running, state_timestamp, state_received_at, state_sequence,
        state_event_id, state_conflict=coalesce(state_conflict, false);
union tag_rows, state_rows
`;
