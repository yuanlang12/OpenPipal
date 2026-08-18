---
name: deck-stage
description: 用 deck-stage 预制舞台做幻灯片——页元素契约、逐页入场动画门控（data-deck-active）、跳过页、演讲备注、导航与页内脚本接口、打印/PPTX/交接包导出时到底发生什么。凡是要产出 deck/幻灯片/演示稿/汇报材料/pitch，或要改一份已有 deck 的页序、动画、备注、侧栏、导出行为，动手前必读。DC 文件格式本身（骨架、模板语法、样式规则）见 dc-authoring 技能。
---

# deck-stage：幻灯舞台

把「一页一个直接子元素」的静态 HTML 变成能翻页、能自适应任意容器、能一页一张纸导出的幻灯片。
你只写「这一页说什么、怎么排」；翻页、等比缩放、页码、打印几何这四件确定性的机械活全部归舞台——
它们恰好是错一次就整份废掉的部分。

DC 文件本身的骨架、`{{ }}` 空穴、`sc-for`/`sc-if`、逻辑块、调参面板见 **dc-authoring 技能**，本篇只讲舞台。

## 1. 最小可运行文件

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
  <style>
    *{ box-sizing:border-box; }
    html,body{ margin:0; height:100%; }
    :root{
      --type-title:64px; --type-subtitle:44px; --type-body:34px; --type-small:28px;
      --pad-x:100px; --pad-y:88px; --gap-item:28px;
    }
  </style>
</helmet>

<x-import component-from-global-scope="deck-stage" from="./deck-stage.js"
          width="1920" height="1080" hint-size="100%,100%">

  <section data-label="Title" data-speaker-notes="30 秒开场，点出这次汇报要解决的问题"
           style="background:#f5f0e6; padding:var(--pad-y) var(--pad-x); display:flex; flex-direction:column; justify-content:center;">
    <h1 style="margin:0; font:600 var(--type-title)/1.15 Georgia, serif; color:#241f1a;">季度回顾</h1>
    <p style="margin:24px 0 0; font:400 var(--type-subtitle)/1.35 system-ui; color:#6b6157;">2026 Q2 · 增长与留存</p>
  </section>

  <section data-label="Agenda"
           style="background:#fffdf8; padding:var(--pad-y) var(--pad-x); display:flex; flex-direction:column; justify-content:center; gap:var(--gap-item);">
    <h2 style="margin:0; font:600 var(--type-subtitle)/1.2 system-ui; color:#241f1a;">今天讲三件事</h2>
    <div style="font:400 var(--type-body)/1.4 system-ui; color:#3c352d;">一、这一季发生了什么</div>
    <div style="font:400 var(--type-body)/1.4 system-ui; color:#3c352d;">二、数字背后的原因</div>
    <div style="font:400 var(--type-body)/1.4 system-ui; color:#3c352d;">三、下一季怎么打</div>
  </section>

