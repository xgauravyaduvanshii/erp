"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { inspect } = require("node:util");

const chalk = require("chalk");
const chokidar = require("chokidar");

const { createMainProcessHost } = require("./main-process-host");
const { shellEscape } = require("./ssh-tunnel");
const { createWsServer, toWireValue } = require("./ws-server");
const { pathToFileURL } = require("node:url");

function createLogger() {
  function write(stream, color, label, message) {
    stream.write(`${color(`[erp:${label}]`)} ${message}\n`);
  }

  return {
    error(message) {
      write(process.stderr, chalk.red, "error", message);
    },
    info(message) {
      write(process.stdout, chalk.cyan, "info", message);
    },
    renderer(channel, args) {
      const formatter = channel === "error" ? chalk.red : channel === "warn" ? chalk.yellow : chalk.gray;
      const rendered = args.map((value) => formatValue(value)).join(" ");
      write(process.stdout, formatter, "renderer", rendered);
    },
    warn(message) {
      write(process.stdout, chalk.yellow, "warn", message);
    }
  };
}

function formatValue(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return value.stack || value.message;
  }

  return inspect(value, { colors: false, depth: 5, breakLength: Infinity });
}

function buildConnectCommand(options) {
  return [
    `erp connect ${options.username}@${options.host}`,
    `--key ~/.ssh/mykey.pem`,
    `--port ${options.port}`,
    `--vite-port ${options.vitePort}`
  ].join(" ");
}

function buildRemoteStartCommand(options) {
  return [
    `cd ${shellEscape(options.project)}`,
    `nohup erp start --port ${options.port} --vite-port ${options.vitePort} > .erp-start.log 2>&1 & echo $!`
  ].join(" && ");
}

async function fileExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    return false;
  }
}

async function readPackageMainPath(cwd) {
  const packageJsonPath = path.join(cwd, "package.json");

  if (!(await fileExists(packageJsonPath))) {
    return null;
  }

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));

  if (!packageJson.main) {
    return null;
  }

  return path.resolve(cwd, packageJson.main);
}

async function findMainEntryFromCandidates(cwd) {
  const candidates = [
    "main.js",
    "main.cjs",
    "main.mjs",
    "src/main.js",
    "src/main.cjs",
    "src/main.mjs",
    "electron/main.js",
    "electron/main.cjs",
    "electron/main.mjs",
    "electron.js",
    "index.js"
  ];

  for (const candidate of candidates) {
    const absolute = path.join(cwd, candidate);

    if (await fileExists(absolute)) {
      return absolute;
    }
  }

  return null;
}

async function resolveMainEntry(cwd) {
  const prepared = await prepareMainEntry(cwd);
  return prepared ? prepared.entryPath : null;
}

