---
name: three-d-object
description: 3D 物体交付物的说明书——裸 HTML（非 DC）骨架、钉死版本 + SRI 的 three importmap、three-d-stage 舞台的三个属性与两个方法、导出 OBJ+MTL / GLB 的命名纪律、以及一整节"不知道就会踩、踩了不报错"的约束。判据：taskType=3D 物体，或用户要 3D 模型 / 三维物件 / 能转能下载的产品渲染图时必读，写第一行之前读完。这条路不产出 .dc.html，dc-authoring 的模板语法一条都不适用（只沿用它的术语与字体口径）。需要联网：three.js 从 CDN 加载。
---

# 3D 物体（three.js 建模 · three-d-stage 舞台）

一个 3D 物体 = 一个自含的 `.html` 文件，用 `create_artifact(type='html', title='xxx.html')` 交付。
**它不是 Design Component**：没有 `<x-dc>`、没有 `./support.js`、没有空穴 `{{ }}`、没有伪态样式、
没有逻辑块、没有调参面板。dc-authoring 的文件格式在这条路上一条都不适用。

分工只有一句：**你只写建模模块。** 相机、灯、地面、影子、取景、轨道控制、转台、下载工具栏
全部归 `three-d-stage` 这件运行时。它住在 `resources/dc-runtime/three-d-stage.js`，
预览 / 自检 / 导出这些宿主动作会自动把它内联进你的页面。

> 下文所有 `:NNN` 行号都指 `resources/dc-runtime/three-d-stage.js`。

---

## 1. 门闩逃生舱口（漏写就交不出去）

design / teacher 角色的 `type='html'` 交付物默认必须是 DC。判定在
`src/main/openpipal-product-tools.ts:1067`：整页 HTML + 没有 `<x-dc>` + 没有 non-dc 标记
→ `create_artifact` **直接拒收**，内容不落盘。

**统一写法：`<!-- non-dc: 3d-object -->`，放文件第一行**（`<!DOCTYPE html>` 之前）。
正则全文任意位置命中即放行，但仍写第一行——这个字面量与 `src/main/roles/design-role.ts:55`
给 3D 物体形态的写法一致，照抄不要改词。

标题写 `名称.html`，不是 `.dc.html`。

---

## 2. 骨架（可直接抄，每一行都有理由）

three.js **只**通过下面这份钉死的 import map 加载。放 `<head>`、排在任何 module script 之前：

```html
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.184.0/build/three.module.js",
    "three/addons/controls/OrbitControls.js": "https://unpkg.com/three@0.184.0/examples/jsm/controls/OrbitControls.js",
    "three/addons/exporters/OBJExporter.js": "https://unpkg.com/three@0.184.0/examples/jsm/exporters/OBJExporter.js",
    "three/addons/exporters/GLTFExporter.js": "https://unpkg.com/three@0.184.0/examples/jsm/exporters/GLTFExporter.js"
  },
  "integrity": {
    "https://unpkg.com/three@0.184.0/build/three.module.js": "sha384-8FCZ1eVO6it4+pbec2aDtnTrwjWXZLJRC+MAGCIPDgsYnUrl/E0A2YlF8ioMKI/J",
    "https://unpkg.com/three@0.184.0/build/three.core.js": "sha384-dw2ooPewaEIrAgl6oFDBmmBWCE9oW9LxRGcfwZ0hLvEprzo202wXl7vCYHRlSnOT",
    "https://unpkg.com/three@0.184.0/examples/jsm/controls/OrbitControls.js": "sha384-4rziNxOBZKQ69i+w+f89KJ55TCYquwchVbByQwmaOeIOXdOU2PLDn3kOfXHwIJC9",
    "https://unpkg.com/three@0.184.0/examples/jsm/exporters/OBJExporter.js": "sha384-nbwtoZENJD3Vq+ACK0CuGQdPMuDWHkamC2KJD70EV5nfg6jQjfppKOea07YJN+N3",
    "https://unpkg.com/three@0.184.0/examples/jsm/exporters/GLTFExporter.js": "sha384-VofkvpG6HERhFCYbsUOHeNXBCqID2nfqkQqnVzE1jc/oPcz+qJ13ADdXH08hE+cQ"
  }
}
</script>
```

