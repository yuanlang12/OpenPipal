# OpenPipal release acceptance manual

> **Current ledger: NOT RUN / BLOCKED.** This file is an execution template, not
> evidence that any release gate has passed. The F-04 risk/security review is
> frozen and unsealed, and the repository is not approved for public source
> release. See [open-source readiness](open-source-readiness.md).

Evidence anchors below name exact recorded runs. The last previously recorded
policy-bound diagnostic names `bd91927`; later feature/documentation changes
require a new immutable candidate binding and do not inherit that result.

The current Runtime/i18n development checkpoints recorded outside this release
ledger are `3798144` (Runtime V2 and bilingual core) and `2361f4a` (Pi 0.84.1
public `Agent` migration). Their Agent-management, Chat
status/tool-card/alert, Design System browser, Tools/Skills hub, Goal, MCP App,
Canvas assistant, built-in CLI, Presenter handshake, and application-following
regression evidence is documented in the
[Runtime V2 and i18n development ledger](runtime-v2-i18n-dev-verification.md).
On `2361f4a`, the non-loopback unit set passed 169 files with 1,316 tests passed
and 1 skipped; the three local-listen files passed separately with 37 tests, for
172 files and 1,353 passed tests in total. Node and Renderer TypeScript, the
production build, targeted lint, and the generated Main-bundle
relative-reference scan also passed. These results came from a development
checkout rather than a clean immutable release candidate. They therefore do
not change any A, B, C, D, E, or F status in this manual.

The evidence-only release checkpoint `67d9860` adds a fail-closed macOS verifier
and a self-contained strict ASAR inventory reader. Its focused bundle passed 4
files and 75 tests. The non-loopback set passed 156 files with 1,215 tests
passed and 1 skipped; the three local-listen files passed separately as 3 files
and 36 tests after one machine-local listen authorization; no external network
was used. Node and Renderer
TypeScript, `npm run build`, and diff-check passed, with only the existing Vite
warnings during build. These results validate evidence-producing code, not an
immutable release candidate or any A–F gate. The focused and broader subsets
were recorded separately; their counts must not be added, and the split runs do
not constitute candidate-specific A-11.

The exact-candidate build-manifest checkpoint `8111750` implements the
release-only `afterPack` pipeline that embeds
`Contents/Resources/openpipal-release-build.json` and extends verifier-side
candidate/source/architecture binding. `6138ac8` is a test-only follow-up: it
raises the local timeout for four temporary-Git fixture cases to 15 seconds,
without changing product code or assertions. The release-focused bundle passed
5 files and 87 tests. On the final same source snapshot, the non-loopback set
passed 157 files, with 1,240 tests passed and 1 skipped; the three local-listen
files passed separately as 3 files and 36 tests. Node and Renderer TypeScript,
`npm run build`, and diff-check passed, with only the existing Vite warnings
during build. The pipeline has not produced a real package, these development
results are not candidate-specific A-gate evidence, and the committed A–F
ledger still has **0 PASS** entries.

At the last committed policy-binding checkpoint `bd91927`
(`bd919271a0cdbc5a55e2bc6213f412b1d4d37913`), the committed candidate verifier
exited 1 with **FAIL** and 322 errors: 270 excluded paths, 42 blocked
replacement paths, four candidate identity/approval errors
(`CANDIDATE_OWNER_PENDING`, `CANDIDATE_APPROVER_PENDING`,
`CANDIDATE_STATUS_NOT_APPROVED`, and `CANDIDATE_COMMIT_MISMATCH`), and six
pending rule reviews. Its candidate-content and path-set integrity bindings
match. It counts 989 candidate paths and reports zero unknown-path and zero
rule-overlap errors. The diagnostic verdict is **FAIL**; the official F-00
ledger status remains **BLOCKED**. The documentation checkpoint `762ef76`
precedes this policy-binding commit, so the current documentation changes will
require another immutable binding before any candidate-specific run.

The macOS verifier is not a standalone official gate. The repository has no
protected external control plane that independently fixes immutable verifier
and inventory bytes, supplies an absolute trust-bundle path with an
independently allowlisted SHA-256, generates the report inside the protected
job, and decides final release outside candidate-controlled output. That runner
must also enforce a fresh checkout, fixed dependencies, exact approved
commands, an empty package-output directory, and isolation from untrusted
same-UID mutation for the full build and verification interval. The macOS
policy still has `PENDING` values for `candidateContentSha256`,
`teamIdentifier`, `review.owner`, `review.approver`, `review.status`, and both
signer records' `identity`, `keyId`, and `publicKeySpkiBase64`. The embedded
build-manifest generation pipeline is implemented but has not been executed on
a real package. No real package, Developer ID signature,
notarization/staple, signed manual evidence, or signed-package macOS user-view
run exists, so F-06 remains **BLOCKED**.

Presenter localization and readiness-handshake changes are committed in the
current recorded development source; their focused handshake and i18n tests pass. This
supersedes the earlier Presenter development blocker, but it is not
candidate-specific C-05 evidence.

Later Computer Use passes exercised isolated development instances, not a
release candidate. The local deterministic fixture completed ordinary and
Design turns on both `legacy` and `pi-core`. A real DeepSeek ordinary turn on
`pi-core` completed streaming, tool handling, and persistence, but Computer Use
altered the submitted prompt, so no exact-response assertion is counted. A
real DeepSeek Design turn on `pi-core` completed in 13 seconds with exactly one
`create_artifact` call and the expected Workspace/SVG result. An explicit
English hot switch covered shell, history, roles, chat, tool card, Workspace,
Artifact, and settings surfaces while user/model/Artifact content remained raw;
the preference was then restored to **Follow system**, which currently resolves
to Simplified Chinese. These are bounded development observations only and do
not change B, C, or D statuses or replace their full candidate matrices.

## 1. How to use this manual

Every result belongs to one immutable candidate commit. A result from another
commit, a dirty checkout, a different application bundle, or an older package
cannot be carried forward.

Use only these status values:

- **NOT RUN** — no candidate-specific evidence exists yet.
- **PASS** — the exact procedure passed on the recorded candidate and its
  evidence is available.
- **FAIL** — the procedure ran and did not meet the expected result.
- **BLOCKED** — the procedure cannot run or cannot pass until a stated decision,
  authorization, or external prerequisite is resolved.
- **N/A** — permitted only with a written release-owner justification.

The committed copy of this manual intentionally remains `NOT RUN` / `BLOCKED`.
After freezing a clean candidate, copy it to a private evidence directory outside
the repository and update statuses only in that copy. Otherwise recording a
result would change the candidate being tested.

Set up the evidence ledger before running a gate:

> `OPENPIPAL_CANDIDATE` below is the **private** commit under test — that is what gates A
> through E measure. Gate F-00 is the exception: the open-source policy verifier takes the
> commit of the **cut public tree**, not this one. Passing this variable to it produces a
> guaranteed, meaningless failure. See "What the candidate commit is, and how to build one"
> in [`open-source-readiness.md`](open-source-readiness.md).

