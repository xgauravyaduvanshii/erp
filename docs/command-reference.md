# Command Reference

## `erp start`

Starts the remote runtime bridge inside the Electron project.

### Options

- `--port <port>`: WebSocket bridge port, default `7700`
- `--vite-port <port>`: renderer dev-server port, default `5173`

## `erp connect`

Connects locally to the remote project through SSH tunnels.

### Arguments

- `<target>`: SSH target in `user@host` format

### Options

- `--key <path>`: private key path
- `--port <port>`: remote bridge port, default `7700`
- `--vite-port <port>`: remote renderer port, default `5173`
- `--project <remote-path>`: validate and optionally start the remote bridge
- `--no-electron`: forward the renderer without launching the local Electron shell