整份骨架：

```html
<!-- non-dc: 3d-object -->
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<!-- ↑ 上面那份 importmap 原样放这里 -->
<style>
  html,body { margin:0; overflow:hidden; background:#f0eee6 }
  three-d-stage:not(:defined) { visibility: hidden; }
  three-d-stage { display: block; width: 100vw; height: 100vh; }
</style>
</head><body>

<three-d-stage name="desk-lamp" background="#f0eee6" autorotate></three-d-stage>
<script src="./three-d-stage.js"></script>

<script type="module">
const stage = document.querySelector("three-d-stage");
const { THREE } = await stage.ready;      // 舞台自己那一份 three，别再另写 import

const model = new THREE.Group();
model.name = "desk-lamp";

// 共享材质：起名，因为名字会成为 OBJ 的 usemtl 与 GLB 的材质名
const brass = new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.34, metalness: 0.4 });
brass.name = "brass";
const enamel = new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.75, metalness: 0 });
enamel.name = "enamel";

// 真实米制：底座直径 22cm、灯杆 42cm
const base = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.115, 0.018, 64), brass);
base.name = "base";
base.position.y = 0.009;
model.add(base);

const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.42, 32), brass);
stem.name = "stem";
stem.position.y = 0.018 + 0.21;
model.add(stem);

const shade = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.11, 48, 1, true), enamel);
shade.name = "shade";
shade.position.y = 0.018 + 0.42 + 0.02;
model.add(shade);

stage.setObject(model);
</script>
</body></html>
```

逐行的理由：

- **importmap 是封闭集合**：四个条目一个不能少、版本号 / URL / 每一位哈希都不能改。
  越界的说明符（清单外的 addon、第二份 three）解析不出来，那一支 `import` 直接抛。
  它必须排在任何 module script 之前，否则解析时它还不在。
- **`<script src="./three-d-stage.js"></script>` 要原样一行。** 宿主用一条正则把整个标签换成
  内联的 `<script type="module">…源码…</script>`（`src/renderer/src/components/artifacts/dcRuntime.ts:21`
  与 `src/main/dc-headless.ts:122`，两处同一条）。正则的硬要求：`src` 恰是 `three-d-stage.js`
  或 `./three-d-stage.js`；标签之间**没有内容**；写成 `></script>` 而不是自闭合。
  **正则不带 `g`，只替换第一处**——写两遍，第二处会留成解析不了的相对路径。
- **建模脚本必须是 `<script type="module">`**：要用顶层 `await`。
- **`:not(:defined)` 那条是 FOUC 防护**；`width:100vw; height:100vh` 决定舞台多大——
  `:host` 自带的只是 `width:100%; height:100%; min-height:320px`（:144），
  body 没有确定高度时会落到 320px 那档，画面变成窄窄一条。

---

## 3. 作者接口全表（就这五样）

