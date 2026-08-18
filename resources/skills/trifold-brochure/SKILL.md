---
name: trifold-brochure
description: 三折页宣传册——一张横版纸的正反两面、每面三栏、折成三折的印刷品。核心难点是折序：栏在纸上的位置决定它在折好后什么时候被读到，封面是外侧最右一栏。含骨架（含把分页壳加载进来的那一步）、三栏几何与折线余量、cqw/cqh 与物理单位的分工、印刷纪律与交付话术。判据：用户要三折页 / 折页宣传单 / brochure 时必读；doc-page 的公共事实（三种模式、属性全表、静默失败）在 doc-design 技能里，先读那份。
---

# 三折页（doc-page 横版显式分页）

一份三折页 = **一张横版纸、正反两面、每面三栏**，交付物是一个 `.dc.html`，
打印出来恰好 2 页。纸张、`@page`、分页几何由预制件 `doc-page` 持有，**你不写打印 CSS**。

三种模式的判定、纸张与边距属性全表、单位规则、导 PDF 的真实行为、通用静默失败清单
见 **doc-design** 技能；DC 文件格式本身见 **dc-authoring**。本篇只写折页自己的事。

---

## 1. 骨架（可直接抄——`doc-page.js` 那一行不能少）

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
  <style>
    doc-page:not(:defined){ visibility:hidden }
    @media print{ .fold-guide{ display:none } }
  </style>
</helmet>

<doc-page orientation="landscape">

  <section class="page" data-screen-label="外侧" style="position:relative; display:grid; grid-template-columns:repeat(3,1fr); background:#f7f4ec; color:#1d2b26; font-family:Optima,'Avenir Next','PingFang SC',system-ui">
    <div style="padding:6cqh 4cqw">…内折翼…</div>
    <div style="padding:6cqh 4cqw">…封底：联络与事务信息…</div>
    <div style="padding:6cqh 4cqw">…封面：一个承诺…</div>
    <div class="fold-guide" style="position:absolute; top:0; bottom:0; left:33.333%; border-left:1px dashed rgba(0,0,0,.25)"></div>
    <div class="fold-guide" style="position:absolute; top:0; bottom:0; left:66.667%; border-left:1px dashed rgba(0,0,0,.25)"></div>
  </section>

  <section class="page" data-screen-label="内侧" style="position:relative; display:grid; grid-template-columns:repeat(3,1fr); background:#fff; color:#1d2b26; font-family:Optima,'Avenir Next','PingFang SC',system-ui">
    <div style="padding:6cqh 4cqw">…第一拍…</div>
    <div style="padding:6cqh 4cqw">…第二拍…</div>
    <div style="padding:6cqh 4cqw">…第三拍…</div>
  </section>

