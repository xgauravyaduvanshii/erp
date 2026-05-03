"use strict";

function buildPreloadScript(options) {
  const wsPort = Number.parseInt(String(options.wsPort), 10) || 7700;
  const wsModulePath = JSON.stringify(String(options.wsModulePath || require.resolve("ws")));
  const syncChildSource = `
"use strict";

const WebSocket = require(process.argv[1]);
const wsUrl = process.argv[2];
const responseType = process.argv[3];
const message = JSON.parse(process.argv[4]);
const timeoutMs = Number.parseInt(process.argv[5], 10) || 10000;
let completed = false;

function finish(status, payload) {
  if (completed) {
    return;
  }

  completed = true;
  process.stdout.write(JSON.stringify({ payload, status }));
  process.exit(status === 1 ? 0 : 1);
}

const timer = setTimeout(() => {
  finish(2, {
    message: "ERP sync IPC timed out.",
    name: "Error"
  });

  if (socket && typeof socket.terminate === "function") {
    socket.terminate();
  }
}, timeoutMs);

let socket;

try {
  socket = new WebSocket(wsUrl);
} catch (error) {
  clearTimeout(timer);
  finish(2, {
    message: error.message,
    name: error.name || "Error",
    stack: error.stack
  });
}

if (socket) {
  socket.on("open", () => {
    socket.send(JSON.stringify(message));
  });

  socket.on("message", (raw) => {
    let response;

    try {
      response = JSON.parse(raw.toString());
    } catch (error) {
      return;
    }

    if (!response || response.id !== message.id || response.type !== responseType) {
      return;
    }

    clearTimeout(timer);
    finish(1, response);
    socket.close();
  });

  socket.on("error", (error) => {
    clearTimeout(timer);
    finish(2, {
      message: error.message,
      name: error.name || "Error",
      stack: error.stack
    });
  });

  socket.on("close", () => {
    clearTimeout(timer);

    if (!completed) {
      finish(2, {
        message: "ERP bridge disconnected.",
        name: "Error"
      });
    }
  });
}
`;

  return `"use strict";

const electron = require("electron");
const { spawnSync } = require("node:child_process");
const proxiedIpcRenderer = electron.ipcRenderer;
const wsUrl = "ws://127.0.0.1:${wsPort}";
const wsModulePath = ${wsModulePath};
const syncChildSource = ${JSON.stringify(syncChildSource)};
const listeners = new Map();
const pendingRequests = new Map();
const queuedMessages = [];
const originalConsole = {
  error: console.error.bind(console),
  info: console.info.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console)
};

let clientIdentity = null;
let reconnectTimer = null;
let sequence = 0;
let socket = null;
let socketOpen = false;
let shuttingDown = false;

function nextId(prefix) {
  sequence += 1;
  return prefix + "-" + Date.now() + "-" + sequence;
}

function toWireValue(value, seen = new WeakSet()) {
  if (value === undefined) {
    return { __erpType: "undefined" };
  }

  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return { __erpType: "bigint", value: value.toString() };
  }

  if (typeof value === "symbol") {
    return { __erpType: "symbol", value: value.toString() };
  }

  if (typeof value === "function") {
    return { __erpType: "function", value: value.name || "anonymous" };
  }

  if (value instanceof Date) {
    return { __erpType: "date", value: value.toISOString() };
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return { __erpType: "buffer", value: value.toString("base64") };
  }

  if (value instanceof Error) {
    return {
      __erpType: "error",
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => toWireValue(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return { __erpType: "circular", value: "[Circular]" };
    }

    seen.add(value);
    const output = {};

    for (const [key, nested] of Object.entries(value)) {
      output[key] = toWireValue(nested, seen);
    }

    seen.delete(value);
    return output;
  }

  return String(value);
}

function fromWireValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => fromWireValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  switch (value.__erpType) {
    case "undefined":
      return undefined;
    case "bigint":
      return BigInt(value.value);
    case "symbol":
      return value.value;
    case "function":
      return "[Function " + value.value + "]";
    case "date":
      return new Date(value.value);
    case "buffer":
      return typeof Buffer !== "undefined" ? Buffer.from(value.value, "base64") : value.value;
    case "circular":
      return value.value;
    case "error": {
      const error = new Error(value.message || "ERP IPC error");
      error.name = value.name || "Error";

      if (value.stack) {
        error.stack = value.stack;
      }

      return error;
    }
    default: {
      const output = {};

      for (const [key, nested] of Object.entries(value)) {
        if (key === "__erpType") {
          continue;
        }

        output[key] = fromWireValue(nested);
      }

      return output;
    }
  }
}

function flushQueue() {
  while (socketOpen && socket && queuedMessages.length > 0) {
    socket.send(queuedMessages.shift());
  }
}

function rejectPending(message) {
  for (const [id, pending] of pendingRequests.entries()) {
    pendingRequests.delete(id);
    pending.reject(new Error(message));
  }
}

function dispatchEvent(channel, args) {
  const handlers = listeners.get(channel);

  if (!handlers || handlers.size === 0) {
    return;
  }

  for (const handler of Array.from(handlers)) {
    try {
      handler({ channel, sender: proxiedIpcRenderer }, ...args);
    } catch (error) {
      originalConsole.error(error);
    }
  }
}

function sendMessage(message) {
  const payload = JSON.stringify(message);

  if (socketOpen && socket) {
    socket.send(payload);
    return;
  }

  queuedMessages.push(payload);
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1200);
}

function resolvePending(message) {
  const pending = pendingRequests.get(message.id);

  if (!pending || pending.responseType !== message.type) {
    return false;
  }

  pendingRequests.delete(message.id);

  if (message.error) {
    pending.reject(fromWireValue(message.error));
    return true;
  }

  pending.resolve(typeof pending.transform === "function" ? pending.transform(message.result) : fromWireValue(message.result));
  return true;
}

function buildContextBridgeValue(channel, schema, currentPath) {
  if (!schema || typeof schema !== "object") {
    return undefined;
  }

  if (schema.type === "object") {
    const output = {};
    const entries = schema.entries || {};

    for (const [key, nested] of Object.entries(entries)) {
      output[key] = buildContextBridgeValue(channel, nested, currentPath.concat(key));
    }

    return output;
  }

  if (schema.type === "function") {
    if (schema.async) {
      return (...args) =>
        sendRequest(
          {
            id: nextId("context-bridge"),
            type: "context-bridge-call",
            channel,
            path: currentPath,
            args: args.map((value) => toWireValue(value))
          },
          "context-bridge-response"
        );
    }

    return (...args) => {
      const response = runSyncRequest(
        {
          id: nextId("context-bridge"),
          type: "context-bridge-sync",
          channel,
          path: currentPath,
          args: args.map((value) => toWireValue(value)),
          originClientId: clientIdentity || undefined
        },
        "context-bridge-response"
      );

      if (response.error) {
        throw fromWireValue(response.error);
      }

      return fromWireValue(response.result);
    };
  }

  return fromWireValue(schema.value);
}

function installContextBridge(channel, schema) {
  globalThis[channel] = buildContextBridgeValue(channel, schema, []);
}

function handleSocketMessage(raw) {
  let message;

  try {
    message = JSON.parse(String(raw.data || raw));
  } catch (error) {
    originalConsole.error(error);
    return;
  }

  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "client-id") {
    clientIdentity = message.result;
    return;
  }

  if (
    message.type === "ipc-response" ||
    message.type === "context-bridge-response" ||
    message.type === "context-bridge-snapshot-response"
  ) {
    if (resolvePending(message)) {
      return;
    }
  }

  if (message.type === "context-bridge-expose") {
    installContextBridge(message.channel, message.schema);
    return;
  }

  if (message.type === "ipc-event") {
    dispatchEvent(message.channel, Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : []);
    return;
  }

  if (message.type === "hmr") {
    dispatchEvent("erp:hmr", Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : []);
  }
}

function sendRequest(message, responseType, transform) {
  return new Promise((resolve, reject) => {
    pendingRequests.set(message.id, {
      reject,
      resolve,
      responseType,
      transform
    });
    sendMessage(message);
  });
}

function runSyncRequest(message, responseType) {
  const child = spawnSync(process.execPath, ["-e", syncChildSource, wsModulePath, wsUrl, responseType, JSON.stringify(message), "10000"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    },
    maxBuffer: 1024 * 1024,
    timeout: 11_000,
    windowsHide: true
  });

  if (child.error) {
    throw child.error;
  }

  if (!child.stdout) {
    throw new Error(child.stderr || "ERP sync IPC returned an empty payload.");
  }

  const envelope = JSON.parse(child.stdout);
  const payload = envelope && envelope.payload ? envelope.payload : null;
  const status = envelope && typeof envelope.status === "number" ? envelope.status : child.status;

  if (status !== 1) {
    const error = new Error((payload && payload.message) || child.stderr || "ERP sync IPC failed.");
    error.name = (payload && payload.name) || "Error";

    if (payload && payload.stack) {
      error.stack = payload.stack;
    }

    throw error;
  }

  return payload;
}

function bootstrapContextBridges() {
  try {
    const response = runSyncRequest(
      {
        id: nextId("context-bridge-snapshot"),
        type: "context-bridge-snapshot"
      },
      "context-bridge-snapshot-response"
    );

    if (response.error) {
      return;
    }

    const exposures = Array.isArray(response.result) ? response.result : [];

    for (const exposure of exposures) {
      if (exposure && exposure.channel && exposure.schema) {
        installContextBridge(exposure.channel, exposure.schema);
      }
    }
  } catch (error) {}
}

function connect() {
  if (shuttingDown) {
    return;
  }

  try {
    socket = new WebSocket(wsUrl);
  } catch (error) {
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    socketOpen = true;
    flushQueue();
  });

  socket.addEventListener("message", (raw) => {
    handleSocketMessage(raw);
  });

  socket.addEventListener("close", () => {
    socketOpen = false;
    rejectPending("ERP bridge disconnected.");
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    socketOpen = false;
    scheduleReconnect();
  });
}

proxiedIpcRenderer.invoke = (channel, ...args) => {
  return sendRequest(
    {
      id: nextId("ipc"),
      type: "ipc-invoke",
      channel,
      args: args.map((value) => toWireValue(value))
    },
    "ipc-response"
  );
};

proxiedIpcRenderer.send = (channel, ...args) => {
  sendMessage({
    id: nextId("ipc-send"),
    type: "ipc-send",
    channel,
    args: args.map((value) => toWireValue(value))
  });

  return proxiedIpcRenderer;
};

proxiedIpcRenderer.sendSync = (channel, ...args) => {
  const response = runSyncRequest(
    {
      id: nextId("ipc-sync"),
      type: "ipc-sync",
      channel,
      args: args.map((value) => toWireValue(value)),
      originClientId: clientIdentity || undefined
    },
    "ipc-response"
  );

  if (response.error) {
    throw fromWireValue(response.error);
  }

  return fromWireValue(response.result);
};

proxiedIpcRenderer.on = (channel, handler) => {
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set());
  }

  listeners.get(channel).add(handler);
  return proxiedIpcRenderer;
};

proxiedIpcRenderer.once = (channel, handler) => {
  function wrapped(event, ...args) {
    proxiedIpcRenderer.removeListener(channel, wrapped);
    return handler(event, ...args);
  }

  return proxiedIpcRenderer.on(channel, wrapped);
};

proxiedIpcRenderer.removeListener = (channel, handler) => {
  const handlers = listeners.get(channel);

  if (handlers) {
    handlers.delete(handler);

    if (handlers.size === 0) {
      listeners.delete(channel);
    }
  }

  return proxiedIpcRenderer;
};

proxiedIpcRenderer.off = proxiedIpcRenderer.removeListener;

proxiedIpcRenderer.removeAllListeners = (channel) => {
  if (typeof channel === "string") {
    listeners.delete(channel);
  } else {
    listeners.clear();
  }

  return proxiedIpcRenderer;
};

electron.ipcRenderer.invoke = proxiedIpcRenderer.invoke;
electron.ipcRenderer.send = proxiedIpcRenderer.send;
electron.ipcRenderer.sendSync = proxiedIpcRenderer.sendSync;
electron.ipcRenderer.on = proxiedIpcRenderer.on;
electron.ipcRenderer.once = proxiedIpcRenderer.once;
electron.ipcRenderer.removeListener = proxiedIpcRenderer.removeListener;
electron.ipcRenderer.off = proxiedIpcRenderer.off;
electron.ipcRenderer.removeAllListeners = proxiedIpcRenderer.removeAllListeners;

for (const level of ["log", "info", "warn", "error"]) {
  console[level] = (...args) => {
    sendMessage({
      id: nextId("console"),
      type: "console",
      channel: level,
      args: args.map((value) => toWireValue(value))
    });

    return originalConsole[level](...args);
  };
}

try {
  electron.ipcRenderer = proxiedIpcRenderer;
} catch (error) {}

globalThis.ipcRenderer = proxiedIpcRenderer;
globalThis.erpIpcRenderer = proxiedIpcRenderer;

bootstrapContextBridges();
connect();

globalThis.addEventListener("beforeunload", () => {
  shuttingDown = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket) {
    socket.close();
  }

  rejectPending("ERP preview window closed.");
});
`;
}

module.exports = {
  buildPreloadScript
};
