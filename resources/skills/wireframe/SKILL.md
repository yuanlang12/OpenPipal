---
name: wireframe
description: 线框图——早期广度探索：先访谈问清楚，然后一口气给 3–5 个结构完全不同的低保真方案（手绘感、灰阶、占位块），把注意力逼回"东西怎么摆、流程怎么走"，不谈视觉细节。判据：taskType=线框，或用户说"先铺开看看有哪些做法"「结构上还有别的思路吗」时必读。地基是 dc-authoring 的画板模式那节。下游是 hi-fi-design：用户选定结构方向后转过去升保真（那份管设计上下文与方向编排）。
---

# 线框图（wireframe · 广度优先）

这份技能管**设计空间的铺开**：一次给出几个**结构互不相同**的走法，让用户在被视觉细节绑架之前先选结构。
打磨、品牌、配色统统不在这一步——那是 hi-fi-design 的事。格式与画板模式的形状约束在 dc-authoring，不重复。

## 1. 先访谈

线框是**问题问对了才有价值**的产物。至少覆盖：解决什么任务、谁在用、用完之后他要做什么；核心流程几步、
哪一步最重要、哪一步最容易被放弃；桌面还是移动、信息密还是疏；有没有必须出现的模块（列表 / 表单 / 图表 / 媒体）。
**问任务与流程，不问视觉**——这一步别问主色和字体，用不上，问了还会让用户以为现在要定视觉。

## 2. 骨架：一份能直接跑的低保真画板稿

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
  <meta name="design_doc_mode" content="canvas">
  <style>*{ box-sizing:border-box } html,body{ margin:0 }</style>
</helmet>
<!-- 方案 1A：帧 = 根的直接子元素，绝对定位 -->
<div style="position:absolute; left:80px; top:96px; width:1040px">
  <div style="font:400 15px/1 'Bradley Hand','Chalkboard SE','Segoe Print','Comic Sans MS','Kaiti SC',STKaiti,cursive; color:#5b554c; margin-bottom:12px">1A · 单栏时间线</div>
  <div data-screen-label="1A 单栏时间线" style="background:#fffdf9; border:2px dashed #3a352e; border-radius:6px; padding:28px 30px; font:400 15px/1.6 'Bradley Hand','Chalkboard SE','Segoe Print','Comic Sans MS','Kaiti SC',STKaiti,cursive; color:#3a352e">
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #3a352e; padding-bottom:12px; margin-bottom:22px"><span style="font-size:19px">Logo</span><span>导航 · 导航 · 导航</span></div>
    <!-- 图片位：矩形 + 两条对角线（两层 linear-gradient，内联写得下，不必写 SVG） -->
    <div style="height:200px; border:2px dashed #8a8378; border-radius:4px; margin-bottom:20px; background:linear-gradient(to top right, transparent 49.5%, #c9c3b8 49.5%, #c9c3b8 50.5%, transparent 50.5%), linear-gradient(to bottom right, transparent 49.5%, #c9c3b8 49.5%, #c9c3b8 50.5%, transparent 50.5%)"></div>
    <!-- 正文占位：灰条，不是 lorem -->
    <div style="height:12px; border-radius:6px; background:#ddd7cc; margin-bottom:9px"></div>
    <div style="height:12px; border-radius:6px; background:#ddd7cc; width:64%; margin-bottom:24px"></div>
    <div style="display:inline-block; border:2px solid #3a352e; border-radius:20px; padding:8px 20px">主操作</div>
  </div>
</div>
<div style="position:absolute; left:1280px; top:96px; width:1040px">…方案 1B：结构完全不同的第二种走法…</div>
<div style="position:absolute; left:2480px; top:96px; width:1040px">…方案 1C：第三种…</div>
</x-dc>
</body>
</html>
```

坐标算法：`left = 80 + i × (帧宽 + 160)`，同一轮共用一个 `top`。

## 3. 广度纪律：3–5 个，结构要真的不同

同一个方案调三次间距不算三个方案。判据——**把两个方案的文字全抹掉，剩下的框子还认得出区别吗？**
一次至少跨两个维度：

| 维度 | 走法举例 |
|---|---|
| 导航模式 | 顶部横向 / 左侧固定栏 / 无导航单流 / 底部标签页 |
| 信息层级 | 全部平铺 / 概览+详情两层 / 渐进展开 |
| 流程步数 | 一屏搞定 / 分步向导 / 边填边预览 |
| 内容排布 | 单栏时间线 / 双栏对照 / 卡片网格 / 表格 |
| 入口位置 | 主操作在顶 / 在底 / 常驻悬浮 / 藏进列表项 |

**别在这一步做视觉变体**（换配色、换圆角、换阴影）——那是 hi-fi-design 的维度，在这里做只会让用户
误以为现在在选视觉。

## 4. 低保真在我们这儿怎么落地

- **手绘感字体走系统字体栈**（不拉网络字体，理由与口径见 dc-authoring 的字体一节）：
  `'Bradley Hand', 'Chalkboard SE', 'Segoe Print', 'Comic Sans MS', 'Kaiti SC', STKaiti, cursive`
  ——前两个 macOS 自带、中间两个覆盖 Windows、后两个给中文兜底、末尾 `cursive` 是最终回退。**版式不许
  依赖其中任何一款**：行高、宽度、换行回退到 `cursive` 时也要成立。
- **灰阶 + 一个强调色**：墨色 `#3a352e`、占位灰 `#ddd7cc`、纸底 `#fffdf9`；强调色只用在"这一步是重点"的一两处。
- **虚线边框**（`border:2px dashed`）是"这里还没定"的通用语言，容器与图片位都用它。
- **正文用灰条占位、不写 lorem**；但**按钮、导航项、标签写真实文字**——它们是结构的一部分，写成灰条就读不出流程。
- **图标用 Unicode 字形**（◎ ⊞ ⇉ ◈ ⚐ ▤ ▲ ●）配字号颜色，**不要用 emoji 当图标**，也别写内联 SVG（吃预算）。
- 要"歪一点"的手绘感就给容器一点 `transform:rotate(-.3deg)`，克制着用；它不影响宿主量帧宽。

