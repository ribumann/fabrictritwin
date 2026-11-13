import { ClientRequestProperties } from "azure-kusto-data";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_BYTES = 1_048_576;
const MAX_ROWS = 1000;
const DEADLINE_MS = 9_000;
const METADATA_BYTES = 16_384;
const RESOURCE = "https://kusto.kusto.windows.net";

type Family = "feed" | "density" | "vibration" | "water-energy";
interface Scope {
  runId: string;
  maxRows: number;
}
type Query =
  | (Scope & { kind: "latest"; asOf: string })
  | (Scope & { kind: "incidents"; asOf: string })
  | (Scope & { kind: "summary"; start: string; end: string })
  | (Scope & {
      kind: "trend";
      start: string;
      end: string;
      moduleId: string;
      metric: Family;
      binMinutes: 1 | 5;
    })
  | (Scope & {
      kind: "compare";
      start: string;
      end: string;
      metric: Family;
      binMinutes: 1 | 5;
    });

interface Options {
  fetch?: typeof fetch;
  now?: () => number;
}

export class MiningQueryError extends Error {
  constructor(
    public readonly code:
      "configuration" | "invalid" | "timeout" | "cancelled" | "malformed" | "overflow" | "upstream",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MiningQueryError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the non-progressive Kusto V2 envelope without interpreting source rows. */
export function parseMiningQueryFrames(value: unknown, maxRows: number): Record<string, unknown>[] {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS) {
    throw new MiningQueryError("invalid", "Invalid mining row limit.");
  }
  if (!Array.isArray(value) || value.length < 3) {
    throw new MiningQueryError("malformed", "Invalid mining query response frames.");
  }
  const [header] = value;
  const completion = value[value.length - 1];
  if (
    !record(header) ||
    header.FrameType !== "DataSetHeader" ||
    header.IsProgressive !== false ||
    typeof header.Version !== "string" ||
    !record(completion) ||
    completion.FrameType !== "DataSetCompletion" ||
    typeof completion.HasErrors !== "boolean" ||
    typeof completion.Cancelled !== "boolean"
  ) {
    throw new MiningQueryError("malformed", "Incomplete mining query response.");
  }
  if (completion.Cancelled) {
    throw new MiningQueryError("cancelled", "Mining query was cancelled by the service.");
  }
  if (completion.HasErrors) {
    throw new MiningQueryError("upstream", "The mining query failed.", {
      cause: completion.OneApiErrors,
    });
  }
  if (
    completion.OneApiErrors !== undefined &&
    (!Array.isArray(completion.OneApiErrors) || completion.OneApiErrors.length > 0)
  ) {
    throw new MiningQueryError("malformed", "Inconsistent mining query completion.");
  }
  let primary: Record<string, unknown>[] | undefined;
  const ids = new Set<number>();
  for (const frame of value.slice(1, -1)) {
    if (
      !record(frame) ||
      frame.FrameType !== "DataTable" ||
      !Number.isSafeInteger(frame.TableId) ||
      typeof frame.TableId !== "number" ||
      ids.has(frame.TableId) ||
      typeof frame.TableKind !== "string" ||
      typeof frame.TableName !== "string" ||
      !Array.isArray(frame.Columns) ||
      !Array.isArray(frame.Rows)
    ) {
      throw new MiningQueryError("malformed", "Invalid mining query result table.");
    }
    ids.add(frame.TableId);
    const names: string[] = [];
    for (const column of frame.Columns) {
      if (
        !record(column) ||
        typeof column.ColumnName !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_]*$/.test(column.ColumnName) ||
        names.includes(column.ColumnName) ||
        typeof column.ColumnType !== "string"
      ) {
        throw new MiningQueryError("malformed", "Invalid mining query result columns.");
      }
      names.push(column.ColumnName);
    }
    if (
      frame.Rows.length > MAX_ROWS ||
      (frame.TableKind === "PrimaryResult" && frame.Rows.length > maxRows)
    ) {
      throw new MiningQueryError("overflow", "Mining query exceeded the requested row limit.");
    }
    const rows: Record<string, unknown>[] = [];
    for (const values of frame.Rows) {
      if (
        !Array.isArray(values) ||
        values.length !== names.length ||
        values.some((item) => item === undefined)
      ) {
        throw new MiningQueryError("malformed", "Invalid mining query result row.");
      }
      const row: Record<string, unknown> = Object.create(null);
      names.forEach((name, index) => {
        row[name] = values[index];
      });
      rows.push(row);
    }
    if (frame.TableKind === "PrimaryResult") {
      if (primary) throw new MiningQueryError("malformed", "Multiple mining query results.");
      primary = rows;
    } else if (frame.TableKind === "QueryCompletionInformation") {
      if (
        !names.includes("Level") ||
        rows.some((row) => typeof row.Level !== "number" || !Number.isFinite(row.Level))
      ) {
        throw new MiningQueryError("malformed", "Invalid mining query execution status.");
      }
      if (rows.some((row) => typeof row.Level === "number" && row.Level <= 2)) {
        throw new MiningQueryError("upstream", "The mining query reported an execution error.", {
          cause: rows,
        });
      }
    }
  }
  if (!primary) throw new MiningQueryError("malformed", "Missing mining query result.");
  return primary;
}