```sh
export OPENPIPAL_CANDIDATE="$(git rev-parse HEAD)"
export OPENPIPAL_EVIDENCE_ROOT="/absolute/private/path/openpipal-release-evidence/$OPENPIPAL_CANDIDATE"
umask 077
mkdir -p "$OPENPIPAL_EVIDENCE_ROOT"/{A,B,C,D,E,F}
cp docs/release-acceptance.md "$OPENPIPAL_EVIDENCE_ROOT/release-acceptance.md"
```

`OPENPIPAL_EVIDENCE_ROOT` must be absolute, private, durable, and outside this
checkout. Evidence may contain the candidate path/hash, the isolated QA paths,
provider/model names, and the exact synthetic prompt/brief fixtures needed to
reproduce a comparison. Do not put provider keys, tokens, full `config.json`,
the operator's real home/profile paths, real user prompts/data, or unredacted
logs in evidence. Each command record must include stdout/stderr, exit code,
start/end time, and the candidate commit.

## 2. Real-device constraint: one instance, one authorization, no package swap

The user-view pass has a strict operating boundary:

1. Run exactly one OpenPipal desktop process at a time. Do not leave an installed
   OpenPipal, a second dev/Electron process, or a stale ACP adapter running. The
   one short-lived ACP client required by an ACP gate may connect to that active
   desktop process and must exit before the next ACP gate.
2. Use one checkout, the root and ACP dependency trees installed from their
   committed lockfiles, one Electron executable, one app identity, and one
   isolated data root for the entire dev pass.
3. Grant macOS screen-recording permission once to that exact app identity. Do
   not rebuild, reinstall, rename, replace, or switch packages to chase a new
   permission grant.
4. Process restarts required by Runtime selection and locale persistence are
   allowed only from the same frozen checkout and executable. A restart is not
   permission to change the package.
5. Build the ACP adapter once before the pass. ACP, scheduler, extension, and
   desktop checks must reuse the same active OpenPipal process; do not start a
   second OpenPipal process for the adapter.
6. If the app identity changes, a second instance appears, dependencies change,
   or another authorization is requested unexpectedly, stop and mark the
   affected gates **BLOCKED**. Do not improvise another package.

A dev pass does not substitute for a packaged-app pass. To minimize repeated
permissions, release owners may skip the dev pass and run the same user-view
matrix on one fixed packaged candidate instead. If both are run, their evidence
and authorization boundaries are separate; dev results cannot be relabeled as
packaged results.

## 3. Candidate and isolated data setup

Obtain a fresh checkout at the candidate commit. Do not clean or reset a working
tree that contains another person's work. Run the entire B-E user-view pass in
one dedicated QA macOS login; this login is the one screen-recording
authorization boundary, and it must not change during the pass. In that clean
checkout, verify:

```sh
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
git diff --exit-code
git diff --cached --exit-code
node --version
npm --version
sw_vers
uname -m
```

Expected: the commit equals `OPENPIPAL_CANDIDATE`; all Git cleanliness commands
produce no diff/status output; Node is at least `22.19.0`; macOS and architecture
are recorded.

Create task-specific roots. Never point these variables at a real user profile:

```sh
export OPENPIPAL_QA_ROOT="$(mktemp -d /tmp/openpipal-release-qa.XXXXXX)"
export OPENPIPAL_QA_BROWSER_ROOT="$(mktemp -d /tmp/openpipal-browser-qa.XXXXXX)"
```

Every OpenPipal desktop or ACP command in sections B-E must receive the same QA
home. Chrome uses the separate browser root shown in C-08 and E-03:

```sh
env HOME="$OPENPIPAL_QA_ROOT" \
  OPENPIPAL_ISOLATED_HOME="$OPENPIPAL_QA_ROOT" \
  ./node_modules/.bin/electron-vite dev
```

The expected startup log contains `[QA] isolated OpenPipal home:` followed by
`OPENPIPAL_QA_ROOT`. A missing or different path is a **FAIL**; stop before using
the app.

## A. Automated same-snapshot gates

Unless explicitly marked **BLOCKED**, entries start **NOT RUN**. Run them in the
clean candidate checkout. A zero exit code is necessary but does not replace
the manual gates below.

The current development dependency change required npm's legacy peer-resolution
mode. A fresh, plain `npm ci` on the root dependency graph has not yet been
proved, so A-02 is currently **BLOCKED**. Repair the peer graph or approve and
commit a reproducible install policy, freeze a new candidate, reset A-02 to
**NOT RUN**, and then run both plain locked installs. If either fails, mark it
**FAIL**. Do not use `--legacy-peer-deps` merely to turn this gate green.

Repository-wide lint is also not green on the current development branch. The
latest recorded `npx eslint src --quiet` run exited non-zero with 66 errors, all
under `src/main`. That development result is not a candidate-specific A-06 run,
so A-06 remains **NOT RUN** rather than PASS. A candidate frozen from the current
state cannot pass A-06 until the errors are resolved or a release owner records
an explicit, reviewable policy change.

