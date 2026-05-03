# Development Guide

## Local Repo Setup

```bash
npm install
```

## Useful Commands

```bash
npm test
npm run check
npm run smoke:cli
```

## What To Read First

- `bin/erp.js` for the CLI entry
- `src/start.js` for remote orchestration
- `src/connect.js` for local connection behavior
- `test/` for the behavior the project already expects

## Editing Guidance

- Keep the local and remote responsibilities separated.
- Treat the WebSocket bridge as a stable transport contract.
- Avoid making assumptions about a full remote desktop environment.
- Add or update tests when transport behavior, command parsing, or IPC behavior changes.

## Release Hygiene

Before shipping changes:

1. Run the test, check, and smoke commands locally.
2. Review README and docs updates alongside behavior changes.
3. Make sure new flags or compatibility limits are documented.
