import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Notification, Request } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { ActiveAlertsToolResponse, ToolErrorResponse } from "../models.js";
import type { AthleteAssistantDataService } from "../services/athlete-assistant-data.js";
import { getAthleteAssistantDataService } from "../services/athlete-assistant-data.js";
import { authorizeToolCall, toToolResult } from "../tool-context.js";

const queryActiveAlertsInputSchema = z.object({
  athleteId: z.string().uuid(),
});

export type QueryActiveAlertsInput = z.infer<typeof queryActiveAlertsInputSchema>;

export async function executeQueryActiveAlertsTool(
  input: QueryActiveAlertsInput,
  extra?: Pick<RequestHandlerExtra<Request, Notification>, "requestInfo">,
  dataService: AthleteAssistantDataService = getAthleteAssistantDataService(),
): Promise<ActiveAlertsToolResponse | ToolErrorResponse> {
  const parsedInput = queryActiveAlertsInputSchema.parse(input);
  const authorization = authorizeToolCall(parsedInput.athleteId, extra);
  if ("error" in authorization) {
    return authorization;
  }

  try {
    return await dataService.getActiveAlerts(authorization.athleteId);
  } catch {
    return { error: "Unable to query active alerts right now." };
  }
}

export function registerQueryActiveAlertsTool(
  server: McpServer,
  dataService?: AthleteAssistantDataService,
): void {
  server.registerTool(
    "query_active_alerts",
    {
      title: "Query active alerts",
      description: "Returns currently active alerts for the authorized athlete.",
      inputSchema: {
        athleteId: z.string().uuid(),
      },
    },
    async (args, extra) =>
      toToolResult(await executeQueryActiveAlertsTool(args, extra, dataService)),
  );
}
