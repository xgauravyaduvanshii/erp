# Security Policy

## Supported Scope

ERP is a development tool for remote Electron preview over SSH and WebSocket transport. Security reports are especially helpful when they relate to:

- Credential handling
- SSH tunnel behavior
- Unexpected public exposure of local or remote services
- IPC bridge message handling
- Package supply-chain concerns

## Reporting A Vulnerability

Please avoid opening a public issue for a suspected vulnerability.

Instead:

1. Email the maintainer or use your preferred private contact channel
2. Include reproduction steps, impact, and affected version details
3. Share whether the issue is configuration-specific or reproducible by default

For non-sensitive setup or troubleshooting problems, use the paths in [SUPPORT.md](./SUPPORT.md) instead of the private disclosure channel.

## Response Expectations

- Triage confirmation: as quickly as practical
- Reproduction and assessment: best effort based on severity
- Public disclosure: after a fix or mitigation is available

## Operational Guidance

- Use dedicated SSH credentials where possible
- Do not expose bridge ports publicly unless you fully understand the risk
- Keep local and remote dependencies up to date
- Review the [security model guide](./docs/security-model.md) for system assumptions
