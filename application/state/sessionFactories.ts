import type { Host, SerialConfig, TerminalSession } from "../../domain/models";
import { classifyLocalShellType } from "../../lib/localShell";

export interface LocalTerminalOptions {
  shellType?: TerminalSession["shellType"];
  shell?: string;
  shellArgs?: string[];
  shellName?: string;
  shellIcon?: string;
  localStartDir?: string;
}

/**
 * Stable hostId for all Local Terminal sessions.
 *
 * Autocomplete command history is keyed by hostId. Using `local-${sessionId}`
 * made every new Local Terminal look like a brand-new host, so history
 * suggestions never accumulated across opens (issue #2037).
 */
export const LOCAL_TERMINAL_HOST_ID = "local-terminal";

/**
 * Shared empty-array identity for local-shell args snapshots.
 *
 * TerminalSession.localShellArgs is optional, so an `undefined` snapshot is
 * ambiguous: it can mean "launched with no args" or "legacy session saved
 * before args were recorded". Snapshotting an explicit no-args launch as `[]`
 * lets the popup/clone host resolution (`overlaySessionLocalShell`) preserve
 * the session's actual spawn args instead of merging them with args from an
 * edited host. One module-level array keeps reference-identity comparisons
 * (e.g. terminalPaneSessionsEqual) treating equal no-args snapshots as equal.
 */
const EMPTY_LOCAL_SHELL_ARGS: string[] = [];

/**
 * Platform string describing the machine that is launching the session.
 *
 * Vault local hosts can be synced/imported from another OS, so their saved
 * `host.os` describes the source machine. When the host has no explicit
 * shell (`localShell` empty), `startLocalSession` spawns the current
 * machine's OS default shell, so classification must fall back to the
 * runtime platform — not the persisted host OS — or a Windows host opened
 * on Linux would be tagged "powershell" while Bash actually runs.
 */
const runtimePlatformLike = (): string | undefined => {
  if (typeof navigator === "undefined") return undefined;
  return navigator.userAgent || navigator.platform || undefined;
};

export const createLocalTerminalSession = (
  sessionId: string,
  options?: LocalTerminalOptions,
): TerminalSession => ({
  id: sessionId,
  hostId: LOCAL_TERMINAL_HOST_ID,
  hostLabel: options?.shellName || "Local Terminal",
  hostname: "localhost",
  username: "local",
  status: "connecting",
  protocol: "local",
  shellType: options?.shellType,
  localShell: options?.shell,
  localShellArgs: options?.shellArgs,
  localShellName: options?.shellName,
  localShellIcon: options?.shellIcon,
  localStartDir: options?.localStartDir,
});

export const snapshotSerialConfig = (
  config: SerialConfig,
  legacyBackspaceBehavior?: Host["backspaceBehavior"],
): SerialConfig => ({
  ...config,
  backspaceBehavior: config.backspaceBehavior
    ?? (legacyBackspaceBehavior === "ctrl-h" ? "ctrl-h" : "default"),
});

export const createSerialTerminalSession = (
  sessionId: string,
  config: SerialConfig,
  options?: { charset?: string },
): TerminalSession => {
  const serialConfig = snapshotSerialConfig(config);
  const portName = serialConfig.path.split("/").pop() || serialConfig.path;
  return {
    id: sessionId,
    hostId: `serial-${sessionId}`,
    hostLabel: `Serial: ${portName}`,
    hostname: serialConfig.path,
    username: "",
    status: "connecting",
    protocol: "serial",
    serialConfig,
    charset: options?.charset,
  };
};

export const createHostTerminalSession = (
  sessionId: string,
  host: Host,
): TerminalSession => {
  if (host.protocol === "serial") {
    const serialConfig = snapshotSerialConfig(
      host.serialConfig || {
        path: host.hostname,
        baudRate: host.port || 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl: "none",
        localEcho: false,
        lineMode: false,
      },
      host.backspaceBehavior,
    );
    const portName = serialConfig.path.split("/").pop() || serialConfig.path;
    return {
      id: sessionId,
      hostId: host.id,
      hostLabel: host.label || `Serial: ${portName}`,
      hostname: serialConfig.path,
      username: "",
      status: "connecting",
      protocol: "serial",
      serialConfig,
      charset: host.charset,
    };
  }

  return {
    id: sessionId,
    hostId: host.id,
    hostLabel: host.label,
    hostname: host.hostname,
    username: host.username,
    status: "connecting",
    protocol: host.protocol,
    pluginConnection: host.pluginConnection == null
      ? undefined
      : structuredClone(host.pluginConnection),
    port: host.port,
    moshEnabled: host.moshEnabled,
    etEnabled: host.etEnabled,
    charset: host.charset,
    // Local-shell vault hosts carry the per-host shell selection into the
    // session (the bridge resolves discovered shell ids at spawn time).
    // shellType matches ordinary local-terminal creation so captured-CWD
    // restore can reject POSIX injection into CMD/PowerShell sessions.
    ...(host.protocol === "local" ? {
      // With an explicit shell the basename classifies it on any OS, so the
      // saved host.os stays the fallback; a default-shell host launches the
      // current machine's OS default, so classify against the runtime.
      shellType: classifyLocalShellType(
        host.localShell,
        host.localShell?.trim() ? host.os : runtimePlatformLike(),
      ),
      localShell: host.localShell,
      // Preserve field presence: an edited host must not contribute its args
      // to a session that was launched with an explicit shell and no args.
      localShellArgs: host.localShellArgs ?? EMPTY_LOCAL_SHELL_ARGS,
      localShellName: host.localShellName,
      localShellIcon: host.localShellIcon,
      localStartDir: host.localStartDir,
    } : {}),
    ...(host.ephemeral ? { ephemeralHost: true } : {}),
    ...(host.autoOpenSftpPanel ? { autoOpenSidePanel: "sftp" as const } : {}),
  };
};

export const createWorkspaceHostTerminalSession = (
  sessionId: string,
  host: Host,
  workspaceId: string,
): TerminalSession => ({
  ...createHostTerminalSession(sessionId, host),
  workspaceId,
});
