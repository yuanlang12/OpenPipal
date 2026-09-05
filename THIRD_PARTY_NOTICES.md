# Third-Party Notices (Draft)

> **DRAFT — NOT A REDISTRIBUTION CLEARANCE.** This inventory was assembled from
> `package.json`, the packages installed in the local `node_modules/` tree, and files
> committed to this repository. No upstream site was consulted. A package's license
> metadata is evidence about that package; it is not a license for OpenPipal or proof
> that every file in a future distribution has been cleared.

OpenPipal does not yet have a root project license. This document must not be read as
granting permission to copy, modify, or redistribute OpenPipal. See
[`docs/open-source-readiness.md`](docs/open-source-readiness.md) for the remaining
publication gates.

A deterministic evidence generator is available through
[`docs/third-party-inventory-inputs.json`](docs/third-party-inventory-inputs.json)
and [`scripts/generate-third-party-inventory.mjs`](scripts/generate-third-party-inventory.mjs).
Its JSON or Markdown output is an input to manual review, not this notice file,
not a legal conclusion, and not redistribution clearance. Store generated
reports in the private release-evidence directory; do not overwrite this
human-reviewed draft with generated output.

## Evidence labels

- **LOCALLY DOCUMENTED** — the installed package contains both license metadata and a
  local license or notice file. Its inclusion and notice placement still need to be
  checked against the final packaged artifact.
- **LICENSE TEXT PRESENT — PROVENANCE PENDING** — copied or bundled repository
  material carries a local license text, but its exact upstream revision and recorded
  modification state have not yet been independently verified.
- **METADATA ONLY — PENDING** — the installed package declares a license in
  `package.json`, but the installed package does not contain the corresponding license
  text.
- **PENDING** — the local evidence is incomplete or points to terms that are not
  available in this offline snapshot.
- **EXCLUDED FROM CLEARANCE** — do not treat the material as approved for a public
  source release or redistribution until provenance and permission are resolved.

Installed versions below describe the local dependency tree last refreshed on
2026-08-10. The three Pi rows were rechecked after the Runtime migration; the
remaining direct-dependency rows retain the earlier local evidence review.
“Source” is normalized from installed package metadata and was not independently
verified.

## Direct runtime dependencies

| Package | Requested / installed | Declared license | Source in package metadata | Local evidence and status |
|---|---|---|---|---|
| `@anthropic-ai/sandbox-runtime` | `^0.0.44` / `0.0.44` | Apache-2.0 | `anthropic-experimental/sandbox-runtime` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `@modelcontextprotocol/sdk` | `^1.27.1` / `1.27.1` | MIT | `modelcontextprotocol/typescript-sdk` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `dotenv` | `^16.4.5` / `16.6.1` | BSD-2-Clause | `motdotla/dotenv` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `esbuild` | `^0.21.5` / `0.21.5` | MIT | `evanw/esbuild` | `package.json`, `LICENSE.md` — **LOCALLY DOCUMENTED** |
| `i18next` | `26.3.6` / `26.3.6` | MIT | `i18next/i18next` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `ignore` | `7.0.5` / `7.0.5` | MIT | `kaelzhang/node-ignore` | `package.json`, `LICENSE-MIT` — **LOCALLY DOCUMENTED** |
| `mammoth` | `^1.12.0` / `1.12.0` | BSD-2-Clause | `mwilliamson/mammoth.js` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `pdf-parse` | `^2.4.5` / `2.4.5` | Apache-2.0 | `mehmet-kozan/pdf-parse` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `perfect-freehand` | `^1.2.3` / `1.2.3` | MIT | `steveruizok/perfect-freehand` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `protobufjs` | `^8.6.0` / `8.6.0` | BSD-3-Clause | `protobufjs/protobuf.js` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `quickjs-emscripten` | `^0.32.0` / `0.32.0` | MIT | `justjake/quickjs-emscripten` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `react-i18next` | `17.0.11` / `17.0.11` | MIT | `i18next/react-i18next` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `sharp` | `^0.35.4` / `0.35.4` | Apache-2.0 | `lovell/sharp` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `typescript` | `^5.7.2` / `5.9.3` | Apache-2.0 | `microsoft/TypeScript` | `package.json`, `LICENSE.txt` — **LOCALLY DOCUMENTED** |
| `ws` | `^8.20.0` / `8.20.0` | MIT | `websockets/ws` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `yaml` | `2.9.0` / `2.9.0` | ISC | `eemeli/yaml` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |

## Direct development dependencies

Development-only placement does not establish that a package is absent from generated
or packaged output. That must be checked against the release artifact.

| Package | Requested / installed | Declared license | Source in package metadata | Local evidence and status |
|---|---|---|---|---|
| `@earendil-works/pi-agent-core` | `0.84.1` / `0.84.1` | MIT | `earendil-works/pi`, `packages/agent` | `package.json`; no local license text — **METADATA ONLY — PENDING** |
| `@earendil-works/pi-ai` | `0.84.1` / `0.84.1` | MIT | `earendil-works/pi`, `packages/ai` | `package.json`; no local license text — **METADATA ONLY — PENDING** |
| `@earendil-works/pi-coding-agent` | `0.84.1` / `0.84.1` | MIT | `earendil-works/pi`, `packages/coding-agent` | `package.json`; no local license text — **METADATA ONLY — PENDING** |
| `@electron-toolkit/preload` | `^3.0.1` / `3.0.2` | MIT | `alex8088/electron-toolkit`, `packages/preload` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `@electron-toolkit/utils` | `^3.0.0` / `3.0.0` | MIT | `alex8088/electron-toolkit`, `packages/utils` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `@eslint/js` | `^10.0.1` / `10.0.1` | MIT | `eslint/eslint`, `packages/js` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `@playwright/test` | `^1.58.2` / `1.58.2` | Apache-2.0 | `microsoft/playwright` | `package.json`, `LICENSE`, `NOTICE` — **LOCALLY DOCUMENTED** |
| `@types/node` | `^22.10.0` / `22.19.15` | MIT | `DefinitelyTyped/DefinitelyTyped`, `types/node` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `@types/react` | `^18.3.12` / `18.3.28` | MIT | `DefinitelyTyped/DefinitelyTyped`, `types/react` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `@types/react-dom` | `^18.3.1` / `18.3.7` | MIT | `DefinitelyTyped/DefinitelyTyped`, `types/react-dom` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `@types/ws` | `^8.18.1` / `8.18.1` | MIT | `DefinitelyTyped/DefinitelyTyped`, `types/ws` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `@vitejs/plugin-react` | `^4.3.4` / `4.7.0` | MIT | `vitejs/vite-plugin-react`, `packages/plugin-react` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `autoprefixer` | `^10.4.20` / `10.4.27` | MIT | `postcss/autoprefixer` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `diff` | `^8.0.4` / `8.0.4` | BSD-3-Clause | `kpdecker/jsdiff` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `electron` | `43.3.0` / `43.3.0` | MIT | `electron/electron` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `electron-builder` | `26.15.7` / `26.15.7` | MIT | `electron-userland/electron-builder`, `packages/electron-builder` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `electron-vite` | `^2.3.0` / `2.3.0` | MIT | `alex8088/electron-vite` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `eslint` | `^10.2.0` / `10.2.0` | MIT | `eslint/eslint` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `eslint-plugin-react` | `^7.37.5` / `7.37.5` | MIT | `jsx-eslint/eslint-plugin-react` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `eslint-plugin-react-hooks` | `^7.0.1` / `7.0.1` | MIT | `facebook/react`, `packages/eslint-plugin-react-hooks` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `globals` | `^17.5.0` / `17.5.0` | MIT | `sindresorhus/globals` | `package.json`, `license` — **LOCALLY DOCUMENTED** |
| `lucide-react` | `^1.6.0` / `1.6.0` | ISC | `lucide-icons/lucide`, `packages/lucide-react` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `marked` | `^17.0.4` / `17.0.4` | MIT | `markedjs/marked` | `package.json`, `LICENSE.md` — **LOCALLY DOCUMENTED** |
| `mermaid` | `^11.13.0` / `11.13.0` | MIT | `mermaid-js/mermaid` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `postcss` | `^8.4.49` / `8.5.15` | MIT | `postcss/postcss` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `react` | `^18.3.1` / `18.3.1` | MIT | `facebook/react`, `packages/react` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `react-dom` | `^18.3.1` / `18.3.1` | MIT | `facebook/react`, `packages/react-dom` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `react-markdown` | `^9.0.1` / `9.1.0` | MIT | `remarkjs/react-markdown` | `package.json`, `license` — **LOCALLY DOCUMENTED** |
| `rehype-katex` | `^7.0.1` / `7.0.1` | MIT | `remarkjs/remark-math`, `packages/rehype-katex` | `package.json`; no local license text — **METADATA ONLY — PENDING** |
| `remark-gfm` | `^4.0.0` / `4.0.1` | MIT | `remarkjs/remark-gfm` | `package.json`, `license` — **LOCALLY DOCUMENTED** |
| `remark-math` | `^6.0.0` / `6.0.0` | MIT | `remarkjs/remark-math`, `packages/remark-math` | `package.json`; no local license text — **METADATA ONLY — PENDING** |
| `tailwindcss` | `^3.4.15` / `3.4.19` | MIT | `tailwindlabs/tailwindcss` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `typescript-eslint` | `^8.58.2` / `8.58.2` | MIT | `typescript-eslint/typescript-eslint`, `packages/typescript-eslint` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
| `vite` | `^5.4.11` / `5.4.21` | MIT | `vitejs/vite`, `packages/vite` | `package.json`, `LICENSE.md` — **LOCALLY DOCUMENTED** |
| `vitest` | `^4.1.7` / `4.1.7` | MIT | `vitest-dev/vitest`, `packages/vitest` | `package.json`, `LICENSE.md` — **LOCALLY DOCUMENTED** |
| `zustand` | `^5.0.12` / `5.0.12` | MIT | `pmndrs/zustand` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |

## Bundled and vendored material

### Pi packages

The three direct `@earendil-works/pi-*` packages identify version `0.84.1`,
license `MIT`,
and paths in the `earendil-works/pi` repository in their installed metadata. Their
published package directories do not include a license text. They therefore remain
**METADATA ONLY — PENDING** until the exact source revision, license text, required
notices, and packaged OpenPipal usage are recorded locally.

### Internationalization packages

The installed `i18next` `26.3.6` and `react-i18next` `17.0.11` packages each contain
MIT metadata, an MIT license text, and repository metadata for the corresponding
`i18next` project. They are **LOCALLY DOCUMENTED**, subject to final artifact review.

### Vendored React files inside DC Runtime

The following files contain React license headers and are byte-for-byte identical to
the locally installed React 18.3.1 UMD production files at the hashes shown:

| Vendored file | Matching installed file | SHA-256 |
|---|---|---|
| `resources/dc-runtime/vendor/react.production.min.js` | `node_modules/react/umd/react.production.min.js` | `d949f1c3687aedadcedac85261865f29b17cd273997e7f6b2bfc53b2f9d4c4dd` |
| `resources/dc-runtime/vendor/react-dom.production.min.js` | `node_modules/react-dom/umd/react-dom.production.min.js` | `35f4f974f4b2bcd44da73963347f8952e341f83909e4498227d4e26b98f66f0d` |

The installed React packages contain MIT license texts, but the vendored directory
does not currently carry that text alongside the files. These two vendored files are
**PENDING** until the required license/notice placement is made part of the release:
the MIT licence requires its text to accompany the code, so the full licence must be
placed inside `vendor/` before release. Until 2026-08-16 this obligation was tracked as
a machine-checked exception in `config/open-source-policy.json`, which worked only as a
side effect of the broad exclusion row that has since been narrowed; it is recorded
here instead, and in the release checklist below.

This match does not clear any other part of the runtime beyond the two files named.

### OpenAI Skills snapshots

