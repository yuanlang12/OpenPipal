# Electron 43 migration checkpoint

Original compatibility baseline: `codex/runtime-v2-i18n@12dcaa0`.

This phase established the desktop execution environment and its compatibility
contracts. The default Agent Runtime remains `legacy`; exact opt-in `pi-core`
now runs the public `Agent` from `@earendil-works/pi-agent-core` `0.84.1`.
`AgentHarness` is still an unimplemented scaffold in that release and is used
only by the negative compatibility guard, never as the OpenPipal Runtime.

## Pinned contract

- Electron `43.3.0`
- embedded Node `24.18.1`
- Electron modules ABI `148`
- electron-builder `26.15.7`
- build Node `>=22.19.0`
- minimum packaged macOS version `12.0`

Electron 42 and newer download the binary on demand instead of from the package
postinstall hook. `electron:install` is therefore an explicit, idempotent step
that runs before development, builds, and unit tests. Native application
dependencies remain rebuilt by electron-builder's postinstall step.

## Rollback

Runtime rollback does not require an Electron downgrade: unset
`OPENPIPAL_AGENT_RUNTIME` or set it to `legacy`, then restart the same executable
so process-lifetime selection is rebuilt. Before a release, a full environment
rollback may instead switch the branch or commit back to `12dcaa0`. Do not mix a
dependency rollback with conversation-data migration; this phase does not
change `~/.openpipal`, schemas, sessions, or user configuration.

OpenPipal conversation JSON and Artifact sidecars remain the durable state under
both Runtime selections. The pi-core adapter creates transient in-memory
`Agent` state from that history; it does not use the v4 Session repository and
does not claim that an interrupted provider/tool call can resume in flight.

## Activation and release gates

1. Confirm the exact Electron, Node, and modules ABI tuple in Electron itself.
2. Complete the no-network public `Agent` turn and confirm that attempting a
   Harness prompt fails closed with `HarnessNotImplemented`.
3. Load native `sharp` and PDF/canvas dependencies in Electron.
4. Pass the full unit suite, TypeScript check, and production build.
5. Build an unpacked application for the current architecture and inspect its
   resources before any installed-app launch.
6. Validate both macOS architectures, signing, notarization, and real UI flows as
   separate release gates; none is implied by a source build.

The local arm64 gate may populate a task-scoped cache before invoking Electron's
installer when the default GitHub release URL is unavailable. Any such artifact
must match both GitHub's release-asset SHA-256 and the checksum bundled in the
exact `electron` npm package; a third-party mirror is not an accepted substitute.
