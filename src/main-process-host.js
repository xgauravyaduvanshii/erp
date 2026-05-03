"use strict";

const { EventEmitter } = require("node:events");
const { fork } = require("node:child_process");
const path = require("node:path");

const { fromWireValue, toWireValue } = require("./ws-server");

const runnerPath = path.join(__dirname, "main-bridge-runner.js");

function errorFromPayload(payload) {
  return fromWireValue(payload);
}

class MainProcessHost extends EventEmitter {
  constructor(options) {
    super();
    this.channels = [];
    this.closing = false;
    this.contextBridges = new Map();
    this.current = null;
    this.cwd = options.cwd;
    this.entryPath = null;
    this.invokeSequence = 0;
    this.logger = options.logger;
    this.reloadChain = Promise.resolve();
    this.restartDelayMs = options.restartDelayMs || 500;
    this.restartTimer = null;
    this.transport = options.transport;
  }

  start(entryPath) {
    return this.reload({ entryPath, reason: "initial-load" });
  }

  reload(options) {
    this.reloadChain = this.reloadChain.then(() => this.performReload(options));
    return this.reloadChain;
  }

  async performReload(options) {
    const entryPath = options.entryPath;

    if (!entryPath) {
      await this.disposeCurrent();
      this.entryPath = null;
      this.channels = [];
      this.contextBridges.clear();
      return { channels: [], entryPath: null };
    }

    this.entryPath = entryPath;

    const candidate = await this.spawnCandidate(entryPath);
    const previous = this.current;

    this.current = candidate;
    this.channels = candidate.channels.slice();
    this.contextBridges = new Map(candidate.contextBridges);

    if (previous) {
      await this.stopState(previous);
    }

    this.emit("ready", {
      channels: this.channels.slice(),
      entryPath,
      reason: options.reason || "reload"
    });

    return {
      channels: this.channels.slice(),
      entryPath
    };
  }

  async invoke(channel, args, clientId) {
    return this.requestChild("invoke", {
      channel,
      args,
      clientId
    });
  }

  async send(channel, args, clientId) {
    return this.requestChild("send", {
      channel,
      args,
      clientId
    });
  }

  async sendSync(channel, args, clientId) {
    return this.requestChild("sync", {
      channel,
      args,
      clientId
    });
  }

  async callContextBridge(channel, path, args, clientId) {
    return this.requestChild("context-bridge-call", {
      channel,
      path,
      args,
      clientId
    });
  }

  async callContextBridgeSync(channel, path, args, clientId) {
    return this.requestChild("context-bridge-sync", {
      channel,
      path,
      args,
      clientId
    });
  }

  requestChild(type, payload) {
    if (!this.current) {
      throw new Error("ERP has not loaded a remote Electron main process yet.");
    }

    this.invokeSequence += 1;
    const requestId = `${type}-${Date.now()}-${this.invokeSequence}`;
    const state = this.current;

    return new Promise((resolve, reject) => {
      state.pending.set(requestId, { reject, resolve });
      state.child.send({
        type,
        requestId,
        channel: payload.channel,
        path: Array.isArray(payload.path) ? payload.path : undefined,
        args: Array.isArray(payload.args) ? payload.args.map((value) => toWireValue(value)) : [],
        clientId: payload.clientId
      });
    });
  }

  listContextBridges() {
    return Array.from(this.contextBridges.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([channel, schema]) => ({ channel, schema }));
  }

