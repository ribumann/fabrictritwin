import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FabricNotebookLoadHistoryRunner } from "../src/services/daily-generate.js";

const workspaceId = "workspace-1";
const notebookId = "notebook-1";
const pollUri = `https://api.fabric.microsoft.com/v1/workspaces/${workspaceId}/items/${notebookId}/jobs/instances/job-1`;

describe("FabricNotebookLoadHistoryRunner", () => {
  const getToken = vi.fn(async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 3_600_000 }));
  const fetchMock = vi.fn<typeof fetch>();
  const runner = new FabricNotebookLoadHistoryRunner({ getToken });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.stubEnv("FABRIC_WORKSPACE_ID", workspaceId);
    vi.stubEnv("LOAD_HISTORY_NOTEBOOK_ITEM_ID", notebookId);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function acceptJob() {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202, headers: { Location: pollUri } }));
  }

  it("uses the MI-supported release notebook API with typed parameters and waits for Completed", async () => {
    acceptJob();
    fetchMock.mockResolvedValueOnce(Response.json({ status: "NotStarted" }));
    fetchMock.mockResolvedValueOnce(Response.json({ status: "InProgress" }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "job-1", status: "Completed" }));

    const completion = runner.run({ environment: "test", athleteId: "athlete-1" });
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await completion).toEqual({ attempted: true, status: "completed", workspaceId, notebookId, jobInstanceId: "job-1" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.fabric.microsoft.com/v1/workspaces/${workspaceId}/notebooks/${notebookId}/jobs/execute/instances?beta=false`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          parameters: [
            { name: "athlete_id", value: "athlete-1", type: "Text" },
            { name: "environment", value: "test", type: "Text" },
          ],
          executionData: { compute: "Spark" },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, pollUri, expect.any(Object));
    expect(getToken).toHaveBeenCalledTimes(4);
    expect(getToken).toHaveBeenCalledWith("https://api.fabric.microsoft.com/.default");
  });

  it.each(["Failed", "Cancelled", "Deduped"])("propagates terminal %s and its failure reason", async (status) => {
    acceptJob();
    fetchMock.mockResolvedValueOnce(Response.json({ status, failureReason: { errorCode: "UserAccessTokenException" } }));

    await expect(runner.run({ environment: "dev" })).rejects.toThrow(`status '${status}': {"errorCode":"UserAccessTokenException"}`);
  });

  it("honors the scheduler Retry-After before polling", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202, headers: { Location: pollUri, "Retry-After": "60" } }));
    fetchMock.mockResolvedValueOnce(Response.json({ id: "job-1", status: "Completed" }));
    const completion = runner.run({ environment: "dev" });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await completion).status).toBe("completed");
  });

  it("fails rather than waiting forever for an unfinished job", async () => {
    acceptJob();
    fetchMock.mockImplementation(async () => Response.json({ status: "InProgress" }));
    const completion = expect(runner.run({ environment: "dev" })).rejects.toThrow("Timed out after 900s");

    await vi.advanceTimersByTimeAsync(900_000);
    await completion;
  });

  it("fails on missing or unknown job status", async () => {
    acceptJob();
    fetchMock.mockResolvedValueOnce(Response.json({ id: "job-1" }));

    await expect(runner.run({ environment: "dev" })).rejects.toThrow("unrecognized status");
  });

  it("fails when the scheduler rejects submission", async () => {
    fetchMock.mockResolvedValueOnce(new Response("InsufficientPrivileges", { status: 403 }));
    await expect(runner.run({ environment: "dev" })).rejects.toThrow("HTTP 403: InsufficientPrivileges");
  });

  it("requires a polling location after acceptance", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await expect(runner.run({ environment: "dev" })).rejects.toThrow("Location header");
  });

  it("does not treat a polling error as a completed load", async () => {
    acceptJob();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(runner.run({ environment: "dev" })).rejects.toThrow("poll Fabric notebook job status: HTTP 403");
  });

  it("discovers the notebook on a later item page when its id is not configured", async () => {
    vi.stubEnv("LOAD_HISTORY_NOTEBOOK_ITEM_ID", "");
    const nextPage = `https://api.fabric.microsoft.com/v1/workspaces/${workspaceId}/items?continuationToken=next`;
    fetchMock.mockResolvedValueOnce(Response.json({ value: [], continuationUri: nextPage }));
    fetchMock.mockResolvedValueOnce(Response.json({ value: [{ id: notebookId, type: "Notebook", displayName: "triatwin-dev-load-history-to-tables" }] }));
    acceptJob();
    fetchMock.mockResolvedValueOnce(Response.json({ id: "job-1", status: "Completed" }));

    expect((await runner.run({ environment: "dev" })).notebookId).toBe(notebookId);
    expect(fetchMock).toHaveBeenNthCalledWith(2, nextPage, expect.any(Object));
  });
});
