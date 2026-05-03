"use strict";

const { EventEmitter } = require("node:events");

const WebSocket = require("ws");

const { fromWireValue } = require("./ws-server");

function hydrateMessage(message) {
  return {
    ...message,
    args: Array.isArray(message.args) ? message.args.map((value) => fromWireValue(value)) : [],
    error: Object.prototype.hasOwnProperty.call(message, "error") ? fromWireValue(message.error) : undefined,
    result: Object.prototype.hasOwnProperty.call(message, "result") ? fromWireValue(message.result) : undefined
  };
}

class ErpWsClient extends EventEmitter {
  constructor(options) {
    super();
    this.closing = false;
    this.host = options.host || "127.0.0.1";
    this.logger = options.logger;
    this.port = options.port;
    this.reconnectDelayMs = options.reconnectDelayMs || 1_500;
    this.reconnectTimer = null;
    this.socket = null;
  }

  connect() {
    if (this.closing) {
      return;
    }

    const target = `ws://${this.host}:${this.port}`;
    this.socket = new WebSocket(target);

    this.socket.on("open", () => {
      this.emit("open");
    });

    this.socket.on("message", (data) => {
      this.handleMessage(data);
    });

    this.socket.on("error", (error) => {
      this.emit("error", error);
    });

    this.socket.on("close", () => {
      this.emit("close");

      if (!this.closing) {
        this.scheduleReconnect();
      }
    });
  }

  handleMessage(data) {
    let message;

    try {
      message = JSON.parse(data.toString());
    } catch (error) {
      this.logger.warn(`Ignoring malformed ERP client payload: ${error.message}`);
      return;
    }

    if (!message || typeof message !== "object") {
      return;
    }

    const hydrated = hydrateMessage(message);

    this.emit("message", hydrated);
    this.emit(hydrated.type, hydrated);
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

  async close() {
    this.closing = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      return;
    }

    await new Promise((resolve) => {
      if (this.socket.readyState === WebSocket.CLOSING) {
        this.socket.once("close", () => {
          resolve();
        });
        return;
      }

      this.socket.once("close", () => {
        resolve();
      });

      this.socket.close();
    });
  }
}

function createWsClient(options) {
  return new ErpWsClient(options);
}

module.exports = {
  ErpWsClient,
  createWsClient,
  hydrateMessage
};
