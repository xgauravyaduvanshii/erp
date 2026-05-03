# Security Model

ERP uses SSH and local port forwarding as its primary security boundary.

## Transport

- Remote services are expected to bind locally on the remote host
- ERP forwards those ports through SSH instead of exposing them publicly
- IPC messages move through a WebSocket bridge that is reached through the SSH tunnel

## Trust Model

- The local machine is trusted to view the app and hold renderer storage
- The remote project is trusted to execute main-process handler logic
- SSH credentials should be managed with the same care as any other remote development workflow

## Sensitive Inputs

- Private keys passed with `--key`
- Remote project paths used with `--project`
- Any secrets already available to the remote application

## Recommendations

- Use least-privilege SSH credentials
- Prefer non-shared remote development hosts
- Rotate keys regularly
- Keep the remote project dependencies up to date
