# Open-source readiness

**Status: BLOCKED — not approved for public source release**

**Last reviewed: 2026-08-10**

Evidence anchors below name exact recorded runs. `bd91927` is now a historical
policy-bound diagnostic, not the current Runtime/i18n feature checkpoint. A
pre-rebind diagnostic has also been recorded for `2361f4a`; it remains a
fail-closed development observation and does not make that checkpoint a release
candidate.

This document is the release gate for publishing the OpenPipal source. Adding
community documents or setting `private: true` in `package.json` only reduces
accidental publication risk; neither action grants redistribution rights or
changes the source-closed terms in the current [README](../README.md).

## Current safeguards

- The README still states that the source is closed and pull requests are not
  accepted.
- The npm package is marked private to prevent accidental registry publication.
- Draft contribution and private vulnerability-reporting procedures exist.
- Existing risk-review artifacts and the working tree must be preserved until
  their review resumes.

These safeguards are preparation evidence, not release approval.

The separate [Runtime V2 and i18n development verification ledger](runtime-v2-i18n-dev-verification.md)
records current local regression and dev-UI evidence. It is intentionally not a
release-gate PASS and does not override any blocker below.

The [open-source provenance decision register](open-source-provenance.md)
tracks the highest-risk prompts, Runtime assets, Skills, branding, extension
files, QA screenshots, and bundled package inputs. It is a working engineering
register only: every `PENDING` or `EXCLUDED` row remains a release blocker.

## Preparation tools and current result

Four evidence-producing components now make the remaining work explicit:

- [`config/open-source-policy.json`](../config/open-source-policy.json) and
  [`scripts/verify-open-source-candidate.mjs`](../scripts/verify-open-source-candidate.mjs)
  classify an immutable Git commit. The verifier reads both the policy and all
  candidate facts from that commit, binds the policy blob separately, and
  invalidates stale review when any non-policy candidate content changes.
- [`third-party-inventory-inputs.json`](third-party-inventory-inputs.json) and
  [`scripts/generate-third-party-inventory.mjs`](../scripts/generate-third-party-inventory.mjs)
  produce deterministic lockfile, repository-input, optional app-bundle, ASAR,
  and native-architecture evidence. Their output explicitly says
  `evidenceOnly: true` and `redistributionClearance: false`.
- [`config/macos-release-policy.json`](../config/macos-release-policy.json) and
  [`scripts/verify-macos-release.mjs`](../scripts/verify-macos-release.mjs)
  bind candidate source, app/DMG artifacts, signatures, entitlements,
  notarization/stapling records, and dual-signed manual evidence. Their output
  remains evidence-only and explicitly sets `publicReleaseClearance: false`.
- [`electron-builder.release.yml`](../electron-builder.release.yml) and
  [`scripts/embed-macos-release-build-manifest.mjs`](../scripts/embed-macos-release-build-manifest.mjs)
  implement a release-only `afterPack` hook that writes an exact-candidate
  `Contents/Resources/openpipal-release-build.json` into each macOS app. The
  hook rejects a non-exact or dirty candidate and binds immutable Git source
  bytes and the package architecture. It has not yet been run to produce a
  real package.

The last policy-bound historical diagnostic was run against checkpoint
`bd91927` (`bd919271a0cdbc5a55e2bc6213f412b1d4d37913`). It exited 1 and
correctly returned **FAIL** with 322 unresolved gate errors while its candidate
content and path-set bindings matched. A newer pre-rebind diagnostic was run on
the `2361f4a` Runtime/i18n feature checkpoint. It also exited 1 and returned
**FAIL**, counting 1,011 candidate paths, 345 errors, and 22 unknown paths: 270
excluded-path findings, 42 blocked-replacement findings, four unresolved
candidate identity/approval findings, six pending rule reviews, 22 unknown-path
findings, and one stale candidate-content binding. The path set still matched,
but the content hash did not. This is the expected fail-closed result before a
new policy classification and immutable binding; no final policy rebind is
claimed here. The official F-00 ledger remains **BLOCKED** and all release gates
remain at **0 PASS**.

