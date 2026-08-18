---
name: animation-basics
description: 动画时间线运行时（./animations.jsx）的说明书——Stage/Sprite/三个 hook/四个图元/20 条缓动的全部接口与默认值、幕登记与剪辑台、EDL 写回产物、逐帧导出契约、对比板相框尺寸算法。判据：本次要做的是"动画/视频/motion 短片/产品演示片/讲解片"，或产物里出现 Stage·Sprite·useTime·useSprite 中任何一个，就必读。先读 dc-authoring（DC 格式与 x-import 协议归它管），再读这份。普通网页的 hover/入场动效不归这份管（见文末）。
---

# animation-basics

一个动画交付物 = **场景 `jsx` 产物 + `.dc.html` 薄壳**两个文件。场景里声明"什么东西在第几秒到第几秒之间、长什么样"，
rAF 循环、播放条、剪辑台、逐帧导出协议全部由运行时 `./animations.jsx` 兜住。

这份技能只讲这个运行时。DC 文件骨架、`{{ }}` 空穴、`x-import` 协议、`helmet`、字体规矩、告警体系
一律归 **dc-authoring**，那份先读，这里不重复。

---

## 1. 开工前：问足 + 两步交付节奏

动画最吃叙事对齐，凭感觉开工必返工。**动手前用 `questions_v2` 一次问足**，调用后结束本轮等回答，别脑补默认值。必问：

- **叙事**：讲什么故事？几个转折？情感高点在哪？（text-options）
- **时长**：先出 ~13 秒 3 方向提案，正片目标秒数？
- **画幅**：16:9 / 9:16 / 1:1？（决定 `Stage` 的 `width`/`height`）
- **品牌色与气质**：主色、accent、清爽数据感 / 科技感 / 温暖亲和？（svg-options 给色板与几何预览）
- **观众**：决定信息密度与旁白语气。
- **要不要字幕**：Caption 胶囊是否需要。

**两步交付**

**Step 1 — 3 方向 ~13 秒提案（画板模式对比板）**：一套叙事、一份数据、**一个** `Scene({ theme })`，
方向差异全压进 theme 对象（约 20 个 token：ink/muted/accent/语义三色/panel/圆角/背景…），
`DirectionA/B/C` 只是传不同 theme。梯度铺开：一个贴用户已知审美、一个中间态、一个更大胆。
三块画布并排在一张画板上，页面文案内嵌选择指令（锚点 1a/1b/1c）。

**Step 2 — 选定后扩产正片**：**新建** `film-<选项>.jsx`，复用提案里立住的 theme / 数据数组 / Beat / 组件，
把 13 秒的 4 拍加密到 8 幕 ~60 秒。demo 里立住的数据资产逐字复用，别重编一遍。

---

## 2. 交付形状（顺序不能反）

1. **先建场景 jsx**：`create_artifact(type='code', language='jsx')`。返回里拿到 `(id: artifact-XXXX)`——**记住这个 id**。
   宿主用 esbuild 把它预编译成同目录 `<id>.compiled.js`，编译错误当场回到工具返回值里，照错修。
2. **再建薄壳**：`create_artifact(type='html', title='xxx.dc.html')`，
   `<x-import ... from="./animations.jsx ./artifact-XXXX.jsx">`（链式，空格分隔，**前者先求值**）。
3. 两者是不同 type（code vs html），标题相近也不会互相拦截。

**改稿路由**：改动画逻辑 → `edit_artifact` 改**场景那个 code id**；改版式/加方向 → 改薄壳 html id。不重发全文。
场景 jsx 产物在工作区里会被自动装进一个最小薄壳预览（导出多个根组件时给切换 chips），所以单看场景也能验。

**两道硬闸（撞上就是被拒，不是"再试一次"）**

- `type='code'` 内容 **> 28000 字符直接拒**。正片场景必须分批长出来：先 create 一个**能编译**的骨架
  （8 幕各留唯一占位如 `{/* FILL:BEAT-3 */ null}`，幕号不同 → 每幕 edit 锚点唯一），再逐幕 `edit_artifact` 补。
- 场景形状的 code 产物**预编译不过就拒**。被拒时别整篇重发（大概率又截断），补/修那一幕即可。
- 薄壳里检测到被内联的引擎或场景代码**直接拒**。`x-import` 的兄弟引用由宿主读盘内联，不走 `file://` fetch，
  会话托管的 artifact 照样解析。**渲染没立刻出画面 = 宿主在异步内联，正常**，不要因此改走内联或 recreate 薄壳。

---

## 3. 骨架（每一行都跑得通）

### 场景文件（`type='code'`, `language='jsx'`）