  scheduleRestart() {
    if (this.closing || this.restartTimer || !this.entryPath) {
      return;
    }

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.reload({
        entryPath: this.entryPath,
        reason: "child-restart"
      }).catch((error) => {
        this.emit("warning", `Main-process restart failed: ${error.message}`);
        this.scheduleRestart();
      });
    }, this.restartDelayMs);
  }

  async spawnCandidate(entryPath) {
    return new Promise((resolve, reject) => {
      const child = fork(runnerPath, [], {
        cwd: this.cwd,
        env: {
          ...process.env,
          ERP_CWD: this.cwd,
          ERP_ENTRY_PATH: entryPath
        },
        stdio: ["ignore", "ignore", "inherit", "ipc"]
      });
      const state = {
        channels: [],
        child,
        contextBridges: new Map(),
        entryPath,
        pending: new Map(),
        ready: false
      };
      const timeout = setTimeout(() => {
        void this.stopState(state);
        reject(new Error(`Timed out loading remote Electron main entry ${entryPath}.`));
      }, 15_000);

      child.on("message", (message) => {
        if (!message || typeof message !== "object") {
          return;
        }

        if (message.type === "ready") {
          clearTimeout(timeout);
          state.ready = true;
          state.channels = Array.isArray(message.channels) ? message.channels : [];
          resolve(state);
          return;
        }

        if (message.type === "load-error") {
          clearTimeout(timeout);
          void this.stopState(state);
          reject(errorFromPayload(message.error));
          return;
        }

        if (message.type === "request-result") {
          const pending = state.pending.get(message.requestId);

          if (!pending) {
            return;
          }

          state.pending.delete(message.requestId);
          pending.resolve(fromWireValue(message.result));
          return;
        }

        if (message.type === "request-error") {
          const pending = state.pending.get(message.requestId);

          if (!pending) {
            return;
          }

          state.pending.delete(message.requestId);
          pending.reject(errorFromPayload(message.error));
          return;
        }

        if (message.type === "context-bridge-expose") {
          state.contextBridges.set(message.channel, message.schema);

          if (this.current === state) {
            this.contextBridges = new Map(state.contextBridges);
          }

          this.emit("context-bridge-expose", {
            channel: message.channel,
            schema: message.schema
          });
          return;
        }

        if (message.type === "bridge-message") {
          this.transport.sendToClient(message.clientId, message.message);
          return;
        }

        if (message.type === "bridge-broadcast") {
          this.transport.broadcast(message.message);
          return;
        }

        if (message.type === "console") {
          this.emit("console", {
            channel: message.channel || "log",
            args: Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : []
          });
          return;
        }

        if (message.type === "runtime-error") {
          this.emit("warning", `Main-process runtime error: ${errorFromPayload(message.error).message}`);
        }
      });

      child.once("exit", (code, signal) => {
        clearTimeout(timeout);

        for (const pending of state.pending.values()) {
          pending.reject(
            new Error(
              `ERP main-process bridge exited${signal ? ` from ${signal}` : ""}${typeof code === "number" ? ` with code ${code}` : ""}.`
            )
          );
        }

        state.pending.clear();

        if (this.current === state) {
          this.current = null;
          this.channels = [];
          this.contextBridges.clear();

          if (!this.closing) {
            this.emit(
              "warning",
              `Main-process bridge exited${signal ? ` from ${signal}` : ""}${typeof code === "number" ? ` with code ${code}` : ""}.`
            );
            this.scheduleRestart();
          }
        } else if (!state.ready && !this.closing) {
          reject(
            new Error(
              `ERP could not load ${entryPath}${signal ? ` because the runner exited from ${signal}` : ""}${typeof code === "number" ? ` with code ${code}` : ""}.`
            )
          );
        }
      });

      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async stopState(state) {
    if (!state || !state.child || state.child.killed) {
      return;
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!state.child.killed) {
          state.child.kill("SIGTERM");
        }

        resolve();
      }, 2_000);

      state.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        state.child.send({ type: "shutdown" });
      } catch (error) {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async disposeCurrent() {
    const current = this.current;

    if (!current) {
      this.contextBridges.clear();
      return;
    }

    this.current = null;
    this.contextBridges.clear();
    await this.stopState(current);
  }

  async close() {
    this.closing = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    await this.disposeCurrent();
  }
}

function createMainProcessHost(options) {
  return new MainProcessHost(options);
}

module.exports = {
  MainProcessHost,
  createMainProcessHost
};
