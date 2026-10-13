const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveWindowMinimumSize } = require("./mainWindow.cjs");

test("uses the static layout minimums when they fit the display", () => {
  const size = resolveWindowMinimumSize(
    { getPrimaryDisplay: () => ({ workArea: { width: 1920, height: 1080 } }) },
    1100,
    640,
  );
  assert.deepEqual(size, { width: 1100, height: 640 });
});

test("shrinks the minimum to fit a small primary work area (#3647)", () => {
  // 1366×768 at 125% Windows scaling leaves ~1093×585 logical px of work area.
  const size = resolveWindowMinimumSize(
    { getPrimaryDisplay: () => ({ workArea: { width: 1093, height: 585 } }) },
    1100,
    640,
  );
  assert.equal(size.width, Math.floor(1093 * 0.9));
  assert.equal(size.height, Math.floor(585 * 0.9));
  assert.ok(size.width < 1100 && size.height < 640);
});

test("never shrinks below a small usable floor", () => {
  const size = resolveWindowMinimumSize(
    { getPrimaryDisplay: () => ({ workArea: { width: 300, height: 200 } }) },
    1100,
    640,
  );
  assert.deepEqual(size, { width: 320, height: 240 });
});

test("keeps the static minimums when screen is unavailable", () => {
  assert.deepEqual(resolveWindowMinimumSize(null, 1100, 640), { width: 1100, height: 640 });
  assert.deepEqual(resolveWindowMinimumSize({}, 1100, 640), { width: 1100, height: 640 });
  assert.deepEqual(
    resolveWindowMinimumSize(
      { getPrimaryDisplay: () => { throw new Error("screen not ready"); } },
      1100,
      640,
    ),
    { width: 1100, height: 640 },
  );
});

test("createWindow clamps saved bounds and BrowserWindow minima to the fitted size", async () => {
  const { EventEmitter } = require("node:events");
  const { createMainWindowApi } = require("./mainWindow.cjs");

  let constructedOptions = null;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      constructedOptions = options;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        id: 71,
        isDestroyed: () => this.destroyed,
        setWindowOpenHandler() {},
        openDevTools() {},
        send() {},
      });
    }
    close() {}
    isDestroyed() { return this.destroyed; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { width: 1000, height: 700 }; }
    setBackgroundColor() {}
    loadURL() { return Promise.resolve(); }
  }

  const api = createMainWindowApi({
    mainWindow: null, electronApp: null, currentTheme: "light", isQuitting: false,
    pendingWindowStateWrite: null, queuedWindowState: null, windowStateCloseRequested: false,
    DEFAULT_WINDOW_WIDTH: 1400, DEFAULT_WINDOW_HEIGHT: 900, MIN_WINDOW_WIDTH: 1100, MIN_WINDOW_HEIGHT: 640,
    V8_CACHE_OPTIONS: "code", THEME_COLORS: { light: {} },
    unhealthyWebContentsIds: new Set(), rendererReadySeenByWebContentsId: new Set(),
    __dirname, URL, require, console, setTimeout, clearTimeout,
    getGlobalShortcutBridge: () => ({ handleWindowClose: () => false }),
    getMainWindowCount: () => 1,
    debugLog() {}, resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return { width: 980, height: 560, x: 0, y: 0 }; },
    getDevRendererBaseUrl: (url) => url, getWindowBoundsState() { return null; },
    queueWindowStateSave() {}, saveWindowStateSync() {}, setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; }, createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {}, registerWindowHandlers() {}, requestWindowCommandClose() {},
    shouldCloseWindowFromInput() { return false; },
    registerMainWindow() {}, unregisterMainWindow() {}, registerAppContentWindow() {}, unregisterAppContentWindow() {},
    closeSettingsWindow() {}, hideSettingsWindow() {}, applyWindowOpacityToWindow() {},
  });

  await api.createWindow(
    {
      BrowserWindow: Window,
      nativeTheme: {},
      app: {},
      screen: {
        getPrimaryDisplay: () => ({ workArea: { width: 1093, height: 585 } }),
        getAllDisplays: () => [],
      },
      shell: {},
      ipcMain: {},
    },
    {
      preload: "/tmp/preload.cjs",
      devServerUrl: "http://localhost:5173",
      isDev: true,
      appIcon: null,
      isMac: true,
      electronDir: __dirname,
    },
  );

  assert.ok(constructedOptions);
  assert.equal(constructedOptions.minWidth, Math.floor(1093 * 0.9));
  assert.equal(constructedOptions.minHeight, Math.floor(585 * 0.9));
  assert.equal(constructedOptions.width, Math.max(980, Math.floor(1093 * 0.9)));
  assert.equal(constructedOptions.height, Math.max(560, Math.floor(585 * 0.9)));
});