The current dependency inventory records 1,438 lockfile placements, 453
Runtime-closure placements, 846 dependency edges, and 10 configured
repository-input groups in the development checkout. Its output remains
`evidenceOnly: true` and `redistributionClearance: false`. Those figures are
local inventory evidence, not proof that a fixed candidate or packaged app has
been cleared.

The packaging boundary checkpoint `5c9d678`, initial gate `345b083`, inventory
checkpoint `d86e317`, binding repair `7ef2214`, evidence-manual integration
`9914411`, release-infrastructure classification `be6e5b0`, macOS entitlement
contract `28cd793`, and policy rebind `9188c13` are release-preparation
checkpoints after the feature baseline below. The entitlement checkpoint fixes
the missing signing inputs, malformed `extendInfo` shape, and English/Chinese
privacy-purpose resources at source level. No fresh Developer ID package was
built or exercised, so these checkpoints do not change any A–F status in the
release acceptance manual.

The later signing-manual checkpoints `0e0477a` and `b31d374`, evidence-verifier
checkpoint `67d9860`, and last immutable policy checkpoint recorded before the
build-manifest work, `18b4592`, add a fail-closed macOS verifier plus a
self-contained strict ASAR inventory reader. At `67d9860`, the focused bundle
passed 4 files and 75 tests. The non-loopback unit
set passed 156 files, with 1,215 tests passed and 1 skipped; the three
local-listen files passed separately as 3 files and 36 tests after one
machine-local listen authorization; no external network was used. Node and
Renderer TypeScript checks,
`npm run build`, and `git diff --check` passed, with only the existing Vite
warnings during build. These results validate an evidence-producing code
checkpoint, not an official gate or release candidate. The focused and broader
subsets were recorded separately; their counts must not be added, and the split
runs do not constitute candidate-specific A-11.

The macOS verifier is conditional on a protected release control plane that is
not implemented in this repository. A standalone caller can choose both the
trust-bundle path and its claimed expected hash, so a trusted external runner
must use a fresh checkout and fixed dependencies, run the exact approved
commands into an empty package-output directory, exclude untrusted same-UID
mutation for the full build/verification interval, independently pin immutable
verifier and inventory bytes, provide an absolute bundle path with an
independently allowlisted SHA-256, generate the report in that protected job,
and make the final release decision outside the candidate's report. Until that
exists, the standalone verifier cannot be treated as the official release gate,
and F-06 remains **BLOCKED**.

The later exact-candidate build-manifest checkpoint `8111750` implements the
release-only packaging hook and verifier-side manifest binding. `6138ac8` is a
test-only follow-up that raises the local timeout of four temporary-Git fixture
cases to 15 seconds; it changes neither product code nor assertions. The
documentation checkpoint `762ef76` records that boundary, and `bd91927` binds
the candidate policy used by the latest fail-closed diagnostic above. The
release-focused bundle passed 5 files and 87 tests. The final same-snapshot
non-loopback set passed 157 files, with 1,240 tests passed and 1 skipped; the
three local-listen files passed separately as 3 files and 36 tests. Node and
Renderer TypeScript, `npm run build`, and `git diff --check` passed, with only
the existing Vite warnings during build. These are development regression
results. The hook has not produced a real package; candidate identity,
approvals and a binding for any later documentation or product commit remain
pending. No A–F entry is promoted: the committed release ledger still has
**0 PASS** entries.

## Latest development and evidence checkpoints

`2361f4a` (`2361f4a3f1586db4fb44d05612691d4713e2b65e`) is the current recorded
Runtime/i18n feature checkpoint. It upgrades the Pi packages to 0.84.1 and uses
Pi's public `Agent` API for the `pi-core` path; the incomplete 0.84.1
`AgentHarness` scaffold is not the production path. The Presenter localization
and readiness work is committed in this checkpoint. The legacy Runtime remains
available as the rollback path.

