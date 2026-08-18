---
name: design-tokens
description: 色彩与排版的推导法——用 oklch 从一个种子色推出整套和谐色板，定字体层级、字号/间距/阴影/圆角刻度，以及 token 该叫什么名字。任何要定视觉基调的任务都先读这份：着陆页、海报、卡片、幻灯片、仪表盘、设计系统的 tokens 目录；用户没给品牌色板时尤其必读。已经有品牌资产（指定色值/字体）时只读「命名决定分类」和「字体加载」两节。
---

# design-tokens

这份技能管**值从哪来**：一套颜色、字号、间距怎么推出来才互相咬合，而不是一个个拍脑袋。
它不管版式与观感判断，也不管设计系统的目录结构与交付流程（那是 `design-system-authoring`）。

先定 token 再写样式。反过来——先写死一堆字面值、事后再抽 token——抽出来的是一堆孤立数字，
改一处不会跟着动。

## 一、骨架：可以直接抄的起手式

一个交付物的全部基调可以就是这么一段。种子色只有一个，其余全是从它推的。

```css
:root {
  /* ── 种子：一个色相、一个中性色相，其余都是推导 ── */
  --seed-h: 250;              /* 品牌色相 0-360 */
  --neutral-h: 250;           /* 中性色相：取种子色相，让灰有倾向、不脏 */

  /* 品牌阶梯：色相不动，亮度降、色度先升后降 */
  --brand-50:  oklch(97% 0.02 var(--seed-h));
  --brand-100: oklch(93% 0.05 var(--seed-h));
  --brand-300: oklch(80% 0.12 var(--seed-h));
  --brand-500: oklch(62% 0.18 var(--seed-h));   /* 主色本体 */
  --brand-700: oklch(45% 0.15 var(--seed-h));
  --brand-900: oklch(28% 0.09 var(--seed-h));

  /* 第二色相：种子 ±150~180，色度压低一档，只做点缀 */
  --accent: oklch(68% 0.14 70);

  /* 中性：色度 ≤0.02，色相跟着中性种子走 */
  --paper:   oklch(98.5% 0.004 var(--neutral-h));
  --surface: oklch(96%   0.006 var(--neutral-h));
  --border:  oklch(88%   0.010 var(--neutral-h));
  --muted:   oklch(58%   0.012 var(--neutral-h));
  --ink:     oklch(22%   0.015 var(--neutral-h));

  /* 语义色：四支就够，色度对齐品牌色，别一支艳一支灰 */
  --success: oklch(60% 0.11 145);
  --danger:  oklch(56% 0.15 32);
  --warning: oklch(72% 0.13 78);
  --info:    oklch(60% 0.06 240);

  /* 排版 */
  --font-display: 'Instrument Serif', ui-serif, Georgia, serif;
  --font-body: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, monospace;

  --text-xs: 0.75rem;    --text-sm: 0.875rem;  --text-base: 1rem;
  --text-lg: 1.25rem;    --text-xl: 1.5rem;    --text-2xl: 2rem;
  --text-3xl: 2.75rem;   --text-4xl: 3.75rem;  --text-5xl: 5rem;

  --leading-tight: 1.15;  --leading-normal: 1.5;  --leading-loose: 1.7;
  --tracking-tight: -0.02em;  --tracking-wide: 0.06em;
  --measure: 68ch;                     /* 正文行长上限 */

  /* 间距：4px 基准，只留会用到的档 */
  --space-1: 0.25rem;  --space-2: 0.5rem;   --space-3: 0.75rem;
  --space-4: 1rem;     --space-6: 1.5rem;   --space-8: 2rem;
  --space-12: 3rem;    --space-16: 4rem;    --space-24: 6rem;

  /* 阴影：两层叠加——一层贴地的接触影，一层扩散的环境影 */
  --shadow-sm: 0 1px 2px oklch(20% 0.02 var(--neutral-h) / 0.06);
  --shadow-md: 0 4px 12px oklch(20% 0.02 var(--neutral-h) / 0.08),
               0 2px 4px  oklch(20% 0.02 var(--neutral-h) / 0.04);
  --shadow-lg: 0 20px 40px oklch(20% 0.02 var(--neutral-h) / 0.12),
               0 4px 8px   oklch(20% 0.02 var(--neutral-h) / 0.06);

  /* 圆角 */
  --radius-sm: 6px;  --radius-md: 10px;  --radius-lg: 16px;  --radius-full: 9999px;
}
```

