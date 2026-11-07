import { createDefaultSeedHistoryStore, type SeedHistoryStore } from "@triathlon-twin/simulator";

export interface SeededHistoryPreconditionChecker {
  hasSeededHistory(athleteId: string, environment: string): Promise<boolean>;
}

export class OneLakeSeededHistoryPreconditionChecker implements SeededHistoryPreconditionChecker {
  private resolvedStore: SeedHistoryStore | undefined;

  constructor(private readonly store?: SeedHistoryStore) {}

  private getStore(): SeedHistoryStore {
    if (!this.resolvedStore) {
      this.resolvedStore = this.store ?? createDefaultSeedHistoryStore();
    }

    return this.resolvedStore;
  }

  async hasSeededHistory(athleteId: string, environment: string): Promise<boolean> {
    return (await this.getStore().getExistingSeed(athleteId, environment)) !== null;
  }
}

export function createDefaultSeededHistoryPreconditionChecker(): SeededHistoryPreconditionChecker {
  return new OneLakeSeededHistoryPreconditionChecker();
}
