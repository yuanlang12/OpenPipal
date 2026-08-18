---
name: interactive-prototype
description: 可交互原型 + 手机设备外框的说明书——DCLogic 状态驱动的交互清单，以及 ios-frame / android-frame 两件外框共 13 个预制件的全部 props 与默认值、明暗方案在两个平台上完全不同的下发方式、内容区自带的内边距与层序、"看着成了其实没生效"的一批静默失败（裸属性、驼峰属性名、IOSList 的下传规则）。判据：taskType=原型，或用户要"能点的 / 手机 App 原型 / phone mockup / 多屏流程"时必读；写第一行之前先读 dc-authoring（DC 格式、模板语法、x-import 协议、逻辑块都归它），再读这份。
---

# 可交互原型（Interactive prototype）

这份技能管两件事：**怎么让一份 DC 摸起来像真的在运行的 app**，
以及**怎么把它装进两件设备外框预制件**（`./ios-frame.jsx` 7 个件、`./android-frame.jsx` 6 个件，共 13 个）。

DC 文件格式本身（骨架、`{{ }}` 空穴、`sc-for`/`sc-if`、伪态样式、`x-import` 协议、
`DCLogic`、`data-props`、画板模式、告警表）全在 **dc-authoring**，这里只引用不重复。

---

## 1. 骨架（可直接抄，每一行都跑得通）