```jsx
// xxx场景.jsx —— 求值时 animations.jsx 已在 window，直接解构
const { Stage, Sprite, useTime, useSprite, clamp, interpolate, animate, Easing,
        TextSprite, RectSprite, ImageSprite } = window;

const THEME_A = { key:'dir-a', bg:'#fbfaf8', ink:'#101319', muted:'#5b636e',
  accent:'oklch(80% 0.14 215)', bad:'oklch(66% 0.18 25)',
  mid:'oklch(82% 0.15 88)', good:'oklch(78% 0.15 165)' };
const THEME_B = { key:'dir-b', bg:'#05070d', /* 暗底：同色相提亮 L */ };
const THEME_C = { key:'dir-c', bg:'#fff8ef', /* 奶油底：提 L、降 C */ };

// Beat = 顶层 Sprite + 整层 crossfade。转场机制就是它，没有独立转场系统。
// label 一路透传给 Sprite，会成为剪辑台上那块 clip 的名字（不给就是"片段 N"）。
function Beat({ start, end, label, fadeIn = 0.5, fadeOut = 0.5, children, style }) {
  return (
    <Sprite start={start} end={end} label={label}>
      {({ localTime, duration }) => {
        const opacity = Math.min(
          clamp(localTime / fadeIn, 0, 1),
          clamp((duration - localTime) / fadeOut, 0, 1)
        );
        return (
          <div style={{ position:'absolute', inset:0, opacity, ...style }}>
            {typeof children === 'function' ? children({ localTime, duration }) : children}
          </div>
        );
      }}
    </Sprite>
  );
}

// 常驻背景层：Stage 直接子级、所有 Beat 之外。它不是 Sprite，所以不占一条剪辑轨。
function Bg({ theme }) {
  const t = useTime();
  const drift = Math.sin(t * 0.4) * 20;
  return (
    <div style={{ position:'absolute', inset:0, background:theme.bg }}>
      <div style={{ position:'absolute', left:200 + drift, top:120, width:400, height:400,
        filter:'blur(72px)', background:theme.accent, opacity:0.5 }} />
    </div>
  );
}

function Scene({ theme }) {
  return (
    <Stage width={1280} height={720} duration={13} background={theme.bg} persistKey={theme.key}>
      <Bg theme={theme} />
      {/* 相邻 Beat 区间重叠 ~0.4s = crossfade。
          正文优先用现成图元：进退场、Ken Burns、占位框都在里面，手搓 div 是兜底不是默认。 */}

      <Beat start={0} end={2.7} label="数据汇入">
        <TextSprite x={120} y={300} text="每天 3 分钟" size={96} weight={700}
                    color={theme.ink} entryDur={0.6} entryEase={Easing.easeOutBack} />
        <TextSprite x={120} y={420} text="把这周的课上完" size={40}
                    color={theme.muted} entryDur={0.5} />
      </Beat>

      <Beat start={2.4} end={8.7} label="热力图">
        {({ localTime: lt }) => (
          <>
            {/* 逐格生长：宽度用 animate 的单段补间，每格错开 0.08s 形成级联 */}
            {[0,1,2,3,4].map(i => (
              <RectSprite key={i} x={160} y={200 + i*80} height={56} radius={8}
                          color={theme.accent}
                          width={animate({ from:0, to:520, start:0.2 + i*0.08, end:1.1 + i*0.08,
                                           ease: Easing.easeOutCubic })(lt)} />
            ))}
            {/* 真图未定时先占位：给了 placeholder 就画斜纹框、**不加载 src** */}
            <ImageSprite x={760} y={200} width={360} height={280} radius={12}
                         placeholder={{ label: '课堂热力图截图' }} />
          </>
        )}
      </Beat>

      <Beat start={8.5} end={13.0} label="学生报告">
        {/* 有真图时：kenBurns 让停留期缓慢推近，一个开关的事 */}
        <ImageSprite x={120} y={140} width={480} height={440} radius={12}
                     src="uploads/report.png" kenBurns kenBurnsScale={1.12} />
        <TextSprite x={680} y={300} text="家长看得懂" size={64} weight={700} color={theme.ink} />
      </Beat>
    </Stage>
  );
}

const DirectionA = () => <Scene theme={THEME_A} />;
const DirectionB = () => <Scene theme={THEME_B} />;
const DirectionC = () => <Scene theme={THEME_C} />;
Object.assign(window, { DirectionA, DirectionB, DirectionC });
```

### 薄壳（`type='html'`，全屏正片形态）

```html
<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script src="./support.js"></script>
</head><body>
<x-dc>
<helmet><style>html,body{ margin:0; height:100%; background:#05070d }</style></helmet>
<x-import component-from-global-scope="FilmB" from="./animations.jsx ./artifact-YYYY.jsx"
          hint-size="100%,100%" style="position:absolute; inset:0;"></x-import>
</x-dc>
</body></html>
```

`helmet` 的底色与影片底色同色，缩放留边时无缝。全部内容在场景 jsx 里，薄壳只留挂载声明与版式。

---

