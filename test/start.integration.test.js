const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const WebSocket = require("ws");

const { createStartRuntime } = require("../src/start");

const silentLogger = {
  error() {},
  info() {},
  renderer() {},
  warn() {}
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
}

function connectWebSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function createMessageQueue(socket) {
  const queued = [];
  const waiters = [];

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));

    if (waiterIndex >= 0) {
      const waiter = waiters.splice(waiterIndex, 1)[0];
      clearTimeout(waiter.timeout);
      waiter.resolve(message);
      return;
    }

    queued.push(message);
  });

  return {
    next(predicate, timeoutMs = 4_000) {
      const queuedIndex = queued.findIndex((message) => predicate(message));

      if (queuedIndex >= 0) {
        return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const waiterIndex = waiters.findIndex((waiter) => waiter.resolve === resolve);

          if (waiterIndex >= 0) {
            waiters.splice(waiterIndex, 1);
          }

          reject(new Error(`Timed out waiting for message after ${timeoutMs}ms.`));
        }, timeoutMs);

        waiters.push({ predicate, reject, resolve, timeout });
      });
    }
  };
}

async function waitForReload(queue, socket, expectedResult) {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < 6_000) {
    attempt += 1;
    const id = `reload-${attempt}`;
    socket.send(
      JSON.stringify({
        id,
        type: "ipc-invoke",
        channel: "ping",
        args: []
      })
    );
    const response = await queue.next((message) => message.type === "ipc-response" && message.id === id, 2_000);

    if (response.result === expectedResult) {
      return response;
    }

    await wait(100);
  }

  throw new Error(`Timed out waiting for IPC handler reload to produce ${expectedResult}.`);
}

async function nextResponse(queue, id, type = "ipc-response") {
  return queue.next((message) => message.type === type && message.id === id, 4_000);
}

test("createStartRuntime reloads captured ipcMain handlers after main file changes", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "erp-runtime-"));
  const port = await getFreePort();
  const vitePort = await getFreePort();
  const mainPath = path.join(cwd, "main.js");
  const httpServer = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>ok</body></html>");
  });

  async function writeMain(version) {
    await fs.writeFile(
      mainPath,
      `"use strict";
const { app, ipcMain } = require("electron");

app.whenReady().then(() => {
  ipcMain.handle("ping", async () => "${version}");
  ipcMain.handle("push", async (event, payload) => {
    event.sender.send("pong", payload + "-${version}");
    return "sent-${version}";
  });
});
`,
      "utf8"
    );
  }

  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ main: "main.js" }, null, 2));
  await writeMain("v1");
  await listen(httpServer, vitePort);

  t.after(async () => {
    await fs.rm(cwd, { force: true, recursive: true });
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  const runtime = await createStartRuntime({
    broadcastLocalConsole: false,
    cwd,
    logger: silentLogger,
    mainReloadDebounceMs: 75,
    port,
    vitePort
  });

  t.after(async () => {
    await runtime.close();
  });

  const socket = await connectWebSocket(port);
  const queue = createMessageQueue(socket);

  t.after(() => {
    socket.close();
  });

  socket.send(JSON.stringify({ id: "ping-1", type: "ipc-invoke", channel: "ping", args: [] }));
  const firstResponse = await queue.next((message) => message.type === "ipc-response" && message.id === "ping-1");
  assert.equal(firstResponse.result, "v1");

  socket.send(JSON.stringify({ id: "push-1", type: "ipc-invoke", channel: "push", args: ["hello"] }));
  const eventMessage = await queue.next((message) => message.type === "ipc-event" && message.channel === "pong");
  assert.deepEqual(eventMessage.args, ["hello-v1"]);
  const pushResponse = await queue.next((message) => message.type === "ipc-response" && message.id === "push-1");
  assert.equal(pushResponse.result, "sent-v1");

  await writeMain("v2");

  const hmrMessage = await queue.next(
    (message) =>
      message.type === "hmr" &&
      message.channel === "file-change" &&
      Array.isArray(message.args) &&
      message.args[0] &&
      message.args[0].path === "main.js"
  );

  assert.equal(hmrMessage.args[0].event, "change");

  const reloadedResponse = await waitForReload(queue, socket, "v2");
  assert.equal(reloadedResponse.result, "v2");
});

