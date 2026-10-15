const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startPtyJob } = require('./ptyExec.cjs');
const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');
const { buildLiveShellProbe, buildLiveShellProbeCleanup } = require('./liveShellProbe.cjs');

// systemd >=258 (Ubuntu 25.10/26.04) ships a PS0/PROMPT_COMMAND hook that emits
// OSC 3008 context sequences around every submitted command (issue #3676).
// During paced typed delivery that bypass output can desync the payload's own
// final newline and leave the command sitting on the input line uncommitted.
// A delivery that observed OSC 3008 must be followed by one standalone submit
// Enter written as its own write; quiet deliveries must not change shape.

const COMMAND = "echo " + "x".repeat(1200);
const OSC_3008 = "\x1b]3008;start=uuid;type=command\x1b\\";

function makePty() {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => { writes.push(String(data)); return true; };
  return { pty, writes };
}

function expectedDeliveryLength(marker) {
  const probe = 2 + buildLiveShellProbe(marker).length;
  const wrapper = 2 + buildLiveShellProbeCleanup(marker).length + buildWrappedCommand(COMMAND, "posix", marker, true).length;
  return probe + wrapper;
}

async function driveDelivery(t, pty, writes, marker, { osc }) {
  const totalLength = expectedDeliveryLength(marker);
  // Short probe is delivered as a single write; reply to finish probing.
  t.mock.timers.tick(30);
  assert.ok(writes.length >= 1, "probe was written");
  pty.emit("data", `${marker}_P:sh\n${marker}_Q`);
  let delivered = false;
  for (let i = 0; i < 4000; i += 1) {
    t.mock.timers.tick(30);
    if (osc && i % 4 === 0) pty.emit("data", osc);
    if (writes.join("").length >= totalLength) { delivered = true; break; }
  }
  assert.ok(delivered, "wrapper delivery completed");
  t.mock.timers.tick(60);
}

test("delivery that observes OSC 3008 sends a standalone submit Enter (issue #3676)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  await driveDelivery(t, pty, writes, job.marker, { osc: OSC_3008 });
  assert.equal(writes[writes.length - 1], "\n", "a standalone Enter is written after the noisy delivery");
  assert.ok(writes[writes.length - 2].endsWith("\n"), "payload batch still ends with its own newline");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("delivery without OSC 3008 noise does not gain an extra standalone Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  await driveDelivery(t, pty, writes, job.marker, { osc: null });
  const payload = writes[writes.length - 1];
  assert.notEqual(payload, "\n", "no standalone Enter is written on quiet delivery");
  assert.ok(payload.endsWith("\n"), "wrapper payload still ends with its own newline");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("decorative title OSC noise does not trigger the standalone Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  await driveDelivery(t, pty, writes, job.marker, { osc: "\x1b]0;user@host: /tmp\x07" });
  assert.notEqual(writes[writes.length - 1], "\n", "title-only noise must not add a standalone Enter");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});