两屏 iOS 原型：列表 → 详情，滑动切换，浮一枚毛玻璃迷你播放条。

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
    *{ box-sizing:border-box }
    html,body{ margin:0; height:100%; background:#e8e6e2 }
  </style>
</helmet>

<div style="min-height:100%; display:flex; align-items:center; justify-content:center; padding:32px 0">
  <x-import component-from-global-scope="IOSDevice" from="./ios-frame.jsx"
            title="Library" dark="{{ true }}" hint-size="402px,874px">

    <div style="position:relative; height:100%; overflow:hidden">
      <!-- 轨道：全篇唯一一处让空穴决定布局的地方——它是唯一会动的东西，其余几何一律内联 -->
      <div style="{{ track }}">

        <!-- 屏 1 · 列表 -->
        <div style="width:50%; height:100%; overflow:auto; padding-bottom:100px">
          <x-import component-from-global-scope="IOSList" from="./ios-frame.jsx" header="最近播放" dark="{{ true }}">
            <sc-for list="{{ songs }}" as="s" hint-placeholder-count="5">
              <div onClick="{{ s.open }}" style="cursor:pointer" style-active="opacity:.55">
                <x-import component-from-global-scope="IOSListRow" from="./ios-frame.jsx"
                          title="{{ s.name }}" detail="{{ s.len }}" icon="{{ s.tint }}" dark="{{ true }}"></x-import>
              </div>
            </sc-for>
          </x-import>
        </div>

        <!-- 屏 2 · 详情。不写 font-family：外框根节点已经铺了平台字体栈，这里继承 -->
        <div style="width:50%; height:100%; overflow:auto; padding:0 24px 100px">
          <div onClick="{{ back }}" style="display:inline-block; padding:14px 0; font-size:16px; color:#0a84ff; cursor:pointer">‹ 返回</div>
          <div style="height:220px; border-radius:22px; background:linear-gradient(160deg,#3a3a3c,#1c1c1e)"></div>
          <div style="margin-top:20px; font-size:26px; font-weight:600; color:#f5f5f7">{{ picked.name }}</div>
          <div style="margin-top:6px; font-size:15px; color:rgba(235,235,245,0.62)">{{ picked.len }}</div>
        </div>
      </div>

      <!-- 迷你播放条：轨道的兄弟，所以不跟着屏幕滚动 -->
      <x-import component-from-global-scope="IOSGlassPill" from="./ios-frame.jsx" dark="{{ true }}"
                style="position:absolute; left:16px; bottom:18px; width:370px; height:58px; padding:0 14px">
        <div style="display:flex; align-items:center; gap:12px; width:342px">
          <div style="width:34px; height:34px; border-radius:8px; background:{{ picked.tint }}"></div>
          <div style="flex:1; min-width:0; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">{{ picked.name }}</div>
          <div onClick="{{ toggle }}" style="font-size:16px; cursor:pointer" style-active="opacity:.5">{{ playIcon }}</div>
        </div>
      </x-import>
    </div>
  </x-import>
</div>
</x-dc>

<script type="text/x-dc" data-dc-script>
class Component extends DCLogic {
  state = { screen: 'list', picked: null, playing: false }
  renderVals() {
    const songs = [
      { name: '夜航', len: '3:24', tint: '#5b8def' },
      { name: '晚风', len: '4:02', tint: '#c2603f' },
      { name: '钝角', len: '2:47', tint: '#4f9e7a' }
    ]
    const shifted = this.state.screen === 'detail'
    return {
      songs: songs.map((s) => ({ ...s, open: () => this.setState({ screen: 'detail', picked: s }) })),
      picked: this.state.picked || songs[0],
      track: 'display:flex; width:200%; height:100%; transition:transform .38s cubic-bezier(.32,.72,0,1);' +
             ' transform:translateX(' + (shifted ? '-50%' : '0') + ')',
      back: () => this.setState({ screen: 'list' }),
      playIcon: this.state.playing ? '❚❚' : '▶',
      toggle: () => this.setState((s) => ({ playing: !s.playing }))
    }
  }
}
</script>
</body>
</html>
```

**逻辑块的三条硬条件**（dc-authoring §4 的约定，这里只重申，写错就整块失效）：
标签必须是 `<script type="text/x-dc" data-dc-script>`（不写 `type` 浏览器会先执行一遍并抛 ReferenceError）；
类名必须**恰好叫 `Component`**；必须 `extends DCLogic`，且必须有 `renderVals()`。

---

## 2. 两件设备外框

绝不自己手绘手机壳。状态栏、灵动岛/挖孔、导航区、Home Indicator / 手势条、圆角、描边、
落地阴影、内容裁切全部自带，自己画既是像素级精细活又白烧 token。

| | iOS | Android |
|---|---|---|
| 文件 | `./ios-frame.jsx` | `./android-frame.jsx` |
| 外框组件 | `IOSDevice` | `AndroidDevice` |
| 默认尺寸 / `hint-size` | `402px,874px` | `412px,892px` |
| 机身边框 | 无（整块就是屏） | **10px 实体边框**，`box-sizing:border-box` |
| 屏幕可用区 | 402 × 874 | **392 × 872**（各边被边框吃掉 10px） |
| 顶部系统区 | 状态栏 54px，**浮在内容之上** | 状态栏 36px，**占位在流内** |
| 底部系统区 | Home Indicator 浮层（内容区自带 28px 余量） | 手势导航条 26px，占位在流内 |
| 系统区能否关掉 | 导航区能（不传 `title`），状态栏与 Indicator 不能 | **都不能**，状态栏与手势条恒在 |

### 2.1 怎么挂

13 个件**全部挂在 `window` 上**，都能用 `x-import` 的 `component-from-global-scope` 直接挂进模板，
属性与 children 原样透传，**可以嵌套**（外框里套列表，列表里套行）。
不要为了用它们去写 `React.createElement`——那条路做 UI 布局宿主的就地编辑摸不到。

```html
<x-import component-from-global-scope="IOSDevice" from="./ios-frame.jsx"
          title="Settings" dark="{{ true }}" keyboard="{{ true }}" hint-size="402px,874px">
  …屏幕内容…
</x-import>
```

- **顶层那个 `x-import` 必须写 `hint-size`**（= 外框尺寸），否则流式期只有一个撑不出版面的小占位。
- **套在外框里的子件不用写 `hint-size`**：它们和外框同一个文件，外框就绪的那一刻它们已经在 `window` 上，
  永远不会进占位态。
- 所有 `x-import` 都写成**成对标签**（`<x-import …></x-import>`）。HTML 解析器不认自闭合的未知元素，
  写 `/>` 会把后面的兄弟节点全吞进去。

### 2.2 `title` 的三态语义（两件同款判定：`title !== undefined`）

| 你写的 | 结果 |
|---|---|
| **不传 `title`** | **没有导航栏 / 应用栏**。做全屏 app、自定义头部、通栏封面的唯一正确写法 |
| `title=""` | 出一条空标题的导航栏（合法用法：只要那条横杆占位） |
| `title="Library"` | 正常标题 |

**自带导航栏上的按钮全是装饰**——`IOSNavBar` 的返回尖角与三点、`AndroidAppBar` 的两枚图标位
都没有事件接口，点不动。所以：**原型需要真的能点的返回键 / 操作按钮 = 不要传 `title`，自己画头部。**
iOS 侧不传 `title` 时内容区自动让出 54px 顶部内边距，你的自定义头部从那里往下画就压不到时间。

### 2.3 iOS 全表（`./ios-frame.jsx`）

| 组件 | props（`=` 后是默认值） |
|---|---|
| `IOSDevice` | `children`、`width=402`、`height=874`、`dark=false`、`title`（不传=无导航区）、`keyboard=false` |
| `IOSStatusBar` | `dark=false`、`time='9:41'` |
| `IOSNavBar` | `title='Title'`、`dark=false`、`trailingIcon=true` |
| `IOSGlassPill` | `children`、`dark=false`、`style={}` |
| `IOSList` | `header`、`children`、`dark=false` |
| `IOSListRow` | `title`、`detail`、`icon`、`chevron=true`、`isLast=false`、`dark=false` |
| `IOSKeyboard` | `dark=false` |

- `IOSListRow` 的 **`icon` 传的是一个颜色值**（画左侧 30×30 的圆角色块），不是图标名。
- `IOSList` 自带 18px 上外边距与左右各 16px 内缩，别再包一层带 padding 的容器。
- `IOSGlassPill` 的 `style` 是**唯一暴露出来的毛玻璃配方**（半透明底 + `backdrop-filter` +
  高光/暗边/描边三层 inset）：浮动按钮、Toast、迷你播放条、分段控件都拿它当底座，别自己配一套。
  它的 children 装在一个内层 inline-flex 里，要横向铺开就给自己的那层写死宽度。
- `IOSStatusBar` / `IOSNavBar` / `IOSKeyboard` / `IOSGlassPill` 也能**脱离外框**单独挂
  （做尺寸放大图、系统件对照页），此时 `dark` 得自己传。

### 2.4 Android 全表（`./android-frame.jsx`）

| 组件 | props（`=` 后是默认值） |
|---|---|
| `AndroidDevice` | `children`、`width=412`、`height=892`、`dark=false`、`title`（不传=无应用栏）、`large=false`、`keyboard=false` |
| `AndroidStatusBar` | `dark=false`、`time='9:30'` |
| `AndroidAppBar` | `title='Title'`、`large=false` |
| `AndroidListItem` | `headline`、`supporting`、`leading` |
| `AndroidNavBar` | `dark=false` |
| `AndroidKeyboard` | 无 props |

- `large="{{ true }}"` 的应用栏把标题下沉成独立一行（30px 字号），首行只剩两枚图标位；
  高度约 132px，不传 `large` 时 64px。
- `AndroidListItem` 的 `leading` 是**放进圆形头像位的字符**（primary 底 + 反色字），不传就没有头像位；
  `supporting` 不传则是单行项（56px 高），传了变双行（72px 高）。

### 2.5 明暗方案：两件的下发方式不同，这是最大的用法分野

**Android —— `AndroidDevice` 在根节点上下发 15 个 M3 角色变量**，屏幕内容可以直接写
`var(--m3-…)`，跟着 `dark` 一起翻，而且这是**静态内联样式**（不走空穴，流式期就有观感）：

```html
<div style="padding:14px 16px; background:var(--m3-secondaryContainer); color:var(--m3-onSecondaryContainer)">
  这块配色跟着外框的 dark 翻
</div>
```

变量名**大小写敏感**，照抄这 15 个（角色名保持驼峰）：

```
--m3-surface  --m3-surfaceVariant  --m3-inverseOnSurface  --m3-secondaryContainer
--m3-onSurface  --m3-onSurfaceVariant  --m3-onSecondaryContainer  --m3-onPrimaryContainer
--m3-primary  --m3-onPrimary  --m3-primaryFixedDim
--m3-outline  --m3-outlineVariant  --m3-scrim  --m3-shadow
```

变量只在 `AndroidDevice` 子树里有定义（`AndroidStatusBar` / `AndroidNavBar` 自己也带一份）；
`AndroidAppBar` / `AndroidListItem` / `AndroidKeyboard` **没有 `dark` 形参**，靠继承这些变量，
单独拿出去用会落回浅色兜底。想换主色，在设备内的任意一层写
`style="--m3-primary:#7c4dff"` 覆盖即可，下面的系统件跟着变。

**iOS —— 没有这套**。色板全部内联在组件内部，屏幕内容拿不到任何变量，配色**只能自己定并手动同步**。
外框内部用的就是下面这两套，照抄它，你的内容才和系统件同一套：

| 角色 | light（`dark=false`） | dark（`dark=true`） |
|---|---|---|
| 屏幕底 | `#f2f2f7` | `#000000` |
| 卡片 / 分组底 | `#ffffff` | `#1c1c1e` |
| 主文本 | `#101014` | `#f5f5f7` |
| 次要文本 | `rgba(60,60,67,0.60)` | `rgba(235,235,245,0.62)` |
| 弱化文本 / 尖角 | `rgba(60,60,67,0.34)` | `rgba(235,235,245,0.32)` |
| 分隔线 | `rgba(60,60,67,0.22)` | `rgba(235,235,245,0.18)` |
| 强调色 | `#007aff` | `#0a84ff` |

**推论：iOS 侧挑一套明暗写死，不要做运行时明暗切换。** 要切换就得把每处配色都走空穴，
而空穴在流式全程是空的（逻辑块未上场），整份原型在生成期间会没有样式。要明暗开关就用 Android。

### 2.6 几何预算（够不够放得下，先按这张表算）

| | 内容区高度 | 备注 |
|---|---|---|
| iOS 传 `title` | ≈ 697px | 导航区约 149px（含让出的 54px 状态栏）+ 底部 28px 余量 |
| iOS 不传 `title` | ≈ 792px | 顶部自动 54px 内边距 + 底部 28px 余量 |
| iOS `keyboard="{{ true }}"` | 再减 ≈ 270px | 同时底部 28px 余量归零 |
| Android 不传 `title` | 810 × 392 | 892 − 20 边框 − 36 状态栏 − 26 手势条 |
| Android 传 `title`（小应用栏） | 746 × 392 | 再减 64px 应用栏 |
| Android 传 `title` + `large="{{ true }}"` | 678 × 392 | 再减 132px 应用栏 |
| Android `keyboard="{{ true }}"` | 再减 ≈ 250px | |

**改尺寸就得同步改 `hint-size`**，否则流式期占位框和终态尺寸对不上，用户会看到跳版。
且 `width` / `height` 直接进 CSS，必须写成整值空穴：`width="{{ 390 }}"`（写 `width="390"` 是没单位的
CSS 值，会被丢掉，外框塌成内容高）。

### 2.7 多屏叙事

- **一台设备内部切屏**：骨架里那套——一条轨道 + `transform:translateX` + `transition`，
  由 `state.screen` 驱动。全屏页（Now Playing 这类）从底部升起就换成 `translateY`。
- **多台设备并排看流程**：画板模式（dc-authoring §6）。每台设备各自装进一个绝对定位的
  根直接子元素，打上 `data-screen-label`，宿主的逐屏截图与文本摘要按它分组。
- **状态栏时间只在单独挂 `IOSStatusBar` / `AndroidStatusBar` 时能改**（`time`，默认 `9:41` / `9:30`）：
  设备外框内部是写死 `dark` 一个参数挂上去的，`time` 传给 `IOSDevice` 不会转下去。
  想让多屏叙事的时间推进，就得不用设备外框、自己拼一台。多数情况下不值得——保持默认时间即可。

---

## 3. 什么才算"可交互"

逐项自检，缺一项就还是静态 mockup：

- **状态驱动**：列表增删、选中、展开折叠、步骤指示全部走 `state` + `setState`，不摆一次性 DOM。
- **hover / active 态**：可点元素给 `style-hover` / `style-active`（伪态样式，dc-authoring §2.3）。
  这两个不必进 `state`——纯 CSS 就够，进 state 反而多一次重渲染。
- **表单校验**：`<input>` / `<textarea>` 是普通 DOM 元素，照常用。必填与格式错误即时提示，
  非法时提交按钮 `disabled` + 灰化。
- **过渡动画**：面板切换、元素出入场写 `transition` / `transform`，不做硬切。
- **多步导航流**：向导 / tab / 路由式切换要有前进后退，且**状态在步骤间保留**。
- **真键盘体验自己做**：两件的 `IOSKeyboard` / `AndroidKeyboard` 都是**静态外观件**，
  不可交互、没有任何回调，按不下去。要"打字"就在内容区用真 `<input>` + `state`，
  外框的 `keyboard` 只负责把那块视觉占位铺出来。

---

## 4. 运行时已经替你做了什么（别写这些）

- **整台设备的外观**：圆角、描边、落地阴影、内容裁切、灵动岛 / 挖孔、状态栏（含信号 Wi-Fi 电池）、
  Home Indicator、手势导航条——全部自带。
- **内容区已经是滚动容器**（`flex:1` + `overflow:auto`）：不要自己写外层滚动壳，
  不要给屏幕内容写 `height:874px`。
- **iOS 已经替系统区让好了位**：不传 `title` 时顶部 54px 内边距，不开 `keyboard` 时底部 28px 余量。
- **两套明暗色板已经算好**：不要写 `@media (prefers-color-scheme)`，明暗由 `dark` prop 一处切换。
- **毛玻璃配方**已经封在 `IOSGlassPill` 与 `IOSKeyboard` 里：不要自己调 `backdrop-filter`。
- **导出降级已经想过**：`backdrop-filter` 在 headless 截图 / PDF 里可能不合成，底色本身撑得住可读性——
  不用为导出另写一套替代样式。
- **平台字体栈铺在外框根节点上**：屏幕内容不写 `font-family` 就继承（iOS 一套、Android 一套）。
  字体口径照 dc-authoring §7，**不拉网络字体**。
- **全部图标是内联 SVG 自绘**，零外部资源：离线、导出、大陆网络下都在。
- **外框文件由宿主内联**（`from="./ios-frame.jsx"` 就够），不走网络、不用自己 fetch。
- **自检卡按内容挑外框**：产物里出现 ios-frame / `IOSDevice` 时，宿主的自检预览卡自动用
  402×874 的手机比例展示——你不用为它做任何事。

---

## 5. 约束与静默失败（不知道就会踩，踩了不报错）

1. **裸属性在终稿会变成空串。** 终稿的模板文本取自 DOM 序列化，`<x-import … dark>` 会被序列化成
   `dark=""`，而 `""` 是假值——外框照浅色渲染，没有任何告警。
   **`dark` / `keyboard` / `large` / `chevron` 一律写整值空穴**：`dark="{{ true }}"`。
2. **驼峰属性名在终稿会被压平**（只有事件名会被还原成 React 驼峰）。于是
   **`trailingIcon` 与 `isLast` 从模板传不进去**：写 `trailingIcon="{{ false }}"` 到达组件时是
   `trailingicon`，右上角那枚三点胶囊照出。`IOSDevice` 本来也不把 `trailingIcon` 转给它内部那条
   导航区——要"只有返回键"的头部就别传 `title`，自己画。
3. **`IOSList` 的下传规则很窄**：只给**直接子元素中类型恰为 `IOSListRow`** 的补 `dark` / `isLast`，
   且只在子元素自己没传时补。两种常见写法都会断链——
   `sc-for` 每轮包了一层 Fragment；你为了做点击区包了一层 `div`。
   **推论：行上一律显式写 `dark="{{ … }}"`**，否则深色卡片里会出现一排浅色的行。
4. **`isLast` 基本指望不上**：标签之间的换行空白也占子元素数组的位置，`IOSList` 数出来的"最后一个"
   多半是那段空白。代价只是最后一行多一道 0.5px 分隔线（压在卡片圆角底边上，一般看不出来）；
   在意就自己用 `div` 画列表。
5. **13 个系统件都不透传任意属性**：没有 `onClick`、没有 `id`、没有 `class`，
   除 `IOSGlassPill` 外也没有 `style`。**交互一律套在外层 `div` 上**（骨架里就是这么写的）。
6. **iOS 内容区不是定位上下文**：它没有 `position:relative`，所以你写的 `position:absolute; inset:0`
   图层锚的是**整台设备**——会一路铺到状态栏底下。要锚在内容区内就自己包一层
   `position:relative; height:100%`。Android 的内容区自带 `position:relative`，没有这个问题。
7. **iOS 的 z 层序**：作者内容在最底，状态栏 z20、灵动岛 z30、Home Indicator z40。
   灵动岛与 Home Indicator 是 `pointer-events:none`（盖住内容却不吃点击，全屏可交互图层照常工作），
   **但状态栏那条 54px 会吃点击**——顶部 54px 不要放可点元素。
8. **通栏大图 / 满屏封面要用负 margin 抵消内边距**：不传 `title` 时顶上有 54px、不开 `keyboard` 时
   底下有 28px。第一个子元素写 `margin-top:-54px`，最后一个写 `margin-bottom:-28px`。
9. **`position:fixed` 不要用**：它锚的是视口不是设备，导出与画板模式下位置全错。
10. **走空穴的 `style` 在流式期间是空的**（逻辑块要等整篇生成结束才上场，dc-authoring §10.1）。
    把走空穴的层压到最少——**只给真的会动的那一层**，静态几何一律内联，
    否则用户在生成全程看到的是一堆没有样式的方块。
11. **`{{ }}` 里不求值任何表达式**：三元、拼串、`.map` 全在 `renderVals()` 里算完按名暴露
    （骨架里的 `track` 就是这么给的）。
12. **别改 `state` 的键名**：热更新按同名键把上一版 state 带过来，改名 = 用户当前的选中/步骤当场归零。

---

## 6. 纪律

- **绝不自己手绘设备边框和状态栏。** 那是像素级精细活，且外框已经有了。
- **一台设备 = 一块屏幕内容。** 想展示流程就并排多台（画板模式），不要把两屏塞进一台里上下堆。
- **平台一致性**：iOS 稿别放 Material 的 FAB 与手势条，Android 稿别放灵动岛与 iOS 的大标题。
  两件外框的观感分野（有无机身边框、系统区能否关闭）本身就是平台语言的一部分。
- **UI 布局不进 `React.createElement`**：宿主的就地编辑对 createElement 子树不透明，用户点不进去改。
- **开关型的东西放 `data-props`**（明暗、密度、默认视图），单句文案和单个颜色不要建参数——
  用户能就地改（dc-authoring §5）。
- **改已有原型先想 `edit_artifact`**：加一屏 = 在锚点插模板块 + 在 `renderVals()` 做小编辑，
  不重发全文（dc-authoring §10.11）。

---

## 7. 交付前自检

调 `render_artifact(id)`，按 dc-authoring §11 把告警清干净，另外多看这四条：

1. **外框到底挂上了没有。** `x-import` 失败时只把 children 原样透传，屏幕内容照样可见——
   "内容出现了"不能证明外框在。看截图里有没有状态栏和机身圆角；没有就查
   `component-from-global-scope` 的名字拼写和 `from` 路径。
2. **深色稿里有没有浅色的行**：那是第 5 节第 3 条，行上漏写 `dark`。
3. **自检只渲染初始态，点不了。** 要验第二屏，临时把 `state` 的初值改到那一屏、自检一次、再改回来。
4. **内容有没有被裁掉**：内容区是 `overflow:auto`，超出的部分要滚动才看得见——
   自检截图里看不到不等于不存在，但用户的第一屏就是截图那一屏。按第 2.6 节的预算表核对高度。
