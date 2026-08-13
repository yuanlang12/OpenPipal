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
| `sharp` | `^0.33.5` / `0.33.5` | Apache-2.0 | `lovell/sharp` | `package.json`, `LICENSE` — **LOCALLY DOCUMENTED** |
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
**PENDING** until the required license/notice placement is made part of the release.
This match does not clear any other part of `resources/dc-runtime/`.

### OpenAI Skills snapshots

[`resources/SKILLS-NOTICE.md`](resources/SKILLS-NOTICE.md) records five specific
directories as snapshots from `openai/skills`: `skill-creator/`, `doc/`, `slides/`,
`spreadsheet/`, and `pdf/`. Each of those five directories contains an Apache License
2.0 `LICENSE.txt`. These snapshots are **LICENSE TEXT PRESENT — PROVENANCE PENDING**:
the repository records their source, but this review did not independently verify the
exact upstream revision or modification state. This is not evidence about any other
skill directory.

## Pending or excluded repository material

The following material is outside this draft clearance. It must not be included in a
public source or binary release merely because some neighboring files have known
licenses.

| Material | Status | Required resolution |
|---|---|---|
| `docs/claude/anthropic-design-agent-prompt.md`; `docs/claude/claude-design-dc-prompt.md` | **EXCLUDED FROM CLEARANCE** | Establish origin, applicable terms, and redistribution permission; otherwise omit from the public release. |
| `resources/dc-runtime/**`, except for the separately evidenced React file match above | **EXCLUDED FROM CLEARANCE** | Establish provenance and license per file/component, including generated, backup, support, and stage assets; otherwise omit. |
| `resources/skills/*` other than the five directories named in `resources/SKILLS-NOTICE.md` | **EXCLUDED FROM CLEARANCE** | Classify first-party versus third-party authorship and retain the applicable license/provenance record for every distributed skill. |
| `resources/skills-legacy/**` | **EXCLUDED FROM CLEARANCE** | Resolve authorship, upstream source, modifications, and redistribution terms; otherwise omit. |
| `resources/system-agents/**/skills/**` | **EXCLUDED FROM CLEARANCE** | Resolve authorship and redistribution terms for agent-specific skills; otherwise omit. |
| `resources/icon.icns`, `resources/icon.svg`, `resources/tray/**`, `resources/brand/**` | **EXCLUDED FROM CLEARANCE** | Confirm ownership and decide which trademarks and brand assets may be redistributed. |
| `openpipal-extension/icons/**` | **EXCLUDED FROM CLEARANCE** | Confirm ownership and redistribution scope for extension artwork. |
| `src/renderer/src/assets/agent-avatars/**` | **EXCLUDED FROM CLEARANCE** | Establish creator/source and redistribution permission for each avatar. |

No license conclusion is made here for Anthropic prompt archives, DC Runtime, custom or
legacy skills, or OpenPipal brand assets. The absence of a third-party notice is not
evidence that an item is first-party or cleared.

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