On this development checkpoint, the complete unit split recorded 172 files,
1,353 tests passed, and 1 skipped. Node and Renderer TypeScript checks, targeted
ESLint, `npm run build`, and the built-chunk relative-reference scan all passed.
The chunk scan covered 50 JavaScript files and 169 relative Runtime references
with zero missing targets. These results are development regression evidence,
not candidate-specific A-11 evidence and not a release-gate PASS.

A bounded Computer Use pass exercised the isolated development app through the
same user-visible flows. On `pi-core`, the deterministic local fixture passed
both an ordinary conversation and a Design conversation. A real DeepSeek
ordinary conversation completed with streaming, tool use, and persistence, but
the UI-entered prompt was mangled, so no exact-response assertion is counted.
The real DeepSeek Design conversation completed with exactly one
`create_artifact` call and rendered the expected Workspace/SVG result. The
legacy rollback path separately passed local-fixture ordinary and Design
conversations. An English hot switch was checked across the core shell,
history, roles, chat, tool card, Workspace, Artifact, and settings surfaces;
dynamic user/model/Artifact content remained unchanged, and the preference was
then returned to **Follow system**, displaying Simplified Chinese on the current
system. These are bounded dev-UI observations from an unpackaged app, not a
clean frozen candidate, signed package, or official Runtime release matrix.

Release-specific evidence is still absent: no clean locked install, complete
repository-wide lint, candidate-bound Playwright/E2E run, dual-architecture
package, signing/notarization/stapling record, packaged-app data-isolation and
recovery run, or sealed F-04 risk/security review has been accepted. The
pre-rebind candidate verifier also remains **FAIL** as described above. Those
items remain **BLOCKED** or **NOT RUN** in the
[release acceptance manual](release-acceptance.md), whose committed ledger has
**0 PASS** entries.

## Blocking decisions and evidence

