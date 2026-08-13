# Runtime V2 and i18n development verification

**Status: DEVELOPMENT EVIDENCE ONLY — NOT RELEASE ACCEPTANCE**

**Recorded: 2026-08-10**

Evidence anchors in this ledger name exact recorded runs; they do not assert
that a later documentation commit or working-tree `HEAD` still equals the
recorded policy checkpoint.

This ledger records what was actually exercised while developing Runtime V2
and the bilingual interface. It does not change any status in the
[release acceptance manual](release-acceptance.md), because the checks were not
run from a clean, immutable release candidate and no packaged candidate was
exercised. The risk/security review (F-04) has been unfrozen and a read-only
pre-check ran, but it is still unsealed.

## Checkpoints and recovery

- Working branch: `codex/runtime-v2-i18n`.
- Pre-i18n recovery branch: `codex/runtime-v2-pre-i18n-20260809`, pointing to
  `151f852`.
- Runtime/i18n documentation checkpoint before the last UI cleanup: `f296b84`.
- Initial isolated UI-language cleanup checkpoint: `e5da868`.
- Workspace browsing and generated-label lifecycle checkpoint: `9576291`.
- Conversation-status and role-avatar accessibility checkpoint: `b492fb7`.
- Agent-management localization checkpoint: `00648e1`.
- Chat status-surface localization checkpoint: `667f9a8`.
- Design System browser localization checkpoint: `5cb0773`.
- Chat tool-card localization checkpoint: `256a46b`.
- Tools and Skills hub localization checkpoint: `2728e5a`.
- Goal, MCP App, Canvas assistant, Chat alert, and built-in CLI status
  localization checkpoint and latest recorded Runtime/i18n feature source:
  `fa4e1f8`.
- macOS signing-input and localized privacy-purpose checkpoint: `28cd793`.
- fail-closed candidate-policy rebind for those new resources: `9188c13`.
- macOS signing release-contract documentation checkpoint: `0e0477a`.
- fail-closed candidate-policy rebind after that documentation: `b31d374`.
- evidence-only macOS release verifier and self-contained strict ASAR inventory
  checkpoint: `67d9860`.
- candidate-policy classification and rebind for the new evidence tooling, and
  latest immutable recorded policy run before the build-manifest work:
  `18b4592`
  (`18b45923e860f2725e1facc459275f267a79bde7`).
- exact-candidate embedded macOS build-manifest pipeline checkpoint: `8111750`.
- test-only timeout follow-up for the four temporary-Git fixture cases:
  `6138ac8`. This raises only those cases' local limit to 15 seconds; it does
  not change product code or test assertions.
- documentation checkpoint for that pipeline and its release boundary:
  `762ef76`.
- previous immutable candidate-policy binding checkpoint:
  `bd91927`
  (`bd919271a0cdbc5a55e2bc6213f412b1d4d37913`).
- Runtime V2, scheduler/subagent boundaries, app-follow control, Presenter,
  conversation-title and remaining i18n checkpoint: `3798144`.
- current recorded Runtime source checkpoint: `2361f4a`
  (`2361f4a3f1586db4fb44d05612691d4713e2b65e`), which migrates the opt-in
  pi-core adapter to the public Pi `0.84.1` `Agent` API.
- review-correction batch: `9460216` (built-in model display), `52403c6`
  (sequential subagent tools), `ab66995` (extension locale limitation), and
  `610f6a9` (app-tracking isolation).
- current request-boundary checkpoint: `32a8871`
  (`32a8871d68109fbe55754b961b1cd338d236b137`), which explicitly preserves
  conversation session stream options for pi-core provider requests.
- current controlled-trial observability and isolated Electron locale-checkpoint:
  `7f1fd1c` (`7f1fd1c5f551ec83b868e8768aa971d9ab931348`). It adds safe
  per-turn Runtime observability and the executable English built-in-label
  acceptance test described below.
- legacy trial-observability parity checkpoint: `c1dafec`. It gives the
  rollback Runtime the same safe per-turn phase trace as pi-core, so a future
  continuity-matrix timeout can be attributed rather than inferred from an
  aggregate usage row.
- Runtime selection remains process-lifetime and opt-in: default and explicit
  `legacy` use the legacy Runtime; exact `pi-core` selects the public
  `@earendil-works/pi-agent-core` `Agent` path. Pi `0.84.1`'s
  `AgentHarness` is an unimplemented scaffold and is retained only in a
  negative compatibility check. A selected pi-core load failure is surfaced
  instead of silently falling back.
- OpenPipal conversation JSON and Artifact sidecars remain the durable product
  store. The pi-core adapter reconstructs transient Agent state from that
  history rather than introducing a second persisted Session repository or
  claiming in-flight resume.

The user-owned modification to
`tests/artifacts/extension-offline/tc-ext.2-online.png` observed while these
checkpoints were recorded did not enter any of them. Each checkpoint still
contains the older tracked version of that file.

The macOS signing-input checkpoint was verified only at source level: the
focused packaging/Runtime contract bundle passed 2 files and 9 tests, both
TypeScript projects passed, all four plist/strings files passed `plutil`, and a
focused code review of the signing-input changes found no P0/P1/P2 within that
narrow diff. That review was not the frozen F-04 risk/security review. The later
`67d9860` release-verifier checkpoint was also verified only as
evidence-producing code. It does not form
an official release gate by itself. The earlier immutable policy-bound source
at `18b4592` failed closed. The later embedded build-manifest pipeline is
implemented and regression-tested, but it has not produced a real package.
The last immutable policy-bound diagnostic at `bd91927` failed closed with 322
errors across 989 candidate paths. A later diagnostic against feature checkpoint
`2361f4a` also failed closed and deliberately exposed the unbound feature delta:
345 errors across 1,011 candidate paths, including 22 unknown paths. Those paths
were classified and rebound in later checkpoints; the current binding reports
**0 unknown paths** with both the content and path-set bindings matching, and it
still fails closed on excluded paths, blocked replacements and PENDING reviews. Exclusions, blocked replacements, rule review and candidate
identity/approval remain open either way.
No fresh app was packaged, signed, notarized, launched, manually approved, or
granted TCC permissions. Therefore this evidence does not close any packaged,
signing, notarization, real-device, or public-release gate. Across sections
A–F of the release manual, the committed ledger still has **0 PASS** entries.

## Automated evidence

The following results were observed locally on the development branch. They
are useful regression evidence, but they do not satisfy the clean-candidate
requirements in section A of the release manual.

### At `f296b84`

- Runtime focused bundle: 11 files, 64 tests passed.
- i18n focused bundle: 17 files, 94 tests passed.
- Design/Artifact plus deterministic QA fixture bundle: 8 files, 93 tests
  passed.
- Root full unit suite: 150 files passed; 1,143 tests passed and 1 skipped.
- Node, Renderer, and root project-reference TypeScript checks passed.
- ACP typecheck and offline v1/v2 protocol smoke passed.
- Production build passed with the existing Vite static/dynamic import
  warnings.

