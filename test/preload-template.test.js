const test = require("node:test");
const assert = require("node:assert/strict");

const { buildPreloadScript } = require("../src/preload-template");

test("buildPreloadScript embeds the websocket port and ipc proxy hooks", () => {
  const script = buildPreloadScript({ wsModulePath: "/tmp/ws.js", wsPort: 7700 });

  assert.match(script, /ws:\/\/127\.0\.0\.1:7700/);
  assert.match(script, /ipcRenderer\.invoke/);
  assert.match(script, /ipcRenderer\.on/);
  assert.match(script, /ipcRenderer\.send\s*=/);
  assert.match(script, /ipcRenderer\.sendSync/);
  assert.match(script, /context-bridge-expose/);
  assert.match(script, /context-bridge-call/);
  assert.match(script, /context-bridge-sync/);
  assert.match(script, /spawnSync/);
  assert.match(script, /ELECTRON_RUN_AS_NODE/);
  assert.match(script, /require\(process\.argv\[1\]\)/);
  assert.match(script, /const wsUrl = process\.argv\[2\]/);
  assert.doesNotMatch(script, /SharedArrayBuffer/);
  assert.match(script, /type: "ipc-invoke"/);
  assert.match(script, /type: "ipc-send"/);
  assert.match(script, /type: "ipc-sync"/);
  assert.match(script, /type: "console"/);
});
