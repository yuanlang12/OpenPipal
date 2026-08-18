---
name: doc-design
description: 排版级文档交付物（简历/一页纸/备忘录/报告/白皮书/科普长文/教案讲义）的说明书，同时是分页壳 doc-page 三种模式（连续流 / 显式分页 / 缩放贴合）的总说明书——纸张与边距属性全表、页眉页脚只在哪种模式存在、运行时已铺好的排版与断页底座、会静默失败的写法、导 PDF 的真实行为。判据：交付物最终要落到纸上（打印、导 PDF、固定纸张尺寸）就必读；flier / trifold-brochure 只写各自形态的纪律，doc-page 的公共事实一律以本篇为准。写第一行之前读完。
---

# 排版级文档（doc-page 分页壳）

一个 `.dc.html`，正文交给预制件 `doc-page` 托管：屏幕上是一张（或一叠）真实纸张，
打印与导 PDF 时版心、页眉页脚、断页卫生已经是对的。**你不写任何 `@page` / `@media print` 的
分页几何**——纸张几何由组件持有，自己再写一份只会和它打架。

DC 文件格式本身（`<x-dc>`、空穴、helmet 规则、就地编辑、字体口径、`render_artifact` 自检）见
**dc-authoring** 技能，本篇不重复，只讲纸。

**与 `generate_document` 分轨**：那个工具产出内容文档（Markdown / docx，落 `~/.openpipal/outputs/`），
重在文字本身，不做版式。用户只说"写份东西"用它。本技能是**排版**文档——用户要"设计一份简历 /
白皮书 / 报告"、在意版式与字体、要在宿主里点选改字、要一键出 PDF 时走这条。

---

## 1. 三种模式：先选对，再动手

模式**不是属性选的，是内容形状与属性组合推导出来的**（`doc-page.js` 的 `_geometry()`）：

| 模式 | 触发条件 | 屏幕 | 打印 / PDF | `margin` | 页眉页脚 slot |
|---|---|---|---|---|---|
| **A 连续流**（默认） | 既没有 `.page` 直接子元素，也没成对给 `content-width`+`content-height` | 一张无限延长的纸 | 打印引擎按纸张分页，内容重排 | 生效，默认 `0.75in` | ✅ **只有这里有** |
| **B 显式分页** | 有 `.page` **直接子元素** | 一页一张卡片，纸间 24px | 一个 `.page` 恰好一张纸，溢出裁切 | 恒为 0（全出血），写了也被忽略 | ❌ 静默丢弃 |
| **C 缩放贴合** | 没有 `.page`，且 `content-width` 与 `content-height` **同时**是合法绝对长度 | 一张纸，内容整体等比缩放后贴合 | 同屏幕，一张纸 | 默认 0；显式写了才内缩 | ❌ 静默丢弃 |

选哪个：

- **A** —— 长度由内容决定的文档：报告、白皮书、科普长文、简历、备忘录、信函、教案讲义。**本篇主线。**
- **B** —— 页数确定的印刷品：传单、海报、证书、三折页。细则见 **flier** / **trifold-brochure** 技能。
- **C** —— 已经按固定像素画好的设计要原样上纸：1200×1600 的社媒图、按 px 画的信息图、
  按 px 画的封面。内容整体缩放到纸上，比例不变。

三者互斥。B 的判定优先于 C：只要有一个 `.page` 直接子元素，`content-width/height` 就完全不起作用。

---

## 2. 骨架（连续流，可直接抄）

```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <script src="./doc-page.js"></script>
  <style>doc-page:not(:defined){ visibility:hidden }</style>
</helmet>

<doc-page size="letter" margin="0.9in">

  <div slot="header" style="display:flex; justify-content:space-between; font:400 11px/1.4 'SF Mono','Cascadia Code',ui-monospace,monospace; letter-spacing:.18em; text-transform:uppercase; color:#8a8f98">
    <span>Agent 工程科普指南</span><span>明析</span>
  </div>

  <h1 style="font:700 46px/1.14 Optima,'Avenir Next','Songti SC',serif; letter-spacing:-.01em; color:#101319; margin:0 0 18px">标题</h1>
  <p style="font-size:20px; line-height:1.65; color:#4a5058; margin:0 0 34px; max-width:32em">副题一到两句。</p>
  <p style="margin:0 0 16px">正文……</p>

</doc-page>
</x-dc>
</body>
</html>
```

