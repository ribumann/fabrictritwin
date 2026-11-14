import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDirectory = path.join(root, 'scripts', 'fabric', 'fixtures');
const queryPath = path.join(outputDirectory, 'mining-engine-self-test.kql');
const manifestPath = path.join(outputDirectory, 'mining-engine-self-test.manifest.json');
const catalogPath = path.join(root, 'apps', 'simulator', 'src', 'mining', 'plant-catalog.json');
const historicalSourceFiles = [
  {
    path: 'infra/fabric/eventhouse/MiningValidation.kql',
    sha256: 'e733da5365075ea850588f1bf57ff3bc3ff7a2055fa3217149c5f4d26b94e0df',
  },
  {
    path: 'infra/fabric/eventhouse/MiningQueries.kql',
    sha256: 'aa2e41fa8d370f77e217da5304cd0ad7c5c4c1cce2b22b8ca541fa9b38f19c05',
  },
  {
    path: 'apps/simulator/src/mining/plant-catalog.json',
    sha256: '0ba278e5e28b3466381534c5a920ce28b551cb3a7ddfc68cdf4371749f2c62ce',
  },
  {
    path: 'apps/simulator/src/mining/catalog.ts',
    sha256: 'ae699fe26beaad2f245a317ecb96e9dbfdecdf0414a34e1eb26a31f5f1930a66',
  },
  {
    path: 'infra/fabric/eventhouse/MiningSchema.kql',
    sha256: 'd8b21287a96c87a041f7f741f3233f4da47bcd0a1c53bcd8db6e88a5bb2c26c1',
  },
];
const sourceRevision = 'd01-kql-coverage-bins-v5';
const sourceBaseCommit = '4d1f93b6d1cc7e940d24f73621742329c112197d';
const sourceFiles = historicalSourceFiles.map((source) => ({
  ...source,
  sha256: ({
    'infra/fabric/eventhouse/MiningValidation.kql': '8ed380084a1a1975fa4883e66085a6581ae5cce0321c661b37bcf050f6398170',
    'infra/fabric/eventhouse/MiningQueries.kql': '818036feac8f5edb23c2c3564014c1ab0b4271f1926dc3257a87271c53e1ab1a',
    'infra/fabric/eventhouse/MiningSchema.kql': '2d780c59767ae0937914aeb3e36c48182ad2d913720ad199526e1858e62dbdec',
  })[source.path] ?? source.sha256,
}));
const catalogVersion = `sha256:${sourceFiles[2].sha256}`;
const runId = 'd0100000-0000-4000-8000-000000000001';
const incidentId = 'd0100000-0000-4000-8000-000000000002';
const coreTagIds = [
  'D01.A.crusher.ore_flow',
  'D01.B.crusher.ore_flow',
  'D01.C.crusher.ore_flow',
  'D01.A.dms.medium_density',
  'D01.B.dms.medium_density',
  'D01.C.dms.medium_density',
  'D01.A.crusher.vibration_rms',
  'D01.B.crusher.vibration_rms',
  'D01.C.crusher.vibration_rms',
  'D01.shared.water.water_flow',
  'D01.shared.control.power',
];
const functionNames = [
  'mining_SourceReadiness',
  'mining_DeduplicatedTelemetry',
  'mining_DeduplicatedState',
  'mining_PlantLatest',
  'mining_PlantSummary',
  'mining_AssetTrend',
  'mining_ActiveIncidents',
  'mining_CompareLines',
];
const aliases = new Map([
  ['mining_SourceContract', '_selftest_SourceContract'],
  ['mining_PlantCatalog', '_selftest_PlantCatalog'],
  ['mining_PublishProfile', '_selftest_PublishProfile'],
  ['mining_ValidatedTelemetry', '_selftest_ValidatedTelemetry'],
  ['mining_ValidatedState', '_selftest_ValidatedState'],
  ['mining_IncidentLedger', '_selftest_IncidentLedger'],
  ...functionNames.map((name) => [name, `_selftest_${name.slice('mining_'.length)}`]),
]);

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readPinnedSource(relativePath, expectedHash) {
  const bytes = fs.readFileSync(path.join(root, relativePath));
  const actualHash = sha256(bytes);
  const text = bytes.toString('utf8');
  const originalCheckoutHash = sha256(
    Buffer.from(text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'), 'utf8'),
  );
  if (actualHash !== expectedHash && originalCheckoutHash !== expectedHash) {
    fail(`Pinned source changed: ${relativePath} (${actualHash})`);
  }
  return text.replace(/\r\n?/g, '\n');
}

function findClosingDelimiter(text, openIndex, opening, closing) {
  let depth = 0;
  let quoted = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const current = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quoted) {
      if (current === '\\') {
        index += 1;
      } else if (current === '"' && next === '"') {
        index += 1;
      } else if (current === '"') {
        quoted = false;
      }
      continue;
    }
    if (current === '/' && next === '/') {
      lineComment = true;
      index += 1;
    } else if (current === '/' && next === '*') {
      blockComment = true;
      index += 1;
    } else if (current === '"') {
      quoted = true;
    } else if (current === opening) {
      depth += 1;
    } else if (current === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  fail(`Unclosed ${opening}${closing} delimiter in frozen KQL source`);
}

function extractFunction(source, functionName) {
  const declaration = new RegExp(
    String.raw`\.create-or-alter\s+function\s+with\s*\(folder\s*=\s*"Mining/(?:Validation|Queries)"\)\s+${functionName}\b`,
    'm',
  );
  const match = declaration.exec(source);
  if (!match) fail(`Missing frozen function: ${functionName}`);
  const signatureStart = source.indexOf('(', match.index + match[0].length);
  const signatureEnd = findClosingDelimiter(source, signatureStart, '(', ')');
  const bodyStart = source.indexOf('{', signatureEnd + 1);
  if (bodyStart < 0) fail(`Missing function body: ${functionName}`);
  const bodyEnd = findClosingDelimiter(source, bodyStart, '{', '}');
  const parameters = source.slice(signatureStart + 1, signatureEnd).replace(/\s+/g, ' ').trim();
  const body = source.slice(bodyStart + 1, bodyEnd).trim();
  return { parameters, body };
}

function rewriteIdentifiers(text) {
  let output = '';
  let index = 0;
  let quoted = false;
  let lineComment = false;
  let blockComment = false;
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];
    if (lineComment) {
      output += current;
      index += 1;
      if (current === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      output += current;
      index += 1;
      if (current === '*' && next === '/') {
        output += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quoted) {
      output += current;
      index += 1;
      if (current === '\\' && index < text.length) {
        output += text[index];
        index += 1;
      } else if (current === '"' && text[index] === '"') {
        output += text[index];
        index += 1;
      } else if (current === '"') {
        quoted = false;
      }
      continue;
    }
    if (current === '/' && next === '/') {
      output += '//';
      index += 2;
      lineComment = true;
    } else if (current === '/' && next === '*') {
      output += '/*';
      index += 2;
      blockComment = true;
    } else if (current === '"') {
      output += current;
      index += 1;
      quoted = true;
    } else if (/[A-Za-z_]/.test(current)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index += 1;
      const identifier = text.slice(start, index);
      if (identifier.startsWith('mining_')) {
        const replacement = aliases.get(identifier);
        if (!replacement) fail(`Unmapped mining symbol in frozen KQL source: ${identifier}`);
        output += replacement;
      } else {
        output += identifier;
      }
    } else {
      output += current;
      index += 1;
    }
  }
  return output;
}

function kqlString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function kqlDynamic(value) {
  return `dynamic(${JSON.stringify(value)})`;
}

function datatable(name, schema, rows) {
  if (rows.length === 0) fail(`Synthetic fixture table is empty: ${name}`);
  return `let ${name} = datatable(${schema})[\n${rows.map((row) => `    ${row}`).join(',\n')}\n];`;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) fail(`Duplicate ${label} in synthetic fixture`);
}

