import { CredentialUnavailableError, ManagedIdentityCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { MiningCoordinationError, type MiningStore, type StoredDocument } from "./store.js";

function storageCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function failure(error: unknown, operation: string): MiningCoordinationError {
  const code = storageCode(error);
  if (error instanceof CredentialUnavailableError) {
    return new MiningCoordinationError(
      "prerequisite",
      "Mining requires the configured managed identity to be available on the backend host.",
      { cause: error },
    );
  }
  if (code === "ContainerNotFound") {
    return new MiningCoordinationError(
      "prerequisite",
      "The dedicated mining-state container must be provisioned by an authorized operator.",
      { cause: error },
    );
  }
  if (
    code === "AuthorizationPermissionMismatch" ||
    code === "AuthorizationFailure" ||
    code === "AuthenticationFailed"
  ) {
    return new MiningCoordinationError(
      "unauthorized",
      "Mining managed identity requires container-scoped Blob data and lease permissions.",
      { cause: error },
    );
  }
  if (
    code === "LeaseIdMismatchWithBlobOperation" ||
    code === "LeaseIdMismatchWithLeaseOperation" ||
    code === "LeaseNotPresentWithBlobOperation" ||
    code === "LeaseNotPresentWithLeaseOperation" ||
    code === "LeaseLost" ||
    code === "ConditionNotMet"
  ) {
    return new MiningCoordinationError("lease_lost", `Mining ${operation} lost its fence.`, {
      cause: error,
    });
  }
  return new MiningCoordinationError(
    operation === "read" ? "storage" : "uncertain",
    `Mining storage ${operation} failed; reconcile by request/run ID before any retry.`,
    { cause: error },
  );
}

export class BlobMiningStore implements MiningStore {
  constructor(private readonly container: ContainerClient) {}

  async read(path: string, signal?: AbortSignal): Promise<StoredDocument | undefined> {
    try {
      if (signal?.aborted) throw new MiningCoordinationError("cancelled", "Mining read cancelled.");
      const response = await this.container
        .getBlockBlobClient(path)
        .download(0, undefined, { abortSignal: signal });
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (!response.readableStreamBody || !response.etag) {
        response.readableStreamBody?.destroy();
        throw new Error("Missing mining document body or ETag.");
      }
      const stream = response.readableStreamBody;
      const cancel = () =>
        stream.destroy(new MiningCoordinationError("cancelled", "Mining read cancelled."));
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (signal?.aborted) {
          stream.destroy();
          throw new MiningCoordinationError("cancelled", "Mining read cancelled.");
        }
        for await (const chunk of stream) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 16_384) throw new Error("Mining document exceeds 16 KiB.");
          chunks.push(buffer);
        }
        if (signal?.aborted)
          throw new MiningCoordinationError("cancelled", "Mining read cancelled.");
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      return {
        value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        etag: response.etag,
        leased: response.leaseState === "leased",
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new MiningCoordinationError("cancelled", "Mining read cancelled.", { cause: error });
      }
      if (storageCode(error) === "BlobNotFound") return undefined;
      throw failure(error, "read");
    }
  }

  async create(path: string, value: unknown): Promise<boolean> {
    try {
      await this.container.getBlockBlobClient(path).uploadData(Buffer.from(JSON.stringify(value)), {
        conditions: { ifNoneMatch: "*" },
        blobHTTPHeaders: { blobContentType: "application/json" },
      });
      return true;
    } catch (error) {
      if (
        ["BlobAlreadyExists", "ConditionNotMet", "LeaseIdMissing"].includes(
          storageCode(error) ?? "",
        )
      )
        return false;
      throw failure(error, "create");
    }
  }

  async write(path: string, value: unknown, etag: string, leaseId?: string): Promise<string> {
    try {
      const result = await this.container
        .getBlockBlobClient(path)
        .uploadData(Buffer.from(JSON.stringify(value)), {
          conditions: { ifMatch: etag, leaseId },
          blobHTTPHeaders: { blobContentType: "application/json" },
        });
      if (!result.etag) throw new Error("Mining write returned no ETag.");
      return result.etag;
    } catch (error) {
      throw failure(error, "write");
    }
  }

  async acquire(path: string, leaseId: string): Promise<boolean> {
    try {
      await this.container.getBlobClient(path).getBlobLeaseClient(leaseId).acquireLease(60);
      return true;
    } catch (error) {
      if (storageCode(error) === "LeaseAlreadyPresent") return false;
      throw failure(error, "acquire");
    }
  }

  async renew(path: string, leaseId: string): Promise<void> {
    try {
      await this.container.getBlobClient(path).getBlobLeaseClient(leaseId).renewLease();
    } catch (error) {
      throw failure(error, "renew");
    }
  }

  async release(path: string, leaseId: string): Promise<void> {
    try {
      await this.container.getBlobClient(path).getBlobLeaseClient(leaseId).releaseLease();
    } catch (error) {
      throw failure(error, "release");
    }
  }
}

/** Opt-in only. Does not connect, provision containers, or use developer/key credentials. */
export function configuredMiningStore(
  env: NodeJS.ProcessEnv = process.env,
): BlobMiningStore | undefined {
  if (
    env.MINING_RUN_COORDINATION_ENABLED === undefined ||
    env.MINING_RUN_COORDINATION_ENABLED === "false"
  ) {
    return undefined;
  }
  if (env.MINING_RUN_COORDINATION_ENABLED !== "true") {
    throw new MiningCoordinationError(
      "configuration",
      "MINING_RUN_COORDINATION_ENABLED must be true or false.",
    );
  }
  const endpoint = env.MINING_STATE_BLOB_ENDPOINT;
  const container = env.MINING_STATE_CONTAINER;
  if (!endpoint || !container) {
    throw new MiningCoordinationError(
      "configuration",
      "Mining requires MINING_STATE_BLOB_ENDPOINT and a dedicated MINING_STATE_CONTAINER; no fallback is permitted.",
    );
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new MiningCoordinationError(
      "configuration",
      "MINING_STATE_BLOB_ENDPOINT must be an Azure Blob account root URL.",
      { cause: error },
    );
  }
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    url.port ||
    !/^mining-state(?:-[a-z0-9]+)*$/.test(container) ||
    container.length > 63
  ) {
    throw new MiningCoordinationError(
      "configuration",
      "Mining requires an HTTPS Azure Blob account root without credentials and a private mining-state[-suffix] container.",
    );
  }
  const credential = new ManagedIdentityCredential(
    env.MINING_MANAGED_IDENTITY_CLIENT_ID
      ? { clientId: env.MINING_MANAGED_IDENTITY_CLIENT_ID }
      : {},
  );
  const service = new BlobServiceClient(endpoint, credential, {
    retryOptions: { maxTries: 1, tryTimeoutInMs: 10_000 },
  });
  return new BlobMiningStore(service.getContainerClient(container));
}
