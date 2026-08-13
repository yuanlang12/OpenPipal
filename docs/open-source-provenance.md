# Open-source provenance decision register

**Status: BLOCKED — offline working register, not redistribution clearance**

**Inventory date:** 2026-08-09; Pi dependency rows refreshed 2026-08-10

**Local baseline observed before authoring:** `b492fb717c2a74a7e48417ea5f6cc80303b9ad52`.
The Pi dependency refresh was checked against Runtime checkpoint `2361f4a`.

**Public candidate commit:** **PENDING — no candidate exists**

**Closure owner / final approver:** **PENDING — unassigned for every open row**

This register turns the repository's highest-risk provenance questions into
explicit keep, replace, or remove decisions. It is based only on files, Git
history, installed-package metadata, and build configuration available in the
local checkout. No upstream site or release artifact was inspected.

This is an engineering release-control record, not legal advice or a legal
conclusion. A local license file or package metadata is evidence to review; it
does not by itself establish that OpenPipal may publish a particular derivative,
asset, prompt, generated file, or complete distribution.

## How to read the register

- **Shipped?** describes the current build configuration, not a re-inspected
  signed release. `CONFIG: YES` means the file is imported into a bundle or
  selected by `electron-builder.yml`; the final packaged candidate still needs
  a file-manifest check.
- **Source release?** describes what would happen if the current tracked tree
  were published without a clean export manifest. `TRACKED: YES` means Git would
  expose the material even when the desktop packager excludes it.
- **PENDING** means the local evidence is incomplete. It is not an approval.
- **EXCLUDED** means the item must stay out of the public candidate until the
  named evidence is supplied and reviewed.
- **KEEP (conditional)** means the preferred product decision is to retain the
  item only after the notice/status condition closes. If it does not close,
  the fallback is exclusion or replacement.
- The exact **Path / glob** value is the row identifier. Evidence paths are
  named in the row; the final owner, approver, candidate commit, and verification
  result must be written into the row before its status can change.

The root project still has no selected source license, and the current README
still describes a source-closed distribution. Nothing in this register
overrides the blockers in [Open-source readiness](open-source-readiness.md).
Package metadata and bundled-Skill evidence are cross-checked against the draft
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and
[`resources/SKILLS-NOTICE.md`](../resources/SKILLS-NOTICE.md); those notices are
inputs to this decision register, not release approval.

## Decision summary

The lowest-risk first public candidate should:

1. **Remove** the two archived Design prompts, DC Runtime backups, legacy Skills,
   the 229 tracked QA screenshots, and exploratory brand files from the public
   export.
2. **Replace or independently rewrite** the shipped Design prompt derivative,
   copied/captured Design Runtime material, translated "official" Design Skills,
   extension icons, and avatar sprites unless exact origins and redistribution
   terms are recorded.
3. **Keep conditionally** the Pi packages, React runtime, five OpenAI Skill
   snapshots, and first-party Skill, agent-profile, and standalone-extension
   source candidates only after exact revisions, ownership, modification
   records, required license texts/notices, and final packaged contents are
   verified.
4. Publish from an explicit allowlist/export manifest, not by changing the
   visibility of the current development history.

## Prompts and DC Runtime