</x-import>
</x-dc>
</body>
</html>
```

硬点：

- **`from="./deck-stage.js"` 必须逐字出现。** 宿主用 `from="…deck-stage.js"` 或字面量 `<deck-stage` 这一组
  正则认定「这是一份 deck」，它是 PPTX 导出门闩与交接包分类的唯一判据。写错路径 = 导不出 PPTX。
- **`hint-size="100%,100%"` 要写。** 这是舞台就绪前的占位尺寸；不写会先塌成一个默认小占位框，运行时还会告警。
- `width` / `height` 由 `x-import` 原样透传给舞台，缺省 **1920 × 1080**。
- 整段（含 `<x-import>` 与全部页元素）必须待在 `<x-dc>…</x-dc>` 内部；写到外面就是裸标记，看着像成了但全死。
- **不要写裸 `<deck-stage>` + 末尾 `<script src="./deck-stage.js">`。** 这条路能跑（宿主必须继续支持），
  但元素升级之前你的页会以作者样式整屏裸露，流式期间观感崩掉。
- 一份产物**只能有一个舞台**：导出与自检链路一律 `document.querySelector('deck-stage')`，多写的那个不存在。

## 2. 页元素契约

一页 = 舞台的**一个直接子元素**，页序 = 文档顺序。
`<template>` / `<script>` / `<style>` 三种直接子元素不算页；**除此之外任何直接子元素都算一页**——
为了分组多套一层 `<div>` 包裹，就会多出一张空白页。

### 写在页元素上的属性

| 属性 | 值 | 作用 |
|---|---|---|
| `data-label` | 字符串 | 该页的人类可读名。**它决定交付文件名**，见下 |
| `data-speaker-notes` | 字符串 | 该页演讲备注。跟着元素走，重排/复制/删除都不会错位 |
| `data-deck-skip` | 布尔属性 | 跳过页：不参与翻页、不进 PDF/PPTX/交接包，但仍留在文件里、仍能被数字键与侧栏直达 |

**`data-label` 不是装饰。** 舞台在收集页时给每一页写上 `data-screen-label="NN 标签"`（两位零填充序号 + 空格 + 标签），
然后：交接包的 `reference/` 用它当图片文件名（`01-Title.png`，非法字符换 `-`，封顶 48 字符）；
自检的逐页文本摘要按它分组；侧栏缩略图显示它。不写 `data-label` 时按
「作者原有屏名 → 页内第一个 `h1`–`h6` 的文本（截 60 字）→ `Slide N`」逐级回退。

### 写在舞台上的属性

| 属性 | 作用 |
|---|---|
| `width` / `height` | 设计画布尺寸（整数 px）。缺省 1920 × 1080 |
| `no-rail` | 关掉缩略图侧栏。**不写的话侧栏默认开启** |
| `noscale` | **导出通道专用，作者不要写**（见第 8 节） |

### CSS 变量

- **`--deck-letterbox`** —— 舞台底色，也就是幻灯片等比缩放后四周那圈边的颜色。缺省 `#0b0b0d`。
  写在 helmet 的 `:root` 里，浅色 deck 常配 `#ffffff` 或与首页底色同族。
- `--deck-w` / `--deck-h` / `--deck-k` / `--deck-rail` / `--deck-thumb-w` / `--deck-thumb-h` / `--deck-thumb-k`
  是舞台自己每次适配时写的几何量，**不要设它们**。

## 3. 逐页入场动画：`data-deck-active`

**舞台给当前页打 `data-deck-active`，翻走时摘掉。** 用它当选择器前缀，动画就只在这页翻到时播，
翻回去还会重播——CSS 入场动效走这条，别用 `IntersectionObserver`、别用 JS 计时器：

```html
<helmet><style>
  @keyframes riseIn { from { opacity:0; transform:translateY(28px) } to { opacity:1; transform:none } }
  [data-deck-active] .rise { animation: riseIn .5s cubic-bezier(.2,.7,.3,1) both }
  [data-deck-active] .rise:nth-child(2) { animation-delay:.10s }
  [data-deck-active] .rise:nth-child(3) { animation-delay:.20s }
</style></helmet>
```

（`[data-deck-active] .rise` 这种 class 钩子是 deck 允许写在 helmet `<style>` 里的少数几类之一——
入场动画天然内联不了。正文样式仍然内联 only，见 dc-authoring。）

三件必须知道的：

1. **打印 / 导 PDF 时舞台自动把每一页置成终态。** 打印时所有页同时上纸，如果只有当前页带
   `data-deck-active`，其余页会以动画起始态（通常 `opacity:0`）印出来。舞台在打印开始前给每一页
   （跳过页除外）补上这个属性，并注入一段定格样式把 `animation-duration` 归零、`animation-fill-mode:forwards`、
   `transition:none`，打印结束再原样还原。所以 **PDF 里不会出现半截动画或空白页**，你不用为打印写任何补丁。
