import assert from "node:assert/strict";
import test from "node:test";

import { createHostTerminalSession } from "./sessionFactories.ts";
import { createLocalTerminalSession } from "./sessionFactories.ts";
import { resolveTerminalSessionHost } from "../../domain/terminalHostResolution";
import type { Host } from "../../domain/models";

const localVaultHost = (overrides: Partial<Host> = {}): Host => ({
  id: "local-vault-1",
  label: "Project A CMD",
  hostname: "localhost",
  username: "",
  group: "Projects/A",
  tags: ["local"],
  os: "linux",
  protocol: "local",
  createdAt: 0,
  ...overrides,
});

test("createHostTerminalSession copies local shell fields for local vault hosts", () => {
  const host = localVaultHost({
    localShell: "wsl-ubuntu",
    localShellArgs: ["--cd", "/work"],
    localShellName: "Ubuntu (WSL)",
    localShellIcon: "ubuntu",
    localStartDir: "/work",
  });
  const session = createHostTerminalSession("session-1", host);

  assert.equal(session.protocol, "local");
  assert.equal(session.hostId, "local-vault-1");
  assert.equal(session.localShell, "wsl-ubuntu");
  assert.deepEqual(session.localShellArgs, ["--cd", "/work"]);
  assert.equal(session.localShellName, "Ubuntu (WSL)");
  assert.equal(session.localShellIcon, "ubuntu");
  assert.equal(session.localStartDir, "/work");
});

test("createHostTerminalSession does not add local shell fields to SSH hosts", () => {
  const host: Host = {
    ...localVaultHost({ protocol: "ssh", hostname: "example.com", port: 22 }),
  } as Host;
  const session = createHostTerminalSession("session-2", host);

  assert.equal(session.protocol, "ssh");
  assert.equal(session.localShell, undefined);
  assert.equal(session.localShellName, undefined);
  assert.equal(session.shellType, undefined);
});

test("createHostTerminalSession classifies the shell for CMD/PowerShell local vault hosts", () => {
  const cmd = createHostTerminalSession("session-cmd", localVaultHost({ localShell: "cmd", os: "windows" }));
  assert.equal(cmd.shellType, "cmd");

  const pwsh = createHostTerminalSession("session-pwsh", localVaultHost({ localShell: "pwsh", os: "windows" }));
  assert.equal(pwsh.shellType, "powershell");

  // Discovered shell IDs persisted by the local-shell editor are not
  // executable basenames, but they still resolve to POSIX shells at spawn
  // time — WSL distros, Git Bash, and Cygwin all run a POSIX shell.
  const wslId = createHostTerminalSession("session-wsl-id", localVaultHost({ localShell: "wsl-ubuntu", os: "windows" }));
  assert.equal(wslId.shellType, "posix");

  const gitBash = createHostTerminalSession("session-git-bash", localVaultHost({ localShell: "git-bash", os: "windows" }));
  assert.equal(gitBash.shellType, "posix");

  const cygwin = createHostTerminalSession("session-cygwin", localVaultHost({ localShell: "cygwin", os: "windows" }));
  assert.equal(cygwin.shellType, "posix");

  // Unix discovery emits disambiguated path-slug IDs when multiple
  // installations share a basename (e.g. /bin/bash vs
  // /opt/homebrew/bin/bash); the backend launches the resolved command, so
  // the session must classify as that command's shell type, not "unknown".
  const slugBash = createHostTerminalSession("session-slug-bash", localVaultHost({ localShell: "bin-bash", os: "macos" }));
  assert.equal(slugBash.shellType, "posix");

  const slugHomebrewBash = createHostTerminalSession(
    "session-slug-homebrew",
    localVaultHost({ localShell: "opt-homebrew-bin-bash", os: "macos" }),
  );
  assert.equal(slugHomebrewBash.shellType, "posix");

  const customPowershellPath = createHostTerminalSession(
    "session-pwsh-path",
    localVaultHost({ localShell: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", os: "windows" }),
  );
  assert.equal(customPowershellPath.shellType, "powershell");

  // Default-shell hosts classify by the saved host OS, like ordinary
  // local-terminal creation classifies by the resolved shell.
  const windowsDefault = createHostTerminalSession("session-win-default", localVaultHost({ os: "windows" }));
  assert.equal(windowsDefault.shellType, "powershell");

  const posixDefault = createHostTerminalSession("session-posix-default", localVaultHost({ os: "linux" }));
  assert.equal(posixDefault.shellType, "posix");

  const unknownCustom = createHostTerminalSession(
    "session-unknown",
    localVaultHost({ localShell: "/usr/local/bin/exotic-shell", os: "linux" }),
  );
  assert.equal(unknownCustom.shellType, "unknown");
});

test("createLocalTerminalSession is unaffected by vault local hosts", () => {
  const session = createLocalTerminalSession("session-3", { shellName: "CMD" });
  assert.equal(session.hostId, "local-terminal");
  assert.equal(session.localShellName, "CMD");
});

test("createHostTerminalSession snapshots an explicit no-args local shell as an empty array", () => {
  // Legacy vault hosts can predate localShellArgs, so the field may be
  // absent on the Host; the session snapshot must still distinguish
  // "launched with no args" ([]) from "no metadata" (undefined).
  const host = localVaultHost({
    localShell: "cmd",
    localShellName: "Command Prompt",
    os: "windows",
  });
  const session = createHostTerminalSession("session-noargs", host);

  assert.ok(Array.isArray(session.localShellArgs), "args snapshot must be present");
  assert.deepEqual(session.localShellArgs, []);
});

test("resolveTerminalSessionHost does not merge edited host args into a no-args local snapshot", () => {
  const launchTimeHost = localVaultHost({
    localShell: "cmd",
    localShellName: "Command Prompt",
    os: "windows",
  });
  const session = createHostTerminalSession("session-1", launchTimeHost);

  // The saved host was later edited to a shell with args; the snapshot taken
  // at launch time must win so the clone relaunches CMD, not WSL.
  const editedHost: Host = {
    ...launchTimeHost,
    label: "Edited WSL",
    localShell: "wsl-ubuntu",
    localShellArgs: ["--cd", "/elsewhere"],
    localShellName: "Ubuntu (WSL)",
    localStartDir: "/elsewhere",
  };

  const resolved = resolveTerminalSessionHost({
    session,
    hosts: [editedHost],
    groupConfigs: [],
    proxyProfiles: [],
    localOs: "windows",
  });

  assert.equal(resolved.localShell, "cmd");
  assert.deepEqual(resolved.localShellArgs, []);
  assert.equal(resolved.localShellName, "Command Prompt");
});