## 4. 心智模型（三条铁律，破一条就是黑屏或导出漂移）

**① 秒制，不是帧制。** 时间单位是秒（浮点）。全局时间由 `Stage` 经 React Context 下发。

**② 画面只是 `t` 的纯函数。** 每一帧在 render 里按当前时刻算出 `transform / opacity` 写进内联 style。
不写 CSS `transition` / `@keyframes`、不攒增量状态、不读挂钟、不用未播种随机。
理由是确定性：顺放到 t、倒着擦洗到 t、冷启动直接落在 t，三者必须像素一致——
逐帧导出正是靠"把播放头钉到 t=i/fps 再截图"工作的。自走时钟的相位由挂载时刻决定，不由 t 决定，
在这条链路上必然漂移。

**③ 时间只在 `Stage` 子树内存在。** `useTime()` / `useTimeline()` / `useSprite()` 在 `Stage` 之外
拿到的是空闲时间线：`time` 恒 0、`duration` 恒 0，**不报错**。在 Scene 函数体顶层（`<Stage>` 之外）
或模块作用域调用 `useTime()`，整片就定在 t=0，opacity 门全关 = 黑屏。这是最常见的根因。

---

## 5. 能力全表

运行时用**一条原子语句**暴露这 16 个名字，场景顶部解构取用：

```
Stage  Sprite  PlaybackBar  TimelineContext  SpriteContext
useTime  useTimeline  useSprite
TextSprite  ImageSprite  RectSprite  VideoSprite
Easing  interpolate  animate  clamp
```

### 5.1 `Stage`

| 属性 | 默认 | 说明 |
|---|---|---|
| `width` / `height` | 1280 / 720 | 画布逻辑尺寸（取整、最小 1）。导出分辨率就是它 |
| `duration` | 8 | 时间轴总长（秒，可小数）。**非正数或非数静默回落 8** |
| `background` | `#ffffff` | 画布底色。作者不给也要能读清深色文字 |
| `loop` | `true` | 播到尾是否回绕 |
| `autoplay` | `true` | 挂载后自动播 |
| `persistKey` | `openpipal-stage` | 持久化键前缀，见 §6.4 |
| `fps` | 30 | **保留字段：收下、强转、不使用。** 导出帧率来自宿主参数，写它不改变任何行为 |
| `style` | — | 合并进舞台根（画布视口 + 播放条的外层容器），不是画布本身 |
| `className` | — | 透传到舞台根 |
| `children` | — | 画布内容，全部按 `position:absolute` 排在 `width × height` 的坐标系里 |

舞台根的固定行为：`width/height:100%`、纵向 flex、`overflow:hidden`、底色 `#14161a`（letterbox 色）。
两个子节点：画布视口 + 播放条，永远只有这两个。

### 5.2 `Sprite` —— 时间窗

| 属性 | 默认 | 说明 |
|---|---|---|
| `start` | 0 | 绝对秒 |
| `end` | 舞台 `duration` | 绝对秒；省略 = 直到片尾 |
| `label` | `''` | 幕名。**只对顶层 Sprite 有意义**，会画在剪辑台的 clip 上 |
| `keepMounted` | `false` | 真则窗外也常驻挂载（自己用 `ctx.visible` 判断该不该画） |
| `children` | — | 节点，或 `(ctx) => 节点` 的函数 |

时间片上下文 `ctx = { localTime, duration, progress, visible }`：
`localTime = max(0, t - start)`；`duration = end - start`；`progress = clamp(localTime/duration, 0, 1)`
（duration 非正时为 0）；`visible` 是播放头是否落在 **`[start, end]` 闭区间**内。
不可见且没有 `keepMounted` → 整棵子树卸载（返回 null）。

### 5.3 三个 hook

| 接口 | 返回 |
|---|---|
| `useTime()` | 当前时刻（秒）。等价于 `useTimeline().time` |
| `useTimeline()` | `{ time, duration, playing, setTime, setPlaying }` —— **可编程控制播放**：`setTime(秒)` 会先暂停再定位，`setPlaying(bool)` 切播放态 |
| `useSprite()` | 最近一层 `Sprite` 的时间片上下文 |

**`useSprite()` 在 `Sprite` 之外不是错误，它回退到舞台级**：
`localTime = 舞台时刻`、`duration = 舞台时长`、`progress` 按舞台算、`visible` 恒 `true`。
所以 `TextSprite` 这类图元直接挂在 `Stage` 下就能用。
推论：**不要为了"拿到 localTime"而多包一层 `Sprite`**——那会多登记一个幕、污染用户的剪辑轨（§6.1）。

### 5.4 四个现成图元

四个都自带进退场（淡入淡出 + 各自的位移/缩放），都吃 `style`（合并覆盖算出来的样式），
都是 `position:absolute` + `pointerEvents:none`。前三个走 `useSprite()`，因此既能放在 `Sprite` 里，也能直接挂舞台。