2. **PPTX 与交接包的逐页截图也定格。** 那条链路不进 print 媒体，走的是「`goTo(i)` → 等两帧 → 截图」，
   本来会把动画拍在刚起步处（一页 `opacity:0` 起手的动效，导出的 PPTX 上就是一张空白）。
   导出器开截图前设的 `noscale` 现在同时触发同一块定格样式，摘掉即还原。
   **所以三条导出路（PDF / PPTX / 交接包）拿到的都是终态，入场动画可以放心写。**
3. 侧栏缩略图里的克隆体被强制置成 active 态，所以缩略图看到的是终态，不是一栏空白。

## 4. 演讲备注

两种来源，逐页合并：

1. **每页 `data-speaker-notes` 属性**（推荐）——存在即权威。
2. 文档里一个 `<script type="application/json" id="speaker-notes">` 的 JSON **字符串数组**，按页下标兜底。
   某页有属性就用属性，其余页仍然回落到数组。数组不是合法 JSON 只告警、不抛。

**备注真的会到用户手里**：导 PPTX 时宿主从舞台的 `notes` 取整表，写进每页的 notesSlide，
在 PowerPoint / Keynote 的备注栏里能直接读到（没写备注的页不建 notes 部件，整份没备注就完全不产生）。
所以备注要按「演讲者真会念的话」写，不是给自己留的 TODO。

## 5. 舞台给用户的东西

**键盘**（焦点在页面任意处即可，`noscale` 时全部静默）：

| 键 | 行为 |
|---|---|
| `→` / `PageDown` / `空格` | 下一页（连续跳过 `data-deck-skip`） |
| `←` / `PageUp` | 上一页（同上） |
| `Home` / `End` | 首页 / 末页 |
| `1`–`9` | 直达第 1–9 页；`0` = 第 10 页。**直达不跳过跳过页** |
| `R` | 回到第一页，**仅在底部覆层可见时生效**（刚动过鼠标才认这个键） |

- 带 `Cmd` / `Ctrl` / `Alt` 的组合键一律让给宿主与浏览器。
- 焦点在 `input` / `textarea` / `select` / `contenteditable` 里时**一个键都不吞**——幻灯里放输入框是安全的。

**鼠标点击幻灯片不翻页。** 点按翻页（左半 = 上一页，右半 = 下一页）只在**粗指针 / 触摸设备**上启用；
桌面有键盘和覆层按钮，再劫持点击会把页里的交互内容废掉。

**幻灯片里可以放真交互控件。** 即便在触摸设备上，点在 `a[href]`、`button`、`input`、`textarea`、`select`、
`label`、`summary`、`[role=button|link|checkbox|radio|tab|switch|slider|menuitem]`、`[contenteditable]`、
`[tabindex]`（≠ -1）上时，点按翻页自动让位——判定会穿透开放 shadow root，页里嵌自定义元素也认得出。

**底部覆层**：上一页 / `当前 / 总数` / 下一页 / 复位 / 切换侧栏。鼠标移动或翻页时浮现，静置约 2.4 秒淡出。

**左侧缩略图侧栏**：每页一张真缩略图 + 序号 + 屏名，当前页高亮，点击跳页，缩略图获得焦点后 `↑`/`↓` 步进，
跳过页显灰并打 `skip` 标。可拖右边缘调宽（150–400px，缺省 210px）。
**默认开启**，仅在这几种情况下不出现：写了 `no-rail`、`noscale`、演示模式、或舞台宽度 < 900px。

## 6. 页内脚本接口

`slidechange` 事件在舞台元素上派发，**冒泡且穿 shadow**，所以 `document` 上也听得到；首次挂载也派一次。

