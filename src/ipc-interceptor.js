"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { createRequire, registerHooks } = Module;
const { fileURLToPath, pathToFileURL } = require("node:url");

const { toWireValue } = require("./ws-server");

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    return false;
  }
}

function createFlexibleStub(label) {
  const stub = function flexibleStub() {
    return undefined;
  };

  return new Proxy(stub, {
    get(target, property) {
      if (property === "then") {
        return undefined;
      }

      if (property === Symbol.toPrimitive) {
        return () => label;
      }

      if (property === "toString") {
        return () => label;
      }

      if (property === "toJSON") {
        return () => label;
      }

      return createFlexibleStub(`${label}.${String(property)}`);
    },
    apply() {
      return undefined;
    },
    construct() {
      return createFlexibleStub(`new ${label}`);
    }
  });
}

async function loadTsconfigResolver(cwd) {
  const tsconfigPath = path.join(cwd, "tsconfig.json");

  try {
    const raw = JSON.parse(await fs.readFile(tsconfigPath, "utf8"));
    const compilerOptions = raw.compilerOptions || {};

    return {
      baseUrl: path.resolve(cwd, compilerOptions.baseUrl || "."),
      paths: compilerOptions.paths || {}
    };
  } catch (error) {
    return null;
  }
}

function isBareSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:") && !specifier.includes(":");
}

function resolveFileCandidate(targetPath) {
  const candidates = [
    targetPath,
    `${targetPath}.ts`,
    `${targetPath}.tsx`,
    `${targetPath}.mts`,
    `${targetPath}.cts`,
    `${targetPath}.js`,
    `${targetPath}.mjs`,
    `${targetPath}.cjs`,
    path.join(targetPath, "index.ts"),
    path.join(targetPath, "index.tsx"),
    path.join(targetPath, "index.mts"),
    path.join(targetPath, "index.cts"),
    path.join(targetPath, "index.js"),
    path.join(targetPath, "index.mjs"),
    path.join(targetPath, "index.cjs")
  ];

  for (const candidate of candidates) {
    try {
      const stats = require("node:fs").statSync(candidate);

      if (stats.isFile()) {
        return candidate;
      }
    } catch (error) {}
  }

  return null;
}

function applyWildcardMapping(specifier, pattern, target) {
  if (!pattern.includes("*")) {
    return specifier === pattern ? target : null;
  }

  const [patternPrefix, patternSuffix] = pattern.split("*");

  if (!specifier.startsWith(patternPrefix) || !specifier.endsWith(patternSuffix || "")) {
    return null;
  }

  const wildcardValue = specifier.slice(patternPrefix.length, specifier.length - patternSuffix.length);
  return target.replace("*", wildcardValue);
}

function resolveWithTsconfig(specifier, resolver) {
  if (!resolver || !isBareSpecifier(specifier)) {
    return null;
  }

  for (const [pattern, targets] of Object.entries(resolver.paths)) {
    const targetList = Array.isArray(targets) ? targets : [targets];

    for (const target of targetList) {
      const mapped = applyWildcardMapping(specifier, pattern, target);

      if (!mapped) {
        continue;
      }

      const resolved = resolveFileCandidate(path.resolve(resolver.baseUrl, mapped));

      if (resolved) {
        return resolved;
      }
    }
  }

  return resolveFileCandidate(path.resolve(resolver.baseUrl, specifier));
}

function resolveLocalSpecifier(specifier, context) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return null;
  }

  const parentPath =
    context && typeof context.parentURL === "string" && context.parentURL.startsWith("file:")
      ? path.dirname(fileURLToPath(context.parentURL))
      : null;
  const basePath = specifier.startsWith(".") && parentPath ? path.resolve(parentPath, specifier) : specifier;

  return resolveFileCandidate(basePath);
}

async function findConfigFromCandidates(cwd, candidates) {
  for (const candidate of candidates) {
    const absolutePath = path.join(cwd, candidate);

    if (await fileExists(absolutePath)) {
      return absolutePath;
    }
  }

  return null;
}