**挂载口径（三份技能统一用这一种写法）**：helmet 里一行 `<script src="./doc-page.js"></script>`，
正文直接写 `<doc-page>`。这个 `src` 不是让浏览器去取路径、也不靠运行时执行 helmet 脚本——
**宿主扫到这个引用就把预制件源码内联进文档**（预览端 `dcRuntime.ts`、自检与导出端 `dc-headless.ts`
两条同源通道），所以路径必须一字不差是 `./doc-page.js`。

> `<x-import component-from-global-scope="doc-page" from="./doc-page.js" …>` 也能解析（宿主对
> `from` / `src` / `import` 一视同仁），老产物里见到不必改。但新写的一律用上面那种：属性直接写在
> 元素上、子元素就是纸上的内容，少一层透传。

- **`.page` 的判定看的是"直接子元素"**：写 B 模式时 `<section class="page">` 必须紧贴 `<doc-page>`，
  中间包任何一层 `div` 都会退回 A 模式（无告警）。
- 一份文档可以有多个 `doc-page`，但 **`@page` 只有第一个在场的那个持有**——第二个的
  `size` / `orientation` 在打印时不生效。要两种纸张 = 拆两份产物。

---

## 3. 属性全表

`size` `orientation` `width` `height` `margin` `content-width` `content-height`，
七个，全部可随时改（组件监听属性变化重算）。

| 属性 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `size` | `letter` \| `legal` \| `a4`（大小写不敏感） | `letter` | letter 8.5×11in，legal 8.5×14in，a4 210×297mm。**不在这三个里的值静默落回 letter** |
| `orientation` | 含 `landscape` 即横版 | 纵版 | 横版 = 交换宽高 |
| `width` / `height` | 绝对长度 | 由 `size` 定 | 非标准纸型用它俩覆盖 `size`（如 `width="22in" height="30in"` 的海报）；原样透传，不做单位换算 |
| `margin` | CSS 简写 1–4 个绝对长度 | A 模式 `0.75in`；C 模式 `0`；B 模式恒 `0` | 四值顺序同 CSS：上 右 下 左 |
| `content-width` + `content-height` | 绝对长度，**必须成对** | 无 | 成对给且没有 `.page` 才进 C 模式；只给一个 = 两个都被忽略，静默留在 A 模式 |

**长度单位**：只认绝对单位 `px` `in` `cm` `mm` `pt` `pc` `q`（`0` 也合法）。
`em` `rem` `%` `vh` `vw` 这类相对单位在纸上没有稳定含义，一律判为无效。
无效的后果分两种：`width` / `height` / `content-*` 无效 = 该属性当没写；
`margin` **任何一个分量**无效 = 整个 margin 落回默认值（A 模式 0.75in，C 模式 0），不报错。
所以 `margin="5%"`、`margin="2em"` 的实际效果是 0.75in，不是你以为的那个数。

**C 模式的换算**：CSS px 恒等于 1/96in，组件按这个换算，所以
`content-width="1200px" content-height="1600px"` 就是把一块 12.5×16.67in 的设计整体缩放上纸——
你按 px 画的稿子尺寸对得上，不用自己折算。缩放比 = min(可用宽/内容宽, 可用高/内容高)，
**水平居中、顶对齐**。内容实际比声明的大 → 超出部分被纸边裁掉，所以两个值要写你设计的真实尺寸。

### `@page` 与导 PDF 的真实行为

组件往 `document.head` 注入唯一一条 `@page`，规则只有两种形态：

- **钉死纸张**：`@page{size:<宽> <高>; margin:0}` —— B / C 模式，或 A 模式里作者**同时**给了
  `width` 和 `height`。
- **不钉纸张**：`@page{margin:0}` —— A 模式的常态。这是有意的：连续流文档该按用户手上的真实纸张
  分页，组件不替打印机决定纸型。

导 PDF（`export_artifact(format='pdf')`，或用户在导出弹窗里选 PDF）走无头 Chromium，
`preferCSSPageSize:true`：@page 里有 size 就用它。A 模式没有 size 时，宿主**读 `doc-page` 元素上
的 `size` / `orientation` 属性**补一个纸张（认得的三种纸名，认不得就 Letter）——所以 A 模式写
`size="a4"` 对 PDF 是有效的（`dc-export.ts` 的纸张兜底，2026-08-17 加）。