```js
document.addEventListener('slidechange', (e) => {
  const { index, previousIndex, total, slide, previousSlide, reason } = e.detail
  // index/previousIndex 从 0 起，首次 previousIndex 为 -1、previousSlide 为 null
  // reason: 'init' | 'keyboard' | 'click' | 'tap' | 'api'
})

const deck = document.querySelector('deck-stage')
deck.index          // 当前页序号（0 起）
deck.length         // 总页数（已过滤 template/script/style）
deck.designWidth    // 设计宽（数字）
deck.designHeight   // 设计高（数字）
deck.goTo(n)        // 直达第 n 页（0 起，越界钳到两端，不跳过 skip 页）
deck.next(); deck.prev(); deck.reset()
```

用途是「翻到第 5 页时启动那张图表的计数动画」这类。**别用它重造翻页**：绑 `←`/`→`、写页码、
写 `@page` / `@media print`、写缩放或 `zoom`、写 `:not(:defined)` 隐藏，全部是重复造轮子，
而且会和舞台自己那套打架。

## 7. 运行时已经替你做了什么（别再写一遍）

- **每页的定位与尺寸**：舞台把每一页绝对定位铺满设计画布，强制覆盖 `position` / `left` / `top` / `right` /
  `bottom` / `width` / `height` / `margin`，并置 `box-sizing:border-box`。页元素上写这几个属性没有意义，
  只会误导后来改稿的人。**页内的排版照常自己写**（flex / grid / padding / 字号全归你）。
- **等比缩放居中**：按 `min(容器宽/设计宽, 容器高/设计高)` 缩放，四周留底色边，永不裁切、永不变形，
  容器尺寸变化自动重算。480px 宽的预览面板和 4K 投影用的是同一份稿。
- **翻页与导航**：键盘、触屏点按、覆层按钮、缩略图侧栏、程序式 API，全都作用在同一个「当前页」状态上。
- **页码**：覆层里的 `当前 / 总数` 自动维护。不要自己在页脚画页码。
- **打印几何**：`@page { size: 设计宽px 设计高px; margin:0 }` 注入到 document 层并压过你后写的任何 `@page`，
  逐页强制分页且末页不会多出一张空白纸，跳过页不出纸，底色/背景强制打印（`print-color-adjust:exact`）。
  打印期还会把祖先容器的 `height`/`overflow` 临时中和，免得 N 页被压成一屏。
- **打印动画定格**：见第 3 节第 1 条。
- **就绪握手**：舞台挂载时给自己打 `data-fonts-pending`，网络字体就绪或 2 秒封顶后自摘；导出链路等这个信号。
- **流式增量收页**：页是一页一页流出来的，舞台自己观察子节点与 `data-label` / `data-deck-skip` 变化重收集。
- **缩略图代价**：侧栏没露面就一张克隆都不做；克隆里的 `iframe` / `video` / `audio` / `object` / `embed`
  会被换成中性占位块，不会为了一张缩略图再拉一次媒体。

## 8. 约束与静默失败

- **超出设计画布的内容被静默裁掉。** 每页强制 `overflow:hidden`。「幻灯片看着少了一行字 / 最后一个要点没了」
  基本只有这一个解释——不是渲染坏了，是你这页写多了。发现少内容先数字号和 padding，别去改舞台。
- **翻走的页不卸载，只 `visibility:hidden`。** 好处是视频进度、`iframe`、表单输入、组件内部状态全都保住，
  翻回去东西还在。反面是**隐藏页里 `autoplay` 的音视频照样在响**——deck 里放自动播放媒体一定要显式控制。
- **侧栏默认吃掉左侧约 210px。** 缩放比是按「容器宽减去侧栏宽」算的，所以带侧栏时幻灯片比你以为的小。
  做满屏观感（或产物要被嵌进窄面板）就写 `no-rail`。舞台宽度 < 900px 时侧栏本来就不出现。
- **舞台霸占整个视口**（`position:fixed; inset:0`）。因此：`<deck-stage>` / `<x-import>` 外面**不能再放页头页脚
  或任何别的内容**，放了也看不见；一份产物只放一个舞台。
