const commandSubmissionListeners = new Map<string, (data: string) => void>();

export function registerTerminalCommandSubmissionListener(
  sessionId: string,
  listener: (data: string) => void,
): () => void {
  commandSubmissionListeners.set(sessionId, listener);
  return () => {
    if (commandSubmissionListeners.get(sessionId) === listener) {
      commandSubmissionListeners.delete(sessionId);
    }
  };
}

/** Invalidate command-relative UI before typed or programmatic input is sent. */
export function notifyTerminalCommandSubmission(sessionId: string, data: string): void {
  if (/[\r\n]/u.test(data)) commandSubmissionListeners.get(sessionId)?.(data);
}