[`resources/SKILLS-NOTICE.md`](resources/SKILLS-NOTICE.md) records five specific
directories as snapshots from `openai/skills`: `skill-creator/`, `doc/`, `slides/`,
`spreadsheet/`, and `pdf/`. Each of those five directories contains an Apache License
2.0 `LICENSE.txt`. These snapshots are **LICENSE TEXT PRESENT — PROVENANCE PENDING**:
the repository records their source, but this review did not independently verify the
exact upstream revision or modification state. This is not evidence about any other
skill directory.

### Bundled fonts

The renderer bundles latin woff2 subsets of three font families, self-hosted under
`src/renderer/src/assets/fonts/`:

| Family | License | License file |
|---|---|---|
| Geist, Geist Mono | SIL Open Font License 1.1 | `src/renderer/src/assets/fonts/LICENSE-Geist.txt` |
| Instrument Serif | SIL Open Font License 1.1 | `src/renderer/src/assets/fonts/LICENSE-InstrumentSerif.txt` |

OFL-1.1 permits bundling and redistribution with software provided the license text
accompanies the fonts; the license files ship in the same directory as the font files.

## Pending or excluded repository material

The following material is outside this draft clearance. It must not be included in a
public source or binary release merely because some neighboring files have known
licenses.

| Material | Status | Required resolution |
|---|---|---|
| `docs/claude/anthropic-design-agent-prompt.md`; `docs/claude/claude-design-dc-prompt.md` | **EXCLUDED FROM CLEARANCE** | Establish origin, applicable terms, and redistribution permission; otherwise omit from the public release. |
| `resources/skills/*` other than the five directories named in `resources/SKILLS-NOTICE.md` and the sixteen design skills resolved below | **EXCLUDED FROM CLEARANCE** | Classify first-party versus third-party authorship and retain the applicable license/provenance record for every distributed skill. Narrowed on 2026-08-17: the sixteen design skills are resolved below. What remains under this row is the two curriculum skills (`curriculum-info-tech-primary`, `curriculum-physics-junior`), which belong to the teaching role and were never part of the design capability. |
| `resources/skills-legacy/**` | **EXCLUDED FROM CLEARANCE** | Resolve authorship, upstream source, modifications, and redistribution terms; otherwise omit. |
| `resources/system-agents/**/skills/**` | **EXCLUDED FROM CLEARANCE** | Resolve authorship and redistribution terms for agent-specific skills; otherwise omit. |

No license conclusion is made here for Anthropic prompt archives, DC Runtime, or custom
and legacy skills. The absence of a third-party notice is not evidence that an item is
first-party or cleared.

### Resolved 2026-08-14 — brand assets and artwork confirmed first-party

On 2026-08-14 the project owner confirmed full copyright ownership of, and approved
redistribution for, the following materials previously listed above as unresolved:

| Material | Resolution |
|---|---|
| `resources/icon.icns`, `resources/icon.svg`, `resources/tray/**`, `resources/brand/**` | First-party artwork; owner confirms copyright and approves redistribution. `resources/brand/**` still stays out of the release tree as process material by policy, independent of this clearance. |
| `openpipal-extension/icons/**` | First-party artwork; owner confirms copyright and approves redistribution. |
| `src/renderer/src/assets/agent-avatars/**` | First-party artwork; owner confirms copyright and approves redistribution. |

This resolution records the owner's own declaration; it is not a third-party license
finding and licenses nothing beyond the paths listed.

### Resolved 2026-08-16 — DC Runtime clean-room replacements

The row above covering `resources/dc-runtime/**` was written on 2026-08-14 at 10:08.
Five of the runtime files were replaced by clean-room implementations written in this
repository later the same day and the day before; the row was never revisited, so it
kept describing files that no longer existed. It is narrowed above to the three
components that are still original material, and the five below are recorded here as
first-party work.