function configuration(env: NodeJS.ProcessEnv): { uri: string; database: string } {
  const uri = env.EVENTHOUSE_QUERY_URI;
  const database = env.EVENTHOUSE_DATABASE_NAME;
  if (
    !uri ||
    !database ||
    uri !== env.MINING_EVENTHOUSE_QUERY_URI ||
    database !== env.MINING_EVENTHOUSE_DATABASE_NAME ||
    env.MINING_CURATED_SOURCE_VERSION !== "d01-validated-source-v1" ||
    env.MINING_CURATED_QUERY_VERSION !== "d01-g5-query-v1"
  ) {
    throw new MiningQueryError(
      "configuration",
      "The approved mining query target and contract versions are not configured.",
    );
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new MiningQueryError("configuration", "Invalid mining query endpoint.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !/^[a-z0-9][a-z0-9.-]*\.kusto\.(?:windows\.net|fabric\.microsoft\.com)$/.test(url.hostname) ||
    url.hostname.split(".").some((label) => /^ingest(?:-|$)/.test(label)) ||
    !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(database)
  )
    throw new MiningQueryError(
      "configuration",
      "The mining query target must be an approved HTTPS Kusto query endpoint and database.",
    );
  return { uri, database };
}

function identityEndpoint(env: NodeJS.ProcessEnv): URL {
  if (
    !env.IDENTITY_ENDPOINT ||
    !env.IDENTITY_HEADER ||
    !env.MINING_MANAGED_IDENTITY_CLIENT_ID ||
    !uuid.test(env.MINING_MANAGED_IDENTITY_CLIENT_ID)
  ) {
    throw new MiningQueryError("configuration", "The mining managed identity is not configured.");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(env.IDENTITY_ENDPOINT);
  } catch {
    throw new MiningQueryError("configuration", "Invalid managed identity endpoint.");
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new MiningQueryError("configuration", "The managed identity endpoint must be loopback.");
  }
  endpoint.searchParams.set("api-version", "2019-08-01");
  endpoint.searchParams.set("resource", RESOURCE);
  endpoint.searchParams.set("client_id", env.MINING_MANAGED_IDENTITY_CLIENT_ID);
  return endpoint;
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new MiningQueryError("upstream", `Mining service returned HTTP ${response.status}.`);
  }
  if (!response.body) throw new MiningQueryError("malformed", "Mining service returned no body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        throw new MiningQueryError("overflow", "Mining service response exceeded its byte limit.");
      }
      chunks.push(value);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw new MiningQueryError("malformed", "Mining service returned invalid JSON.", { cause });
    }
  } finally {
    if (!complete) await reader.cancel();
    reader.releaseLock();
  }
}

function assertPublicCloudMetadata(value: unknown): void {
  const azure = record(value) ? value.AzureAD : undefined;
  if (
    !record(azure) ||
    typeof azure.LoginEndpoint !== "string" ||
    !/^https:\/\/login\.microsoftonline\.com\/?$/.test(azure.LoginEndpoint) ||
    azure.LoginMfaRequired !== false ||
    azure.KustoServiceResourceId !== RESOURCE
  ) {
    throw new MiningQueryError("configuration", "Unsupported mining query cloud metadata.");
  }
}

function accessToken(value: unknown, clientId: string, now: number): string {
  if (
    !record(value) ||
    typeof value.access_token !== "string" ||
    !value.access_token ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    value.resource !== RESOURCE ||
    value.client_id !== clientId ||
    (typeof value.expires_on !== "string" && typeof value.expires_on !== "number")
  ) {
    throw new MiningQueryError("malformed", "Invalid managed identity token response.");
  }
  const expiry = String(value.expires_on);
  const expiryMs = /^\d+$/.test(expiry) ? Number(expiry) * 1000 : Date.parse(expiry);
  if (!Number.isFinite(expiryMs) || expiryMs <= now) {
    throw new MiningQueryError("malformed", "The managed identity token is expired or invalid.");
  }
  return value.access_token;
}