**没挂 doc-page 的产物导 PDF 会落到 Chromium 默认信纸**，宿主不传任何纸张参数。
比可打印宽度宽的内容**不会自动缩放**，只会溢出到纸外。所以"顶层元素写个 px 宽度、导出自动把
PDF 页尺寸设成这个像素尺寸"这件事**不存在**；要把固定尺寸设计原样上纸，用上面的 C 模式。

---

## 4. 页眉页脚（只有连续流模式有）

给任意直接子元素加 `slot="header"` 或 `slot="footer"`：

```html
<div slot="footer" style="text-align:center; font:400 11px/1.4 ui-monospace,monospace; color:#8a8f98">明析 · 2026</div>
```

- 打印时它们 `position:fixed` 钉在每页上（running header/footer），正文由组件量出的等高占位行让开——
  这套你不用管，只写内容。
- **占位高度就是页眉实测高度，组件不额外加间距**：想让正文离页眉更远，自己在页眉上写
  `padding-bottom` 或在正文首元素上写 `margin-top`。
- **B / C 模式下没有具名 slot**：写了 `slot="header"` 的元素既进不了 header 槽、也不会掉进默认槽，
  于是**不渲染、不报错、静默消失**。固定纸张的页眉页脚就在 `.page` 里当普通元素画。
- **不要写"第 N 页"**：这个位置渲染不出页码计数器。要页码只能一页一个 `.page` 手写死。
- 默认不加页眉页脚。正文 h1 已经命名了文档；长报告、每页要品牌或密级标记时才加。

---

## 5. 运行时已经替你做了什么（别再写一遍）

`doc-page` 一挂上就往文档里铺了一整套底座，**全部写在 `:where()` 里 = 零特异性**，
你自己写的任何值都能直接覆盖，不需要 `!important`、不需要更具体的选择器。

**排版底座**
- `body{margin:0}` + 一套中西文都能落地的系统字体栈，`font-size:15px`，`line-height:1.6`，`color:#181a1f`
- `img{max-width:100%; height:auto}`（图不会撑破版心）
- `pre{white-space:pre-wrap; overflow-wrap:anywhere}`、`table{max-width:100%}`
- 标题 `text-wrap:balance`、段落与列表项 `text-wrap:pretty`

**打印期**
- `html,body` 强制白底、去边距
- **断页卫生**：`figure` `pre` `img` `svg` `blockquote` `tr` `thead` `tfoot` 一律 `break-inside:avoid`；
  `p` `li` 的 `orphans:3; widows:3`；所有标题 `break-after:avoid`（标题不会孤零零留在页底）
- **颜色保真**：`print-color-adjust:exact` 挂在组件上，正文继承——深色块、彩色背景印得出来，
  你不用写这条
- 屏幕上的纸卡阴影、圆角在打印时自动去掉

**屏幕**
- 纸卡（白底 + 阴影）、桌面底色、纸与纸的间距
- **容器比纸窄时整体缩放**，纸永远完整可见；打印期缩放恒为 1，不影响出片。
  自检截图里"字看着变小了"通常是这层，不是你把字号写小了。

**B 模式的 `.page` 还自动带**：纸张尺寸（`!important` 钉死）、`overflow:hidden`、白底、
`container-type:size`（容器查询单位可直接用）、页间分页符。这些**都不用你写**。

所以：不要手写 `@page`、不要写 `@media print` 的分页规则、不要给 `.page` 写 width/height/
`container-type`、不要自己搭"纸卡 div"、不要写 `body{margin:0}`、不要写 `print-color-adjust`。

---

## 6. 合法的定制出口（只有这几个）

- **`--doc-page-desk`** —— 屏幕上"桌面"的底色（默认 `#e8e6df`）。在 helmet 的 `<style>` 里
  写 `:root{--doc-page-desk:#f3f1ec}` 换掉。只影响屏幕，不影响打印。
- **`doc-page::part(sheet)`** —— 纸张容器本身。改纸的底色、阴影、圆角走它，例如
  `doc-page::part(sheet){box-shadow:none}`。也写在 helmet 的 `<style>` 里。
