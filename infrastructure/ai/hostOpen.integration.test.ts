import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { Host, TerminalSession } from '../../domain/models';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useHostOpenSessionReuse } from '../../application/state/useHostOpenSessionReuse';
import { handleVaultAgentOp, type VaultAgentApiDeps } from './vaultAgentBridgeClient';

const require = createRequire(import.meta.url);
const { isolateCliDiscoveryFile } = require('../../electron/bridges/cliDiscoveryTestIsolation.cjs');
isolateCliDiscoveryFile();
const bridge = require('../../electron/bridges/mcpServerBridge.cjs');
const { registerMcpTools } = require('../../electron/capabilities/codegen/mcpToolRegistry.cjs');

test('MCP host_open forwards the schema input through RPC and vault service to the real renderer handler', async (t) => {
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode('auto');
  t.after(() => bridge.cleanup());
  const host: Host = { id: 'host-1', label: 'Host', hostname: 'example.invalid', username: 'user', protocol: 'ssh', os: 'linux', tags: [] };
  const tabs: TerminalSession[] = [{ id: 'existing', hostId: host.id, hostLabel: host.label, hostname: host.hostname, username: host.username, status: 'connecting' }];
  let finder: ReturnType<typeof useHostOpenSessionReuse>;
  let renderer: ReactTestRenderer;
  function Harness() {
    finder = useHostOpenSessionReuse({ sessions: [...tabs], hosts: [{ ...host }], keys: [], identities: [], resolveEffectiveHost: (value) => value });
    return null;
  }
  const render = async () => act(async () => {
    if (renderer) renderer.update(React.createElement(Harness));
    else renderer = create(React.createElement(Harness));
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  t.after(async () => act(async () => renderer.unmount()));
  await render();
  const deps = {
    getHosts: () => [host],
    resolveEffectiveHost: (value: Host) => value,
    findExistingSessionForHost: (hostId: string) => finder(hostId),
    openHost: (openedHost: Host) => {
      const sessionId = `new-${tabs.length}`;
      tabs.push({ ...tabs[0], id: sessionId, hostname: openedHost.hostname, username: openedHost.username });
      return { ok: true as const, sessionId, host };
    },
  } as unknown as VaultAgentApiDeps;
  bridge.setVaultAgentInvoker((op: string, params: Record<string, unknown>) => handleVaultAgentOp(op, params, deps));
  let openTool: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  let schema: { parse: (args: Record<string, unknown>) => Record<string, unknown> };
  registerMcpTools({
    tool(name: string, _description: string, shape: Record<string, unknown>, handler: typeof openTool) {
      if (name !== 'host_open') return;
      schema = require('zod').z.object(shape);
      openTool = handler;
    },
  }, {
    rpcCall: (method: string, params: Record<string, unknown>) => bridge.dispatchBuiltinRpc(method, params),
    scopeParams: { chatSessionId: 'integration-chat' },
    guardWriteOperation: () => null,
    catalogDescription: (_name: string, fallback: string) => fallback,
  });
  assert.ok(openTool);
  const run = async (args: Record<string, unknown>) => {
    await render();
    const response = await openTool!(schema.parse(args)) as { content: { text: string }[] };
    await render();
    return JSON.parse(response.content[0].text);
  };
  for (let index = 0; index < 3; index++) {
    const reused = await run({ hostId: host.id });
    assert.equal(reused.sessionId, 'existing');
    assert.equal(reused.reused, true);
  }
  assert.equal(tabs.length, 1);
  const fresh = await run({ hostId: host.id, newTab: 'true' });
  assert.equal(fresh.sessionId, 'new-1');
  assert.equal(tabs.length, 2);
  // An inactive tab requires a real open instead of an endless wait.
  for (const tab of tabs) tab.status = 'disconnected';
  const recovered = await run({ hostId: host.id, newTab: 'false' });
  assert.equal(recovered.sessionId, 'new-2');
  assert.equal(tabs.length, 3);
  tabs[2].status = 'connected';
  host.label = 'Renamed only';
  assert.equal((await run({ hostId: host.id })).sessionId, recovered.sessionId);
  host.hostname = 'replacement.invalid';
  const editedTarget = await run({ hostId: host.id });
  assert.notEqual(editedTarget.sessionId, recovered.sessionId, 'a saved endpoint edit must not reuse the old transport');
  assert.equal(editedTarget.reused, undefined);
});