## 二、色板：用 oklch 推，不要凭空写 hex

`oklch(L C H)` 三个分量各管一件事，而且**互不串味**——这正是它比 hex/hsl 好用的原因：

| 分量 | 范围 | 改它会怎样 |
|---|---|---|
| `L` 感知亮度 | 0%–100% | 只变明暗。两个不同色相取同一个 L，看起来一样重 |
| `C` 色度 | 0–0.37（sRGB 内实际到 0.25 就顶天） | 只变鲜艳度。C=0 就是纯灰 |
| `H` 色相 | 0–360 | 只变颜色种类。同一 H 的深浅一定是同一支色 |

hsl 做不到这点：`hsl(60 100% 50%)` 的黄和 `hsl(240 100% 50%)` 的蓝亮度标称相同，眼睛看差着一倍。
所以**阶梯用 oklch 推才会均匀**。

### 推导四步

1. **定种子**：一个 `L C H`。C 决定调性（见下表），L 通常落在 55%–65%——这是既能压白底文字、
   又不至于发闷的区间。
2. **推阶梯**：H 锁死不动，L 从 97% 走到 28%。C 不要线性跟着走——最浅（97%）和最深（28%）两端
   都要把 C 压到 0.02–0.10，中段（55%–70%）给最高的 C。C 保持不变的阶梯，浅色端会发粉、深色端会发脏。
3. **推中性**：把 C 压到 0.004–0.02，H 沿用种子色相。**纯灰（C=0）在有彩色旁边永远显脏**，
   带一点点种子色相的灰才像一套东西。往种子色相偏 = 和谐，往互补方向偏 = 冷暖对撞、更有张力。
4. **推点缀与语义**：点缀色取种子 H ±150–180；四支语义色（成功/危险/警告/信息）的 C 要和品牌色
   同一档，不然语义色会喧宾夺主或者被淹掉。

### 调性 → 参数

| 想要 | 种子 C | 中性 C | 其他 |
|---|---|---|---|
| 克制 / 商务 / 报告 | 0.06–0.12 | 0.004–0.008 | 只用一个色相 + 中性，点缀色靠 L 拉开 |
| 编辑感 / 杂志 | 0.10–0.16 | 0.010–0.020 | 中性偏暖（H 60–90），配衬线 display |
| 产品 / 科技 | 0.14–0.20 | 0.006–0.012 | 中性偏冷（H 230–260） |
| 高能 / 活动页 | 0.20–0.26 | 0.02 | 两个色相都上高 C，靠大面积留白托住 |

**暗色模式不是把 L 一减了事**：L 反转（如 22%↔96%）之后还要把 C 降 15%–25%——同样的色度在深底
上会显得更艳；同时把纯白文字换成 L≈95% 的近白，纯白在深底上会晕。我们自己那套的做法是只重定义
语义层的四个种子（accent / surface / ink / contrast），派生层自动跟随，见
`src/renderer/src/styles/tokens.css:288-300`。

### 对比度

oklch 的 L 不等于 WCAG 相对亮度，但可以当粗筛：**正文与底色的 L 差 ≥ 45 个点**基本能过 AA（4.5:1），
大标题和图标 ≥ 30 点（3:1）。粗筛只是粗筛，定稿前按实际对比度算一遍。
`--muted` 这类次级文字最容易踩线——它天然想更浅，而它承载的往往是时间、单位、说明这类
必须读得出来的信息。

### 一套真实的例子

`src/renderer/src/styles/tokens.css` 是我们自己的实例，三层结构值得照抄：
L1 物理色板（原始色值，组件永不直接引）→ L2 语义 token（组件只用这层）→ L3 由 L2 计算派生。
换主题只改 L2。它的动作色是冷中性的**墨色**（`--sw-stone-700: #1B2429`，`tokens.css:42`）而不是彩色，
品牌绿退到只做 success / logo；四支语义色分别是 sage 绿 `#6F864F`、clay 红 `#B25A3E`、
slate 蓝 `#5B7388`、amber 黄 `#B8843C`（`tokens.css:91-98`）——四支的鲜艳度是齐的，这是它不花的原因。

## 三、字体层级

### 选谁

- **有品牌资产指定字体 → 必须用它**，没有商量余地。
- **没有品牌 → 不要默认 Inter / Roboto / Arial / Helvetica / Fraunces**。这几个是"没做选择"的标志，
  一眼可辨。顺带一提：`roboto` / `arial` / `helvetica` / `segoe ui` / `fira code` / `pingfang sc` 等名字
  在宿主编译设计系统时被当作系统字体处理，写进 `--font-*` 也不会被识别为品牌字体
  （`src/main/ds-compile.ts` 的 `SYSTEM_FONTS`）。
