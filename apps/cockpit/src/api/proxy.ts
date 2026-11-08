import type { Request, Response as ExpressResponse } from "express";
import { buildServiceAuthHeaders } from "./service-auth.js";

export interface StreamingBackendProxyOptions {
  streamingBackendBaseUrl: string;
  fetchImpl?: typeof fetch;
  buildAuthHeaders?: () => Promise<Record<string, string>>;
}

async function relayUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
): Promise<void> {
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) res.setHeader("Retry-After", retryAfter);
  const rawBody = await upstream.text();

  if (contentType.includes("application/json")) {
    try {
      res.status(upstream.status).json(rawBody ? (JSON.parse(rawBody) as unknown) : {});
    } catch {
      res.status(upstream.status).type(contentType).send(rawBody);
    }
    return;
  }

  res.status(upstream.status).type(contentType).send(rawBody);
}

export async function proxyStreamingBackendGet(
  _req: Request,
  res: ExpressResponse,
  options: StreamingBackendProxyOptions,
  buildUpstreamUrl: () => URL,
  errorCode: string,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const buildAuthHeaders = options.buildAuthHeaders ?? buildServiceAuthHeaders;

  try {
    const headers = await buildAuthHeaders();
    const upstream = await fetchImpl(buildUpstreamUrl(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    await relayUpstreamResponse(upstream, res);
  } catch (error) {
    res.status(502).json({
      error: {
        code: errorCode,
        message: error instanceof Error ? error.message : "Failed to reach the Streaming Backend.",
      },
    });
  }
}

export async function proxyStreamingBackendPost(
  _req: Request,
  res: ExpressResponse,
  options: StreamingBackendProxyOptions,
  buildUpstreamUrl: () => URL,
  requestBody: unknown,
  errorCode: string,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const buildAuthHeaders = options.buildAuthHeaders ?? buildServiceAuthHeaders;

  try {
    const headers = new Headers(await buildAuthHeaders());
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const upstream = await fetchImpl(buildUpstreamUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
    await relayUpstreamResponse(upstream, res);
  } catch (error) {
    res.status(502).json({
      error: {
        code: errorCode,
        message: error instanceof Error ? error.message : "Failed to reach the Streaming Backend.",
      },
    });
  }
}