async function findElectronViteConfig(cwd) {
  return findConfigFromCandidates(cwd, [
    "electron.vite.config.ts",
    "electron.vite.config.mts",
    "electron.vite.config.cts",
    "electron.vite.config.js",
    "electron.vite.config.mjs",
    "electron.vite.config.cjs"
  ]);
}

async function loadConfigFile(configPath) {
  const imported = await import(`${pathToFileURL(configPath).href}?erp=${Date.now()}`);
  const candidate = imported.default ?? imported;

  if (typeof candidate === "function") {
    return candidate({
      command: "serve",
      mode: "development"
    });
  }

  return candidate;
}

function pickEntryNames(input) {
  if (!input) {
    return [];
  }

  if (typeof input === "string") {
    return [path.parse(input).name];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => pickEntryNames(item));
  }

  if (typeof input === "object") {
    return Object.keys(input);
  }

  return [];
}

async function detectStandalonePreloadEntries(cwd, entryPath) {
  const discovered = [];
  const seen = new Set();

  async function addCandidate(candidatePath) {
    if (!candidatePath) {
      return;
    }

    const absolutePath = path.resolve(cwd, candidatePath);

    if (seen.has(absolutePath)) {
      return;
    }

    if (await fileExists(absolutePath)) {
      seen.add(absolutePath);
      discovered.push(absolutePath);
    }
  }

  const electronViteConfigPath = await findElectronViteConfig(cwd);

  if (electronViteConfigPath) {
    try {
      const config = await loadConfigFile(electronViteConfigPath);
      const outDir = path.resolve(cwd, config?.preload?.build?.outDir || "dist/preload");
      const input = config?.preload?.build?.rollupOptions?.input || config?.preload?.build?.lib?.entry;
      const names = pickEntryNames(input);

      for (const name of names) {
        await addCandidate(path.join(outDir, `${name}.cjs`));
        await addCandidate(path.join(outDir, `${name}.js`));
        await addCandidate(path.join(outDir, `${name}.mjs`));
      }
    } catch (error) {}
  }

  if (entryPath) {
    const normalizedEntryPath = path.normalize(entryPath);
    const distMainSegment = `${path.sep}dist${path.sep}main${path.sep}`;

    if (normalizedEntryPath.includes(distMainSegment)) {
      const siblingPreloadDir = path.resolve(path.dirname(entryPath), "..", "preload");
      await addCandidate(path.join(siblingPreloadDir, "index.cjs"));
      await addCandidate(path.join(siblingPreloadDir, "index.js"));
      await addCandidate(path.join(siblingPreloadDir, "index.mjs"));
      await addCandidate(path.join(siblingPreloadDir, "preload.cjs"));
      await addCandidate(path.join(siblingPreloadDir, "preload.js"));
      await addCandidate(path.join(siblingPreloadDir, "preload.mjs"));
    }
  }

  for (const candidate of [
    "dist/preload/index.cjs",
    "dist/preload/index.js",
    "dist/preload/index.mjs",
    "dist/preload/preload.cjs",
    "dist/preload/preload.js",
    "dist/preload/preload.mjs",
    "preload.cjs",
    "preload.js",
    "preload.mjs",
    "src/preload.cjs",
    "src/preload.js",
    "src/preload.mjs",
    "electron/preload.cjs",
    "electron/preload.js",
    "electron/preload.mjs"
  ]) {
    await addCandidate(candidate);
  }

  return discovered;
}

function describeContextBridgeValue(value, seen = new WeakSet()) {
  if (typeof value === "function") {
    return {
      type: "function",
      async: value.constructor && value.constructor.name === "AsyncFunction"
    };
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (seen.has(value)) {
      return {
        type: "value",
        value: toWireValue("[Circular]")
      };
    }

    seen.add(value);
    const entries = {};

    for (const [key, nested] of Object.entries(value)) {
      entries[key] = describeContextBridgeValue(nested, seen);
    }

    seen.delete(value);
    return {
      type: "object",
      entries
    };
  }

  return {
    type: "value",
    value: toWireValue(value)
  };
}

