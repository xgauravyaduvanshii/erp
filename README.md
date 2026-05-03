# erp

Electron Remote Preview for developing an Electron renderer on a remote machine while viewing it in a local Electron shell.

`erp` gives you two commands:

- `erp start` runs in the remote Electron project, starts the bridge, captures `ipcMain.handle()` registrations, and keeps Vite reachable over SSH.
- `erp connect` runs locally, opens SSH tunnels with `ssh2`, launches a tiny local Electron shell, and proxies renderer IPC calls back to the remote handlers.

## Install

```bash
npm install -g erp
```

`erp connect` expects `electron` to be available on the local machine where you launch the preview shell. Install it in the directory where you run `erp connect`, or use `--no-electron` if you only want the tunnels:

```bash
npm install electron
```

## Usage

### 1. Start ERP on the EC2 instance

SSH into the instance, change into your Electron project, and start the bridge:

```bash
cd /path/to/electron-project
erp start
```

Optional flags:

```bash
erp start --port 7700 --vite-port 5173
```

What `erp start` does:

- Starts a WebSocket bridge on `127.0.0.1:7700`
- Reuses an existing Vite server on `127.0.0.1:5173`, or starts one from the current project
- Loads the Electron main entry with an Electron shim so `ipcMain.handle()` calls can be invoked remotely
- Watches project files with `chokidar` and emits HMR/file-change notifications
- Prints a suggested `erp connect ...` command

### 2. Connect from your local machine

From your local machine, run:

```bash
erp connect ec2-user@1.2.3.4 --key ~/.ssh/mykey.pem --project /path/to/electron-project
```

Optional flags:

```bash
erp connect ec2-user@1.2.3.4 \
  --key ~/.ssh/mykey.pem \
  --port 7700 \
  --vite-port 5173 \
  --project /path/to/electron-project
```

`erp connect` will:

- Open `localhost:5173 -> remote:5173`
- Open `localhost:7700 -> remote:7700`
- If `--project` is set and the remote ERP bridge is not already running, start `erp start` inside that project over SSH
- Launch a minimal local Electron window pointed at `http://127.0.0.1:5173`
- Inject a preload script from a temp file that proxies `ipcRenderer.invoke()` and `ipcRenderer.on()` over WebSocket
- Print remote console output in the local terminal with a `[remote]` prefix
- Reconnect the SSH tunnel and WebSocket client when the connection drops

### 3. Browser-only mode

If you want the tunnels without launching Electron:

```bash
erp connect ec2-user@1.2.3.4 --key ~/.ssh/mykey.pem --no-electron
```

Then open `http://127.0.0.1:5173` in a normal browser.

## How localStorage works

`erp` does not proxy or override `localStorage`, `sessionStorage`, or IndexedDB.

The local preview window loads `http://127.0.0.1:5173` in your local Chromium-based Electron shell, so browser storage naturally lives on your local machine. That means:

- Renderer storage is fast and fully local
- Refreshes and HMR keep using the same local browser storage
- Nothing in storage is sent back through the ERP IPC bridge

Only Electron IPC traffic and renderer console messages are proxied.

## Architecture Notes

- The remote side only needs enough Electron behavior to register and invoke `ipcMain.handle()` handlers, so `erp start` uses a lightweight Electron shim instead of a full remote GUI.
- Remote main-process IPC registrations are reloaded when project files change, so `ipcMain.handle()` updates take effect without restarting `erp start`.
- `webContents.send()` calls from the remote main process are emitted to local `ipcRenderer.on()` listeners as `ipc-event` messages.
- The local preload script is written to a temp file at runtime and attached through `BrowserWindow`'s `webPreferences.preload`.

## Troubleshooting

### Port already in use

If `7700` or `5173` is already taken locally or remotely:

- Stop the process already using the port, or
- Pick different ports on both sides:

```bash
erp start --port 8800 --vite-port 5273
erp connect ec2-user@1.2.3.4 --key ~/.ssh/mykey.pem --port 8800 --vite-port 5273
```

### SSH auth errors

If `erp connect` cannot authenticate:

- Confirm the username in `user@host`
- Confirm the PEM path passed to `--key`
- Check that the file is readable
- If you rely on an SSH agent, make sure `SSH_AUTH_SOCK` is set
- If you use `--project`, make sure `erp` is installed on the remote machine too, because ERP may need to start the remote bridge for you

### Electron not found

If `erp connect` says Electron was not found:

- Install `electron` where you run `erp connect`, or
- Run with `--no-electron` and open the forwarded Vite URL in a browser

### Vite could not be started

If `erp start` cannot find Vite and nothing is already listening on the Vite port:

- Install `vite` in the remote project, or
- Start the Vite dev server manually and run `erp start` again

## Development

```bash
npm test
npm run check
npm run smoke:cli
```