function validateFixtureExpectations(catalog, runTelemetry, stateRows, profileRows, retryEvent) {
  const slowTags = catalog.telemetry_tags.filter((tag) =>
    ['bearing_temperature', 'level', 'product_mass'].includes(tag.metric)).length;
  if (slowTags !== 11 || profileRows.length - slowTags !== 45) {
    fail('Synthetic profile fixture does not match the frozen 45/11 cadence split');
  }
  if (runTelemetry.length !== 23 ||
      new Set(runTelemetry.map((row) => row.eventId)).size !== 22 ||
      runTelemetry.filter((row) => row.eventId === retryEvent.eventId).length !== 2) {
    fail('Synthetic retry fixture does not contain one exact two-copy event');
  }
  const retryCopies = runTelemetry.filter((row) => row.eventId === retryEvent.eventId);
  if (retryCopies[0].fingerprint !== retryCopies[1].fingerprint ||
      retryCopies[0].receiveDelaySeconds === retryCopies[1].receiveDelaySeconds) {
    fail('Synthetic retry fixture must preserve payload identity and vary receive time');
  }
  const feedValues = ['A', 'B', 'C'].map((line) => {
    const tagId = `D01.${line}.crusher.ore_flow`;
    const samples = [...new Map(
      runTelemetry.filter((row) => row.tagId === tagId).map((row) => [row.eventId, row]),
    ).values()];
    if (samples.length !== 2) fail(`Missing two feed samples for ${tagId}`);
    return samples[0].value;
  });
  const plantFeedTph = feedValues.reduce((sum, value) => sum + value, 0);
  const processedTonnes = feedValues.reduce((sum, value) => sum + value * 60 / 3600, 0);
  if (plantFeedTph !== 42 || Math.abs(processedTonnes - 0.7) > 1e-12 ||
      stateRows.length !== 4) {
    fail('Synthetic summary inputs do not match the pinned scalar expectations');
  }
}

