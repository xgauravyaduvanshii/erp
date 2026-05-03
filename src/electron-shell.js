"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { buildPreloadScript } = require("./preload-template");

function resolveElectronBinary() {
  let resolved;

  try {
    resolved = require.resolve("electron", { paths: [process.cwd(), __dirname] });
  } catch (error) {
    throw new Error(
      'Electron was not found locally. Install it where you run "erp connect" or use --no-electron.'
    );
  }

  const candidate = require(resolved);

  if (typeof candidate === "string" && candidate.length > 0) {
    return candidate;
  }

  throw new Error("The resolved electron module did not expose an executable path.");
}

function buildMainScript() {
  return `"use strict";

const { app, BrowserWindow } = require("electron");

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: "#0f172a",
    height: 900,
    title: process.env.ERP_WINDOW_TITLE || "ERP Preview",
    width: 1440,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      preload: process.env.ERP_PRELOAD_PATH,
      sandbox: false
    }
  });

  mainWindow.loadURL(process.env.ERP_TARGET_URL);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.whenReady().then(createWindow);
`;
}

async function launchElectronShell(options) {
  const { logger, title, url, wsPort } = options;
  const electronBinary = resolveElectronBinary();
  const wsModulePath = require.resolve("ws");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "erp-electron-shell-"));
  const mainPath = path.join(tempDir, "main.cjs");
  const preloadPath = path.join(tempDir, "preload.cjs");

  async function cleanup() {
    await fs.rm(tempDir, { force: true, recursive: true });
  }

  await fs.writeFile(mainPath, buildMainScript(), "utf8");
  await fs.writeFile(preloadPath, buildPreloadScript({ wsModulePath, wsPort }), "utf8");

  logger.info(`Launching local Electron preview at ${url}.`);

  let child;

  try {
    child = spawn(electronBinary, [mainPath], {
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        ERP_PRELOAD_PATH: preloadPath,
        ERP_TARGET_URL: url,
        ERP_WINDOW_TITLE: title || "ERP Preview"
      },
      stdio: ["ignore", "ignore", "inherit"]
    });
  } catch (error) {
    await cleanup();
    throw error;
  }

  await new Promise((resolve, reject) => {
    function onError(error) {
      child.off("spawn", onSpawn);
      reject(error);
    }

    function onSpawn() {
      child.off("error", onError);
      resolve();
    }

    child.once("error", onError);
    child.once("spawn", onSpawn);
  }).catch(async (error) => {
    await cleanup();
    throw error;
  });

  let closed = false;

  child.once("exit", async (code, signal) => {
    if (!closed) {
      logger.info(
        `Electron preview exited${signal ? ` from ${signal}` : ""}${typeof code === "number" ? ` with code ${code}` : ""}.`
      );
    }

    await cleanup();
  });

  return {
    pid: child.pid,
    async close() {
      if (closed) {
        return;
      }

      closed = true;

      if (!child.killed) {
        child.kill("SIGTERM");
      }

      await new Promise((resolve) => {
        child.once("exit", () => {
          resolve();
        });

        setTimeout(resolve, 1_500);
      });

      await cleanup();
    }
  };
}

module.exports = {
  launchElectronShell
};
