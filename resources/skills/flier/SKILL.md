---
name: flier
description: 单页印刷品——传单、海报、公告、证书、奖状。固定纸张、一页（或正反两页）画满、溢出即裁切，走 doc-page 的显式分页模式。含骨架、纸内尺寸语言（cqw/cqh 与物理单位的分工）、隔着房间三秒可读的层级纪律、可直接化用的版面手法、image-slot 图片位。判据：交付物是"一张纸就是全部内容"的印刷品时必读；doc-page 的公共事实（三种模式、属性全表、静默失败）在 doc-design 技能里，先读那份。
---

# 单页印刷品（doc-page 显式分页）

一张要打印出来贴墙、发到手上或裱起来的纸。特征是**页数确定、内容必须填满这张纸、
超出的部分会被裁掉**——不是可以往下流的文档。

纸张、`@page`、断页几何全部由预制件 `doc-page` 持有，**你一行打印 CSS 都不写**。
三种模式的判定、纸张与边距属性全表、单位规则、导 PDF 的真实行为、通用的静默失败清单
在 **doc-design** 技能里，本篇只写这个形态自己的事。DC 文件格式本身见 **dc-authoring**。

---

## 1. 骨架（可直接抄）

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

<doc-page size="a4">
  <section class="page" data-screen-label="正面"
           style="position:relative; background:#0f2f2b; color:#f4f1e8; font-family:Optima,'Avenir Next','PingFang SC',system-ui">
    <!-- 整张传单：绝对定位分区 + cqw/cqh 尺寸 -->
  </section>
</doc-page>
</x-dc>
</body>
</html>
```

- **`class="page"` 的 `<section>` 必须是 `<doc-page>` 的直接子元素**：中间包一层 div，
  纸张盒、裁切、容器查询单位就全没了，而且不报错。
- 一个 `.page` = 一张纸。双面传单写两个 `.page`，打印对话框就恰好是 2 页。
- `size="a4"` 给公制读者，默认 letter；海报要非标准尺寸用 `width` / `height`（如 `width="18in" height="24in"`）。
- `position:relative` 要自己写（组件不设 position，绝对定位的子元素得有参照）。
  `data-screen-label` 可选，写了自检与交接包会**逐页**给你摘要和截图。

---

## 2. 纸内的尺寸语言

`.page` 已经是尺寸容器（组件自动加的），所以纸内**直接就能用容器查询单位**：
`1cqw` = 纸宽的 1%，`1cqh` = 纸高的 1%。

**统一口径（与 trifold-brochure 技能同一条）**：

- **版面几何用 `cqw` / `cqh`** —— 分区、定位、留白、圆角、字号。换纸张（letter ↔ A4）时
  整套比例自动跟着走，不用重排。
- **有物理下限的量用物理单位**（`pt` / `mm` / `in`）—— 正文最小字号、发丝线宽度、
  出血与折线余量。这些下限本身是物理的，写成比例就守不住。
- **`vh` / `vw` 一律不用**：它们跟窗口走，不跟纸走，屏幕上看着对、打印全错。

换算（用来核对最小字号）：

| 纸张 | `1cqw` | `1cqh` | 9pt 正文约等于 |
|---|---|---|---|
| letter 纵版 8.5×11in | 6.1pt | 7.9pt | `1.15cqh` |
| A4 纵版 210×297mm | 6.0pt | 8.4pt | `1.07cqh` |

实用下限：**正文 ≥`1.2cqh`**（两种纸上都过 9pt），次要小字 ≥`1cqh`，
统治性大标题落在 `7–10cqh`。

布局骨架用 `position:absolute` + cqw/cqh 分区最稳——纸是固定盒子，绝对定位不会被内容长度推歪。

---

## 3. 运行时已经替你做了什么

`.page` 一旦是直接子元素，组件就给了它：

- **纸张尺寸**（用 `!important` 钉死——你写 `width` / `height` 无效）
- **`container-type:size`**（cqw/cqh 可用，不用自己写）
- **`overflow:hidden`**（屏幕与打印都裁切）、白底、屏幕上的纸卡阴影与圆角（打印时自动去掉）
- **页间分页符**：每个 `.page` 后一个分页，最后一页不多出空白页
- **`body{margin:0}`、颜色保真（`print-color-adjust:exact`）、`img{max-width:100%}`、
  断页卫生**（`figure`/`pre`/`img`/`svg`/`blockquote`/`tr`/`thead`/`tfoot` 不被切开）
- **`@page{size:…;margin:0}`**：显式分页模式一定钉纸张，导 PDF 时 CSS 说了算

所以不要写：`@page`、`@media print` 的分页规则、`.page` 的 width/height/`container-type`/
`overflow`、`body{margin:0}`、`print-color-adjust`、自己搭的"纸卡 div"。

---

## 4. 约束与静默失败

1. **`.page` 必须是直接子元素**（见 §1）。包一层就退回连续流文档，纸没了、裁切没了、cq 单位没了。
2. **`slot="header"` / `slot="footer"` 在这个模式下不存在**——写了不渲染也不报错。
   传单的页眉页脚就在 `.page` 里当普通元素画。
3. **cq 单位只在 `.page` 里有意义**。写到 `.page` 外面（比如 `doc-page` 的兄弟元素上），
   没有尺寸容器可依，它会退化成视口单位——屏幕上勉强能看，打印出来尺寸全错。
4. **溢出就是没了**：多出纸面的内容不会流到第二页，直接被裁掉，不报错。
   所以内容要**主动填满**这张纸，并且在 letter 与 A4 上都成立（换纸时高宽比会变，
   全 cqw/cqh 的版面才不会散）。
5. **整页出血底色写在 `.page` 上**（内联 `background` 压得过组件的默认白底）。
   写在 `body` 上屏幕看着对，打印期 body 被强制成白底，一导 PDF 就没了。
6. **不要用 `position:fixed`**：打印时它会在每一页重复出现一次。
7. `size` 只认 `letter` / `legal` / `a4`，别的值静默落回 letter；`margin` 在这个模式下恒为 0
   （全出血），写了也不生效——想要白边自己在 `.page` 里留 padding。

---

## 5. 三秒可读（这类交付物的唯一硬指标）

传单是隔着房间、路过一瞥被读到的。层级不成立，配色再好也白做。

- **一个统治性元素**：通常是 ≤6 个词的主标题，大到跨屋能读（`7–10cqh`）。其余一切明显从属，
  第二层不许和它抢。
- **五 W 聚成一块可扫读的组**：什么事 / 什么时候 / 在哪 / 多少钱 / 怎么行动（一条 URL、
  一个电话、一张二维码）。**不要把它们散进正文段落**——路人不读段落。
- **删到层级一眼无误为止**：慷慨的留白胜过多出来的两行文案。
- **强对比、平色块、几何形状**优先于照片和渐变；正文近黑配浅底，或浅字配深底，中间调最容易糊。
- **灰度自检**：把整张想象成黑白复印件，层级还成立才算过——这也是它真正会被复印的样子。

---

## 6. 可直接化用的版面手法

都是纯 CSS、零图片依赖、token 便宜的做法。换配色和形状适配主题，别照抄数值。

**斜切色区**——两个色区的交界不用水平直线，给下方色区一个 `clip-path`：

```html
<div style="position:absolute; inset:38cqh 0 0; background:#f4f1e8;
            clip-path:polygon(0 6cqh, 100% 0, 100% 100%, 0 100%)"></div>