**`TextSprite`** —— 一行文字

| 属性 | 默认 | | 属性 | 默认 |
|---|---|---|---|---|
| `text`（无则用 `children`） | — | | `weight` | `600` |
| `x` / `y` | 0 / 0（px） | | `letterSpacing` | `normal`（数字补 px） |
| `size` | 48（px） | | `entryDur` / `exitDur` | 0.5 / 0.4 秒 |
| `color` | `#111318` | | `entryEase` / `exitEase` | `easeOutCubic` / `easeInCubic` |
| `font` | `inherit` | | `align` | `left`（可 `center`/`right`） |

`align` 决定文字相对 `x` 的对齐：水平位移由组件自己补偿（`center` = -50%，`right` = -100%），
**作者只给一个坐标**。行高固定 1.15，`white-space:pre`（自己写换行）。进场上浮 18px、退场上移 18px。

**`ImageSprite`** —— 一张图

| 属性 | 默认 | 说明 |
|---|---|---|
| `src` | — | 用户图走 `uploads/xxx.png` 相对路径（见 dc-authoring） |
| `x` / `y` / `width` / `height` | 0 / 0 / 400 / 300 | px |
| `fit` | `cover` | CSS `object-fit` |
| `radius` | 0 | 圆角 px |
| `alt` | `''` | |
| `kenBurns` | `false` | 真则在**保持段**（进场结束→退场开始）匀速缓推 |
| `kenBurnsScale` | `1.08` | 缓推终点缩放 |
| `entryDur` / `exitDur` | 0.6 / 0.4 | 进场 = 淡入 + 从 0.96 放大到 1 |
| `placeholder` | — | **给了就渲斜纹占位框、完全不加载 `src`**，`{ label:'城市夜景' }` 的 label 写在框中央 |

`placeholder` 正好对上"先排版后配图"的节奏：第一版全用占位把版式与节奏立住，
拿到真图后逐个换成 `src`。**给了 placeholder 就算同时给 src 也不会加载**。

**`RectSprite`** —— 实心矩形 / 容器

| 属性 | 默认 | 说明 |
|---|---|---|
| `x` / `y` / `width` / `height` | 0 / 0 / 200 / 120 | px |
| `color` | `#111318` | 背景 |
| `radius` | 0 | 圆角 px |
| `entryDur` / `exitDur` | 0.45 / 0.35 | 进场带 12px 上移 |
| `render` | — | **逃生舱口**：`(spriteCtx) => 样式对象`，返回值覆盖算出来的样式 |
| `children` | — | 渲进矩形里 |

`render` 的优先级最高（在 `style` 合并之后应用），拿到的是完整时间片上下文。
图元不够用时用它，而不是从零手写一个 `Sprite`：

```jsx
<RectSprite x={80} y={400} width={520} height={8} color={theme.accent} radius={4}
  render={({ progress }) => ({ transform: `scaleX(${progress})`, transformOrigin: '0 50%' })} />
```

**`VideoSprite`** —— 把已有视频放进片子

| 属性 | 默认 | 说明 |
|---|---|---|
| `src` | — | 视频地址 |
| `start` | 0 | **源片内**的起始时间戳（秒） |
| `end` | 无 | 给了且 `> start` 时，在 `[start, end]` 区间内**取模循环** |
| `speed` | 1 | 舞台时间的缩放倍数 |
| `style` | — | 合并进 `<video>`（默认 `display:block`） |
| 其余属性 | — | 原样透传给 `<video>`（`width`、`className`、`poster`…） |

播放位置**由舞台播放头驱动**，不用视频自己的时钟：`舞台时刻 × speed` 落进 `[start, end]` 取模，
换算成源片时间戳写回；已经足够接近（差 ≤ 0.04s）就不写，避免每帧 seek 抖动。元素恒定静音、内联播放。

**两个坑**：① 它读的是**舞台绝对时刻**，不是所在 `Sprite` 的 `localTime`——把它塞进一个 4 秒才开场的
Beat 里，它照样从舞台 0 秒开始算位置。② **逐帧导出下不保证视频帧与 t 严格对齐**（解码器 seek 未必在
两次 rAF 内落地）。要求逐帧精确的画面用图片序列或矢量绘制。

### 5.5 `Easing` —— 20 条曲线

```
linear
easeInQuad    easeOutQuad    easeInOutQuad      柔和、通用
easeInCubic   easeOutCubic   easeInOutCubic     默认口味（图元的默认进退场就是它）
easeInQuart   easeOutQuart   easeInOutQuart     更陡，收得更硬
easeInExpo    easeOutExpo    easeInOutExpo      极端加减速，适合"唰"地出现/消失
easeInSine    easeOutSine    easeInOutSine      最平，适合背景漂移、呼吸
easeInBack    easeOutBack    easeInOutBack      **允许过冲**：弹出、卡片入场
easeOutElastic                                  **强过冲回弹**：一片子里最多用一两次
```