### At `e5da868`

- The focused resource, shell, and Chat i18n bundle passed: 3 files, 20 tests.
- The full non-loopback unit set passed: 147 files, 1,108 tests passed and 1
  skipped.
- Node and Renderer TypeScript checks passed.
- Targeted ESLint for the changed files passed with zero errors.
- Production build passed with the same existing Vite chunk warnings.
- The three loopback-dependent unit files were not rerun after `e5da868`; they
  are `browser-control.test.ts`, `http-stream-safety.test.ts`, and
  `test-connection-anthropic-gate.test.ts`. They had passed together at
  `f296b84` when run with local-listen permission.

### Through `9576291`

- Workspace browsing chrome, file/preview/source states, stable protocol labels,
  generated tab-title descriptors and Bash/code execution chrome were moved to
  the shared Chinese/English catalogue. User content, Agent content, source
  titles/summaries, file names, URLs and unknown extension ids remain raw.
- The Workspace/i18n focused bundle passed 6 files and 40 tests.
- The full non-loopback unit set passed 148 files and 1,116 tests, with 1 test
  skipped. The three local-listen files named above were not part of that run.
- Node and Renderer TypeScript checks and the production build passed. The
  production build retained the existing Vite static/dynamic import warnings.

### At `b492fb7`

The following focused command was rerun on the checkpoint source with only the
pre-existing, unrelated tracked QA screenshot modified outside the commit:

```sh
./node_modules/.bin/vitest run \
  tests/unit/workspace-entries.test.ts \
  tests/unit/workspace-tab-memory.test.ts \
  tests/unit/renderer-workspace-i18n.test.ts \
  tests/unit/i18n-resources.test.ts \
  tests/unit/renderer-shell-i18n.test.ts \
  tests/unit/renderer-chat-i18n.test.ts
```

Result: 6 files and 42 tests passed. The added assertions cover localized
conversation-status announcements and role-avatar accessibility in addition to
the Workspace label and tab-memory lifecycle. No full unit, loopback, locked
install, repository-wide lint, build, packaged-app or UI result is promoted to
`b492fb7` by this focused rerun.

### Through `5cb0773`

The three commits from `00648e1` through `5cb0773` localize Agent management,
the remaining Chat status surfaces, and the Design System browser. On the
`5cb0773` development source, with only the pre-existing unrelated QA
screenshot modified outside these checkpoints, the following focused command
was rerun:

```sh
./node_modules/.bin/vitest run \
  tests/unit/renderer-agents-i18n.test.ts \
  tests/unit/renderer-chat-i18n.test.ts \
  tests/unit/renderer-design-system-i18n.test.ts \
  tests/unit/i18n-resources.test.ts
```

Result: 4 files and 25 tests passed: 5 Agent-management tests, 8 Chat tests, 6
Design System browser tests, and 6 shared-catalogue tests.

The following Node and Renderer TypeScript checks also exited zero:

```sh
./node_modules/.bin/tsc --noEmit -p tsconfig.node.json
./node_modules/.bin/tsc --noEmit -p tsconfig.web.json
```

Targeted ESLint over all 19 TypeScript/TSX files changed between `3013f23` and
`5cb0773` exited zero. The exact command was:

```sh
./node_modules/.bin/eslint --quiet \
  src/renderer/src/components/AgentTemplateEditor.tsx \
  src/renderer/src/components/AgentsPanel.tsx \
  src/renderer/src/components/MemoryNotice.tsx \
  src/renderer/src/components/MermaidBlock.tsx \
  src/renderer/src/components/MessageBubble.tsx \
  src/renderer/src/components/StreamingInlinePreview.tsx \
  src/renderer/src/components/messages/ScreenshotCard.tsx \
  src/renderer/src/components/messages/SearchResultCard.tsx \
  src/renderer/src/components/messages/shared/PasteButton.tsx \
  src/renderer/src/components/messages/shared/VoiceReplayButton.tsx \
  src/renderer/src/components/shared/markdown-shared.tsx \
  src/renderer/src/components/artifacts/DesignSystemFiles.tsx \
  src/renderer/src/components/artifacts/DesignSystemGallery.tsx \
  src/renderer/src/components/artifacts/DesignSystemView.tsx \
  src/shared/i18n/resources.ts \
  tests/unit/renderer-agents-i18n.test.ts \
  tests/unit/renderer-chat-i18n.test.ts \
  tests/unit/renderer-design-system-i18n.test.ts \
  tests/e2e/ds-gallery.spec.ts
```

`git diff --check 3013f23..5cb0773` also exited zero. The Design System E2E file
only received a locale-aware byte-size assertion update from `4.0KB` to `4 KB`;
the Playwright/E2E test itself was not run.

No full unit suite, loopback bundle, root project-reference check, production
build, locked install, repository-wide lint, packaged-app, Computer Use, or
real-provider/model result is promoted to `5cb0773` by this focused rerun.

### At `256a46b`

`256a46b` localizes OpenPipal-owned chrome in file-result, document, subagent,
and role-archive cards while preserving file names, paths, titles, model names,
Agent output, errors, stop reasons, and other user/provider content as raw
content. The focused Chat-card bundle passed 5 files and 35 tests.

On that same development snapshot, the full non-loopback unit set passed 150
files, with 1,131 tests passed and 1 skipped. The run explicitly excluded the
three local-listen files named above; therefore it is not a complete
`npm run test:unit` or loopback result. Node and Renderer TypeScript checks
passed, and `npm run build` passed with only the existing Vite chunk warnings.
`git diff --check` also exited zero.

At the time this validation was recorded, the only working-tree modification
outside `256a46b` was the user-owned
`tests/artifacts/extension-offline/tc-ext.2-online.png`; it was not staged or
included in the checkpoint or its validation. These are development-checkout
results, not clean-candidate evidence, so every A gate in the release manual
retains its existing **NOT RUN** or **BLOCKED** status. The loopback files,
root locked install, root project-reference check, repository-wide lint, and
packaged-app checks remain unverified on `256a46b`.

### Through `fa4e1f8`

`2728e5a` localizes OpenPipal-owned catalogue, filter, status, action, dialog,
and empty-state chrome in the Tools and Skills hubs. `fa4e1f8` extends that
boundary to Goal status and progress, MCP App permission/fullscreen states,
Canvas assistant commands, the Chat send-failure alert, and built-in CLI tool
status display. Tool and Skill names, descriptions, paths, server names,
capability ids, Goal reasons, and other user/provider/runtime payloads remain
raw content.

On the `fa4e1f8` development snapshot, the full non-loopback unit set passed
152 files, with 1,143 tests passed and 1 skipped. The run explicitly excluded
`browser-control.test.ts`, `http-stream-safety.test.ts`, and
`test-connection-anthropic-gate.test.ts`; it is therefore not a complete
`npm run test:unit` or loopback result. Node and Renderer TypeScript checks,
`npm run build`, and `git diff --check` passed. The build emitted only the
existing Vite warnings.