Unlike the 2026-08-14 brand-asset resolution, this one does not rest on a declaration
alone. Each file was produced under the split-side procedure documented in
`docs/claude/design-rewrite/README.md`: one side read the original and wrote a
behaviour specification stating only what the host requires, and a second side that
never read the original implemented against that specification. Each replacement
therefore has a matching pair of commits — the original being removed first, the
independent implementation landing after — and each file opens with its own
authorship statement.

| File | Commits (original removed → clean-side landed) | Independent implementation |
|---|---|---|
| `resources/dc-runtime/doc-page.js` | `5d562db` | 356 lines, replacing a 757-line original |
| `resources/dc-runtime/support.js` | `5d562db` → `ae5ff90`, `1a6f5be`, `5fe4e74`, `f579e3c` | four stages, P1 skeleton 892 lines through P4; 52/52 end-to-end |
| `resources/dc-runtime/deck-stage.js` | `bd927fa` → `551f951` | 800 lines; 17 host contracts pass |
| `resources/dc-runtime/image-slot.js` | `bf57384` → `f7ff41f` | 547 lines; 18+1 host contracts pass |
| `resources/dc-runtime/animations.compiled.js` | `74858c3` → `2195707` | 1050 lines; 10 unit tests and 32 browser contracts pass |

The corresponding policy entry is `keep-self-written-design-runtime` in
`config/open-source-policy.json`. Content hashes are deliberately not pinned there:
these five files are still under active development, and a pin would decay into a
signature that is re-applied without being read. Substitution back to original material
is instead visible in the per-file authorship headers and in the commit pairs above.

This resolution covers only the five files listed. It makes no finding about
`three-d-stage` or any skill directory; the two device frames are resolved separately
below.

**Namespace migration, 2026-08-16.** The clean-room rewrites retained the original
host's protocol identifiers so that each replacement could be accepted against the
existing host without changing two things at once; the rewrite specifications recorded
this as a deferred, separately revertible commit. That commit has now been made. The
host API `window.omelette.writeFile` is `window.openpipal.writeFile`, the deck
presentation message key `__omelette_presenting` is `__openpipal_presenting`, and the
animation export protocol identifiers `data-om-exportable-video-with-duration-secs`,
`data-om-fonts-inlined`, `data-om-seek-to-time-frame` and `data-om-edl-changed` are
`data-openpipal-video-duration-secs`, `data-openpipal-fonts-ready`,
`openpipal:seek-to-time` and `openpipal:edl-changed`. Both sides of every identifier
were changed together — runtime, four host files, the browser contract harness and the
skill documentation. In the release tree produced by `scripts/make-open-source-cut.mjs`
the earlier namespace now occurs nowhere except in this record of the rename itself.
Two documentation files that are
excluded from release, `docs/claude/design-parity-goal.md` and
`docs/claude/dc-route-acceptance.md`, still name it when describing the original
host's video-export protocol; those are statements about the original and are accurate
as written.

### Resolved 2026-08-17 — device frames

`ios-frame` and `android-frame` were replaced by first-party implementations. They were
produced under the same split-side procedure as the five files above and against a
single written specification, `docs/claude/design-rewrite/device-frames-spec.md`, which
states only what each frame must present and what the host pipeline requires. The
specification deliberately contains no geometry, colour values, SVG paths or shadow
recipes: every such value in the resulting files was chosen by its implementer.

Two implementers worked independently, one per frame. Each was given an explicit
prohibition list — both original frame files, both of their compiled siblings,
`resources/dc-runtime/three-d-stage.js`, and `docs/claude/claude-design-dc-prompt.md`
(which embeds complete third-party source) — and was instructed to stop and report if
any line of them was seen. Both reported no contact, and neither original file showed
any modification in version control while they worked.

The two frames do not rest on the same basis, and the distinction is recorded here
deliberately.

**`android-frame`** was built from the publicly documented Material 3 design system.
No Material Design code or asset was copied. What was used is the system's documented
colour-role vocabulary (`surface`, `onSurface`, `surfaceVariant`, `secondaryContainer`,
`primary`, `outline`, and so on), its light/dark role-to-tone mapping, and its published
component dimensions. The palette values themselves were computed rather than taken:
the implementer wrote a generator that treats the Material tone number as CIE L\*,
applies a chroma envelope around a single self-chosen source hue (a teal at Lab 195°,
not the Material baseline hue), and reduces chroma until each colour falls inside sRGB.
Attribution to Material 3 is recorded in the file header and here as a matter of
practice; it is not offered as a licence grant, because no licensed expression was
taken.