- 一份交付物**两个字族就够**：一个有性格的 display 扛标题，一个中性的 body 扛正文。
  第三个只在真需要代码/数据对齐时加 mono。

按调性的备选：

| 调性 | 备选 |
|---|---|
| 商务 / 科技 | Work Sans、Space Grotesk、IBM Plex Sans、Geist |
| 学术 / 严肃 | EB Garamond、Literata、Source Serif、思源宋体 |
| 编辑 / 有主张 | Instrument Serif、Fraunces（做 display 可以，做正文不行）、Newsreader |
| 活泼 / 产品 | Plus Jakarta Sans、Manrope、Nunito Sans |
| 中文 | 思源宋体、思源黑体、HarmonyOS Sans、PingFang SC |

### 字体怎么进交付物 —— 这一节先读完再写 `<link>`

**不要在交付物里用 `<link>` 或 `@import` 从字体 CDN 拉字体。** 三条理由都是本项目实测过的，
原文在 `src/renderer/src/styles/fonts.css:1-15`：

1. 打开即向第三方报到，和"不经手任何东西"的隐私主张冲突；
2. 常见字体 CDN 的域名在中国大陆不通（本机实测 curl 返回 000），而 `@import` / `<link>` 是**阻塞式**的
   ——要等它超时才继续渲染，客户看到的是一段白屏；
3. 断网时字体直接回退，观感和联网时不是一回事。

这三条用在交付物上比用在应用界面上更严重：应用界面在我们自己机器上跑，交付物是要**发出去**的，
客户在什么网络环境、什么机器上打开，我们控制不了；而且导出的 PDF / 独立 HTML **不会把字体文件带上**
——远端拉不到就是替身字体，版式全走样。

> **待定**：字体随产物一起分发（把开源字体随运行时发 / 导出时内联进产物 / 只用系统字体栈）
> 三条路尚未选定。以下做法在三条路中的任何一条下都成立，先按这个写。

**在任何选择下都正确的做法：**

- **优先用系统字体栈的组合拳。** 系统字体不等于没个性——把不同的族搭起来照样有主张，
  而且零加载、零阻塞、离线一致：

  ```css
  /* 有编辑感的衬线 display */
  --font-display: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, ui-serif, serif;
  /* 几何感的无衬线 display */
  --font-display: Futura, 'Avenir Next', 'Century Gothic', ui-sans-serif, sans-serif;
  /* 中性正文 */
  --font-body: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', sans-serif;
  /* 中文衬线 */
  --font-serif-cjk: 'Songti SC', 'Source Han Serif SC', STSong, serif;
  ```

- **一定要用网络字体时，把回退链写完整，并且让回退链自己也站得住。**
  回退链不是摆设——它是断网时客户真正看到的东西。同族同调的替补排在前面，
  末位永远留 `serif` / `sans-serif` / `monospace` 之一。
- **回退切换要不塌。** 替补字族的字宽和目标字族差太远，回退时行数会变、卡片会撑破。
  用 `size-adjust` / `ascent-override` 收敛，或者干脆把版式做成不吃固定行数的（用 `min-height` 而不是
  写死高度，标题给 `text-wrap: balance`）。
- **`font-display: swap`**，不要 `block`。宁可先用替补把内容画出来，也不要空白等待。

### 刻度

字号阶梯用比例数列，不要逐档 +2px。做界面/仪表盘用 1.2（档多、差别细），做海报/着陆页用 1.333 或 1.5
（大标题要真的大）。**关键在两端**：正文别低于 16px（网页）/ 14px（密集界面），
最大号至少是正文的 3 倍，不然层级立不起来。

```css
--text-base: 1rem;
--text-lg: 1.25rem;  --text-xl: 1.5rem;  --text-2xl: 2rem;
--text-3xl: 2.75rem; --text-4xl: 3.75rem; --text-5xl: 5rem;   /* 1.333 系 */
```

行高与字号反相关：正文 1.5–1.7，大标题 1.05–1.2。字号越大行高越紧，
标题用 1.5 会散成一盘沙。字距同理：display 尺寸给 `-0.02em` 收紧，全大写小标签给 `+0.06em` 撑开。
正文行长控制在 60–75 字符（`--measure: 68ch`），比字号本身更影响读感。