async function prepareMainEntry(cwd, options = {}) {
  const envOverride = process.env.ERP_MAIN;
  const packageMainPath = await readPackageMainPath(cwd);
  const electronViteConfigPath = await findElectronViteConfig(cwd);
  const packageMainExists = packageMainPath ? await fileExists(packageMainPath) : false;

  if (envOverride) {
    const absolute = path.resolve(cwd, envOverride);

    if (await fileExists(absolute)) {
      return {
        entryPath: absolute,
        strategy: "env-override",
        usesElectronVitePackageMain: false
      };
    }
  }

  if (
    packageMainPath &&
    electronViteConfigPath &&
    (!packageMainExists || options.preferElectronViteBuild || options.forceElectronViteBuild)
  ) {
    try {
      const buildArtifacts = options.buildElectronViteMainArtifacts || buildElectronViteMainArtifacts;
      await buildArtifacts(cwd, {
        electronViteConfigPath,
        logger: options.logger,
        packageMainPath
      });

      if (await fileExists(packageMainPath)) {
        return {
          entryPath: packageMainPath,
          strategy: "package-main-built",
          usesElectronVitePackageMain: true
        };
      }
    } catch (error) {
      if (options.logger) {
        options.logger.warn(`Electron main artifact build failed: ${error.message}`);
      }
    }
  }

  if (packageMainExists || (packageMainPath && (await fileExists(packageMainPath)))) {
    return {
      entryPath: packageMainPath,
      strategy: electronViteConfigPath ? "package-main-electron-vite" : "package-main",
      usesElectronVitePackageMain: Boolean(electronViteConfigPath)
    };
  }

  const electronViteEntry = await resolveElectronViteMainEntry(cwd);

  if (electronViteEntry) {
    return {
      entryPath: electronViteEntry,
      strategy: "electron-vite-source",
      usesElectronVitePackageMain: false
    };
  }

  const candidateEntry = await findMainEntryFromCandidates(cwd);

  if (candidateEntry) {
    return {
      entryPath: candidateEntry,
      strategy: "candidate",
      usesElectronVitePackageMain: false
    };
  }

  return null;
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

function pickRollupInput(input) {
  if (!input) {
    return null;
  }

  if (typeof input === "string") {
    return input;
  }

  if (Array.isArray(input)) {
    return pickRollupInput(input[0]);
  }

  if (typeof input === "object") {
    const firstValue = Object.values(input)[0];
    return pickRollupInput(firstValue);
  }

  return null;
}

async function resolveElectronViteMainEntry(cwd) {
  const configPath = await findElectronViteConfig(cwd);

  if (!configPath) {
    return null;
  }

  try {
    const config = await loadConfigFile(configPath);
    const mainInput =
      pickRollupInput(config?.main?.build?.rollupOptions?.input) || config?.main?.build?.lib?.entry || null;

    if (!mainInput) {
      return null;
    }

    const absolute = path.resolve(cwd, mainInput);

    if (await fileExists(absolute)) {
      return absolute;
    }
  } catch (error) {}

  return null;
}

async function buildElectronViteMainArtifacts(cwd, options = {}) {
  const electronVite = await loadModuleFromCwd("electron-vite", cwd);
  const vite = await loadModuleFromCwd("vite", cwd);
  const previousCwd = process.cwd();
  const previousMode = process.env.NODE_ENV_ELECTRON_VITE;

  process.chdir(cwd);
  process.env.NODE_ENV_ELECTRON_VITE = "production";

  try {
    const resolved = await electronVite.resolveConfig({ root: cwd }, "build", "production");

    if (!resolved || !resolved.config) {
      throw new Error("electron-vite did not return a build config.");
    }

    if (resolved.config.main) {
      await vite.build(resolved.config.main);
    }

    if (resolved.config.preload) {
      await vite.build(resolved.config.preload);
    }
  } finally {
    process.chdir(previousCwd);

    if (previousMode === undefined) {
      delete process.env.NODE_ENV_ELECTRON_VITE;
    } else {
      process.env.NODE_ENV_ELECTRON_VITE = previousMode;
    }
  }

  if (options.packageMainPath && options.logger) {
    options.logger.info(
      `Built Electron main/preload artifacts for ${path.relative(cwd, options.packageMainPath)} using electron-vite.`
    );
  }
}

function findExternalHostFromInterfaces(networkInterfaces) {
  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries || []) {
      if (entry && entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return "<ip>";
}

function requestMetadataText(options) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "169.254.169.254",
        method: options.method || "GET",
        path: options.path,
        headers: options.headers || {},
        timeout: options.timeoutMs || 700
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(body.trim());
            return;
          }

          reject(new Error(`Metadata request failed with status ${response.statusCode || "unknown"}.`));
        });
      }
    );

    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("Metadata request timed out."));
    });
    request.end();
  });
}

async function fetchEc2Metadata(pathName) {
  let token = null;

  try {
    token = await requestMetadataText({
      method: "PUT",
      path: "/latest/api/token",
      headers: {
        "X-aws-ec2-metadata-token-ttl-seconds": "60"
      }
    });
  } catch (error) {}

  try {
    return await requestMetadataText({
      path: `/latest/meta-data/${pathName}`,
      headers: token
        ? {
            "X-aws-ec2-metadata-token": token
          }
        : {},
      timeoutMs: 700
    });
  } catch (error) {
    return null;
  }
}