**`ios-frame`** is an independent implementation of a generic modern smartphone
interface. No Apple design resource, UI kit, or exported asset was consulted. The
specification describes the affordances a viewer must be able to recognise — a rounded
bezel-less body, a black pill near the top edge, a status bar carrying a time and
signal, wireless and battery indicators, an optional large-title navigation area, an
optional on-screen keyboard, and a home indicator — and every dimension, path and colour
implementing them was authored for this repository. The default frame size of 402 × 874
is a device logical resolution, a fact rather than an expression, and is already
recorded in this repository's own authoring skills.

The predecessor row for `ios-frame` stated that Apple Design Resources terms prohibit
embedding and derivatives. That statement is about **using Apple's supplied material**,
and it remains true; it is not a finding that no phone frame may be drawn. The owner of
this repository was informed of the distinction, and of the residual risk that a
sufficiently close visual resemblance can be contested independently of how the file was
produced, and directed that a first-party replica be built. That direction is recorded
as the basis for this resolution.

Two things present in the originals were deliberately not carried over: the
third-party tooling header each file began with, and an inert presence probe in a
third-party attribute namespace that no code in this repository ever read. The
replacements carry a `data-openpipal-frame` root attribute instead, which the
end-to-end tests assert.

| File | Independent implementation |
|---|---|
| `resources/dc-runtime/ios-frame.jsx` | 663 lines; seven exported components |
| `resources/dc-runtime/android-frame.jsx` | 515 lines; six exported components |
| `resources/dc-runtime/ios-frame.compiled.js`, `resources/dc-runtime/android-frame.compiled.js` | generated from the two files above by `scripts/build-dc-runtime-compiled.mjs`; byte-identical on repeated runs, so the relationship is verifiable by anyone rather than asserted |

Verification at the time of this entry: 1685 unit tests, both TypeScript projects, and
17 of 17 `dc-render` end-to-end tests pass, including the two that render each frame
through the real preview pipeline. The corresponding policy entries are
`keep-self-written-design-runtime` (which now also covers these four files) and
`review-self-written-device-frames-delta` (the build script).

This resolution covers only the two device frames. `three-d-stage` remains original
material, and no finding is made about any skill directory.

### Resolved 2026-08-17 — three-d-stage, and the end of the DC Runtime row

`resources/dc-runtime/three-d-stage.js` was the last original third-party file in the DC
Runtime. It has been replaced by a first-party implementation, and the runtime row above is
therefore gone rather than narrowed: every file under `resources/dc-runtime/` is now either
first-party or a vendored dependency recorded elsewhere in this document.

This replacement differs from the seven before it in one respect that is recorded here
deliberately: **three.js itself is kept.** It is MIT, and it is not vendored — the page loads
it from a CDN through an import map pinned to one version with Subresource Integrity hashes.
Referencing an open-source library under its own licence raises no attribution question. What
was replaced is only the shell around it: the custom element that turns an author-supplied
`THREE.Object3D` into a lit, framed, orbitable, downloadable stage.

The work followed the same split-side procedure as the earlier replacements, against
`docs/claude/design-rewrite/three-d-stage-spec.md`. The implementer was given an explicit
prohibition list — the original file and `docs/claude/claude-design-dc-prompt.md` — reported no
contact, and the original showed no modification in version control while they worked. The
lighting rig, framing algorithm, shadow approach and toolbar are all their own; the
specification deliberately contained no values. For the export formats and the r184 shadow API
they read three.js's own MIT sources, which is the source the specification pointed at.

| File | Independent implementation |
|---|---|
| `resources/dc-runtime/three-d-stage.js` | 816 lines, replacing a third-party original |

