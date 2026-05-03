#!/usr/bin/env node

const { Command } = require("commander");

const packageJson = require("../package.json");
const { runConnectCommand } = require("../src/connect");
const { runStartCommand } = require("../src/start");

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const program = new Command();

program
  .name("erp")
  .description("Electron Remote Preview")
  .version(packageJson.version)
  .showHelpAfterError("(add --help for usage details)");

program
  .command("start")
  .description("Run the ERP bridge inside the remote Electron project")
  .option("--port <port>", "WebSocket bridge port", "7700")
  .option("--vite-port <port>", "Vite dev server port", "5173")
  .action(async (options) => {
    await runStartCommand({
      port: parsePort(options.port, 7700),
      vitePort: parsePort(options.vitePort, 5173)
    });
  });

program
  .command("connect")
  .description("Open SSH tunnels and launch a local Electron preview shell")
  .argument("<target>", "SSH target in user@host format")
  .option("--key <path>", "Path to the SSH private key PEM file")
  .option("--port <port>", "Remote ERP WebSocket bridge port", "7700")
  .option("--vite-port <port>", "Remote Vite dev server port", "5173")
  .option("--project <remote-path>", "Validate the remote project path over SSH before launching")
  .option("--no-electron", "Skip launching Electron and only establish the SSH tunnels")
  .action(async (target, options) => {
    await runConnectCommand(target, {
      key: options.key,
      port: parsePort(options.port, 7700),
      vitePort: parsePort(options.vitePort, 5173),
      project: options.project,
      electron: options.electron
    });
  });

program.parseAsync(process.argv).catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
