---
name: design-system-authoring
description: 把一套设计系统做成 ~/.openpipal/design-systems/<名>/ 下的文件夹交付物——目录蓝图、tokens、组件三件套（jsx + .d.ts + .prompt.md）、@dsCard 预览卡、UI kit、编译产物与画廊评审闭环。用户说"做一套设计系统 / UI kit / 品牌规范库 / 组件库"，或要修订、增补、重新编译已有的那一套时必读。只是要给单个交付物定色板和字体，读 design-tokens 就够，不用读这份。
---

# design-system-authoring

这份技能管**怎么把一套设计系统组织成一个文件夹，并让宿主把它编译成能用的东西**。

- 色值怎么推、字号刻度怎么定、token 该叫什么名字 → `design-tokens`，本篇不重复。
- 单个页面的版式与观感判断不在本篇范围。

## 一、交付物是一个文件夹，不是 artifact

- 落点 `~/.openpipal/design-systems/<系统名>/`，kebab-case。
- **本交付豁免"整页 HTML 走 artifact"的规则**：设计系统就是一堆文件，用 write 逐个文件写。
- **`SKILL.md` 存在 = 注册完成。** 宿主列举设计系统时只认一件事：目录下有一个真实的、非软链的
  `SKILL.md`（`role-manager.ts:352-367`）。没有它，这套系统在新建任务界面里等于不存在；
  有了它，不需要任何别的登记动作。
- 系统名会被校验：非空、≤128 字符、首尾无空白、不以 `.` 开头、不含 `/` `\` `..` `\0`
  （`design-system-resource.ts:198-210`）；系统目录本身不能是软链（同文件 `13-33`）。
- `SKILL.md` frontmatter 的 `name` / `description` 就是画廊页眉的标题与副标题
  （`role-manager.ts:449-469`，逐行解析、只抓这两个键，不是 YAML 解析器）。

### 谁会读这个文件夹——这决定了它该怎么组织

用户在新建任务界面勾选一套系统后，它以 `category="design-system"` 加绝对路径进入那个会话的上下文
（`RolePreflowPanel.tsx:517`）。那个会话拿到的指令是固定的（`agent-runtime/openpipal-prompt-core.ts:181-182`）：
先读 `SKILL.md` → 按它的指引读 README / tokens / 组件文件 → 要用哪个组件先读它的 `.prompt.md` →
交 dc 产物时把 token 文件的 `:root { --… }` 块**原样拷进 helmet `<style>`**。

三条推论，直接决定蓝图：

1. `SKILL.md` 是唯一入口，必须写清阅读顺序，不能只写一句"看 README"就完事；
2. 每个组件的 `.prompt.md` 是它的权威用法说明，不是可选装饰；
3. **每个 token 文件要能被单独整块拷走**——语义别名和它依赖的基础值放同一个文件里，
   跨文件 `var()` 引用在拷贝后会断链，下游拿到的是一堆解析不出来的变量名。

## 二、目录蓝图

```
<系统名>/
├── SKILL.md          # 入口：品牌一句话 + 阅读顺序 + 硬规则。存在即注册
├── README.md         # 设计圣经，画廊底部整篇 markdown 渲染
├── styles.css        # 只放 @import 行，自己不写任何声明（见 §8）
├── tokens/*.css      # :root 里的 --x: y，一个关注点一个文件
├── components/<组>/  # <Name>.jsx + <Name>.d.ts + <Name>.prompt.md + <组>.card.html
├── ui_kits/<产品面>/ # index.html（+ README + jsx）
├── guidelines/*.html # specimen 预览卡
├── assets/           # logo / 图标 / 插画（拷进来的，不是画的）
├── fonts/            # .woff2 / .woff / .ttf / .otf
└── _*                # 宿主生成，别手写（见 §4）
```

以 `_` 或 `.` 开头的目录不进任何扫描；`ui_kits` `assets` `fonts` `node_modules` `screenshots`
`shared` 不进卡片扫描（`role-manager.ts:446`、`ds-compile.ts:171`）。品牌方有自己的目录惯例时从其惯例，
但 `SKILL.md` / `styles.css` / `components/` / `ui_kits/` 这四个位置是硬约定，改了扫描就找不到。

## 三、骨架：能直接抄的三个最小件

### 预览卡（一张一个 .html）

```html
<!-- @dsCard group="Colors" viewport="700x180" name="Brand Ramp" subtitle="品牌色 50→900" -->
<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="../styles.css"></head>
<body style="margin:0;padding:16px;background:var(--paper);font-family:var(--font-body)">
  <div style="display:flex;gap:8px">
    <div style="flex:1;height:64px;border-radius:var(--radius-md);background:var(--brand-500)"></div>
    <div style="flex:1;height:64px;border-radius:var(--radius-md);background:var(--brand-700)"></div>
  </div>
</body></html>
```

首行必须是 `@dsCard`（见 §5）。`styles.css` 走相对路径，深度按卡片所在目录算：
`guidelines/` 用 `../`，`components/core/` 用 `../../`。卡内不写标题不加外框——卡名由画廊渲染在卡外。

### 组件三件套

```jsx
// components/core/Button.jsx
export function Button({ variant = 'primary', size = 'md', disabled, children, ...rest }) {
  const [pressed, setPressed] = React.useState(false)   // 注意：React.useState，不是裸 useState
  return (
    <button
      className={`btn btn-${variant} btn-${size}`}
      disabled={disabled}
      onPointerDown={() => setPressed(true)}
      onPointerUp={() => setPressed(false)}
      style={{ transform: pressed ? 'translateY(0.5px)' : 'none' }}
      {...rest}
    >{children}</button>
  )
}
```

这个例子走 `className`，那就意味着 `.btn` / `.btn-primary` 等必须在被 `styles.css` `@import` 的 CSS 里
**真实定义**（§10）；不想维护类名就全用内联 `style` + `var(--token)`，两条路都行，混着走最容易漏。

```ts
// components/core/Button.d.ts —— LOAD-BEARING：组件约束规则的唯一输入
export interface ButtonProps {
  /** 视觉变体 @default 'primary' */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  /** 尺寸 @default 'md' */
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  children?: React.ReactNode
}
```

```md
<!-- components/core/Button.prompt.md -->
主操作按钮。一屏最多一个 primary，其余用 secondary / ghost。