## 5. 方案怎么摆、怎么编号

**画板模式并排**：一个方案一个绝对定位的帧，横向排开，`left` / `top` 全部 ≥ 0——形状约束
（帧必须是根的直接子元素、不许包 wrapper、间距纪律）见 dc-authoring 的画板模式那节。

编号用与 hi-fi-design **同一套**：`{轮次数字}{大写字母}`，第一轮 `1A`–`1E`，第二轮 `2A`…编号永久稳定；
新一轮向下另起一行，旧轮坐标一个字不改。编号同时写在**帧上方的可见标签**与 **`data-screen-label`**。
用户在聊天里直接打编号回指（"1C 的分步流程配 1A 的导航"）；**不要建 `#编号` 锚点互链**，在我们的预览沙箱里点了不跳（见 §7.1）。

## 6. 方案太宽时：标签页切换

默认永远是并排。只有**单个方案宽到并排后连单帧适配都读不清**（帧宽超过 ~1600px）或方案数超过 5 时才换——
这是线框里唯一需要逻辑块的地方：

```html
<div style="position:absolute; left:80px; top:96px; width:1440px">
  <div style="display:flex; gap:10px; margin-bottom:16px">
    <sc-for list="{{ tabs }}" as="tab" hint-placeholder-count="3">
      <button onClick="{{ tab.pick }}" style="padding:8px 18px; border:2px solid #3a352e; border-radius:18px; cursor:pointer; background:{{ tab.bg }}; color:{{ tab.fg }}; font:400 15px/1 'Bradley Hand','Chalkboard SE',cursive">{{ tab.name }}</button>
    </sc-for>
  </div>
  <sc-if value="{{ showA }}" hint-placeholder-val="{{ true }}"><div data-screen-label="1A 单栏时间线" style="…">…</div></sc-if>
  <sc-if value="{{ showB }}" hint-placeholder-val="{{ false }}"><div data-screen-label="1B 双栏对照" style="…">…</div></sc-if>
</div>
</x-dc>

<script type="text/x-dc" data-dc-script>
class Component extends DCLogic {
  state = { active: 0 }
  renderVals() {
    const a = this.state.active
    const names = ['1A 单栏时间线', '1B 双栏对照', '1C 分步向导']
    return {
      tabs: names.map((name, i) => ({
        name, bg: i === a ? '#3a352e' : 'transparent', fg: i === a ? '#fffdf9' : '#3a352e',
        pick: () => this.setState({ active: i })
      })),
      showA: a === 0, showB: a === 1, showC: a === 2
    }
  }
}
</script>
```

**代价要知道**：`sc-if` 为假时那一支**根本不进 DOM**——没被选中的方案在文本摘要里没有一条、
在交接包里没有一张截图，对自检和导出完全隐形。所以能并排就并排。

## 7. 约束与静默失败

1. **`#锚点` 与 `:target` 在预览里不通。** 预览是无 `<base>` 的 srcdoc 沙箱，`href="#1b"` 解析到宿主页面地址上：实测点了 iframe 不滚动、`:target` 不命中、片段落到宿主文档的 URL 上。编号只用来"说"。
2. **所有 `left` / `top` 必须 ≥ 0**：逐帧截图的裁剪框把负坐标钳到 0，越界那一侧连同宽度直接被裁掉。
3. **漏写 `data-screen-label`** → 文本摘要退成整页一条、自检没法逐方案核对、交接包从逐帧截图退成整页一张。
4. **自检截图只有一屏**（1280×900 视口截图、无宿主缩放），并排的方案大多不在这一屏里——核对以逐屏文本摘要为准。
5. **上限 60 帧**：文本摘要与逐帧截图都封顶 60。
6. **文本重叠检测会拦你**：两段文字的包围盒相交超过对方面积的 25% 就报错并要求修完再交——手绘感的歪斜与负边距最容易触发，`transform:rotate()` 用小角度。
7. **正文只用内联 `style`**；`<style>` 只能待在 helmet 里，正文里的会被丢弃并告警。
8. **流式期间逻辑块还没上场**，空穴全是灰色占位微光（标签页方案生成中是一排灰条，正常）——也因此**静态文案绝不要走空穴**，只有 `tab.bg` 这种真随状态变的值才配用。
9. **一份产物只写一个 `<x-dc>`**，闭合之后只允许那一个逻辑块 script；写在外面的内容空穴与事件全死。

## 8. 自检与转交

通用自检（`render_artifact`、告警对照表）照 dc-authoring 跑。线框额外核三条：逐屏摘要里**方案数与编号**对得上、`left` / `top` 全非负、**结构真的不同**（读一遍摘要，三条若是同一件事的三种说法，那是三次微调）。

**用户选定方向后不要在这份稿子上加保真度**——新开一个产物转 hi-fi-design（那一步要先收齐品牌资料 / 参考图 / 设计系统再动手）。编号沿用这里的：选中的 `1C` 到那边继续叫 `1C`，深化版从 `2A` 起编。