test("createStartRuntime supports ipcMain.on, sendSync, contextBridge, webContents.send, and native module warnings", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "erp-patterns-"));
  const port = await getFreePort();
  const vitePort = await getFreePort();
  const logMessages = [];
  const logger = {
    error(message) {
      logMessages.push(`error:${message}`);
    },
    info(message) {
      logMessages.push(`info:${message}`);
    },
    renderer() {},
    warn(message) {
      logMessages.push(`warn:${message}`);
    }
  };
  const httpServer = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>ok</body></html>");
  });

  await fs.writeFile(path.join(cwd, "native-addon.node"), "");
  await fs.writeFile(
    path.join(cwd, "preload.js"),
    `"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridgeApi", {
  version: "1.0.0",
  greet(name) {
    return "hello " + name;
  },
  async asyncPing(value) {
    return ipcRenderer.invoke("async-ping", value);
  },
  syncPing(value) {
    return ipcRenderer.sendSync("sync-ping", value);
  },
  fire(value) {
    ipcRenderer.send("one-way", value);
    return "fired";
  }
});
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "main.js"),
    `"use strict";
const path = require("node:path");
const nativeAddon = require("./native-addon.node");
const { app, BrowserWindow, ipcMain } = require("electron");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  ipcMain.handle("async-ping", async (event, value) => value + "-async");
  ipcMain.on("one-way", (event, value) => {
    event.sender.send("ack", value + "-ack");
    win.webContents.send("broadcast", value + "-broadcast");
  });
  ipcMain.on("sync-ping", (event, value) => {
    event.returnValue = value + "-sync";
  });
  ipcMain.handle("native-check", async () => typeof nativeAddon);
});
`,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ main: "main.js" }, null, 2));
  await listen(httpServer, vitePort);

  t.after(async () => {
    await fs.rm(cwd, { force: true, recursive: true });
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  const runtime = await createStartRuntime({
    broadcastLocalConsole: false,
    cwd,
    logger,
    port,
    vitePort
  });

  t.after(async () => {
    await runtime.close();
  });

  const socket = await connectWebSocket(port);
  const queue = createMessageQueue(socket);

  t.after(() => {
    socket.close();
  });

  const exposure = await queue.next(
    (message) => message.type === "context-bridge-expose" && message.channel === "bridgeApi",
    4_000
  );
  assert.equal(exposure.channel, "bridgeApi");
  assert.ok(exposure.schema);

  socket.send(
    JSON.stringify({
      id: "bridge-call-1",
      type: "context-bridge-call",
      channel: "bridgeApi",
      path: ["greet"],
      args: ["codex"]
    })
  );
  const bridgeCall = await nextResponse(queue, "bridge-call-1", "context-bridge-response");
  assert.equal(bridgeCall.result, "hello codex");

  socket.send(
    JSON.stringify({
      id: "bridge-call-2",
      type: "context-bridge-call",
      channel: "bridgeApi",
      path: ["asyncPing"],
      args: ["demo"]
    })
  );
  const bridgeAsync = await nextResponse(queue, "bridge-call-2", "context-bridge-response");
  assert.equal(bridgeAsync.result, "demo-async");

  socket.send(
    JSON.stringify({
      id: "bridge-sync-1",
      type: "context-bridge-sync",
      channel: "bridgeApi",
      path: ["syncPing"],
      args: ["demo"]
    })
  );
  const bridgeSync = await nextResponse(queue, "bridge-sync-1", "context-bridge-response");
  assert.equal(bridgeSync.result, "demo-sync");

  socket.send(
    JSON.stringify({
      id: "send-1",
      type: "ipc-send",
      channel: "one-way",
      args: ["hello"]
    })
  );
  const ackEvent = await queue.next((message) => message.type === "ipc-event" && message.channel === "ack", 4_000);
  assert.deepEqual(ackEvent.args, ["hello-ack"]);
  const broadcastEvent = await queue.next(
    (message) => message.type === "ipc-event" && message.channel === "broadcast",
    4_000
  );
  assert.deepEqual(broadcastEvent.args, ["hello-broadcast"]);

  socket.send(
    JSON.stringify({
      id: "sync-1",
      type: "ipc-sync",
      channel: "sync-ping",
      args: ["hello"]
    })
  );
  const syncResponse = await nextResponse(queue, "sync-1");
  assert.equal(syncResponse.result, "hello-sync");

  socket.send(
    JSON.stringify({
      id: "invoke-native",
      type: "ipc-invoke",
      channel: "native-check",
      args: []
    })
  );
  const nativeResponse = await nextResponse(queue, "invoke-native");
  assert.equal(nativeResponse.result, "function");
  assert.ok(logMessages.some((entry) => entry.includes("Native module")));
});

test("createStartRuntime falls back to standalone preload bundles when no BrowserWindow preload runs", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "erp-standalone-preload-"));
  const port = await getFreePort();
  const vitePort = await getFreePort();
  const httpServer = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>ok</body></html>");
  });

  await fs.mkdir(path.join(cwd, "dist", "main"), { recursive: true });
  await fs.mkdir(path.join(cwd, "dist", "preload"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify(
      {
        main: "./dist/main/index.js"
      },
      null,
      2
    )
  );
  await fs.writeFile(
    path.join(cwd, "dist", "main", "index.js"),
    `"use strict";
