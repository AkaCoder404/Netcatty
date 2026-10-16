import test from "node:test";
import assert from "node:assert/strict";
import type { Host, PortForwardingRule } from "../../domain/models.ts";
import { STORAGE_KEY_PORT_FORWARDING } from "../config/storageKeys.ts";
import {
  getActiveConnection,
  getRuleMappingStates,
  reconcileWithBackend,
  setReconnectCallback,
  startPortForward,
  stopAndCleanupRuleAndWait,
  syncWithBackend,
} from "./portForwardingService.ts";

const host = (overrides: Partial<Host> = {}): Host => ({
  id: "host-1",
  label: "Host",
  hostname: "example.com",
  username: "root",
  tags: [],
  os: "linux",
  ...overrides,
});

const multiRule = (overrides: Partial<PortForwardingRule> = {}): PortForwardingRule => ({
  id: "rule-multi",
  label: "Multi",
  type: "local",
  localPort: 18080,
  bindAddress: "127.0.0.1",
  remoteHost: "127.0.0.1",
  remotePort: 8080,
  mappings: [
    { localPort: 18080, remotePort: 8080 },
    { localPort: 19090, remotePort: 9090 },
  ],
  status: "inactive",
  createdAt: 1,
  ...overrides,
});

const installMappingBridge = (startResult: Record<string, unknown>) => {
  const callbacks = new Map<string, (status: string, error?: string) => void>();
  let capturedOptions: Record<string, unknown> | null = null;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        startPortForward: async (options: Record<string, unknown>) => {
          capturedOptions = options;
          return startResult;
        },
        onPortForwardStatus: (
          tunnelId: string,
          cb: (status: string, error?: string) => void,
        ) => {
          callbacks.set(tunnelId, cb);
          return () => callbacks.delete(tunnelId);
        },
        stopPortForwardByRuleId: async () => ({ stopped: 2, failed: 0, errors: [] }),
      },
    },
  });
  return {
    getOptions: () => capturedOptions,
    fireStatus: (tunnelId: string, status: string, error?: string) =>
      callbacks.get(tunnelId)?.(status, error),
    hasCallback: (tunnelId: string) => callbacks.has(tunnelId),
  };
};

const successResult = {
  success: true,
  tunnelId: "pf-rule-multi-1",
  mappings: [
    {
      mappingId: 18080,
      localPort: 18080,
      remotePort: 8080,
      tunnelId: "pf-rule-multi-1-18080",
      success: true,
      status: "active",
    },
    {
      mappingId: 19090,
      localPort: 19090,
      remotePort: 9090,
      tunnelId: "pf-rule-multi-1-19090",
      success: true,
      status: "active",
    },
  ],
};

test("startPortForward fans a multi-mapping rule out to one tunnel per mapping", async (t) => {
  const bridge = installMappingBridge(successResult);

  const statuses: string[] = [];
  const result = await startPortForward(
    multiRule(),
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
  );

  assert.equal(result.success, true);
  assert.deepEqual(bridge.getOptions()?.mappings, [
    { localPort: 18080, remotePort: 8080 },
    { localPort: 19090, remotePort: 9090 },
  ]);

  const connection = getActiveConnection("rule-multi");
  assert.equal(connection?.status, "active");
  assert.equal(connection?.mappings?.size, 2);
  assert.deepEqual(
    getRuleMappingStates("rule-multi").map((mapping) => mapping.mappingId).sort(),
    [18080, 19090],
  );
  assert.deepEqual(statuses, ["connecting", "active"]);
  t.after(() => stopAndCleanupRuleAndWait("rule-multi"));
});

test("startPortForward keeps a partially-started rule and reports partial", async (t) => {
  installMappingBridge({
    success: false,
    error: "listen EADDRINUSE: address already in use",
    tunnelId: "pf-rule-multi-2",
    mappings: [
      {
        mappingId: 18080,
        localPort: 18080,
        remotePort: 8080,
        tunnelId: "pf-rule-multi-2-18080",
        success: true,
        status: "active",
      },
      {
        mappingId: 19090,
        localPort: 19090,
        remotePort: 9090,
        success: false,
        error: "listen EADDRINUSE: address already in use",
      },
    ],
  });

  const statuses: string[] = [];
  const result = await startPortForward(
    multiRule({ id: "rule-multi-2" }),
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
  );

  assert.equal(result.success, false);
  const connection = getActiveConnection("rule-multi-2");
  assert.equal(connection?.status, "partial");
  assert.equal(connection?.mappings?.size, 2);
  assert.equal(connection?.mappings?.get(19090)?.status, "error");
  assert.match(connection?.mappings?.get(19090)?.error ?? "", /EADDRINUSE/);
  assert.ok(statuses.includes("partial"));
  t.after(() => stopAndCleanupRuleAndWait("rule-multi-2"));
});

