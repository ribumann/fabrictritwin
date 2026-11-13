import { Readable } from "node:stream";
import { CredentialUnavailableError } from "@azure/identity";
import { BlobServiceClient, type BlobDownloadResponseParsed } from "@azure/storage-blob";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobMiningStore, configuredMiningStore } from "../src/mining/blob-store.js";

// Transport metadata is unused by the adapter; keep SDK method mocks typed.
const transport = { _response: {} as BlobDownloadResponseParsed["_response"] };
const leaseResponse = {
  leaseId: "fence",
  _response: { ...transport._response, parsedHeaders: {} },
};

function fixture() {
  const service = new BlobServiceClient("https://example.blob.core.windows.net");
  const container = service.getContainerClient("mining-state-test");
  const blob = container.getBlockBlobClient("test.json");
  const lease = blob.getBlobLeaseClient("11111111-1111-4111-8111-111111111111");
  vi.spyOn(container, "getBlockBlobClient").mockReturnValue(blob);
  vi.spyOn(container, "getBlobClient").mockReturnValue(blob);
  vi.spyOn(blob, "getBlobLeaseClient").mockReturnValue(lease);
  return { store: new BlobMiningStore(container), blob, lease };
}

afterEach(() => vi.restoreAllMocks());

describe("mining Blob adapter", () => {
  it("uses a finite 60s lease, proposed fence ID, conditional create and fenced ETag writes", async () => {
    const { store, blob, lease } = fixture();
    const upload = vi.spyOn(blob, "uploadData").mockResolvedValue({ ...transport, etag: '"next"' });
    const acquire = vi.spyOn(lease, "acquireLease").mockResolvedValue(leaseResponse);
    const renew = vi.spyOn(lease, "renewLease").mockResolvedValue(leaseResponse);
    const release = vi.spyOn(lease, "releaseLease").mockResolvedValue(leaseResponse);
    expect(await store.create("test.json", { version: 1 })).toBe(true);
    expect(upload.mock.calls[0][1]?.conditions).toEqual({ ifNoneMatch: "*" });
    expect(await store.acquire("test.json", "fence")).toBe(true);
    expect(blob.getBlobLeaseClient).toHaveBeenCalledWith("fence");
    expect(acquire).toHaveBeenCalledWith(60);
    expect(await store.write("test.json", { version: 1 }, '"old"', "fence")).toBe('"next"');
    expect(upload.mock.calls[1][1]?.conditions).toEqual({ ifMatch: '"old"', leaseId: "fence" });
    await store.renew("test.json", "fence");
    await store.release("test.json", "fence");
    expect(renew).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("reads JSON with the ETag and service lease state; only BlobNotFound is absent", async () => {
    const { store, blob } = fixture();
    const download = vi.spyOn(blob, "download").mockResolvedValue({
      ...transport,
      etag: '"one"',
      leaseState: "leased",
      readableStreamBody: Readable.from(['{"version":1}']),
    });
    expect(await store.read("test.json")).toEqual({
      value: { version: 1 },
      etag: '"one"',
      leased: true,
    });
    download.mockRejectedValueOnce({ code: "BlobNotFound", statusCode: 404 });
    expect(await store.read("test.json")).toBeUndefined();
    download.mockRejectedValueOnce({ code: "ContainerNotFound", statusCode: 404 });
    await expect(store.read("test.json")).rejects.toMatchObject({ code: "prerequisite" });
    download.mockRejectedValueOnce({ statusCode: 404 });
    await expect(store.read("test.json")).rejects.toMatchObject({ code: "storage" });
  });

  it("distinguishes expected admission conflicts from conditional fencing failures", async () => {
    const { store, blob, lease } = fixture();
    vi.spyOn(blob, "uploadData").mockRejectedValue({ code: "ConditionNotMet", statusCode: 412 });
    expect(await store.create("test.json", {})).toBe(false);
    await expect(store.write("test.json", {}, '"stale"', "stale")).rejects.toMatchObject({
      code: "lease_lost",
    });
    const acquire = vi
      .spyOn(lease, "acquireLease")
      .mockRejectedValue({ code: "LeaseAlreadyPresent", statusCode: 409 });
    expect(await store.acquire("test.json", "other")).toBe(false);
    acquire.mockRejectedValueOnce({ code: "OtherConflict", statusCode: 409 });
    await expect(store.acquire("test.json", "other")).rejects.toMatchObject({ code: "uncertain" });
    vi.spyOn(lease, "renewLease").mockRejectedValue({
      code: "LeaseIdMismatchWithLeaseOperation",
      statusCode: 412,
    });
    await expect(store.renew("test.json", "other")).rejects.toMatchObject({ code: "lease_lost" });
  });

  it.each(["AuthorizationPermissionMismatch", "AuthorizationFailure", "AuthenticationFailed"])(
    "reports %s as a missing identity permission, never absence/contention",
    async (code) => {
      const { store, blob, lease } = fixture();
      vi.spyOn(blob, "download").mockRejectedValue({ code, statusCode: 403 });
      vi.spyOn(blob, "uploadData").mockRejectedValue({ code, statusCode: 403 });
      vi.spyOn(lease, "acquireLease").mockRejectedValue({ code, statusCode: 403 });
      await expect(store.read("test.json")).rejects.toMatchObject({ code: "unauthorized" });
      await expect(store.create("test.json", {})).rejects.toMatchObject({ code: "unauthorized" });
      await expect(store.acquire("test.json", "id")).rejects.toMatchObject({
        code: "unauthorized",
      });
    },
  );

  it("reports network write/acquisition failures as uncertain and reads as failed", async () => {
    const { store, blob, lease } = fixture();
    vi.spyOn(blob, "download").mockRejectedValue(new Error("network"));
    vi.spyOn(blob, "uploadData").mockRejectedValue(new Error("network"));
    vi.spyOn(lease, "acquireLease").mockRejectedValue(new Error("network"));
    await expect(store.read("test.json")).rejects.toMatchObject({ code: "storage" });
    await expect(store.write("test.json", {}, "etag", "id")).rejects.toMatchObject({
      code: "uncertain",
    });

    await expect(store.acquire("test.json", "id")).rejects.toMatchObject({ code: "uncertain" });
  });

  it("reports unavailable managed identity as an explicit prerequisite", async () => {
    const { store, blob } = fixture();
    vi.spyOn(blob, "uploadData").mockRejectedValue(
      new CredentialUnavailableError("No MI endpoint"),
    );
    await expect(store.create("test.json", {})).rejects.toMatchObject({
      code: "prerequisite",
      message: expect.stringContaining("managed identity"),
    });
  });

  it("rejects malformed, oversized or incomplete documents explicitly", async () => {
    const { store, blob } = fixture();
    const download = vi.spyOn(blob, "download");
    download.mockResolvedValueOnce({
      ...transport,
      etag: "one",
      readableStreamBody: Readable.from(["bad json"]),
    });
    await expect(store.read("test.json")).rejects.toMatchObject({ code: "storage" });
    download.mockResolvedValueOnce({
      ...transport,
      etag: "one",
      readableStreamBody: Readable.from([" ".repeat(16385)]),
    });
    await expect(store.read("test.json")).rejects.toMatchObject({ code: "storage" });
    download.mockResolvedValueOnce({ ...transport, readableStreamBody: Readable.from(["{}"]) });
    await expect(store.read("test.json")).rejects.toMatchObject({ code: "storage" });
  });
});

describe("mining opt-in configuration", () => {
  const enabled = {
    MINING_RUN_COORDINATION_ENABLED: "true",
    MINING_STATE_BLOB_ENDPOINT: "https://example.blob.core.windows.net/",
    MINING_STATE_CONTAINER: "mining-state-test",
  };
  it("does not construct storage or start work by default, independent of DEMO_PROFILE", () => {
    expect(configuredMiningStore({})).toBeUndefined();
    expect(configuredMiningStore({ DEMO_PROFILE: "synthetic" })).toBeUndefined();
    expect(configuredMiningStore({ MINING_RUN_COORDINATION_ENABLED: "false" })).toBeUndefined();
  });
  it("fails closed on absent or malformed opt-in prerequisites", () => {
    for (const env of [
      { MINING_RUN_COORDINATION_ENABLED: "yes" },
      { MINING_RUN_COORDINATION_ENABLED: "true" },
      { ...enabled, MINING_STATE_BLOB_ENDPOINT: "invalid" },
      { ...enabled, MINING_STATE_BLOB_ENDPOINT: "http://example.blob.core.windows.net/" },
      {
        ...enabled,
        MINING_STATE_BLOB_ENDPOINT: "https://example.blob.core.windows.net/?sig=secret",
      },
      { ...enabled, MINING_STATE_BLOB_ENDPOINT: "https://example.blob.core.windows.net/tokens" },
      { ...enabled, MINING_STATE_BLOB_ENDPOINT: "https://example.com/" },
      { ...enabled, MINING_STATE_CONTAINER: "token-store" },
    ]) {
      expect(() => configuredMiningStore(env)).toThrowError(
        expect.objectContaining({ code: "configuration" }),
      );
    }
  });
  it("constructs an MI-only client without any network calls or provisioning", () => {
    expect(configuredMiningStore(enabled)).toBeInstanceOf(BlobMiningStore);
  });
});