- **直接覆盖底座** —— 底座是零特异性的，正文里内联写 `style="font-size:16px; line-height:1.8"`
  就覆盖掉了，这是预期用法。
- **出血底色写在 `.page` 或内容根上，绝不写 `body`** —— 打印期 `body` 被强制成白底，
  写在 body 上的整页底色在屏幕上看着好好的，一导 PDF 就没了。

---

## 7. 约束与静默失败（不知道就会踩，踩了不报错）

1. `.page` 必须是 `doc-page` 的**直接子元素**。包一层 wrapper → 退回连续流，纸张盒、
   容器查询单位、逐页裁切全部落空。
2. B 模式里**非 `.page` 的直接子元素照样会被渲染**——它没有纸张盒，会变成夹在纸与纸之间的裸块。
   B 模式下每个直接子元素都应该是 `.page`。
3. **`slot="header"` / `slot="footer"` 只在 A 模式存在**，B / C 模式下静默消失（见 §4）。
4. **`content-width` 与 `content-height` 必须成对**。只给一个 = 两个都当没写，你以为进了 C 模式，
   实际还在 A 模式。
5. **`margin` 的任一分量用了相对单位 → 整条落回默认值**，不报错。
6. **`size` 写了三种纸名之外的值 → 静默落回 letter。**
7. **一份文档只有第一个 `doc-page` 持有 `@page`**，后面的纸张属性在打印时不生效。
8. **给 `.page` 写 `width` / `height` 无效**（组件用 `!important` 钉成纸张尺寸）；写 `background`
   有效（内联样式压得过组件的默认白底）。
9. **溢出即裁切**：B / C 模式的纸是硬边界，超出部分不流到下一页，直接没了。
10. **正文里不要用 `position:fixed` / `sticky`**：打印时 fixed 元素会在**每一页**重复出现一次。
    需要每页重复的东西只有页眉页脚，走 §4 的 slot。
11. **不要用 `vh` / `vw` 做纸上的尺寸**：视口单位按屏幕算、打印按纸算，两边全错。
    连续流文档的长度用物理单位（`in` / `mm` / `pt`）或 `px`（1px = 1/96in，是确定的物理长度）。
    容器查询单位 `cqw` / `cqh` **只在 B 模式的 `.page` 里可用**（组件在那里给了尺寸容器）——
    A / C 模式没有尺寸容器，写了会退化成视口单位，屏幕上勉强能看、打印尺寸全错。
12. **`break-inside:avoid` 是"尽量不切"不是"绝不切"**：块内容本身超过一页时照样被硬切。
    自己搭的卡片 / callout / 统计块想不被切开，给它自己写 `break-inside:avoid`，并保证它短于一页。
13. **多列 Grid 的项写 `break-inside:avoid` 会留空白带**（grid 只按行分页）。要分栏排版用真
    `columns`（§8）。

---

## 8. 版式纪律

**分栏**只用真 CSS 多栏：`column-count` + `column-gap`，跨栏标题 `column-span:all`，
窄栏配 `hyphens:auto`（要在文件的 `<html>` 上写 `lang`，否则断词规则不生效）。
`flex` / `grid` 并排模拟出来的"栏"在分页时不流动——整栏卡死或错位。

```html
<div style="column-count:2; column-gap:34px; hyphens:auto">
  <h3 style="column-span:all; margin:0 0 12px">跨栏标题</h3>
  <p>正文……</p>
</div>
```

**行长**是单栏长文最容易翻车的一处。letter + `0.75in` 边距的版心是 7in ≈ 672px：
15px 中文约 40 字/行，正好；同样宽度的英文会到 85+ 字符，远超舒适区。英文长文三选一——
边距加到 `1.25in`、给正文段落 `max-width:34em`（右侧留白当边注区，别居中）、或者走双栏。

**字阶**定一组值全文复用，别每处现编：

| 用途 | 值 |
|---|---|
| h1 | 40–52px / 行高 1.12–1.18 / 字重 700–900 / 字距 -0.01em |
| h2 | 26–30px / 行高 1.25 |
| 引言 lead | 20–22px / 行高 1.6 / 比正文浅一档的颜色 |
| 正文 | 中文 15–16px / 行高 1.75–1.9；英文 16px / 行高 1.55–1.7 |
| 图注 / 页眉页脚 | 11–12px |

