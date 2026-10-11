import type { ProviderValidationIssue } from "@netcatty/plugin-contract";

export type TerminalSessionExitEvent = {
  exitCode?: number;
  signal?: number;
  error?: string;
  reason?: "exited" | "error" | "timeout" | "closed";
  // True when the remote closed the channel without sending exit-status or
  // exit-signal (#3591): no numeric exit code exists, and the renderer shows
  // a distinct message instead of a misleading "code 0".
  remoteClosedWithoutExitStatus?: boolean;
  diagnostics?: ReadonlyArray<ProviderValidationIssue>;
};

export function formatSessionClosedExitMessage(evt: TerminalSessionExitEvent): string {
  if (evt?.remoteClosedWithoutExitStatus) {
    return "\r\n[session closed by remote (no exit status)]";
  }
  // reason "error" is an abnormal teardown on our side (transport failure,
  // terminal worker exit) (#3631): the error text is surfaced separately as
  // the session error, and any exit code carried along belongs to that
  // infrastructure failure — printing it would read like a clean remote exit
  // ("session closed (code 0)"), exactly the misreport #3591 removed for
  // peer-initiated channel closes.
  if (evt?.reason === "error") {
    return "\r\n[session closed unexpectedly]";
  }
  return `\r\n[session closed${evt?.exitCode !== undefined ? ` (code ${evt.exitCode})` : ""}]`;
}

export type TerminalSessionExitIntent =
  | { kind: "closeSession" }
  | { kind: "markDisconnected" };

type TerminalPopupExitOptions = {
  autoCloseOnExit?: boolean;
  isAttachMode?: boolean;
};

function isConfirmedCleanExit(evt: TerminalSessionExitEvent): boolean {
  return evt.reason === "exited" && evt.exitCode === 0;
}

export function resolveTerminalSessionExitIntent(
  evt: TerminalSessionExitEvent,
  autoCloseOnExit = true,
): TerminalSessionExitIntent {
  if (autoCloseOnExit && isConfirmedCleanExit(evt)) {
    return { kind: "closeSession" };
  }

  // Non-zero or unknown exits, timeouts, transport errors, and channel closes
  // should keep the tab visible so the user can inspect output and reconnect.
  return { kind: "markDisconnected" };
}

export function shouldCloseTerminalPopupOnExit(
  evt: TerminalSessionExitEvent,
  options: TerminalPopupExitOptions = {},
): boolean {
  if (options.autoCloseOnExit === false) return false;
  return options.isAttachMode === true || isConfirmedCleanExit(evt);
}

export function shouldRevealTerminalPopupOnExit(
  _evt: TerminalSessionExitEvent,
  options: TerminalPopupExitOptions = {},
): boolean {
  return options.autoCloseOnExit === false &&
    options.isAttachMode !== true;
}