At the time this validation was recorded, the only working-tree modification
outside `fa4e1f8` was the user-owned
`tests/artifacts/extension-offline/tc-ext.2-online.png`; it was not staged or
included in the checkpoint or its validation. These are development-checkout
results, not clean-candidate evidence, so every A gate in the release manual
retains its existing **NOT RUN** or **BLOCKED** status. The complete
loopback-inclusive unit suite, locked install, root project-reference check,
repository-wide lint, packaged-app checks, and final candidate acceptance
remain unverified on `fa4e1f8`.

### At `67d9860` and policy checkpoint `18b4592`

`67d9860` adds two evidence-only release-preparation components:

- a fail-closed macOS verifier that binds candidate source, app/DMG artifacts,
  signing identity and entitlements, notarization/stapling results, and signed
  manual evidence; and
- a self-contained strict ASAR reader in the third-party inventory, including
  deterministic archive/file integrity and path/link/bounds validation without
  a runtime dependency on Electron's ASAR package.

The focused release bundle passed 4 files and 75 tests. The non-loopback
unit set then passed 156 files, with 1,215 tests passed and 1 skipped. The three
local-listen files passed separately as 3 files and 36 tests after one
machine-local listen authorization; no external network was used. Node and
Renderer TypeScript checks,
`npm run build`, and `git diff --check` passed. The build emitted only the
existing Vite static/dynamic import warnings. These are development-checkout
regression results, not A-gate or packaged-candidate results. The focused and
broader subsets were recorded separately; their counts must not be added, and
the split runs do not constitute the candidate-specific A-11 gate.

After the evidence-tooling paths were classified and rebound at `18b4592`, the
committed candidate verifier was run against exact commit
`18b45923e860f2725e1facc459275f267a79bde7`. It exited 1 with `verdict: FAIL`
and 322 unresolved errors. Both candidate-content and path-set bindings matched;
the report counted 986 candidate paths, zero unknown-path errors, and zero
rule-overlap errors. The 322 errors are 270 excluded paths still present, 42
blocked replacement paths, four candidate identity/approval errors
(`CANDIDATE_OWNER_PENDING`, `CANDIDATE_APPROVER_PENDING`,
`CANDIDATE_STATUS_NOT_APPROVED`, and `CANDIDATE_COMMIT_MISMATCH`), and six
pending rule reviews. Only content/path-set integrity bindings matched; identity
and approval remain unresolved. The diagnostic verdict is **FAIL**, while the
official F-00 ledger status remains **BLOCKED**.

The macOS verifier remains an evidence-only code checkpoint. A standalone
invocation is not an official release gate because a local caller can select
both the trust-bundle path and its expected hash. A protected external runner
must independently pin immutable verifier and inventory bytes, supply an
absolute trust-bundle path with an independently allowlisted SHA-256, generate
the report inside that protected job, and make the final release decision
outside candidate-controlled output. This repository does not yet implement
that control plane.

The committed [`config/macos-release-policy.json`](../config/macos-release-policy.json)
also remains deliberately incomplete: `candidateContentSha256`,
`teamIdentifier`, `review.owner`, `review.approver`, `review.status`, and both
`manualEvidence.operator` and `manualEvidence.approver` values for `identity`,
`keyId`, and `publicKeySpkiBase64` are `PENDING`. The required embedded
`Contents/Resources/openpipal-release-build.json` build-manifest pipeline was
not yet present at this checkpoint. No real package, Developer ID signature,
notarization, staple, signed manual evidence, or signed-package macOS user-view
run exists for this checkpoint. F-06 remains **BLOCKED**.

### Through `8111750` and test follow-up `6138ac8`

`8111750` implements the previously missing exact-candidate embedded
build-manifest pipeline for release-only macOS packages. The dedicated
[`electron-builder.release.yml`](../electron-builder.release.yml) uses the
`afterPack` hook in
[`scripts/embed-macos-release-build-manifest.mjs`](../scripts/embed-macos-release-build-manifest.mjs),
while the existing development, `build:mac`, and `build:unpack` paths remain
unchanged. `release:build-macos` requires an exact candidate at the clean
checkout `HEAD`, rejects tracked/index/non-ignored-untracked changes, reads
bound source bytes from immutable Git blobs, maps builder `arm64`/`x64` to
manifest `arm64`/`x86_64`, and exclusively creates
`Contents/Resources/openpipal-release-build.json` inside the canonical app
bundle. The verifier now reads that manifest fail-closed and binds its
candidate, tree, candidate-content digest, architecture, source digests, and
inventory-recorded bytes to the package and protected trust inputs.

The release-focused bundle passed 5 files and 87 tests. On the same source
snapshot, the non-loopback set passed 157 files, with 1,240 tests passed and 1
skipped. The three local-listen files passed separately as 3 files and 36
tests; no external network was used. Node and Renderer TypeScript checks,
`npm run build`, and `git diff --check` passed. The production build emitted
only the existing Vite static/dynamic import warnings.

The initial all-file parallel run exposed only four temporary-Git fixture
cases exceeding Vitest's default five-second limit under load; no product
assertion failed. `6138ac8` raises the timeout for only those four fixture
cases to 15 seconds, without changing product code or test assertions. The
same-snapshot results above are the final rerun after that test-only change.

This pipeline is implemented but has not been executed to produce a real
dual-architecture package. It is also not a self-authorizing release control
plane. The protected external runner must still enforce a fresh checkout,
fixed dependencies, exact commands, an empty package-output directory, and
isolation from untrusted same-UID mutation for the complete build and
verification interval. It must independently pin verifier/inventory bytes and
the allowlisted trust-bundle digest, retain the report, and decide release
outside candidate-controlled output. The standalone verifier is evidence-only;
the macOS policy, candidate identity/approval and a final binding for any later
documentation or product commit remain pending. Therefore no A–F gate is
promoted to PASS and F-06 remains **BLOCKED**.

### At documentation checkpoint `762ef76` and policy-binding `HEAD` `bd91927`

`762ef76` records the exact-candidate build-manifest pipeline in all three
release ledgers. `bd91927` updates only the candidate policy binding. Running
the committed offline candidate verifier against exact commit
`bd919271a0cdbc5a55e2bc6213f412b1d4d37913` exited 1 with `verdict: FAIL` and
322 errors across 989 candidate paths: 270 excluded paths, 42 blocked
replacement paths, four candidate identity/approval errors and six pending
rule reviews. Candidate-content and path-set bindings both match; unknown-path
and rule-overlap counts are both zero. This is a more current fail-closed
diagnostic than the earlier `18b4592` record, not an F-00 PASS or redistribution
clearance.

### At Runtime/i18n checkpoint `3798144` and Pi `0.84.1` checkpoint `2361f4a`

