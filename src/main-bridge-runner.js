"use strict";

const { createIpcInterceptor, loadProjectMain } = require("./ipc-interceptor");
const { fromWireValue, serializeError, toWireValue } = require("./ws-server");

const cwd = process.env.ERP_CWD;
const entryPath = process.env.ERP_ENTRY_PATH;
const ipcInterceptor = createIpcInterceptor();

let restoreConsole = () => {};
let runtime = {
  async close() {}
};
let shuttingDown = false;

function send(message) {
  if (typeof process.send === "function") {
    process.send(message);
  }
}

function encodeBridgeMessage(message) {
  return {
    ...message,
    args: Array.isArray(message.args) ? message.args.map((value) => toWireValue(value)) : undefined,
    error: Object.prototype.hasOwnProperty.call(message, "error") ? serializeError(message.error) : undefined,
    result: Object.prototype.hasOwnProperty.call(message, "result") ? toWireValue(message.result) : undefined
  };
}

function patchConsole() {
  const original = {
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console)
  };

  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      send({
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

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  restoreConsole();
  await runtime.close();
  process.exit(0);
}

ipcInterceptor.attachTransport({
  broadcast(message) {
    send({
      type: "bridge-broadcast",
      message: encodeBridgeMessage(message)
    });
  },
  sendToClient(clientId, message) {
    send({
      type: "bridge-message",
      clientId,
      message: encodeBridgeMessage(message)
    });
  }
});

process.once("SIGINT", () => {
  void shutdown();
});

process.once("SIGTERM", () => {
  void shutdown();
});

process.on("uncaughtException", (error) => {
  send({
    type: "runtime-error",
    error: serializeError(error)
  });
  void shutdown();
});

process.on("unhandledRejection", (error) => {
  send({
    type: "runtime-error",
    error: serializeError(error)
  });
  void shutdown();
});

process.on("message", async (message) => {
  if (!message || typeof message !== "object") {
    return;
  }

  if (
    message.type === "invoke" ||
    message.type === "send" ||
    message.type === "sync" ||
    message.type === "context-bridge-call" ||
    message.type === "context-bridge-sync"
  ) {
    try {
      const args = Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : [];
      let result;

      if (message.type === "invoke") {
        result = await ipcInterceptor.invoke(message.channel, args, message.clientId);
      } else if (message.type === "send") {
        result = await ipcInterceptor.send(message.channel, args, message.clientId);
      } else if (message.type === "sync") {
        result = ipcInterceptor.sendSync(message.channel, args, message.clientId);
      } else if (message.type === "context-bridge-call") {
        result = await runtime.callContextBridge(
          message.channel,
          Array.isArray(message.path) ? message.path : [],
          args,
          message.clientId
        );
      } else {
        result = runtime.callContextBridgeSync(
          message.channel,
          Array.isArray(message.path) ? message.path : [],
          args,
          message.clientId
        );
      }

      send({
        type: "request-result",
        requestId: message.requestId,
        result: toWireValue(result)
      });
    } catch (error) {
      send({
        type: "request-error",
        requestId: message.requestId,
        error: serializeError(error)
      });
    }

    return;
  }

  if (message.type === "shutdown") {
    await shutdown();
  }
});

async function boot() {
  restoreConsole = patchConsole();

  runtime = await loadProjectMain({
    cwd,
    entryPath,
    ipcInterceptor,
    onContextBridgeExpose(name, schema) {
      send({
        type: "context-bridge-expose",
        channel: name,
        schema
      });
    },
    transport: {
      broadcast(message) {
        send({
          type: "bridge-broadcast",
          message: encodeBridgeMessage(message)
        });
      },
      sendToClient(clientId, message) {
        send({
          type: "bridge-message",
          clientId,
          message: encodeBridgeMessage(message)
        });
      }
    }
  });

  send({
    type: "ready",
    channels: ipcInterceptor.listChannels()
  });
}

boot().catch((error) => {
  send({
    type: "load-error",
    error: serializeError(error)
  });
  process.exit(1);
});
