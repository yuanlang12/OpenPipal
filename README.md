# OpenPipal

> An AI companion that docks itself beside whatever app you're using — native on macOS, plus a browser side panel.

<p align="center">
  <a href="https://github.com/yuanlang12/OpenPipal/releases/latest">
    <img src="https://img.shields.io/github/v/release/yuanlang12/OpenPipal?label=download&color=14b8a6" alt="Download" />
  </a>
  <img src="https://img.shields.io/badge/platform-macOS-1c1917" alt="macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-14b8a6" alt="Apache-2.0" /></a>
</p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

Switch to any application and OpenPipal follows, docking to the side of your screen so the
conversation stays next to the work instead of in another window.

**It ships no model of its own.** Every request goes straight from your Mac to an
OpenAI-compatible endpoint that you configure — your key, your provider, your bill.
Nothing is proxied through an OpenPipal server, because there isn't one.

---

## What's in this release

This repository carries the **default OpenPipal Agent** only.

Five further built-in agents (Learner, Teacher, Office, Design, Interpreter) depend on a
design runtime we have not yet replaced with our own implementation, so they are not part
of this open-source release. They return once that rewrite lands. Custom agents, skills,
MCP servers, memory and the browser extension are all unaffected.

The published tree is cut from our working repository by
[`scripts/make-open-source-cut.mjs`](scripts/make-open-source-cut.mjs), driven by
[`config/open-source-policy.json`](config/open-source-policy.json). Every excluded path is
listed in `OPEN-SOURCE-CUT.json` — the cut is reproducible, not hand-curated.

---

## Install

### Desktop

1. Grab the `.dmg` for your Mac from [Releases](https://github.com/yuanlang12/OpenPipal/releases/latest)
   (separate builds for Apple Silicon and Intel), then drag `OpenPipal.app` into `Applications`.
2. **First launch: right-click the app → Open**, then confirm in the dialog. The build is not
   Apple-notarized, so macOS blocks a plain double-click. You only do this once.
3. Open **Settings → Model**, add a preset with your Base URL, API key and model name.

### Browser extension (optional)

1. Download `openpipal-extension-*.zip` from the same release and unzip it anywhere.
2. Open `chrome://extensions` in Chrome, Edge or Brave and turn on **Developer mode**.
3. Choose **Load unpacked** and select the unzipped folder.

The extension shares one AI instance with the desktop app and talks to it over
`localhost:3031`, so **the desktop app has to be running**.

---

## Model providers

Anything that speaks the OpenAI-compatible protocol works. Presets included:

| Provider | Base URL | Example model |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat`, `deepseek-reasoner` |
| OpenRouter | `https://openrouter.ai/api/v1` | `anthropic/claude-sonnet-4` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-72B-Instruct` |
| Ollama (local) | `http://localhost:11434/v1` | whatever you've pulled |

---

## What it does

- **Follows the foreground app** — switch windows and OpenPipal re-docks itself
- **Visualizer** — the model renders cards, charts, whiteboards and Mermaid diagrams live
- **Skills** — bundled capabilities for documents, PDFs, slides and spreadsheets, plus
  a skill creator and a tool installer; import your own from a folder or a GitHub repo
- **Long-term memory** — per-agent, opt-in, stored as plain Markdown you can read and edit
- **MCP** — connect any Model Context Protocol server; Context7 and DeepWiki ship as presets
- **Browser side panel** — the same assistant, inside the browser

---

## Your data stays on your machine

```
~/.openpipal/
├── config.json     # model presets and app settings
├── memory/         # long-term memory, one folder per agent
├── outputs/        # files the model produced
├── conversations/  # chat history
└── skills/         # your own skills
```

API keys live in `config.json` on your disk and are never uploaded. Deleting `~/.openpipal/`
removes everything.

---

## Build from source

Requires macOS, Node.js 22.19+ and npm.

```bash
npm ci
npx electron-vite build
npx electron .                   # run the built app
```

Checks:

```bash
npx tsc --noEmit -p tsconfig.node.json   # main process
npx tsc --noEmit -p tsconfig.web.json    # renderer
npx vitest run                           # unit tests
npx playwright test                      # end-to-end
```

`npm run dev` gives you the usual hot-reload loop. Packaging is
`npx electron-builder --config electron-builder.yml`; note that builds produced this way are
unsigned and unnotarized.

### Layout

| Path | What lives there |
|---|---|
| `src/main/` | Electron main process — agent runtime, tools, IPC, window docking |
| `src/renderer/` | React UI, shared by the desktop app and the browser panel |
| `src/preload/` | The IPC bridge between them |
| `src/shared/` | Contracts and the i18n catalogue used by both sides |
| `openpipal-extension/` | Chrome extension |
| `resources/skills/` | Bundled skills |
| `docs/` | Architecture notes and development records |

The renderer talks to the main process over preload IPC on the desktop, and over an
HTTP/SSE shim on `:3031` when it runs inside the browser extension — one renderer, two
transports.

---

## FAQ

**macOS says it can't verify the developer.** Right-click → Open instead of double-clicking,
then confirm. Once per install.

**Is it free?** The app is. Model usage is billed by your provider directly to you; OpenPipal
never sees the money or the key.

**Can I run a local model?** Yes — point the Base URL at `http://localhost:11434/v1` for
Ollama and use whatever model you've pulled.

**Windows or Linux?** Not planned. The docking behaviour leans on macOS window APIs.

**The extension does nothing.** Make sure the desktop app is running; the extension needs it
on `localhost:3031`.

---

## Contributing

Bug reports and ideas are welcome in [Issues](https://github.com/yuanlang12/OpenPipal/issues).
See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and
[SECURITY.md](SECURITY.md) for how to report a vulnerability privately.

---

## License

[Apache-2.0](LICENSE). Third-party components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); bundled skills carry their own notice in
`resources/SKILLS-NOTICE.md`.