async function detectConnectHost(options = {}) {
  const fetcher = options.fetchEc2Metadata || fetchEc2Metadata;
  const networkInterfaces = options.networkInterfaces || os.networkInterfaces;

  try {
    const publicIpv4 = await fetcher("public-ipv4");

    if (publicIpv4) {
      return publicIpv4;
    }
  } catch (error) {}

  try {
    const publicHostname = await fetcher("public-hostname");

    if (publicHostname) {
      return publicHostname;
    }
  } catch (error) {}

  return findExternalHostFromInterfaces(typeof networkInterfaces === "function" ? networkInterfaces() : networkInterfaces);
}

async function isPortOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end();
      resolve(true);
    });

    socket.on("error", () => {
      resolve(false);
    });

    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPort(port, options = {}) {
  const host = options.host || "127.0.0.1";
  const intervalMs = options.intervalMs || 150;
  const timeoutMs = options.timeoutMs || 20_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port, host)) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error(`Timed out waiting for ${host}:${port} after ${timeoutMs}ms.`);
}

async function loadModuleFromCwd(specifier, cwd) {
  const resolved = require.resolve(specifier, { paths: [cwd, __dirname] });
  return import(pathToFileURL(resolved).href);
}

async function findConfigFromCandidates(cwd, candidates) {
  for (const candidate of candidates) {
    const absolute = path.join(cwd, candidate);

    if (await fileExists(absolute)) {
      return absolute;
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

async function findViteConfig(cwd) {
  const electronViteConfig = await findElectronViteConfig(cwd);

  if (electronViteConfig) {
    return electronViteConfig;
  }

  const candidates = [
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.cts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs"
  ];

  return findConfigFromCandidates(cwd, candidates);
}

function shouldIgnoreWatchPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");

  if (normalized === "") {
    return false;
  }

  if (
    normalized.startsWith(".git/") ||
    normalized.startsWith(".erp-") ||
    normalized.includes("/.erp-") ||
    normalized.startsWith("coverage/") ||
    normalized.includes("/coverage/") ||
    normalized.startsWith("dist/") ||
    normalized.includes("/dist/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/")
  ) {
    return true;
  }

  return /(^|\/)(?:electron\.)?vite\.config\.\d+\.mjs$/.test(normalized);
}

async function ensureViteServer(options) {
  const { cwd, logger, vitePort } = options;

  if (await isPortOpen(vitePort)) {
    logger.info(`Using the existing Vite dev server on port ${vitePort}.`);
    return {
      async close() {}
    };
  }

  const viteConfig = await findViteConfig(cwd);
  let vite;

  try {
    vite = await loadModuleFromCwd("vite", cwd);
  } catch (error) {
    throw new Error(
      `No Vite dev server is listening on port ${vitePort}, and Vite could not be resolved from ${cwd}. Install Vite in the project or start it manually first.`
    );
  }
  let serverConfig;

  if (viteConfig && path.basename(viteConfig).startsWith("electron.vite.config.")) {
    const electronViteConfig = await loadConfigFile(viteConfig);
    const rendererConfig = electronViteConfig && electronViteConfig.renderer ? electronViteConfig.renderer : {};

    serverConfig = vite.mergeConfig(rendererConfig, {
      configFile: false,
      root: cwd,
      server: {
        host: "127.0.0.1",
        port: vitePort,
        strictPort: true
      }
    });
  } else {
    serverConfig = {
      configFile: viteConfig || undefined,
      root: cwd,
      server: {
        host: "127.0.0.1",
        port: vitePort,
        strictPort: true
      }
    };
  }

  const server = await vite.createServer(serverConfig);

  await server.listen();
  logger.info(`Started Vite on 127.0.0.1:${vitePort}${viteConfig ? ` using ${path.basename(viteConfig)}` : ""}.`);

  return {
    async close() {
      await server.close();
    }
  };
}

function patchConsole(wsServer) {
  const original = {
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console)
  };

  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      wsServer.broadcast({
        type: "console",
        channel: level,
        args: args.map((value) => toWireValue(value))
      });

      return original[level](...args);
    };
  }

  return () => {
    for (const [level, method] of Object.entries(original)) {
      console[level] = method;
    }
  };
}