<Button variant="primary" size="md">保存</Button>

variant: primary（实底品牌色）/ secondary（描边）/ ghost（透明）/ danger（实底红）
size: sm 28px / md 36px / lg 44px 行高
```

### 组件卡（消费编译产物）

```html
<!-- @dsCard group="Components" viewport="700x260" name="Buttons" subtitle="四种变体 × 三种尺寸 × 禁用态" -->
<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="../../styles.css"></head>
<body style="margin:0;padding:16px;background:var(--paper)">
  <div id="root"></div>
  <script src="../../_vendor/react.production.min.js"></script>
  <script src="../../_vendor/react-dom.production.min.js"></script>
  <script src="../../_ds_bundle.js"></script>
  <script>
    var DS = window.AcmeUi_1f3c9d;          // namespace 见 _ds_manifest.json
    var h = React.createElement;
    ReactDOM.createRoot(document.getElementById('root')).render(
      h('div', { style: { display: 'flex', gap: '12px' } },
        h(DS.Button, { variant: 'primary' }, '主按钮'),
        h(DS.Button, { variant: 'secondary' }, '次按钮'),
        h(DS.Button, { variant: 'ghost' }, '幽灵'),
        h(DS.Button, { variant: 'danger', disabled: true }, '禁用')))
  </script>
