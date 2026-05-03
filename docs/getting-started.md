# Getting Started

This guide walks through the fastest path from install to a working remote preview session.

## Prerequisites

- Node.js `>=22` on the machine where you run ERP
- SSH access to the remote host
- A remote Electron project with a Vite-based renderer workflow
- `electron` installed locally if you want the Electron preview shell

## Install ERP

```bash
npm install -g erp
```

Install `electron` locally for full preview mode:

```bash
npm install electron
```

## Start On The Remote Host

```bash
ssh ec2-user@1.2.3.4
cd /path/to/electron-project
erp start
```

ERP will look for a renderer entry and either reuse an existing Vite server or try to start one.

## Connect Locally

```bash
erp connect ec2-user@1.2.3.4 --key ~/.ssh/mykey.pem --project /path/to/electron-project
```

If the bridge is not already running, ERP can start it remotely when `--project` is supplied.

## Verify The Session

You should see:

- An SSH tunnel status message
- A WebSocket bridge status message
- A local Electron window pointing to the forwarded Vite app
- Remote renderer console output mirrored into your local terminal

## Browser-Only Preview

If you only need the forwarded renderer and not Electron:

```bash
erp connect ec2-user@1.2.3.4 --key ~/.ssh/mykey.pem --no-electron
```

Then open `http://127.0.0.1:5173` in your browser.
