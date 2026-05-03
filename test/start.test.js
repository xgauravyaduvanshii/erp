const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  buildConnectCommand,
  buildRemoteStartCommand,
  detectConnectHost,
  prepareMainEntry,
  shouldIgnoreWatchPath,
  resolveMainEntry
} = require("../src/start");

test("resolveMainEntry prefers package.json main", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-start-test-"));
  const mainPath = path.join(tempDir, "electron", "main.cjs");

  await fs.mkdir(path.dirname(mainPath), { recursive: true });
  await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ main: "electron/main.cjs" }, null, 2));
  await fs.writeFile(mainPath, "module.exports = {};\n");

  assert.equal(await resolveMainEntry(tempDir), mainPath);
});

test("resolveMainEntry falls back to common main filenames", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-start-test-"));
  const mainPath = path.join(tempDir, "src", "main.js");

  await fs.mkdir(path.dirname(mainPath), { recursive: true });
  await fs.writeFile(mainPath, "module.exports = {};\n");

  assert.equal(await resolveMainEntry(tempDir), mainPath);
});

test("resolveMainEntry detects electron-vite main input files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-start-test-"));
  const mainPath = path.join(tempDir, "emain", "emain.ts");
  const electronViteModulePath = path.join(tempDir, "node_modules", "electron-vite", "index.js");

  await fs.mkdir(path.dirname(mainPath), { recursive: true });
  await fs.mkdir(path.dirname(electronViteModulePath), { recursive: true });
  await fs.writeFile(
    electronViteModulePath,
    `"use strict";
exports.defineConfig = (value) => value;
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(tempDir, "electron.vite.config.js"),
    `"use strict";
const { defineConfig } = require("electron-vite");

module.exports = defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: "emain/emain.ts"
        }
      }
    }
  }
});
`,
    "utf8"
  );
  await fs.writeFile(mainPath, "export {};\n");

  assert.equal(await resolveMainEntry(tempDir), mainPath);
});

test("prepareMainEntry auto-builds missing electron-vite dist main artifacts", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-start-test-"));
  const declaredMainPath = path.join(tempDir, "dist", "main", "index.js");
  const sourceMainPath = path.join(tempDir, "emain", "emain.ts");
  const packageJsonPath = path.join(tempDir, "package.json");
  const configPath = path.join(tempDir, "electron.vite.config.js");
  let buildCalls = 0;

  await fs.mkdir(path.dirname(sourceMainPath), { recursive: true });
  await fs.writeFile(packageJsonPath, JSON.stringify({ main: "./dist/main/index.js" }, null, 2));
  await fs.writeFile(
    configPath,
    `module.exports = {
  main: {
    build: {
      rollupOptions: {
        input: {
          index: "emain/emain.ts"
        }
      }
    }
  }
};
`,
    "utf8"
  );
  await fs.writeFile(sourceMainPath, "export {};\n");

  const prepared = await prepareMainEntry(tempDir, {
    buildElectronViteMainArtifacts: async (cwd, options) => {
      buildCalls += 1;
      await fs.mkdir(path.dirname(declaredMainPath), { recursive: true });
      await fs.writeFile(declaredMainPath, `"use strict";\nmodule.exports = {};\n`, "utf8");
      assert.equal(cwd, tempDir);
      assert.equal(options.packageMainPath, declaredMainPath);
    }
  });

  assert.equal(buildCalls, 1);
  assert.equal(prepared.entryPath, declaredMainPath);
  assert.equal(prepared.strategy, "package-main-built");
});

test("prepareMainEntry falls back to the electron-vite source entry when artifact build fails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-start-test-"));
  const sourceMainPath = path.join(tempDir, "emain", "emain.ts");
  const electronViteModulePath = path.join(tempDir, "node_modules", "electron-vite", "index.js");

  await fs.mkdir(path.dirname(sourceMainPath), { recursive: true });
  await fs.mkdir(path.dirname(electronViteModulePath), { recursive: true });
  await fs.writeFile(path.join(tempDir, "package.json"), JSON.stringify({ main: "./dist/main/index.js" }, null, 2));
  await fs.writeFile(
    electronViteModulePath,
    `"use strict";
exports.defineConfig = (value) => value;
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(tempDir, "electron.vite.config.js"),
    `"use strict";
const { defineConfig } = require("electron-vite");

module.exports = defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: "emain/emain.ts"
        }
      }
    }
  }
});
`,
    "utf8"
  );
  await fs.writeFile(sourceMainPath, "export {};\n");

  const prepared = await prepareMainEntry(tempDir, {
    buildElectronViteMainArtifacts: async () => {
      throw new Error("boom");
    }
  });

  assert.equal(prepared.entryPath, sourceMainPath);
  assert.equal(prepared.strategy, "electron-vite-source");
});

test("buildConnectCommand includes the forwarded ports", () => {
  const command = buildConnectCommand({
    username: "ec2-user",
    host: "54.10.20.30",
    port: 7700,
    vitePort: 5173
  });

  assert.equal(
    command,
    "erp connect ec2-user@54.10.20.30 --key ~/.ssh/mykey.pem --port 7700 --vite-port 5173"
  );
});

test("detectConnectHost prefers the EC2 public IP when metadata is available", async () => {
  const host = await detectConnectHost({
    fetchEc2Metadata: async (pathName) => {
      if (pathName === "public-ipv4") {
        return "3.91.22.11";
      }

      return null;
    },
    networkInterfaces: () => ({
      eth0: [{ address: "10.0.12.14", family: "IPv4", internal: false }]
    })
  });

  assert.equal(host, "3.91.22.11");
});

test("buildRemoteStartCommand starts ERP inside the requested project path", () => {
  const command = buildRemoteStartCommand({
    port: 7700,
    project: "/srv/electron app",
    vitePort: 5173
  });

  assert.match(command, /cd '\/srv\/electron app'/);
  assert.match(command, /nohup erp start --port 7700 --vite-port 5173/);
});

test("shouldIgnoreWatchPath skips electron-vite temporary config bundles", () => {
  assert.equal(shouldIgnoreWatchPath(""), false);
  assert.equal(shouldIgnoreWatchPath("electron.vite.config.1746212345678.mjs"), true);
  assert.equal(shouldIgnoreWatchPath("nested/electron.vite.config.1746212345678.mjs"), true);
  assert.equal(shouldIgnoreWatchPath("dist/main/index.js"), true);
  assert.equal(shouldIgnoreWatchPath("node_modules/ws/index.js"), true);
  assert.equal(shouldIgnoreWatchPath("frontend/app.tsx"), false);
});
