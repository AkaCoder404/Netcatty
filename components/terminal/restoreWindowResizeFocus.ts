import { hasOpenAppDialog } from "./focusTerminalSession";

/** Debounce so a continuous frame drag (or maximize transition) triggers one restore. */
export const WINDOW_RESIZE_RESTORE_FOCUS_DELAY_MS = 120;

export type MinimalWindow = {
  addEventListener?: (type: string, listener: () => void) => unknown;
  removeEventListener?: (type: string, listener: () => void) => unknown;
};

export type MinimalDocument = Parameters<typeof hasOpenAppDialog>[0] & {
  hasFocus?: () => boolean;
};

type AttachWindowResizeFocusRestoreOptions = {
  win?: MinimalWindow | null;
  doc?: MinimalDocument | null;
  refocus?: () => void;
  delayMs?: number;
  scheduleTimeout?: (callback: () => void, delay: number) => unknown;
  cancelTimeout?: (id: unknown) => void;
};

/**
 * #3647: dragging the OS window frame (or maximizing) leaves the active xterm
 * helper textarea unfocused, so keystrokes do nothing until the user clicks
 * back into the terminal. Attach a window `resize` listener that re-runs the
 * tab-change refocus path after the resize settles.
 *
 * Restore is skipped when the app window does not hold OS input focus, or when
 * a modal dialog is open, so the restore never steals typing from elsewhere.
 */
export const attachWindowResizeFocusRestore = (
  {
    win = typeof window !== "undefined" ? window : null,
    doc = typeof document !== "undefined" ? document : null,
    refocus,
    delayMs = WINDOW_RESIZE_RESTORE_FOCUS_DELAY_MS,
    scheduleTimeout = (callback: () => void, delay: number) => setTimeout(callback, delay),
    cancelTimeout = (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  }: AttachWindowResizeFocusRestoreOptions = {},
): (() => void) => {
  if (!win?.addEventListener || !win.removeEventListener || typeof refocus !== "function") {
    return () => {};
  }

  let timerId: unknown = null;
  const restoreFocus = () => {
    timerId = null;
    if (doc?.hasFocus?.() === false) return;
    if (hasOpenAppDialog(doc)) return;
    refocus();
  };
  const handleResize = () => {
    if (timerId !== null) {
      cancelTimeout(timerId);
    }
    timerId = scheduleTimeout(restoreFocus, delayMs);
  };

  win.addEventListener("resize", handleResize);
  return () => {
    win.removeEventListener("resize", handleResize);
    if (timerId !== null) {
      cancelTimeout(timerId);
      timerId = null;
    }
  };
};