| Path / glob | Local evidence / source | Upstream revision | Modifications | License / terms evidence | Shipped? | Source release? | Decision | Notice / status |
|---|---|---|---|---|---|---|---|---|
| `docs/claude/anthropic-design-agent-prompt.md` | 425-line prompt archive; introduced by local commit `3b80b49`; current SHA-256 `39c0e3ac…b1280d78`; content names Claude/Anthropic capabilities but contains no source record | **PENDING** — no URL, retrieval record, version, or commit | Git shows later OpenPipal edits (`+11/-8`) for local precompiled React, no-network preview, and tool wording | **PENDING** — no governing terms or permission record in the file | NO — `docs/**` is excluded by `electron-builder.yml` | **TRACKED: YES** | **REMOVE** from public candidate; keep only in a private provenance archive | **EXCLUDED** until source, exact revision, applicable terms, and permission for the modified copy are recorded |
| `docs/claude/claude-design-dc-prompt.md` | 9,199-line prompt capture; added by local commit `0442c6d`, whose message says it was used to match official Claude Design | **PENDING** — no exact upstream identifier | Local file is a capture adapted to OpenPipal's DC workflow; the complete modification boundary is not recorded | **PENDING** — no local license or terms record | NO — `docs/**` is excluded by the packager | **TRACKED: YES** | **REMOVE** from public candidate | **EXCLUDED**; do not substitute a Git commit message for upstream permission |
| `src/main/role-manager.ts` — Design `systemPrompt` block | Introduced with the first prompt archive in `3b80b49`; structure and distinctive instructions overlap the archived Design prompt while adding OpenPipal-specific tools, DC workflow, and product rules | **PENDING** — derivative baseline is not tied to an immutable upstream revision | Extensively translated, reorganized, and expanded across many local commits; no clean-room authorship record or complete upstream-to-current diff | **PENDING** — no source terms or permission record for retained upstream expression | **CONFIG: YES** — built-in Design Agent prompt | **TRACKED: YES** | **REPLACE** with an independently authored OpenPipal prompt | **BLOCKED — REPLACE**; the prompt is inline product code and cannot be made safe merely by excluding an export path |
| `resources/dc-runtime/support.js`; `resources/dc-runtime/backup-pre-w1/support.js` | Both declare `GENERATED from dc-runtime/src/*.ts`; the referenced `dc-runtime/` source directory is absent from this checkout; added in `0442c6d` | **PENDING** | Generated output; rebuild source and exact generator inputs are unavailable locally | **PENDING** — no source license or generated-file notice | Primary file: **CONFIG: YES**; backup: NO by `!backup-pre-w1/**` | **TRACKED: YES** | **REPLACE** with a locally owned implementation whose source and reproducible build are included; remove backup | **EXCLUDED** while corresponding source and terms are absent |
| `resources/dc-runtime/{animations.jsx,deck-stage.js,doc-page.js,ios-frame.jsx,android-frame.jsx,image-slot.js}` | Local commits `0442c6d`, `985ba16`, and `0b000e2` describe byte matching, "official original file" imports, and files harvested from official generated artifacts | **PENDING** — no exact upstream commit, artifact ID, URL, or immutable source bundle | `doc-page.js` was replaced/expanded locally; other files have OpenPipal integration and registration changes; a complete upstream-to-local diff is absent | **PENDING** — no governing license/terms evidence in this directory | **CONFIG: YES** via `extraResources`; several are also consumed by renderer/runtime code | **TRACKED: YES** | **REPLACE** with independently owned/runtime-cleared implementations | **EXCLUDED**; each retained replacement needs origin, revision, diff, license/terms, and notice placement |
| `resources/dc-runtime/three-d-stage.js` | Added by local commit `3829ca2` as a OpenPipal Design feature; no separate source declaration in the file | **PENDING** | Local implementation history exists; external inputs and ownership declaration are not recorded | **PENDING** — root project license and ownership attestation absent | **CONFIG: YES** | **TRACKED: YES** | **KEEP (conditional)** | **PENDING** — record author/inputs and cover it under the approved root license; the row remains blocked until then |
| `resources/dc-runtime/{animations,ios-frame,android-frame}.compiled.js` | Local compiled sidecars paired with JSX files; Git history describes esbuild precompilation | Same as each source JSX: **PENDING** | Generated derivatives; exact reproducible command/tool version is not recorded beside every output | Inherits unresolved source status; no generated-file manifest | **CONFIG: YES** | **TRACKED: YES** | **REMOVE** from the source export and regenerate from cleared source during the build | **EXCLUDED** until the replacement source and reproducible build are present |
| `resources/dc-runtime/backup-pre-w1/**` | Three historical generated/source snapshots, exactly 98,683 Git-blob bytes (96.37 KiB); packager explicitly excludes the directory | **PENDING** | Historical backup state; not a maintained source of truth | **PENDING** | NO | **TRACKED: YES** | **REMOVE** from public candidate | **EXCLUDED**; preserve privately if needed for rollback |
| `resources/dc-runtime/vendor/react.production.min.js`; `react-dom.production.min.js` | Byte-identical to installed React 18.3.1 UMD production files; SHA-256 `d949f1c3…d4c4dd` and `35f4f974…f66f0d`; local `node_modules/react*/LICENSE` contains MIT text | npm artifact `18.3.1`; exact upstream Git commit **PENDING** | No local byte modifications detected against the installed UMD files | MIT text is present in installed packages, but not beside the vendored files or proven present in the final app | **CONFIG: YES** | **TRACKED: YES** | **KEEP (conditional)**, sourcing the bytes from the locked package during a reproducible build | **PENDING** — add required copyright/license notice to the distribution and verify final bytes |