</doc-page>
</x-dc>
</body>
</html>
```

三处最容易漏、漏了就是废品：

1. **helmet 里的 `<script src="./doc-page.js"></script>`** —— 没有它 `<doc-page>` 永远不会升级成
   组件，纸张盒、`@page`、三栏几何全部落空，交付物只是一段裸 HTML。这个 `src` 不走网络：
   宿主扫到这个引用就把预制件源码内联进文档，所以路径必须一字不差。
2. **`<x-dc>` 与 `<helmet>`** —— 整页 HTML 交付物必须是 Design Component，`create_artifact`
   会直接拒收没有 `<x-dc>` 的整页 HTML；`<helmet>` 必须是模板的第一个子节点。
3. **`class="page"` 的 `<section>` 必须是 `<doc-page>` 的直接子元素** —— 中间包一层 div
   就退回连续流文档，两面变成一条长纸，而且不报错。

`orientation="landscape"` 给横版（letter 横版 = 11×8.5in）；公制读者加 `size="a4"`（297×210mm）。
`position:relative` 要自己写（绝对定位的折线参考线需要参照）。
`data-screen-label` 让自检摘要与交接包截图**逐面**分开给你——两面的产物强烈建议写。

---

## 2. 栏序即折序（这个形态唯一真正的难点）

一栏的位置决定它在折好后**什么时候被读到**。按标准的向内卷折（右栏先折进去）：

- **外侧（第一个 `.page`，印在纸的正面）** 三栏从左到右是：
  **[内折翼] [封底] [封面]** —— **封面在最右**。
- **内侧（第二个 `.page`，印在纸的背面）** 三栏从左到右就是完全展开后的整版阅读顺序。

读者的实际顺序：

1. 拿到手看到的是**封面**（外侧最右栏）。
2. 掀开封面，先露出来的是**内折翼**（外侧最左栏）。
3. 再展开，看到内侧三栏的整版。
4. 翻到背面才是**封底**（外侧中间栏）。

内容照这个顺序写：封面给一个承诺（大标题 + 一句话 + 一个视觉锚点，别塞正文）；
内折翼承接封面，用一小段把话接住；内侧三栏是三个可独立读完的节拍，同时又要横着连成一版；
封底放联络方式、地址、二维码、版权这类事务信息。

**核对法**：印出来对着光看，内侧最左栏应该正好在封面背后。不是的话，是打印的翻页方式选错了（§5）。

---

## 3. 三栏几何与折线余量

`.page` 是尺寸容器（组件自动给的），纸内直接用容器查询单位：`1cqw` = 纸宽的 1%，
`1cqh` = 纸高的 1%。三等栏 = `grid-template-columns:repeat(3,1fr)`，每栏 `33.333cqw` 宽。

**统一口径（与 flier 技能同一条）**：

- **版面几何用 `cqw` / `cqh`** —— 分区、定位、留白、字号。letter ↔ A4 换纸时比例自动跟着走。
- **有物理下限的量用物理单位**（`pt` / `mm` / `in`）—— 最小字号、发丝线宽、折线余量。
  这些下限本身是物理的，写成比例就守不住。
- **`vh` / `vw` 一律不用**（跟窗口不跟纸）。

**折线余量**：所有内容距每条折线和纸边 ≥`0.375in`（≈9.5mm）。换算成比例，
横版 letter 是 `3.5cqw` / `4.5cqh`，横版 A4 是 `3.3cqw` / `4.6cqh`——
**每栏左右各留 ≥`4cqw`、上下各留 ≥`5cqh` 的 padding**，两种纸都安全。

**别做精确的折翼数学**。向内卷折时被折进去的那一栏实际要窄约 1/16in（1.6mm），
但这个差量取决于纸张厚度与折页机，算得再准也对不上——用足够大的安全内边距把它吃掉。

**最小字号**：横版纸更矮，`1cqh` 比纵版小（横版 letter 的 `1cqh` ≈ 6.1pt，横版 A4 ≈ 6.0pt）。
所以**正文 ≥`1.6cqh`**（两种纸上都过 9pt 线），小字注释 ≥`1.5cqh`，
栏标题按一臂距离阅读的尺度放大（`4–6cqh`）。

**折线参考线**写在 `.page` 里当普通绝对定位元素画，外观照常内联写；
只有"打印时隐藏"这条规则内联写不了——给参考线一个 class 钩子，在 helmet 的 `<style>` 里
写 `@media print{ .fold-guide{ display:none } }`（见 §1 骨架）。"屏幕辅助元素在打印时隐藏"
是内容级规则，可以写进 helmet；**分页几何仍然一行都不许写**。

---

## 4. 运行时已经替你做了什么 / 静默失败

`.page` 一旦是直接子元素，组件就给了它：纸张尺寸（`!important` 钉死，你写 width/height 无效）、
`container-type:size`、`overflow:hidden`、白底、屏幕纸卡阴影（打印自动去掉）、页间分页符
（两个 `.page` 恰好 2 页，末页不多出空白页）、`@page{size:…;margin:0}`、`body{margin:0}`、
颜色保真、断页卫生。**这些都不用你写。**

会踩且不报错的：

1. **`.page` 不是直接子元素** → 退回连续流，两面变一条长纸。
2. **`slot="header"` / `slot="footer"` 在这个模式下不存在** → 写了不渲染、不报错。
   页眉页脚就在栏里当普通元素画。
3. **cq 单位只在 `.page` 里有意义**，写到外面会退化成视口单位——屏幕上勉强能看，打印尺寸全错。
4. **溢出即裁切**：超出纸面的内容不会流到第三页，直接没了。每一面都要按"填满且不溢出"设计。
5. **出血底色写在 `.page` 上**，写在 `body` 上打印期会被强制成白底，屏幕看着对、PDF 里没了。
6. **`margin` 属性在这个模式下恒为 0**（全出血），白边由栏自己的 padding 负责。
7. **`size` 只认 `letter` / `legal` / `a4`**，别的值静默落回 letter。
8. **只有第一个 `doc-page` 持有 `@page`**——两面必须写在**同一个** `doc-page` 里，
   拆成两个 `doc-page` 会让第二个的纸张设置失效。

---

## 5. 印刷纪律与交付话术

- 实色块与矢量形状印得最稳。**避免大面积深色满铺**（费墨、折线处易裂），
  **避免 0.5pt 以下的发丝线**（印不出来或断续）。
- 跨折线的图形要留出余量：横跨两栏的色块会在折线处对不齐，除非它本来就是整面通铺。
- 图标用 Unicode 字形，不画 SVG（token 贵，印出来也不更好）；
  字体走系统字体栈，**不要写网络字体 `<link>`**（理由见 dc-authoring 的「字体」一节）。
- 真实照片的位置用 `image-slot` 占位（用法见 flier 技能），别画灰矩形交差。

**告诉用户怎么印**：双面打印、**短边翻页**（flip on short edge）、缩放 **100%（实际大小）**，
先把右栏向内折、再把左栏折过来。先印一张对着光核对两面栏位是否对齐，再印全量。

---

## 6. 交付前自检

1. `render_artifact(id)` 看告警、文本重叠检测与截图。
2. **自检截图是 1280×900 的视口截图**，横版纸一屏放得下宽度但两面拍不全——
   靠 `data-screen-label` 拿到的逐面文本摘要核对第二面。
3. 目视核对：三栏是否等宽、内容有没有压到折线余量里、有没有被纸边裁掉、
   相邻文本的包围盒有没有相交。
4. 内容核对：封面在外侧最右栏、封底在外侧中间栏、内折翼在外侧最左栏（§2）。
5. 要成品文件就 `export_artifact(format='pdf')`，落 `~/.openpipal/outputs/`；
   PDF 应该是 2 页横版，页数不对说明 `.page` 的结构错了。
