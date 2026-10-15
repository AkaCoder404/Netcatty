const commandInjectionReadyReaders = new Map<string, () => boolean>();
const commandSubmissionListeners = new Map<string, () => void>();

export function registerTerminalCommandSubmissionListener(
  sessionId: string,
  listener: () => void,
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
  if (/[\r\n]/u.test(data)) commandSubmissionListeners.get(sessionId)?.();
}

export function registerTerminalCommandInjectionReadyReader(
  sessionId: string,
  reader: () => boolean,
): () => void {
  commandInjectionReadyReaders.set(sessionId, reader);
  return () => {
    if (commandInjectionReadyReaders.get(sessionId) === reader) {
      commandInjectionReadyReaders.delete(sessionId);
    }
  };
}

/** True when the live terminal reports an idle shell prompt ready for injection. */
export function isTerminalReadyForCommandInjection(sessionId: string): boolean {
  return commandInjectionReadyReaders.get(sessionId)?.() === true;
}
