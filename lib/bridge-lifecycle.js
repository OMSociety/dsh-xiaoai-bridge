/** Serialize bridge control operations; only adjacent equivalent requests share a result. */
export function createBridgeLifecycle({ launch, halt, cancelRetry, resetBudget, ensure }) {
  let tail = null;
  function run(kind, operation) {
    if (tail?.kind === kind) return tail.promise;
    const previous = tail?.promise ?? Promise.resolve();
    const entry = { kind };
    entry.promise = previous.then(operation, operation).finally(() => {
      if (tail === entry) tail = null;
    });
    tail = entry;
    return entry.promise;
  }

  function launchExplicitly() {
    cancelRetry();
    resetBudget();
    return launch();
  }
  return {
    start({ fromWatchdog = false } = {}) {
      return fromWatchdog ? run('retry', launch) : run('start', launchExplicitly);
    },
    ensureStarted() { return run('ensure', ensure); },
    stop() {
      cancelRetry();
      return run('stop', () => { cancelRetry(); return halt(); });
    },
    restart() {
      cancelRetry();
      return run('restart', async () => {
        cancelRetry();
        const stopped = await halt();
        return stopped.ok ? launchExplicitly() : stopped;
      });
    },
  };
}
