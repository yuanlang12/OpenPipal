---
name: verify
description: Compile-check the Electron+Vite build and run E2E tests. Use after making code changes to confirm nothing is broken before reporting done.
---

Run a full verification pass on the OpenPipal codebase:

1. **Lint** — run `npm run lint` (ESLint on `src/`). Catches React hooks violations, unused vars, and `any` usage without a full build.

2. **Compile check** — run `npx electron-vite build`. Compiles main process, preload, and renderer in one pass. Fail fast if there are TypeScript errors.

3. **E2E tests** (if the build passes) — run `npx playwright test`. Tests live in `tests/e2e/`. They mock `window.api` via `addInitScript` and use the renderer E2E dev server (`src/renderer/vite.config.ts`).

Report: ✓ or ✗ for each step, plus the last 20 lines of output if either fails.

**这三步验的是源码，不是装机版。** 全绿只代表当前代码能构建、能过测试；它不代表 /Applications 里那个 App 是新的。要请用户上机测试，先走 `/release` 的第 3 步核对 asar 指纹，否则用户看到的可能仍是旧构建。
