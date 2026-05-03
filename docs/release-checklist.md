# Release Checklist

Use this checklist before publishing a new ERP version.

## Before Tagging

1. Run `npm test`
2. Run `npm run check`
3. Run `npm run smoke:cli`
4. Review README and docs for new flags or behavior
5. Update `CHANGELOG.md`

## Before Publishing

1. Verify `package.json` version
2. Run `npm pack --dry-run`
3. Confirm ignored artifacts are not being shipped accidentally
4. Check that workflows are green on the default branch

## After Publishing

1. Verify installation from the produced package
2. Confirm the README examples still match the released CLI