选型：`easeOut*` 用于**入场**（快进慢停，观众先看到东西）；`easeIn*` 用于**退场**；
`easeInOut*` 用于**镜头运动**（推镜、平移，两头都要稳）；`Back` / `Elastic` 是调味料，
用在需要"活泼"的单点强调上，整片铺开会显廉价。

### 5.6 三个纯函数

```js
interpolate(input, output, ease?)  // -> (t) => value；分段补间
animate({ from, to, start, end, ease })  // -> (t) => value；单段补间
clamp(v, min, max)                 // 收敛到闭区间；NaN 收到下界
```

`interpolate` 的 `ease` **可以是数组**，与段数一一对应（缺项那段退线性）——
"停-推-停"这类多段镜头运动可以每段给不同曲线：

```js
const camScale = interpolate([0, 1.2, 3.5, 4.2], [1, 1, 1.16, 1.16],
                             [Easing.linear, Easing.easeInOutCubic, Easing.linear]);
```

两者都**不外推**（超出首/末关键点取端点值），段长为 0 不除零。
`animate` 在 `start` 之前恒为 `from`、`end` 之后恒为 `to`。

**它们不能插值颜色**：端点不是有限数时退化成阶跃（进度到 1 才换）。要过渡颜色就分别插值分量再拼字符串。

---

## 6. 幕与剪辑台（用户真正拿到的东西）

播放条同时是剪辑台。**你摆 Beat 的方式，直接决定用户在剪辑轨上看到的分段。**

### 6.1 幕登记三条规则

1. **只有顶层 `Sprite` 成幕**——父级链上没有别的 `Sprite` 的那些。嵌在幕内部的 `Sprite` 是幕的内部结构，不登记。
2. **按 `start|end` 去重**：两个顶层 Sprite 时间窗完全相同 → 剪辑轨上只有一块 clip。
   想让用户看到两段就别给同样的区间。**重叠不合并**（crossfade 靠重叠，合掉就看不见了）。
3. **登记表只增不删**：条件渲染出来的 Sprite（`{t > 3 && <Sprite/>}`）随播放头卸载时**不注销**——
   否则 clip 会跟着播放头闪。舞台重建才清空。

clip 的名字取 `label`；不给就是按出表序号的"片段 N"（英文文档是 `Clip N`）。**给每个 Beat 起真名**，
这是用户唯一能认出"我点的是哪一幕"的依据。

### 6.2 播放条的形状

- **控制行 44px**：播放/暂停、回到开头、中段、`x.xs / y.ys` 读数、分段展开按钮。
- **轨道行 40px**，只在展开态渲染；整条 44 + 40 = **84px**。
- **一个幕都没登记 → 没有展开按钮、永远 44px**，与没有剪辑台时逐像素一致。
- **有幕时默认展开**（84px）。用 Beat 写的片子一律按 84 算版式。
- 收起态中段是一条 4px 细轨（擦洗面）；展开态中段换成**选中段操作区**，擦洗归轨道行。
- 操作区内容：幕名 · 起止时间 + 倍速 `0.5× 1× 1.5× 2×` + 删除这段 + 重置全部编辑（仅在有编辑时出现）+ 关闭。
- 文案按 `<html lang>` 前缀在中/英两套里二选一（读不到就按英文）。

### 6.3 用户能做什么

- **擦洗**：在轨上按下 = 定位 + 暂停 + 选中按下点所在的幕（重叠处取 `start` 更大的那个，即"后进场的那一幕"）；
  拖动跟随（带指针捕获，触摸可用）。
- **悬停预览**：只改显示的时刻，不动播放头。
- **键盘**：`空格` 播放/暂停 · `←`/`→` 步进 0.1s（**按住 `Shift` 步进 1s**）· `0` 或 `Home` 回开头并暂停 ·
  `Escape` 清除选中。在 `input`/`textarea`/`select`/contenteditable 里打字不吞键；带 ⌘/Ctrl/Alt 不响应。
  **多个 Stage 同页时**：只有页面上唯一一个 Stage，或指针悬停/焦点落在它身上，才吃键盘——对比板不会一键切三块。
- **不循环时**播到末尾会钉在末尾并暂停；此时再按播放会先回到 0。

### 6.4 剪辑会改变你的交付物

用户在剪辑台上改倍速或删段之后：

1. 运行时在画布元素上派 `openpipal:edl-changed`；
2. 宿主把这张编辑表**写回产物 html 自身**——`<script data-openpipal-edl>window.__openpipalEdl=[…]</script>`；
3. 于是预览、逐帧 mp4 导出、交接包采样、自检三帧看到的是**同一份剪辑**，
   画布上的 `data-openpipal-video-duration-secs` 变成剪辑后的时长，**导出的 mp4 时长跟着变**。