`3798144` closes the development-source Runtime and bilingual-interface work
that followed `fa4e1f8`: scheduler and subagent source isolation, app-following
pause control, Presenter readiness/localization, empty-conversation display
titles, system-locale refresh, OpenPipal-owned message/error projections, and
the remaining reachable i18n fallbacks. `2361f4a` then migrates the opt-in
pi-core adapter from Pi `0.83.0` to the runnable public Pi `0.84.1` `Agent` API
while preserving the legacy adapter and shared OpenPipal conversation store.
The Pi `0.84.1` `AgentHarness` scaffold is tested only to ensure it is not used.

On the `2361f4a` development snapshot:

- the non-loopback unit set passed 169 files, with 1,316 tests passed and 1
  skipped;
- the three local-listen files passed separately as 3 files and 37 tests, for
  172 files and 1,353 passing tests in the two recorded groups;
- the independent Runtime review bundle passed 15 files and 121 tests, and the
  current i18n/locale review bundle passed 26 files and 153 tests;
- Node and Renderer TypeScript checks, targeted ESLint, `npm run build`, and
  `git diff --check` passed;
- the generated Main bundle contained 50 JavaScript files and 169 relative
  Runtime references, with zero missing referenced chunks; and
- the focused Pi dependency tree resolved the root and nested Pi packages at
  exact version `0.84.1`, with no `0.83` Pi package in that focused tree.

These were development-checkout runs, not section-A executions from a clean
immutable candidate. The grouped test counts must not be added to focused
subsets, and no A–F status changes.

Repository-wide lint is still a release blocker: the latest recorded
`npx eslint src --quiet` run exited non-zero with 66 errors, all under
`src/main`. The locked-install gate is also **BLOCKED** because the root peer
graph has not passed a plain `npm ci`; using `--legacy-peer-deps` is not release
evidence. Because these are development-branch observations rather than a clean
candidate run, A-02 remains **BLOCKED** and A-06 remains **NOT RUN** in the
release manual.

### At review-handover checkpoints `d808603`, `28788c5`, and policy binding `HEAD`

Ownership of the working tree moved from the executing agent to the reviewing
agent at `43625cd`; the executing agent was paused with no partial edits left
behind. Three defects found by review were closed here.

`d808603` restores the Runtime locale boundary. Since `1619afe` both Runtimes
translated the watchdog stall notice with `tMain` before writing it into message
content, so the same conversation produced different transcript bytes per
interface language, and `agent-runtime-boundary`'s "keeps UI locale resources out
of Runtime prompts and tool contracts" assertion had been failing across eleven
commits. Both Runtimes now write the language-neutral sentinel defined in
`src/shared/runtime-notice.ts`, and `messageDisplay` localizes it at display
time, matching the existing `[Error]` prefix treatment. Gateway text stays
byte-for-byte raw. Note for scope: synthetic error bubbles are already excluded
from the model payload by `shouldReplayStoredMessage`, so the defect was
transcript stability and contract enforceability, not model-context leakage.

`28788c5` localizes the four `useLocalSTT` recording/transcription fallbacks,
which reached users through the OrbView tooltip. The existing i18n regression
tests only scan `.tsx` sources, so a `.ts` hook was structurally invisible to
them; the added scanning test rejects Chinese literals inside error-state
setters across every renderer `.ts` file.

The policy commit registers the seven previously unregistered candidate paths
and rebinds the candidate content hash. `UNKNOWN_CANDIDATE_PATH` is back to
**0** and both bindings match; the verifier still returns **FAIL** with 323
errors, all of them the expected excluded-path, blocked-replacement, and
PENDING-review entries. Nothing is approved by this record.

Verification at `HEAD`: both TypeScript project references, 178 unit test files
with 1,410 passed and 1 skipped, and `npx electron-vite build`. Real-provider
behavior, packaged-app behavior, and every release-manual gate are unchanged by
this batch.

### Controlled pi-core trial at `b2ba82b` — cohort **20/20**, continuity **2/2**

The trial was resumed with a committed driver rather than a temporary one:
`scripts/qa/runtime-trial.mjs` and `scripts/qa/runtime-continuity.mjs`. This is a
direct response to the previous unattributed stall, which could not be replayed
because its driver did not survive the run. Every sample below can be re-run by a
third party with the same command line.

Each sample uses a fresh isolated `OPENPIPAL_ISOLATED_HOME`, a fresh conversation,
one real provider turn under explicit `OPENPIPAL_AGENT_RUNTIME=pi-core`, and
`autoMemoryEnabled: false` so no extraction subagent perturbs the sample. The
driver waits past the 120-second watchdog before giving up, so a stall would be
observed rather than truncated.

- **Sample cohort: 20/20 completed with the exact terminal marker**, ten on
  `deepseek-v4-flash` via one gateway identity and ten on `qwen3.7-plus` via a
  different vendor endpoint. Each persisted exactly one conversation file with one
  terminal assistant marker. `first_model_event` ranged 1,079–1,477 ms and settled
  1,439–1,846 ms on the first identity; 592–1,183 ms and 1,511–2,038 ms on the
  second. Zero retries, zero watchdog firings, zero unattributed turns.
- **Continuity matrix: 2/2 passed**, once per provider. Each ran
  `legacy → pi-core → legacy` across three Electron launches sharing one isolated
  data root, so the conversation genuinely continued across processes rather than
  being three separate conversations. Both produced a single persisted file with
  nine messages and three terminal markers, and every leg recorded a complete
  `stream_fn_called` → `stream_opened` → `first_stream_next` → `first_model_event`
  → `settled: completed` trace.

This clears the controlled-trial criterion that `B98254B_R4` had reset to 0/20.
It does **not** explain that failure: the earlier unattributed legacy stall was
**not reproduced** in 26 real-provider turns here, and its root cause remains
unknown. The attribution records added in `84b0775` are now in place, so a
recurrence can be narrowed to a specific local stream boundary; that is the
mitigation, not a fix.

Scope limits, unchanged: this is development evidence from a development
checkout. It is not a frozen candidate, not a packaged app, and it closes no
release-manual gate on its own. Section B of the release manual remains
**NOT RUN**, and `legacy` remains the default Runtime.

### Default promotion and memory opt-in at `HEAD`

Two product defaults changed here on the maintainer's decision.

**`pi-core` is now the default Runtime.** The switch was verified on real
provider turns, not only in unit tests: with `OPENPIPAL_AGENT_RUNTIME` unset the
recorded phase rows report `runtime: pi-core`, and with it set to `legacy` they
report `runtime: legacy`, so the rollback valve still works. The first attempt
recorded `legacy` because the Electron bundle had not been rebuilt after the
source change; that is worth stating, since a unit suite alone would have
reported success while the running app was unchanged. `legacy` stays implemented
and is still chosen for any unreadable value, and its removal now carries a
registered sunset condition in `docs/claude/mechanism-registry.md`.

