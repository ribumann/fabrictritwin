export const supportedMcpTools = [
  "query_recovery_trend",
  "query_training_load",
  "query_active_alerts",
  "query_race_splits",
] as const;

export type SupportedMcpToolName = (typeof supportedMcpTools)[number];

export interface JsonRpcToolCallRequest {
  jsonrpc: "2.0";
  method: "tools/call";
  params: {
    name: SupportedMcpToolName;
    arguments: Record<string, unknown>;
  };
  id: number;
}

export function isSupportedMcpToolName(value: unknown): value is SupportedMcpToolName {
  return typeof value === "string" && supportedMcpTools.includes(value as SupportedMcpToolName);
}

export function buildMcpToolCallRequest(
  tool: SupportedMcpToolName,
  args: Record<string, unknown>,
): JsonRpcToolCallRequest {
  return {
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      name: tool,
      arguments: args,
    },
    id: 1,
  };
}
