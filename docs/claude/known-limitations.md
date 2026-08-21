# Known Limitations & Window Tracking

## Known Limitations

- Gemini Flash: `parallel_tool_calls: false` + TOOL_RULES mitigate arg concatenation.
- B站 subtitle API requires user login (Cookie with SESSDATA). Without login, falls back to page content.
- YouTube subtitle extraction: CSP blocks inline scripts, POT tokens block URL fetching. Solution: MAIN world inject.js + DOM MutationObserver on rendered captions. Subtitles accumulate over playback time.
- HTTP API streaming uses SSE via XHR (POST with text/event-stream response). XHR onload handles residual buffered data.
- Extension `pasteToTarget` is a no-op (no desktop app context in browser).
- Context7 is for popular library docs only, not arbitrary GitHub repos (use DeepWiki for that).
- **render_artifact 自检会把宿主环境的无害告警当成交付阻断项**：console 过滤只有 `HEADLESS_NOISE_RE = /favicon|Slow network|preload/i`（`openpipal-product-tools.ts:536`），此外凡 `level==='warning'` 一律计入"渲染发现 N 个问题（修完再交）"。2026-07 生成稳定性调查实测：27 次报问题里 21 次（78%）只是 Electron 自带的 CSP 安全警告，模型为此反复 read 截图 → 复检 → 再 render，把静默期拖长成用户眼里的"卡死"。装机版中 Electron 默认不打印这类安全警告，所以主要伤 dev 模式。修法很便宜：把宿主环境安全警告并进噪音白名单。
- Browser-extension surfaces have no server push for desktop-side locale changes. The side panel's `LocaleProvider` resyncs via `focus`/`visibilitychange` refetch (`getLocaleState`) only — a panel that stays focused won't switch language until it loses and regains focus. Deliberate for now: the browser surface is intentionally minimal, and the SSE channel in `http-server.ts` is scoped to chat streams only (no locale/settings push).
- **QA follow isolation**: `OPENPIPAL_DISABLE_APP_TRACKING=1` is for isolated
  automation or desktop QA only. At process start it skips frontmost-app
  probing so the test process does not trigger Accessibility prompts; it does
  not change the persisted global app-following preference or normal user
  behavior.

- **暗色模式的 surface 阶容易写反**:`deriveSurfaceScale` 里 0 档永远是 canvas
  种子、700 档永远是 ink,所以**暗色下背景/描边必须落在低档位**,高档位是文字色。
  写 `dark:bg-surface-700` 会刷出一块近白(实测 `--sw-surface-800-rgb` 在暗色下
  = `223 226 229`)。2026-08 已按「浅色搭档表达的意图」把全仓 690 处
  `dark:(bg|border|divide)-surface-*` 统一回低档位;新增代码照 `bg-surface-0
  dark:bg-surface-50` 这种写法即可;若 dark 档位和浅色档位相同就**别写 dark: 变体**
  —— 那是空操作,只会让人误以为此处有明暗决策。两条规则都由
  `tests/unit/dark-surface-ladder.test.ts` 强制,不再只是散文。

## Window Tracking Details

- **窗口选择**：跟随目标应用**最前面的窗口**（而非最大窗口），跳过宽高<100px的小弹窗。支持跟随子窗口/弹窗。
- **Full Screen 支持**：`visibleOnFullScreen` 由 window-tracker 按挂靠目标的 AXFullScreen **动态开关**（applyFullscreenAux）——目标真全屏时开（OpenPipal 浮于全屏 Space 之上，但此期间 app 无法成为前台、菜单栏显示全屏应用的名字，系统行为无解）；平时关（普通窗口，点击即激活、菜单栏显示 OpenPipal）。常开会导致 app 永远无法成为前台应用（2026-07 对照实验：该参数是唯一致因，transparent 无罪）。
- **全屏应用定位**：右侧放不下尝试左侧，都不够则贴屏幕右边缘内侧（覆盖在应用上）。
- **插拔式独立模式**：用户拖拽 OpenPipal 离开目标应用超过 50px → 进入独立模式（窗口变宽 700px）。切到任何已绑定应用 → 自动回归窄窗跟随。用 `moved` 事件 + `isAutoMoving` 标记区分用户拖拽和代码定位。
- **应用跟随设置**：用户可在设置中禁用特定应用的跟随。`disabledApps` 存入 config.json，内存缓存避免每秒读文件。
- **图片粘贴**：InputBar 支持 Cmd+V 粘贴多张图片，缩略图预览，发送后 AI 多图分析。输入框随内容自动撑高。
