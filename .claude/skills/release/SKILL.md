---
name: release
description: Package OpenPipal as a macOS DMG for distribution. User-invoked only — runs npm run build:mac.
disable-model-invocation: true
---

Build and package OpenPipal for macOS distribution:

```bash
npm run build:mac
```

This runs `electron-vite build` then `electron-builder --mac`, producing a DMG in `dist/`.

Before running, confirm:
- All changes are committed (`git status` clean or known-dirty is intentional)
- Browser extension version in `openpipal-extension/manifest.json` is bumped if extension files changed (patch +1 per release rule in CLAUDE.md)