function resolveContextBridgeTarget(root, targetPath) {
  let current = root;

  for (const segment of targetPath) {
    if (current == null || (typeof current !== "object" && typeof current !== "function")) {
      throw new Error(`Context bridge path "${targetPath.join(".")}" could not be resolved.`);
    }

    current = current[segment];
  }

  return current;
}

function createRendererEndpoint(options) {
  const { clientId, localDispatch, senderReference, transport, mode } = options;
  const emitter = new EventEmitter();

  emitter.send = (channel, ...args) => {
    if (typeof localDispatch === "function") {
      localDispatch(channel, args, senderReference || emitter);
    }

    if (!transport) {
      return typeof localDispatch === "function";
    }

    const message = {
      type: "ipc-event",
      channel,
      args
    };

    if (mode === "single" && clientId) {
      transport.sendToClient(clientId, message);
    } else {
      transport.broadcast(message);
    }

    return true;
  };

  emitter.postMessage = (channel, message) => emitter.send(channel, message);
  emitter.isDestroyed = () => false;
  emitter.openDevTools = () => undefined;
  emitter.closeDevTools = () => undefined;
  emitter.reload = () => undefined;
  emitter.reloadIgnoringCache = () => undefined;
  emitter.executeJavaScript = async () => null;
  emitter.printToPDF = async () => Buffer.alloc(0);
  emitter.capturePage = async () => null;
  emitter.getURL = () => "";

  return emitter;
}

function createIpcInterceptor() {
  const handlers = new Map();
  const listeners = new EventEmitter();
  let transport = null;

  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => {
    handlers.set(channel, handler);
    return ipcMain;
  };
  ipcMain.handleOnce = (channel, handler) => {
    handlers.set(channel, async (event, ...args) => {
      handlers.delete(channel);
      return handler(event, ...args);
    });

    return ipcMain;
  };
  ipcMain.removeHandler = (channel) => {
    handlers.delete(channel);
    return ipcMain;
  };
  ipcMain.on = (channel, listener) => {
    listeners.on(channel, listener);
    return ipcMain;
  };
  ipcMain.once = (channel, listener) => {
    listeners.once(channel, listener);
    return ipcMain;
  };
  ipcMain.removeListener = (channel, listener) => {
    listeners.removeListener(channel, listener);
    return ipcMain;
  };
  ipcMain.off = ipcMain.removeListener;
  ipcMain.removeAllListeners = (channel) => {
    listeners.removeAllListeners(channel);
    return ipcMain;
  };

  function createMessageEvent(clientId, senderOptions = {}) {
    const sender = createRendererEndpoint({
      clientId,
      transport,
      mode: "single",
      localDispatch: senderOptions.localDispatch,
      senderReference: senderOptions.senderReference
    });

    return {
      processId: process.pid,
      frameId: 0,
      reply: (channel, ...args) => sender.send(channel, ...args),
      returnValue: undefined,
      sender,
      senderFrame: {
        url: "erp://renderer",
        postMessage: (channel, message) => sender.send(channel, message)
      }
    };
  }

  return {
    attachTransport(nextTransport) {
      transport = nextTransport;
    },
    async invoke(channel, args, clientId, senderOptions = {}) {
      const handler = handlers.get(channel);

      if (!handler) {
        throw new Error(`No ipcMain.handle() registration found for channel "${channel}".`);
      }

      const event = createMessageEvent(clientId, senderOptions);
      return handler(event, ...args);
    },
    async send(channel, args, clientId, senderOptions = {}) {
      const event = createMessageEvent(clientId, senderOptions);

      for (const listener of listeners.listeners(channel)) {
        await Promise.resolve(listener(event, ...args));
      }

      return undefined;
    },
    sendSync(channel, args, clientId, senderOptions = {}) {
      const event = createMessageEvent(clientId, senderOptions);

      for (const listener of listeners.listeners(channel)) {
        listener(event, ...args);
      }

      return event.returnValue;
    },
    ipcMain,
    listChannels() {
      return Array.from(handlers.keys()).sort();
    }
  };
}

