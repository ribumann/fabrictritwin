import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildServiceAuthHeaders,
  getServiceAccessToken,
  resetServiceTokenCacheForTests,
} from "../src/actions/service-auth.js";

describe("service-auth", () => {
  const originalScope = process.env.STREAMING_BACKEND_SCOPE;

  beforeEach(() => {
    resetServiceTokenCacheForTests();
    process.env.STREAMING_BACKEND_SCOPE = "api://test-app/.default";
  });

  afterEach(() => {
    resetServiceTokenCacheForTests();
    if (originalScope === undefined) {
      delete process.env.STREAMING_BACKEND_SCOPE;
    } else {
      process.env.STREAMING_BACKEND_SCOPE = originalScope;
    }
  });

  it("acquires a token for the configured scope using the injected credential", async () => {
    const getToken = vi.fn().mockResolvedValue({
      token: "fake-token-1",
      expiresOnTimestamp: Date.now() + 3_600_000,
    });

    const token = await getServiceAccessToken({ credential: { getToken } });

    expect(token).toBe("fake-token-1");
    expect(getToken).toHaveBeenCalledWith("api://test-app/.default");
  });

  it("caches the token across calls until it is near expiry", async () => {
    const getToken = vi.fn().mockResolvedValue({
      token: "fake-token-2",
      expiresOnTimestamp: Date.now() + 3_600_000,
    });

    const first = await getServiceAccessToken({ credential: { getToken } });
    const second = await getServiceAccessToken({ credential: { getToken } });

    expect(first).toBe("fake-token-2");
    expect(second).toBe("fake-token-2");
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("re-acquires the token once the cached one is near expiry", async () => {
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ token: "stale-token", expiresOnTimestamp: Date.now() - 1 })
      .mockResolvedValueOnce({ token: "fresh-token", expiresOnTimestamp: Date.now() + 3_600_000 });

    const first = await getServiceAccessToken({ credential: { getToken } });
    const second = await getServiceAccessToken({ credential: { getToken } });

    expect(first).toBe("stale-token");
    expect(second).toBe("fresh-token");
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("throws when the credential returns no token", async () => {
    const getToken = vi.fn().mockResolvedValue(null);

    await expect(getServiceAccessToken({ credential: { getToken } })).rejects.toThrow(
      /Failed to acquire a service access token/,
    );
  });

  it("throws when STREAMING_BACKEND_SCOPE is not configured and no scope is supplied", async () => {
    delete process.env.STREAMING_BACKEND_SCOPE;
    const getToken = vi.fn();

    await expect(getServiceAccessToken({ credential: { getToken } })).rejects.toThrow(
      /STREAMING_BACKEND_SCOPE is not configured/,
    );
    expect(getToken).not.toHaveBeenCalled();
  });

  it("builds Authorization: Bearer + content-type headers from the acquired token", async () => {
    const getToken = vi.fn().mockResolvedValue({
      token: "fake-token-3",
      expiresOnTimestamp: Date.now() + 3_600_000,
    });

    const headers = await buildServiceAuthHeaders({ credential: { getToken } });

    expect(headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer fake-token-3",
    });
  });
});
