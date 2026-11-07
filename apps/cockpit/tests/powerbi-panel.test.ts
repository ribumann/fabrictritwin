import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../src/ui/public/powerbi-panel.js", import.meta.url), "utf8");
function fixture() {
  const status = { textContent: "" };
  const message = { textContent: "", innerHTML: "" };
  const report = { setAccessToken: vi.fn(async () => {}), on: vi.fn() };
  const sdk = { embed: vi.fn(() => report), reset: vi.fn() };
  const documentImpl = { hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const fetchImpl = vi.fn(async () => Response.json({
    status: "ready", reportId: "report", datasetId: "dataset", workspaceId: "workspace",
    embedUrl: "https://app.powerbi.com/reportEmbed", tokenType: "Embed", accessToken: "test-embed-token",
    expiration: new Date(Date.now() + 600_000).toISOString(),
  }));
  const windowObject: { createPowerBiPanel?: (options: object) => { refresh: () => Promise<void>; dispose: () => void } } = {};
  vm.runInNewContext(source, { window: windowObject, Date, setTimeout, clearTimeout, AbortController });
  const panel = windowObject.createPowerBiPanel!({
    container: {}, status, message, sdk, models: { TokenType: { Embed: 1 }, Permissions: { Read: 0 } },
    fetchImpl, documentImpl,
  });
  return { panel, status, message, report, sdk, fetchImpl, documentImpl };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-09T12:00:00Z")); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Power BI panel automatic renewal", () => {
  it("embeds once then uses setAccessToken without losing report state", async () => {
    const f = fixture();
    await Promise.all([f.panel.refresh(), f.panel.refresh()]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.sdk.embed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(480_000);
    expect(f.report.setAccessToken).toHaveBeenCalledWith("test-embed-token");
    expect(f.sdk.embed).toHaveBeenCalledTimes(1);
    expect(f.status.textContent).toBe("Embedded");
    f.panel.dispose();
  });

  it("retires an expired report during an outage and retries without leaking errors", async () => {
    const f = fixture();
    await f.panel.refresh();
    f.fetchImpl.mockRejectedValue(new Error("test-embed-token secret"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.sdk.reset).toHaveBeenCalled();
    expect(f.message.textContent).not.toContain("test-embed-token");
    expect(f.fetchImpl.mock.calls.length).toBeGreaterThan(2);
    f.panel.dispose();
  });

  it.each([401, 403])("clears the report and stops renewal when access is denied (%i)", async (status) => {
    const f = fixture();
    await f.panel.refresh();
    f.fetchImpl.mockResolvedValue(new Response(null, { status }));
    await vi.advanceTimersByTimeAsync(480_000);
    expect(f.sdk.reset).toHaveBeenCalledTimes(1);
    expect(f.status.textContent).toBe("Not authorized");
    // Anonymous visitors already get this report via Cockpit's own service-principal
    // identity (MI-mode); a 401/403 means the browser is signed in as a principal that
    // is not authorized, so the recovery action is signing out, not signing in again.
    expect(f.message.innerHTML).toContain('href="/.auth/logout?post_logout_redirect_uri=%2F"');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    f.panel.dispose();
  });

  it("does not retry missing configuration until reload", async () => {
    const f = fixture();
    f.fetchImpl.mockResolvedValue(Response.json({ status: "not-configured" }, { status: 503 }));
    await f.panel.refresh();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.status.textContent).toBe("Configuration needed");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    f.panel.dispose();
  });

  it("recovers on tab visibility and cleans up listeners and timers", async () => {
    const f = fixture();
    await f.panel.refresh();
    vi.setSystemTime(new Date(Date.now() + 500_000));
    const onVisibility = f.documentImpl.addEventListener.mock.calls[0][1] as () => void;
    onVisibility();
    await f.panel.refresh();
    expect(f.report.setAccessToken).toHaveBeenCalledTimes(1);
    f.panel.dispose();
    expect(f.documentImpl.removeEventListener).toHaveBeenCalledWith("visibilitychange", onVisibility);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores in-flight responses after disposal", async () => {
    const f = fixture();
    let complete!: (response: Response) => void;
    f.fetchImpl.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = f.panel.refresh();
    f.panel.dispose();
    complete(Response.json({ status: "ready" }));
    await pending;
    expect(f.sdk.embed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("re-embeds if expiry removes the iframe during an SDK token acknowledgement", async () => {
    const f = fixture();
    await f.panel.refresh();
    let respond!: (response: Response) => void;
    f.fetchImpl.mockImplementationOnce(() => new Promise((resolve) => { respond = resolve; }));
    let acknowledge!: () => void;
    f.report.setAccessToken.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    await vi.advanceTimersByTimeAsync(599_000);
    respond(Response.json({
      status: "ready", reportId: "report", datasetId: "dataset", workspaceId: "workspace",
      embedUrl: "https://app.powerbi.com/reportEmbed", tokenType: "Embed", accessToken: "new-token",
      expiration: new Date(Date.now() + 600_000).toISOString(),
    }));
    const pending = f.panel.refresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    acknowledge();
    await pending;
    expect(f.sdk.embed).toHaveBeenCalledTimes(2);
    expect(f.status.textContent).toBe("Embedded");
    f.panel.dispose();
  });

  it("bounds an SDK acknowledgement that never resolves so renewal can retry", async () => {
    const f = fixture();
    await f.panel.refresh();
    f.report.setAccessToken.mockImplementationOnce(() => new Promise(() => {}));
    const pending = f.panel.refresh();
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(f.status.textContent).toBe("Temporarily unavailable");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.report.setAccessToken).toHaveBeenCalledTimes(2);
    f.panel.dispose();
  });
});
