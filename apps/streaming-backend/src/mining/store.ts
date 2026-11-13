export class MiningCoordinationError extends Error {
  constructor(
    public readonly code:
      | "configuration"
      | "prerequisite"
      | "unauthorized"
      | "storage"
      | "uncertain"
      | "conflict"
      | "invalid"
      | "lease_lost"
      | "cancelled",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MiningCoordinationError";
  }
}

export interface StoredDocument {
  value: unknown;
  etag: string;
  leased: boolean;
}

/** All paths are relative to the dedicated, already-provisioned mining container. */
export interface MiningStore {
  read(path: string): Promise<StoredDocument | undefined>;
  create(path: string, value: unknown): Promise<boolean>;
  write(path: string, value: unknown, etag: string, leaseId?: string): Promise<string>;
  acquire(path: string, leaseId: string): Promise<boolean>;
  renew(path: string, leaseId: string): Promise<void>;
  release(path: string, leaseId: string): Promise<void>;
}
