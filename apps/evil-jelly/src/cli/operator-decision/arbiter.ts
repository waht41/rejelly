let decisionQueue: Promise<void> = Promise.resolve();

/** Serialize decision sessions because the terminal has one active decision surface. */
export function runDecisionSession<T>(operation: () => Promise<T>): Promise<T> {
  const previous = decisionQueue;
  let release!: () => void;
  decisionQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous.then(async () => {
    try {
      return await operation();
    } finally {
      release();
    }
  });
}

export function resetDecisionArbiter(): void {
  decisionQueue = Promise.resolve();
}