</body></html>
```

普通 `<script>` + `React.createElement`，不用 `text/babel`、不用任何远程地址（见 §6）。
组件或 token 改了，这张卡重编译后会跟着变——这是它比手写 CSS 复刻更保真的原因。

## 四、编译：一次工具调用，落四件产物

`create_artifact({ type: 'design-system', title: '<显示名>', content: '{"name":"<文件夹名>"}' })`
既是"把画廊交给用户"的手势，也是编译触发器（`openpipal-product-tools.ts:1155-1187`）。它落四件：

| 产物 | 是什么 | 出处 |
|---|---|---|
| `_vendor/react*.production.min.js` | React 18.3.1 UMD 两件，每次编译都刷新 | `ds-compile.ts:108-115`、`741-745` |
| `_ds_manifest.json` | 12 键机器索引：`namespace` `components` `cards` `tokens` `globalCssPaths` `fonts` `brandFonts` `hasThumbnailHtml` `source`，另有恒为空的 `startingPoints` `templates` `themes` | `ds-compile.ts:789-809` |
| `_ds_bundle.js` | format 4 预编译包，挂到 `window.<namespace>` | `ds-compile.ts:811-886` |
| `_adherence.oxlintrc.json` | 从 `.d.ts` 生成的 oxlint 规则 | `ds-compile.ts:888-895` |

- **namespace** = `PascalCase(文件夹名)_sha1(文件夹名)前6位`（`ds-compile.ts:121-132`）。确定性、同名可复现；
  首字符是数字时前缀 `Ds`。别自己编，编完了从 `_ds_manifest.json` 里读。
- **best-effort**：单件失败不阻断其余，错误随工具返回值回来（前 6 条），比如某个 jsx 的 esbuild 语法错。
  看到 `⚠️ 设计系统编译告警` 就修，那是编译器在指你的语法错。
- **时序**：写完组件三件套 → **先调一次** `create_artifact(type='design-system')` 让 `_vendor/` 和
  `_ds_bundle.js` 落盘 → 再写并自检消费真组件的卡 → 收尾用**同一个 id** 再调一次刷新画廊。
  第一次编译之前，任何引用 `_ds_bundle.js` 的卡都是白板。
- 同一套系统反复发布：带历史里那个画廊 artifact 的**原 id**。不带 id 且标题相近会被拦
  （只和同 type 比对，`artifact-store.ts:544-556`），拒绝消息里给的 id 就是本系统的画廊，带上它重发。
  `force_new: true` 只在用户明确要"另做一份留着对比"时用。
- 没有 jsx 组件的系统照样能编（`components` 为空壳），画廊走 `@dsCard` 派生，不受影响。

### `_ds_bundle.js` 怎么编出来的——这决定了 jsx 怎么写

`transformComponentSource`（`ds-compile.ts:493-531`）在交给 esbuild 之前**剥掉所有 import 行**：

- `import React from 'react'` → 剥。React 由 `_vendor/` 提供的全局承接。
- **`import { useState } from 'react'` 也被剥，且不做任何补偿。** 组件里写裸 `useState` 就是渲染期
  ReferenceError。**一律 `React.useState` / `React.useEffect` / `React.useMemo`。**
- `import { Icon } from './Icon.jsx'` → 剥，并把这个文件里所有独立出现的 `Icon` 改写成
  `__ds_scope.Icon`（`ds-compile.ts:843-845`）。求值时解析，文件先后顺序无关。
- 任何 npm 依赖 → 静默剥掉。组件只能靠 React + CSS 变量，不能有第三方包。

暴露规则：只有 `components/**` 的具名导出挂上 `window.<namespace>`；`ui_kits/**` 的 jsx 照样编译进包，
但只进 `unexposedExports`，卡片里取不到（`ds-compile.ts:854-861`）。**要被 kit 复用的东西必须住在
`components/`。** 每个模块单独 try/catch，出错记进 `window.<namespace>.__errors`
（`ds-compile.ts:849-853`）——卡片渲染不出来时先打这个数组。

### `_adherence.oxlintrc.json` 怎么来的

`buildAdherence`（`ds-compile.ts:602-707`）用 TypeScript 解析 `components/**/*.d.ts`：

- 只认 **`interface` 声明**，`type X = {…}` 不算。`XProps` → 组件 `X`；不带 `Props` 后缀的接口名会被
  **原样当成组件名**，所以数据形状接口别塞进组件的 `.d.ts`。
- 每个 interface 的属性名 → 该组件的 prop 白名单，额外放行 `key` `ref` `className` `style` `children`
  （`ds-compile.ts:623`）。
- 纯字符串字面量联合（`'primary' | 'ghost'`）→ 枚举校验；掺进任何非字面量类型就整条不算枚举。
- 三条全局禁令，全 `warn` 级（`ds-compile.ts:627-641`）：裸 hex 色值 / 裸 `px` 数值 /
  不在 `brandFonts` 里的 `font-family`。**第三条只在 `brandFonts` 非空时才生成。**

**这份文件没有宿主在跑。** 全仓只有 `ds-compile.ts` 提到 oxlint，应用里没有任何地方执行它——
落盘只为互操作，给外部工具和人读。所以那三条禁令没有机制兜底，是纪律不是门闩，靠你自己守。

## 五、`@dsCard`：画廊的驱动元数据

每张预览卡首行一条注释，属性顺序任意、单双引号都容（`ds-compile.ts:188-210`、`role-manager.ts:551-571`）：

```html
<!-- @dsCard group="Type" viewport="700x220" name="Display Scale" subtitle="展示字级 1.333 比例" -->
```

- `viewport="WxH"` → 画廊 iframe 的实际渲染尺寸（`DesignSystemGallery.tsx:345-352`）。
  缺省 700×400；**高度被静默夹到 640 上限**（`role-manager.ts:569`），写 900 会得到 640。
- `group` → 归入哪个分组。缺省用卡片所在的顶层目录名，根目录下的卡兜底成 `general`。
  组名用 Title Case，全套一致（`Colors` / `Type` / `Spacing` / `Motion` / `Components` / `Brand`）。
- `name` 缺省由文件名标题化——先去 `.html` 再去 `.card`，`-_.` 转空格后首字母大写
  （`buttons.card.html` → `Buttons`，`type-scale.html` → `Type Scale`）；`subtitle` 缺省空。
- 分组顺序按首次出现，组内按文件名排序。

**缺 `@dsCard` 不报错**：卡照样进画廊，只是掉进兜底分组、尺寸也是兜底值。缺标签视为这张卡没做完。

尺寸纪律：**宁多张小卡，不做一张大卡**。主色 / 中性色 / 语义色分开，display / body / mono 分开，
间距 token 和间距实例分开。一套系统典型 12–20 张。

UI kit 不吃 `viewport`：`ui_kits/<目录>/index.html` 在画廊里恒为全宽 × 640 高
（`DesignSystemGallery.tsx:394-400`），给 kit 写 `@dsCard` 只影响 `_ds_manifest.json` 的 `cards` 条目。

## 六、画廊预览是严格断网的沙箱

卡片和 UI kit 在画廊里通过本地回环 HTTP 以 iframe 加载，响应头带一条严格 CSP
（`design-system-resource.ts:73-102`，`http-server.ts:1312-1346`）：

```
default-src 'none';  script-src 'unsafe-inline' <本系统目录>;  style-src 'unsafe-inline' <本系统目录>;
img-src data: blob: <本系统目录>;  font-src data: <本系统目录>;  connect-src 'none';
frame-src 'none';  worker-src 'none';  form-action 'none';  base-uri 'none';  sandbox allow-scripts
```

能加载的只有**本设计系统目录内**的文件，加上内存里的 `data:` / `blob:`。落到实处：

- **字体必须是本地文件 + `@font-face`。** 没有 Google Fonts、没有任何字体 CDN、没有 `@import url(https://…)`。
  这条和 `dc-authoring` 的字体口径是同一条。可伺服的字体后缀只有 `.woff2` `.woff` `.ttf` `.otf`
  （`design-system-resource.ts:182-188`），别的后缀直接 404。缺正版字体就用系统字体栈替身并打旗标（§10）。
- 远程图标、远程图片、远程脚本一律被拒。素材拷进 `assets/` 再相对引用。
- `connect-src 'none'` → `fetch` / `XMLHttpRequest` / WebSocket / `sendBeacon` 全断。UI kit 的"数据"
  只能是写死在页面里的常量。
- 沙箱不含 `allow-same-origin` → 文档处于不透明源：**`localStorage` / `sessionStorage` 一碰就抛
  SecurityError**；`alert` / `confirm`（无 `allow-modals`）、表单提交（无 `allow-forms` 且
  `form-action 'none'`）、嵌套 iframe（`frame-src 'none'`）都不可用。交互状态只能放在内存里。
- 没有 `'unsafe-eval'` → 别在卡片里 `eval` / `new Function` / `text/babel` 现场编 JSX。JSX 由
  `_ds_bundle.js` 预编译，这是它存在的理由。
- 单个文件超过 8MB 不伺服（`design-system-resource.ts:7`）。大图先压。

**不能通过放宽预览的安全策略来兼容外部依赖。** 把依赖拷进目录里，并在 README 记来源。

## 七、宿主已经替你做了什么

这些不用你写，写了也是白写：

- **不用手写 token 清单、分类、品牌字体清单、lint 规则。** 编译器静态解析你的 CSS 与 `.d.ts` 自动生成。
- **不用手写 `_ds_manifest.json` / `_ds_bundle.js` / `_adherence.oxlintrc.json` / `_vendor/`。**
  手写就是和编译器打架——下次发布会被整个覆盖。你只写源：`jsx` / `d.ts` / `prompt.md` / `css` /
  `card.html` / `README.md` / `SKILL.md`。
- **不用手动登记系统。** `SKILL.md` 落地即被列举，新建任务界面自动出现。
- **不用维护评审台账。** `_review.json` 由画廊读写（`role-manager.ts:375-418`），下次发布时宿主自动
  把"仍被踩且未解决"的项列到工具返回值里。别手写、别删。
- **不用自己截图。** `render_artifact` 自检会渲染页面、回传 console 错误/警告、跑一遍文本重叠检测
  （最多 5 条）、抓一段页面文本摘要，并把截图**作为 image block 直接内联在工具结果里**回给你
  （`openpipal-product-tools.ts:730-784`；截图同时存到 `~/.openpipal/outputs/.self-check/`，
  那份是给人看的）。你不需要、也不应该去 read 那个 png 文件。
  两种降级会明说：模型不支持看图、或图太大（base64 超 600KB）时只给文本摘要。
- **不用给画廊单独做缩略图。** 根目录的 `thumbnail.html` 只被记进 manifest 的 `hasThumbnailHtml`，
  画廊不消费它。

## 八、约束与静默失败

不知道就会踩、踩了不报错的：

- **`styles.css` 自己写的东西不会被扫描。** 编译器取的是它的 `@import` 列表，然后把
  `styles.css` 本身**排除**在解析源之外（`ds-compile.ts:439-458`、`772-773`）。token 或 `@font-face`
  写在 `styles.css` 里 = 查无此物。**`styles.css` 只放 `@import` 行。**
- **`@import` 不递归。** 只读 `styles.css` 那一层的 `@import`；从 `colors.css` 里再 `@import` 出去的文件
  不会被扫到。全部 token 文件在 `styles.css` 里逐条列出。
- 没有 `styles.css` 时兜底只枚举 `tokens/*.css`（深度 ≤2），别的位置的 token 一律看不见。
- **同名 token 以首次出现为准**，后面的定义不覆盖前面的（`ds-compile.ts:342`）。先写亮色再写暗色重定义，
  顺序反了清单里记的就是暗色那份。
- **token 分类按名字的连字符段判定**，值是色值时**先于**一切名字猜测，`font` 判定排在 `spacing` 之前
  （`ds-compile.ts:313-328`）。完整判定表和 `@kind` 旁注写法在 `design-tokens` 第六节，照那份的命名写就落对。
  分错不报错，只是画廊分组和下游取用静默走偏。
- **品牌字族必须加引号才认得出。** `brandFonts` 从 font 类 token 的值里抓**带引号**的首个非系统字族
  （`ds-compile.ts:402-415`）：`--font-display: 'Geist', sans-serif` 认得，`--font-display: Geist, sans-serif`
  认不得。认不出 → `brandFonts` 空 → 那条字体禁令根本不生成。
- **`@font-face` 只从被 `@import` 的 CSS 里收**（`ds-compile.ts:418-432`），CDN 的 `@import` 一律不算。
- **兄弟组件名会被全文替换，包括字符串字面量。** `import { Icon } from './Icon.jsx'` 之后，这个文件里
  每一处独立的 `Icon` 都变成 `__ds_scope.Icon`——包括 `className="Icon"` 里的那个，也包括对象字面量
  简写 `{ Icon }`（会变成语法错误）。别把兄弟组件名同时当局部变量名、类名或文案用。
- **`render_artifact` 的 path 模式走 `file://`，没有画廊那套 CSP。** 自检时远程字体能加载、`localStorage`
  能用；进画廊就全断。**自检通过 ≠ 画廊里成立**，凡是引用了外部地址或存储 API 的卡，必须在画廊里再看一眼。
- path 模式只接受 `~/.openpipal` 下 workspace / outputs / design-systems / conversations/artifacts
  四个根内的绝对路径（`openpipal-product-tools.ts:569-577`）。
- **"渲染干净"只代表没有 JS 错误**，不代表内容对。品牌名、文案、色值对不对，看回传的截图和文本摘要。
- 组件 jsx 扫描深度 6 层、卡片扫描深度 3 层目录（`ds-compile.ts:143-165`、`230-283`）。埋太深的文件静默消失。
- 根目录下的任何 `*.html` 都会被当成卡片（兜底进 `general` 组）。不想它进画廊就别放在根目录。

## 九、工作流

开工先建 todo list，逐项走完。**独立跑完，不中途汇报**：这是长任务，除非关键资源读不了
（比如用户给了代码库路径但打不开），否则不要停下来提问。brief 没说的（具体色值、字体、组件清单）
自己做专业决定，记进 README 的 Caveats，跑完一次性交代。

0. **先探既有目录**：`ls ~/.openpipal/design-systems/<系统名>/`。已存在且非空 → 这是**增量修订不是新建**：
   先读 `README.md` / `styles.css` / `_review.json` 盘点既有蓝图与评审状态，沿用既有结构、只补缺件、
   只改被踩项。**禁止 rm / 覆盖 / 换蓝图重构既有产物**——实案是第二个会话把已有系统当空地开荒，
   清场删掉了前一会话的 14 个组件三件套和一个 UI kit。确要推倒重来，先说明差异、拿到用户明确同意。
1. **探资产**：读用户给的每一份材料。**信源优先级：代码库 > 截图**（截图只做高层参考）。
   只有文字 brief 也能做，但要在 README 的 Sources 表如实标注。
2. **README 骨架**：公司/产品的高层理解 + 信源清单（完整路径或链接，不假设读者有权限）。
3. **tokens + styles.css**：token 文件（基础值 + 语义别名，同层自洽）→ 字体文件拷进 `fonts/` 并写
   `@font-face` → `styles.css` 汇总 `@import`。值怎么推按 `design-tokens`。
4. **README 补 CONTENT FUNDAMENTALS 节**：文案的语气、大小写、称谓、emoji 用不用——给具体例句。
5. **README 补 VISUAL FOUNDATIONS 节**：逐条回答色彩、字体、间距、背景、动效、hover/press 态、边框、
   内外阴影、布局、透明与模糊、图片色调、圆角、卡片长相。**全部回答，不许跳。**
6. **specimen 预览卡**：随做随写，写一张自检一张（§5 的尺寸与分组纪律）。
7. **assets/ 与 README ICONOGRAPHY 节**：logo / 图标 / 插画**程序化拷贝**进来，没有就文字占位加旗标。
8. **组件三件套**：Button / IconButton / Input / Select / Checkbox / Switch / Card / Badge / Tag /
   Avatar / Tabs / Dialog / Toast / Tooltip 之类，集合小就都放 `components/core/`。一件一次 write，
   写完先触发一次编译（§4 时序），再写组件卡。
9. **UI kits**：一个产品面一个目录（单独一条 todo），README + `index.html`（+ jsx）。**只复刻不发明**
   ——像素级贴近真实产品视图，点击流程可以是假的但要走得通；组件复用第 8 步的原语，别在 kit 里重写
   Button；**项目里没见过的界面不许编**，宁可留白加注。
10. **README 补 index 节**：根目录清单 + 组件 / UI kit 索引。
11. **写 `SKILL.md`**：品牌一句话 + 视觉方向 + 阅读顺序（先 README，再 tokens，用组件前读 `.prompt.md`）
    + 硬规则清单 + 常用片段。frontmatter 的 `name` / `description` 会显示在画廊页眉。
12. **开画廊**（收尾动作，不做等于没交付）：`create_artifact(type='design-system')`，见 §4。
13. **收尾**：不总结成果；只列 CAVEATS（没做到的、代做决策的替身），然后**加粗请用户在画廊里逐卡评审**。

### 画廊评审闭环

用户在画廊里逐卡 👍/👎（👎 可写意见），点「发送反馈给 Agent」后你会收到一条
`【设计系统评审反馈 · <系统名>】`：✅ 已确认清单 / ❌ 待修改逐条意见（带卡片相对路径）/ ⏸ 未评审清单
（`DesignSystemGallery.tsx:255-283`）。处理规则：

- **只改被踩项**对应的源文件（卡 HTML / 组件三件套 / token CSS）。✅ 已确认项一律不动，确认即冻结。
- 踩了但没写意见的：自己重渲那张卡、对照 README 规范、检查 token 链路，找出问题再改。
- 改完先自检，再用**原 id** 重调 `create_artifact(type='design-system')` 刷新画廊，然后请用户复审被改的卡。
- 循环到全部 ✅ = 定稿。之后除非用户开口，不再动这些文件。
- 评审台账在 `_review.json`，别手写别删。发布时仍有未解决的踩项，宿主会在工具返回值里提醒你。

## 十、纪律

- **不引用未定义的类名。** 组件样式两条路：内联 `style={{ color: 'var(--text-body)' }}`，
  或 `className` 配一个被 `styles.css` `@import` 的 CSS 文件里**真实定义**的类。选后者时，
  卡片自检前把用到的每个类名 grep 一遍，确认定义存在——类名失配 = 整卡裸浏览器样式，
  截图上看是"全是灰描边默认按钮"。组件卡的合格线是能看到**实色变体**（primary 实底、danger 红、
  ghost 透明），全灰就是没通过。
- **组件三件套不派 subagent 批量代写。** 子代理拿不到你的探索上下文（token 名、蓝图、README 约定），
  实证两次委派全数失败还建错目录，清理成本高于自己写。一件一次 write，天然规避输出上限。
- **不自绘 SVG imagery、不生成图片。** 拷贝，或占位加旗标等用户补。
- **不读 SVG 文件内容**——知道用途就直接拷贝再引用，读进来只是烧上下文。
- **代做的决策必须打旗标。** brief 没给而你替用户定的字体 / logo / 图标集 / 品牌文案，在 README 的
  Sources 表逐条标注"代选，未经确认"，并写清替换路径（正版字体 → 改 `tokens/typography.css` 的
  `--font-*` 加 `@font-face`；真 logo → 替换 `assets/logo-*.svg`）。收尾 CAVEATS 汇总。
- **防审美惯性**：蓝紫渐变、emoji 卡片、彩色左边框卡——除非在信源里真的见过，否则不要。
- **动效三层缺一不可**：数值进 `tokens/motion.css`（3 缓动 + 3 时长 + 语义过渡别名，
  只用 ease-out / ease-in-out / linear 系，禁 bounce 与 spring 过冲）；演示进
  `guidelines/motion.card.html`（一条会跑的点轨，动画参数直接引 token，一眼看出三档节奏差别）；
  禁令进 README 的 Animation 节（写性格不只写数值：不过冲、不留常驻装饰循环、
  hover/press/focus/disabled 四态各一条硬规则，press 给具体数值如 `translateY(0.5px)`）。
- **一个关注点一个 token 文件**，不要一个大文件写全部。单文件保持 2–8KB，README 分节多次写。
- 没有幻灯片模板信源时不建 `slides/` 目录。

## 十一、自检

每阶段做，不留到最后：

1. 每张 specimen 卡、每个 `ui_kits/*/index.html` 写完就 `render_artifact` **path 模式**（传绝对路径）
   渲染一次：console 必须干净，回传的截图必须看得出内容——空白、错位、裸变量名、字体没生效都算没完成。
2. `grep -rL '@dsCard' <系统名>/ --include='*.html'` —— 结果里剔掉 `ui_kits/*/index.html`，
   剩下的就是缺标签的卡，补齐才算完成。
3. `grep -rnE '(^|[^.A-Za-z_$])use[A-Z]' components/` —— 命中的就是裸 hook，全部改成 `React.useX`（§4）。
4. `grep -rnE 'https?://' --include='*.html' --include='*.css' <系统名>/` —— 应为零命中（§6）。
   README 里的信源链接不算，那是给人读的。
5. token 改动后重渲一张色卡，确认 `@import` 链路还通。
6. 组件卡里留一行守卫，编译出问题时自检会直接回报给你：
   `(window.<namespace>.__errors || []).forEach(function (e) { console.error('ds-bundle', e.path, e.error) })`
7. 收尾发布后，读一遍工具返回值里的编译告警与未解决踩项，有就修完再交。