function createElectronShim(options) {
  const { cwd, ipcInterceptor, onContextBridgeExpose, onWarning, transport } = options;
  const appPaths = {
    cache: path.join(cwd, ".erp-cache"),
    desktop: path.join(cwd, "Desktop"),
    documents: path.join(cwd, "Documents"),
    downloads: path.join(cwd, "Downloads"),
    home: cwd,
    logs: path.join(cwd, ".erp-logs"),
    temp: os.tmpdir(),
    userData: path.join(cwd, ".erp-user-data")
  };
  const contextBridges = new Map();
  const preloadTasks = new Set();
  const windows = [];
  let webContentsId = 0;

  function warn(message) {
    if (typeof onWarning === "function") {
      onWarning(message);
      return;
    }

    console.warn(message);
  }

  function dispatchPreloadEvent(preloadState, channel, args, senderReference) {
    if (!preloadState) {
      return;
    }

    preloadState.emitter.emit(channel, { channel, sender: senderReference || preloadState.ipcRenderer }, ...args);
  }

  function getPreloadSenderOptions(preloadState) {
    return {
      localDispatch: (channel, args, senderReference) => {
        dispatchPreloadEvent(preloadState, channel, args, senderReference);
      },
      senderReference: preloadState.ipcRenderer
    };
  }

  function createPreloadState(windowInstance) {
    const preloadState = {
      currentClientId: null,
      emitter: new EventEmitter(),
      exposedApis: new Map(),
      ipcRenderer: null,
      loaded: false,
      windowInstance
    };

    const ipcRenderer = {
      invoke(channel, ...args) {
        return ipcInterceptor.invoke(channel, args, preloadState.currentClientId, getPreloadSenderOptions(preloadState));
      },
      send(channel, ...args) {
        void ipcInterceptor.send(channel, args, preloadState.currentClientId, getPreloadSenderOptions(preloadState));
      },
      sendSync(channel, ...args) {
        return ipcInterceptor.sendSync(channel, args, preloadState.currentClientId, getPreloadSenderOptions(preloadState));
      },
      postMessage(channel, message) {
        ipcRenderer.send(channel, message);
      },
      on(channel, handler) {
        preloadState.emitter.on(channel, handler);
        return ipcRenderer;
      },
      once(channel, handler) {
        preloadState.emitter.once(channel, handler);
        return ipcRenderer;
      },
      removeListener(channel, handler) {
        preloadState.emitter.removeListener(channel, handler);
        return ipcRenderer;
      },
      off(channel, handler) {
        return ipcRenderer.removeListener(channel, handler);
      },
      removeAllListeners(channel) {
        preloadState.emitter.removeAllListeners(channel);
        return ipcRenderer;
      }
    };

    preloadState.ipcRenderer = ipcRenderer;
    return preloadState;
  }

  const runtimeState = {
    currentPreloadState: null
  };

  async function withPreloadState(preloadState, callback) {
    const noopEventTarget = {
      addEventListener() {},
      dispatchEvent() {
        return true;
      },
      removeEventListener() {}
    };
    const previousAddEventListener = globalThis.addEventListener;
    const previousDispatchEvent = globalThis.dispatchEvent;
    const previousDocument = globalThis.document;
    const previousRemoveEventListener = globalThis.removeEventListener;
    const previous = runtimeState.currentPreloadState;
    const previousSelf = globalThis.self;
    const previousWindow = globalThis.window;

    runtimeState.currentPreloadState = preloadState;
    globalThis.addEventListener = noopEventTarget.addEventListener;
    globalThis.dispatchEvent = noopEventTarget.dispatchEvent;
    globalThis.document = previousDocument || createFlexibleStub("document");
    globalThis.removeEventListener = noopEventTarget.removeEventListener;
    globalThis.self = globalThis;
    globalThis.window = globalThis;

    try {
      return await callback();
    } finally {
      globalThis.addEventListener = previousAddEventListener;
      globalThis.dispatchEvent = previousDispatchEvent;
      globalThis.document = previousDocument;
      globalThis.removeEventListener = previousRemoveEventListener;
      runtimeState.currentPreloadState = previous;
      globalThis.self = previousSelf;
      globalThis.window = previousWindow;
    }
  }

  async function executePreload(preloadPath, preloadState) {
    const absolutePath = path.isAbsolute(preloadPath) ? preloadPath : path.resolve(cwd, preloadPath);
    const moduleUrl = pathToFileURL(absolutePath).href;

    await withPreloadState(preloadState, async () => {
      const loader = createRequire(absolutePath);
      const extension = path.extname(absolutePath);

      if (extension === ".cjs" || extension === ".js" || extension === ".node") {
        loader(absolutePath);
        return;
      }

      await import(moduleUrl);
    });
  }

  function trackPreloadTask(task) {
    preloadTasks.add(task);
    task.finally(() => {
      preloadTasks.delete(task);
    });
  }

  function loadWindowPreload(windowInstance) {
    const preloadPath =
      windowInstance.options &&
      windowInstance.options.webPreferences &&
      windowInstance.options.webPreferences.preload;

    if (!preloadPath || !windowInstance.__erpPreloadState || windowInstance.__erpPreloadState.loaded) {
      return;
    }

    windowInstance.__erpPreloadState.loaded = true;
    trackPreloadTask(
      executePreload(preloadPath, windowInstance.__erpPreloadState).catch((error) => {
        warn(`Preload ${path.relative(cwd, preloadPath)} failed inside the ERP shim: ${error.message}`);
      })
    );
  }

  function registerContextBridgeExposure(name, api, preloadState) {
    const schema = describeContextBridgeValue(api);
    const exposure = {
      api,
      preloadState,
      schema
    };

    preloadState.exposedApis.set(name, exposure);
    contextBridges.set(name, exposure);

    if (typeof onContextBridgeExpose === "function") {
      onContextBridgeExpose(name, schema);
    }
  }

  async function callContextBridge(channel, targetPath, args, clientId) {
    const exposure = contextBridges.get(channel);

    if (!exposure) {
      throw new Error(`No contextBridge exposure found for "${channel}".`);
    }

    const target = resolveContextBridgeTarget(exposure.api, targetPath);

    if (typeof target !== "function") {
      return target;
    }

    const previousClientId = exposure.preloadState.currentClientId;
    exposure.preloadState.currentClientId = clientId || null;

    try {
      return await Promise.resolve(target(...args));
    } finally {
      exposure.preloadState.currentClientId = previousClientId;
    }
  }

  function callContextBridgeSync(channel, targetPath, args, clientId) {
    const exposure = contextBridges.get(channel);

    if (!exposure) {
      throw new Error(`No contextBridge exposure found for "${channel}".`);
    }

    const target = resolveContextBridgeTarget(exposure.api, targetPath);

    if (typeof target !== "function") {
      return target;
    }

    const previousClientId = exposure.preloadState.currentClientId;
    exposure.preloadState.currentClientId = clientId || null;

    try {
      const result = target(...args);

      if (result && typeof result.then === "function") {
        throw new Error(
          `Context bridge method "${channel}.${targetPath.join(".")}" returned a Promise and cannot be used synchronously.`
        );
      }

      return result;
    } finally {
      exposure.preloadState.currentClientId = previousClientId;
    }
  }

  const fallbackIpcRenderer = createFlexibleStub("electron.ipcRenderer");
  const contextBridge = {
    exposeInMainWorld(name, api) {
      if (!runtimeState.currentPreloadState) {
        warn(`contextBridge.exposeInMainWorld("${name}") was called outside of a preload context.`);
        return;
      }

      registerContextBridgeExposure(name, api, runtimeState.currentPreloadState);
    },
    exposeInIsolatedWorld(worldId, name, api) {
      void worldId;
      contextBridge.exposeInMainWorld(name, api);
    }
  };

  const app = new EventEmitter();
  let ready = false;
  const readyPromise = new Promise((resolve) => {
    process.nextTick(() => {
      ready = true;
      app.emit("ready");
      resolve();
    });
  });
  app.commandLine = { appendSwitch() {} };
  app.disableHardwareAcceleration = () => undefined;
  app.exit = () => app.emit("exit");
  app.getAppPath = () => cwd;
  app.getName = () => path.basename(cwd);
  app.getPath = (name) => appPaths[name] || cwd;
  app.getVersion = () => "0.0.0-erp";
  app.isReady = () => ready;
  app.quit = () => app.emit("quit");
  app.releaseSingleInstanceLock = () => undefined;
  app.requestSingleInstanceLock = () => true;
  app.setAppUserModelId = () => undefined;
  app.setName = () => undefined;
  app.setPath = (name, nextPath) => {
    appPaths[name] = nextPath;
  };
  app.whenReady = () => readyPromise;
  app.dock = createFlexibleStub("app.dock");

  class FakeBrowserWindow extends EventEmitter {
    constructor(windowOptions = {}) {
      super();
      this.id = windows.length + 1;
      this.options = windowOptions;
      this.__erpPreloadState = createPreloadState(this);
      this.webContents = createRendererEndpoint({
        mode: "broadcast",
        transport,
        localDispatch: (channel, args, senderReference) => {
          dispatchPreloadEvent(this.__erpPreloadState, channel, args, senderReference);
        },
        senderReference: this.__erpPreloadState.ipcRenderer
      });
      this.webContents.id = ++webContentsId;
      windows.push(this);
      loadWindowPreload(this);
    }

    static fromWebContents(target) {
      return windows.find((window) => window.webContents === target) || null;
    }

    static getAllWindows() {
      return windows.slice();
    }

    static getFocusedWindow() {
      return windows[0] || null;
    }

    close() {
      const index = windows.indexOf(this);

      if (index >= 0) {
        windows.splice(index, 1);
      }

      this.emit("closed");
    }

    destroy() {
      this.close();
    }

    focus() {}

    hide() {}

    isDestroyed() {
      return false;
    }

    loadFile(filePath) {
      this.lastFile = filePath;
      loadWindowPreload(this);
      process.nextTick(() => {
        this.emit("ready-to-show");
      });
      return Promise.resolve();
    }

    loadURL(url) {
      this.lastURL = url;
      loadWindowPreload(this);
      process.nextTick(() => {
        this.emit("ready-to-show");
      });
      return Promise.resolve();
    }

    maximize() {}

    minimize() {}

    reload() {}

    restore() {}

    setBackgroundColor() {}

    setAlwaysOnTop() {}

    setBounds() {}

    setMenuBarVisibility() {}

    setMinimumSize() {}

    setSize() {}

    setTitle() {}

    show() {}
  }

  class FakeBrowserView extends EventEmitter {
    constructor() {
      super();
      this.__erpPreloadState = createPreloadState(this);
      this.webContents = createRendererEndpoint({
        mode: "broadcast",
        transport,
        localDispatch: (channel, args, senderReference) => {
          dispatchPreloadEvent(this.__erpPreloadState, channel, args, senderReference);
        },
        senderReference: this.__erpPreloadState.ipcRenderer
      });
      this.webContents.id = ++webContentsId;
    }

    setBounds() {}

    setAutoResize() {}
  }

  class FakeTray extends EventEmitter {
    destroy() {}

    setContextMenu() {}

    setToolTip() {}
  }

  class FakeNotification extends EventEmitter {
    show() {
      this.emit("show");
    }
  }

  const dialog = {
    showErrorBox() {},
    showMessageBox: async () => ({ checkboxChecked: false, response: 0 }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined })
  };

  const Menu = {
    buildFromTemplate() {
      return createFlexibleStub("Menu");
    },
    setApplicationMenu() {}
  };

  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.themeSource = "system";

  const session = {
    defaultSession: {
      cookies: {
        get: async () => [],
        set: async () => undefined
      },
      clearCache: async () => undefined,
      clearStorageData: async () => undefined,
      protocol: createFlexibleStub("session.defaultSession.protocol"),
      webRequest: {
        onBeforeRequest() {},
        onHeadersReceived() {}
      }
    },
    fromPartition() {
      return session.defaultSession;
    }
  };

  const shell = {
    beep() {},
    openExternal: async () => true,
    openPath: async () => ""
  };

  const safeStorage = {
    decryptString(buffer) {
      return Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer || "");
    },
    encryptString(value) {
      return Buffer.from(String(value ?? ""), "utf8");
    },
    isEncryptionAvailable() {
      return false;
    }
  };

  const screen = {
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1440, height: 900 } })
  };

  const protocol = {
    handle: async () => undefined,
    registerFileProtocol() {},
    registerSchemesAsPrivileged() {}
  };

  const clipboard = {
    readText: () => "",
    writeText() {}
  };

  const nativeImage = {
    createFromPath() {
      return {
        isEmpty: () => false,
        toPNG: () => Buffer.alloc(0)
      };
    }
  };

  const webUtils = {
    getPathForFile(file) {
      return file && typeof file.path === "string" ? file.path : "";
    }
  };

  const electron = {
    app,
    BaseWindow: FakeBrowserWindow,
    BaseWindowConstructorOptions: createFlexibleStub("electron.BaseWindowConstructorOptions"),
    BrowserView: FakeBrowserView,
    BrowserWindow: FakeBrowserWindow,
    Menu,
    Notification: FakeNotification,
    Rectangle: createFlexibleStub("electron.Rectangle"),
    Tray: FakeTray,
    WebContents: createFlexibleStub("electron.WebContents"),
    WebContentsView: FakeBrowserView,
    WebviewTag: createFlexibleStub("electron.WebviewTag"),
    clipboard,
    crashReporter: {
      addExtraParameter() {},
      start() {}
    },
    dialog,
    globalShortcut: {
      isRegistered: () => false,
      register: () => true,
      unregister() {},
      unregisterAll() {}
    },
    ipcMain: ipcInterceptor.ipcMain,
    nativeImage,
    net: {
      fetch: typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : createFlexibleStub("electron.net.fetch"),
      request: createFlexibleStub("electron.net.request")
    },
    nativeTheme,
    powerMonitor: new EventEmitter(),
    protocol,
    safeStorage,
    screen,
    session,
    shell,
    utilityProcess: createFlexibleStub("electron.utilityProcess"),
    webContents: {
      getAllWebContents() {
        return windows.map((window) => window.webContents);
      }
    },
    webUtils
  };

  Object.defineProperty(electron, "contextBridge", {
    enumerable: true,
    value: contextBridge
  });
  Object.defineProperty(electron, "ipcRenderer", {
    enumerable: true,
    get() {
      return runtimeState.currentPreloadState ? runtimeState.currentPreloadState.ipcRenderer : fallbackIpcRenderer;
    }
  });

  return {
    async close() {
      await Promise.allSettled(Array.from(preloadTasks));
      contextBridges.clear();
    },
    async loadStandalonePreloads(preloadPaths) {
      for (const preloadPath of preloadPaths) {
        const preloadState = createPreloadState({
          options: {
            webPreferences: {
              preload: preloadPath
            }
          }
        });

        try {
          await executePreload(preloadPath, preloadState);
        } catch (error) {
          warn(`Standalone preload ${path.relative(cwd, preloadPath)} failed inside the ERP shim: ${error.message}`);
        }
      }
    },
    async waitForPreloads() {
      await Promise.allSettled(Array.from(preloadTasks));
    },
    callContextBridge,
    callContextBridgeSync,
    electron: new Proxy(electron, {
      get(target, property) {
        if (property in target) {
          return target[property];
        }

        return createFlexibleStub(`electron.${String(property)}`);
      }
    }),
    listContextBridges() {
      return Array.from(contextBridges.entries()).map(([channel, exposure]) => ({
        channel,
        schema: exposure.schema
      }));
    },
    warn
  };
}

