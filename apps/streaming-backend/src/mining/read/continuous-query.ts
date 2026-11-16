/** Fixed rolling slice over the existing validated, fingerprint-deduplicated contract. */
export const continuousThroughputQuery = `
declare query_parameters(plant:string, run:string, asof:datetime);
let source_status = toscalar(mining_SourceReadiness() | project status);
let tags = datatable(tag_id:string) [
    "D01.A.crusher.ore_flow", "D01.B.crusher.ore_flow", "D01.C.crusher.ore_flow"
];
let telemetry = materialize(
    mining_DeduplicatedTelemetry(plant, run, asof - 10m, asof)
    | where received_at <= asof and tag_id in (tags)
);
let latest_samples = telemetry
    | summarize arg_max(timestamp, *) by tag_id
    | project tag_id, latest_timestamp=timestamp, latest_received_at=received_at,
        latest_quality=quality, latest_conflict=event_conflict;
let cutoff = toscalar(latest_samples
    | summarize tag_count=count(), watermark=min(latest_timestamp)
    | project iff(tag_count == 3, watermark, datetime(null)));
let window = telemetry
    | where timestamp > cutoff - 5m and timestamp <= cutoff
    | summarize sample_count=count(), distinct_timestamps=array_length(make_set(timestamp, 11)),
        usable_samples=countif(quality == "good" and not(event_conflict) and isnotnull(value)
            and unit == "t/h" and interval_seconds == 30),
        average_value=avgif(value, quality == "good" and not(event_conflict)),
        first_sample=min(timestamp), last_sample=max(timestamp),
        window_received_at=max(received_at)
        by tag_id;
let aligned = telemetry
    | where timestamp <= cutoff
    | summarize arg_max(timestamp, *) by tag_id
    | project tag_id, sample_time=timestamp, received_at, event_id, value, quality,
        event_conflict, unit, interval_seconds;
tags
| join kind=leftouter latest_samples on tag_id
| join kind=leftouter window on tag_id
| join kind=leftouter aligned on tag_id
| project source_status, plant_id=plant, run_id=run, as_of_utc=asof,
    watermark=cutoff, window_start=cutoff-5m, tag_id,
    latest_timestamp, latest_received_at, latest_quality, latest_conflict,
    sample_time, received_at, event_id, value, quality, event_conflict, unit, interval_seconds,
    sample_count=coalesce(sample_count, 0), distinct_timestamps=coalesce(distinct_timestamps, 0),
    usable_samples=coalesce(usable_samples, 0), average_value, first_sample, last_sample, window_received_at
`;