## Skills

The checkout contains 67 tracked files under `resources/skills/`, five under
`resources/skills-legacy/`, 14 under `resources/system-agents/`, and six
subagent profile prompts under `resources/subagents/`. The current packager
includes all current Skills, system-agent resources, and subagent profiles, but
not the legacy directory.

| Path / glob | Local evidence / source | Upstream revision | Modifications | License / terms evidence | Shipped? | Source release? | Decision | Notice / status |
|---|---|---|---|---|---|---|---|---|
| `resources/skills/{skill-creator,doc,slides,spreadsheet,pdf}/**` (46 files) | `resources/SKILLS-NOTICE.md` identifies snapshots from `openai/skills`, retrieved April 2026; each directory contains `LICENSE.txt` | **PENDING** — retrieval month is recorded, exact commit/tag is not | Notice says unmodified when retrieved, but no offline upstream tree/hash manifest exists to verify that statement now | Apache-2.0 text is present in each directory; applicability to the exact snapshot still needs revision/diff verification | **CONFIG: YES** | **TRACKED: YES** | **KEEP (conditional)** | **PENDING** — record immutable upstream revision and per-file diff; preserve license/attribution in source and app |
| `resources/skills/{animation-basics,dc-authoring,deck-stage,design-system-authoring,design-tokens,doc-design,flier,hi-fi-design,html-email,interactive-prototype,prototype-tweaks,three-d-object,trifold-brochure,web-research,wireframe}/**` | Git history and file text repeatedly say "official original translation", "official sample extraction", "official registry", or OpenPipal host adaptation | **PENDING** — no exact source/revision manifest | Translations, extraction from output samples, and OpenPipal-specific runtime/tool adaptations are substantial but not diffed against immutable originals | **PENDING** — no applicable upstream terms or permission record | **CONFIG: YES** | **TRACKED: YES** | **REPLACE** with independently authored OpenPipal instructions | **EXCLUDED** as a group until the replacements have file-level origin/terms records |
| `resources/skills/{curriculum-info-tech-primary,curriculum-physics-junior}/SKILL.md` | Added by `b27f321` as distilled curriculum-standard files; underlying documents are not identified in the Skill files | **PENDING** | Distillation/translation boundary is not recorded | **PENDING** — source documents and applicable terms absent | **CONFIG: YES** | **TRACKED: YES** | **REPLACE** with source-cited, permission-reviewed summaries | **EXCLUDED** until the curriculum sources and reuse basis are documented |
| `resources/skills/{frontend-design,tool-installer}/**` | Local Git creation history; no explicit external-source claim found in the files | **PENDING** | Maintained as OpenPipal-specific instructions | Root license and contributor/AI-assisted ownership record are **PENDING** | **CONFIG: YES** | **TRACKED: YES** | **KEEP (conditional)** | **PENDING** — maintainer ownership attestation plus approved root license |
| `resources/skills-legacy/**` (5 files) | Historical simplified Skills; Git shows they were replaced/backed up in `c729dac`; no per-file origin/terms record | **PENDING** | Obsolete local versions | **PENDING** | NO — not selected in `extraResources` | **TRACKED: YES** | **REMOVE** from public candidate | **EXCLUDED**; retain only in a private history/archive if needed |
| `resources/system-agents/{evolver,teacher}/skills/**` (4 Skill directories) | Local Git history exists for Evolver memory/Agent workflows and the Teacher personal-style workflow; no explicit external-source claim found | **PENDING** | OpenPipal-specific and modified over time; Teacher Skill includes local references/scripts | Root license and contributor/AI-assisted ownership record are **PENDING** | **CONFIG: YES** via `resources/system-agents` | **TRACKED: YES** | **KEEP (conditional)** | **PENDING** — document authorship/inputs and cover the exact files under the approved root license |
| `resources/system-agents/design/preflow.json` | Git commit `90c7e2c` says template labels/subtitles were aligned to and copied from an official registry; later commits translated and expanded the manifest | **PENDING** — no registry snapshot, revision, or terms record | Chinese localization, additional templates, and English locale overlay are OpenPipal modifications; no immutable source diff | **PENDING** | **CONFIG: YES** via `resources/system-agents` | **TRACKED: YES** | **REPLACE** with independently authored template names/descriptions | **EXCLUDED** until the replacement provenance is recorded |
| `resources/system-agents/{evolver/agent.md,learner/layout.json,teacher/preflow.json}` | Local Git history describes OpenPipal Evolver, study-layout, and Teacher onboarding behavior; no explicit external-source claim found | **PENDING** | OpenPipal-specific files modified across product iterations | Root license and contributor/AI-assisted ownership record are **PENDING** | **CONFIG: YES** via `resources/system-agents` | **TRACKED: YES** | **KEEP (conditional)** | **PENDING** — document authorship/inputs and cover exact files under the approved root license |
| `resources/subagents/*.md` (6 files) | Local Git history describes OpenPipal advisor, artifact reviewer, executor, explorer, researcher, and thinker profiles; no explicit upstream source or license record found | **PENDING** | OpenPipal-specific profile prompts evolved across product commits; exact authorship/inputs are not recorded | Root license and contributor/AI-assisted ownership record are **PENDING** | **CONFIG: YES** via `resources/subagents` | **TRACKED: YES** | **KEEP (conditional)** | **PENDING** — document authorship/inputs and include the exact six files in the approved source/license manifest |