async function writeElectronStubs() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-electron-shim-"));
  const cjsPath = path.join(tempDir, "electron.cjs");
  const mjsPath = path.join(tempDir, "electron.mjs");
  const exportNames = [
    "app",
    "BaseWindow",
    "BaseWindowConstructorOptions",
    "BrowserView",
    "BrowserWindow",
    "Menu",
    "Notification",
    "Rectangle",
    "Tray",
    "WebContents",
    "WebContentsView",
    "WebviewTag",
    "clipboard",
    "contextBridge",
    "crashReporter",
    "dialog",
    "globalShortcut",
    "ipcMain",
    "ipcRenderer",
    "nativeImage",
    "net",
    "nativeTheme",
    "powerMonitor",
    "protocol",
    "safeStorage",
    "screen",
    "session",
    "shell",
    "utilityProcess",
    "webContents",
    "webUtils"
  ];

  const cjsContents = `"use strict";\nmodule.exports = globalThis.__ERP_ELECTRON_SHIM__.electron;\n`;
  const mjsContents = [
    `const electron = globalThis.__ERP_ELECTRON_SHIM__.electron;`,
    `export default electron;`,
    ...exportNames.map((name) => `export const ${name} = electron.${name};`)
  ].join("\n");

  await fs.writeFile(cjsPath, cjsContents, "utf8");
  await fs.writeFile(mjsPath, `${mjsContents}\n`, "utf8");

  return { cjsPath, mjsPath, tempDir };
}