| ID | Status | Command or procedure | Expected result | Evidence location |
|---|---|---|---|---|
| A-01 Candidate identity | **NOT RUN** | Run the commands in section 3 before dependency installation. | Clean checkout; exact commit, OS, architecture, Node and npm recorded. | `A/01-candidate.txt` |
| A-02 Locked installs | **BLOCKED** | After resolving the peer-policy block and freezing a new candidate, run `npm ci`, then `npm --prefix openpipal-acp ci`, once each. Do not install or upgrade another package after this stage. | Both dependency trees install from their committed lockfiles without override flags; root and ACP manifests/lockfiles remain unchanged. | `A/02-npm-ci-root.log` and `A/02-npm-ci-acp.log` |
| A-03 Node TypeScript | **NOT RUN** | `./node_modules/.bin/tsc --noEmit -p tsconfig.node.json` | Exit 0 with no type errors. | `A/03-tsc-node.log` |
| A-04 Web TypeScript | **NOT RUN** | `./node_modules/.bin/tsc --noEmit -p tsconfig.web.json` | Exit 0 with no type errors. | `A/04-tsc-web.log` |
| A-05 Root project references | **NOT RUN** | `./node_modules/.bin/tsc --build tsconfig.json --pretty false --force` | Both referenced projects build from the candidate without stale-cache success. Generated ignored output is not release evidence by itself. | `A/05-tsc-root.log` |
| A-06 Lint | **NOT RUN** | `npm run lint` | Exit 0. Any waiver is a release-owner decision and must not be hidden as PASS. | `A/06-lint.log` |
| A-07 Runtime focused tests | **NOT RUN** | Run Runtime command bundle A-RUNTIME below. | Every listed file passes, including default/opt-in selection, lazy boundary, explicit failure, lifecycle, semantic parity, role isolation, tool authorization/abort handling, parent context and scheduler policy/surface routing on both Runtimes. | `A/07-runtime-focused.log` |
| A-08 i18n focused tests | **NOT RUN** | Run i18n command bundle A-I18N below. | Every listed file passes, including system resolution, persistence, Main/Renderer/HTTP/extension contracts, Workspace label lifecycle, Agent management, Chat status/tool-card/alert surfaces, Tools and Skills hubs, Design System browser, Goal/MCP App/Canvas and built-in CLI status surfaces, Presenter handshake/chrome, application following, accessibility status copy and catalogue parity. | `A/08-i18n-focused.log` |
| A-09 Design/Artifact focused tests | **NOT RUN** | Run Design command bundle A-DESIGN below. | Role/preflow path, Artifact scoping, preview/history state and export contract tests pass. | `A/09-design-focused.log` |
| A-10 ACP offline contract | **NOT RUN** | `npm --prefix openpipal-acp run typecheck`, then `npm --prefix openpipal-acp run test:protocol`. The committed `test:protocol` script runs the ACP build before its smoke test. | ACP typecheck and offline v1/v2 protocol smoke pass without a desktop app. `openpipal-acp/dist/index.js` is built once for manual testing. | `A/10-acp-offline.log` |
| A-11 Full unit suite | **NOT RUN** | `npm run test:unit` | Complete root unit suite exits 0. Focused results alone are insufficient. | `A/11-full-unit.log` |
| A-12 Production build | **NOT RUN** | `npm run build` | Main, preload and renderer production build exits 0. | `A/12-build.log` |
| A-13 Unpacked package | **NOT RUN** | `npm run build:unpack` | Unpacked app is produced for the current architecture and launches only in the later packaged-app pass. | `A/13-build-unpack.log` plus artifact manifest |
| A-14 macOS packages | **NOT RUN** | Only inside the protected runner's fresh candidate checkout, require `HEAD` to equal the full `OPENPIPAL_CANDIDATE`, use fixed committed dependencies and exact approved commands, confirm the committed mac target still lists `arm64` and `x64`, and choose a nonexistent `OPENPIPAL_PACKAGE_OUTPUT` outside the checkout. Create the empty directory once, then run `OPENPIPAL_RELEASE_CANDIDATE="$OPENPIPAL_CANDIDATE" npm run release:build-macos -- --config.directories.output="$OPENPIPAL_PACKAGE_OUTPUT"`. The runner must exclude untrusted same-UID mutation until verification finishes. List/hash only that directory's `.app`/DMG files; inspect each app's embedded `Contents/Resources/openpipal-release-build.json`, top-level privacy keys, and `Contents/Resources/{en,zh-Hans}.lproj/InfoPlist.strings`. Never reuse ignored `out/` or historical `dist/` releases as candidate evidence. | Both arm64 and x86_64 manifests and their arm64/x64 packages bind the same exact candidate, tree, candidate-content digest, and source digests; purpose strings are top-level and both locales are present. This does not imply signing, notarization or legal clearance. | `A/14-build-mac.log`, isolated file list, embedded manifest copies, Info.plist evidence and SHA-256 hashes |
| A-15 Post-build cleanliness | **NOT RUN** | Re-run `git status --porcelain=v1 --untracked-files=all`, `git diff --exit-code`, and `git diff --cached --exit-code`. Record and hash the files under `$OPENPIPAL_PACKAGE_OUTPUT`; record local `out/` or `dist/` only if either path exists. | No tracked or non-ignored source change exists. The external package-output manifest is retained; any local ignored artifact path is recorded separately, and an unexpected output location is investigated rather than assumed safe. | `A/15-post-build-clean.txt` and `A/15-build-files.txt` |

### A-RUNTIME

```sh
./node_modules/.bin/vitest run \
  tests/unit/agent-runtime-selection.test.ts \
  tests/unit/agent-runtime-boundary.test.ts \
  tests/unit/agent-runtime-host.test.ts \
  tests/unit/agent-runtime-semantic-parity.test.ts \
  tests/unit/pi-core-compatibility.test.ts \
  tests/unit/pi-core-harness-contract.test.ts \
  tests/unit/pi-core-models.test.ts \
  tests/unit/pi-core-runtime-lifecycle.test.ts \
  tests/unit/pi-core-tool-authorizer.test.ts \
  tests/unit/pi-core-tool-bridge.test.ts \
  tests/unit/pi-mcp-bridge-abort.test.ts \
  tests/unit/role-context-isolation.test.ts \
  tests/unit/scheduler-runtime-safety.test.ts \
  tests/unit/scheduler-tool-policy.test.ts \
  tests/unit/scheduler-legacy-tool-surface.test.ts \
  tests/unit/scheduler-pi-core-tool-surface.test.ts \
  tests/unit/subagent-parent-context.test.ts
```

### A-I18N

```sh
./node_modules/.bin/vitest run \
  tests/unit/locale-contract.test.ts \
  tests/unit/locale-manager.test.ts \
  tests/unit/locale-ipc-contract.test.ts \
  tests/unit/locale-http-contract.test.ts \
  tests/unit/i18n-resources.test.ts \
  tests/unit/i18n-p1-boundaries.test.ts \
  tests/unit/main-i18n.test.ts \
  tests/unit/renderer-i18n.test.ts \
  tests/unit/renderer-shell-i18n.test.ts \
  tests/unit/renderer-chat-i18n.test.ts \
  tests/unit/renderer-conversation-title-i18n.test.ts \
  tests/unit/renderer-presenter-i18n.test.ts \
  tests/unit/presenter-window-handshake.test.ts \
  tests/unit/file-display.test.ts \
  tests/unit/process-render.test.ts \
  tests/unit/teacher-personal-style-contract.test.ts \
  tests/unit/renderer-tools-skills-i18n.test.ts \
  tests/unit/renderer-agents-i18n.test.ts \
  tests/unit/renderer-workspace-i18n.test.ts \
  tests/unit/renderer-settings-i18n.test.ts \
  tests/unit/renderer-secondary-surfaces-i18n.test.ts \
  tests/unit/preflow-i18n.test.ts \
  tests/unit/renderer-artifacts-i18n.test.ts \
  tests/unit/renderer-artifact-runtime-i18n.test.ts \
  tests/unit/renderer-artifact-canvas-i18n.test.ts \
  tests/unit/renderer-design-system-i18n.test.ts \
  tests/unit/workspace-entries.test.ts \
  tests/unit/workspace-tab-memory.test.ts \
  tests/unit/extension-i18n-contract.test.ts \
  tests/unit/extension-page-i18n.test.ts \
  tests/unit/app-detector-following.test.ts \
  tests/unit/app-follow-settings.test.ts \
  tests/unit/app-following-client-contract.test.ts \
  tests/unit/web-app-following-shim.test.ts \
  tests/unit/web-locale-shim.test.ts
```

