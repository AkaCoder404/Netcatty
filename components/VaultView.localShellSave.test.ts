import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { upsertHostById } from "../domain/host";
import { saveWorkSurfaceHostDraft } from "../application/state/useWorkSurfaceHostEditor";
import { createLocalShellHost } from "../domain/localShellHost";
import type { Host } from "../types";

// Execute the actual Vault save callback with its persistence boundary stubbed.
const source = readFileSync(new URL("./VaultView.tsx", import.meta.url), "utf8");
const callback = source.match(/const handleSaveLocalShellHost = useCallback\((\(host: Host, connectNow\?: boolean\) => \{[\s\S]*?)\}, \[/)?.[1];
assert.ok(callback);
const compiled = ts.transpile(`const save = ${callback}};`, { target: ts.ScriptTarget.ES2022 });

for (const editing of [false, true]) {
  for (const connectNow of [false, true]) {
    test(`local shell save: editing=${editing}, connect=${connectNow}`, () => {
      const opened = createLocalShellHost({ id: "local-1", label: "old", tags: ["old"], notes: "clear me" });
      const latest = { ...opened, showLineTimestamps: true, lastConnectedAt: 42 };
      const draft = { ...opened, tags: ["edited"], notes: undefined };
      let saved: Host[] = [];
      let connected: Host | undefined;
      const save = new Function(
        "hosts", "editingLocalShellHost", "onUpdateHosts", "onConnect",
        "setIsLocalShellHostPanelOpen", "setEditingLocalShellHost",
        "upsertHostById", "saveWorkSurfaceHostDraft",
        `${compiled} return save;`,
      )(
        editing ? [latest] : [], editing ? opened : null,
        (hosts: Host[]) => { saved = hosts; }, (host: Host) => { connected = host; },
        () => {}, () => {}, upsertHostById, saveWorkSurfaceHostDraft,
      );
      save(draft, connectNow);
      assert.equal(saved.length, 1);
      assert.deepEqual(saved[0], editing ? { ...latest, tags: ["edited"], notes: undefined } : draft);
      assert.deepEqual(connected, connectNow ? saved[0] : undefined);
    });
  }
}