推论：**你交付的 13 秒只是起点**。下次 `read_artifact` 看到文件里多出那个 `<script data-openpipal-edl>` 块，
那是用户的编辑，不是脏数据——别删。全速 1（= 没有编辑）时宿主会自己把这个块移掉。
场景代码永远拿到**源时刻**，不用为剪辑写任何代码。

**持久化三把键**，前缀是 `persistKey`：`<persistKey>:t`（播放头）、`<persistKey>:edl`（编辑表）、
`<persistKey>:lane`（轨道展开态）。**同页多个 Stage 必须各给独立 `persistKey`**（对比板走 `theme.key`），
漏给或重名 → 三样全串台。冷启动会**首帧就定格**在恢复出来的时刻，不会先闪一帧 t=0。

---

## 7. 运行时已经替你做了什么（别写这些代码）

- **rAF 播放循环**与单帧步长封顶（窗口切走再回来不会一次跳过半条时间轴）。
- **播放条、擦洗、悬停预览、触摸拖动、键盘、剪辑台**——全套播放器交互。别自己做控件。
- **自适应缩放**：画布按容器等比缩放，**封顶 1（不放大）**，两侧留 `#14161a` letterbox。别自己实现缩放。
- **持久化与冷启动定格**（三把键）。
- **宿主逐帧导出协议**：画布元素带 `data-openpipal-video-duration-secs` 与尺寸属性、监听
  `openpipal:seek-to-time`（收到即暂停 + 钉住 + 同步提交）、字体就绪后置位。
  **画面上没有任何导出按钮**——mp4 由宿主的导出入口/`export_artifact` 驱动，别在场景里画"下载视频"。
- **属性强转**：`x-import` 挂载路径下所有属性都是字符串，运行时会把数字属性转数、把 `"false"`/`"0"`/`"no"`/`"off"` 当假。
- **`style` 只在真是对象时合并**（字符串不会被展开成一堆下标键）。
- **等 React 就绪**再启动（自行轮询约 15 秒），**幂等守卫**（同一份源码被求值两次只生效一次）。
- **`PlaybackBar` 摆在 `Stage` 外**会静默不渲染，不会抛。
- **场景 jsx 的预编译**、**`animations.jsx` 先于场景求值的门闩**、**薄壳兄弟引用的读盘内联**——全是宿主的活。

所以：不要写 `setInterval`/自建时钟，不要写播放/暂停按钮，不要给场景套 try/catch，
不要 `fetch` 兄弟文件，不要为"防止引擎没加载"写兜底 UI，不要自己缩放画布。

---

## 8. 约束与静默失败（不知道就会踩，踩了不报错）

1. **`Stage` 之外调时间 hook → 空闲时间线**（`time` 恒 0、`duration` 恒 0），不报错，全片定格 = 黑屏。
2. **`useSprite()` 在 `Sprite` 之外回退到舞台级**，不是失效。为拿 `localTime` 多包一层 `Sprite` = 多一条剪辑轨。
3. **只有顶层 `Sprite` 成幕**；嵌套的不登记，`label` 白给。
4. **`start|end` 相同的顶层 Sprite 被去重**，用户只看到一块 clip。
5. **幕登记只增不删**：卸载过的 Sprite 的 clip 仍在轨上。
6. **`duration` 非正或非数 → 静默回落 8 秒**，导出时长跟着错。
7. **缩放封顶 1**：相框比舞台大不会放大，只会四周出深灰边。相框尺寸算法见 §10。
8. **播放条要从相框高度里扣**：44px（无幕）或 84px（有幕，默认展开）。忘扣 = 画布被压小 + 左右留边。
9. **`interpolate` / `animate` 不插值颜色**，端点是颜色字符串时到进度 1 才阶跃切换。
10. **`VideoSprite` 用舞台绝对时刻**，不是所在幕的 `localTime`；逐帧导出下与 t 不保证对齐。
11. **`ImageSprite` 给了 `placeholder` 就不加载 `src`**，两个都给也一样。
12. **`Sprite` 的可见区间是闭区间**：相邻幕 `end` 与 `start` 相等的那一瞬两幕同时在场。
13. **`keepMounted` 常驻时窗外照渲**，得自己看 `ctx.visible`。
14. **`fps` 是保留字段**，写了不改变任何行为。
15. **`persistKey` 重名/漏写 → 播放头、编辑表、展开态三样串台。**
16. **剪辑保底闸**：把输出时长删到 0.2 秒以下的编辑**原样不发生**，不提示不报错。
17. **`useTimeline().setTime()` 的入参走输出轴**（用户剪辑后与 `time` 读到的源时刻不再相等）。没有剪辑时两者相同。
18. **CSS `transition` / `@keyframes` 在这套系统里是错的**：相位由挂载时刻决定，scrub 与逐帧导出下不确定。
19. **网络字体一律不用**（不写 `<link>` 拉字体）。理由与替代做法见 dc-authoring 的「字体」一节：
    用系统字体栈，或把字体以 `data:` URI 内联进 `helmet`。导出链路不内联网络字体，用户拿到的成品会落回替身。

