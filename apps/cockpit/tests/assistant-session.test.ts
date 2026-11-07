import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Result = { response: { status: number; ok?: boolean; type?: string }; parsedBody?: { error?: { canRefresh?: boolean; code?: string } } };
type PostJson = (...args: unknown[]) => Promise<Result>;

function loadHelper(refresh: typeof fetch) {
  const context: {
    fetch: typeof fetch;
    Response: typeof Response;
    TriatwinAssistantSession?: { postQuestion: (post: PostJson, payload: unknown) => Promise<Result> };
  } = { fetch: refresh, Response };
  const source = readFileSync(new URL("../src/ui/public/assistant-session.js", import.meta.url), "utf8");
  runInNewContext(source, context);
  if (!context.TriatwinAssistantSession) {
    throw new Error("Assistant session helper was not registered");
  }
  return context.TriatwinAssistantSession.postQuestion;
}

describe("assistant browser session recovery", () => {
  const expired = { response: { status: 401 }, parsedBody: { error: { canRefresh: true } } };

  it("refreshes only once and resends the same question without storing credentials", async () => {
    const refresh = vi.fn(async () => new Response(null, { status: 200 }));
    const post = vi.fn<PostJson>().mockResolvedValueOnce(expired).mockResolvedValueOnce({ response: { status: 200 } });
    const payload = { question: "Keep my question", athleteId: "athlete" };
    const result = await loadHelper(refresh)(post, payload);
    expect(result.response.status).toBe(200);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(2, "/api/assistant/ask", payload, { redirect: "manual" });
    expect(refresh).toHaveBeenCalledWith("/.auth/refresh", {
      credentials: "same-origin", redirect: "manual", cache: "no-store",
    });
  });

  it("never loops when the retried request still needs refresh", async () => {
    const refresh = vi.fn(async () => new Response(null, { status: 200 }));
    const post = vi.fn<PostJson>().mockResolvedValue(expired);
    expect((await loadHelper(refresh)(post, {})).response.status).toBe(401);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("keeps sign-in required when EasyAuth refresh fails", async () => {
    const refresh = vi.fn(async () => new Response(null, { status: 401 }));
    const post = vi.fn<PostJson>().mockResolvedValue(expired);
    expect((await loadHelper(refresh)(post, {})).response.status).toBe(401);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not refresh or resubmit consent/permission errors", async () => {
    const refresh = vi.fn();
    const post = vi.fn<PostJson>().mockResolvedValue({ response: { status: 401 }, parsedBody: { error: { canRefresh: false } } });
    await loadHelper(refresh)(post, {});
    expect(refresh).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("handles an expired EasyAuth browser session without following its login redirect", async () => {
    const refresh = vi.fn();
    const post = vi.fn<PostJson>().mockResolvedValue({ response: { status: 0, type: "opaqueredirect" } });
    const result = await loadHelper(refresh)(post, {});
    expect(result.response.status).toBe(401);
    expect(result.parsedBody?.error?.code).toBe("assistant_authentication_required");
    expect(refresh).not.toHaveBeenCalled();
  });
});
