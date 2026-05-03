# Examples

## Standard EC2 Workflow

```bash
erp connect ec2-user@1.2.3.4 --key ~/.ssh/mykey.pem --project /srv/apps/my-electron-app
```

## Custom Ports

```bash
erp start --port 8800 --vite-port 5273
erp connect ec2-user@1.2.3.4 --key ~/.ssh/mykey.pem --port 8800 --vite-port 5273
```

## Browser-Only Tunnel

```bash
erp connect ec2-user@1.2.3.4 --key ~/.ssh/mykey.pem --no-electron
```