| 接口 | 形式 | 默认 | 语义 |
|---|---|---|---|
| `name` | 属性 | `model` | 导出文件基名（`xxx.obj` / `xxx.mtl` / `xxx.glb`）。只在按下下载那一刻读（:258、:655）。路径分隔符、空白、`* ? " < > \|` 一律换成 `-`，`.obj/.mtl/.glb/.gltf` 后缀被剥掉，截到 80 字符，清空后回落 `model`（:99-106） |
| `background` | 属性 | `#f0eee6` | 画布底色，任何 CSS 颜色字符串（用 2D 画布当解析器，:76-87）；解析不出就用默认色。它同时决定半球光的天 / 地色、影子的色相、以及工具栏走浅色还是深色玻璃（相对亮度 < 0.42 翻深，:423） |
| `autorotate` | 布尔属性 | 不在场 | 存在即慢速转台，约 65 秒一圈（:47）。**用户第一次拖拽 / 滚轮 / 触摸后永久停**，之后再加回属性也不恢复（:255、:347-350） |
| `stage.ready` | Promise | — | resolve 出 `{ THREE }`——舞台自己那一份 three 实例。`await` 它再建模，一条来源不会错 |
| `stage.setObject(obj)` | 方法 | — | 交一个 `THREE.Object3D`（通常是具名 `Group`）。不是 Object3D 只留一条 warn、不渲染（:262-268）。可以在 `ready` 之前调，舞台会挂起等启动完（:267、:298）。再调一次会把上一个从场景里摘掉（:440） |

工具栏在 `setObject` 之后才出现（:179 默认 `hidden` → :459 打开）。没交模型就没有下载按钮。

舞台还把 shadow DOM 的三块暴露成 `part="stage" / "toolbar" / "note"`（:178-185），
需要时可以 `three-d-stage::part(toolbar){…}`。默认样式深浅底色都成立，通常不用动。

---

## 4. 运行时已经替你做了什么（别写这些代码）

**布光与画面**

- 三盏平行光（主 / 补 / 轮廓）+ 一盏半球光，色温与光比是摄影棚配方（:24-28）。
  灯位按包围球半径缩放（:535-543），1 厘米的螺丝和 10 米的房子共用同一套布光。**只有主光投影**——
  一个影子才像棚拍。
- 色彩管线：`outputColorSpace = SRGBColorSpace`、`toneMapping = NeutralToneMapping`（:312-314）——
  中性映射只压高光不动色相，你调好的材质色不会被整体拉偏。底色走 `setClearColor` 而不是
  `scene.background`，不过色调映射，给什么色就是什么色（:429）。
- 地面是 `ShadowMaterial` 平面，只在有影子处着色，所以**看得见影子、看不见平面边界**；
  再叠一张径向渐变的接触暗部把物体压在地上（:373-400），位置贴着包围盒最低点（:527-533）。

**取景与相机**

- `setObject` 之后自动算包围盒，把相机放到「8 个角点全部落进视锥」的距离（:467-510）。
  不是"外接球恰好入画"那套——细高件不会被缩成画面中间一根。目标点、缩放上下限、
  `near` / `far` 一并按物体尺度定（:513-525）。
- OrbitControls 已经接好（拖拽旋转 / 滚轮缩放 / 平移 / 阻尼），别自己写。
- `ResizeObserver` + `resize` 双路跟随挂载盒；用户还没动过相机时，容器变形会重新取景（:601-616）。
  DPR 封顶 2。渲染循环是脏标驱动的，没变化就不重绘（:624-633）；元素移出文档即停 rAF（:245-249）。

**影子**

- 你交进来的每个 mesh 都被自动打开 `castShadow` / `receiveShadow`（:443-445）。
- 主光的阴影正交框把「物体 + 它落在地上的影子」一起算进去（:548-572），斜光下影子的尾巴
  不会被裁掉；`normalBias` 按物体尺度走（:596），大模型不漏光、小模型阴影不脱开。
- **`shadowSide` 自动兜底（:446-452）**：three 默认拿背面写深度图，而 `LatheGeometry` /
  `ExtrudeGeometry` / `openEnded` 的圆柱与圆锥这类**单层开放面**，从光的方向压根没有可用的背面——
  影子会**静默消失**。舞台在挂载时给没显式设过的材质补 `shadowSide = DoubleSide`；
  你显式写过就照你的。本技能推荐的建模手法（具名部件 + 开放面）正好会踩这个坑，不用自己防。

**导出**

- 导出器在 `setObject` 时就预热（:463-464），按下按钮时不用再等一次网络往返。
- 导出前给每个 mesh / material 临时补一个 OBJ 安全且唯一的名字，导完**原样还回去**（:708-762）——
  舞台不在你的场景里留副作用。