### A-DESIGN

```sh
./node_modules/.bin/vitest run \
  tests/unit/role-context-isolation.test.ts \
  tests/unit/role-manifest-path-security.test.ts \
  tests/unit/artifact-registry.test.ts \
  tests/unit/artifact-scoping.test.ts \
  tests/unit/workspace-tab-memory.test.ts \
  tests/unit/workspace-visibility-memory.test.ts \
  tests/unit/export-artifact-validate.test.ts
```

## B. Runtime acceptance

Every B gate is currently **NOT RUN** for a release candidate. Earlier
Computer Use observations on isolated development instances used the local
deterministic fixture for ordinary and Design turns on both `legacy` and
`pi-core`. A later real DeepSeek ordinary turn on `pi-core` completed streaming,
tool handling, and persistence; because Computer Use altered the prompt, no
exact-response assertion is counted. A real DeepSeek Design turn on `pi-core`
completed in 13 seconds with exactly one `create_artifact` call and the expected
Workspace/SVG result. These are not clean-candidate or packaged-app results,
and they do not complete B-05's same-prompt dual-Runtime real-provider matrix or
B-04's frozen-candidate restart rollback procedure. Do not promote these
partial development observations to candidate, rollback, Design Agent, or
provider PASS status.

Runtime selection is process-lifetime state. Stop the current process before
changing `OPENPIPAL_AGENT_RUNTIME`, then relaunch the same executable with the
same `OPENPIPAL_QA_ROOT`. Do not edit the variable while a conversation is
running and call that a Runtime switch.

Use these launch forms for the dev pass:

```sh
# Default / rollback Runtime
env -u OPENPIPAL_AGENT_RUNTIME \
  HOME="$OPENPIPAL_QA_ROOT" \
  OPENPIPAL_ISOLATED_HOME="$OPENPIPAL_QA_ROOT" \
  ./node_modules/.bin/electron-vite dev

# Explicit pi-core opt-in
env HOME="$OPENPIPAL_QA_ROOT" \
  OPENPIPAL_ISOLATED_HOME="$OPENPIPAL_QA_ROOT" \
  OPENPIPAL_AGENT_RUNTIME=pi-core \
  ./node_modules/.bin/electron-vite dev

# Explicit legacy rollback after stopping pi-core
env HOME="$OPENPIPAL_QA_ROOT" \
  OPENPIPAL_ISOLATED_HOME="$OPENPIPAL_QA_ROOT" \
  OPENPIPAL_AGENT_RUNTIME=legacy \
  ./node_modules/.bin/electron-vite dev
```

For a packaged pass, first complete A-13 through A-15, then select one unpacked
executable from those final outputs, record its SHA-256 and absolute path as
`OPENPIPAL_APP_EXEC`, and replace the Electron launch command in each applicable
Runtime launch form above with `"$OPENPIPAL_APP_EXEC"`. Never rebuild or replace
that executable during the pass.

```sh
export OPENPIPAL_APP_EXEC="/absolute/path/to/OpenPipal.app/Contents/MacOS/OpenPipal"
shasum -a 256 "$OPENPIPAL_APP_EXEC"
```

Before B-01, configure one supported real provider and one fixed model inside
the isolated QA profile, using a dedicated, revocable, spending-limited QA
credential. Record only provider/model identity, never the credential. All B
and D prompts/briefs must be bounded synthetic fixtures stored in evidence. If
the blank QA profile cannot be configured without copying real user
configuration, mark the affected gates **BLOCKED**.

For the deterministic **product-chain check only**, the repository also ships a
loopback-only OpenAI-compatible QA fixture. It does not call the internet, and
it must never be counted as real-provider compatibility or model-quality
evidence. Start it as a short-lived companion process, then configure a custom
provider in the isolated profile with the printed base URL, fixed model and
fixed QA token:

```sh
node scripts/qa/openai-compatible-fixture.mjs --port 40421
# baseUrl: http://127.0.0.1:40421/v1
# model:   openpipal-qa-fixture
# apiKey:  openpipal-qa-only
```

Use an ordinary bounded prompt for the text path. For the Design tool path,
include the explicit marker `[QA_DESIGN_ARTIFACT]`; the fixture will request one
bounded SVG through `create_artifact`, wait for the tool result, then finish the
turn. Use a fresh Design conversation for each Runtime pass so the deterministic
title and call sequence cannot collide with an earlier artifact in the same
history. Stop the fixture after B-00. Do not reuse this profile or token for any
real endpoint. The fixture's final text only acknowledges the tool result; the
operator must verify UI visibility and isolated-root persistence independently.
The fixed token is only a test request discriminator, not a secret or a defense
against other local processes; run the fixture only for the bounded QA pass.

| ID | Status | Manual step | Expected result | Evidence location |
|---|---|---|---|---|
| B-00 Deterministic local product chain | **NOT RUN** | With the QA fixture above, use Computer Use to send one ordinary prompt, then open a Design Agent conversation and send `[QA_DESIGN_ARTIFACT]`. Repeat on legacy and pi-core using the same frozen candidate and isolated root selected for this dev or packaged pass. | Both Runtimes stream the fixed text; Design calls `create_artifact` once, shows the SVG in the client and persists one conversation/tool/artifact chain under the QA root. This proves only the local UI→Runtime→tool→storage path. | `B/00-local-fixture-legacy/` and `B/00-local-fixture-pi-core/` |
| B-01 Legacy default | **NOT RUN** | Launch with `OPENPIPAL_AGENT_RUNTIME` unset. Start one desktop conversation with the preflight provider and a bounded synthetic prompt. | Log states `selected legacy runtime`; conversation streams, finishes and persists. No pi-core selection is logged. | `B/01-legacy-default/` |
| B-02 pi-core opt-in | **NOT RUN** | Stop B-01 cleanly; relaunch with exact value `pi-core`; continue the existing conversation and start a new one. | Log states `selected pi-core runtime`; both turns use existing OpenPipal history and persist once. No legacy selection is logged. | `B/02-pi-core-opt-in/` |
| B-03 Explicit failure does not silently downgrade | **NOT RUN** | Keep pi-core selected and use a duplicate QA provider preset with an intentionally invalid credential for one bounded turn. Also retain A-07's explicit loader-failure test result. | User sees one actionable failure; logs remain pi-core and never report a legacy selection or a false successful answer. Do not corrupt a package to force a loader failure manually. | `B/03-no-silent-fallback/` |
| B-04 Restart rollback | **NOT RUN** | Stop pi-core; relaunch with explicit `legacy` using the same data root; reopen B-02 conversations and send a follow-up. | Existing history is readable without migration; new turn completes on legacy; shared product/security behavior remains available. | `B/04-restart-rollback/` |
| B-05 Real provider desktop matrix | **NOT RUN** | With the preflight provider, exact same synthetic prompt and fixed model, run one completed desktop turn on legacy and pi-core. | Both produce coherent final output and stable streaming/tool order. Record provider/model identity, duration and outcome, never the key. | `B/05-real-provider-desktop/` |
| B-06 ACP on both Runtimes | **NOT RUN** | While each Runtime is active, run `(cd openpipal-acp && env HOME="$OPENPIPAL_QA_ROOT" node scripts/e2e-stage4.mjs)`. | ACP basic stream ends normally and cancellation ends as cancelled. The resulting conversations are persisted once under the active Runtime. | `B/06-acp-legacy/` and `B/06-acp-pi-core/` |
| B-07 Scheduler on both Runtimes | **NOT RUN** | In Tasks, create a synthetic enabled task using the same real provider, choose a clear scope, save it, and use **Run now** once under each Runtime. | Each run starts once, records success/error honestly, persists the correct role/conversation binding and remains visible after restart. No duplicate turn is created. | `B/07-scheduler-legacy/` and `B/07-scheduler-pi-core/` |
| B-08 Cross-entrypoint isolation | **NOT RUN** | Sequentially run a desktop turn, ACP turn and scheduler turn against different synthetic conversations, then inspect each history. | No role, working directory, prompt, Artifact, credentials or partial response leaks between entry points. | `B/08-entrypoint-isolation/` |
| B-09 Process restart stability | **NOT RUN** | After completed legacy and pi-core turns, restart the same candidate twice without changing data or dependencies. | Completed history and task state return; no turn is replayed merely because of restart. | `B/09-restart-stability/` |

