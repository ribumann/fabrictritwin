import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Notification, Request } from "@modelcontextprotocol/sdk/types.js";
import type { ToolErrorResponse } from "./models.js";

export const AUTHORIZED_ATHLETE_HEADER = "x-triatwin-authorized-athlete-id";

function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

export function getHeaderValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const desired = normalizeHeaderName(name);
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (normalizeHeaderName(headerName) !== desired) {
      continue;
    }

    return Array.isArray(headerValue) ? headerValue[0] : headerValue;
  }

  return undefined;
}

export function resolveAuthorizedAthleteId(
  extra?: Pick<RequestHandlerExtra<Request, Notification>, "requestInfo">,
): string | undefined {
  return getHeaderValue(extra?.requestInfo?.headers, AUTHORIZED_ATHLETE_HEADER)?.trim() || undefined;
}

export function authorizeToolCall(
  requestedAthleteId: string,
  extra?: Pick<RequestHandlerExtra<Request, Notification>, "requestInfo">,
): { athleteId: string } | ToolErrorResponse {
  const authorizedAthleteId = resolveAuthorizedAthleteId(extra);
  if (!authorizedAthleteId || requestedAthleteId !== authorizedAthleteId) {
    return { error: "Not authorized for this athlete." };
  }

  return { athleteId: authorizedAthleteId };
}

export function toToolResult<T extends object>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
