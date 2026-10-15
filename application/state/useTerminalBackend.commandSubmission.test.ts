import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTerminalBackend } from './useTerminalBackend';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  notifyTerminalCommandSubmission,
  registerTerminalCommandSubmissionListener,
} from '../../components/terminal/runtime/terminalCommandInjectionReadyRegistry';

test('shared backend invalidates relative UI before SFTP, snippet and typed submissions reach the bridge', () => {
  let backend!: ReturnType<typeof useTerminalBackend>;
  renderToStaticMarkup(createElement(() => { backend = useTerminalBackend(); return null; }));
  const seen: string[] = [];
  const dispose = registerTerminalCommandSubmissionListener('active', () => seen.push('invalidate'));
  const originalGet = netcattyBridge.get;
  netcattyBridge.get = () => ({ writeToSession: (_id, data) => seen.push(data) }) as NetcattyBridge;
  try {
    backend.writeToSession('active', "cd -- '/other'\r", { automated: true });
    backend.writeToSession('active', 'cd /another\r', { automated: true });
    backend.writeToSession('active', '\r');
    assert.deepEqual(seen, ['invalidate', "cd -- '/other'\r", 'invalidate', 'cd /another\r', 'invalidate', '\r']);
    seen.length = 0;
    backend.writeToSession('other', 'cd /elsewhere\r', { automated: true });
    backend.writeToSession('active', 'cd /draft', { automated: true });
    assert.deepEqual(seen, ['cd /elsewhere\r', 'cd /draft']);
    netcattyBridge.get = () => undefined;
    backend.writeToSession('active', '\r');
    assert.equal(seen.length, 2);
  } finally {
    netcattyBridge.get = originalGet;
    dispose();
  }
});

test('disposing an old terminal cannot remove a replacement submission listener', () => {
  const seen: string[] = [];
  const disposeOld = registerTerminalCommandSubmissionListener('restored', () => seen.push('old'));
  const disposeNew = registerTerminalCommandSubmissionListener('restored', () => seen.push('new'));
  disposeOld();
  notifyTerminalCommandSubmission('restored', '\n');
  assert.deepEqual(seen, ['new']);
  disposeNew();
  notifyTerminalCommandSubmission('restored', '\r');
  assert.deepEqual(seen, ['new']);
});
