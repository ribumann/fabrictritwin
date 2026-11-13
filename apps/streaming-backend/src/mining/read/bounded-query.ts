import { ManagedIdentityCredential } from "@azure/identity";
import {
  Client,
  ClientRequestProperties,
  KustoConnectionStringBuilder,
  type KustoResponseDataSet,
} from "azure-kusto-data";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_BYTES = 1_048_576;
const MAX_ROWS = 1000;
const DEADLINE_MS = 9_000;

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

interface QueryClient {
  axiosInstance: { defaults: { maxContentLength?: number } };
  executeQuery(
    database: string,
    query: string,
    properties: ClientRequestProperties,
  ): Promise<KustoResponseDataSet>;
  close(): void;
}

interface Options {
  client?: () => QueryClient;
  now?: () => number;
}

export class MiningQueryError extends Error {
  constructor(
    public readonly code:
      "configuration" | "invalid" | "timeout" | "cancelled" | "malformed" | "overflow",
    message: string,
  ) {
    super(message);
    this.name = "MiningQueryError";
  }
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
    !/^[a-z0-9][a-z0-9.-]*\.kusto\.windows\.net$/.test(url.hostname) ||
    url.hostname.split(".").some((label) => /^ingest(?:-|$)/.test(label)) ||
    !/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/.test(database)
  )
    throw new MiningQueryError(
      "configuration",
      "The mining query target must be an approved HTTPS Kusto query endpoint and database.",
    );
  return { uri, database };
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
  if (input.kind === "summary")
    return `${windowHead}); mining_PlantSummary(plant, run, start, end)`;
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
    const properties = new ClientRequestProperties();
    properties.setTimeout(DEADLINE_MS);
    properties.setClientTimeout(DEADLINE_MS);
    properties.setOption("truncationmaxrecords", MAX_ROWS + 1);
    properties.setOption("truncationmaxsize", MAX_BYTES);
    if (signal?.aborted) throw new MiningQueryError("cancelled", "Mining query was cancelled.");
    let client: QueryClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          client?.close();
          reject(new MiningQueryError("timeout", "Mining query exceeded its deadline."));
        }, DEADLINE_MS);
        cancel = () => {
          client?.close();
          reject(new MiningQueryError("cancelled", "Mining query was cancelled."));
        };
        signal?.addEventListener("abort", cancel, { once: true });
      });
      const query = await Promise.race([
        prepare(input, properties, (options.now ?? Date.now)()),
        deadline,
      ]);
      client =
        options.client?.() ??
        new Client(
          KustoConnectionStringBuilder.withTokenCredential(
            config.uri,
            new ManagedIdentityCredential(
              env.MINING_MANAGED_IDENTITY_CLIENT_ID
                ? { clientId: env.MINING_MANAGED_IDENTITY_CLIENT_ID }
                : {},
            ),
          ),
        );
      client.axiosInstance.defaults.maxContentLength = MAX_BYTES;
      if (signal?.aborted) throw new MiningQueryError("cancelled", "Mining query was cancelled.");
      const result = await Promise.race([
        client.executeQuery(config.database, query, properties),
        deadline,
      ]);
      const completion = result.dataSetCompletion;
      if (
        !completion ||
        completion.HasErrors ||
        !("Cancelled" in completion) ||
        completion.Cancelled !== false ||
        result.getErrorsCount().errors ||
        result.primaryResults.length !== 1
      ) {
        throw new MiningQueryError(
          "malformed",
          "Mining query returned an incomplete or invalid result.",
        );
      }
      const rows: Record<string, unknown>[] = [];
      for (const row of result.primaryResults[0].rows()) {
        rows.push(row.toJSON<Record<string, unknown>>());
        if (rows.length > input.maxRows) {
          throw new MiningQueryError("overflow", "Mining query exceeded the requested row limit.");
        }
      }
      if (Buffer.byteLength(JSON.stringify(rows), "utf8") > MAX_BYTES) {
        throw new MiningQueryError("overflow", "Mining query exceeded the response byte limit.");
      }
      return rows;
    } finally {
      if (timer) clearTimeout(timer);
      if (cancel) signal?.removeEventListener("abort", cancel);
      client?.close();
    }
  };
}