## Brand, UI assets, extension assets, and QA screenshots

| Path / glob | Local evidence / source | Upstream revision | Modifications | License / terms evidence | Shipped? | Source release? | Decision | Notice / status |
|---|---|---|---|---|---|---|---|---|
| `resources/brand/**` (31 files) | Local brand exploration README and Git commit `3b80b49` describe 30+ AI-assisted logo candidates and a selected direction | **PENDING** | Exploratory drafts and showcase pages; most are not required by the product | No trademark policy, asset license, creator assignment, or approved final-asset manifest | NO evidence of app packaging/import | **TRACKED: YES** | **REMOVE** explorations from public candidate | **EXCLUDED** until ownership and trademark/reuse policy are approved; an approved production mark must enter through a separate allowlist |
| `src/renderer/src/components/shared/OpenPipalLogo.tsx` | File header says it ports official `assets/logo-mark.svg` / `logo-lockup.svg`; those source assets and their provenance record are absent; introduced by local commit `692012d` | **PENDING** | Reimplemented as a token-driven React SVG/wordmark rather than copying two theme assets | **PENDING** — no source terms, permission record, or approved trademark policy | **CONFIG: YES** — renderer component | **TRACKED: YES** | **REPLACE** with a documented first-party mark | **EXCLUDED** until replacement origin, ownership, and permitted use are recorded |
| `resources/icon.svg`; `resources/icon.icns`; `resources/tray/**` | SVG and generator history derive these outputs from the same "official mark" geometry; commits `6bee2f4` and `ee0d73b` record the local chain | **PENDING** — same unresolved base-mark origin as `OpenPipalLogo.tsx` | SVG was redrawn for the macOS grid; ICNS and tray PNGs are generated derivatives | No approved trademark policy, asset license, source terms, or ownership declaration | App icon and tray PNGs: **CONFIG: YES**; source SVG itself is not selected as an extra resource | **TRACKED: YES** | **REPLACE** with outputs from the approved first-party mark | **EXCLUDED** until the canonical replacement source, owner, and trademark/reuse rules are recorded |
| `scripts/render-app-icon.cjs`; `scripts/render-tray-icon.cjs` | App-icon script reads `resources/icon.svg`; tray script embeds the unresolved "official mark" geometry directly | **PENDING** | Local generator logic; tray source itself contains the mark coordinates | No separate license or ownership declaration; embedded geometry inherits the unresolved mark status | NO — `scripts/**` is excluded by the desktop packager | **TRACKED: YES** | **REPLACE** embedded/source mark inputs while retaining only generic generator logic | **EXCLUDED** until both scripts consume a cleared canonical mark and reproducible outputs are recorded |
| `openpipal-extension/{background.js,content.js,inject.js,manifest.json,sidepanel.html,sidepanel.js,_locales/**}` (8 files) | Commit `52c6819` says the extension source was copied from a formerly separate sibling project and distributed separately; that earlier repository/revision is not present locally | **PENDING** | Substantial OpenPipal changes followed the copy, including browser control, local authentication, and bilingual UI; no origin-to-current patch set is recorded | Root/extension source license and prior-project ownership record are **PENDING** | Not in DMG; **SEPARATE EXTENSION: historically shipped**, current candidate artifact not inspected | **TRACKED: YES** | **KEEP (conditional)** | **PENDING** — record prior-project owner/revision, current modification history, approved license, and standalone package manifest |
| `openpipal-extension/icons/**` (3 PNGs) | Extension directory was copied from a formerly separate project in commit `52c6819`; no icon source file or creator record is present | **PENDING** | Only raster sizes are present; derivation chain unknown | **PENDING** | Not in DMG; historically part of a separately distributed extension, but current release artifact was not inspected | **TRACKED: YES** | **REPLACE** from the approved canonical mark | **EXCLUDED** until source and ownership are recorded |
| `src/renderer/src/assets/agent-avatars/**` (2 PNG sprite atlases) | Added in commit `68a9b16` with no source/creator/terms metadata; 768×384 day and night atlases | **PENDING** | Modification/generation history unknown | **PENDING** | **CONFIG: YES** — referenced by renderer CSS | **TRACKED: YES** | **REPLACE** with documented first-party assets | **EXCLUDED** from public and binary candidates until replacement provenance is recorded |
| `tests/artifacts/**/*.png` (229 tracked PNGs, exactly 13,267,815 Git-blob bytes / 12.65 MiB) | Exact tracked count and committed-blob size from `git ls-tree -rl HEAD`; no repository-level capture manifest records creator, fixture/data source, consent, sanitization, or per-image provenance | **PENDING** | Screenshots accumulated across many E2E/UI commits; content and redaction state were not reviewed in this offline provenance pass | No blanket redistribution record; screenshots may contain third-party UI, generated content, local paths, or user-derived material | NO — `tests/**` is excluded by `electron-builder.yml` | **TRACKED: YES** | **REMOVE** all 229 from the first public candidate | **EXCLUDED**; preserve current files unchanged in a private QA archive, then regenerate a minimal synthetic public set with a manifest if needed |

