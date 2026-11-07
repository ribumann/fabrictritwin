import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Notification, Request } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { ToolErrorResponse, TrainingLoadResponse } from "../models.js";
import type { AthleteAssistantDataService } from "../services/athlete-assistant-data.js";
import { getAthleteAssistantDataService } from "../services/athlete-assistant-data.js";
import { authorizeToolCall, toToolResult } from "../tool-context.js";

const queryTrainingLoadInputSchema = z.object({
  athleteId: z.string().uuid(),
});

export type QueryTrainingLoadInput = z.infer<typeof queryTrainingLoadInputSchema>;

export async function executeQueryTrainingLoadTool(
  input: QueryTrainingLoadInput,
  extra?: Pick<RequestHandlerExtra<Request, Notification>, "requestInfo">,
  dataService: AthleteAssistantDataService = getAthleteAssistantDataService(),
): Promise<TrainingLoadResponse | ToolErrorResponse> {
  const parsedInput = queryTrainingLoadInputSchema.parse(input);
  const authorization = authorizeToolCall(parsedInput.athleteId, extra);
  if ("error" in authorization) {
    return authorization;
  }

  try {
    return await dataService.getTrainingLoad(authorization.athleteId);
  } catch {
    return { error: "Unable to query training load right now." };
  }
}

export function registerQueryTrainingLoadTool(
  server: McpServer,
  dataService?: AthleteAssistantDataService,
): void {
  server.registerTool(
    "query_training_load",
    {
      title: "Query training load",
      description:
        "Returns the current training-block phase, ACWR, and recent completed sessions for the authorized athlete.",
      inputSchema: {
        athleteId: z.string().uuid(),
      },
    },
    async (args, extra) => toToolResult(await executeQueryTrainingLoadTool(args, extra, dataService)),
  );
}