function buildFixture(catalog) {
  const tagsById = new Map(catalog.telemetry_tags.map((tag) => [tag.id, tag]));
  const coreTags = coreTagIds.map((id) => {
    const tag = tagsById.get(id);
    if (!tag) fail(`Catalog is missing fixture tag: ${id}`);
    return tag;
  });
  const intervalFor = (metric) => ['bearing_temperature', 'level', 'product_mass'].includes(metric) ? 60 : 30;
  const modules = catalog.modules.map((row) => ({ kind: 'module', id: row.id, moduleId: row.id }));
  const equipment = catalog.equipment.map((row) => ({
    kind: 'equipment',
    id: row.id,
    moduleId: row.module_id,
  }));
  const streams = catalog.streams.map((row) => ({
    kind: 'stream',
    id: row.id,
    moduleId: row.module_id ?? '',
  }));
  const catalogRows = [
    ...modules,
    ...equipment,
    ...streams,
    ...catalog.telemetry_tags.map((tag) => ({ kind: 'tag', id: tag.id, moduleId: tag.module_id, tag })),
  ];
  assertUnique(catalogRows.map((row) => `${row.kind}:${row.id}`), 'catalog identity');
  if (catalogRows.length !== 194 || catalog.telemetry_tags.length !== 56) {
    fail('Frozen catalog counts do not match the D01 readiness contract');
  }
  const catalogKqlRows = catalogRows.map((row) => [
    '"D01"',
    kqlString(catalogVersion),
    kqlString(row.kind),
    kqlString(row.id),
    kqlString(row.moduleId),
    row.tag
      ? kqlDynamic({
        module_id: row.tag.module_id,
        equipment_id: row.tag.equipment_id,
        metric: row.tag.metric,
        unit: row.tag.unit,
      })
      : 'dynamic({})',
  ].join(', '));
  const profileRows = catalog.telemetry_tags.map((tag) => [
    '"D01"',
    kqlString(catalogVersion),
    '"d01-publish-profile-v1"',
    kqlString(tag.id),
    String(intervalFor(tag.metric)),
  ].join(', '));

  const runTelemetry = [];
  let sequence = 1;
  for (const tag of coreTags) {
    const sampleValues = tag.metric === 'ore_flow'
      ? ({ A: 12, B: 14, C: 16 }[tag.module_id.split('.')[1]])
      : tag.metric === 'medium_density'
        ? ({ A: 1500, B: 1600, C: 1700 }[tag.module_id.split('.')[1]])
        : tag.metric === 'vibration_rms'
          ? ({ A: 2.4, B: 2.8, C: 3.2 }[tag.module_id.split('.')[1]])
          : tag.metric === 'water_flow' ? 2 : 100;
    for (const ageSeconds of [30, 1]) {
      const rowSequence = sequence;
      const eventId = sha256(Buffer.from(`${runId}:${rowSequence}`, 'utf8'));
      const value = sampleValues;
      const fingerprint = sha256(Buffer.from(JSON.stringify([
        runId, rowSequence, tag.id, value, ageSeconds,
      ]), 'utf8'));
      runTelemetry.push({
        runId,
        eventId,
        sequence: rowSequence,
        ageSeconds,
        receiveDelaySeconds: 1,
        moduleId: tag.module_id,
        equipmentId: tag.equipment_id,
        tagId: tag.id,
        value,
        unit: tag.unit,
        intervalSeconds: intervalFor(tag.metric),
        fingerprint,
      });
      if (tag.id === 'D01.A.crusher.ore_flow' && ageSeconds === 1) {
        runTelemetry.push({
          ...runTelemetry.at(-1),
          receiveDelaySeconds: 3,
        });
      }
      sequence += 1;
    }
  }
  const telemetryRows = runTelemetry.map((row) => [
    '"D01"',
    kqlString(row.runId),
    kqlString(row.eventId),
    String(row.sequence),
    String(row.ageSeconds),
    String(row.receiveDelaySeconds),
    kqlString(row.moduleId),
    kqlString(row.equipmentId),
    kqlString(row.tagId),
    Number(row.value).toFixed(3),
    kqlString(row.unit),
    '"good"',
    String(row.intervalSeconds),
    kqlString(row.fingerprint),
  ].join(', '));
  const retryEvent = runTelemetry.find((row) =>
    row.tagId === 'D01.A.crusher.ore_flow' && row.ageSeconds === 1);
  if (!retryEvent) fail('Synthetic retry fixture event was not constructed');

  const stateRows = ['A', 'B', 'C', 'shared'].map((scopeId, index) => {
    const stateSequence = 100 + index;
    return [
      '"D01"',
      kqlString(runId),
      kqlString(sha256(Buffer.from(`${runId}:${stateSequence}`, 'utf8'))),
      String(stateSequence),
      kqlString(scopeId),
      'true',
      '"running"',
      kqlString(sha256(Buffer.from(JSON.stringify([runId, stateSequence, scopeId, 'running']), 'utf8'))),
    ].join(', ');
  });
  validateFixtureExpectations(catalog, runTelemetry, stateRows, profileRows, retryEvent);
  const incidentRows = [[
    '"D01"',
    kqlString(runId),
    kqlString(incidentId),
    kqlString(sha256(Buffer.from('d01-self-test-incident-raised', 'utf8'))),
    '1',
    '20',
    '1',
    '"self-test-rule"',
    '"A"',
    '"raised"',
    '"warning"',
    'dynamic({"source":"synthetic-self-test"})',
    '"d01-incident-ledger-v1"',
  ].join(', ')];

  const statements = [
    '// Synthetic-only scalar self-test; all source and data bindings below are query-local.',
    '// Local READY flags exercise query branches only and are not deployment or source proof.',
    'let _selftest_WindowEnd = bin(now() - 2m, 1m);',
    'let _selftest_WindowStart = _selftest_WindowEnd - 1m;',
    'let _selftest_AsOf = _selftest_WindowEnd + 1s;',
    `let _selftest_RunId = ${kqlString(runId)};`,
    `let _selftest_IncidentId = ${kqlString(incidentId)};`,
    datatable(
      '_selftest_SourceContract',
      'contract_version:string, catalog_version:string, profile_version:string, status:string, raw_timestamp_shape_verified:bool, exclusive_writer_approved:bool, incident_source_version:string, incident_source_ready:bool',
      [[
        '"d01-validated-source-v1"',
        kqlString(catalogVersion),
        '"d01-publish-profile-v1"',
        '"Ready"',
        'true',
        'true',
        '"d01-incident-ledger-v1"',
        'true',
      ].join(', ')],
    ).replace(/\n\];$/, '\n]\n| extend recorded_at = _selftest_AsOf;'),
    datatable(
      '_selftest_PlantCatalog',
      'plant_id:string, catalog_version:string, record_kind:string, record_id:string, module_id:string, record_json:dynamic',
      catalogKqlRows,
    ),
    datatable(
      '_selftest_PublishProfile',
      'plant_id:string, catalog_version:string, profile_version:string, tag_id:string, interval_seconds:int',
      profileRows,
    ),
    datatable(
      '_selftest_ValidatedTelemetry',
      'plant_id:string, run_id:string, event_id:string, sequence:long, age_seconds:long, receive_delay_seconds:long, module_id:string, equipment_id:string, tag_id:string, value:real, unit:string, quality:string, interval_seconds:int, payload_fingerprint:string',
      telemetryRows,
    ).replace(/\n\];$/, `
]
| extend timestamp = _selftest_WindowEnd - age_seconds * 1s
| extend received_at = timestamp + receive_delay_seconds * 1s,
    catalog_version = ${kqlString(catalogVersion)},
    profile_version = "d01-publish-profile-v1",
    source_contract_version = "d01-validated-source-v1"
| project plant_id, run_id, event_id, sequence, timestamp, received_at,
    module_id, equipment_id, tag_id, value, unit, quality, interval_seconds,
    catalog_version, profile_version, source_contract_version,
    payload_fingerprint;`),
    datatable(
      '_selftest_ValidatedState',
      'plant_id:string, run_id:string, event_id:string, sequence:long, scope_id:string, scheduled_running:bool, state:string, payload_fingerprint:string',
      stateRows,
    ).replace(/\n\];$/, `
]
| extend timestamp = _selftest_WindowEnd - 10s
| extend received_at = timestamp + 1s,
    catalog_version = ${kqlString(catalogVersion)},
    source_contract_version = "d01-validated-source-v1"
| project plant_id, run_id, event_id, sequence, timestamp, received_at,
    scope_id, scheduled_running, state, catalog_version,
    source_contract_version, payload_fingerprint;`),
    datatable(
      '_selftest_IncidentLedger',
      'plant_id:string, run_id:string, incident_id:string, event_id:string, event_sequence:long, age_seconds:long, receive_delay_seconds:long, rule_id:string, scope_id:string, event_type:string, severity:string, evidence:dynamic, source_contract_version:string',
      incidentRows,
    ).replace(/\n\];$/, `
]
| extend occurred_at = _selftest_WindowEnd - age_seconds * 1s
| extend received_at = occurred_at + receive_delay_seconds * 1s
| project plant_id, run_id, incident_id, event_id, event_sequence,
    occurred_at, received_at, rule_id, scope_id, event_type, severity,
    evidence, source_contract_version;`),
  ];

  const validationSource = readPinnedSource(sourceFiles[0].path, sourceFiles[0].sha256);
  const querySource = readPinnedSource(sourceFiles[1].path, sourceFiles[1].sha256);
  for (const name of functionNames) {
    const source = name === 'mining_SourceReadiness' ? validationSource : querySource;
    const { parameters, body } = extractFunction(source, name);
    const localName = aliases.get(name);
    statements.push(
      `let ${localName} = (${parameters}) {\n${rewriteIdentifiers(body)}\n};`,
    );
  }

  const retryEventId = retryEvent.eventId;
  statements.push(
    `let _selftest_Latest = materialize(_selftest_PlantLatest("D01", _selftest_RunId, _selftest_AsOf));`,
    `let _selftest_Summary = materialize(_selftest_PlantSummary("D01", _selftest_RunId, _selftest_WindowStart, _selftest_WindowEnd));`,
    `let _selftest_Trend = materialize(_selftest_AssetTrend("D01", _selftest_RunId, "D01.A.crusher", "feed", _selftest_WindowStart, _selftest_WindowEnd, 1));`,
    `let _selftest_Incidents = materialize(_selftest_ActiveIncidents("D01", _selftest_RunId, _selftest_AsOf));`,
    `let _selftest_Compare = materialize(_selftest_CompareLines("D01", _selftest_RunId, "feed", _selftest_WindowStart, _selftest_WindowEnd, 1));`,
    `let _selftest_LatestTags = _selftest_Latest | where row_kind == "tag";`,
    `let _selftest_LatestStates = _selftest_Latest | where row_kind == "state";`,
    `let _selftest_SummaryRow = toscalar(_selftest_Summary | project status);`,
    `let _selftest_TrendRow = toscalar(_selftest_Trend | project status);`,
    `let _selftest_IncidentRow = toscalar(_selftest_Incidents | project status);`,
    `let _selftest_CompareRows = _selftest_Compare | where status == "OK";`,
    `let _selftest_RetryCopies = toscalar(_selftest_ValidatedTelemetry | where event_id == ${kqlString(retryEventId)} | count);`,
    `let _selftest_RetryReceivedAtMatches = toscalar(_selftest_LatestTags | where tagId == "D01.A.crusher.ore_flow" | project received_at == event_time + 1s);`,
    `let _selftest_LatestMatch = toscalar(_selftest_LatestTags | where tagId == "D01.A.crusher.ore_flow" and status == "OK" and value == 12.0 and unit == "t/h" and received_at == event_time + 1s | count) == 1;`,
    `let _selftest_SummaryMatch = toscalar(_selftest_Summary | where status == "OK" and abs(line_a_feed_tph - 12.0) < 0.000001 and abs(line_b_feed_tph - 14.0) < 0.000001 and abs(line_c_feed_tph - 16.0) < 0.000001 and abs(plant_feed_tph - 42.0) < 0.000001 and abs(processed_tonnes - 0.7) < 0.000001 and running_lines == 3 and abs(common_coverage - 1.0) < 0.000001 and abs(gross_process_water_m3_per_t - (1.0 / 21.0)) < 0.000001 and abs(whole_plant_energy_kwh_per_t - (50.0 / 21.0)) < 0.000001 and good_sample_count == 10 and conflicting_event_count == 0 | count) == 1;`,
    `let _selftest_TrendMatch = toscalar(_selftest_Trend | where status == "OK" and module_id == "D01.A.crusher" and tagId == "D01.A.crusher.ore_flow" and seriesId == "D01.A.crusher.ore_flow" and metric_family == "feed" and value == 12.0 and unit == "t/h" and good_count == 2 and expected_samples == 2.0 and coverage == 1.0 | count) == 1;`,
    `let _selftest_IncidentMatch = toscalar(_selftest_Incidents | where status == "OK" and incident_id == _selftest_IncidentId and rule_id == "self-test-rule" and scope_id == "A" and severity == "warning" and active_state == "ACTIVE_UNACKNOWLEDGED" | count) == 1;`,
    `let _selftest_CompareMatch =
    toscalar(_selftest_CompareRows | where line_id == "A" and tag_id == "D01.A.crusher.ore_flow" and value == 12.0 and unit == "t/h" and good_count == 2 and coverage == 1.0 | count) == 1 and
    toscalar(_selftest_CompareRows | where line_id == "B" and tag_id == "D01.B.crusher.ore_flow" and value == 14.0 and unit == "t/h" and good_count == 2 and coverage == 1.0 | count) == 1 and
    toscalar(_selftest_CompareRows | where line_id == "C" and tag_id == "D01.C.crusher.ore_flow" and value == 16.0 and unit == "t/h" and good_count == 2 and coverage == 1.0 | count) == 1;`,
    `print
    self_test_passed = _selftest_SummaryRow == "OK" and _selftest_TrendRow == "OK" and
        _selftest_IncidentRow == "OK" and _selftest_RetryCopies == 2 and
        _selftest_RetryReceivedAtMatches and
        _selftest_LatestMatch and _selftest_SummaryMatch and _selftest_TrendMatch and
        _selftest_IncidentMatch and _selftest_CompareMatch and
        toscalar(_selftest_LatestTags | count) == 56 and
        toscalar(_selftest_LatestTags | where status == "OK" | count) == 11 and
        toscalar(_selftest_LatestStates | where status == "OK" | count) == 4 and
        toscalar(_selftest_LatestTags | where status == "UNKNOWN_NO_OBSERVATION" | count) == 45 and
        toscalar(_selftest_Trend | where status == "OK" | count) == 1 and
        toscalar(_selftest_CompareRows | count) == 3 and
        toscalar(_selftest_Incidents | where active_state == "ACTIVE_UNACKNOWLEDGED" | count) == 1 and
        abs(toscalar(_selftest_Summary | project plant_feed_tph) - 42.0) < 0.000001 and
        abs(toscalar(_selftest_Summary | project processed_tonnes) - 0.7) < 0.000001 and
        toscalar(_selftest_Summary | project running_lines) == 3 and
        abs(toscalar(_selftest_Summary | project common_coverage) - 1.0) < 0.000001 and
        toscalar(_selftest_CompareRows | summarize sum(good_count)) == 6,
    synthetic_source_status = toscalar(_selftest_SourceReadiness() | project status),
    catalog_rows = toscalar(_selftest_PlantCatalog | count),
    profile_rows = toscalar(_selftest_PublishProfile | count),
    telemetry_fixture_rows = toscalar(_selftest_ValidatedTelemetry | count),
    retry_copies = _selftest_RetryCopies,
    latest_tag_rows = toscalar(_selftest_LatestTags | count),
    latest_good_tag_rows = toscalar(_selftest_LatestTags | where status == "OK" | count),
    latest_state_rows = toscalar(_selftest_LatestStates | where status == "OK" | count),
    unknown_tag_rows = toscalar(_selftest_LatestTags | where status == "UNKNOWN_NO_OBSERVATION" | count),
    summary_status = _selftest_SummaryRow,
    summary_feed_tph = toscalar(_selftest_Summary | project plant_feed_tph),
    summary_processed_tonnes = toscalar(_selftest_Summary | project processed_tonnes),
    summary_common_coverage = toscalar(_selftest_Summary | project common_coverage),
    trend_rows = toscalar(_selftest_Trend | where status == "OK" | count),
    compare_rows = toscalar(_selftest_CompareRows | count),
    compare_good_samples = toscalar(_selftest_CompareRows | summarize sum(good_count)),
    latest_contract_match = _selftest_LatestMatch,
    summary_contract_match = _selftest_SummaryMatch,
    asset_trend_contract_match = _selftest_TrendMatch,
    active_incidents_contract_match = _selftest_IncidentMatch,
    compare_lines_contract_match = _selftest_CompareMatch,
    active_incidents = toscalar(_selftest_Incidents | where active_state == "ACTIVE_UNACKNOWLEDGED" | count);`,
  );

  const semanticCases = [
    {
      function: 'mining_PlantLatest',
      arguments: {
        plant_id: 'D01',
        run_id: runId,
        as_of_utc: 'window_end_utc + 1s',
      },
      expected: {
        rowCount: 60,
        tagRows: 56,
        observedTagRows: 11,
        unknownTagRows: 45,
        stateRows: 4,
        latestFeed: {
          tagId: 'D01.A.crusher.ore_flow',
          seriesId: 'D01.A.crusher.ore_flow',
          value: 12,
          unit: 't/h',
          receivedAt: 'event_time + 1s (minimum retry receipt)',
        },
      },
    },
    {
      function: 'mining_PlantSummary',
      arguments: {
        plant_id: 'D01',
        run_id: runId,
        window_start_utc: 'window_end_utc - 1m',
        window_end_utc: 'bin(now() - 2m, 1m)',
      },
      expected: {
        rowCount: 1,
        status: 'OK',
        lineFeedTph: { A: 12, B: 14, C: 16 },
        plantFeedTph: 42,
        processedTonnes: 0.7,
        runningLines: 3,
        goodSampleCount: 10,
        commonCoverage: 1,
        grossProcessWaterM3PerT: 1 / 21,
        wholePlantEnergyKwhPerT: 50 / 21,
        conflictingEventCount: 0,
      },
    },
    {
      function: 'mining_AssetTrend',
      arguments: {
        plant_id: 'D01',
        run_id: runId,
        requested_module_id: 'D01.A.crusher',
        metric_family: 'feed',
        window_start_utc: 'window_end_utc - 1m',
        window_end_utc: 'bin(now() - 2m, 1m)',
        bin_minutes: 1,
      },
      expected: {
        rowCount: 1,
        status: 'OK',
        moduleId: 'D01.A.crusher',
        tagId: 'D01.A.crusher.ore_flow',
        seriesId: 'D01.A.crusher.ore_flow',
        metricFamily: 'feed',
        value: 12,
        unit: 't/h',
        goodCount: 2,
        expectedSamples: 2,
        coverage: 1,
      },
    },
    {
      function: 'mining_ActiveIncidents',
      arguments: {
        plant_id: 'D01',
        requested_run_id: runId,
        as_of_utc: 'window_end_utc + 1s',
      },
      expected: {
        rowCount: 1,
        status: 'OK',
        incidentId,
        ruleId: 'self-test-rule',
        scopeId: 'A',
        severity: 'warning',
        activeState: 'ACTIVE_UNACKNOWLEDGED',
      },
    },
    {
      function: 'mining_CompareLines',
      arguments: {
        plant_id: 'D01',
        run_id: runId,
        metric_family: 'feed',
        window_start_utc: 'window_end_utc - 1m',
        window_end_utc: 'bin(now() - 2m, 1m)',
        bin_minutes: 1,
      },
      expected: {
        rowCount: 3,
        status: 'OK',
        lines: {
          A: { tagId: 'D01.A.crusher.ore_flow', value: 12, unit: 't/h', goodCount: 2, coverage: 1 },
          B: { tagId: 'D01.B.crusher.ore_flow', value: 14, unit: 't/h', goodCount: 2, coverage: 1 },
          C: { tagId: 'D01.C.crusher.ore_flow', value: 16, unit: 't/h', goodCount: 2, coverage: 1 },
        },
        totalGoodSamples: 6,
      },
    },
  ];

  return {
    query: `${statements.join('\n')}\n`,
    fixture: {
      catalogRows: catalogRows.length,
      profileRows: profileRows.length,
      telemetryRows: runTelemetry.length,
      telemetryLogicalEvents: new Set(runTelemetry.map((row) => row.eventId)).size,
      stateRows: stateRows.length,
      incidentRows: incidentRows.length,
      runId,
      incidentId,
      timeWindow: {
        windowEndUtc: 'bin(now() - 2m, 1m)',
        windowStartUtc: 'window_end_utc - 1m',
        asOfUtc: 'window_end_utc + 1s',
      },
      semanticCases,
      expected: {
        sourceStatus: 'READY (synthetic only)',
        latestTagRows: 56,
        latestGoodTagRows: 11,
        latestStateRows: 4,
        unknownTagRows: 45,
        summaryStatus: 'OK',
        summaryFeedTph: 42,
        summaryProcessedTonnes: 0.7,
        summaryRunningLines: 3,
        summaryCommonCoverage: 1,
        assetTrendRows: 1,
        compareLinesRows: 3,
        compareGoodSamples: 6,
        activeIncidents: 1,
        retryCopies: 2,
        retryReceivedAt: 'minimum received_at for same event_id',
      },
    },
  };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  for (const source of sourceFiles) readPinnedSource(source.path, source.sha256);
  const catalogBytes = fs.readFileSync(catalogPath);
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  const { query, fixture } = buildFixture(catalog);
  const queryBytes = Buffer.from(query, 'utf8');
  const maxBytes = 262144;
  if (queryBytes.length > maxBytes) fail(`Generated payload exceeds ${maxBytes} bytes`);
  if (/^\s*\./m.test(query) || /\bmining_[A-Za-z0-9_]+\b/.test(query)) {
    fail('Generated payload contains a management command or an unmapped mining symbol');
  }
  const manifest = {
    schemaVersion: 2,
    status: 'synthetic-engine-self-test-only',
    sourceRevision,
    sourceBaseCommit,
    historicalSource: {
      sourceCommit: '324d73496913b4a2944713eb8861f2b7fdba4c02',
      sourceFiles: historicalSourceFiles,
      payloadCommit: '94e90886629b07ee4100223077f0a6747636dfd6',
      querySha256: 'a1a05bf82f28989d32b8c7190e7fc3a341038b90f4e28a5c9d1edae4f15034b4',
      queryBytes: 108379,
    },
    previousCandidates: [{
      sourceRevision: 'd01-kql-reserved-identifier-v2',
      sourceCommit: '40d13ed257b0eeba7323d89710bc364872c23956',
      miningQueriesSha256: '68e69067deb7f898196ce2c64a95cd98e92652fd81b4e64866657d8acc037105',
      querySha256: 'c90677d2dbba05d300b4550f35601a56b0d8a32a7c219ee461253325e08e0677',
      queryBytes: 108399,
    }, {
      sourceRevision: 'd01-kql-string-conflict-v3',
      sourceCommit: '73e4e428128d5dffd527074feca90d3a103231c9',
      miningQueriesSha256: '9658f006440604d87b4211007dbd6e4990043ed6b80780e1808040dc343f91b8',
      querySha256: '0b3e3027612fab95ce513d2dafcfbfabc01cda0fdf34773c135e85713bd8a9cb',
      queryBytes: 108379,
    }, {
      sourceRevision: 'd01-kql-column-bindings-v4',
      sourceCommit: 'b43bfc477da75433ef9cd33bf2eed56059b527cc',
      miningQueriesSha256: '63f84951b34cf27722fb74f58234dac659af058d50dc2cb1430b58409fe48b4c',
      querySha256: '380c2234bbd86545ea52b8cc0af90e58a7671b38aa5f76c4b8974c7eae9ffd41',
      queryBytes: 108395,
    }],
    queryPath: 'scripts/fabric/fixtures/mining-engine-self-test.kql',
    querySha256: sha256(queryBytes),
    queryBytes: queryBytes.length,
    maxBytes,
    fixtureSha256: sha256(Buffer.from(JSON.stringify(fixture), 'utf8')),
    sourceFiles,
    fixture,
    proofRequirements: {
      status: 'requirements-only-not-issued',
      knownIdentity: {
        plantId: 'D01',
        catalogVersion,
        profileVersion: 'd01-publish-profile-v1',
        sourceContractVersion: 'd01-validated-source-v1',
        incidentSourceVersion: 'd01-incident-ledger-v1',
        sourceRevision,
        sourceBaseCommit,
        selfTestRunId: runId,
        selfTestFixtureSha256: sha256(Buffer.from(JSON.stringify(fixture), 'utf8')),
      },
      independentlyProtectedValuesRequired: [
        'target.environment (opaque exact-match value)',
        'target tenant, subscription, workspace, Eventstream and Eventhouse database identity',
        'authorized business run UUID and separately approved synthetic canary run UUID',
        'canary fixture identity, expected copy/row counts and fixture SHA-256',
        'native definition identity for MiningSchema.kql, MiningValidation.kql and MiningQueries.kql',
      ],
      canaryPerTable: ['mining_TelemetryRaw', 'mining_PlantStateEvents'].map((table) => ({
        table,
        expectedDistinctEventIds: 1,
        observedDistinctEventIds: 1,
        minimumCopies: 1,
        lexemeMatchCopies: 'equal copies',
        wrongDestinationCopies: 0,
        rawIngestionNonNullCopies: 'equal copies',
      })),
      classifierObservation: {
        sourceReadinessStatusIsAuthority: false,
        expectedRows: 'must be independently frozen by the approved canary fixture',
        observedRows: 'must equal expectedRows',
        nonNullReceivedAtRows: 'must equal expectedRows',
        ingestionTimePropagationMatchRows: 'must equal expectedRows',
        comparison: 'Duplicate-preserving multiset comparison by event_id and raw ingestion time versus event_id and received_at.',
        deduplicatedRowsPerExpectedEvent: 1,
        deduplicatedEventConflictRows: 0,
        deduplicatedReceivedAt: 'minimum raw ingestion time for identical copies',
        doNotInferExpectedRowsFromObservedCopies: true,
      },
      temporalOrder: 'deployment <= canary <= classifier <= semantic <= issuedAtUtc',
      nativeReadback: {
        status: 'unavailable-unverified',
        requiredOnEveryUse: true,
        requirements: [
          'Caller/run authorization must precede receipt and native-definition reads.',
          'Read the exact target and current native definitions through a bounded, cancellable, independently authorized readback.',
          'Compare current target and definition identities to protected expected values; a receipt or manifest alone is insufficient.',
          'Missing or unverified readback keeps readiness unavailable (503).',
        ],
      },
      selfTestContribution: 'informational-only; never grants deployment or source readiness',
    },
    limitations: [
      'Query-local datatable fixtures only; no deployed table, function, endpoint, or business-row reads.',
      'Synthetic source readiness flags exercise query branches and are not evidence of deployment or source readiness.',
      'Aggregate scalar output does not establish hosted KQL compilation, ingestion, timestamp preservation, or runtime readiness.',
      'Happy-path query results and same-event retry behavior are covered; hosted semantics and all error branches remain unverified.',
    ],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  if (checkOnly) {
    const existingQuery = fs.readFileSync(queryPath);
    const existingManifest = fs.readFileSync(manifestPath, 'utf8');
    if (!existingQuery.equals(queryBytes) || existingManifest !== manifestText) {
      fail('Generated payload or manifest is stale; rerun the builder');
    }
    console.log(`self-test payload verified: ${queryBytes.length} bytes sha256:${manifest.querySha256}`);
    return;
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(queryPath, queryBytes);
  fs.writeFileSync(manifestPath, manifestText, 'utf8');
  console.log(`wrote self-test payload: ${queryBytes.length} bytes sha256:${manifest.querySha256}`);
}

main();