```

**三卡信息条**（五 W 聚拢的标准形）——`display:grid; grid-template-columns:repeat(3,1fr)`，
每卡白底 + 圆角 + 不同颜色的 `border-top` 区分语义；卡内三层：小号宽字距 eyebrow →
大号粗体主值（`white-space:nowrap` 防折行）→ 浅灰一行补充。

**胶囊徽章**——`display:inline-flex; border-radius:999px` + 半透明白底 + 1px 白描边，
放日期或"限 30 人"这类限定语。**图标圆**——列表每项前一个 `border-radius:50%` 实心圆，
里面 flex 居中一个 Unicode 字形（◎ ⊞ ⇉ ◈ ⚐）；不要画 SVG 图标，token 贵且印出来未必更好。

**二维码占位**——真码没拿到之前用 CSS 画：
`background:repeating-conic-gradient(#0f2f2b 0 25%, #fff 0 50%) 0 0/12% 12%`，
四角压三个实心方块当定位点，等用户给了真码换成 `<img>`。
**撕角条**（用户要"可撕联系方式"才加）——底边一排等宽窄格，格间 `border-left:1px dashed`，
格内文字 `writing-mode:vertical-rl` 竖排放电话。

**配色克制**：一个主色（大面积）+ 一个强调色（标题或徽章）+ 一个点缀，就这三个。
字体走系统字体栈、两款配对（一款有性格的展示体给标题，一款界面无衬线给正文），
**不要写网络字体 `<link>`**——理由与可选的几组栈见 dc-authoring 的「字体」一节。

---

## 7. 图片位（用户要放真实照片的地方）

需要真实照片而现在没有的位置，不要画灰色矩形交差——用预制件 `image-slot`，
用户在预览里把图拖进去就补齐，且补齐是持久的（预览重开、导 PDF、导独立 HTML 都还在）。

```html
<script src="./image-slot.js"></script>   <!-- helmet 里，与 doc-page.js 并列 -->
…
<image-slot id="hero" shape="rounded" fit="cover" placeholder="主视觉 / hero shot"></image-slot>
```

- `id` **页内唯一**，它就是持久化的键。
- `shape`：`rect` / `rounded`（默认，`radius` 可调，默认 12px）/ `pill` / `circle`；
  `mask` 收任意 `clip-path`；`fit`：`cover`（默认）/ `contain`。
- 槽位大小由外面的容器决定——包一个 cqw/cqh 定尺寸的 div，`image-slot` 铺满它。
- 用户**随消息发过的图**优先直接引用 `src="uploads/…"`（见 dc-authoring 的用户图片一节），
  `image-slot` 是给"图还没有"的位置用的。

---

## 8. 交付前自检

1. `render_artifact(id)` 看告警、文本重叠检测与截图。
2. **自检截图是 1280×900 的视口截图，比一张纸矮**：纵版 letter 只拍得到上面 85% 左右，
   页底看不见是正常的。写了 `data-screen-label` 的话摘要会逐页分开，用它核对第二页的内容。
3. 目视四件事：有没有被裁掉的内容、相邻文本的包围盒有没有相交、灰度下层级是否成立、
   五 W 是不是聚在一块。
4. 双面传单：两面都要填满，第二面不能只有半屏内容。
5. 要成品文件就 `export_artifact(format='pdf')`，落 `~/.openpipal/outputs/`。