- **`noscale` 是导出通道专用。** 导出器设上它以后舞台零缩放、左上角对齐、隐藏全部 chrome、键盘与点按
  全部静默、入场动画定格在终态。作者写了就会看到「幻灯片跑到左上角还溢出、什么都点不动、动画不播」。
- **网络字体只等 2 秒。** 超时舞台就宣布就绪，导出会用回退字体出片。字体是版式命门的 deck，
  要么接受回退字体、要么别把字重/字宽压得太死。
- **数字键与 `goTo` 不跳过 `data-deck-skip`**，只有 `←`/`→`/空格 这类翻页型导航跳。跳过页在自检的文本摘要里
  带 `[跳过页·不进导出]` 前缀——看到它是正常的，不要以为自己漏写了一页去补稿。
- **侧栏宽度记不住是正常的。** 预览 iframe 没有同源权限，`localStorage` 连读都会抛；舞台已经全程兜住，
  丢的只是这条偏好。
- **文本重叠自检只覆盖当前页。** 重叠检测跳过 `visibility:hidden` 的元素，而自检截图停在第 1 页——
  后面几页的排版重叠**检不出来**，只能靠逐页文本摘要 + 自己算尺寸。

## 9. 版式与演示纪律

- **先写完整的标题序列再动版式。** 选一种语法风格（短名词短语 或 短陈述句）全程统一；
  只读标题应当能看懂整场演讲的脉络，像一本书的目录。
- **版式变量先定死。** helmet 的 `:root` 里写投影级刻度（`--type-*`、`--pad-*`、`--gap-*`），
  正文一律 `var(…)` 引用。用户改一个数字就能缩放全 deck。
- **尺度：1920×1080 上任何文字 ≥ 24px、标题 ≥ 48px。** 网页默认密度（14–16px 正文）在投影上是不可读的；
  觉得「不够大方」就是不够大。用户说「36pt」指磅：px = pt × 1.333。
- **别往页面上堆字**（最常见的失败）。堆字之前先问：这页是不是更该是表格、图示、引语、或一个大数字。
  追求页型多样：全图页、换底色页、大数字页、引语页、表格页、少字页。
- **静态 HTML，不用循环生成页。** 三个要点就写三个块——重复本身就是让用户能单独改第二条的机制；
  `sc-for` 渲染出来的用户点不进去改不了。
- **平行结构**：章节页长得一样，重复元素位置一致，同层级字号一致。
- 除非用户要求，不用 emoji、不自画插图；图标用 Unicode 字形（见 dc-authoring 的 token 预算纪律）。
- **标题是本页的章节名，不是金句。** 不写「不是 X，而是 Y」「魔法时刻」这类演讲者式判词——
  它读起来像 AI 写的，而且抢掉了正文该说的话。

## 10. 交付前自检

跑一次 `render_artifact`，然后逐条核：

1. **页数对不对** —— 摘要里的 frame 条数 = 你想要的页数。多出一条通常是多套了一层包裹 `<div>`；
   少一条通常是某页写进了别的元素里。
2. **逐页正文都在** —— 摘要是**逐页可信**的（舞台专门为自检开了逐页可读态），每一页的标题与关键数字
   都该出现在对应的 `NN 标签` 条目里。某页正文明显比你写的短 = 内容超框被裁了。
3. **屏名成立** —— `NN 标签` 里的标签就是将来交接包 `reference/` 的文件名。出现 `Slide 7` 说明这页
   既没写 `data-label` 也没有标题，补上。
4. **跳过页** —— 只有你有意跳过的那几页带 `[跳过页·不进导出]`。
5. **控制台干净** —— 尤其别放过 `hint-size` 缺失告警和空穴 never resolved。
6. **看截图时用幻灯片构图规则，不是网页直觉**：`align-items:flex-start` + 下三分之一留白是**正确的**
   幻灯片构图。想把 flex-start 改成 center 的冲动是网页反射，忍住。
7. 要导 PPTX 的：确认 `from="./deck-stage.js"` 在文件里，且没有哪一页的核心信息只在入场动画终态才可见。
