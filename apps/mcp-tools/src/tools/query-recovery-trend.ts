import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Notification, Request } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { RecoveryTrendResponse, ToolErrorResponse } from "../models.js";
import type { AthleteAssistantDataService } from "../services/athlete-assistant-data.js";
import { getAthleteAssistantDataService } from "../services/athlete-assistant-data.js";
import { authorizeToolCall, toToolResult } from "../tool-context.js";

const queryRecoveryTrendInputSchema = z.object({
  athleteId: z.string().uuid(),
  days: z.number().int().positive().max(30).default(7),
});

export type QueryRecoveryTrendInput = z.infer<typeof queryRecoveryTrendInputSchema>;

export async function executeQueryRecoveryTrendTool(
  input: QueryRecoveryTrendInput,
  extra?: Pick<RequestHandlerExtra<Request, Notification>, "requestInfo">,
  dataService: AthleteAssistantDataService = getAthleteAssistantDataService(),
): Promise<RecoveryTrendResponse | ToolErrorResponse> {
  const parsedInput = queryRecoveryTrendInputSchema.parse(input);
  const authorization = authorizeToolCall(parsedInput.athleteId, extra);
  if ("error" in authorization) {
    return authorization;
  }

  try {
    return await dataService.getRecoveryTrend(authorization.athleteId, parsedInput.days);
  } catch {
    return { error: "Unable to query recovery trend right now." };
  }
}

export function registerQueryRecoveryTrendTool(
  server: McpServer,
  dataService?: AthleteAssistantDataService,
): void {
  server.registerTool(
    "query_recovery_trend",
    {
      title: "Query recovery trend",
      description:
        "Returns recent recovery score, sleep debt, and HRV trend for the authorized athlete.",
      inputSchema: {
        athleteId: z.string().uuid(),
        days: z.number().int().positive().max(30).default(7),
      },
    },
    async (args, extra) =>
      toToolResult(await executeQueryRecoveryTrendTool(args, extra, dataService)),
  );
}