## C. Multilingual acceptance

For system-language checks use a dedicated QA macOS login. Do not change the
operator's active account. `system` chooses the first supported language in the
macOS preferred-language list; if the list contains no supported Chinese or
English entry, the effective locale is English.

Chrome extension shell strings follow Chrome's UI locale. The connected OpenPipal
web interface follows OpenPipal's locale bridge. Record these as two distinct
expectations.

The later isolated development pass explicitly switched to English and observed
the shell, history, roles, chat, tool card, Workspace, Artifact, and settings
surfaces change while user/model/Artifact content remained raw. The preference
was then restored to **Follow system**, which currently resolves to Simplified
Chinese. This did not exercise every C-05 surface, restart persistence,
system-English first launch, unsupported fallback, native dialogs, or the Chrome
extension matrix. Every C status below therefore remains unchanged.

Use the same Chrome application and isolated browser root for both extension
locale runs. Fully quit the QA Chrome process between these launches; confirm
the command line and profile path in `chrome://version` before loading the
extension:

```sh
# English Chrome UI
open -na "Google Chrome" --args \
  --user-data-dir="$OPENPIPAL_QA_BROWSER_ROOT" \
  --lang=en-US --no-first-run --disable-default-apps

# After fully quitting the English run: Simplified Chinese Chrome UI
open -na "Google Chrome" --args \
  --user-data-dir="$OPENPIPAL_QA_BROWSER_ROOT" \
  --lang=zh-CN --no-first-run --disable-default-apps
```

| ID | Status | Manual step | Expected result | Evidence location |
|---|---|---|---|---|
| C-01 Automated locale contracts | **NOT RUN** | Complete A-08 on the exact candidate. | Shared catalogue, Electron/Main/Renderer/HTTP and extension contracts all pass. | `A/08-i18n-focused.log` |
| C-02 System Chinese | **NOT RUN** | In the QA login, put a Chinese locale first among supported preferred languages, leave OpenPipal preference at **Follow system**, and launch/restart the same candidate. | Initial document/UI locale is `zh-CN`; onboarding, welcome and settings appear in Simplified Chinese. | `C/02-system-zh/` |
| C-03 System English | **NOT RUN** | Put English first among supported preferred languages and relaunch with **Follow system**. | Initial document/UI locale is `en`; migrated shell/chat/settings copy is English. | `C/03-system-en/` |
| C-04 Unsupported system fallback | **NOT RUN** | In the dedicated QA login, use a preferred-language list containing no Chinese or English entry, then relaunch with **Follow system**. | Effective locale is English; UI remains usable and does not expose raw translation keys. | `C/04-unsupported-to-en/` |
| C-05 Manual immediate switch | **NOT RUN** | In Settings → Appearance → Language, switch Chinese → English → Chinese without restarting. After each switch inspect active Chat status/tool-card/alert surfaces, Agent management, Tools and Skills hubs, Design System browser, Presenter default/close/waiting chrome, Goal, MCP App permission/fullscreen states, Canvas assistant commands, and built-in CLI tool status. | Renderer text changes once per selection; selected option, document language and current/effective labels agree. User/Agent, prompt, manifest, review, Goal reason, tool/Skill metadata, server name and file content remain raw. No translated surface exposes a stale string, raw translation key, or mixed hard-coded language. | `C/05-manual-switch/` |
| C-06 Preference persistence | **NOT RUN** | Select explicit English, restart the same candidate/data root, then select explicit Chinese and restart again. | Explicit preference survives restart and does not revert to the system locale. | `C/06-restart-persistence/` |
| C-07 Tray and native dialogs | **NOT RUN** | In each explicit locale, open the tray menu and trigger conversation export, working-folder selection and Artifact export-folder dialogs. | Tray tooltip/menu and native titles/filter labels use the selected locale after the locale change/restart; no mixed hard-coded language in the tested surfaces. | `C/07-main-native/` |
| C-08 Extension packaged locale | **NOT RUN** | Use the two isolated Chrome launch forms above, load unpacked `openpipal-extension/`, and verify English then Simplified Chinese after a full Chrome quit/relaunch. | `chrome://version` shows the QA profile and intended `--lang`; manifest name, disconnected shell, retry status and context menus follow Chrome locale; action IDs and authentication behavior remain unchanged. | `C/08-extension-chrome-locale/` |
| C-09 Connected sidebar refresh | **NOT RUN** | With the same extension/profile and one active OpenPipal instance, change OpenPipal's language and refresh/reconnect the sidebar. | Connected OpenPipal UI uses the desktop locale endpoint/change event; disconnected extension shell continues to follow Chrome locale. | `C/09-extension-connected/` |
| C-10 Layout baseline and long-copy resilience | **BLOCKED** | Release owner first records the minimum supported docked content size. At that exact size, inspect English/Chinese onboarding and settings at default and 200% Renderer zoom; inspect the extension at 200% Chrome zoom and the tray at the QA account's recorded OS text scale. | The baseline is explicit and repeatable; controls remain readable, text wraps or truncates intentionally, and primary actions remain reachable by keyboard. Until the baseline is approved, this gate stays BLOCKED. | `C/10-layout-baseline.txt` and `C/10-layout-resilience/` |

## D. Design Agent acceptance

Use synthetic brand and product content with no third-party or user data. Keep the
same real provider used by B-05 so this flow also exercises the actual Runtime.

