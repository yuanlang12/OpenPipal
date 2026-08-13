# Runtime V2 migration and rollback

Runtime V2 moves generic Agent execution responsibilities toward the stable
public `Agent`, model, tool, and event APIs from the pi-mono lineage, now
published in the current `@earendil-works/pi-*` packages. OpenPipal's product
behavior remains in OpenPipal-owned adapters and extensions.

This migration does **not** embed Pi's official CLI Agent, TUI, command system,
or its application architecture. CLI-specific code is not a Runtime dependency.

## pi-mono lineage boundary

The `pi-core` adapter targets the runnable public `Agent` plus public model,
tool, event, and Node execution contracts exported from the package roots of
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. It must not depend
on `pi-coding-agent` types such as `AgentSession`, `AgentSessionRuntime`,
`SessionManager`, `ResourceLoader`, CLI tool definitions, RPC/TUI modes, or any
`node_modules/.../dist` path.

Pi `0.84.1` still exports `AgentHarness` and v4 Session types, but the Harness is
an unimplemented scaffold: operations such as `prompt` fail with
`HarnessNotImplemented`. OpenPipal therefore does not instantiate it, does not
adopt the v4 lane-based Session repository, and does not claim resumable
in-flight Pi runs. `AgentHarnessTool` remains usable only as a public
context-aware tool type that OpenPipal binds into ordinary `AgentTool` values.

The three direct Pi packages are pinned exactly to `0.84.1` so a routine install
cannot silently change the Runtime contract. Version upgrades require a
separate compatibility change and parity run.

The installed core package declares Node `>=22.19.0`. OpenPipal pins Electron
43.3.0, which embeds Node 24.18.1, and verifies that tuple with a no-network
public `Agent` turn. The same contract probe verifies that selecting the current
Harness scaffold fails closed instead of being mistaken for a runnable Runtime.
This removes the engine mismatch. As of 2026-08-10 the adapter is the
**default** Runtime: the controlled trial cleared its exit gate with 20/20
real-provider samples across two provider identities and one
`legacy -> pi-core -> legacy` continuity matrix per provider, all reproducible
through `scripts/qa/runtime-trial.mjs` and `scripts/qa/runtime-continuity.mjs`.
Becoming the default is not a release gate: the packaged-app, manual UI, and
final security gates are unchanged and still open.

Initial migration baseline: `main@d38a1b1455e3ce3557c5b5c3be49e7cfd9e94495`.

## Non-negotiable invariants

1. `pi-core` is the default since 2026-08-10, after passing the controlled-trial
   exit gate below. `legacy` remains implemented and reachable as the rollback
   valve, and is still selected for any unreadable value, so an unparseable
   configuration never silently runs the newer path. Its removal is registered
   with a sunset condition in `docs/claude/mechanism-registry.md`.
2. Desktop IPC, HTTP/ACP, and scheduler entry points depend only on
   `OpenPipalAgentRuntime`; they do not choose or construct a Pi implementation.
3. Runtime selection is process-lifetime state. It never changes halfway through
   an active conversation.
4. Existing OpenPipal conversation files are never destructively rewritten by an
   experimental Runtime. `pi-core` rebuilds a fresh in-memory `Agent` from the
   supplied OpenPipal history for each `agentChat` call, and the existing
   OpenPipal transcript remains the only durable source of truth.
5. The pi-core implementation must use public exports from the current pi-mono
   lineage. New imports from `node_modules/.../dist` are forbidden.
6. OpenPipal security, permissions, Artifact, MCP, memory, roles, and tool policy
   remain product-owned behavior and require parity tests before cutover.
7. UI locale resources stay outside the Agent Runtime, prompts, tool schemas,
   and transcript. Language switching may translate OpenPipal-owned interface
   labels, but never rewrites user/Agent content or provider/tool payloads.

## Runtime switch

`OPENPIPAL_AGENT_RUNTIME` is the emergency switch:

- unset or `legacy`: use the existing Runtime;
- `pi-core`: explicitly opt into the current pi-core Runtime;
- invalid values: warn once and fall back to `legacy`.

An explicit `pi-core` load or compatibility failure is returned to the caller;
it never silently runs the legacy implementation while claiming that pi-core is
active. A failed initial load may be retried, while a successful selection is
fixed for the process lifetime.

## Current Phase 5 checkpoint

The public `Agent` adapter is the default Runtime; `legacy` is selected only by
an explicit `OPENPIPAL_AGENT_RUNTIME=legacy` or by an unreadable value. Its
execution model is:

- OpenPipal conversation JSON remains the only durable transcript;
- every `agentChat` call creates a fresh in-memory `Agent` state from the
  supplied OpenPipal history, so edited or deleted history cannot reappear;