function canonicalUtc(value: string, now: number): string {
  const time = Date.parse(value);
  if (!utc.test(value) || !Number.isFinite(time) || time > now) {
    throw new MiningQueryError("invalid", "Mining query timestamps must be valid, nonfuture UTC.");
  }
  const normalized = value.replace(
    /(?:\.(\d{1,3}))?Z$/,
    (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(3, "0")}Z`,
  );
  if (new Date(time).toISOString() !== normalized) {
    throw new MiningQueryError("invalid", "Mining query timestamps must be valid, nonfuture UTC.");
  }
  return normalized;
}

async function prepare(
  input: Query,
  properties: ClientRequestProperties,
  now: number,
): Promise<string> {
  if (
    !uuid.test(input.runId) ||
    !Number.isInteger(input.maxRows) ||
    input.maxRows < 1 ||
    input.maxRows > MAX_ROWS
  ) {
    throw new MiningQueryError("invalid", "Invalid mining run or row limit.");
  }
  properties.setParameter("plant", "'D01'");
  properties.setParameter("run", `'${input.runId}'`);
  const head = "declare query_parameters(plant:string, run:string";
  if (input.kind === "latest" || input.kind === "incidents") {
    properties.setParameter("asof", `datetime(${canonicalUtc(input.asOf, now)})`);
    const name = input.kind === "latest" ? "mining_PlantLatest" : "mining_ActiveIncidents";
    return `${head}, asof:datetime); ${name}(plant, run, asof)`;
  }
  const start = canonicalUtc(input.start, now);
  const end = canonicalUtc(input.end, now);
  if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 86_400_000) {
    throw new MiningQueryError(
      "invalid",
      "Mining query windows must be positive and no longer than 24 hours.",
    );
  }
  properties.setParameter("start", `datetime(${start})`);
  properties.setParameter("end", `datetime(${end})`);
  const windowHead = `${head}, start:datetime, end:datetime`;
  if (input.kind === "summary") {
    if (Date.parse(end) - Date.parse(start) < 60_000) {
      throw new MiningQueryError("invalid", "Mining summary windows must be at least one minute.");
    }
    return `${windowHead}); mining_PlantSummary(plant, run, start, end)`;
  }
  if (
    !["feed", "density", "vibration", "water-energy"].includes(input.metric) ||
    (input.kind === "compare" && input.metric === "water-energy") ||
    ![1, 5].includes(input.binMinutes)
  ) {
    throw new MiningQueryError("invalid", "Unsupported mining metric or bin size.");
  }
  properties.setParameter("metric", `'${input.metric}'`);
  properties.setParameter("bin", String(input.binMinutes));
  if (input.kind === "compare") {
    return `${windowHead}, metric:string, bin:int); mining_CompareLines(plant, run, metric, start, end, bin)`;
  }
  const { D01_PLANT_CATALOG } = await import("@triathlon-twin/simulator/mining");
  if (!D01_PLANT_CATALOG.modules.some((module) => module.id === input.moduleId)) {
    throw new MiningQueryError("invalid", "Unknown mining module.");
  }
  properties.setParameter("module", `'${input.moduleId}'`);
  return `${windowHead}, module:string, metric:string, bin:int); mining_AssetTrend(plant, run, module, metric, start, end, bin)`;
}

/** Not mounted until curated source readiness and typed result mapping are implemented. */
export function createBoundedMiningQuery(
  env: NodeJS.ProcessEnv = process.env,
  options: Options = {},
) {
  return async (input: Query, signal?: AbortSignal): Promise<Record<string, unknown>[]> => {
    const config = configuration(env);
    const identity = identityEndpoint(env);
    const properties = new ClientRequestProperties();
    properties.setTimeout(DEADLINE_MS);
    properties.setClientTimeout(DEADLINE_MS);
    properties.setOption("truncationmaxrecords", MAX_ROWS + 1);
    properties.setOption("truncationmaxsize", MAX_BYTES);
    if (signal?.aborted) throw new MiningQueryError("cancelled", "Mining query was cancelled.");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, DEADLINE_MS);
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const query = await prepare(input, properties, (options.now ?? Date.now)());
      controller.signal.throwIfAborted();
      const request = options.fetch ?? fetch;
      const metadata = await readJson(
        await request(`${config.uri.replace(/\/$/, "")}/v1/rest/auth/metadata`, {
          headers: { "Cache-Control": "no-cache" },
          redirect: "error",
          signal: controller.signal,
        }),
        METADATA_BYTES,
      );
      assertPublicCloudMetadata(metadata);
      controller.signal.throwIfAborted();
      const token = accessToken(
        await readJson(
          await request(identity, {
            headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER! },
            redirect: "error",
            signal: controller.signal,
          }),
          METADATA_BYTES,
        ),
        env.MINING_MANAGED_IDENTITY_CLIENT_ID!,
        (options.now ?? Date.now)(),
      );
      controller.signal.throwIfAborted();
      const response = await request(`${config.uri.replace(/\/$/, "")}/v2/rest/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-ms-readonly": "true",
        },
        body: JSON.stringify({ db: config.database, csl: query, properties: properties.toJSON() }),
        redirect: "error",
        signal: controller.signal,
      });
      return parseMiningQueryFrames(await readJson(response, MAX_BYTES), input.maxRows);
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new MiningQueryError(
          timedOut ? "timeout" : "cancelled",
          timedOut ? "Mining query exceeded its deadline." : "Mining query was cancelled.",
          { cause },
        );
      }
      if (cause instanceof MiningQueryError) throw cause;
      throw new MiningQueryError("upstream", "Mining query transport failed.", { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  };
}