Isolated development passes completed local-fixture Design turns on both
`legacy` and `pi-core`. A real DeepSeek Design turn on `pi-core` completed in 13
seconds, made exactly one `create_artifact` call, and showed the expected
Workspace/SVG result. These were not clean-candidate runs and did not include
the complete revision/export, restart-recovery, or equivalent real-provider
dual-Runtime procedures. Every D status below remains **NOT RUN**.

| ID | Status | Manual step | Expected result | Evidence location |
|---|---|---|---|---|
| D-01 Automated Design boundary | **NOT RUN** | Complete A-09 and the role-isolation portion of A-07. | Design role, preflow path, Artifact scope, history state and export contracts pass. | `A/09-design-focused.log` and `A/07-runtime-focused.log` |
| D-02 Welcome page | **NOT RUN** | Create a new conversation and inspect the default welcome page; select the built-in Design role. Repeat in Chinese and English. | New conversation starts on the general welcome selector; Design name/tagline/abilities are localized and selecting it does not lose or reuse another role's conversation. | `D/02-welcome/` |
| D-03 Design preflow | **NOT RUN** | On Design, choose a template, enter a synthetic brief, optionally attach a synthetic image, select the intended model and submit. | Design preflow appears, records the selected task type/model/assets in this conversation only, and the submitted brief is visible before/with the first turn. | `D/03-preflow/` |
| D-04 Generate Artifact | **NOT RUN** | Ask Design Agent for one small, deterministic visual deliverable that requires an Artifact. | One Artifact is created under the Design conversation, streaming state settles, and the final preview renders without borrowing another conversation's file. | `D/04-generate/` |
| D-05 Revise, preview and export | **NOT RUN** | Ask for one bounded revision, compare preview before/after, then use a supported export action. | Revision changes the intended Artifact, completed history remains coherent, preview matches the saved result, and export creates the expected synthetic output once. | `D/05-revise-preview-export/` |
| D-06 History isolation | **NOT RUN** | Create a second Design conversation and a General conversation. Switch among all three, close/reopen Artifact tabs, then restart. | Messages, role brief, working directory, Artifact list/tab state and output history remain bound to their original conversation/role; switching back restores only that conversation's state. | `D/06-history-isolation/` |
| D-07 Runtime comparison | **NOT RUN** | Repeat D-03 through D-05 once on legacy and once on pi-core using equivalent synthetic briefs. | Both Runtimes preserve OpenPipal Design behavior; any content-quality difference is recorded, not hidden as an infrastructure pass. | `D/07-runtime-comparison/` |

## E. User-data isolation and recovery

These checks validate only the isolated QA profile. They must not inspect, copy,
modify, or restore a user's real `~/.openpipal` content.

For E-06, keep the recovery copy private and outside both the repository and
evidence directory. Run each line separately and stop if the non-existence check
fails:

```sh
export OPENPIPAL_QA_BACKUP="/absolute/private/path/openpipal-qa-backup-$OPENPIPAL_CANDIDATE"
test ! -e "$OPENPIPAL_QA_BACKUP"
ditto "$OPENPIPAL_QA_ROOT" "$OPENPIPAL_QA_BACKUP"
export OPENPIPAL_QA_RESTORE="$(mktemp -d /tmp/openpipal-release-restore.XXXXXX)"
ditto "$OPENPIPAL_QA_BACKUP" "$OPENPIPAL_QA_RESTORE"
```

| ID | Status | Command or manual step | Expected result | Evidence location |
|---|---|---|---|---|
| E-01 Isolation preflight | **NOT RUN** | Confirm `OPENPIPAL_QA_ROOT` is an absolute temporary path and is not the current login's home or real OpenPipal directory. Launch with both `HOME` and `OPENPIPAL_ISOLATED_HOME` set as in section 3. | Startup logs the exact isolated root; config, conversations, token and Electron userData appear only below it. | `E/01-isolation-preflight/` |
| E-02 Single authorization | **NOT RUN** | Grant screen-recording permission once to the frozen app identity. Continue all user-view checks without replacing the executable. | Capture works after the documented restart; no second authorization is requested. | `E/02-single-authorization/` |
| E-03 Cross-process QA home | **NOT RUN** | Run ACP commands with `HOME="$OPENPIPAL_QA_ROOT"`; launch Chrome with the C-08 `--user-data-dir` forms; inspect OpenPipal/ACP paths and Chrome's `chrome://version` profile path without opening file contents. | ACP token/data resolve below the QA root; Chrome profile data resolves below the browser QA root; neither uses the operator's profile. | `E/03-cross-process-paths/` |
| E-04 Restart recovery | **NOT RUN** | Complete a conversation and task, stop cleanly, and relaunch the same executable/data root. | Completed conversation, locale preference, task and Artifact metadata recover exactly once. | `E/04-restart-recovery/` |
| E-05 Interrupted-turn recovery | **NOT RUN** | In the isolated profile, stop the app during a long synthetic response, then relaunch. | No partial response is presented as a completed success; previously completed turns remain readable; retry is explicit. | `E/05-interrupted-turn/` |
| E-06 Backup/restore drill | **NOT RUN** | Stop OpenPipal, run the backup commands above, relaunch the original root and make one visible synthetic change, stop again, then launch the same candidate with both `HOME` and `OPENPIPAL_ISOLATED_HOME` set to `OPENPIPAL_QA_RESTORE`. Do not overwrite or delete the original. | Restored root shows the pre-change state; original QA root remains available for comparison; no real user directory participates. | `E/06-backup-restore/` |
| E-07 Evidence sanitization | **NOT RUN** | Review the evidence directory manually before handoff. | Candidate/app paths, isolated QA paths and synthetic fixtures/hashes remain auditable; API keys, ACP/browser tokens, full config, operator profile paths, real user prompts/data, browser profile contents and unrelated screenshots are absent. | `E/07-sanitization-signoff.txt` |

## F. Open-source, legal, security, history and signing gates

These gates cannot be satisfied by build output or UI tests. The statuses below
reflect the current repository state and remain **BLOCKED** until the referenced
evidence is approved for the exact candidate.

Run the candidate tools only after A-01 proves that a clean checkout's `HEAD`
equals `OPENPIPAL_CANDIDATE`. Save generated output outside the repository. The
candidate verifier deliberately exits nonzero while any exclusion,
replacement, unclassified path, content binding, or approval remains open.
Do not hide that exit code. `npm run --silent` is required when redirecting JSON
so npm's command banner does not corrupt the report.