**Automatic memory is now opt-in and off by default.** Flipping only the config
default would have produced a half-off feature: `autoMemoryEnabled` gated writes
alone, while recall injection was gated by the separate per-role flag, so
existing memories would have kept being injected into every prompt forever. The
gate is now shared by three surfaces — the config default, the recall injection
in `openpipal-prompt-core.ts`, and the workspace-layout prompt section that tells
the model where to read and write memories — so a disabled subsystem leaves no
dangling instruction. Stored memory files are untouched and the Settings toggle
re-enables everything; the toggle copy now says it controls recall as well as
capture. This is a product default, not a repair: the recall design still
injects the whole index rather than selecting by relevance, and the implemented
`findRelevantMemories` scorer still has no callers.

Verification at `HEAD`: both TypeScript project references, 179 unit test files
with 1,412 passed and 1 skipped, `npx electron-vite build`, and the real-turn
default and rollback checks above. No release-manual gate changes.

## User-view evidence from one isolated dev instance

The checks below reused one development Electron identity, one checkout, one
temporary OpenPipal data root, and one deterministic loopback-only
OpenAI-compatible QA fixture. Later bounded calls used the user-configured
DeepSeek preset without copying its credential into evidence. Computer Use
operated the visible OpenPipal UI, while the isolated profile's log and
conversation/Artifact files supplied Runtime and persistence evidence.

The observations remain a development operator record rather than an auditable
candidate record: no packaged app was used, the temporary evidence was not
sealed into the release ledger, and the prompts did not form the complete B–E
matrix. They therefore do not promote any release-manual status.

### Runtime and product-chain observations through `7f1fd1c` (post-`32a8871`)

- On pi-core, the local fixture completed and persisted an ordinary conversation
  and a fresh Design conversation. Design called `create_artifact` once, opened
  the expected SVG in Workspace, and restored the correct Artifact after history
  switching.
- On pi-core with the configured DeepSeek provider, an ordinary turn streamed
  to a terminal response and persisted. Computer Use altered the intended exact
  prompt while entering it, so this run is not counted as an exact-response
  assertion.
- A fresh pi-core DeepSeek Design turn completed in about 13 seconds, made
  exactly one `create_artifact` call, and rendered the requested SVG in
  Workspace.
- After a controlled restart on explicit `legacy`, the same isolated data root
  remained readable. The local fixture completed both an ordinary turn and a
  fresh Design turn; Design used two model calls and produced the expected
  persisted preview/Workspace chain.
- The instance was then returned to explicit `pi-core`. Runtime logs identified
  the selected adapter at each restart; no silent fallback was accepted.

#### DeepSeek no-response ledger and post-fix evidence

One isolated pi-core DeepSeek first-turn attempt logged runtime selection at
`2026-08-10T07:49:51Z` and had no terminal model event within 60 seconds. The
bounded caller stopped it at `2026-08-10T07:50:51Z`. At that time the default
stall watchdog threshold was 120 seconds, so it did not fire before the
external 60-second stop. The pre-fix logs at
`$OPENPIPAL_QA_ROOT/.openpipal/logs/main.log` recorded selection and usage but
had no per-turn phase trace; `$OPENPIPAL_QA_ROOT/.openpipal/usage.jsonl` recorded
only the aggregate call. This was a real observability gap.

`32a8871` makes explicit session stream options part of pi-core's request
boundary. It is a **candidate** explanation for a provider-level delayed
authentication path; the 60-second event does not establish causality and is
not counted as a stable-session result. Any earlier pi-core successes are
pre-fix evidence only. The later `7f1fd1c` checkpoint adds the safe phase
trace used for all future trial samples.

After `7f1fd1c`, two short, isolated pi-core turns against two separately
configured real-provider identities reached a terminal result, persisted once,
and each produced the safe pi-core `RuntimeTurn` phase trace. They establish
that the post-fix real-provider path can complete; they are not credited to the
current controlled sample because the later legacy-observability change below
means they were not run on the final continuity-matrix candidate.

One later same-root `legacy → pi-core → legacy` matrix attempt is explicitly
**not counted and must not be retried with the same marker**. Its first legacy
leg reached the caller's roughly 80-second bound with an aggregate usage row
but no persisted assistant result; at that time legacy lacked a per-turn phase
trace, so the cause is unknown. The pi-core leg later settled after roughly
45 seconds but did not satisfy the test's exact expected-response marker. The
final legacy leg did not issue a verified model turn because the temporary UI
probe selector was too broad. This is negative/inconclusive evidence, not a
continuity success or a provider defect claim.

`c1dafec` closes that legacy observability gap before any new matrix is
attempted. Both Runtimes now write only safe phase/outcome fields—`started`,
`first_model_event`, `external_abort` or `watchdog` when applicable, and
`settled`—without prompts, answers, credentials, or raw upstream errors. A
fresh candidate build and a fresh matrix marker are required before beginning
the 20-session count.

#### `c1dafec` same-root continuity result (development evidence)

One new, unique matrix marker was run in the isolated development data root on
the same configured real-provider identity. A single persisted conversation
contains exactly six messages: the three stage prompts and exactly one matching
assistant result for each of `legacy`, `pi-core`, and final `legacy`. The safe
phase traces were complete for all stages:

- initial `legacy`: first model event at about 42.4 seconds; settled completed
  at about 43.2 seconds;
- `pi-core`: first model event at about 25.9 seconds; settled completed at
  about 27.5 seconds;
- final `legacy`: first model event at about 17.3 seconds; settled completed
  at about 18.0 seconds.

This closes the **development** same-root `legacy → pi-core → legacy` behavior
check and proves that `c1dafec` observes both rollback legs. It is not a frozen
candidate or packaged-app result: the generated development bundle contained
unrelated uncommitted renderer work, and this record is not a substitute for
the 20-session, two-provider controlled sample. The temporary Playwright
driver retained an idle Node cleanup handle after all three Electron windows
had closed; the persisted conversation and JSONL phases above were read before
that driver was ended. No Electron child or provider request remained. This is
a test-driver cleanup issue, not a product completion claim.

#### `51a655a` controlled-trial ledger (development evidence)

The current worktree was rebuilt after the Canvas/security/license checkpoint.
The generated Main entry had 21 relative chunk references and zero missing
targets. The unit suite was also rechecked: the sandbox run passed 173 files
and the three localhost-bound suites passed separately with the native
permission, for 176 files, 1,399 passing tests, and one existing skip. This is
development-build evidence only, not a packaged candidate.

Two new real-provider matrix markers are deliberately **not counted**:

- `R1` completed its initial legacy leg (first model event about 42.5 seconds;
  settled about 43.0 seconds), pi-core leg (about 8.2 / 10.4 seconds), and an
  original final legacy leg (about 10.5 / 11.5 seconds). The temporary driver
  did not report its stage transition while closing Electron. An operator then
  incorrectly treated the still-running final leg as absent and issued a second
  final-legacy prompt with the same marker. The conversation therefore contains
  duplicate final marker prompts/results and is excluded. The original final
  leg also produced an empty internal reasoning record before its terminal text;
  that is not a second terminal answer, but the marker duplication alone makes
  the sample invalid.