---

## 9. 配方词汇表（全是时间纯函数，逐条可抄）

- **crossfade 转场** = 相邻 Beat 区间重叠 ~0.4s（`end=7.0` 接 `start=6.6`）。上一幕 fadeOut 与下一幕 fadeIn 同时进行。
- **级联入场** = 按阅读序每格延迟 24ms：`const appear = 0.5 + (row*7 + col) * 0.024;`
  配 `Easing.easeOutBack` 的 scale 弹出 + 同步淡入。28 格约 0.7s 扫完。
- **count-up 数字** = `Math.round(target * Easing.easeOutCubic(clamp((lt - delay) / 1.1, 0, 1)))`。
  与容器的弹入并行但时长不同（弹入 0.5s、count 1.1s），读起来才不机械。
- **draw-on 折线** = `strokeDasharray` 给大值 + `strokeDashoffset = dash * (1 - progress)`；双线错 0.3s 先后画。
- **圆环进度** = SVG circle，`strokeDasharray = 2πr`、`strokeDashoffset = circ * (1 - pct/100)`、
  `transform:rotate(-90deg)` 让起点朝上，中心大数字同步 count-up。
- **三关键帧推镜** = 整层容器 `transform: scale(...) translate(...)`，
  用 `interpolate([t0,t1,t2], [1, 1, 1.16], Easing.easeInOutCubic)(lt)` 做"停-推-停"，
  `transformOrigin` 定在戏眼（如 `'55% 45%'`）。要每段不同曲线就把 ease 写成数组（§5.6）。
- **Ken Burns 照片** = `<ImageSprite kenBurns kenBurnsScale={1.12} …>`，不用自己算。
- **进度条/擦除** = `RectSprite` 的 `render` 逃生舱口返回 `scaleX(progress)`（§5.4）。
- **正弦呼吸/脉冲** = `1 + Math.sin((lt - phase) * 4) * 0.05`。低频正弦替代 loop 动画，scrub 下确定。
- **常驻背景层** = `Bg` 组件放 `Stage` 直接子级、所有 Beat 之外（§3）。它不是 Sprite，不占剪辑轨。
- **Caption 胶囊字幕** = 底部胶囊（`backdropFilter:'blur(8px)'` + 半透深底），
  用一个 `capOp(lt)` helper 控制每幕中后段淡入、幕尾提前淡出，承担旁白职能。
- **先排版后配图** = 第一版全用 `<ImageSprite placeholder={{ label:'…' }} …>`，节奏立住后再换 `src`。
- **可编程播放** = 需要"点某处跳到第 3 幕"这类交互时用 `useTimeline().setTime(3.2)`，别自己造时钟。
- **节奏纪律**：入场 0.3–0.6s，元素间错峰 0.14–0.18s；每幕 7–10 秒；
  除刻意停顿外画面永远有东西在动；文字/图出现后留"消化秒数"再切。
- **选色**：语义色用 oklch，在同一 L/C 带内选，三个方向**色相相同、只调 L/C 适配底色**——
  `bad: oklch(66% 0.18 25)` / `mid: oklch(82% 0.15 88)` / `good: oklch(78% 0.15 165)` / `accent: oklch(80% 0.14 215)`。
- **分镜**：先 establishing shot 再推近景；元素活在真实语境里（窗口 chrome / 手机壳 / 背景光斑），别漂浮在虚空。

---

## 10. 对比板薄壳与相框尺寸算法

三方向对比板走**画板模式**，三个 `x-import` 引用**同一个场景文件**，只是取不同的全局名。

### 相框尺寸怎么算（算错就左右留深灰边）

舞台在相框里的缩放是 `scale = min(1, 相框宽/舞台宽, (相框高 - 播放条高)/舞台高)`，**且封顶 1**。
播放条高 = **84**（场景用了 Beat → 有幕 → 默认展开）或 44（一个幕都没有）。

所以**先定相框宽，再算相框高**：

```
scale = 相框宽 / 舞台宽          （相框宽 ≤ 舞台宽时；否则 scale 封顶 1）
相框高 = 舞台高 × scale + 84
```

1280×720 的舞台，取相框宽 800：`scale = 800/1280 = 0.625` → `720 × 0.625 = 450` → **相框 800×534**，
正好铺满、零留边。

反例（旧稿的错）：给 `820×520` 装 1280×720 —— 画布可用高只剩 `520 - 84 = 436`，
`scale = min(1, 0.641, 0.606) = 0.606`，画布实宽 776，于是**左右各留 22px 深灰边**，还平白缩小了一档。

`hint-size` 写与相框同尺寸。