```sh
run_candidate_policy_gate() {
  OPENPIPAL_F00_DIR="$OPENPIPAL_EVIDENCE_ROOT/F/00-candidate-policy"
  mkdir -p "$OPENPIPAL_F00_DIR"
  OPENPIPAL_F00_STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # 注意：这里要的是**裁剪出来的公开树**的提交，不是 $OPENPIPAL_CANDIDATE（私仓那个）。
  # 构建步骤见 open-source-readiness.md 的「What the candidate commit is」。
  if npm run --silent open-source:verify-candidate -- \
    --repo "$OPENPIPAL_PUBLIC_CANDIDATE_REPO" \
    --commit "$OPENPIPAL_PUBLIC_CANDIDATE" \
    > "$OPENPIPAL_F00_DIR/report.json" \
    2> "$OPENPIPAL_F00_DIR/stderr.log"; then
    OPENPIPAL_F00_STATUS=0
  else
    OPENPIPAL_F00_STATUS=$?
  fi

  OPENPIPAL_F00_FINISHED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  {
    # 两个提交都记：私仓那个是"这份公开树从哪裁出来的"，公开候选那个才是被验的对象
    printf 'privateCandidate=%s\n' "$OPENPIPAL_CANDIDATE"
    printf 'publicCandidate=%s\n' "$OPENPIPAL_PUBLIC_CANDIDATE"
    printf 'publicCandidateRepo=%s\n' "$OPENPIPAL_PUBLIC_CANDIDATE_REPO"
    printf 'startedAt=%s\n' "$OPENPIPAL_F00_STARTED"
    printf 'finishedAt=%s\n' "$OPENPIPAL_F00_FINISHED"
    printf 'exitCode=%s\n' "$OPENPIPAL_F00_STATUS"
  } > "$OPENPIPAL_F00_DIR/execution.txt"

  return "$OPENPIPAL_F00_STATUS"
}

run_candidate_policy_gate
```

The function records evidence before returning the verifier's real status, both
with and without shell `errexit`; `report.json` includes the committed policy
path and SHA-256. Do not continue to F-02 unless it returns 0 and the report says
`verdict: PASS`.

```sh
export OPENPIPAL_CANDIDATE_APP="/absolute/path/to/OpenPipal.app"

run_third_party_inventory_gate() {
  OPENPIPAL_F02_DIR="$OPENPIPAL_EVIDENCE_ROOT/F/02-third-party"
  mkdir -p "$OPENPIPAL_F02_DIR"

  OPENPIPAL_F02_CHECKOUT_STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if npm run --silent open-source:inventory -- --format json \
    > "$OPENPIPAL_F02_DIR/checkout-inventory.json" \
    2> "$OPENPIPAL_F02_DIR/checkout-stderr.log"; then
    OPENPIPAL_F02_CHECKOUT_STATUS=0
  else
    OPENPIPAL_F02_CHECKOUT_STATUS=$?
  fi
  OPENPIPAL_F02_CHECKOUT_FINISHED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  {
    printf 'candidate=%s\n' "$OPENPIPAL_CANDIDATE"
    printf 'startedAt=%s\n' "$OPENPIPAL_F02_CHECKOUT_STARTED"
    printf 'finishedAt=%s\n' "$OPENPIPAL_F02_CHECKOUT_FINISHED"
    printf 'exitCode=%s\n' "$OPENPIPAL_F02_CHECKOUT_STATUS"
  } > "$OPENPIPAL_F02_DIR/checkout-execution.txt"
  if [ "$OPENPIPAL_F02_CHECKOUT_STATUS" -ne 0 ]; then
    return "$OPENPIPAL_F02_CHECKOUT_STATUS"
  fi

  OPENPIPAL_F02_APP_STARTED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  if npm run --silent open-source:inventory -- \
    --app "$OPENPIPAL_CANDIDATE_APP" --format json \
    > "$OPENPIPAL_F02_DIR/app-inventory.json" \
    2> "$OPENPIPAL_F02_DIR/app-stderr.log"; then
    OPENPIPAL_F02_APP_STATUS=0
  else
    OPENPIPAL_F02_APP_STATUS=$?
  fi
  OPENPIPAL_F02_APP_FINISHED="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  {
    printf 'candidate=%s\n' "$OPENPIPAL_CANDIDATE"
    printf 'app=%s\n' "$OPENPIPAL_CANDIDATE_APP"
    printf 'startedAt=%s\n' "$OPENPIPAL_F02_APP_STARTED"
    printf 'finishedAt=%s\n' "$OPENPIPAL_F02_APP_FINISHED"
    printf 'exitCode=%s\n' "$OPENPIPAL_F02_APP_STATUS"
  } > "$OPENPIPAL_F02_DIR/app-execution.txt"

  return "$OPENPIPAL_F02_APP_STATUS"
}

run_third_party_inventory_gate
```

The inventory reports are inputs to human review. They are not notices, legal
conclusions, or release approval, even when generation exits zero.

`npm run release:verify-macos` is currently an evidence-only diagnostic, not an
official F-06 gate. Its implemented inputs cover the exact candidate, mapped
arm64/x86_64 app and DMG paths, manual-evidence file, online-notary profile and
submission records; it also requires an absolute protected trust-bundle path
and expected SHA-256. The release-only embedded
`Contents/Resources/openpipal-release-build.json` pipeline is implemented, but
it has not produced real artifacts. This manual intentionally does not provide
a runnable F-06 command template yet: the approved artifacts, completed
policy/trust bundle, and protected external runner do not exist. A local caller
can choose both trust-bundle environment values, so a
standalone report cannot close F-06 even if it says PASS. The external release
control plane must enforce a fresh checkout, fixed dependencies, exact approved
commands, an empty output directory, and isolation from untrusted same-UID
mutation for the full interval. It must independently pin the
verifier/inventory bytes and allowlisted trust-bundle hash, run the verifier
inside its immutable job, retain the report, and make the release decision
independently.