## 四、间距刻度

4px 基准，走 1 / 2 / 3 / 4 / 6 / 8 / 12 / 16 / 24 这样**越往上跳得越大**的档位。等差刻度
（4/8/12/16/20/24…）在大尺寸段几乎没有区分度，结果就是所有留白看起来都差不多。

刻度的价值是**只从刻度里取值**。一旦出现 `margin: 13px`，这套东西就已经废了——
不是因为 13px 难看，是因为下一个人不知道该跟 12 还是跟 16。

层级留白要拉开差距：同组元素之间 `--space-2`，组与组之间 `--space-8`，区块与区块之间 `--space-24`。
差 2 倍不够，差 3–4 倍才读得出"这是两件事"。

## 五、阴影与圆角

阴影**永远两层**：一层小而紧的接触影（贴着元素底边，1–2px 模糊）+ 一层大而散的环境影。
单层阴影一眼假。

阴影颜色**不要用纯黑**。`rgba(0,0,0,.5)` 落在有彩色底面上会发灰发脏。取中性色相里最深的那档、
把 alpha 压到 0.04–0.12：`oklch(20% 0.02 250 / 0.08)`。深色模式下阴影几乎不可见，
该换成边框或者微弱的顶部高光来做层次。

圆角：**同一个交付物里最多三档 + 一个 full**。嵌套时外层圆角要比内层大——
外圆角 = 内圆角 + 内边距，否则两条弧线不同心，看着别扭。

## 六、唯一的真接口：token 的名字决定它被归成哪一类

当交付物是**设计系统**（`design-system-authoring` 那条路）时，宿主会静态解析你写的 CSS，
按 token **名字**把每个 token 归入 `color / font / spacing / radius / shadow / other` 六类之一，
判定逻辑在 `src/main/ds-compile.ts` 的 `inferKind()`（2026-08-17 改成段匹配）。归类结果落进 `_ds_manifest.json`
的 `tokens[].kind` 与 `.oxlintrc.json` 的 `x-openpipal.tokenKinds`，下游按 kind 取用。

判定按顺序短路，第一条命中即返回：

| 顺序 | 条件（名字已转小写、剥掉开头的 `--`） | 归类 |
|---|---|---|
| 1 | 名字里有独立**连字符段** `shadow` | shadow |
| 2 | 有独立段 `radius` 或 `corner` | radius |
| 3 | **值**里含 `#hex` / `rgb(` / `hsl(` / `oklch(` / `oklab(` / `lab(` / `lch(` / `color-mix(` | color |
| 4 | 有独立段 `font`/`text`/`leading`/`tracking`/`weight`/`line-height`/`letter` | font |
| 5 | 有独立段 `space`/`spacing`/`gap`/`size`/`width`/`height`/`measure`/`sidebar`/`container`/`topbar`/`inset`/`gutter` | spacing |
| 6 | 值是纯长度（`16px` / `1.5rem` / `68ch`…） | spacing |
| 7 | 名字里含 `color`/`bg`/`fg`/`ink`/`paper`/`surface`/`border`/`accent`/`success`/`error`/`warning`/`danger`/`info`/`ring`/`focus`/`text` | color |
| 8 | 都不中 | other |

三条值得记住的顺序含义：

- **关键词按连字符段匹配，不要求紧贴 `--`。** 所以 `--acme-font-body`、`--sw-text-xs`
  这类带命名空间前缀的写法**照样落对**——品牌 token 几乎都带前缀，这是常态而不是例外。
- **值的色值判定（第 3 条）排在名字猜测之前。** 值是事实，名字是猜：`--text-primary: #333`
  归 **color**，不会因为名字里有 `text` 被判成 font。
- **font（第 4 条）排在 spacing（第 5 条）之前。** `--font-size` 两边都命中，它是字号不是间距。

仍然会落到 other 的两种，是**没有信号、不该硬猜**，不是缺陷：

| 写成 | 归类 | 为什么 |
|---|---|---|
| `--brand-sage: var(--brand-500)` | **other** | 值是 `var()` 引用、不含色值字面量，名字里也没有第 7 条的色彩词。想归 color 就写 `@kind` |
| `--duration-fast: .15s`、`--ease-enter: cubic-bezier(…)` | **other** | 没有 motion 这一类，动效 token 落 other 是正常的，别硬改名去凑 |

