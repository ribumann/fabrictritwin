export interface BackendShutdownOptions {
  closePublisher: () => Promise<void> | undefined;
  closeHttp: () => Promise<void>;
  stopBackgroundServices: () => void;
  terminateStreams: () => void;
}

export function createBackendShutdown(options: BackendShutdownOptions): () => Promise<void> {
  let closing: Promise<void> | undefined;

  return () => {
    if (closing) return closing;

    let resolveClosing!: () => void;
    let rejectClosing!: (cause: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      resolveClosing = resolve;
      rejectClosing = reject;
    });

    const failures: unknown[] = [];
    const operations: Promise<void>[] = [];
    const start = (operation: () => Promise<void> | undefined) => {
      try {
        const result = operation();
        if (result) operations.push(result);
      } catch (cause) {
        failures.push(cause);
      }
    };

    start(options.closePublisher);
    for (const stop of [options.stopBackgroundServices, options.terminateStreams]) {
      try {
        stop();
      } catch (cause) {
        failures.push(cause);
      }
    }
    start(options.closeHttp);

    void Promise.allSettled(operations).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (failures.length === 1) {
        rejectClosing(failures[0]);
      } else if (failures.length > 1) {
        rejectClosing(new AggregateError(failures, "Backend shutdown failed."));
      } else {
        resolveClosing();
      }
    });
    return closing;
  };
}
