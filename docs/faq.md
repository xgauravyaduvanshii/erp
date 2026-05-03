# FAQ

## Is ERP an ERP business application?

No. ERP here stands for Electron Remote Preview.

## Does ERP proxy `localStorage` or IndexedDB?

No. The preview window runs locally, so browser storage also stays local.

## Can I use ERP without Electron?

Yes. Run `erp connect --no-electron` and open the forwarded Vite URL in a browser.

## Does ERP require Vite?

Vite is the best-supported renderer flow. Existing reachable renderer servers can also work, but ERP is designed around the common Electron-plus-Vite setup.

## Can ERP start the remote bridge for me?

Yes. If you pass `--project`, `erp connect` can validate the remote path and start `erp start` remotely when needed.
