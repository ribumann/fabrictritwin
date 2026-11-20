const cadence = 30;
const arrivalGrace = 5;

export function collectReceipt(history, run) {
  const start = Date.parse(run?.startedAt);
  const stop = Date.parse(run?.stopAt);
  const receipt = run?.nativeReceipt;
  const sample = Date.parse(receipt?.sampleTime);
  const received = Date.parse(receipt?.receivedAt);
  const seconds = (sample - start) / 1000;
  const prior = history[0]?.runId === run?.runId && history[0]?.start === start ? history : [];
  if (
    run?.publisherStatus !== "running" ||
    run.stopRequested ||
    !run.runId ||
    receipt?.runId !== run.runId ||
    !Number.isFinite(stop) ||
    !(sample > start && sample <= stop && received >= sample) ||
    !(seconds === 5 || seconds % cadence === 0) ||
    ![receipt.stateCount, receipt.telemetryCount].every(
      (count) => Number.isSafeInteger(count) && count >= 0 && count <= 200,
    ) ||
    prior.some((batch) => batch.seconds === seconds)
  )
    return prior;
  return [...prior, { ...receipt, start, seconds }]
    .sort((a, b) => a.seconds - b.seconds)
    .slice(-21);
}

export function streamWindow(run, history, now = Date.now()) {
  const start = Date.parse(run?.startedAt);
  const stop = Date.parse(run?.stopAt);
  if (run?.publisherStatus !== "running" || run.stopRequested || !(stop > start)) return null;
  const last = history.findLast((batch) => batch.telemetryCount > 0)?.seconds ?? 0;
  const elapsed = Math.max(0, (now - start) / 1000);
  const due = last + cadence;
  if (due > (stop - start) / 1000) return null;
  return {
    last,
    due,
    progress: Math.max(0, Math.min(cadence, elapsed - last)),
    remaining: Math.max(0, Math.ceil(due - elapsed)),
    state: elapsed < due ? "collecting" : elapsed < due + arrivalGrace ? "arriving" : "overdue",
  };
}

const svgNs = "http://www.w3.org/2000/svg";
const width = 600;
const height = 92;
const left = 14;
const right = width - left;
const bottom = 84;

function mark(parent, tag, attributes) {
  const element = document.createElementNS(svgNs, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  parent.append(element);
}

function plot(target, domain, max, min, render) {
  const x = (seconds) => left + (seconds / domain) * (right - left);
  const y = (value) => bottom - ((value - min) / (max - min)) * 76;
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  for (const value of [min, (min + max) / 2, max]) {
    mark(svg, "line", { x1: left, y1: y(value), x2: right, y2: y(value), class: "stream-grid" });
  }
  render(svg, x, y);
  target.replaceChildren(svg);
}

const readingValid = (batch) =>
  batch.telemetryCount > 0 &&
  typeof batch.reading?.tagId === "string" &&
  typeof batch.reading?.unit === "string" &&
  Number.isFinite(batch.reading?.value);

export function collectPreview(run) {
  const start = Date.parse(run?.startedAt);
  const stop = Date.parse(run?.stopAt);
  if (!Array.isArray(run?.simulatorPreview) || !(stop > start)) return [];
  const points = new Map();
  for (const point of run.simulatorPreview.slice(-120)) {
    const sample = Date.parse(point?.sampleTime);
    const seconds = (sample - start) / 1000;
    if (
      point?.runId === run.runId &&
      sample > start &&
      sample <= stop &&
      seconds % 5 === 0 &&
      Number.isFinite(point.hopperTonnes) &&
      point.hopperTonnes >= 0
    )
      points.set(seconds, { seconds, value: point.hopperTonnes });
  }
  return [...points.values()].sort((a, b) => a.seconds - b.seconds);
}

export function drawStreamCharts(history, preview, element, format) {
  const set = (id, value) => (element(id).textContent = value);
  const newest = history.at(-1);
  const horizon = Math.max(newest?.seconds ?? 0, preview.at(-1)?.seconds ?? 0);
  const domain = Math.max(60, Math.ceil(horizon / 60) * 60);
  const ticks = [0, domain / 2, domain].map((s) => `${s / 60}m`).join(" · ");
  const batchMax = Math.max(
    10,
    Math.ceil(
      Math.max(0, ...history.map((batch) => batch.stateCount + batch.telemetryCount)) / 10,
    ) * 10,
  );
  plot(element("stream-batches"), domain, batchMax, 0, (svg, x, y) => {
    for (const batch of history) {
      for (const [count, offset, kind] of [
        [batch.stateCount, 0, "state"],
        [batch.telemetryCount, batch.stateCount, "numeric"],
      ]) {
        if (count > 0)
          mark(svg, "rect", {
            x: x(batch.seconds) - 5,
            y: y(count + offset),
            width: 10,
            height: y(offset) - y(count + offset),
            class: `stream-${kind}`,
          });
      }
    }
  });
  set("stream-batch-scale", `0–${batchMax} events · ${ticks} into run`);
  set(
    "stream-batch-latest",
    newest
      ? `At +${newest.seconds}s: ${newest.stateCount} state, ${newest.telemetryCount} numeric`
      : "No batch observed yet",
  );

  const latest = preview.at(-1);
  const values = preview.map(({ value }) => value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const padding = Math.max(0.1, (max - min) * 0.1);
  plot(element("stream-reading"), domain, max + padding, min - padding, (svg, x, y) => {
    for (const [i, point] of preview.entries()) {
      const previous = preview[i - 1];
      if (previous && point.seconds - previous.seconds === 5) {
        mark(svg, "line", {
          x1: x(previous.seconds),
          y1: y(previous.value),
          x2: x(point.seconds),
          y2: y(point.value),
          class: "stream-trace",
        });
      }
      mark(svg, "circle", {
        cx: x(point.seconds),
        cy: y(point.value),
        r: 2.5,
        class: "stream-preview-point",
      });
    }
  });
  set(
    "stream-reading-scale",
    latest ? `${format(min - padding)}–${format(max + padding)} t · ${ticks}` : `${ticks} into run`,
  );
  set(
    "stream-reading-latest",
    latest
      ? `${format(latest.value)} t at +${latest.seconds}s`
      : "Waiting for the first 5-second simulator tick",
  );
  const rows = history.map((batch) => {
    const row = document.createElement("tr");
    const reading = readingValid(batch)
      ? `${batch.reading.tagId}: ${format(batch.reading.value)} ${batch.reading.unit}`
      : "—";
    for (const value of [`+${batch.seconds}s`, batch.stateCount, batch.telemetryCount, reading]) {
      const cell = row.insertCell();
      cell.textContent = value;
    }
    return row;
  });
  element("stream-batch-rows").replaceChildren(...rows);
  element("stream-batch-details").hidden = !rows.length;
}