| ID | Status | Required decision or procedure | Expected result | Evidence location |
|---|---|---|---|---|
| F-00 Candidate policy verifier | **BLOCKED** | Resolve every `PENDING`, excluded path, blocked replacement, unknown path, overlap, evidence mismatch, candidate-content mismatch, and policy/candidate identity error; then run the committed verifier against the full immutable commit. | Exit 0 and `verdict: PASS`; the policy blob, candidate content binding, candidate commit, and final manifest all identify the same reviewed candidate. A verifier PASS is necessary evidence, not legal clearance. | `F/00-candidate-policy/` |
| F-01 Root license and ownership | **BLOCKED** | Maintainers select a root license, confirm copyright ownership and reconcile README/package metadata. | Approved root license exists and no source-closed statement conflicts with it. | `F/01-root-license/` |
| F-02 Third-party inventory | **BLOCKED** | Resolve every PENDING/EXCLUDED item in [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md); generate both checkout/lockfile/repository-input evidence and `--app` ASAR/Resources/native evidence for the exact packaged candidate with the self-contained strict ASAR reader; manually reconcile both reports and place required notices. | File-level keep/replace/remove decisions and required notices cover source, app and extension; every native binary is compatible with the candidate app architecture. A successful strict inventory is evidence only, not clearance. | `F/02-third-party/` |
| F-03 Prompts, DC Runtime and brand | **BLOCKED** | Resolve every relevant row in the [open-source provenance decision register](open-source-provenance.md), including Design prompt archives, `resources/dc-runtime/`, Skills, extension files, icons, avatars, brand assets and QA screenshots; replace or remove anything not cleared. | Every included file has an approved origin/terms record; excluded material is absent from candidate and package manifests. | `F/03-special-material/` |
| F-04 Security review | **BLOCKED** | Only after explicit authorization, resume the frozen review, disposition every candidate, remediate/accept findings and seal the result against this commit. Do not infer PASS from older or partial scan artifacts. | Sealed review names the exact commit and has no unresolved release blocker. | `F/04-security/` |
| F-05 Repository/history hygiene | **BLOCKED** | Review the exact candidate and publishable Git history for credentials, user data, private prompts, generated QA output, large/internal files and forbidden paths. Rebuild a clean history if required. | Approved history manifest and reviewer signoff exist; working-tree cleanliness alone is insufficient. | `F/05-history/` |
| F-06 Signing and notarization | **BLOCKED** | First implement the protected external runner, approve its independently pinned trust bundle, and complete `config/macos-release-policy.json`; the embedded `Contents/Resources/openpipal-release-build.json` pipeline already exists but has not produced a real package. The runner must enforce the fresh-checkout/fixed-dependency/exact-command/empty-output/same-UID-isolation boundary. The policy currently has `PENDING` values for `candidateContentSha256`, `teamIdentifier`, `review.owner`, `review.approver`, `review.status`, and both signer records' `identity`, `keyId`, and `publicKeySpkiBase64`. Then establish release identity and custody, fail if Developer ID is absent, and never fall back to unsigned/ad-hoc output. Build and sign both architectures; inspect effective entitlements and Team IDs for the app, Helpers, and every Mach-O `.node`, `.dylib`, or native launcher; inventory/hash non-Mach-O assets such as Photon WASM. Run notarization/stapling and the committed verification checks. On the same signed identity, complete every required signed manual check, including localized privacy prompts, TCC flows, native/JIT/WASM paths, Runtime chat, Design Artifact, DMG/app matching, and both hardware architectures. | The externally accepted report binds immutable verifier/inventory bytes, allowlisted trust bundle, candidate source, embedded build manifest, exact distributed app/DMG hashes, one approved non-empty Team ID, hardened Runtime, entitlements, notarization/staple, and dual-signed manual evidence. No local standalone report is sufficient. | `F/06-signing-notarization/` |
| F-07 Public project policy | **BLOCKED** | Approve supported versions, contribution/CI policy, maintainer roles, release authorization and disclosure handling; enable and verify private vulnerability reporting from an external reporter account. | Public documents agree and a working private security channel exists. | `F/07-project-policy/` |
| F-08 Final manifest and approval | **BLOCKED** | Bind A-E results and F decisions to one immutable commit, final file/package hashes and recoverable internal checkpoint. Obtain explicit maintainer approval before changing visibility or publishing. | One signed release record has no NOT RUN, FAIL or BLOCKED required gate. | `F/08-final-approval/` |

## W. Windows package gates (feature/windows)

Windows 首发不签名，不走 F-06 那套外部 runner 与信任包。这一节只证明三件事：**包是对的、
装上的就是这个包、核心链路在真 Windows 上跑得动。** 全部通过也只是 Windows 包本身的证据，
不替代 A–F 任何一项。

| Gate | What to do | Pass condition | Evidence |
|---|---|---|---|
| W-01 Native build | 正式包由 `.github/workflows/windows-build.yml` 在 Windows runner 上原生打（`windows-latest` → x64，`windows-11-arm` → arm64）。Mac 上的 `npm run build:win:cross` 只作虚拟机冒烟：它把 esbuild / sharp / canvas 的 win32 变体临时塞进 node_modules 再打。**裸跑 `electron-builder --win` 打出的包在 Windows 上启动即崩**（只带 darwin 二进制），不得当发布物。 | 两个架构的 job 都绿，产物里有 `openpipal-<version>-<arch>-setup.exe` | Actions run / `dist/` |
| W-02 Factory check | `npm run release:verify-windows -- --dist <dir>`（CI 里自动跑）。检查：安装包在且 ≥ 40MB、app.asar 带 out/ 三件与 package.json、`@esbuild/win32-<arch>` 必须在（x64 还要 `@img/sharp-win32-x64`）、没有 dotenv / 私钥 / dist-qa / website、extraResources（托盘 .ico、dc-runtime、skills、acp、mcp-servers.json）齐。 | 每个架构 `verdict: PASS`；arm64 允许一条 `PLATFORM_PACKAGE_UNAVAILABLE` 告警（@napi-rs/canvas 0.1.80 没有 win32-arm64 预编译；sharp 自 0.35 起有） | `windows-release-report-<arch>.json` |
| W-03 Installed = built | 装到 Windows 上后跑 `scripts/verify-windows-install.ps1 -ExpectedAsarSha256 <sha>`，`<sha>` 取自 W-02 报告的 `asarSha256`。**版本号相等不算证据**（与 macOS /release 第 3 步同一条纪律）。 | 退出 0，`matchesExpected: true` | 脚本输出的 JSON |
| W-04 Smoke on real Windows | 同一台机器（虚拟机可）：① 启动无崩溃、主进程日志无 `Cannot find module`；② 设置 → 模型 测试连接通；③ 让 agent 跑 `git status`，出现确认卡且理由含"没有系统沙箱"；④ `cat ~/.ssh/id_rsa` 被拒，理由含"凭据路径"；⑤ `powershell` 工具 `Get-Date` 有返回；⑥ 打开应用跟随，切到记事本，面板贴到记事本旁；⑦ capture_screenshot 返回记事本窗口的图；⑧ 粘贴到记事本成功；⑨ 托盘图标可见，标题栏 — 最小化、× 收进托盘；⑩ 切深色主题，窗口边缘无白边。 | 十项全过；截图存证 | `W/04-smoke/` 截图 + 日志 |

## 4. Completion and reset rules

The candidate is **not releasable** if any required entry is `NOT RUN`, `FAIL` or
`BLOCKED`. A passing build, dev UI pass, or packaged launch cannot override a
legal, security, history or signing block.

If source, lockfile, resources, package configuration, signing inputs, generated
bundle, or application identity changes:

1. record the old candidate as superseded without deleting its evidence;
2. freeze a new commit and evidence directory;
3. reset all affected statuses to `NOT RUN` / `BLOCKED`;
4. repeat every gate whose input or downstream artifact changed.

Publication itself is not fully reversible. A rollback can stop later releases
or restore code, but cannot recall public clones, archives, caches, leaked
credentials or redistributed material. Do not publish first and plan to clear a
gate later.
