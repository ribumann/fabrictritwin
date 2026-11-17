import { D01_CATALOG_VERSION, D01_PUBLISH_PROFILE_VERSION } from "@triathlon-twin/simulator/mining";

export const continuousIncidentPartitionQuery = `declare query_parameters(
  plant:string, run:string, start:datetime, end:datetime, include_end:bool);
let candidates = materialize(union
(mining_DeduplicatedTelemetry(plant, run, start, end)
 | where timestamp < end or (include_end and timestamp == end)
 | project source = "mining_ValidatedTelemetry", plant_id, run_id, event_id,
     sequence, timestamp, received_at, tag_id, value, unit, quality,
     interval_seconds = tolong(interval_seconds),
     scope_id = "", scheduled_running = bool(null), state = "",
     catalog_version = "${D01_CATALOG_VERSION}",
     profile_version = "${D01_PUBLISH_PROFILE_VERSION}",
     source_contract_version = "d01-validated-source-v1", module_id, equipment_id,
     event_conflict),
(mining_DeduplicatedState(plant, run, start, end)
 | where timestamp < end or (include_end and timestamp == end)
 | project source = "mining_ValidatedState", plant_id, run_id, event_id,
     sequence, timestamp, received_at, tag_id = "", value = real(null), unit = "",
     quality = "", interval_seconds = long(null), scope_id, scheduled_running, state,
     catalog_version = "${D01_CATALOG_VERSION}", profile_version = "",
     source_contract_version = "d01-validated-source-v1", module_id = "", equipment_id = "",
     event_conflict));
let identities = union
  (mining_ValidatedTelemetry
   | where plant_id == plant and run_id == run
   | project event_id, payload_fingerprint,
       identity = tostring(pack_array("telemetry", sequence, timestamp, module_id,
         equipment_id, tag_id, value, unit, quality, interval_seconds,
         catalog_version, profile_version, source_contract_version))),
  (mining_ValidatedState
   | where plant_id == plant and run_id == run
   | project event_id, payload_fingerprint,
       identity = tostring(pack_array("state", sequence, timestamp, scope_id,
         scheduled_running, state, catalog_version, source_contract_version)))
  | join kind=leftsemi (candidates | distinct event_id) on event_id
  | summarize fingerprints = make_set(payload_fingerprint, 2),
      identities = make_set(identity, 2),
      missing_fingerprints = countif(isempty(payload_fingerprint)) by event_id;
candidates
| join kind=inner identities on event_id
| extend event_conflict = event_conflict or array_length(fingerprints) != 1
    or array_length(identities) != 1 or missing_fingerprints > 0
| project source, plant_id, run_id, event_id, sequence, timestamp, received_at,
    tag_id, value, unit, quality, interval_seconds, scope_id, scheduled_running, state,
    catalog_version, profile_version, source_contract_version, module_id, equipment_id,
    event_conflict
| order by timestamp asc, sequence asc`;