- `R2` is a fresh marker and was not retried. Its first **legacy** leg wrote
  `started`, then no first-model event for 75.0 seconds; the bounded caller
  wrote `external_abort` and `settled: external_abort`. Pi-core and the final
  legacy leg were never issued. Because the stop boundary is below the
  120-second watchdog threshold, the watchdog was not expected to fire. This
  is attributable negative provider/request-path evidence, not a pi-core
  completion or a causal conclusion about pi-core.

Both attempts restored the isolated global DeepSeek preset after cleanup. The
clean controlled pi-core sample was **0/20** at this point in the ledger. No
marker above may be reused for a retry; the next attempt required a new marker
and the corrected bounded driver.

- `R3` used a new marker and a second configured DeepSeek provider identity.
  Its same-conversation `legacy → pi-core → legacy` matrix completed with one
  persisted user marker and one persisted terminal assistant marker per leg:
  initial legacy first model event / settlement at about 2.6 / 3.0 seconds,
  pi-core at about 5.3 / 5.7 seconds, and final legacy at about 3.0 / 3.3
  seconds. The conversation contains two empty internal reasoning records;
  neither contains a marker or terminal answer and neither duplicates a leg.
  The isolated global preset was restored to `deepseek-v4-flash-0731`, and no
  Electron child or matrix driver remained after cleanup.

`R3` is the first valid controlled pi-core sample: **1/20** completed samples
and **1/2** required provider identities. `R2` remains an attributable negative
legacy provider/request-path event, so pi-core remains opt-in and the default
does not change.

- `R4` used a new marker with the previously silent `deepseek-v4-flash-0731`
  configured identity. Its same-conversation `legacy → pi-core → legacy`
  matrix again completed with one persisted user marker and one persisted
  terminal assistant marker per leg: initial legacy first model event /
  settlement at about 12.2 / 12.7 seconds, pi-core at about 12.7 / 19.3
  seconds, and final legacy at about 19.8 / 20.3 seconds. The isolated global
  preset was restored and no Electron child or matrix driver remained after
  cleanup. This shows that the earlier `R2` silence did not recur on the same
  configured identity after `32a8871`; it does **not** establish `32a8871` as
  that event's cause.

`R4` is the second valid controlled pi-core sample: **2/20** completed samples
and both required configured provider identities have now been represented.
The default remains legacy until the full numerical and parity gate is met.

- `R5` used a third new marker with the `deepseek-v4-flash-free` configured
  identity. Its same-conversation `legacy → pi-core → legacy` matrix completed
  with one persisted user marker and one persisted terminal assistant marker
  per leg: initial legacy first model event / settlement at about 2.2 / 2.6
  seconds, pi-core at about 2.1 / 2.4 seconds, and final legacy at about 2.6 /
  3.2 seconds. One empty internal reasoning record appears in the persisted
  sequence but has no marker or terminal content. The isolated global preset
  was restored and no Electron child or matrix driver remained after cleanup.

`R5` is the third valid controlled pi-core sample: **3/20** completed samples.
The simple-text continuity sample count is not a substitute for the separate
real tool and Design workflow checks still required before any default switch.

#### Real pi-core Design tool check

`QA_RUNTIME_DESIGN_20260810_51A655A_R2` was a separate fresh Design
conversation on the `deepseek-v4-flash-0731` configured identity. The UI chose
the Design role and conversation-scoped real preset, then sent one bounded
request requiring exactly one `create_artifact` call. Under explicit
`pi-core`, it settled in about 64.7 seconds with exactly one persisted
`create_artifact` tool record, one persisted Artifact reference, and a final
assistant confirmation. The referenced SVG exists under the isolated
conversation Artifact directory and contains the requested `RUNTIME DESIGN OK`
text. No additional tool call, retry, or Electron child remained after cleanup.

This is the fourth completed real-provider pi-core conversation: **4/20**.
It supplements rather than replaces the three successful same-conversation
`legacy → pi-core → legacy` continuity matrices; the legacy default remains in
place until the full gate is met.

#### Volume sample and new silent-turn evidence

`QA_RUNTIME_VOLUME_20260810_51A655A_R1` ran fresh, one-turn pi-core
conversations and stopped on its first nonconforming result. `P1` on
`deepseek-v4-flash-0731` and `P2` on `deepseek-v4-flash-free` each produced
one terminal marker and one persisted assistant result. They bring the total
completed real-provider pi-core conversations observed in this trial to **6**.

`P3`, a fresh `deepseek-v4-flash-0731` pi-core conversation, is deliberately
not counted. It wrote `started` and emitted a provider payload record, but no
first-model event or provider error arrived before the bounded caller aborted
at 75 seconds. Its safe trace is `started → external_abort → settled`, with
zero input/output usage in the terminal row. Concurrent `classin`, `context7`,
and `deepwiki` MCP connection timeouts were logged, but the same diagnostics
also appeared alongside successful turns, so they do not establish a cause.
`P4` was not issued.

This is an **unattributed** pi-core stall. The active clean cohort is therefore
reset to **0/20**, rather than presenting the six historical successful turns
as a clean switch cohort. `472d0cb` reduces the in-product silent-model default
from 120 to 60 seconds for both Runtime adapters while retaining the environment
override and tool-execution exemption. It prevents a longer silent UI wait; it
does not reclassify `P3` or prove an upstream cause. A fresh post-build trial
is required before counting again.

After `472d0cb`, the current worktree was rebuilt. The generated Main entry
contained 26 relative JavaScript chunk references with zero missing targets.
Fresh marker `QA_RUNTIME_POST60_20260810_472D0CB_R1_P1` then completed on
`deepseek-v4-flash-0731` under explicit `pi-core`: first model event at about
17.7 seconds, settlement at about 18.2 seconds, and exactly one persisted
terminal marker. This starts the new clean cohort at **1/20**. It verifies that
the rebuilt 60-second version preserves a normal provider turn.

A separate, isolated Electron fault-injection pass then used a local
OpenAI-compatible endpoint that deliberately never returned the one streaming
chat request. The profile was explicitly English and ran `pi-core`; its
auxiliary no-tools title request returned normally so it could not be confused
with the tested chat request. The one 23-tool chat request reached
`/v1/chat/completions`, then the visible transcript stopped after about 60
seconds with the English OpenPipal-owned error “The model service did not respond
within 60 seconds…”. Its safe runtime trace was
`started → watchdog (60,001 ms; firstModelEvent=false) → settled: watchdog
(60,008 ms)`, and the isolated Electron process exited cleanly. This proves the
post-build user-facing watchdog path and its English rendering; it used no real
provider, so it neither counts toward nor resets the **1/20** real-provider
cohort.

