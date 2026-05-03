const test = require("node:test");
const assert = require("node:assert/strict");

const { hydrateMessage } = require("../src/ws-client");

test("hydrateMessage preserves falsy ipc-response payloads", () => {
  const hydrated = hydrateMessage({
    id: "ipc-1",
    result: false,
    type: "ipc-response"
  });

  assert.equal(hydrated.result, false);
});
