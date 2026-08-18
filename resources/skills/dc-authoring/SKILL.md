---
name: dc-authoring
description: Design Component（.dc.html）的格式说明书——文件骨架、{{ }} 空穴、sc-for/sc-if、伪态样式、x-import 预制件协议、DCLogic 逻辑块、data-props 调参面板、画板模式、运行时告警体系与交付前自检。判据：本次交付物是 .dc.html 就必读（design 角色的整页 HTML 一律是，非 DC 会被 create_artifact 直接拒绝）；deck / 动画 / 文档 / 原型 / 传单等专项技能都建立在这份的术语和语法上，先读这份再读它们。写第一行之前读完，别边写边猜。
---

# Design Component（.dc.html）

一个设计交付物 = 一个 `名称.dc.html` 单文件，用 `create_artifact(type='html', title='…​.dc.html')` 交付。
文件由 `./support.js` 运行时驱动：**从第一个流式字符就开始渲染**（半截模板也画得出骨架）、
调参面板由宿主按声明自动生成、导出后离线双击可开。

这份技能只讲**格式本身**。舞台、时间线、分页壳、设备外框各有自己的技能，它们借这里的术语。

---

## 1. 骨架（可直接抄，每一行都跑得通）

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
    html,body{ margin:0; height:100%; background:#faf9f7 }
  </style>
</helmet>

<div style="max-width:960px; margin:0 auto; padding:48px 32px; font-family:"Optima","Avenir Next",-apple-system,"PingFang SC",system-ui">
  <h1 style="font:600 40px/1.15 "Optima","Avenir Next",-apple-system,"PingFang SC",system-ui; margin:0 0 28px; color:#1b1a17">产品概览</h1>

  <sc-for list="{{ cards }}" as="card" hint-placeholder-count="3">
    <div style="padding:20px 22px; border:1px solid #e5e1da; border-radius:8px; margin-bottom:14px; background:#fff"
         style-hover="border-color:#c2603f; transform:translateY(-2px)">
      <div style="font:600 18px/1.3 "Optima","Avenir Next",-apple-system,"PingFang SC",system-ui; color:#1b1a17">{{ card.name }}</div>
      <div style="font:400 14px/1.6 "Optima","Avenir Next",-apple-system,"PingFang SC",system-ui; color:#6b665e; margin-top:6px">{{ card.desc }}</div>
      <button onClick="{{ card.pick }}" style="margin-top:12px; padding:8px 14px; border:0; border-radius:6px; background:#1b1a17; color:#fff; font:500 13px/1 "Optima","Avenir Next",-apple-system,"PingFang SC",system-ui; cursor:pointer">选它</button>
    </div>
  </sc-for>

  <sc-if value="{{ picked }}" hint-placeholder-val="{{ false }}">
    <div style="margin-top:24px; font:400 14px/1.6 "Optima","Avenir Next",-apple-system,"PingFang SC",system-ui; color:#6b665e">已选：{{ picked }}</div>
  </sc-if>
</div>
</x-dc>

<script type="text/x-dc" data-dc-script data-props="{&quot;accent&quot;:{&quot;editor&quot;:&quot;color&quot;,&quot;default&quot;:&quot;#c2603f&quot;,&quot;tsType&quot;:&quot;string&quot;}}">
class Component extends DCLogic {
  state = { picked: null }
  renderVals() {
    const accent = this.props.accent ?? '#c2603f'
    const data = [
      { name: '方案一', desc: '一句话说明' },
      { name: '方案二', desc: '一句话说明' }
    ]
    return {
      accent,
      picked: this.state.picked,
      cards: data.map((d) => ({ ...d, pick: () => this.setState({ picked: d.name }) }))
    }
  }
}
</script>
</body>
</html>
```

- **纯静态设计（无状态、无交互、无参数）：整个 `<script type="text/x-dc">` 标签省略。**
- `./support.js` 永远写这一个相对路径，**绝不自己实现它的任何部分**；漏写了宿主会补进 `<head>`。
- 逻辑块只认第一个 `script[data-dc-script]`（没有才退而找 `script[type="text/x-dc"]`）。
  `data-dc-script` 这个标记同时是宿主的锚点（语法校验、调参持久化、模板边界检查都按它定位），**别省**。
- `data-props` 的 JSON 写在**这个 script 标签**上，双引号一律转义成 `&quot;`。
- **不要写 `data-prop-overrides`**——那是宿主存用户调参的槽位，运行时对它完全无视；
  同 id 重发时若原文里有，原样保留。
- 一份产物**只写一个 `<x-dc>`**：宿主的文本摘要、缩放适配、高度链只认第一个根（`#dc-root`）。

---

## 2. 模板语法

### 2.1 空穴 `{{ }}`

只做点路径查找与字面量，运行时**不求值任何表达式**：

| 写法 | 结果 |
|---|---|
| `{{ user.name }}` | 点路径查找 |
| `{{ items.0.title }}` | 路径段可以是数字下标 |
| `{{ $index }}` | `sc-for` 里的行号（唯一的内置变量） |
| `{{ true }}` `{{ 42 }}` `{{ 'text' }}` | 字面量：布尔 / null / undefined / 数字 / 引号字符串 |

`{{ a + b }}`、`{{ !x }}`、`{{ fn() }}`、`{{ a ? b : c }}` 一律**渲染为空**，
并在控制台留一条告警（自检会收到它）。所有计算在 `renderVals()` 里做完、按名暴露。

取值语义与 React 对齐：`null` / `undefined` / 布尔渲染成空字符串，不会把 "false" 印上屏。
文本位置的空穴还可以直接吐一个 React 元素（`renderVals()` 里 `React.createElement` 造的那种），
运行时会给它补 key 后原样插入。

### 2.2 属性

| 写法 | 结果 |
|---|---|
| `x="literal"` | 字符串 |
| `x="{{ path }}"` | 整值：原始值直传（数字 / 函数 / ref / 对象都不转字符串） |
| `x="a {{ p }} b"` | 插值字符串 |
| `onClick="{{ handler }}"` | 事件：JSX 驼峰名 + **整值空穴** |
| `class` / `for` | 自动映射成 `className` / `htmlFor` |
| 无值属性（`disabled`） | 等价于 `true` |

事件的值必须是函数。写成 `onClick="doThing()"` 这样的字符串不会绑定，只留一条告警。
全小写的事件名（`onclick`、`ondblclick`）会被还原成 React 的驼峰名，但**你就该直接写驼峰**。

`hint-*` 开头的属性是流式占位提示，不会落到 DOM 上。

### 2.3 伪态样式（内联写不了的那五个）

`style-hover` / `style-active` / `style-focus` / `style-before` / `style-after`。
值是一段 CSS 声明串，也可以是 `renderVals()` 返回的样式对象。运行时按声明内容生成 `sc-ps…` 类：

- **hover / active / focus 的每条声明自动补 `!important`**——所以它压得过同一元素上的内联 style。
- **before / after 自动前置 `content:""`**（作者自己写的 content 排在后面，照 CSS 覆盖掉默认值）。
- 相同的声明文本只生成一条规则（列表里 100 行同款 hover 不会变成 100 条规则）。
- 这五个名字之外的 `style-` 属性一律被忽略并告警。

### 2.4 控制流

```html
<sc-for list="{{ items }}" as="item" hint-placeholder-count="3">
  <div style="padding:12px">{{ $index }} · {{ item.name }}</div>
</sc-for>

<sc-if value="{{ hasItems }}" hint-placeholder-val="{{ true }}">…</sc-if>
```

- `list` / `value` **必须是整值空穴**，写成字面量或插值串会告警且不生效。
- 作用域变量名就是 `as` 的值，**不要发明任何前缀**（`$sc_item` 这类约定不存在 = 整个循环渲染为空）。
  漏写 `as` 会告警并按 `item` 兜底。
- **没有 `sc-else` / `sc-elif`**，用多个互斥的 `sc-if`。
- 嵌套循环里内层的 `$index` 会盖住外层的——要用外层序号就在 `renderVals()` 里先算进数据。
- `list` 拿到的不是数组（对象、字符串、数字）→ 告警 + 整块不渲染，运行时不做猜测性循环。
- `<sc-for>` / `<sc-if>` **自己不产生 DOM 元素**（只往父级铺子节点），写在它们身上的
  `style` / `class` 不会出现在页面上。

`hint-*` 不是装饰，是流式期间的**唯一骨架依据**（见 §7 第一条）：

| 提示 | 作用 | 边界 |
|---|---|---|
| `hint-placeholder-count="3"` | 数据到达前先铺 3 行占位 | 只接受整数字面量；**上限 50**，超出按 50 处理；写成空穴形式无效并告警 |
| `hint-placeholder-val="{{ true }}"` | 条件到达前按这个假设渲染 | 只在条件为 `undefined` 时启用 |
| `hint-size="宽,高"` | 外部预制件就绪前占位框的尺寸 | 裸数字补 `px`，`100%` / `50vh` 原样；见 §3 |

**终态不出占位**：流式结束后值还是空的，就如实留空。

### 2.5 标签规则

- **规范 HTML**：非空元素显式闭合、属性值用双引号、不自闭合非空元素。
- **SVG 的驼峰标签名安全**（`linearGradient` / `clipPath` / `foreignObject` 原样传给 React，不会被压小写）。
- **首字母大写的组件标签（`<Card />`）不支持**：告警并按小写元素渲染。外部组件走 `x-import`。
- `<textarea>` 的文本内容会被转成 `defaultValue`。
- 正文里的 `<style>` / `<script>` 被丢弃并告警；正文里的 `<link>` / `<meta>` 静默忽略。

---

## 3. `x-import`：挂载预制件

```html
<x-import component-from-global-scope="deck-stage" from="./deck-stage.js"
          width="1920" height="1080" hint-size="100%,100%">
  …子节点交给组件当 children…
</x-import>
```

**协议要点**

- 组件名两种写法：`component-from-global-scope="全局名"`（自注册的 Web Component 也走这条，
  按标签名从 `customElements` 取）与 `component="导出名"`。两者最终都是**按名字从全局取**，
  这个环境里没有模块解析器。漏写组件名会告警，该块渲染成错误块。
- 文件引用三个别名**完全等价**：`from` / `src` / `import`。值按空白分隔可以是一条链
  （`"./animations.jsx ./artifact-XXXX.jsx"`，前者先求值）。
- **语法属性（`component` / `component-from-global-scope` / `from` / `src` / `import`）会被摘掉，
  其余属性原样透传给组件**——`width`、`height`、`size`、`margin`、`title`、`style`、
  `dark="{{ true }}"` 这些都按普通属性规则（整值 / 插值 / 事件）处理后交出去。
- **顶层 `x-import` 的 `hint-size` 高度写成百分比 = 满屏模式**：运行时给挂载点一屏确定高度
  （`html.sc-dc-fill`），`position:absolute;inset:0` 的舞台类预制件才撑得起来。
  嵌在卡片里的 `100%` 不触发——那是相对那张卡片说的。
- 四态加载机：未登记 → 查一次全局 → `pending`（出 `hint-size` 尺寸的占位框，看门狗 32ms 轮询）
  → 到场即整体重渲染，或超时落 `failed`（红色错误块，不再重试）。
  **`pending` 不看流式标志**（组件在装配路上 ≠ 值还没到），**但流式期间永不判失败**——
  倒计时（10 秒）从流结束才开始。生成中看到占位骨架是正常的，不要因此重发。
- 失败分两型，错误块会说清是哪一种，修法完全不同：
  - `from` 还在 → 宿主没能解析这条链（检查路径拼写、场景 artifact 是否真的存在）；
  - `from` 已被删掉 → 脚本预载了但没把这个名字注册到全局（检查 `component-from-global-scope`
    的名字与组件实际注册的名字是否一致）。

**已知预制件（宿主内置、按引用自动内联，共 6 个）**

| 引用 | 用途 | 展开读 |
|---|---|---|
| `./deck-stage.js` | 幻灯片舞台 | deck-stage 技能 |
| `./animations.jsx` | 动画时间线引擎 | animation-basics 技能 |
| `./ios-frame.jsx` | iOS 设备外框（`IOSDevice`） | interactive-prototype 技能 |
| `./android-frame.jsx` | Android 设备外框（`AndroidDevice`） | interactive-prototype 技能 |
| `./doc-page.js` | 分页文档壳（`doc-page`） | doc-design 技能 |
| `./image-slot.js` | 可填充图片位（`image-slot`，`id` 页内唯一 = 持久化键） | doc-design / flier 技能 |

除此之外**只有**会话内的场景产物可被引用：`./artifact-<id>.jsx`（动画的场景文件，宿主读盘取编译产物）。
自建 helper `.js`、别的兄弟文件都没有可解析的路径。一个 400 行的单 `<x-dc>` 正文很正常，重复靠 `<sc-for>`。

**这些引用由宿主内联，不走网络。** 别自己 `fetch`、别把引擎/场景源码内联进薄壳
（会撑爆输出预算并触发门闩）。

---

## 4. 逻辑块 `DCLogic`

经典 JavaScript——**无 TypeScript、无 import/export**；`DCLogic` 与 `React` 由运行时注入到这段脚本的
执行环境（不是全局）。**类名必须是 `Component`，且 `extends DCLogic`**（两者任一不满足都会告警并整块失效）。

- 有 `this.props` / `state` / `setState` / `forceUpdate` 与 React 类组件的生命周期（`componentDidMount` 等），
  **但没有 `render()`**——渲染路径由基类提供，就是"模板 + `renderVals()` 的返回值"。
- **`renderVals()` 返回模板的全部输入**：扁平值、数组、handler、ref。任何你想写成 JSX 表达式的东西
  （三元、`.map`、比较、拼串）都在这里算完按名暴露。没有 `renderVals()` = 模板取不到任何值（告警）。
- `renderVals()` 抛错时运行时**沿用上一帧的值**并告警，不会整棵树塌掉。
- 模板渲染抛错时**就地换成错误块**，页面其余部分照常可见，不白屏。
- `React.createElement` 是逃生舱口，只用于模板真表达不了的窄场景（如需要跨重渲染保活的动画元素）。
  **绝不用于 UI 布局**：createElement 子树对宿主的就地编辑不透明，用户点不进去。
- 预览里可以调宿主的 AI：`window.openpipal.complete("prompt")`（也接受 `{ messages: [...] }`）。
  **这条只在应用内预览存在**——导出的单文件里没有这个桥，别把交付物的核心内容押在它上面。

**迭代纪律（机制层面的推论）**：改逻辑时运行时会**按同名键把上一版实例的 state 带过来**
（新版删掉的键不复活，新增的键用新版初值）——所以**别随手改 state 的键名**，
改名等于用户正在看的展开/选中/计数当场归零。

---

## 5. `data-props`：调参面板

宿主按这段 JSON 自动渲染类型化控件面板，用户拨过的值经整包替换回传给组件。

```json
{ "defaultView":   { "editor": "enum",    "options": ["map","tree"], "default": "map", "tsType": "string" },
  "startInScatter":{ "editor": "boolean", "default": false,          "tsType": "boolean" },
  "density":       { "editor": "int",     "min": 1, "max": 5, "step": 1, "default": 3 },
  "accent":        { "editor": "color",   "default": "#c2603f",      "tsType": "string" } }
```

- `editor` 取值：`text` | `color` | `int` | `float`（可配 `min` / `max` / `step`，非数字会被丢弃）
  | `boolean` | `enum`（**必须配非空 `options` 数组**）| `null`（回调/对象，不出面板）。
  不在这个集合里的 editor → 该参数降为不出面板 + 告警。
- **`default` 只是控件的种子值，运行时不会拿它去填 `this.props`**。兜底一律写成
  `renderVals()` 里的 `this.props.x ?? 默认值`——两处都填就会出现"面板显示 A、画面渲染 B"。
- `$` 开头的键会被整个丢弃（它们是元数据不是参数），别在这里放 `$` 开头的东西。
- 描述子必须是对象；整段必须是转义后可解析的 JSON，否则面板为空（`create_artifact` 也会直接拒绝）。
- 参数要选**就地编辑做不到的事**：功能开关、UI 替代方案、一个 flag 联动多处的改动。默认给 2-3 个。
  单句文案和单个颜色用户能就地改，别为它们建参数。不要声明组件根本没读的参数。

**静态文档也能声明 data-props**（保留那个 script 标签、不写 `Component` 即可），
但此时覆盖值直接进模板作用域，**用户拨动之前空穴取不到任何值**。要有默认值就写逻辑块。

---

## 6. 画板模式（多方向并排）

`<helmet>` 里加一行 `<meta name="design_doc_mode" content="canvas">`，宿主接管平移缩放与适配，
运行时给画布铺灰底（`html.sc-dc-canvas`，`#e8e6e2`）和至少一屏的画布高度。

```html
<helmet><meta name="design_doc_mode" content="canvas">…</helmet>

<div style="position:absolute; left:80px; top:80px; width:1320px">
  <div style="position:absolute; top:-24px; font:500 11px/1 system-ui; color:rgba(60,50,40,.7)">方向 A · 名称</div>
  <div data-screen-label="Direction A" style="background:#fff; border-radius:2px; box-shadow:0 1px 3px rgba(0,0,0,.08); overflow:hidden">…设计…</div>
</div>
<div style="position:absolute; left:1480px; top:80px; width:1320px">…方向 B…</div>
```

- 每个 frame 是**根的直接子元素**（紧跟 `</helmet>`，不许包 wrapper），`position:absolute` +
  显式 `left` / `top` / `width`——宿主量的就是这批绝对定位的直接子元素，包一层就量不到了。
- **不要**自己加背景、滚动容器、缩放控件或居中逻辑。
- 每个展示卡打 `data-screen-label`：文本摘要、逐屏截图、交接包的文件名都按它分组。
- frame 之间留足间距（~80px）；**所有 `left` / `top` ≥ 0**——导出逐 frame 截图时坐标会被钳到 0，
  负坐标那部分直接被裁掉。
- 间距纪律：8px 系统（8/16/24/32）；绝对定位元素彼此 ≥16px；图例/导航与首行内容 ≥24px；
  **任何两段文本的包围盒不得相交**——自检会检出"文本重叠"并要求修完再交。

### 变体维度建议

给变体时，尝试**跨维度**，不是同一维度的微调：

| 维度 | 举例 |
|---|---|
| 布局 | 上下堆叠 / 左右分栏 / 卡片网格 |
| 配色 | 低饱和中性 / 高饱和品牌色 / 暗色模式 |
| 交互 | 点击展开 / 悬浮预览 / 滚动触发 |
| 信息密度 | 留白大而空 / 信息密集 / 平衡型 |
| 视觉语言 | 扁平 / 拟物 / 手绘 / 几何 |

**至少跨两个维度**，避免"三个都只是换了主色"。

---

## 7. `helmet` 与样式

`<helmet>` 是模板里**唯一**允许出现 `<style>` / `<script>` / `<link>` / `<meta>` 的地方，**必须在模板最顶部**
（前面只允许空白，否则告警：字体与 keyframes 可能晚于首帧生效）。**多个 helmet 只有第一个生效。**

- `<style>` 的内容收进 head 由运行时持有的一个样式元素，热更新时整体换掉。
- `<link>` 按 `href` 、`<meta>` 按 `name` 镜像进 head 并去重；**没有这个键的标签不会被镜像**
  （`<meta charset>` 写进文件的 `<head>`，不要指望 helmet 里那份生效）。
- **helmet 里的 `<script>` 运行时不执行**（文档解析时浏览器已经跑过一遍），
  而且流式期间它压根不会被泵进活文档——预制件的到场靠宿主的预载通道，不靠这一行。

**正文样式只用内联 `style`。** 理由是流式：内联样式即写即画，也只有内联样式能被宿主的就地编辑直写回源码。
重复的样式字面量就在每处重复写。helmet `<style>` 只放**内联写不了**的东西：

- `@font-face`、`@keyframes`、`html,body` reset、滚动条样式；
- `:root` 自定义属性（用户选了设计系统时，其 token 声明块**原样拷进来**，正文一律 `var(--token)` 引用——
  手抄成字面量 = 断链，用户换主题不再联动；token 太多可裁到实际用到的那些及其 `var()` 依赖，
  但保留的每条声明必须原样）；
- 预制件的 FOUC 防护（如 `doc-page:not(:defined){ visibility:hidden }`）。

挂了 `doc-page` 的文档**不要手写 `@page` / `@media print` 的分页几何**——纸张、页边距、断页卫生
全由那个预制件持有；只有颜色保真（`print-color-adjust`）这类内容级规则可以写进 helmet。

### 字体：默认走系统字体栈，别拉网络字体

**不要在 helmet 里写 `<link href="https://fonts.googleapis.com/…">`。** 三条实测理由（与本仓
`src/renderer/src/styles/fonts.css` 文件头记的同一批）：那个域名在中国大陆不通；`<link>` / `@import`
是**阻塞式**的，要等它超时才继续渲染；而且**导出链路不内联任何字体**——用户拿到的 PDF、独立单页、
交接包在离线或大陆环境下打开，字体一律落回替身。排版是设计交付物最吃观感的一环，落回替身基本等于白做。

**默认做法**：用有性格的**系统字体栈**，中西文各给一段、回退链写全。系统里能拿的远不止默认无衬线：

```
衬线/编辑感   Georgia, "Iowan Old Style", "Palatino Linotype", "Songti SC", serif
几何/现代感   Optima, "Avenir Next", "Futura", -apple-system, "PingFang SC", system-ui
中性/界面感   -apple-system, "Segoe UI Variable", "PingFang SC", "Microsoft YaHei", system-ui
等宽/数据感   "SF Mono", "Cascadia Code", "JetBrains Mono", ui-monospace, monospace
```

**确实需要某款特定字体时**：写 `@font-face` 时把字体数据以 `data:` URI 内联进 helmet 的 `<style>`
（产物自带、离线可用），并且**回退链本身要能独立撑住版式**——不要把行高、字宽压到只有那一款字体
才不破版。用 `font-display: swap`，别让文字在等字体时空着。

> 待定：把几款开源字体随运行时一起分发（作者引一行就能用）是可选的后续方案，尚未落地。
> 在它落地之前，上面两条是全部可用手段。

---

## 8. 用户图片

用户随消息发的图片已自动落盘，那条消息里附带"随消息图片已存盘"的路径清单（`uploads/xxx.png`）。
配图**直接用清单里的相对路径**：`<img src="uploads/xxx.png" style="…">`——预览自动内联成 data URI、导出随包携带。

用户给的是**本地图片绝对路径**时：先用 `bash` 把文件复制进本会话图片资产目录
（绝对路径见 runtime-context），再按 `uploads/<文件名>` 引用。
**不要猜文件名，不要写绝对路径或 `file://`**——沙箱预览与导出都解析不了。
既没有随消息图也没有路径时，画占位符并向用户要图；需要用户后补真图的位置用 `image-slot`。

---

## 9. 运行时已经替你做了什么（别写这些防御代码）

- **半截标记的容错**：流式尾部的半截开始标签、半截注释、未闭合的 `{{`，整段丢弃等下一帧，不会闪脏字符。
- **漏写闭合标签**：`li` / `dt` / `dd` / `td` / `th` / `tr` / `option` / `p` 等按 HTML 规则隐式闭合，
  后面的兄弟节点不会被吞进上一项。
- **HTML 实体解码**：`&mdash;` `&nbsp;` `&#8212;` 都会还原成字符。
- **属性名归一**：`class`→`className`、`for`→`htmlFor`、全小写事件名→React 驼峰。
- **style 字符串 → React 样式对象**：厂商前缀、CSS 自定义属性、`url(data:…;base64,…)` 里的分号全部处理好了。
- **伪态规则**的类名生成、内容去重、按渲染代清扫（旧模板的规则当场失效）。
- **高度链**：`#dc-root` 与 `.sc-host` 都写死 `height:100%`；顶层 `x-import` 声明百分比高度时给根一屏确定高度。
- **画板模式**的灰底与最小画布高度。
- **占位微光**（`.sc-placeholder`）的样式与动画，动画只在流式期间跑。
- **源模板收纳**：首帧后原始 `<x-dc>` 子树收进 `<template data-dc-source>`（查不到、不渲染、不进无障碍树），
  并给源拷贝的 id 改名——SVG 的 `url(#id)` 渐变滤镜不会命中隐藏的那份。
- **热更新**：模板增量到达时复用同一棵 React 树与组件实例，state 原样活着，不重建文档、不闪。
- **兄弟预制件与 `uploads/` 图片**由宿主内联/随包携带。

所以：不要给模板套 try/catch，不要自己实现平移缩放，不要自己 fetch 兄弟文件，
不要为"防止组件没加载"写一套兜底 UI。

---

## 10. 约束与静默失败（不知道就会踩）

1. **流式期间逻辑块还没上场。** 宿主只把 `<x-dc>…</x-dc>` 之间的模板文本泵给运行时，
   逻辑块要等整篇生成结束的终稿重建才到位。推论：**空穴在生成全程都是占位微光**。
   所以静态文案、静态样式**绝不要走空穴**（`style="{{ cardStyle }}"`、`{{ pageTitle }}` 这种），
   只有真正的运行时活值才配用空穴——否则用户盯着一屏灰条直到生成结束。
2. **内容写到 `</x-dc>` 外面 = 静默陷阱。** 页面全部内容（含 `<x-import>`、deck 的所有 section）
   必须在 `<x-dc>…</x-dc>` 之间；闭合后只允许那一个 `<script data-dc-script>`。写在外面的标记
   被浏览器静态渲染，**看着像成了，空穴和事件全死**。运行时会告警，`create_artifact` 会直接拒绝。
3. **表达式空穴渲染为空**，且不出占位（它永远不会"到"）——但会留告警。
4. **事件值不是函数就不绑定**（留告警）。
5. **`sc-for` 的 list 不是数组 → 整块不渲染**（留告警）。
6. **`hint-placeholder-count` 上限 50**，非整数字面量无效。
7. **`data-props` 里 `$` 开头的键被丢弃**；`default` 不会进 `this.props`。
8. **`key` 属性别自己写**——运行时会用自己的 key 覆盖。
9. **就地编辑靠"源码里唯一"**。用户在预览里直接改文字/样式时，宿主按三级阶梯在**源码字符串**里定位：
   `id` 属性唯一 → 开标签串唯一 → 文案唯一。三级都不唯一就降级成 AI 改写（一次模型往返，慢且可能改偏）。
   推论：关键可编辑元素给 `id`；**同一句短文案避免在文件里重复出现**；文案走空穴则三级全落空
   （DOM 上的值在源码里根本不存在）。
10. **超长生成会被截断，截断 = 交付物残缺。** 图标用 Unicode 字形（◎ ⊞ ⇉ ◈ ⚐ ▤ ▲ ●）配字号颜色，
    不要写内联 SVG 字符串（一个 SVG icon ≈ 40 个字形的 token）；合成数据 4-6 条足矣，靠 `<sc-for>` 重复；
    预估超过 ~450 行就**先交结构完整的骨架版**（标签全闭合、区块留占位），再同 id 迭代填充。
    **文件必须以 `</html>` 收尾**——没写到这一行就是超预算了，`create_artifact` 会拒绝。
11. **修订已有设计一律先想 `edit_artifact`**：改文案 / 换色 / 调样式 / 修 bug / 在锚点后插新区块，
    都用精确字符串替换（`old_string` 必须在当前内容里唯一），不重发全文、永不超输出预算。
    加新视图 = 在锚点（某区块末尾、`</x-dc>` 前）插模板块 + 在 `renderVals()` 做对应小编辑，分几次做完。
    只有整体换布局/换方向的结构性重写才用 `create_artifact` 同 id 重发。
    **绝不允许为了塞进新内容而删减已有功能。**

---

## 11. 交付前自检：必跑的一步

**每次 `create_artifact` 之后、每轮 `edit_artifact` 收尾时，调一次 `render_artifact(id)`。**
它在隐藏窗口里真渲染一遍，把 console 的 warning / error 回传给你（最多 20 条、每条 200 字符），
外加文本重叠检测、页面文本摘要、截图。**这是一个闭环**：运行时的告警全是可执行的修复指令，
读到就能自己改完再交。返回"渲染干净"才算完。

告警都是**每页只报一次**（同类问题重复出现只看得到第一条），所以修完再跑一遍确认。

| 控制台里出现 | 意思 / 怎么修 |
|---|---|
| 空穴只支持点路径与字面量 | 表达式没求值，渲染成空。搬进 `renderVals()` 按名暴露 |
| 不认识的伪态属性 | `style-*` 拼错了，只有 hover/active/focus/before/after 五个 |
| …的值不是函数，事件未绑定 | 事件要写整值空穴 `onClick="{{ handler }}"` |
| sc-if / sc-for 的条件（数据源）要写成整值空穴 | `value` / `list` 写成了字面量或插值串 |
| sc-for 缺 as 属性 | 补 `as="item"`，模板里的变量名必须与它一致 |
| sc-for 的 list 不是数组 | `renderVals()` 给的不是数组，整块没渲染 |
| 没写 hint-placeholder-count / hint-placeholder-val | 流式期间该区域空白，补上占位提示 |
| hint-placeholder-count 解析不出数字 | 只接受 `"3"` 这样的整数字面量 |
| style / script 只能写在模板顶部的 helmet 里 | 正文里的样式表/脚本被丢弃了 |
| 不支持大写组件标签 | `<Card />` 这种写法不存在，外部组件用 `x-import` |
| x-import 没写组件名 / 没写 hint-size | 补 `component-from-global-scope` / `hint-size` |
| x-import 拿不到外部组件（error） | 看错误块里的分型：`from` 还在 = 路径没解析；`from` 已删 = 名字没注册 |
| 模板里有多个 helmet / helmet 必须写在最顶部 | 合成一个，挪到 `<x-dc>` 的第一个子节点 |
| Component 没有 renderVals() / 没找到 Component / 必须 extends DCLogic | 类名与基类都是硬要求 |
| renderVals() 抛错 | 本帧沿用了上一次的值，逻辑里有真 bug |
| 逻辑块要写成 `<script type="text/x-dc" data-dc-script>` | 不写 type 浏览器会先执行一遍并抛 ReferenceError |
| data-props 不是合法 JSON / editor 不在白名单 / enum 没给 options | 该参数或整个面板不出现 |
| 模板正文之外还有内容 | 见 §10 第 2 条 |
| 文本重叠: "A" × "B" (重叠 N%) | 两段文本包围盒相交超过 25%，排版真的坏了，修 |

**还要核对返回的"页面文本摘要"**——"渲染干净"只代表没有 JS 错误，不代表文案、品牌名、数据是对的。
有 `data-screen-label` 的产物按屏分组给摘要，逐屏对一遍。

---

## 12. 反模式清单

- 空穴里写表达式；空穴里写静态文案/静态样式
- 循环变量名与 `as` 不一致，或给变量名发明前缀
- 内容写在 `</x-dc>` 之外
- 正文里的 CSS class 规则、`<style>`、`<script src>`
- 大写组件标签 `<Card />`
- UI 布局塞进 `React.createElement` 再经空穴暴露（宿主编辑器摸不到）
- 忘写 `hint-placeholder-count` / `hint-placeholder-val` / `hint-size`
- 在模板里用内联 `animation:` 驱动需要跨帧保活的动画（动画元素在 `renderVals()` 里构建后按名暴露）
- 改 state 键名（用户当前的展开/选中/计数会归零）
- 为一句文案或一个颜色建 `data-props` 参数
- 自己实现平移缩放 / 自己 fetch 兄弟文件 / 把引擎源码内联进薄壳
- 同 id 重发时删掉已有功能给新内容腾地方
