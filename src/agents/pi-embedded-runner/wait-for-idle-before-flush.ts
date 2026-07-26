type IdleAwareAgent = {
  waitForIdle?: (() => Promise<void>) | undefined;
};

type ToolResultFlushManager = {
  flushPendingToolResults?: (() => void) | undefined;
  clearPendingToolResults?: (() => void) | undefined;
};

export const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30_000;

async function waitForPromiseBestEffort(
  waitForPromise: (() => Promise<void>) | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!waitForPromise) {
    return false;
  }

  const resolved = Symbol("resolved");
  const timedOut = Symbol("timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      waitForPromise().then(() => resolved),
      new Promise<symbol>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
        timeoutHandle.unref?.();
      }),
    ]);
    return outcome === timedOut;
  } catch {
    // Best-effort during cleanup.
    return false;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

export async function flushPendingToolResultsAfterIdle(opts: {
  agent: IdleAwareAgent | null | undefined;
  sessionManager: ToolResultFlushManager | null | undefined;
  waitForEventDrain?: () => Promise<void>;
  timeoutMs?: number;
  clearPendingOnTimeout?: boolean;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS;
  const waitForIdle = opts.agent?.waitForIdle;
  let timedOut = await waitForPromiseBestEffort(
    typeof waitForIdle === "function" ? () => waitForIdle.call(opts.agent) : undefined,
    timeoutMs,
  );
  if (!timedOut) {
    timedOut = await waitForPromiseBestEffort(opts.waitForEventDrain, timeoutMs);
  }
  const runFlushAction = (action: (() => void) | undefined) => {
    if (!action) {
      return;
    }
    try {
      action();
    } catch (error) {
      try {
        opts.onError?.(error);
      } catch {
        // Cleanup remains best-effort even if its observer fails.
      }
    }
  };
  if (timedOut && opts.clearPendingOnTimeout && opts.sessionManager?.clearPendingToolResults) {
    runFlushAction(() => opts.sessionManager?.clearPendingToolResults?.());
    return;
  }
  runFlushAction(() => opts.sessionManager?.flushPendingToolResults?.());
}