**打印下限**：正文别低于 11px（≈8.3pt）；给年长读者或密集表格的文档，正文按 12pt（16px）起。
图注 11px 是底线，再小印出来读不了。

**字体**走系统字体栈，中西文各给一段、回退链写全，**不要写网络字体 `<link>`**——
理由和可用的几组栈见 dc-authoring 技能的「字体」一节。文档常用三件套：
标题用有编辑感的衬线或几何体、正文用界面无衬线、eyebrow 与编号用等宽体（配
`letter-spacing:.18em` + `text-transform:uppercase`）。三个角色全文一致，不要中途换。

**色板**极简且贯穿：一个墨黑（章线、深色块）、一个正文灰黑、一个 accent、两三档中性灰。
accent 在全文出现 15–20 处量级（章号、eyebrow、引言左边框、图内高亮）。
语义色另算且映射固定——红只表示错误、绿只表示完成，不占 accent 名额。

**间距节奏**：章间 / 段间 / 图上 / 图下各定一个值全文严格复用（例如 52 / 16 / 30 / 24px）。
节奏的一致比数值本身重要。

**信息图用纯 div / flex / grid 画**，不用 SVG、img、canvas。三条理由：每个字都是 DOM 文本，
用户在预览里点得进去改得动；打印保真；不吃 token（一个内联 SVG icon ≈ 40 个 Unicode 字形的开销）。
图标用字形（◎ ⊞ ⇉ ◈ ⚐ ▤ ▲ ●）配字号与颜色。
每张图只表达一个概念、节点 ≤5 个；**相邻两章不复用同一张图的骨架**，全文至少三种不同图式
（左右对比、流程环、中心辐射、组织树、编号条）。

**figure 统一壳**，配合运行时已给的 `break-inside:avoid`：

```html
<figure style="margin:30px 0 24px; border:1px solid #e4e7ec; border-radius:12px; overflow:hidden">
  <figcaption style="background:#f7f8fa; padding:8px 14px; font:600 11px/1.4 ui-monospace,monospace; letter-spacing:.2em; text-transform:uppercase; color:#5b636e">图解 02 · 推理循环</figcaption>
  <div style="padding:24px; display:flex; gap:16px; align-items:center; justify-content:center">…纯 div 节点…</div>
</figure>
```

**表格**给真 `<thead>`——分页时表头会在每页重复；表头行加底色或粗线，正文行只留细分隔线。

**章节节奏**（长文用；简历、备忘录这类短件不套）：封面 → 目录 → 序言 → 编号章节 → 结尾 → 落款行。
每章走同一套结构：章头条（细线 + 编号 + h2）→ 2–3 段铺垫 → 一张图 → 1–2 段收束并勾下一章 →
一句可带走的结论。章节另起一页写 `style="break-before:page"`。

深色封面块 + 大留白 + 单一 accent 是编辑设计的常规手法，与产品 UI 那份"反 AI 默认审美清单"
不冲突——那份针对的是界面装饰惯性。但**不造 filler**：不为了"看起来满"编数据、统计和无意义图标。

---

## 9. 交付前自检

1. `render_artifact(id)` —— 读回 console 告警、文本重叠检测、页面文本摘要与截图（细则见
   dc-authoring 的自检一节）。
2. **文本摘要能穿进组件取到正文**（宿主专门优先取纸张容器），所以摘要为空 = 内容根本没进纸，
   先查 §7 第 1 条和 dc-authoring 的"内容写到 `</x-dc>` 外面"。
3. **自检截图是 1280×900 的视口截图，比一整张纸矮**：letter 纵版只拍得到上面 85% 左右。
   页底的东西看不见是正常的，别据此判断被裁了——B / C 模式的多页产物给每个 `.page` 加
   `data-screen-label="封面"` 这类标签，摘要与交接包截图就会**逐页**分开给你。
4. 目视核对四件事：版心是否居中、行长是否过宽、字体回退链是否落到了难看的替身、
   figure 与自定义卡片有没有被切开。
5. 要 PDF 就 `export_artifact(format='pdf')`，落 `~/.openpipal/outputs/`；回执里带文件大小，
   小得离谱就是渲染出了问题，别直接宣称成功。
6. 改稿优先 `edit_artifact` 精确替换，不要整篇重发（理由见 dc-authoring）。
