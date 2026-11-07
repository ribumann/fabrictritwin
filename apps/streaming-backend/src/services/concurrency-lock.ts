export type LiveSimulationKind = "session" | "race";

export interface LiveSimulationLock {
  runId: string;
  athleteId: string;
  kind: LiveSimulationKind;
}

export type LiveSimulationAcquireResult =
  | {
      acquired: true;
      lock: LiveSimulationLock;
    }
  | {
      acquired: false;
      currentLock: LiveSimulationLock;
    };

export class GlobalConcurrencyLock {
  private currentLock: LiveSimulationLock | undefined;

  tryAcquire(lock: LiveSimulationLock): LiveSimulationAcquireResult {
    if (this.currentLock) {
      return {
        acquired: false,
        currentLock: { ...this.currentLock },
      };
    }

    this.currentLock = { ...lock };
    return {
      acquired: true,
      lock: { ...lock },
    };
  }

  release(runId: string): boolean {
    if (!this.currentLock || this.currentLock.runId !== runId) {
      return false;
    }

    this.currentLock = undefined;
    return true;
  }

  getCurrentLock(): LiveSimulationLock | undefined {
    return this.currentLock ? { ...this.currentLock } : undefined;
  }

  resetForTests(): void {
    this.currentLock = undefined;
  }
}

export const globalConcurrencyLock = new GlobalConcurrencyLock();