## Pi packages and React package inputs

| Path / glob | Local evidence / source | Upstream revision | Modifications | License / terms evidence | Shipped? | Source release? | Decision | Notice / status |
|---|---|---|---|---|---|---|---|---|
| `@earendil-works/pi-agent-core@0.84.1` | `package.json`, `package-lock.json`, and installed metadata point to `earendil-works/pi`, `packages/agent`; lockfile records npm tarball integrity | npm package `0.84.1`; exact upstream Git commit **PENDING** | OpenPipal does not vendor its source; the Runtime adapter now uses the package-root public `Agent` API and wraps it in `src/main/agent-runtime/**` | Installed package declares MIT; published package directory contains no local license text | **CONFIG: YES** — deliberately bundled by `electron.vite.config.ts` | Manifest/lock and OpenPipal adapters: **TRACKED: YES**; package source: NO | **KEEP (conditional)** | **PENDING** — map tarball to immutable upstream revision, obtain license text/notice, and verify packaged transitive contents |
| `@earendil-works/pi-ai@0.84.1` | Installed metadata points to `earendil-works/pi`, `packages/ai`; lockfile records npm tarball integrity | npm package `0.84.1`; exact upstream Git commit **PENDING** | OpenPipal provider/model adapters import public and compatibility APIs | Installed package declares MIT; published package directory contains no local license text | **CONFIG: YES** — bundled into main process output | Manifest/lock and adapters: **TRACKED: YES**; package source: NO | **KEEP (conditional)** | **PENDING** — same revision, license-text, notice, and transitive inventory gate |
| `@earendil-works/pi-coding-agent@0.84.1` | Installed metadata points to `earendil-works/pi`, `packages/coding-agent`; the legacy Runtime still imports package-internal tool/Skill files by relative `node_modules` paths | npm package `0.84.1`; exact upstream Git commit **PENDING** | OpenPipal adds tool/security bridges; package source itself is not modified locally, but legacy internal-path API reliance remains a local integration constraint | Installed package declares MIT but contains no local license text | **CONFIG: YES** — bundled into main process output | Manifest/lock and adapters: **TRACKED: YES**; package source: NO | **KEEP (conditional)** | **PENDING** — map tarball to immutable revision, include license/notice, inventory transitives, and migrate remaining legacy internal-path imports to supported public APIs |
| `node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/{photon_rs_bg.wasm,LICENSE.md,package.json}`; `electron-builder.yml` `extraFiles` | Installed nested package is `@silvia-odwyer/photon-node@0.3.4`; lockfile records npm integrity; WASM SHA-256 is `10468181…92a3615c`; nested path exists while the configured top-level candidate path is absent | npm package `0.3.4`; exact upstream Git/WASM source revision **PENDING** | No local WASM byte modification recorded; builder has two candidate source paths and copies the nested one observed locally | Apache-2.0 metadata and `LICENSE.md` are present in the installed nested package | **CONFIG: YES from nested path**; exact packaged output still **PENDING** inspection | `package-lock.json` and builder config: **TRACKED: YES**; installed WASM/license: NO | **KEEP (conditional)** | **PENDING** — map artifact to immutable source revision, ship Apache notice/license, remove or explain the absent top-level candidate, and verify output bytes |
| npm `react@18.3.1`; `react-dom@18.3.1` | Locked npm artifacts include integrity and MIT metadata; installed packages contain MIT license text | npm package `18.3.1`; exact upstream Git commit **PENDING** | Renderer uses npm packages; DC Runtime also carries separate byte-identical UMD copies | Local license text present in installed packages | **CONFIG: YES** — renderer bundle plus DC vendor copies | Manifests and vendored UMD files: **TRACKED: YES**; other package source: NO | **KEEP (conditional)** | **PENDING** — reconcile one notice path for renderer and DC copies and verify it ships in the exact candidate |