Fresh marker `QA_RUNTIME_POST60_20260810_1619AFE_R2_P1` then completed under
explicit `pi-core` on the second configured identity,
`deepseek-v4-flash-free`. It produced one persisted terminal marker in a fresh
conversation: first model event at about 3.3 seconds and settled completion at
about 3.7 seconds, with one model call and no retry. The isolated global preset
was restored to the local fixture before the call and remained there afterward,
so background title generation did not borrow the real provider. The clean
controlled cohort is now **2/20**, with both required configured provider
identities represented. Legacy remains the default.

The next bounded two-conversation batch,
`QA_RUNTIME_POST60_20260810_06EA144_R3`, also completed under explicit
`pi-core` without a retry. `P1` on `deepseek-v4-flash-0731` recorded its first
model event at about 18.4 seconds and settled at about 18.8 seconds;
`P2` on `deepseek-v4-flash-free` recorded about 3.3 / 4.0 seconds. Each fresh
conversation persisted exactly one terminal marker. The isolated global preset
remained `openpipal-qa-fixture` after the batch. The clean controlled cohort is
now **4/20** across both configured identities; legacy remains the default.

`QA_RUNTIME_POST60_20260810_B98254B_R4` was the required post-fix
same-conversation `legacy → pi-core → legacy` matrix on
`deepseek-v4-flash-0731`, and it is **not** a passing matrix. The first legacy
leg completed (first model event about 19.9 seconds; settled about 26.9
seconds), and the pi-core leg completed (about 9.3 / 9.8 seconds), each with
one persisted terminal marker. The final legacy leg emitted its safe payload
record but received no first model event or provider error; it fired the
60-second watchdog and settled `watchdog` with zero call usage and no terminal
assistant marker. The temporary driver did not retry it and restored the
isolated global fixture preset.

This is an **unattributed legacy stall**, not evidence that pi-core caused the
failure. The same conversation, endpoint, model and session-scoped preset had
completed the two preceding legs; the logs show the final legacy request was
constructed (`msgs=6` and the same system/tool hashes) but provide no upstream
response or causal error. Concurrent MCP/browser-control diagnostics also occur
on successful turns, so they are not assigned as a cause. Because the
controlled-trial criterion permits zero unattributed hangs or stalls, the clean
switch cohort is reset to **0/20** and further real-provider sampling is paused
pending root-cause or better transport-level attribution. Legacy remains the
default and pi-core remains opt-in.

Follow-up `84b0775` adds the required **local** stream-boundary attribution to
both Runtime implementations without changing request payloads, default
selection, retry behavior or provider configuration. Every future model attempt
now records `stream_fn_called`, `stream_opened` and `first_stream_next` before
the existing `first_model_event`/watchdog/settled records, together with an
attempt number. These mean only that OpenPipal called the Provider StreamFn,
obtained a stream iterator, and began its first iterator read respectively;
they do **not** claim that an HTTP request reached the provider or that the
provider accepted it. Thus a future silent turn can be narrowed honestly to
“opening the local provider stream never resolved” versus “the first stream
read produced no model event,” while supplier-side attribution still requires
supplier evidence. The new stream-boundary unit/lifecycle/parity coverage,
Node/Web type checks and a fresh production build passed; the rebuilt Main
bundle had 169 relative JavaScript `require()` references with none missing.
No post-instrumentation real-provider request was sent, so the clean cohort
remains **0/20** and the pause remains in force.

Before making pi-core the default, the controlled-trial gate is: at least 20
completed real-provider conversations across at least two provider identities,
zero unattributed hang or stall, a complete same-provider
`legacy → pi-core → legacy` continuity matrix, and all existing parity/security
gates. This is a development switch criterion only; it does not change any
release-manual B status.

This demonstrates bounded pi-core and legacy development paths plus data-root
compatibility. It is not the release manual's exact frozen-candidate
`legacy → pi-core → legacy` provider matrix, so B-00 through B-09 remain
**NOT RUN**.

### Locale and reachable-surface observations through `2361f4a`

- Selecting English updated the live shell, history, built-in role labels,
  Chat/tool chrome, Workspace/Artifact controls and Settings without restarting.
- User prompts, Agent/model output, custom names, file paths, tool payloads and
  SVG content remained raw rather than being translated.
- Presenter fallback/close/waiting chrome is now committed and covered by its
  i18n and ready-handshake tests; explicit Presenter titles and HTML remain raw.
- History switching removed/restored the correct Workspace Artifact instead of
  leaking another conversation's tab.
- The final preference was restored to **Follow system**; the current supported
  system language resolved to Simplified Chinese and the visible application
  returned to Chinese.
- Global app following remained paused, so opening another application did not
  intentionally trigger OpenPipal window following during this pass.
- A Playwright `_electron` acceptance test launched only an isolated temporary
  development profile (with app tracking disabled and no model request). In
  English it verified the Welcome composer label **Built-in model** and the
  Settings/Models labels **Built-in service** and **Built-in model**. It is
  executable UI evidence for those labels, not a packaged-app or real-provider
  result.

This closes the earlier development observation that was interrupted at the
lock screen. It still does not replace packaged-candidate checks for first
launch under system Chinese/English, unsupported fallback, native dialogs,
Chrome locale, persistence across packaged restarts, or the approved layout
matrix. Every C and E gate remains unchanged.

### Development defects observed and addressed after `f296b84`

The English run exposed mixed-language product chrome: role-state accessibility
labels, Copy/Copied, Workspace tab controls, and the OpenPipal-owned
`create_artifact` receipt prefix. `e5da868` moves these strings to the shared
catalogue or a render-only formatter. Persisted tool results, Artifact titles
and ids, custom role/tab names, user messages, and Agent messages are not
translated.

`9576291` extends that boundary across Workspace browsing, Sources, file and
preview states, generated tab labels, and Bash/code execution cards. `b492fb7`
localizes the remaining conversation-status and role-avatar accessibility
state. `00648e1` localizes Agent management while preserving Agent names,
prompts, paths and descriptions as user content. `667f9a8` localizes memory,
streaming-preview, Mermaid, search, screenshot, paste, voice-replay and Markdown
link chrome without translating message/tool payloads. `5cb0773` localizes the
Design System browser while preserving manifest, review and Agent-feedback
protocol content. `256a46b` extends the same boundary to file-result, document,
subagent, and role-archive cards. `2728e5a` covers the Tools and Skills hubs;
`fa4e1f8` covers Goal, MCP App, Canvas assistant, Chat alert, and built-in CLI
status surfaces. `3798144` and `2361f4a` add the remaining reachable message,
fallback, system-locale, Presenter and app-following boundaries described
above. Their focused and broader offline checks passed, and the visible English
pass sampled the named core surfaces. This is strong development evidence, not
an exhaustive packaged-app language audit.