| Gate | Current state | Evidence required to close it |
|---|---|---|
| Root source license | Decided and landed: the repository carries the verbatim Apache-2.0 text with `Copyright 2026 yuanlang12`, and `package.json` declares `"license": "Apache-2.0"`. The README still describes binary-only, source-closed terms and contradicts it. | Reconcile the README with the selected license at the public-cut commit. The license governs first-party source only; it grants nothing for material listed as excluded or blocked-replacement in `config/open-source-policy.json`. |
| Design prompt redistribution | The repository contains prompt archives such as [`docs/claude/anthropic-design-agent-prompt.md`](claude/anthropic-design-agent-prompt.md) and [`docs/claude/claude-design-dc-prompt.md`](claude/claude-design-dc-prompt.md). Their inclusion is not evidence of redistribution permission. | Record provenance and governing terms for each file and derivative. Keep with required notices, replace, or remove each item based on documented permission. |
| DC Runtime redistribution | [`resources/dc-runtime/`](../resources/dc-runtime/) contains Runtime, backup, compiled, and vendored files, including `support.js` and vendored React builds. No release decision has cleared the directory as a whole. | Produce a file-level origin and license inventory; preserve required notices and source offers; replace or remove anything without verified redistribution rights. |
| Brand and product assets | App icons, tray icons, extension icons, avatar sprites, and [`resources/brand/`](../resources/brand/) may carry copyright or trademark restrictions distinct from the source license. | Confirm ownership and intended trademark policy for every shipped asset category. Mark reusable assets explicitly and exclude or replace the rest. |
| Other bundled third-party material | Dependencies, bundled Skills, fixtures, generated code, and vendored files need one reconciled notice inventory. The draft [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) covers direct npm dependencies and selected repository materials; [`resources/SKILLS-NOTICE.md`](../resources/SKILLS-NOTICE.md) is another input. A deterministic generator now records transitive lockfile, repository-input, ASAR, native-binary, and optional app-bundle evidence, but no fixed candidate report has been manually cleared. | Generate checkout and packaged-app reports for the exact candidate, review every record, and add all required license and notice files. Generated metadata alone is not clearance. |
| Security review | Unfrozen by the maintainer. A read-only pre-check ran and its two high-severity findings were remediated in `51a655a`: srcdoc frames carrying `allow-same-origin` made model-authored HTML same-origin with the host and so able to reach the preload bridge, and the CLI registry interpolated unvalidated input into `execSync`. Both were exploitable in the currently distributed binary, not only in a public source release. Two medium findings are open: `sandbox: false` on the main and Presenter windows, and a blacklist-regex path guard in `serveStatic`. The review is **not sealed**: no attack test, no candidate validation, and no conclusion against an immutable publication commit exists. | Complete the review against the exact publication commit, disposition the open medium findings, run attack tests, and seal the result. |
| Repository and history hygiene | A clean public-source candidate and Git-history review have not been approved. The fail-closed pre-rebind diagnostic at `2361f4a` reports exclusions, replacement blocks, pending candidate/rule approvals, a stale content binding, and 22 newly unknown paths. Ignored files alone do not prove that secrets or user data never entered history. | Classify the unknown paths, bind and rerun an exact immutable candidate, resolve every verifier error, then review that candidate and its history for credentials, `.env` content, user data, private prompts, QA artifacts, large binaries, and internal-only paths. Rebuild a clean candidate if history cannot be published safely. |
| Release verification | Development checks through `2361f4a` and the bounded `pi-core`/legacy, DeepSeek Design, and language-switch Computer Use observations do not establish a clean locked install, complete repository-wide lint, candidate-specific unit/Playwright coverage, packaged-app acceptance, signed dual-Runtime recovery, complete Design revision/export, or any official A–E PASS. | Close every required A–E gate in the [`release acceptance manual`](release-acceptance.md) on one exact candidate. Those gates include type checks, focused and full tests, clean-checkout packaging, rollback verification, user-view acceptance, data isolation, and recovery. |
| macOS signing identity and privacy permissions | The source has explicit Main/Helper entitlements, localized purpose strings, an evidence-only verifier, and an implemented release-only `Contents/Resources/openpipal-release-build.json` pipeline. However, the pipeline has not produced a real package; the protected external runner is absent; and `config/macos-release-policy.json` still has `PENDING` values for `candidateContentSha256`, `teamIdentifier`, `review.owner`, `review.approver`, `review.status`, and both signer records' `identity`, `keyId`, and `publicKeySpkiBase64`. No real Developer ID package, notarization/staple, dual-signed manual evidence, or signed-package TCC/user-view run exists. | Establish the protected external control plane with a fresh checkout, fixed dependencies, exact commands, empty output, same-UID mutation isolation, and independently pinned trust inputs; complete and approve the policy; run the embedded manifest pipeline for both architectures from one frozen candidate; inspect effective signatures/entitlements; run real TCC and Runtime/Design flows; notarize/staple; and retain externally accepted evidence. |
| Public project policy | Contribution status, supported versions, release signing, disclosure handling, CI, and maintainer responsibilities are not finalized. GitHub private vulnerability reporting has not been verified from a reporter's account. | Approve the policies, make README and community files consistent, enable and test private vulnerability reporting, identify a responsible maintainer, and document who can authorize and publish a release. |

## Required publication record

Before changing repository visibility or publishing a source archive, record:

1. The immutable candidate commit and a recoverable internal checkpoint.
2. The approved root license and third-party inventory, including every keep,
   replace, and remove decision.
3. The sealed security-review result for that same commit.
4. Automated check results and isolated packaged-app acceptance evidence.
5. The final file manifest and confirmation that no user data, credentials,
   `.env`, `dist-qa/`, or internal-only artifacts are present.
6. Explicit maintainer approval to publish.

## Publication and rollback boundary

Prepare and validate a candidate while the repository remains private. Publish
only the approved immutable commit; do not publish a moving development branch.
Keep the internal checkpoint and build evidence so code changes can be reverted.

Repository visibility is not fully reversible: public clones, archives, and
caches may survive after a repository is made private again. A rollback plan can
stop later releases and restore code, but it cannot guarantee recall of already
published source or secrets. This is why license, provenance, history, and
security gates must close before the first publication.

## Explicitly out of scope for this preparation step

- choosing or adding a source license;
- concluding that any third-party material is redistributable;
- resuming the frozen security review or performing attack tests;
- changing the README's current source-closed terms;
- changing repository visibility or publishing a release.
