const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");

const { resolveLocalTunnelPorts } = require("../src/connect");

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

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve();
    });
  });
}

test("resolveLocalTunnelPorts keeps requested local ports when they are free", async () => {
  const vitePort = await getFreePort();
  const port = await getFreePort();
  const ports = await resolveLocalTunnelPorts({
    port,
    vitePort
  });

  assert.equal(ports.localPort, port);
  assert.equal(ports.localVitePort, vitePort);
});

test("resolveLocalTunnelPorts falls back to free local ports when requested ports are already in use", async (t) => {
  const occupiedVitePort = await getFreePort();
  const occupiedWsPort = await getFreePort();
  const viteServer = net.createServer();
  const wsServer = net.createServer();

  await listen(viteServer, occupiedVitePort);
  await listen(wsServer, occupiedWsPort);

  t.after(async () => {
    await Promise.all(
      [viteServer, wsServer].map(
        (server) =>
          new Promise((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }

              resolve();
            });
          })
      )
    );
  });

  const ports = await resolveLocalTunnelPorts({
    port: occupiedWsPort,
    vitePort: occupiedVitePort
  });

  assert.notEqual(ports.localPort, occupiedWsPort);
  assert.notEqual(ports.localVitePort, occupiedVitePort);
  assert.notEqual(ports.localPort, ports.localVitePort);
});
