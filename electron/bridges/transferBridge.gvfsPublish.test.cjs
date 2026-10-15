"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bridge = require("./transferBridge.cjs");
const temp = require("./tempDirBridge.cjs");

const unsupported = (code = "ENOTSUP") => Object.assign(new Error(`Injected ${code}`), { code });

// Real files and handles; only unavailable mount operations and virtual mode
// reporting are simulated. This is not a real Linux/GVFS acceptance test.
async function mountedDestination(t, options = {}) {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("gvfs-publish")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "stage.part");
  const target = path.join(root, "target");
  const payload = Buffer.alloc(2 * 1024 * 1024 + 17, 173);
  fs.writeFileSync(stage, payload, { mode: 0o644 });
  if (options.existingMode !== undefined) {
    fs.writeFileSync(target, "original");
    fs.chmodSync(target, options.existingMode);
  }
  const calls = [];
  let cancelled = false;
  for (const name of ["rename", "copyFile", "link", "open"]) {
    const original = fs.promises[name];
    t.after(() => { fs.promises[name] = original; });
    fs.promises[name] = async (...args) => {
      if (name === "rename" && args[0] === stage) throw unsupported("EXDEV");
      if (name === "copyFile") {
        calls.push("copyFile");
        if (options.readyCollision) fs.writeFileSync(args[1], "other writer");
        if (options.copyError !== false) throw unsupported(options.copyError || "ENOTSUP");
      }
      if (name === "link") throw unsupported();
      const result = await original.apply(fs.promises, args);
      if (name !== "open" || args[0] === stage) return result;
      const created = args[1] === "wx";
      if (created && options.virtualMode !== undefined) fs.chmodSync(args[0], options.virtualMode);
      result.chmod = async () => { calls.push("chmod"); throw unsupported(); };
      result.utimes = async () => { calls.push("utimes"); throw unsupported(); };
      if (created) {
        const final = args[0] === target;
        calls.push(final ? "final-open" : "ready-open");
        const write = result.write.bind(result);
        result.write = async (buffer, offset, length, position) => {
          if (options.writeError && final) throw unsupported(options.writeError);
          const written = await write(buffer, offset, Math.min(length, 32768), position);
          if (options.cancel && !final) cancelled = true;
          return written;
        };
        const close = result.close.bind(result);
        result.close = async () => {
          await close();
          if (options.closeError === (final ? "final" : "ready")) throw unsupported("EIO");
        };
      }
      return result;
    };
  }
  const run = () => bridge._promoteLocalTransferForTests(stage, target, {
    sourceSoftIdentity: { mtimeMs: 1700000000000 },
    validateTarget: async () => ({
      targetIdentity: options.existingMode === undefined ? "missing" : undefined,
      existingMode: options.existingMode,
    }),
    assertNotCancelled: () => {
      if (cancelled || (options.cancelBeforeFinal && !fs.existsSync(target))) throw unsupported("ABORT_ERR");
    },
    onCommit: (_identity, timestampsPreserved) => { calls.push(["commit", timestampsPreserved]); },
  });
  return { root, stage, target, payload, calls, run };
}

for (const [virtualMode, copyError] of [[0o644, "ENOTSUP"], [0o700, "EOPNOTSUPP"]]) {
  test(`new mounted destination accepts creation policy ${virtualMode.toString(8)} through both copy stages`, async (t) => {
    const setup = await mountedDestination(t, { virtualMode, copyError });
    await setup.run();
    assert.deepEqual(fs.readFileSync(setup.target), setup.payload);
    assert.deepEqual(fs.readdirSync(setup.root), ["target"]);
    assert.ok(setup.calls.includes("ready-open"));
    assert.ok(setup.calls.includes("final-open"));
    assert.deepEqual(setup.calls.at(-1), ["commit", false]);
  });
}

test("existing mounted file keeps matching virtual permissions", async (t) => {
  const setup = await mountedDestination(t, { virtualMode: 0o700, existingMode: 0o700 });
  await setup.run();
  assert.deepEqual(fs.readFileSync(setup.target), setup.payload);
  assert.equal(fs.statSync(setup.target).mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(setup.root), ["target"]);
});

test("unsupported chmod cannot broaden an existing destination", async (t) => {
  const setup = await mountedDestination(t, { virtualMode: 0o700, existingMode: 0o600 });
  await assert.rejects(setup.run, { code: "ENOTSUP" });
  assert.equal(fs.readFileSync(setup.target, "utf8"), "original");
  assert.equal(fs.statSync(setup.target).mode & 0o7777, 0o600);
  assert.deepEqual(fs.readFileSync(setup.stage), setup.payload);
});

for (const copyError of ["EACCES", "EPERM", "ENOSPC", "EIO", "EEXIST", "EINVAL"]) {
  test(`copyFile ${copyError} remains a failure`, async (t) => {
    const setup = await mountedDestination(t, { copyError });
    await assert.rejects(setup.run, { code: copyError });
    assert.equal(fs.existsSync(setup.target), false);
    assert.deepEqual(fs.readFileSync(setup.stage), setup.payload);
    assert.equal(setup.calls.includes("ready-open"), false);
  });
}

for (const failure of [{ cancel: true }, { closeError: "ready" }, { closeError: "final" }, { writeError: "ENOSPC" }]) {
  test(`copy failure preserves original and complete stage: ${JSON.stringify(failure)}`, async (t) => {
    const setup = await mountedDestination(t, { existingMode: 0o644, virtualMode: 0o644, ...failure });
    await assert.rejects(setup.run, /Recovery files preserved/);
    assert.deepEqual(fs.readFileSync(setup.stage), setup.payload);
    const backup = fs.readdirSync(setup.root).find(name => name.endsWith(".backup"));
    assert.equal(fs.readFileSync(backup ? path.join(setup.root, backup) : setup.target, "utf8"), "original");
    assert.equal(setup.calls.some(call => Array.isArray(call) && call[0] === "commit"), false);
  });
}


test("failed copy followed by exclusive-open collision leaves that entry intact", async (t) => {
  const setup = await mountedDestination(t, { readyCollision: true });
  await assert.rejects(setup.run, /Recovery files preserved/);
  const ready = fs.readdirSync(setup.root).find(name => name.endsWith(".ready"));
  assert.equal(fs.readFileSync(path.join(setup.root, ready), "utf8"), "other writer");
  assert.deepEqual(fs.readFileSync(setup.stage), setup.payload);
  assert.equal(fs.existsSync(setup.target), false);
});

test("rollback retains backup when its original timestamps cannot be restored", async (t) => {
  const setup = await mountedDestination(t, { existingMode: 0o644, cancelBeforeFinal: true });
  await assert.rejects(setup.run, /Recovery files preserved/);
  const backup = fs.readdirSync(setup.root).find(name => name.endsWith(".backup"));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(setup.root, backup), "utf8"), "original");
  assert.deepEqual(fs.readFileSync(setup.stage), setup.payload);
});