**分错不报错**，只是分组和下游取用会静默走偏。最实际的后果：品牌字体是从 `kind === 'font'` 的
token 里抽出来的（`ds-compile.ts` 的 `collectBrandFonts`），字体 token 一旦没被归成 font，`brandFonts` 就是空的，
那条"只允许用设计系统提供的字体"的校验规则也跟着不生成。

非常规命名躲不掉时，用 `@kind` 旁注显式声明，直接压过自动判定
（`ds-compile.ts` 的 `parseTokens`，`@kind` 旁注跟在分号后）：

```css
--sw-font-ui: 'Geist', sans-serif; /* @kind font */
--sw-text-xs: 11px; /* @kind font */
--brand-sage: var(--brand-500); /* @kind color */
```

写法要求：旁注跟在**分号之后**；取值只认 `color` / `font` / `spacing` / `radius` / `shadow` / `other`
六个，拼错了不报错，静默退回自动判定。

## 七、宿主已经替你做了什么

- **不用手写 token 清单。** `:root` 里的 `--x: y` 会被静态解析并汇总进 `_ds_manifest.json`，
  不需要另外维护一份索引（`ds-compile.ts` 生成 manifest 时一并收集）。
- **不用手写分类。** 见上一节，命名合规即自动归类。
- **不用手写品牌字体清单。** 从 font 类 token 里自动抽出首个非系统字族（`ds-compile.ts` 的 `collectBrandFonts`）。
- **不用手写 lint 规则。** 原始 hex 字面量、原始 `px` 字面量、不在清单里的 `font-family`
  都会自动生成告警规则（`ds-compile.ts` 生成 `_adherence.oxlintrc.json` 的那三条 warn 规则）——这也是为什么值必须走 `var(--token)`。

## 八、约束与静默失败

- **同名 token 以首次出现为准**，后面的定义不会覆盖前面的（`ds-compile.ts` 的 `parseTokens`，按首见去重）。
  所以**先写浅色值再写暗色重定义**；顺序反了，清单里记录的就是暗色那份。
- **只有 `styles.css` 通过 `@import` 引到的文件、或 `tokens/*.css` 会被扫描**
  （`ds-compile.ts` 的 `resolveGlobalCssPaths`）。token 写在组件 CSS 里或页面内联 `<style>` 里，等于没写——不报错，只是查无此物。
- **值里不能出现 `;`**：解析取的是 `--name:` 到分号之间的内容（`ds-compile.ts` 的 `parseTokens` 那条 declaration 正则）。
- **色板不能只有亮度变体**。单色相通篇拉深浅，页面会闷；至少要有第二个色相承担点缀与语义。
- **`--muted` 类次级文字最容易掉到对比度线以下**，而它承载的经常是必须读出来的信息。
- **交付物在客户机器上打开时，只有客户机器上有的字体和产物自带的字体能用。** 见第三节。

## 九、纪律

- 从种子色**推**，不要挨个发明 hex——发明出来的色板放在一起不像一家人。
- **不写 `#000` / `#fff`**。纯黑纯白太硬，用 `oklch(22% 0.015 250)` 和 `oklch(98.5% 0.004 250)`——
  带一点色相倾向的深浅色，页面会立刻显得"是调过的"。
- **不用 `rgba(0,0,0,.5)` 做阴影**，过黑过实。见第五节。
- **不搞用不到的档位**。九档字号里只用四档，说明刻度定错了，删掉没用的档比留着强。
- **字面值只准出现在 `:root` 里**，别的地方一律 `var(--token)`。这条一破，改主题就变成全局搜索替换。
- **色板与字体在写第一行样式之前定完**。事后调色是重做，不是微调。

## 十、自检

交付前逐条过：

1. 全文 `grep -c '#[0-9a-fA-F]\{3,8\}'`——`:root` 之外命中数应为 0。
2. 同样查 `rgba(0,0,0`、`margin:` / `padding:` 后面的裸 px：应全部是 `var(--space-*)`。
3. 字号只出现在刻度上；数一数实际用了几档，少于 3 档说明层级没做出来。
4. 每个 `--font-*` 的回退链末位是 `serif` / `sans-serif` / `monospace` 之一；
   把网络字体从链首去掉再看一眼版式，塌了就是回退链没撑住。
5. 正文与底色的 L 差 ≥ 45 点；次级文字、placeholder、disabled 三处逐个确认。
6. 交付物是设计系统时：对照第六节的表，逐个 token 确认归类，异常的补 `@kind` 旁注。
7. 需要暗色时：切过去看阴影还在不在（多半不在了，换边框或顶部高光）。
