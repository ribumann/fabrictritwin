import type { Request, Response as ExpressResponse } from "express";
import { buildServiceAuthHeaders } from "./service-auth.js";

export interface StreamingBackendProxyOptions {
  streamingBackendBaseUrl: string;
  fetchImpl?: typeof fetch;
  buildAuthHeaders?: (signal?: AbortSignal) => Promise<Record<string, string>>;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) void promise.catch(() => {});
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function relayUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
  maxResponseBytes?: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (res.destroyed) return;
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter) res.setHeader("Retry-After", retryAfter);
  let rawBody: string;
  if (maxResponseBytes && upstream.body) {
    const reader = upstream.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await awaitWithAbort(reader.read(), signal);
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxResponseBytes) {
          await awaitWithAbort(reader.cancel(), signal);
          throw new Error("Backend response exceeds the permitted byte limit.");
        }
        chunks.push(value);
      }
      rawBody = Buffer.concat(chunks).toString("utf8");
    } finally {
      if (signal?.aborted) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else {
    rawBody = await awaitWithAbort(upstream.text(), signal);
  }

  signal?.throwIfAborted();
  if (res.destroyed) return;
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
    options.signal?.throwIfAborted();
    const headers = await awaitWithAbort(buildAuthHeaders(), options.signal);
    options.signal?.throwIfAborted();
    const upstream = await awaitWithAbort(
      fetchImpl(buildUpstreamUrl(), {
        method: "GET",
        headers,
        signal: options.signal ?? AbortSignal.timeout(10_000),
      }),
      options.signal,
    );
    await relayUpstreamResponse(upstream, res, options.maxResponseBytes, options.signal);
  } catch (error) {
    if (res.destroyed || res.headersSent) return;
    res.status(options.signal?.aborted ? 504 : 502).json({
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
    await relayUpstreamResponse(upstream, res, options.maxResponseBytes);
  } catch (error) {
    res.status(502).json({
      error: {
        code: errorCode,
        message: error instanceof Error ? error.message : "Failed to reach the Streaming Backend.",
      },
    });
  }
}
