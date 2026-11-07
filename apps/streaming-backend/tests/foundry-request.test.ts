import { AIProjectClient } from "@azure/ai-projects";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("sends the native Fabric REST extension with the SDK's Foundry-scoped bearer", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    id: "response", status: "completed", output: [], output_text: "grounded",
  }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const getToken = vi.fn(async () => ({
    token: "user-foundry-token", expiresOnTimestamp: Date.now() + 3600_000,
  }));
  const client = new AIProjectClient("https://example.services.ai.azure.com/api/projects/demo", { getToken });
  const body = {
    agent_reference: { name: "athlete-assistant", type: "agent_reference" },
    input: "Recovery?", stream: false,
    tools: [{
      type: "fabric_dataagent_preview",
      fabric_dataagent_preview: { project_connections: [{ project_connection_id: "/connections/fabric" }] },
    }],
  };
  await client.getOpenAIClient().post("/responses", { body });
  expect(getToken).toHaveBeenCalledWith(["https://ai.azure.com/.default"], expect.anything());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://example.services.ai.azure.com/api/projects/demo/openai/v1/responses");
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer user-foundry-token");
  expect(JSON.parse(String(init.body))).toEqual(body);
});