Two things were deliberately not carried over: the third-party tooling header, and an export
notification message in a third-party namespace that no code in this repository consumed. With
that message gone, the earlier codename appears nowhere in this repository's code or resources —
only in this document's record of the rename.

The corresponding policy entry is `keep-self-written-design-runtime`, which now covers this file
too; `replace-design-runtime-material` retains only paths that were deleted from the tree but
exist in the reviewed baseline.

### Resolved 2026-08-17 — the sixteen design skills

The row above covering `resources/skills/*` was written on 2026-08-14, when every design skill
was third-party material. The owner confirmed that all fifteen derived skills came from the same
original. They have now been rewritten, and the row is narrowed to the two curriculum skills,
which belong to the teaching role and were never part of the design capability.

The rewrite did not edit the originals into new wording. It changed the source of truth:

> The only source for a skill is this repository's own runtime code and the host code that
> consumes it. Neither the original nor the previous wording is consulted.

That single rule resolves two problems at once. Authorship: a description of our own code is our
own work. Coverage: the earlier skills described the capabilities of the original's host at some
point in time, so everything this runtime grew afterwards was invisible to them — an audit found
134 such gaps, of which 98 were capabilities no skill mentioned at all. Writing from the code
closes both. The procedure is recorded in
`docs/claude/design-rewrite/skill-rewrite-contract.md`; its hard rules require every technical
assertion to be traceable to a line of code, forbid teaching anything absent from the runtime,
and require two sections that no earlier skill had — what the runtime already does for the
author, and which constraints fail silently.

| Skill | Before | After |
|---|---|---|
| `dc-authoring` | 145 | 470 |
| `animation-basics` | 321 | 578 |
| `design-system-authoring` | 152 | 386 |
| `interactive-prototype` | 31 | 361 |
| `design-tokens` | 113 | 325 |
| `doc-design` | 198 | 308 |
| `deck-stage` | 62 | 268 |
| `three-d-object` | 69 | 268 |
| `html-email` | 30 | 221 |
| `hi-fi-design` | 49 | 212 |
| `flier` | 71 | 189 |
| `trifold-brochure` | 40 | 172 |
| `wireframe` | 14 | 146 |
| `web-research` | 28 | 132 |
| **Total** | **1323** | **4036** |

`resources/skills/frontend-design/` is not in that table. It is the owner's own work and was
never derived; it needed no rewrite.

Two files were deleted rather than rewritten. `resources/skills/prototype-tweaks/` taught a
pattern this host rejects outright — its template is full-page HTML, which `create_artifact`
refuses; its styling approach contradicts the foundation skill's rules; and its persistence call
throws in the preview's sandbox. `resources/skills/deck-stage/starter.html` was a copy of the
original's hand-rolled slide engine, which the skill itself had already declared obsolete and
whose output cannot pass the PPTX classifier. Both removals were propagated to their four
registration points.

Verification at the time of this entry: 1693 unit tests, both TypeScript projects, 112 browser
contracts and the end-to-end suite pass. Beyond the automated checks, six runs against the real
application and real models produced deliverables that were inspected by hand — a slide deck, a
printable A4 document, two animations with exported video, and a phone prototype. The
capabilities these rewrites newly documented were used without being asked for.

No finding is made here about `resources/skills-legacy/**`, the two curriculum skills, or the
prompt archives; those rows stand.

## Before any public release

1. Select and add a root OpenPipal license only after the ownership and product decision
   is made; this draft does not select one.
2. Resolve every **METADATA ONLY — PENDING**, **PENDING**, and **EXCLUDED FROM
   CLEARANCE** entry, or exclude it from both source and binary release inputs.
3. Generate an inventory from a clean checkout and the exact lockfile, including
   transitive dependencies, native binaries, generated bundles, fonts, and assets.
4. Inspect the actual packaged application and extension, then ship all required
   license and notice texts in a user-accessible location.
5. Record exact upstream revisions and local modifications for copied source, prompts,
   skills, and vendored files.

This draft covers only the root package's direct npm dependencies and the specifically
named repository materials. A nested component's own license does not license the root
project or unrelated files.
