# Compatibility Notes

ERP is designed for development-time preview workflows.

## Strongest Fit

- Electron apps with a Vite renderer
- Remote Linux or cloud-hosted development machines
- Teams that need remote access to services but still want local preview speed

## Known Limits

- ERP does not aim to mirror every Electron API across the bridge
- Browser storage remains local by design
- Complex custom bootstrapping may require extra setup
- Production packaging and distribution are outside the scope of this tool

## Version Expectations

- Node.js `>=22`
- Local `electron >=29`
- Network access and SSH access between local and remote environments
