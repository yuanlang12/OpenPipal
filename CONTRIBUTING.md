# Contributing to OpenPipal

OpenPipal is preparing for a possible open-source release, but the repository is
not open for external contributions yet. The current [README](README.md) remains
authoritative: source distribution and pull requests stay closed until the
[open-source readiness gates](docs/open-source-readiness.md) are approved.

This guide defines the expected workflow for maintainers and will apply to
external contributors only after the repository status changes.

## Development setup

Requirements:

- macOS
- Node.js 22.19.0 or newer
- npm, using the committed `package-lock.json`

Install the locked dependencies:

```sh
npm ci
```

Run the desktop app in development mode:

```sh
npm run dev
```

Development and QA must not read or modify a user's real OpenPipal data. Create
a dedicated absolute directory and set both variables to that same path for the
development process:

```sh
OPENPIPAL_DEV_DATA="$(mktemp -d /tmp/openpipal-dev.XXXXXX)"
env HOME="$OPENPIPAL_DEV_DATA" \
  OPENPIPAL_ISOLATED_HOME="$OPENPIPAL_DEV_DATA" \
  npm run dev
```

The directory isolates storage only. OpenPipal also uses fixed local service
ports, so do not run multiple desktop instances under the same login unless the
code under test explicitly provides port isolation. Stop only a process you
started, or use a separate machine or login. Do not restart, replace, or attach
to another person's running OpenPipal process.

## Making changes

- Keep each change focused and preserve unrelated work in the checkout.
- Reuse the public Runtime boundary for agent-loop behavior. Keep OpenPipal code
  focused on product-specific roles, memory, permissions, Artifact, MCP, and
  desktop interaction.
- Add or update focused tests for changed behavior.
- Document user-visible behavior, configuration, or compatibility changes.
- Do not add a dependency without explaining why existing platform or project
  capabilities are insufficient and recording its redistribution terms.

## Checks

Run the smallest relevant tests while iterating. For example:

```sh
npx vitest run tests/unit/agent-runtime-selection.test.ts
npx vitest run tests/unit/locale-contract.test.ts
```

Before requesting review, run both TypeScript projects and lint:

```sh
npx tsc --noEmit -p tsconfig.node.json
npx tsc --noEmit -p tsconfig.web.json
npm run lint
```

Run the complete unit suite when the change affects shared Runtime, storage,
security boundaries, packaging, or cross-process contracts:

```sh
npm run test:unit
```

Record checks that could not run and the exact reason. Static checks and unit
tests are not substitutes for packaged-app or real-device acceptance.

## Release-candidate checks

Release owners, not every contributor, are responsible for building the exact
candidate from a clean checkout:

```sh
npm run build
npm run build:unpack
```

The final macOS installer check uses:

```sh
npm run build:mac
```

Build commands create ignored local output and do not prove release readiness.
Against the same candidate commit and an isolated data root, the release record
must also cover these user-view flows:

- launch and complete a basic conversation sequentially with both the legacy
  rollback Runtime and the `pi-core` Runtime;
- verify system-language startup, explicit Chinese/English switching, restart,
  and browser-sidebar refresh behavior;
- complete a representative Design Agent create, revise, preview, and export
  flow;
- connect the browser extension without borrowing an existing browser profile;
- record the commit, macOS and hardware versions, commands, results, failures,
  and evidence locations.

The full publication gates remain in
[docs/open-source-readiness.md](docs/open-source-readiness.md).

## Data and repository hygiene

Never commit:

- `.env`, real API keys, tokens, credentials, or copied credential values;
- `~/.openpipal/`, Electron `userData`, or any directory used as an isolated
  development home;
- real conversations, prompts, memories, audit logs, screenshots, documents,
  browser profiles, or other user-derived data;
- `dist-qa/`, `dist-qa2/`, `out/`, `dist/`, packaged applications, or local
  installer artifacts;
- `node_modules/`, test reports, heap snapshots, or temporary debug output.

Use synthetic fixtures with invented names and deliberately fake values. Before review, inspect
`git status --short` and the complete diff for generated files and sensitive
content. If sensitive data enters Git history, stop and notify the maintainers
privately; deleting the working-tree file alone is not sufficient.

## Review checklist

- The change has a narrow purpose and a clear rollback path.
- Focused tests cover success, failure, and boundary behavior.
- Node and renderer type checks pass.
- No user data, secrets, QA output, or unrelated generated files are included.
- Documentation and third-party notices are updated when applicable.
- Any unverified manual, packaged-app, or security gate is stated explicitly.

Security reports must follow [SECURITY.md](SECURITY.md), not a public issue.
