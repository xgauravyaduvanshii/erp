"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const { inspect } = require("node:util");

const chalk = require("chalk");

const { launchElectronShell } = require("./electron-shell");
const { createSshTunnel, expandHomePath, parseSshTarget, shellEscape } = require("./ssh-tunnel");
const { buildRemoteStartCommand } = require("./start");
const { createWsClient } = require("./ws-client");

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
    remote(level, args) {
      const color = level === "error" ? chalk.red : level === "warn" ? chalk.yellow : chalk.gray;
      const rendered = args.map((value) => formatValue(value)).join(" ");
      process.stdout.write(`${color("[remote]")} ${rendered}\n`);
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

function probeLocalListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(null);
    });

    server.listen(port, "127.0.0.1", () => {
      const address = server.address();

      server.close(() => {
        resolve(address.port);
      });
    });
  });
}

async function findAvailableLocalPort(preferredPort, usedPorts = new Set()) {
  if (!usedPorts.has(preferredPort)) {
    const reservedPreferred = await probeLocalListen(preferredPort);

    if (reservedPreferred === preferredPort) {
      return preferredPort;
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const reservedPort = await probeLocalListen(0);

    if (reservedPort && !usedPorts.has(reservedPort)) {
      return reservedPort;
    }
  }

  throw new Error(`Could not find a free local port for requested port ${preferredPort}.`);
}

async function resolveLocalTunnelPorts(options) {
  const usedPorts = new Set();
  const localVitePort = await findAvailableLocalPort(options.vitePort, usedPorts);
  usedPorts.add(localVitePort);
  const localPort = await findAvailableLocalPort(options.port, usedPorts);

  return {
    localPort,
    localVitePort
  };
}

async function probeRemotePort(tunnel, port) {
  try {
    await tunnel.exec(`bash -lc ${shellEscape(`: > /dev/tcp/127.0.0.1/${port}`)}`);
    return true;
  } catch (error) {
    return false;
  }
}

async function waitForRemotePort(tunnel, port, timeoutMs = 20_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await probeRemotePort(tunnel, port)) {
      return true;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  throw new Error(`Timed out waiting for remote port 127.0.0.1:${port}.`);
}

async function ensureRemoteProjectRuntime(options) {
  const { logger, port, project, tunnel, vitePort } = options;
  const remotePath = await tunnel.exec(`cd ${shellEscape(project)} && pwd`);

  logger.info(`Validated remote project path: ${remotePath}`);

  const bridgeReady = await probeRemotePort(tunnel, port);
  const viteReady = await probeRemotePort(tunnel, vitePort);

  if (!bridgeReady) {
    const command = buildRemoteStartCommand({
      port,
      project: remotePath,
      vitePort
    });
    const pid = await tunnel.exec(`bash -lc ${shellEscape(command)}`);

    logger.info(`Started remote ERP bridge${pid ? ` (pid ${pid.trim()})` : ""}.`);
  }

  if (!bridgeReady) {
    await waitForRemotePort(tunnel, port);
  }

  if (!viteReady) {
    await waitForRemotePort(tunnel, vitePort);
  }

  return remotePath;
}

async function runConnectCommand(target, options) {
  const logger = createLogger();
  const parsedTarget = parseSshTarget(target);
  const port = options.port || 7700;
  const vitePort = options.vitePort || 5173;
  const { localPort, localVitePort } = await resolveLocalTunnelPorts({ port, vitePort });
  const keyPath = options.key ? expandHomePath(options.key) : null;
  const privateKey = keyPath ? await fs.readFile(keyPath, "utf8") : undefined;
  const tunnel = createSshTunnel({
    forwards: [
      { localPort: localVitePort, remoteHost: "127.0.0.1", remotePort: vitePort },
      { localPort, remoteHost: "127.0.0.1", remotePort: port }
    ],
    host: parsedTarget.host,
    port: parsedTarget.port,
    privateKey,
    username: parsedTarget.username
  });
  const wsClient = createWsClient({ logger, port: localPort });
  let shell = null;

  if (localVitePort !== vitePort) {
    logger.warn(`Local port ${vitePort} is busy. Using localhost:${localVitePort} for the remote Vite preview instead.`);
  }

  if (localPort !== port) {
    logger.warn(`Local port ${port} is busy. Using localhost:${localPort} for the ERP WebSocket tunnel instead.`);
  }

  tunnel.on("ready", () => {
    logger.info(
      `SSH tunnel ready: localhost:${localVitePort} -> ${parsedTarget.host}:${vitePort}, localhost:${localPort} -> ${parsedTarget.host}:${port}.`
    );
  });

  tunnel.on("disconnected", () => {
    logger.warn("SSH tunnel dropped. Reconnecting...");
  });

  tunnel.on("error", (error) => {
    logger.warn(`SSH connection error: ${error.message}`);
  });

  wsClient.on("open", () => {
    logger.info(`ERP WebSocket connected on localhost:${localPort}.`);
  });

  wsClient.on("reconnecting", () => {
    logger.warn("ERP WebSocket disconnected. Waiting for the tunnel to reconnect...");
  });

  wsClient.on("error", (error) => {
    if (error && error.code === "ECONNREFUSED") {
      return;
    }

    logger.warn(`ERP WebSocket error: ${error.message}`);
  });

  wsClient.on("console", (message) => {
    logger.remote(message.channel, message.args);
  });

  wsClient.on("hmr", (message) => {
    const payload = message.args[0];

    if (payload && payload.path) {
      logger.info(`File change detected: ${payload.event} ${payload.path}`);
    }
  });

  await tunnel.start();

  if (options.project) {
    await ensureRemoteProjectRuntime({
      logger,
      port,
      project: options.project,
      tunnel,
      vitePort
    });
  }

  wsClient.connect();

  if (options.electron !== false) {
    shell = await launchElectronShell({
      logger,
      title: `ERP Preview - ${target}`,
      url: `http://127.0.0.1:${localVitePort}`,
      wsPort: localPort
    });
  } else {
    logger.info(`Tunnel ready. Open http://127.0.0.1:${localVitePort} in a browser.`);
  }

  logger.info("Press Ctrl+C to close the preview and SSH tunnel.");

  await waitForSignal(async (signal) => {
    logger.info(`Closing ERP connect session (${signal}).`);
    await Promise.allSettled([wsClient.close(), shell ? shell.close() : Promise.resolve(), tunnel.close()]);
  });
}

module.exports = {
  resolveLocalTunnelPorts,
  runConnectCommand
};
