/* Embed tokens are renewed by our backend, not the Aad-only accessTokenProvider hook. */
window.createPowerBiPanel = function createPowerBiPanel({
  container,
  status,
  message,
  sdk = window.powerbi,
  models = window["powerbi-client"]?.models,
  fetchImpl = window.fetch.bind(window),
  documentImpl = document,
}) {
  let report;
  let reportKey;
  let expiresAt = 0;
  let refreshTimer;
  let expiryTimer;
  let pending;
  let stopped = false;
  let disposed = false;
  const controller = new AbortController();

  function reset() {
    if (report) sdk.reset(container);
    report = undefined;
    reportKey = undefined;
    expiresAt = 0;
    clearTimeout(expiryTimer);
  }

  function display(label, detail = "", { signedInButNotAuthorized = false } = {}) {
    status.textContent = label;
    // Anonymous visitors already get this report via Cockpit's own service-principal
    // identity (MI-mode; see api/powerbi.ts). A 401/403 here therefore means the opposite
    // of what it used to: the browser is carrying a *signed-in* EasyAuth session whose
    // principal is not on the report's allowlist (or has an invalid/expired token) --
    // inviting that visitor to "sign in" would only reinforce the blocked session. Offer
    // sign-out instead, which drops back to the working anonymous MI-mode path.
    if (signedInButNotAuthorized) {
      message.innerHTML = `${detail} <a href="/.auth/logout?post_logout_redirect_uri=%2F">Sign out</a> to use the default view.`;
    } else {
      message.textContent = detail;
    }
  }

  function schedule(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), delay);
  }

  async function updateToken(instance, token) {
    let timeout;
    try {
      await Promise.race([
        instance.setAccessToken(token),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("SDK token update timed out")), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function load() {
    try {
      const response = await fetchImpl("/api/powerbi/embed-config", {
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (disposed) return;
      if (response.status === 401 || response.status === 403) {
        stopped = true;
        reset();
        display("Not authorized", "The signed-in account is not authorized to view this report.", { signedInButNotAuthorized: true });
        return;
      }
      const config = await response.json();
      if (disposed) return;
      if (config.status === "not-configured") {
        stopped = true;
        reset();
        display("Configuration needed", "Power BI automatic embedding has not been configured by the operator.");
        return;
      }
      const expiration = Date.parse(config.expiration);
      if (!response.ok || config.status !== "ready" || config.tokenType !== "Embed" ||
          !config.accessToken || !config.reportId || !config.datasetId ||
          !Number.isFinite(expiration) || expiration <= Date.now() + 30_000) {
        throw new Error("Invalid embed configuration");
      }
      const key = `${config.workspaceId}/${config.reportId}/${config.datasetId}`;
      const previousReport = report;
      if (report && reportKey === key) {
        await updateToken(report, config.accessToken);
        if (disposed) return;
      }
      // The old expiry timer may have removed the iframe while the SDK was acknowledging.
      if (!report || report !== previousReport || reportKey !== key) {
        reset();
        report = sdk.embed(container, {
          type: "report",
          id: config.reportId,
          embedUrl: config.embedUrl,
          accessToken: config.accessToken,
          tokenType: models.TokenType.Embed,
          permissions: models.Permissions.Read,
          settings: {
            panes: {
              filters: { visible: false },
              pageNavigation: { visible: true },
            },
            // Fit the report to the container's width instead of Power BI's default
            // fixed-page layout, so the report actually scales with the card instead
            // of rendering small and letterboxed. See styles.css .report-container.
            layoutType: models.LayoutType?.Custom,
            customLayout: {
              displayOption: models.DisplayOption?.FitToWidth,
            },
          },
        });
        reportKey = key;
        report.on("error", () => {
          display("Report unavailable", "Power BI could not render the report. Check the model connection and embedding prerequisites.");
        });
      }
      expiresAt = expiration;
      clearTimeout(expiryTimer);
      expiryTimer = setTimeout(() => {
        reset();
        display("Token expired", "Renewing report access automatically.");
        void refresh();
      }, expiration - Date.now());
      display("Embedded");
      // Small server clock skew must not cause a tight renewal loop.
      schedule(Math.max(10_000, expiration - Date.now() - 120_000));
    } catch {
      if (disposed) return;
      if (expiresAt <= Date.now()) reset();
      display("Temporarily unavailable", report
        ? "Report access renewal failed. Retrying automatically before access expires."
        : "Unable to obtain report access. Retrying automatically; sign in again if your session has expired.");
      schedule(30_000);
    }
  }

  function refresh() {
    if (disposed || stopped) return Promise.resolve();
    if (pending) return pending;
    if (!sdk || !models) {
      stopped = true;
      display("Unavailable", "The Power BI client library did not load.");
      return Promise.resolve();
    }
    clearTimeout(refreshTimer);
    if (!report) display("Loading...");
    pending = load().finally(() => { pending = undefined; });
    return pending;
  }

  function onVisibility() {
    if (!documentImpl.hidden && Date.now() >= expiresAt - 120_000) void refresh();
  }
  documentImpl.addEventListener("visibilitychange", onVisibility);

  return {
    refresh,
    dispose() {
      disposed = true;
      controller.abort();
      clearTimeout(refreshTimer);
      reset();
      documentImpl.removeEventListener("visibilitychange", onVisibility);
    },
  };
};