function waitForSignal(cleanup) {
  return new Promise((resolve) => {
    let closed = false;

    async function onSignal(signal) {
      if (closed) {
        return;
      }

      closed = true;
      await cleanup(signal);
      resolve();
    }

    process.once("SIGINT", () => {
      void onSignal("SIGINT");
    });

    process.once("SIGTERM", () => {
      void onSignal("SIGTERM");
    });
  });
}

async function createStartRuntime(options = {}) {
  const cwd = options.cwd || process.cwd();
  const logger = options.logger || createLogger();
  const port = options.port || 7700;
  const vitePort = options.vitePort || 5173;
  const broadcastLocalConsole = options.broadcastLocalConsole !== false;
  const mainReloadDebounceMs = options.mainReloadDebounceMs || 150;

  let closing = false;
  let loggedNoopBridge = false;
  let mainHost = null;
  let mainLoadChain = Promise.resolve();
  let refreshElectronViteArtifacts = false;
  let reloadTimer = null;
  let viteServer = null;
  let watcher = null;
  let wsServer = null;

  function attachHost(host) {
    host.on("console", (message) => {
      wsServer.broadcast({
        type: "console",
        channel: message.channel,
        args: message.args.map((value) => toWireValue(value))
      });

      logger.info(`[main:${message.channel}] ${message.args.map((value) => formatValue(value)).join(" ")}`);
    });

    host.on("ready", (message) => {
      const relativePath = path.relative(cwd, message.entryPath);
      const verb = message.reason === "initial-load" ? "Loaded" : "Reloaded";

      logger.info(
        message.channels.length > 0
          ? `${verb} ${relativePath}; captured ${message.channels.length} ipcMain.handle() channel${message.channels.length === 1 ? "" : "s"}: ${message.channels.join(", ")}`
          : `${verb} ${relativePath} without any ipcMain.handle() registrations.`
      );
    });

    host.on("warning", (message) => {
      logger.warn(message);
    });

    host.on("context-bridge-expose", (message) => {
      wsServer.broadcast({
        type: "context-bridge-expose",
        channel: message.channel,
        schema: message.schema
      });
    });
  }

  async function performLoadOrReloadMain(reason) {
    const prepared = await prepareMainEntry(cwd, {
      forceElectronViteBuild: refreshElectronViteArtifacts,
      logger,
      preferElectronViteBuild: true
    });
    const nextEntry = prepared ? prepared.entryPath : null;

    refreshElectronViteArtifacts = Boolean(prepared && prepared.usesElectronVitePackageMain);

    if (!nextEntry) {
      if (!loggedNoopBridge) {
        logger.info("No Electron main entry was detected. ERP will run with a no-op IPC bridge.");
        loggedNoopBridge = true;
      }

      if (mainHost) {
        await mainHost.close();
        mainHost = null;
      }

      return {
        channels: [],
        entryPath: null
      };
    }

    loggedNoopBridge = false;

    if (!mainHost) {
      logger.info(`Loading Electron main entry ${path.relative(cwd, nextEntry)} for IPC capture.`);
      mainHost = createMainProcessHost({
        cwd,
        logger,
        transport: wsServer
      });
      attachHost(mainHost);
      return mainHost.start(nextEntry);
    }

    return mainHost.reload({
      entryPath: nextEntry,
      reason
    });
  }

  function loadOrReloadMain(reason) {
    const run = async () => performLoadOrReloadMain(reason);
    mainLoadChain = mainLoadChain.then(run, run);
    return mainLoadChain;
  }

  function scheduleMainReload(reason) {
    if (closing) {
      return;
    }

    if (reloadTimer) {
      clearTimeout(reloadTimer);
    }

    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void loadOrReloadMain(reason).catch((error) => {
        logger.warn(`Main entry reload failed: ${error.message}`);
      });
    }, mainReloadDebounceMs);
  }

  try {
    wsServer = await createWsServer({
      logger,
      onClientConnected({ clientId }) {
        setTimeout(() => {
          if (!mainHost || !wsServer) {
            return;
          }

          for (const exposure of mainHost.listContextBridges()) {
            wsServer.sendToClient(clientId, {
              type: "context-bridge-expose",
              channel: exposure.channel,
              schema: exposure.schema
            });
          }
        }, 25);
      },
      onConsoleMessage(message) {
        logger.renderer(message.channel, message.args);
      },
      onContextBridgeCall: async ({ args, channel, clientId, path }) => {
        if (!mainHost) {
          throw new Error(`No context bridge exposure found for "${channel}".`);
        }

        return mainHost.callContextBridge(channel, path, args, clientId);
      },
      onContextBridgeSnapshot: async () => {
        return mainHost ? mainHost.listContextBridges() : [];
      },
      onContextBridgeSync: async ({ args, channel, clientId, path }) => {
        if (!mainHost) {
          throw new Error(`No context bridge exposure found for "${channel}".`);
        }

        return mainHost.callContextBridgeSync(channel, path, args, clientId);
      },
      onInvoke: async ({ args, channel, clientId }) => {
        if (!mainHost) {
          throw new Error(`No ipcMain.handle() registration found for channel "${channel}".`);
        }

        return mainHost.invoke(channel, args, clientId);
      },
      onSend: async ({ args, channel, clientId }) => {
        if (!mainHost) {
          throw new Error(`No ipcMain.on() registration found for channel "${channel}".`);
        }

        await mainHost.send(channel, args, clientId);
      },
      onSync: async ({ args, channel, clientId }) => {
        if (!mainHost) {
          throw new Error(`No ipcMain.on() registration found for channel "${channel}".`);
        }

        return mainHost.sendSync(channel, args, clientId);
      },
      port
    });

    const restoreConsole = broadcastLocalConsole ? patchConsole(wsServer) : () => {};
    viteServer = await ensureViteServer({ cwd, logger, vitePort });
    watcher = chokidar.watch(cwd, {
      ignored: (targetPath) => shouldIgnoreWatchPath(path.relative(cwd, targetPath)),
      ignoreInitial: true
    });

    watcher.on("all", (event, changedPath) => {
      const relativePath = path.relative(cwd, changedPath);

      if (shouldIgnoreWatchPath(relativePath)) {
        return;
      }

      wsServer.broadcast({
        type: "hmr",
        channel: "file-change",
        args: [
          {
            event,
            path: relativePath
          }
        ]
      });

      scheduleMainReload(`${event}:${relativePath}`);
    });

    await loadOrReloadMain("initial-load").catch((error) => {
      logger.warn(`Main entry load failed: ${error.message}`);
    });

    logger.info(`Watching ${cwd} for file changes.`);

    return {
      cwd,
      logger,
      port,
      vitePort,
      async close() {
        if (closing) {
          return;
        }

        closing = true;

        if (reloadTimer) {
          clearTimeout(reloadTimer);
          reloadTimer = null;
        }

        restoreConsole();
        await Promise.allSettled([
          watcher ? watcher.close() : Promise.resolve(),
          mainHost ? mainHost.close() : Promise.resolve(),
          viteServer ? viteServer.close() : Promise.resolve(),
          wsServer ? wsServer.close() : Promise.resolve()
        ]);
      }
    };
  } catch (error) {
    closing = true;

    if (reloadTimer) {
      clearTimeout(reloadTimer);
      reloadTimer = null;
    }

    await Promise.allSettled([
      watcher ? watcher.close() : Promise.resolve(),
      mainHost ? mainHost.close() : Promise.resolve(),
      viteServer ? viteServer.close() : Promise.resolve(),
      wsServer ? wsServer.close() : Promise.resolve()
    ]);

    throw error;
  }
}

async function runStartCommand(options) {
  const runtime = await createStartRuntime(options);
  const connectHost = await detectConnectHost();

  runtime.logger.info(
    `Connect with: ${buildConnectCommand({
      host: connectHost,
      port: runtime.port,
      username: os.userInfo().username,
      vitePort: runtime.vitePort
    })}`
  );

  await waitForSignal(async (signal) => {
    runtime.logger.info(`Shutting down ERP (${signal}).`);
    await runtime.close();
  });
}

module.exports = {
  buildConnectCommand,
  buildRemoteStartCommand,
  buildElectronViteMainArtifacts,
  createStartRuntime,
  detectConnectHost,
  isPortOpen,
  prepareMainEntry,
  resolveMainEntry,
  runStartCommand,
  shouldIgnoreWatchPath,
  waitForPort
};
