import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/ui/public/app.js", import.meta.url), "utf8");
const tree = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set([
  "escapeHtml",
  "isPlainObject",
  "humanizeKey",
  "formatMcpCellValue",
  "formatNumber",
  "formatTimestamp",
  "renderMcpTable",
  "renderMcpKeyValue",
  "renderMcpError",
  "parseMcpText",
  "renderMcpText",
  "renderMcpValue",
  "renderMcpResult",
]);
const helpers = tree.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""))
  .map((node) => node.getText(tree))
  .join("\n");

function render(value: unknown, rawBody?: string) {
  const raw = { textContent: "" };
  const target = { innerHTML: "", querySelector: () => raw };
  const context = {
    MCP_LABEL_ACRONYMS: new Set(["hrv", "acwr", "rpe", "id"]),
    target,
    rawBody,
    value,
  };
  runInNewContext(`${helpers}\nrenderMcpResult(target, value, rawBody);`, context);
  return { html: target.innerHTML, raw: raw.textContent };
}

describe("Direct MCP readable results", () => {
  it("preserves all 112 synthetic history days outside the MCP preview", () => {
    const context = {
      MCP_LABEL_ACRONYMS: new Set(["hrv", "acwr", "rpe", "id"]),
      records: Array.from({ length: 112 }, (_, day) => ({ day })),
      html: "",
    };
    runInNewContext(`${helpers}\nhtml = renderMcpTable(records);`, context);
    expect(context.html.match(/<tr>/g)).toHaveLength(113);
    expect(context.html).toContain("<td>111</td>");
    expect(context.html).not.toContain("raw response");
  });

  it("renders the authoritative structuredContent and JSON text tool envelope", () => {
    const payload = {
      currentPhase: "Build",
      acwr: 1.12,
      recentSessions: [{ sessionId: "session", date: "2026-11-08", durationMinutes: 60, rpe: 7 }],
    };
    const result = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      },
    };
    const output = render(result);
    expect(output.html).toContain("Current phase");
    expect(output.html).toContain("60 min");
    expect(output.html).toContain("RPE");
    expect(output.html).toContain('scope="col"');
    expect(output.raw).toBe(JSON.stringify(result, null, 2));
    expect(output.html).not.toContain("&quot;recentSessions&quot;");
  });

  it("reads SSE messages, progress, multi-line data and comments without losing raw text", () => {
    const value =
      ': keepalive\r\nevent: message\r\nid: event-1\r\ndata: {"jsonrpc":"2.0",\r\ndata: "method":"notifications/progress","params":{"progress":50}}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"alerts\\":[]}"}]}}\r\n\r\n';
    const output = render(value);
    expect(output.html).toContain("notifications/progress");
    expect(output.html).toContain("50");
    expect(output.html).toContain("Alerts");
    expect(output.html).toContain("No rows returned");
    expect(output.html).toContain("keepalive");
    expect(output.raw).toBe(value);
  });

  it("shows every array, nested field, null, boolean and known units", () => {
    const output = render({
      trend: [{ date: "2026-11-08", hrv: 55 }],
      alerts: [{ raisedAt: "2026-11-08T08:00:00Z", detail: "Rest" }],
      splits: [{ currentPaceSecPerKm: 300, currentHeartRate: 145 }],
      metadata: { enabled: true, absent: null, note: "See clinician" },
    });
    expect(output.html.match(/<table /g)).toHaveLength(3);
    for (const text of ["HRV", "Raised at", "300 sec/km", "145 bpm", "Yes", "—", "See clinician"]) {
      expect(output.html).toContain(text);
    }
    expect(output.html).not.toContain("Invalid Date");
  });

  it.each([[], {}, "", null])("shows an explicit empty value for %j", (value) => {
    const output = render(value);
    expect(output.html).toMatch(/No rows returned|No data returned|No text returned|—/);
  });

  it("shows RPC errors and accompanying diagnostic fields including code zero", () => {
    const output = render({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: 0,
        message: "Unable to query",
        data: { retryAfter: 20 },
      },
    });

    expect(output.html).toContain('class="mcp-error"');
    expect(output.html).toContain('class="mcp-error-code">0');
    expect(output.html).toContain("Unable to query");
    expect(output.html).toContain("Retry after");
  });

  it("preserves exact response whitespace and numeric-looking text", () => {
    const raw = '{ "jsonrpc": "2.0", "result": { "text": "00123" } }\n';
    const output = render(JSON.parse(raw), raw);
    expect(output.raw).toBe(raw);
    expect(output.html).toContain("2.0");
    expect(output.html).toContain("00123");
  });

  it("distinguishes tool errors returned in a successful RPC result", () => {
    expect(
      render({ result: { isError: true, content: [{ type: "text", text: "Denied" }] } }).html,
    ).toContain("The tool reported an error");
    expect(
      render({ result: { structuredContent: { error: "Not authorized for this athlete." } } }).html,
    ).toContain('class="mcp-error"');
  });

  it("keeps malformed JSON and unknown content readable and escapes HTML in keys and text", () => {
    const text = '<img src=x onerror="alert(1)">\n{invalid';
    const output = render({ [text]: text, content: [{ type: "image", data: "abc" }] });
    expect(output.html).not.toContain("<img");
    expect(output.html).toContain("&lt;img");
    expect(output.html).toContain("{invalid");
    expect(output.html).toContain("abc");
    expect(render(text).raw).toBe(text);
  });

  it("bounds rows, text and nesting while retaining the complete raw response", () => {
    let nested: unknown = { final: "still preserved" };
    for (let i = 0; i < 20; i++) nested = { next: nested };
    const value = {
      rows: Array.from({ length: 105 }, (_, id) => ({ id })),
      text: "x".repeat(5000),
      nested,
    };
    const output = render(value);
    expect(output.html).toContain("100 rows");
    expect(output.html).toContain("Text preview limited");
    expect(output.html).toContain("Nested data is in the raw response");
    expect(output.raw).toContain("still preserved");
    expect(output.raw).toBe(JSON.stringify(value, null, 2));
  });
});
