import { createRequire } from "node:module";
import { resolve } from "node:path";

const [origin, scenario, playwrightPath = "playwright"] = process.argv.slice(2);
if (!origin || !["triathlon", "mining"].includes(scenario)) {
  throw new Error(
    "Usage: node measure-twin-latency.mjs <origin> <triathlon|mining> [playwright-module-path]",
  );
}
const base = new URL(origin);
if (
  base.protocol !== "https:" ||
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash
) {
  throw new Error("Supply a bare HTTPS origin.");
}
const require = createRequire(import.meta.url);
const { chromium } = require(
  playwrightPath === "playwright" ? playwrightPath : resolve(playwrightPath),
);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const record = (stage, fields = {}) => console.log(JSON.stringify({ scenario, stage, ...fields }));
const timeout = 240_000;

try {
  const page = await browser.newPage();
  const mining = scenario === "mining";
  const selector = mining ? "#run-start" : "#start-session";
  await page.addInitScript(
    ({ selector, mining }) => {
      const probe = (window.latencyProbe = {});
      document.addEventListener(
        "click",
        (event) => {
          if (event.target.closest(selector)) {
            probe.trigger = { utc: new Date().toISOString(), clock: performance.now() };
          }
        },
        true,
      );
      if (!mining) return;
      new MutationObserver(() => {
        const label = document.querySelector("#arrival-lag")?.textContent?.trim();
        if (!probe.trigger || !label || !/\d/.test(label)) return;
        const overview = probe.overview;
        if (!overview || overview.runId !== probe.runId) return;
        probe.visible ??= {
          clock: performance.now(),
          utc: new Date().toISOString(),
          label,
          overview,
        };
      }).observe(document, { subtree: true, childList: true, characterData: true });
    },
    { selector, mining },
  );

  let triId;
  const firstFrames = new Map();
  if (!mining) {
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        let frame;
        try {
          frame = JSON.parse(String(payload));
        } catch {
          return;
        }
        if (frame.type !== "metric" || !frame.sessionId || firstFrames.has(frame.sessionId)) return;
        firstFrames.set(frame.sessionId, {
          utc: new Date().toISOString(),
          sampleTime: frame.metric?.timestamp,
        });
      }),
    );
  } else {
    page.on("response", async (response) => {
      const url = new URL(response.url());
      const runId = url.searchParams.get("runId");
      if (
        url.origin !== base.origin ||
        url.pathname !== "/api/mining/overview" ||
        !runId ||
        !response.ok()
      )
        return;
      const utc = new Date().toISOString();
      const data = await response.json().catch(() => null);
      if (!data) return;
      const readings = (data.latest?.readings ?? [])
        .filter((row) => row.receivedAt && row.sampleTime)
        .map(({ eventId, sampleTime, receivedAt }) => ({ eventId, sampleTime, receivedAt }));
      if (!readings.length) return;
      await page
        .evaluate(
          (overview) => {
            const probe = window.latencyProbe;
            if (probe.runId === overview.runId) {
              probe.overview = overview;
              const label = document.querySelector("#arrival-lag")?.textContent?.trim();
              if (label && /\d/.test(label)) {
                probe.visible ??= {
                  clock: performance.now(),
                  utc: new Date().toISOString(),
                  label,
                  overview,
                };
              }
            }
          },
          {
            runId,
            utc,
            readings: [...new Map(readings.map((row) => [JSON.stringify(row), row])).values()],
          },
        )
        .catch((error) => {
          if (!page.isClosed()) record("observer_error", { message: error.message });
        });
    });
  }

  await page.goto(new URL(mining ? "/mining/" : "/", base).href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (id) => !document.querySelector(id)?.disabled && !!document.querySelector(id),
    selector,
  );
  const startPath = mining ? "/api/mining/demo/runs/start" : "/api/simulate/trigger-session";
  const admission = page.waitForResponse(
    (response) =>
      response.url() === new URL(startPath, base).href && response.request().method() === "POST",
  );
  await page.locator(selector).click();
  const response = await admission;
  if (response.status() !== 202)
    throw new Error(`${scenario} admission: HTTP ${response.status()}; not retrying`);
  const payload = await response.json();
  const trigger = await page.evaluate(() => window.latencyProbe.trigger);
  const run = payload;
  const runId = run?.runId;
  if (!/^[\da-f-]{36}$/i.test(runId ?? "")) throw new Error("Admission did not include a run ID");
  record("admitted", {
    runId,
    triggerUtc: trigger.utc,
    responseUtc: new Date().toISOString(),
    startedAt: run.startedAt,
  });
  if (mining) {
    await page.evaluate((id) => {
      window.latencyProbe.runId = id;
    }, runId);
    await page.waitForFunction(() => !!window.latencyProbe.visible, null, { timeout });
    const visible = await page.evaluate(() => window.latencyProbe.visible);
    record("fabric_ui", {
      runId,
      visibleUtc: visible.utc,
      clickToVisibleMs: Math.round(visible.clock - trigger.clock),
      label: visible.label,
      responseUtc: visible.overview.utc,
      readings: visible.overview.readings,
    });
  } else {
    triId = runId;
    const telemetry = page.locator("#telemetry-list");
    await telemetry.getByText(triId, { exact: true }).waitFor({ timeout });
    const visible = await page.evaluate(() => ({
      clock: performance.now(),
      utc: new Date().toISOString(),
    }));
    record("websocket_ui", {
      runId,
      visibleUtc: visible.utc,
      clickToVisibleMs: Math.round(visible.clock - trigger.clock),
      firstFrame: firstFrames.get(triId),
    });
    await page.waitForFunction(
      () => document.querySelector("#simulation-status")?.textContent === "completed",
      null,
      { timeout },
    );
    record("publisher_complete", { runId });
  }
} finally {
  await browser.close();
}