- **整份 MTL 由舞台生成**（three 的 `OBJExporter` 只写几何、完全不产 MTL）：
  `Kd` 取基色、`Ks` 按 F0 在 0.04 与基色之间随 `metalness` 插值、`Ns` 由 `roughness` 反推、
  `Ke` 取自发光乘 `emissiveIntensity`、`d` 取不透明度（:764-812）。
- `preserveDrawingBuffer: true`（:308）——截图拍得到画面而不是黑帧。自检链路靠它。

**健壮性**

- 幂等注册（同一份源码可能被内联两次，:17-20）。
- WebGL 上下文丢失会在画面中央给提示（:327-330）。
- 所有失败都从 `console.warn('[three-d-stage] …')` 出（:62-64），自检读得到。

所以：不要自己加灯、不要自己摆相机、不要自己接 OrbitControls、不要自己实现下载按钮、
不要给材质手动开 `castShadow`、不要为"舞台没加载"写一套兜底 UI。

---

## 5. 约束与静默失败（不知道就会踩，踩了不报错）

1. **需要联网。** three 与三个 addon 全部从 CDN 取。舞台走**动态** `import()`（:275-278），
   解析失败时元素照常注册、shadowRoot 照常挂上，只在画面中央给一条提示、控制台留
   `[three-d-stage] three.js 模块解析失败`。所以"页面打开了"**不等于**"模型出画了"。
2. **没有 GPU 的环境建不出 WebGL 上下文**：走同一条路子——提示在、元素在、画面没有（:288-294）。
3. **深色 `background` 会把影子和接触暗部吃掉。** 地面只显影子、暗部是黑色渐变，
   底色本身够暗时没有可显示的差值。这是"只显影子"做法的必然结果，不是 bug。
   要影子有存在感就给中浅底色（默认的 `#f0eee6` 正是为此选的）。
4. **没有环境贴图。** 高 `metalness` 的材质没有东西可反射，会渲成近黑，半球光是唯一托底（:30）。
   **`metalness` 封顶 0.4**，金属感靠调亮基色 + 中低 `roughness` 表达。
5. **贴图不会跟着 OBJ 走**：MTL 生成器不写任何贴图条目（:767）。细节靠几何与材质色表达。
6. **多材质 mesh 的 `usemtl` 只会落到首材质**——`OBJExporter` 只读一个 `material.name`（:745-747）。
   要在 OBJ 里分色就拆成多个 mesh，**一个 mesh 一个材质**。
7. **不起名字就拿自动编号。** `o` / `usemtl` 记号取自 `mesh.name` / `material.name`；
   你没给，舞台补 `part_1` / `material_1`（:730、:739），用户在建模软件里看到的就是这些。
   名字里的 `#` 会被删、空白换成 `_`（:108-112）。
8. **OBJ + MTL 是两次下载**，中间隔 400 毫秒（:52、:684-689）——挨太近浏览器会吞掉后一个。
   预览 iframe 的 sandbox 是 `allow-scripts allow-modals allow-downloads`
   （`src/renderer/src/components/artifacts/HtmlPreview.tsx:1902`），浏览器可能弹
   "是否允许下载多个文件"。这是正常现象，交付时告诉用户点允许。
9. **没有任何持久化。** sandbox 没有 `allow-same-origin`，`localStorage` / `sessionStorage`
   访问即抛，舞台一个字节都不存（:121）。相机机位与转台状态不跨刷新。
10. **转台停了不会自己回来**（:347-350）。别指望改属性把它开回去。
11. **`<script src="./three-d-stage.js">` 只有第一处会被内联**（正则不带 `g`），写两遍第二处是死的。
12. **导出格式只有工具栏那两个**：OBJ+MTL（通用，几何 + 每材质颜色）与 GLB（保留部件层级与
    PBR 材质，Blender / Maya / C4D / Unity / Unreal 干净导入）。用户要 FBX / USDZ / STEP 时直说没有。
