"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { Client } = require("ssh2");

function expandHomePath(targetPath) {
  if (!targetPath) {
    return targetPath;
  }

  if (targetPath === "~") {
    return os.homedir();
  }

  if (targetPath.startsWith("~/")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

function parseSshTarget(target) {
  const rawTarget = String(target || "").trim();
  const atIndex = rawTarget.indexOf("@");

  if (atIndex <= 0 || atIndex === rawTarget.length - 1) {
    throw new Error(`Invalid SSH target "${target}". Use the form user@host.`);
  }

  const username = rawTarget.slice(0, atIndex);
  const hostPart = rawTarget.slice(atIndex + 1);
  let host = hostPart;
  let port;

  const ipv6Match = /^\[(.+)\](?::(\d+))?$/.exec(hostPart);

  if (ipv6Match) {
    host = ipv6Match[1];
    port = ipv6Match[2] ? Number.parseInt(ipv6Match[2], 10) : undefined;
  } else {
    const hostBits = hostPart.split(":");

    if (hostBits.length === 2 && /^\d+$/.test(hostBits[1])) {
      host = hostBits[0];
      port = Number.parseInt(hostBits[1], 10);
    }
  }

  return port ? { host, port, username } : { host, username };
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class SshTunnel extends EventEmitter {
  constructor(options) {
    super();
    this.client = null;
    this.clientReady = false;
    this.closing = false;
    this.connecting = false;
    this.forwards = options.forwards || [];
    this.lastError = null;
    this.localServers = [];
    this.options = options;
    this.readyWaiters = [];
    this.reconnectDelayMs = options.reconnectDelayMs || 1_500;
    this.reconnectTimer = null;
  }

  async start() {
    await this.listenLocally();
    this.connect();
    await this.waitUntilReady(this.options.connectTimeoutMs || 20_000);
    return this;
  }

  async listenLocally() {
    const servers = await Promise.all(
      this.forwards.map((forward) => {
        return new Promise((resolve, reject) => {
          const server = net.createServer((socket) => {
            this.handleSocket(forward, socket);
          });

          server.on("error", reject);
          server.listen(forward.localPort, "127.0.0.1", () => {
            resolve(server);
          });
        });
      })
    );

    this.localServers = servers;
  }

  handleSocket(forward, socket) {
    if (!this.client || !this.clientReady) {
      socket.destroy(new Error("ERP SSH tunnel is reconnecting."));
      return;
    }

    this.client.forwardOut(
      socket.localAddress || "127.0.0.1",
      socket.localPort || 0,
      forward.remoteHost || "127.0.0.1",
      forward.remotePort,
      (error, stream) => {
        if (error) {
          socket.destroy(error);
          return;
        }

        socket.pipe(stream);
        stream.pipe(socket);

        socket.on("error", () => {
          stream.destroy();
        });

        stream.on("error", () => {
          socket.destroy();
        });
      }
    );
  }

  connect() {
    if (this.closing || this.connecting) {
      return;
    }

    this.connecting = true;
    const client = new Client();
    this.client = client;

    client.on("ready", () => {
      this.clientReady = true;
      this.connecting = false;
      this.lastError = null;
      this.emit("ready");

      while (this.readyWaiters.length > 0) {
        const waiter = this.readyWaiters.shift();
        waiter.resolve();
      }
    });

    client.on("error", (error) => {
      this.lastError = error;
      this.connecting = false;
      this.emit("error", error);
    });

    client.on("close", () => {
      this.clientReady = false;
      this.connecting = false;
      this.emit("disconnected");

      if (!this.closing) {
        this.scheduleReconnect();
      }
    });

    const connectionOptions = {
      host: this.options.host,
      keepaliveCountMax: 3,
      keepaliveInterval: 10_000,
      port: this.options.port || 22,
      readyTimeout: this.options.readyTimeoutMs || 20_000,
      username: this.options.username
    };

    if (this.options.privateKey) {
      connectionOptions.privateKey = this.options.privateKey;
    } else if (process.env.SSH_AUTH_SOCK) {
      connectionOptions.agent = process.env.SSH_AUTH_SOCK;
    }

    client.connect(connectionOptions);
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closing) {
      return;
    }

    this.emit("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  waitUntilReady(timeoutMs) {
    if (this.clientReady) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter = { reject, resolve };
      const timeout = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter);

        if (index >= 0) {
          this.readyWaiters.splice(index, 1);
        }

        reject(this.lastError || new Error(`Timed out waiting for SSH tunnel after ${timeoutMs}ms.`));
      }, timeoutMs);

      this.readyWaiters.push({
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        },
        resolve() {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  async exec(command) {
    await this.waitUntilReady(this.options.commandTimeoutMs || 20_000);

    return new Promise((resolve, reject) => {
      this.client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        stream.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        stream.on("close", (code) => {
          if (code === 0) {
            resolve(stdout.trim());
            return;
          }

          reject(new Error(stderr.trim() || `Remote command exited with code ${code}.`));
        });
      });
    });
  }

  async close() {
    this.closing = true;
    this.clientReady = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    await Promise.all(
      this.localServers.map((server) => {
        return new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
      })
    );

    this.localServers = [];

    if (this.client) {
      this.client.end();
    }
  }
}

function createSshTunnel(options) {
  return new SshTunnel(options);
}

module.exports = {
  createSshTunnel,
  expandHomePath,
  parseSshTarget,
  shellEscape
};
