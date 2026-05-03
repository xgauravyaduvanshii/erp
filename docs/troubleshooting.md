# Troubleshooting

## Local Port Conflicts

If the preferred ports are already in use locally, ERP attempts to reserve alternate local ports and logs a warning. If you want fixed ports, free the existing listeners first.

## Remote Port Not Reachable

If the remote bridge or Vite server never becomes reachable:

- Confirm the remote project path is correct
- Confirm the remote host can start or already has a Vite server
- Confirm the selected ports are not blocked or occupied

## SSH Problems

Common causes:

- Wrong username or hostname
- Wrong key path
- Unreadable private key file
- Missing SSH agent configuration

## Electron Launch Problems

If the local Electron shell does not start:

- Confirm `electron` is installed where you run `erp connect`
- Try browser-only mode to isolate whether the issue is Electron-specific

## Project Detection Problems

ERP can discover common main entry patterns, but highly customized project layouts may need an explicit `main` entry in `package.json` or a clearer Electron entry file.

## Debugging Tips

- Run `erp --help` to confirm the CLI is wired correctly
- Start the remote bridge manually before using `--project` to narrow bootstrap failures
- Watch the local terminal for `[erp:warn]`, `[erp:error]`, and `[remote]` lines