13. **`export_artifact` 的 handoff 与 project-zip 只收 DC 产物**，这份会被拒
    （`src/main/export-artifact-validate.ts:47`、`:55`）。模型文件的正确出口是让用户点工具栏那两个按钮。

---

## 6. 建模纪律（决定导出文件在建模软件里是否可用）

- **优先组合基本体**：Box / Cylinder / Sphere / Torus / Cone / Lathe / Extrude+Shape。
  真实物件能拆出的基本体远比直觉多；裸 `BufferGeometry` 是最后手段。
- **给每个 mesh 和每个 material 起名**（`hull`、`walnut`、`brass`）。名字直接成为 OBJ 的
  `o` / `usemtl` 与 GLB 的节点名，是用户拿进建模软件第一眼看到的东西（理由见约束 7）。
- **材质用 `MeshStandardMaterial`，共享一个 3-5 个的小调色板**，`roughness` / `metalness`
  有意识地定（上限见约束 4）。一个 mesh 一个材质（理由见约束 6）。
- **真实世界米制、y-up、原点居中、底面落在最低 y。** 舞台按包围盒取景并把地面摆在最低点，
  尺度写错不会报错，只是取景与影子变怪。
- **刻意共面的面错开约千分之一尺度**防 z-fighting。
- **曲面段数**：特征面 32+ 径向段（全屏看着要平滑），看不见的地方别浪费三角形。
- **轮廓先于材质**：产品图的辨识度住在剪影里。先修轮廓与比例，再调材质分离度。
- **建模脚本自成一个 module，别拆文件**——这条路线没有 `x-import`，宿主只内联 `three-d-stage.js` 一件。
- **改模型用 `edit_artifact` 精确替换**（`old_string` 在当前内容里唯一），不重发全文。
- **字体**：这份产物的画面是 canvas，本来就没有文案。真要在页面上加一行说明文字，
  照 dc-authoring 第 7 节的口径用系统字体栈，**绝不写 `<link href="https://fonts.googleapis.com/…">`**
  （那个域名大陆不通、`<link>` 阻塞渲染、导出链路不内联字体）。

---

## 7. 交付前自检：必跑的一步

`create_artifact` 之后、每轮 `edit_artifact` 收尾时调一次 `render_artifact(id)`
（`src/main/openpipal-product-tools.ts:542`）。它在隐藏窗口里真渲染一遍，回传控制台的
warning / error、文本重叠检测、页面文本摘要与一张截图。这份产物要按下面三件事读它：

1. **控制台有没有 `[three-d-stage]` 开头的 warn。** 舞台所有失败都从那里出（:62-64）：
   `three.js 模块解析失败`（没联网 / importmap 被改坏）、`渲染器初始化失败`（没有 WebGL）、
   `setObject 需要一个 THREE.Object3D`（交错了东西）、`导出失败`。
2. **页面文本摘要对这份产物基本是空的**——画面是 canvas，没有文字可摘。
   别把"摘要为空"当成渲染失败，也别指望它替你核对观感。
3. **截图是唯一能判观感的证据**（`preserveDrawingBuffer` 就是为它开的）。逐条看：
   物体是不是舒适入画（不贴边、不缩成一小点）；剪影认不认得出这是什么；
   影子在不在、软不软、有没有贴地；有没有哪块渲成近黑（`metalness` 调太高）。

改完模型再跑一次，从默认取景重新审视。交付前再核一遍骨架三件套：
首行 `<!-- non-dc: 3d-object -->`、importmap 一字未改、`<script src="./three-d-stage.js"></script>` 恰好一处。

最后向用户交代两句：右上角有 **OBJ + MTL** 与 **GLB** 两个下载按钮（OBJ 会连下两个文件，
浏览器可能问一次"允许下载多个文件"）；这个页面需要联网才能打开。