`b8511a2` closes the Main-process half of the interface language work. Until
this commit every failure string that the renderer displayed verbatim — skill
import, plugin installation and manifest/MCP validation, whisper transcription,
voice connection and preview, the four export chains, workspace file preview,
the scheduler silent-run prefix, MCP OAuth, and thinking detection — was a
Chinese literal, so an English interface printed Chinese on failure. Main now
emits a locale-neutral `errorKey` plus parameters and the renderer translates at
display time, reusing the `errorKey` contract that `config-manager.testConnection`
already had rather than adding a second mechanism. Text that Main did not author
(gateway `message`, WebSocket `err.message`, OS `stderr`) is passed through
without a key so a translation cannot overwrite the evidence.

Two boundaries were preserved rather than crossed. `pi-agent-service.ts` is inside
the set that `agent-runtime-boundary` forbids from importing UI locale resources,
so its thinking-detection result carries key strings only and does not import
`main-i18n`. The subagent `maxTurns` notice is persisted into the transcript, so
it uses the `runtime-notice` sentinel already established for the model-stall
notice instead of a translated string.

Three checks were added and pass: `main-i18n-key-existence` resolves every literal
`tMain`/`mainError` key in `src/main` against both catalogues; `main-user-facing-i18n`
rejects new Chinese literals in the `error`/`invalid`/`warnings`/`skip` slots of the
eleven cleaned files, with an explicit `i18n-exempt` marker for model-facing tool
results that must not follow the UI language; `main-error-localization` asserts the
same failure renders in either language while foreign text passes through untouched.

Both TypeScript projects and `npx electron-vite build` pass. A serial
`npx vitest run --fileParallelism=false --testTimeout=60000` run is fully green at
1430 tests. Under default parallelism this machine intermittently times out
`open-source-candidate`, `macos-release-build-manifest` and `quickjs-sandbox-abort`;
a stash-and-rerun control on the pristine tree reproduced the same timeouts, so they
are load-induced and not caused by this change. No packaged build and no
real-machine English pass over these specific failure paths was performed.

`4a6db6d` widens the real-model coverage and corrects the driver that produced
the earlier cohort. The previous `scripts/qa/*.mjs` launches passed
`out/main/index.js` as the Electron entry, which makes `app.getAppPath()` resolve
to `<repo>/out/main`, so bundled `resources/` was unreachable for the whole run.
Nothing in a plain runtime turn needs those files, so the recorded 20/20 cohort
still measures what it claims, but any resource-dependent behavior was silently
absent from it — most visibly the evolver seed, which made "save as Agent"
fail in 3 ms with `Evolver system prompt is empty` and leave a permanently
placeholder workspace. The drivers now launch the directory, matching
`npx electron .`.

With that corrected, each of the six built-in roles (general, learner, teacher,
design, office, interpreter) completed one real `deepseek-v4-flash` turn on the
default runtime in a fresh isolated home: all six reported `runtime=pi-core`,
`outcome=completed`, and first-model-event between 1043 ms and 1785 ms. "Save as
Agent" was then exercised end to end on general, teacher and design; each one ran
the evolver subagent for roughly a minute and produced a named workspace with a
written `agent.md` (575 characters on the design sample) instead of the
placeholder. This is a single sample per role on one provider, not a matrix.

The same instrumentation identified a first-message stall that users can feel.
`getAvailableClis()` probes 23 commands with `execFileSync` (`which` plus
`--version`, 2 s and 3 s timeouts) and sits on the system-prompt assembly path,
so the first message after launch paid 2697 ms of fully blocked Electron main
thread — no IPC replies, no repaint, hence the macOS wait cursor. A parallel
`execFile` warm-up now fills the same cache during startup idle. Measured on one
machine with the same preset: cold first message went from 4747 ms to 1906 ms
send-to-first-token, the warm-up completed at 1199 ms after launch, and the
synchronous scan no longer runs. The synchronous function is unchanged, so a
message sent before the warm-up finishes still works, just slowly.

Both TypeScript projects, `npx electron-vite build`, and a serial
`npx vitest run --fileParallelism=false` (1429 passed, 1 skipped) are green. No
packaged build was exercised, and no human looked at these flows on screen.

## Not verified by this development pass

- A controlled same-prompt real-model `legacy → pi-core → legacy` comparison,
  broader model-quality/cache behavior, or real image input on both Runtimes.
  A bounded real-provider pi-core turn and Design tool loop were observed, but
  they do not form that matrix.
- The post-`32a8871` controlled pi-core trial: there is not yet a 20-session,
  two-provider sample, and the recorded pi-core-to-legacy continuation is only
  one leg of the required full matrix. The pre-fix 60-second no-response is
  explicitly not counted and its candidate root cause remains unproven.
- Exhaustive user-view coverage of every post-`f296b84` Workspace,
  execution-card, accessibility, Agent-management, Chat status/tool-card,
  Design System browser, Tools/Skills hub, Goal, MCP App, Canvas assistant,
  Chat alert and built-in CLI status surface at every state. The later pass
  covered the specifically recorded reachable flows only.
- Full Electron integration automation for locale events, focus/visibility
  refresh, Tray/native fanout and an already-open browser prompt. Current tests
  cover the manager/helpers and source contracts; the development UI pass
  covers the visible core flow.
- The changed Design System gallery Playwright assertion and its surrounding
  E2E flow; the assertion was updated but the E2E test was not run.
- A single clean-candidate, unexcluded `npm run test:unit` invocation and root
  project-reference TypeScript. Non-loopback and loopback groups passed
  separately on the development checkout.
- ACP and scheduler user flows on both Runtimes.
- Packaged, signed, notarized, Intel, or Apple-silicon distributable behavior.
- The `67d9860` macOS evidence verifier under a protected external release
  runner; the embedded build-manifest pipeline is now implemented through
  `8111750` but has not produced a real package, and the repository still has
  no protected control plane, completed trust policy, real signed artifacts,
  notarization, or signed manual evidence.
- A first launch with English first in the macOS preferred-language list, an
  unsupported system locale, tray/native-dialog localization, or full Chrome
  extension locale switching.
- Design revision/export, interrupted-turn recovery, backup/restore, and the
  approved minimum layout/200% zoom matrix.
- Legal clearance, publishable Git history, repository-wide lint, or a clean
  locked install.

## Frozen gates

- The F-04 risk/security review was unfrozen by the maintainer. A read-only
  pre-check ran and its two high-severity findings were remediated in `51a655a`
  (srcdoc frames that were same-origin with the host and so exposed the preload
  bridge to model-authored HTML; unescaped `execSync` interpolation in the CLI
  registry). This is a pre-check, not the seal: no attack test, no candidate
  validation, and no sealed review against an immutable publication commit
  exists, so **F-04 remains BLOCKED** in the release manual.
- Root license selection is decided: the repository carries Apache-2.0 with
  `Copyright 2026 yuanlang12`, and `package.json` declares it. Third-party and
  provenance clearance, branding policy, repository-history review,
  signing/notarization, and final maintainer approval remain blocked in
  [open-source readiness](open-source-readiness.md). A license file is not
  clearance for material the project does not own.

Until every required release-manual gate is closed against one immutable
candidate, OpenPipal is **not ready for public source release**.
