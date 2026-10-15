import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { Host, TerminalSession } from '../../domain/models';
import { findReusableHostSession } from '../../domain/hostOpenSession';
import { handleVaultAgentOp, type VaultAgentApiDeps } from './vaultAgentBridgeClient';

const require = createRequire(import.meta.url);
const { isolateCliDiscoveryFile } = require('../../electron/bridges/cliDiscoveryTestIsolation.cjs');
isolateCliDiscoveryFile();
const bridge = require('../../electron/bridges/mcpServerBridge.cjs');
const { registerMcpTools, buildZodSchema } = require('../../electron/capabilities/codegen/mcpToolRegistry.cjs');

test('MCP host_open forwards the schema input through RPC and vault service to the real renderer handler', async (t) => {
  bridge.init({ sessions: new Map(), electronModule: null });
  bridge.setPermissionMode('auto');
  t.after(() => bridge.cleanup());
  const host: Host = { id: 'host-1', label: 'Host', hostname: 'example.invalid', username: 'user', protocol: 'ssh' };
  const tabs: TerminalSession[] = [{ id: 'existing', hostId: host.id, hostLabel: host.label, hostname: host.hostname, username: host.username, status: 'connecting' }];
  const deps = {
    getHosts: () => [host],
    resolveEffectiveHost: (value: Host) => value,
    findExistingSessionForHost: (hostId: string) => findReusableHostSession(tabs, hostId),
    openHost: () => {
      const sessionId = `new-${tabs.length}`;
      tabs.push({ ...tabs[0], id: sessionId });
      return { ok: true as const, sessionId, host };
    },
  } as VaultAgentApiDeps;
  bridge.setVaultAgentInvoker((op: string, params: Record<string, unknown>) => handleVaultAgentOp(op, params, deps));
  let openTool: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  let schema: ReturnType<typeof buildZodSchema>;
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
    const response = await openTool!(schema.parse(args)) as { content: { text: string }[] };
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
});