const { app, ipcMain } = require("electron");

app.whenReady().then(() => {
  ipcMain.on("get-platform", (event) => {
    event.returnValue = "linux";
  });
});
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "dist", "preload", "index.cjs"),
    `"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getPlatform: () => ipcRenderer.sendSync("get-platform")
});
`,
    "utf8"
  );
  await listen(httpServer, vitePort);

  t.after(async () => {
    await fs.rm(cwd, { force: true, recursive: true });
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  const runtime = await createStartRuntime({
    broadcastLocalConsole: false,
    cwd,
    logger: silentLogger,
    port,
    vitePort
  });

  t.after(async () => {
    await runtime.close();
  });

  const socket = await connectWebSocket(port);
  const queue = createMessageQueue(socket);

  t.after(() => {
    socket.close();
  });

  const exposure = await queue.next((message) => message.type === "context-bridge-expose" && message.channel === "api");
  assert.equal(exposure.channel, "api");

  socket.send(
    JSON.stringify({
      id: "standalone-preload-platform",
      type: "context-bridge-sync",
      channel: "api",
      path: ["getPlatform"],
      args: []
    })
  );

  const response = await nextResponse(queue, "standalone-preload-platform", "context-bridge-response");
  assert.equal(response.result, "linux");
});

test("createStartRuntime tolerates preload scripts that register DOMContentLoaded listeners", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "erp-preload-window-"));
  const port = await getFreePort();
  const vitePort = await getFreePort();
  const logMessages = [];
  const logger = {
    error(message) {
      logMessages.push(`error:${message}`);
    },
    info(message) {
      logMessages.push(`info:${message}`);
    },
    renderer() {},
    warn(message) {
      logMessages.push(`warn:${message}`);
    }
  };
  const httpServer = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>ok</body></html>");
  });

  await fs.writeFile(
    path.join(cwd, "preload.js"),
    `"use strict";
window.addEventListener("DOMContentLoaded", () => {});
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "main.js"),
    `"use strict";
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });
});
`,
    "utf8"
  );
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ main: "main.js" }, null, 2));
  await listen(httpServer, vitePort);

  t.after(async () => {
    await fs.rm(cwd, { force: true, recursive: true });
  });
  t.after(async () => {
    await new Promise((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });

  const runtime = await createStartRuntime({
    broadcastLocalConsole: false,
    cwd,
    logger,
    port,
    vitePort
  });

  t.after(async () => {
    await runtime.close();
  });

  assert.equal(logMessages.some((entry) => entry.includes("window.addEventListener")), false);
});
