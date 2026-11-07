import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Notification, Request } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import type { RaceSplitsResponse, ToolErrorResponse } from "../models.js";
import type { AthleteAssistantDataService } from "../services/athlete-assistant-data.js";
import { getAthleteAssistantDataService } from "../services/athlete-assistant-data.js";
import { authorizeToolCall, toToolResult } from "../tool-context.js";

const queryRaceSplitsInputSchema = z.object({
  athleteId: z.string().uuid(),
  raceId: z.string().min(1),
});

export type QueryRaceSplitsInput = z.infer<typeof queryRaceSplitsInputSchema>;

export async function executeQueryRaceSplitsTool(
  input: QueryRaceSplitsInput,
  extra?: Pick<RequestHandlerExtra<Request, Notification>, "requestInfo">,
  dataService: AthleteAssistantDataService = getAthleteAssistantDataService(),
): Promise<RaceSplitsResponse | ToolErrorResponse> {
  const parsedInput = queryRaceSplitsInputSchema.parse(input);
  const authorization = authorizeToolCall(parsedInput.athleteId, extra);
  if ("error" in authorization) {
    return authorization;
  }

  try {
    return await dataService.getRaceSplits(authorization.athleteId, parsedInput.raceId);
  } catch {
    return { error: "Unable to query race splits right now." };
  }
}

export function registerQueryRaceSplitsTool(
  server: McpServer,
  dataService?: AthleteAssistantDataService,
): void {
  server.registerTool(
    "query_race_splits",
    {
      title: "Query race splits",
      description: "Returns live or historical race splits plus a projected finish time for the authorized athlete.",
      inputSchema: {
        athleteId: z.string().uuid(),
        raceId: z.string().min(1),
      },
    },
    async (args, extra) => toToolResult(await executeQueryRaceSplitsTool(args, extra, dataService)),
  );
}