test("mapping status events route to the mapping and recompute the aggregate", async (t) => {
  const bridge = installMappingBridge(successResult);

  const statuses: string[] = [];
  await startPortForward(
    multiRule(),
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
  );

  bridge.fireStatus("pf-rule-multi-1-19090", "error", "listener died");
  assert.equal(getActiveConnection("rule-multi")?.status, "partial");
  assert.ok(statuses.includes("partial"));

  bridge.fireStatus("pf-rule-multi-1-19090", "inactive");
  const connection = getActiveConnection("rule-multi");
  assert.equal(connection?.status, "active");
  assert.equal(connection?.mappings?.size, 1);
  t.after(() => stopAndCleanupRuleAndWait("rule-multi"));
});

test("the rule tears down when its last mapping goes inactive", async () => {
  const bridge = installMappingBridge(successResult);

  const statuses: string[] = [];
  await startPortForward(
    multiRule(),
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
  );

  bridge.fireStatus("pf-rule-multi-1-18080", "inactive");
  bridge.fireStatus("pf-rule-multi-1-19090", "inactive");
  assert.equal(getActiveConnection("rule-multi"), undefined);
  assert.equal(statuses.at(-1), "inactive");
});

test("a mapping failure that leaves the rule partial schedules a reconnect", async (t) => {
  const bridge = installMappingBridge(successResult);
  setReconnectCallback(async () => ({ success: true }));
  t.after(() => setReconnectCallback(null));

  const statuses: string[] = [];
  await startPortForward(
    multiRule(),
    host(),
    [],
    [],
    [],
    (status) => statuses.push(status),
    true, // enableReconnect
  );

  bridge.fireStatus("pf-rule-multi-1-19090", "error", "listener died");

  // The failed mapping stays recorded while the rule-level status flips to
  // the reconnect countdown instead of being stranded as partial.
  const connection = getActiveConnection("rule-multi");
  assert.equal(connection?.status, "connecting");
  assert.match(connection?.error ?? "", /Reconnecting/);
  assert.equal(connection?.reconnectAttempts, 1);
  assert.equal(connection?.mappings?.get(19090)?.status, "error");
  assert.equal(getRuleMappingStates("rule-multi").length, 2);
  t.after(() => stopAndCleanupRuleAndWait("rule-multi"));
});

test("a mapping that stops while siblings remain schedules a reconnect", async (t) => {
  const bridge = installMappingBridge(successResult);
  setReconnectCallback(async () => ({ success: true }));
  t.after(() => setReconnectCallback(null));

  await startPortForward(
    multiRule(),
    host(),
    [],
    [],
    [],
    () => {},
    true, // enableReconnect
  );

  bridge.fireStatus("pf-rule-multi-1-19090", "inactive");

  const connection = getActiveConnection("rule-multi");
  assert.equal(connection?.status, "connecting");
  assert.match(connection?.error ?? "", /Reconnecting/);
  assert.equal(connection?.reconnectAttempts, 1);
  t.after(() => stopAndCleanupRuleAndWait("rule-multi"));
});

test("sync groups a one-record mapping snapshot and projects the missing mapping as partial", async (t) => {
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const backing = new Map<string, string>([
    [STORAGE_KEY_PORT_FORWARDING, JSON.stringify([multiRule()])],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => backing.get(key) ?? null,
      setItem: (key: string, value: string) => {
        backing.set(key, value);
      },
      removeItem: (key: string) => {
        backing.delete(key);
      },
    },
  });
  t.after(() => {
    if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  // Only one backend tunnel survived (the sibling hit EADDRINUSE before the
  // renderer reloaded), but its mappingId still marks it as multi-mapping.
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getPortForwardSnapshot: async () => ({
          epoch: "e1",
          revision: 1,
          records: [
            {
              ruleId: "rule-multi",
              tunnelId: "pf-rule-multi-1-18080",
              phase: "active",
              mappingId: 18080,
              localPort: 18080,
              remotePort: 8080,
            },
          ],
        }),
        onPortForwardStatus: () => () => undefined,
      },
    },
  });

  await syncWithBackend();

  const connection = getActiveConnection("rule-multi");
  assert.equal(connection?.status, "partial");
  assert.equal(connection?.mappings?.size, 2);
  assert.equal(connection?.mappings?.get(18080)?.status, "active");
  assert.equal(connection?.mappings?.get(19090)?.status, "error");
  assert.equal(connection?.mappings?.get(19090)?.tunnelId, "");
  t.after(() => stopAndCleanupRuleAndWait("rule-multi"));
});

test("reconcile groups snapshot records of one rule into one connection", async () => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      netcatty: {
        getPortForwardSnapshot: async () => ({
          epoch: "e1",
          revision: 3,
          records: [
            {
              ruleId: "rule-grouped",
              tunnelId: "pf-rule-grouped-1-18080",
              phase: "active",
              mappingId: 18080,
              localPort: 18080,
              remotePort: 8080,
            },
            {
              ruleId: "rule-grouped",
              tunnelId: "pf-rule-grouped-1-19090",
              phase: "error",
              error: "listener died",
              mappingId: 19090,
              localPort: 19090,
              remotePort: 9090,
            },
          ],
        }),
        onPortForwardStatus: () => () => undefined,
      },
    },
  });

  const result = await reconcileWithBackend();
  const connection = getActiveConnection("rule-grouped");
  assert.equal(connection?.status, "partial");
  assert.equal(connection?.mappings?.size, 2);
  assert.ok(result.appeared.includes("rule-grouped"));
});
