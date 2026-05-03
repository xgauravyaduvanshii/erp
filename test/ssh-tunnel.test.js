const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const { expandHomePath, parseSshTarget } = require("../src/ssh-tunnel");

test("parseSshTarget splits username and hostname", () => {
  assert.deepEqual(parseSshTarget("ec2-user@example.com"), {
    username: "ec2-user",
    host: "example.com"
  });
});

test("parseSshTarget rejects malformed values", () => {
  assert.throws(() => parseSshTarget("example.com"), /user@host/i);
});

test("expandHomePath resolves a leading tilde", () => {
  assert.equal(expandHomePath("~/keys/dev.pem"), path.join(os.homedir(), "keys/dev.pem"));
});
