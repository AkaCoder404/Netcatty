import { hasOpenAppDialog } from "./focusTerminalSession";

/** Debounce so a continuous frame drag (or maximize transition) triggers one restore. */
export const WINDOW_RESIZE_RESTORE_FOCUS_DELAY_MS = 120;

export type MinimalWindow = {
  addEventListener?: (type: string, listener: () => void) => unknown;
  removeEventListener?: (type: string, listener: () => void) => unknown;
};

export type MinimalActiveElement = {
  tagName?: string | null;
  matches?: (selector: string) => boolean;
};

export type MinimalDocument = Parameters<typeof hasOpenAppDialog>[0] & {
  hasFocus?: () => boolean;
  activeElement?: MinimalActiveElement | null;
};

/**
 * True when a real DOM element other than the xterm helper textarea holds
 * keyboard focus — an editable field (search box, chat input, SFTP filter,
 * inline rename, ...) as well as non-editable interactive controls that are
 * keyboard-focusable (buttons, host-tree rows, resize separators, sliders).
 * Resize-driven restores must not yank focus away from any of them.
 * Focus parked on `body`/`html` (or an xterm helper textarea) does not count
 * as being held somewhere else, so the restore may proceed.
 */
export const hasActiveForeignFocusElement = (doc: MinimalDocument | null): boolean => {
  const element = doc?.activeElement;
  if (!element) return false;
  if (typeof element.matches === "function" && element.matches("textarea.xterm-helper-textarea")) {
    return false;
  }
  const tagName = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  return tagName !== "body" && tagName !== "html";
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
 * Restore is skipped when the app window does not hold OS input focus, when a
 * modal dialog is open, or when any element other than the xterm helper
 * textarea already holds focus (editable fields, but also keyboard-focusable
 * interactive controls such as buttons or sidebar rows), so the restore never
 * steals typing or keyboard-navigation position from elsewhere.
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
    // The window holds OS focus, but the user may still be typing in a
    // non-terminal field or navigating by keyboard (sidebar rows, buttons).
    // Never steal focus from an element that actually holds it.
    if (hasActiveForeignFocusElement(doc)) return;
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