## Required evidence to close a row

For every retained `PENDING` item, add a record containing:

1. canonical upstream URL and immutable commit/tag or artifact digest;
2. retrieval date and the local file/tree hashes;
3. a complete upstream-to-local modification summary or reproducible patch;
4. the exact license/terms evidence reviewed and all required notices;
5. an ownership/assignment statement for first-party and AI-assisted material;
6. whether it appears in source, the desktop app, the standalone extension, or
   generated release artifacts;
7. the final **KEEP**, **REPLACE**, or **REMOVE** approval and approver.

At closure, replace the row's final status with
`Owner: …; Evidence: …; Candidate: <full SHA>; Check: …; Approver: …`.
Until those values exist, the global owner, approver, and public candidate remain
`PENDING`, and no row may be treated as release-cleared.

Do not mark a row complete from package metadata alone. Verify the clean public
source export and the unpacked packaged app against the same immutable candidate.

## Offline verification record

The following checks reproduce selected local facts in this register without
contacting an external service. They do **not** establish upstream provenance,
permission, or the contents of a future packaged candidate.

```sh
# Baseline, prompt sizes, and recorded local hashes.
git rev-parse HEAD
wc -l docs/claude/anthropic-design-agent-prompt.md \
  docs/claude/claude-design-dc-prompt.md
shasum -a 256 docs/claude/anthropic-design-agent-prompt.md \
  resources/dc-runtime/vendor/react.production.min.js \
  resources/dc-runtime/vendor/react-dom.production.min.js

# Tracked root and subgroup counts: 67 / 5 / 14 / 6 / 46 / 31 / 11 / 3 / 2.
git ls-files resources/skills | wc -l
git ls-files resources/skills-legacy | wc -l
git ls-files resources/system-agents | wc -l
git ls-files resources/subagents | wc -l
git ls-files resources/skills/skill-creator resources/skills/doc \
  resources/skills/slides resources/skills/spreadsheet resources/skills/pdf | wc -l
git ls-files resources/brand | wc -l
git ls-files openpipal-extension | wc -l
git ls-files openpipal-extension/icons | wc -l
git ls-files src/renderer/src/assets/agent-avatars | wc -l

# Exactly 229 tracked QA PNGs and 13,267,815 committed bytes; ignored files do not enter the sum.
git ls-files tests/artifacts | rg -i '\.png$' | wc -l
git ls-tree -rl HEAD tests/artifacts | \
  awk '{bytes += $4; count += 1} END {printf "count=%d bytes=%d MiB=%.2f\n", count, bytes, bytes/1048576}'

# Three backup blobs total 98,683 bytes / 96.37 KiB.
git ls-tree -rl HEAD resources/dc-runtime/backup-pre-w1 | \
  awk '{bytes += $4; count += 1} END {printf "count=%d bytes=%d KiB=%.2f\n", count, bytes, bytes/1024}'

# Vendored React byte matches against the locked local install.
cmp resources/dc-runtime/vendor/react.production.min.js \
  node_modules/react/umd/react.production.min.js
cmp resources/dc-runtime/vendor/react-dom.production.min.js \
  node_modules/react-dom/umd/react-dom.production.min.js

# Locked Pi, React, and nested Photon versions, license metadata, and npm integrity.
node -e 'const p=require("./package-lock.json").packages; for (const k of ["node_modules/@earendil-works/pi-agent-core","node_modules/@earendil-works/pi-ai","node_modules/@earendil-works/pi-coding-agent","node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node","node_modules/react","node_modules/react-dom"]) console.log(k,p[k]?.version,p[k]?.license,p[k]?.integrity)'
test -f node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/LICENSE.md
test -f node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm
test ! -e node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm
shasum -a 256 node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm

# Build-config evidence for selected/excluded resources and bundled Pi imports.
rg -n 'tests|docs|openpipal-extension|dc-runtime|resources/skills|resources/system-agents|resources/subagents|resources/tray|photon_rs_bg' electron-builder.yml
rg -n '@earendil-works/pi-(agent-core|ai|coding-agent)' electron.vite.config.ts src/main
rg -n 'dc-runtime|agent-avatars|OpenPipalLogo' src/renderer/src

# Brand derivation and standalone-extension evidence.
rg -n 'official|官方|logo-mark|logo-lockup' \
  src/renderer/src/components/shared/OpenPipalLogo.tsx resources/icon.svg \
  scripts/render-app-icon.cjs scripts/render-tray-icon.cjs
git show -s --format=fuller 52c6819cdd75ffb0154ed455ebd36578bcb50491

# Local origins and modification history.
git log --follow --format='%H %cs %s' -- <path>
git diff --numstat <introduction-commit> -- <path>

# Exact local file identity or tracked-path existence for any other row.
shasum -a 256 <path>
git ls-files --error-unmatch <tracked-path>
```

Path existence and Git tracking were checked for every path/glob named above;
the brace expressions in the table were expanded to their listed directories.
The working tree was intentionally left intact; no asset, screenshot, prompt,
Skill, dependency, or frozen review artifact was removed or rewritten.
