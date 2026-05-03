# Contributing

Thanks for helping improve ERP.

## Before You Start

- Read the [README](./README.md) for the product overview
- Skim the [development guide](./docs/development.md)
- Check the [command reference](./docs/command-reference.md) if your change touches CLI behavior

## Local Workflow

1. Install dependencies with `npm install`
2. Make your change in a focused branch
3. Run:

```bash
npm test
npm run check
npm run smoke:cli
```

4. Update docs when behavior, flags, setup steps, or limits change

## Pull Requests

Good pull requests usually include:

- A clear problem statement
- Small, reviewable changes
- Tests for behavior changes
- Documentation updates when needed

Please keep commits focused and explain user-facing behavior clearly in the PR description.

## Scope

ERP is a development tool for Electron remote preview. Changes that improve remote bootstrapping, IPC bridging, reconnect behavior, or documentation fit especially well.

## Community Standards

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