### 骨架

```html
<x-dc>
<helmet>
  <meta name="design_doc_mode" content="canvas">
  <style>html,body{ margin:0 }</style>
</helmet>

<div style="position:absolute; left:80px; top:64px; width:2500px;">
  <div style="font:500 12px 'JetBrains Mono','SF Mono',ui-monospace,monospace; letter-spacing:0.14em; text-transform:uppercase; color:#8a7b6a;">学情分析 Agent — 讲解动画</div>
  <h1 style="font:700 40px Optima,'Avenir Next',system-ui; letter-spacing:-0.02em; margin:12px 0 8px;">三个视觉方向 · 同一叙事</h1>
  <p style="font:400 16px -apple-system,'PingFang SC',system-ui; max-width:44em; color:#3c332b;">每段 13 秒讲同一个故事。挑一个方向，我把它扩成完整 ~60 秒讲解片。用 <a href="#1a">1a</a> / <a href="#1b">1b</a> / <a href="#1c">1c</a> 指给我。</p>
</div>

<section id="1a" style="display:inline-flex; flex-direction:column; vertical-align:top; width:800px; margin:150px 40px 40px 0;">
  <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
    <span style="background:#101319; color:#fff; font:500 12px ui-monospace,monospace; padding:3px 8px; border-radius:6px;">1a</span>
    <span style="font:600 15px -apple-system,'PingFang SC',system-ui;">清爽数据仪表盘 · 暖白留白 · 一抹暖橙</span>
  </div>
  <div style="width:800px; height:534px; border-radius:16px; overflow:hidden; box-shadow:0 20px 60px rgba(40,30,15,.14); position:relative;">
    <x-import component-from-global-scope="DirectionA" from="./animations.jsx ./artifact-XXXX.jsx"
              hint-size="800px,534px" style="position:absolute; inset:0; display:block;"></x-import>
  </div>
</section>
<!-- id="1b" 取 DirectionB，id="1c" 取 DirectionC；相框投影颜色跟各自气质走 -->
</x-dc>
```

**间距硬规则**：相框内正文走 8px 间距系统（8/16/24/32）；绝对定位元素彼此 ≥16px；
图例/导航与首行内容 ≥24px；**任何两段文本的包围盒不得相交**——自检会检测文本重叠并要求修复后才能交付。

---

## 11. 交付前自检

对薄壳调 `render_artifact`。产物带 `data-openpipal-video-duration-secs` 时，宿主会**按 10% / 50% / 90%
三个时刻各定格截一帧**，路径回在结果里。逐帧核对：

- 每幕是不是真的在动（三帧画面不同）；
- 有没有黑屏、空幕、裸模板文字、元素飞出画布；
- 文案/数据/品牌名对不对（结果里另有页面文本摘要，取当前定格帧）；
- 剪辑轨上的分段数与名字是不是你想要的（幕数 = 顶层 Sprite 去重后的条数）。

有问题 `edit_artifact` 修**场景那个 id**，修完再收尾。
导出 mp4 后核对返回的分辨率/时长/帧数——时长应等于 `duration`（用户剪过就等于剪辑后的输出时长）。

---

## 12. 反模式（DO NOT）

- ❌ 在 `Stage` 之外调 `useTime()` → 全片定在 t=0（黑屏）。
- ❌ 为拿 `localTime` 给单个元素多包一层 `Sprite` → 多一条剪辑轨。
- ❌ 用 CSS `@keyframes` / `transition` 做强调或循环 → scrub 与逐帧导出下不确定。
- ❌ 自己写 rAF 时钟、自己写播放/暂停控件、自己写"导出视频"按钮（画面上没有导出按钮）。
- ❌ 把引擎或场景内联进薄壳，或预览没立刻出画就 recreate 薄壳 → 撞门闩、进摸索黑洞。
- ❌ 一次 create 一个 30KB 的完整正片场景 → 被 28KB 闸拒 / 被输出上限截断。
- ❌ 三个方向写三份场景代码 → 用一个 `Scene({ theme })` + 三个 theme。
- ❌ 忘给每块 `Stage` 独立 `persistKey` → 播放头、编辑表、展开态串台。
- ❌ 薄壳 `from` 漏写 `./animations.jsx` 前缀或写错场景 id → 场景求值时 `Stage` 不在场。
- ❌ 相框高度不扣播放条 → 画面缩一档、左右留深灰边。
- ❌ Beat 不给 `label` → 用户在剪辑台上看到一排"片段 1/2/3"，认不出哪一幕。

---

**不归这份管**：普通网页的 hover / 点击 / 滚动入场这类微动效**不用本运行时**——
那是内联 `style` 上的 `transition` 与 `helmet` 里的 `@keyframes`（见 dc-authoring 的 `helmet` 一节），
与这里的时间线是两套东西，别把 `Stage` 搬进静态页面。