async function loadProjectMain(options) {
  const { cwd, entryPath, ipcInterceptor, onContextBridgeExpose, transport } = options;
  const stubs = await writeElectronStubs();
  const tsconfigResolver = await loadTsconfigResolver(cwd);
  const shim = createElectronShim({
    cwd,
    ipcInterceptor,
    onContextBridgeExpose,
    onWarning(message) {
      console.warn(message);
    },
    transport
  });
  const originalNodeExtension = Module._extensions[".node"];

  try {
    process.versions.electron = process.versions.electron || "29.0.0";
  } catch (error) {}

  if (!Object.prototype.hasOwnProperty.call(process, "type")) {
    Object.defineProperty(process, "type", {
      configurable: true,
      value: "browser"
    });
  }

  globalThis.__ERP_ELECTRON_SHIM__ = { electron: shim.electron };

  if (typeof originalNodeExtension === "function") {
    Module._extensions[".node"] = function patchedNativeExtension(module, filename) {
      try {
        return originalNodeExtension(module, filename);
      } catch (error) {
        shim.warn(`Native module ${path.relative(cwd, filename)} could not be loaded in the ERP shim: ${error.message}`);
        module.exports = createFlexibleStub(`native:${path.basename(filename)}`);
        return module.exports;
      }
    };
  }

  async function cleanup() {
    delete globalThis.__ERP_ELECTRON_SHIM__;

    if (typeof originalNodeExtension === "function") {
      Module._extensions[".node"] = originalNodeExtension;
    }

    await shim.close();
    await fs.rm(stubs.tempDir, { force: true, recursive: true });
  }

  try {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "electron" || specifier.startsWith("electron/")) {
          const useEsm = Array.isArray(context.conditions) && context.conditions.includes("import");
          return {
            shortCircuit: true,
            url: pathToFileURL(useEsm ? stubs.mjsPath : stubs.cjsPath).href
          };
        }

        const tsconfigResolved = resolveWithTsconfig(specifier, tsconfigResolver);

        if (tsconfigResolved) {
          return {
            shortCircuit: true,
            url: pathToFileURL(tsconfigResolved).href
          };
        }

        const localResolved = resolveLocalSpecifier(specifier, context);

        if (localResolved) {
          return {
            shortCircuit: true,
            url: pathToFileURL(localResolved).href
          };
        }

        return nextResolve(specifier, context);
      }
    });

    await import(pathToFileURL(entryPath).href);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await shim.waitForPreloads();

    if (shim.listContextBridges().length === 0) {
      const standalonePreloads = await detectStandalonePreloadEntries(cwd, entryPath);

      if (standalonePreloads.length > 0) {
        await shim.loadStandalonePreloads(standalonePreloads);
      }
    }

    return {
      async callContextBridge(channel, targetPath, args, clientId) {
        return shim.callContextBridge(channel, targetPath, args, clientId);
      },
      callContextBridgeSync(channel, targetPath, args, clientId) {
        return shim.callContextBridgeSync(channel, targetPath, args, clientId);
      },
      async close() {
        await cleanup();
      },
      listContextBridges() {
        return shim.listContextBridges();
      }
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = {
  createIpcInterceptor,
  loadProjectMain
};
