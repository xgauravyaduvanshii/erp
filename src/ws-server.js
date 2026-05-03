"use strict";

const { inspect } = require("node:util");

const WebSocket = require("ws");

function serializeError(error) {
  if (error && error.__erpType === "error") {
    return error;
  }

  if (error instanceof Error) {
    const payload = {
      __erpType: "error",
      name: error.name,
      message: error.message,
      stack: error.stack
    };

    for (const [key, value] of Object.entries(error)) {
      payload[key] = toWireValue(value);
    }

    return payload;
  }

  return {
    __erpType: "error",
    name: "Error",
    message: typeof error === "string" ? error : inspect(error, { depth: 4, breakLength: Infinity }),
    stack: undefined
  };
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

  if (Buffer.isBuffer(value)) {
    return { __erpType: "buffer", value: value.toString("base64") };
  }

  if (value instanceof Error) {
    return serializeError(value);
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

  return inspect(value, { depth: 4, breakLength: Infinity });
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
      return `[Function ${value.value}]`;
    case "date":
      return new Date(value.value);
    case "buffer":
      return Buffer.from(value.value, "base64");
    case "circular":
      return value.value;
    case "error": {
      const error = new Error(value.message || "ERP transport error");
      error.name = value.name || "Error";

      if (value.stack) {
        error.stack = value.stack;
      }

      for (const [key, nested] of Object.entries(value)) {
        if (key === "__erpType" || key === "name" || key === "message" || key === "stack") {
          continue;
        }

        error[key] = fromWireValue(nested);
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

function createWsServer(options) {
  const {
    onClientConnected,
    onConsoleMessage,
    onContextBridgeCall,
    onContextBridgeSnapshot,
    onContextBridgeSync,
    onInvoke,
    onSend,
    onSync,
    logger,
    port
  } = options;

  return new Promise((resolve, reject) => {
    let sequence = 0;
    const clients = new Map();
    const wss = new WebSocket.Server({ host: "127.0.0.1", port });
    const keepAliveTimer = setInterval(() => {
      for (const client of clients.values()) {
        if (!client.isAlive) {
          client.socket.terminate();
          continue;
        }

        client.isAlive = false;
        client.socket.ping();
      }
    }, 15_000);

    function nextId(prefix) {
      sequence += 1;
      return `${prefix}-${Date.now()}-${sequence}`;
    }

    function normalizeMessage(message) {
      return {
        ...message,
        id: message.id || nextId(message.type || "message")
      };
    }

    function sendRaw(client, message) {
      if (!client || client.socket.readyState !== WebSocket.OPEN) {
        return false;
      }

      client.socket.send(JSON.stringify(normalizeMessage(message)));
      return true;
    }

    async function handleMessage(client, raw) {
      let message;

      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        logger.warn(`Ignoring malformed WebSocket payload from ${client.id}: ${error.message}`);
        return;
      }

      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "ipc-invoke") {
        const channel = message.channel;
        const args = Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : [];

        try {
          const result = await onInvoke({
            id: message.id,
            channel,
            args,
            clientId: client.id
          });

          sendRaw(client, {
            id: message.id,
            type: "ipc-response",
            channel,
            result: toWireValue(result)
          });
        } catch (error) {
          sendRaw(client, {
            id: message.id,
            type: "ipc-response",
            channel,
            error: serializeError(error)
          });
        }

        return;
      }

      if (message.type === "ipc-send") {
        const channel = message.channel;
        const args = Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : [];

        try {
          await onSend?.({
            id: message.id,
            channel,
            args,
            clientId: message.originClientId || client.id
          });
        } catch (error) {
          logger.warn(`One-way IPC "${channel}" failed: ${error.message}`);
        }

        return;
      }

      if (message.type === "ipc-sync") {
        const channel = message.channel;
        const args = Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : [];

        try {
          const result = await onSync?.({
            id: message.id,
            channel,
            args,
            clientId: message.originClientId || client.id
          });

          sendRaw(client, {
            id: message.id,
            type: "ipc-response",
            channel,
            result: toWireValue(result)
          });
        } catch (error) {
          sendRaw(client, {
            id: message.id,
            type: "ipc-response",
            channel,
            error: serializeError(error)
          });
        }

        return;
      }

      if (message.type === "context-bridge-call") {
        const args = Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : [];

        try {
          const result = await onContextBridgeCall?.({
            id: message.id,
            channel: message.channel,
            path: Array.isArray(message.path) ? message.path : [],
            args,
            clientId: message.originClientId || client.id
          });

          sendRaw(client, {
            id: message.id,
            type: "context-bridge-response",
            channel: message.channel,
            path: message.path,
            result: toWireValue(result)
          });
        } catch (error) {
          sendRaw(client, {
            id: message.id,
            type: "context-bridge-response",
            channel: message.channel,
            path: message.path,
            error: serializeError(error)
          });
        }

        return;
      }

      if (message.type === "context-bridge-sync") {
        const args = Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : [];

        try {
          const result = await onContextBridgeSync?.({
            id: message.id,
            channel: message.channel,
            path: Array.isArray(message.path) ? message.path : [],
            args,
            clientId: message.originClientId || client.id
          });

          sendRaw(client, {
            id: message.id,
            type: "context-bridge-response",
            channel: message.channel,
            path: message.path,
            result: toWireValue(result)
          });
        } catch (error) {
          sendRaw(client, {
            id: message.id,
            type: "context-bridge-response",
            channel: message.channel,
            path: message.path,
            error: serializeError(error)
          });
        }

        return;
      }

      if (message.type === "context-bridge-snapshot") {
        try {
          const result = await onContextBridgeSnapshot?.({
            id: message.id,
            clientId: message.originClientId || client.id
          });

          sendRaw(client, {
            id: message.id,
            type: "context-bridge-snapshot-response",
            result: toWireValue(result || [])
          });
        } catch (error) {
          sendRaw(client, {
            id: message.id,
            type: "context-bridge-snapshot-response",
            error: serializeError(error)
          });
        }

        return;
      }

      if (message.type === "console") {
        const hydratedArgs = Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : [];

        if (typeof onConsoleMessage === "function") {
          onConsoleMessage({
            clientId: client.id,
            channel: message.channel || "log",
            args: hydratedArgs
          });
        }

        api.broadcast(
          {
            id: message.id || nextId("console"),
            type: "console",
            channel: message.channel || "log",
            args: Array.isArray(message.args) ? message.args : []
          },
          { excludeClientId: client.id }
        );

        return;
      }
    }

    const api = {
      port,
      sendToClient(clientId, message) {
        return sendRaw(clients.get(clientId), message);
      },
      broadcast(message, options = {}) {
        const normalized = normalizeMessage(message);

        for (const client of clients.values()) {
          if (options.excludeClientId && options.excludeClientId === client.id) {
            continue;
          }

          sendRaw(client, normalized);
        }
      },
      broadcastConsole(channel, args, options = {}) {
        api.broadcast(
          {
            type: "console",
            channel,
            args: args.map((value) => toWireValue(value))
          },
          options
        );
      },
      close() {
        clearInterval(keepAliveTimer);

        for (const client of clients.values()) {
          client.socket.close();
        }

        return new Promise((resolveClose, rejectClose) => {
          wss.close((error) => {
            if (error) {
              rejectClose(error);
              return;
            }

            resolveClose();
          });
        });
      }
    };

    wss.once("error", reject);

    wss.on("connection", (socket, request) => {
      const client = {
        id: `client-${nextId("ws")}`,
        isAlive: true,
        request,
        socket
      };

      clients.set(client.id, client);
      socket.on("pong", () => {
        client.isAlive = true;
      });
      socket.on("close", () => {
        clients.delete(client.id);
      });
      socket.on("error", (error) => {
        logger.warn(`WebSocket client ${client.id} error: ${error.message}`);
      });
      socket.on("message", async (raw) => {
        await handleMessage(client, raw);
      });

      sendRaw(client, {
        type: "client-id",
        result: client.id
      });

      if (typeof onClientConnected === "function") {
        onClientConnected({
          clientId: client.id
        });
      }
    });

    wss.once("listening", () => {
      logger.info(`WebSocket bridge listening on 127.0.0.1:${port}.`);
      resolve(api);
    });
  });
}

module.exports = {
  createWsServer,
  fromWireValue,
  serializeError,
  toWireValue
};