- `sessionId` is only a conversation correlation/cache-routing value here; there
  is no Pi Session repository, run checkpoint, or in-flight resume contract;
- model credentials are resolved from a conversation-local provider closure,
  never by mutating process-wide environment state;
- system prompt, runtime context, image/history conversion, compaction policy,
  usage accounting, goal checks, and watchdog behavior remain OpenPipal-owned;
- empty-completion recovery rebuilds a clean transient session while retaining
  completed tool evidence and removing only internal retry scaffolding;
- an overflowed turn is never automatically replayed after any tool activity,
  because replay could duplicate writes or other side effects.
- public core read/bash/edit/write tools are composed with OpenPipal-owned
  grep/find/ls, product tools, MCP, Artifact, permission, and security policy;
- skills use the public core loader/formatter while OpenPipal keeps source
  precedence, disabled state, role visibility, and workspace isolation;
- all tools remain sequential because OpenPipal event, permission, and Artifact
  ordering intentionally expose one active tool at a time;
- desktop, HTTP/ACP, and scheduler entry points all route through the same
  Runtime boundary; transcript/goal persistence remains owned by those outer
  product layers.
- cancellation aborts local provider/tool/permission work and propagates an MCP
  cancellation signal when the remote SDK supports it; it does not claim to
  roll back a remote side effect that the external service already committed.

The complete pi-core source graph is gated against `pi-coding-agent` and private
`node_modules/.../dist` imports. The legacy main loop keeps its isolated private
facade for rollback. Nested OpenPipal subagents intentionally share the public
core execution/skill layer under both Runtime selections; therefore the switch
rolls back the top-level Agent loop, not child execution internals. Shared
security hardening (strict sandbox wrapping, canonical tenant paths, bounded
temporary files) also remains active under both selections.

Realtime voice is a separate provider/WebSocket pipeline and is not selected by
`OPENPIPAL_AGENT_RUNTIME`; it receives only regression coverage for shared prompt
or product-tool changes.

## Rollback procedure

1. Unset `OPENPIPAL_AGENT_RUNTIME` or set it to `legacy`.
2. Restart OpenPipal so the process-lifetime Runtime selection is rebuilt.
3. Continue reading the existing OpenPipal conversation store; no downgrade or
   reverse migration should be required.
4. This restores the top-level legacy Agent loop. Shared product security and
   nested subagent execution improvements deliberately remain in place.
5. If the branch itself must be abandoned, return to the recorded `main`
   baseline. No production data migration is permitted before a separate backup
   and restore gate has passed.

This rollback resumes from completed OpenPipal transcript and Artifact data. It
does not roll back an external side effect and cannot resume an interrupted
provider/tool call at its exact in-flight position.

## Phase gates

Every major phase requires:

- focused unit and contract tests;
- the full unit suite and production build;
- a matched legacy/pi-core transcript comparison once the pi-core path exists;
- persistence and restart recovery checks;
- a Codex Security diff scan with blocking findings resolved before proceeding;
- a manual desktop acceptance pass before changing the default.

### Controlled pi-core trial exit gate

The explicit `pi-core` switch is a controlled trial, not an implicit promotion
of the default. After the request-boundary checkpoint `32a8871`, all of the
following must be recorded on the same candidate before `legacy` may cease to
be the default:

1. At least 20 completed real-provider conversations across at least two
   provider identities. A completed conversation must reach a terminal product
   result and persist exactly once; a retry or regenerated turn is not an
   additional sample.
2. Zero unattributed hangs or stalls in that sample. Each turn must have the
   safe `RuntimeTurn` trace (`started`, any first-model event, watchdog or
   external-abort phase where applicable, and `settled`) so a timeout is
   attributable rather than merely silent. The trace is required for both
   pi-core and the legacy rollback leg of the continuity matrix.
3. A clean same-provider `legacy → pi-core → legacy` continuity matrix using
   the same OpenPipal data root: an existing conversation is continued once on
   pi-core and then once on legacy, with selection, persistence, and transcript
   boundaries checked at every restart.
4. The existing parity, security, persistence, desktop, ACP, scheduler, and
   packaged-candidate gates remain satisfied; this trial count does not waive
   any of them.

The 60-second no-response observation before `32a8871` is a negative data
point, not a passing sample. The patch makes explicit conversation session
stream options available to pi-core. That is a candidate explanation for a
provider-level delayed-auth path, but causality is not established. All
successful evidence from before the patch remains labelled pre-fix evidence;
the controlled sample starts after the patch.

Phase 5 is not release-complete until the full suite/build, packaged application,
bounded real-provider matrix, manual desktop/ACP/scheduler pass, and Codex
Security diff scan all pass on the same final snapshot.

The legacy implementation can be removed only after the pi-core path has been
the tested default for a stabilization period and rollback artifacts have been
verified independently.

