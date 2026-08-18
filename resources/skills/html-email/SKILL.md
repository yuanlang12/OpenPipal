---
name: html-email
description: 要发进真实邮箱的单文件 HTML 邮件（`.html`，走非 DC 路径）的说明书——门闩逃生舱口的准确写法、table + 全内联的下限、bulletproof 按钮、Outlook 现存的两套渲染引擎、Gmail 的体积裁剪与整块丢 `<style>`、暗色模式反转、以及预览与真实邮箱之间的差距。判据：交付物最终要被邮件工具发出去（taskType=HTML email，或用户说邮件 / EDM / newsletter / 推送周报）就必读；这条路不套 dc-authoring 的文件骨架，写第一行之前读完。
---

# HTML 邮件（单文件 · 非 DC 路径）

一封邮件 = 一个自含的 `.html` 文件，用 `create_artifact(type='html', title='xxx.html')` 交付。
**它不是 Design Component**：没有 `<x-dc>`、没有 `./support.js`、没有空穴、没有调参面板。
dc-authoring 的文件格式在这条路上一条都不适用，唯一共用的是那里的字体口径（见下面第 6 节）。

写邮件的全部难度在一句话里：**收件端不是浏览器。** 每个邮箱客户端各自决定丢掉你写的哪一部分，
而且丢的时候不报错。下面的写法是"三家主流客户端都还能读"的下限，**与常规网页直觉冲突时按这里来**。

---

## 1. 门闩逃生舱口（漏写就交不出去）

design / teacher 角色的 `type='html'` 交付物默认必须是 DC。判定在
`src/main/openpipal-product-tools.ts:1067`：

```js
if (/<html[\s>]/i.test(c) && !/<x-dc[\s>]/i.test(c) && !/<!--\s*non-dc\b/i.test(c)) { …拒绝… }
```

也就是：整页 HTML + 没有 `<x-dc>` + 没有 non-dc 标记 → `create_artifact` **直接拒收**，内容不落盘。

**统一写法：`<!-- non-dc: html-email -->`，放文件第一行（`<!DOCTYPE html>` 之前）。**
这与 `src/main/roles/design-role.ts:55` 给邮件形态的字面量完全一致，照抄不要改词。
正则只认 `<!--` 后跟可选空白再跟 `non-dc`，**全文任意位置命中即放行**——但仍写第一行：
后续维护的人一眼看到"这文件是有意不走 DC 的"，不用全文搜。

---

## 2. 骨架（可直接抄，每一行都有理由）

```html
<!-- non-dc: html-email -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>邮件主题</title>
<style>
  @media only screen and (max-width:620px){
    .col{ display:block !important; width:100% !important }
    .pad{ padding-left:20px !important; padding-right:20px !important }
  }
</style>
</head>
<body style="margin:0; padding:0; background-color:#f2f3f5;">

<!-- preheader：主题行旁边的预览文案，正文里不显示 -->
<div style="display:none; max-height:0; overflow:hidden; opacity:0; mso-hide:all;">
  一句能独立成句的预览文案，别让客户端拿正文开头凑数。
</div>

<!-- 外层满宽表撑底色：Word 引擎不认 body 的 background-color -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background-color:#f2f3f5;">
  <tr>
    <td align="center" style="padding:24px 12px;">

      <!-- 版心表：width 属性 + 内联 width 双写，Word 引擎不认 max-width -->
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:600px; max-width:600px; background-color:#ffffff; border-radius:12px;">
        <tr>
          <td class="pad" style="padding:32px 40px 8px; font-family:Georgia,'Times New Roman',serif; font-size:28px; mso-line-height-rule:exactly; line-height:34px; color:#16181d; font-weight:700;">
            标题一行说清价值
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:8px 40px 24px; font-family:Arial,Helvetica,sans-serif; font-size:16px; mso-line-height-rule:exactly; line-height:26px; color:#3c4149;">
            正文段落。每个可见元素的样式都写在自己的 style 里，不靠上面那个 &lt;style&gt; 块。
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:0 40px 32px;">
            <!-- bulletproof 按钮：带 bgcolor 的 td + 撑满的 a，不是图片、不是 <button> -->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#1f4fd8" style="border-radius:6px;">
                  <a href="https://example.com/action" style="display:block; padding:14px 28px; font-family:Arial,Helvetica,sans-serif; font-size:16px; mso-line-height-rule:exactly; line-height:20px; color:#ffffff; text-decoration:none; font-weight:700;">立即查看</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="pad" style="padding:20px 40px 28px; border-top:1px solid #e4e7ec; font-family:Arial,Helvetica,sans-serif; font-size:12px; mso-line-height-rule:exactly; line-height:18px; color:#6b7280;">
            你收到这封邮件，是因为你订阅了 XX。<br>
            <a href="https://example.com/unsubscribe" style="color:#6b7280; text-decoration:underline;">退订</a>
            · 某某公司 · 某市某区某路 1 号 100000
          </td>
        </tr>
      </table>

    </td>
  </tr>
</table>
</body>
</html>
```

---

## 3. 布局：只有嵌套 table

- 结构一律 `<table role="presentation" cellpadding="0" cellspacing="0" border="0">` 嵌套。
  `role="presentation"` 让读屏软件跳过表格语义，读成普通段落。
- **不用 flex / grid / float / position**——桌面版 Outlook 的 Word 渲染引擎完全不支持这几样，
  它按打印排版的方式理解文档，不是按 CSS 盒模型。
- 版心一张 600px 居中表，纵向单栏流。要"两栏"就写两个 `<td>`，并给它们 `class="col"`，
  靠 `<style>` 里的 media query 在窄屏堆叠——**但要假设 media query 会失效**（§8 第 5 条），
  所以两栏的桌面形态本身也得读得下去。
- 每个 table / td 给**显式宽度**（`width` 属性 + 内联 `width`）。`max-width` 在 Word 引擎里是空气。
- 底色靠满宽表的 `background-color` 撑，不要指望 `<body>` 的背景。

## 4. 样式：全部内联

- **每个可见元素的样式写在它自己的 `style` 属性里。** `<head>` 里的 `<style>` 块只放内联写不了的
  （media query、`:hover`、暗色微调），并且**要当它随时会整块消失来设计**——邮件必须在只有内联样式
  的情况下依然读得通。
- 平台文档给出的 Gmail 行为：`<style>` 只在 `<head>` 里生效；块里出现它认为的语法错误会**整块丢弃**；
  块体积超过约 8KB 同样整块丢弃。所以 `<style>` 要短、要平（不要嵌套 `@`）。
- **任何地方都不许有 JavaScript**（被普遍剥除，不是"可能"）。不引外部样式表。
- 简写属性少用：`padding:32px 40px 8px` 这类在主流客户端可用，但 `background`、`font` 这种
  多值简写在旧客户端解析不稳，拆成单属性更安全。

## 5. Outlook：现在是两套引擎，按低的那套写

- **经典 Outlook for Windows**（2007–2019 及桌面版 Microsoft 365）用 **Word** 作渲染引擎。
  它是本文全部限制的来源：不支持现代布局属性，`border-radius` 不生效（按钮渲染成直角），
  背景图基本无效，行高会被"最高元素"顶开。
- **新版 Outlook for Windows** 换成了 Edge WebView2（Chromium 内核），支持面接近网页。
  两者当前**并存**，收件人用哪个你不知道——所以仍按 Word 引擎的下限写，把新引擎的宽松当白赚。
- `mso-line-height-rule:exactly` 写在**每条 `line-height` 之前**：默认行为下 Word 引擎会为行内最高的
  东西（表情、上标、图片）自动撑高行，把你算好的纵向节奏顶散。
- Outlook 专属补丁包在条件注释里，其它客户端看不见：

```html
<!--[if mso]> …只有 Outlook 会解析的标记或样式… <![endif]-->
```

## 6. 字体、颜色、图片

- **字体走系统字体栈，绝不写网络字体。** 理由和可用的几组栈见 **dc-authoring** 技能的「字体」一节
  （那条对邮件更硬：网络字体在邮件里的落地率本来就低，而 Gmail 的 `<style>` 丢弃规则常被
  嵌套 `@font-face` 触发，连带把整块样式带走）。邮件里安全的栈：
  `Arial, Helvetica, sans-serif` / `Georgia, 'Times New Roman', serif` /
  `Verdana, Geneva, sans-serif` / `'Courier New', monospace`。中文一律靠系统默认，不指定中文字族。
- **暗色模式**：`<meta name="color-scheme">` 与 `<meta name="supported-color-schemes">` 两条都写。
  但要知道各家做法不一样——Apple Mail 一类支持 `prefers-color-scheme` 覆写，Gmail 会剥掉这个媒体查询、
  按自己的规则反转，还有一批客户端做全反转。**能控制的只有配色本身**：避开纯 `#000` / 纯 `#fff`
  当大面积底色，文字与底色的对比度在明暗两种反转下都要成立，logo 与图标别依赖白底透明。
- **视觉靠彩色单元格、边框、间距格和字体搭**，不靠图片。这个环境里**没有可托管图片的地方**：
  你写的相对路径对收件人不存在（§7 与 §8 第 3 条）。必须有图时，留一个明确标注的占位格 + `alt`，
  并在回复里告诉用户"发送前把 `src` 换成托管的 https 绝对地址"。
- 所有图片带 `alt`，`<html>` 带 `lang`，链接是真实 `https` 地址（不要 `#` 死锚点）。

## 7. 宿主替你做了什么（几乎没有——这才是重点）

对**非 DC** 的 `.html` 产物，宿主不注入运行时、不套外壳、不改宽度、不模拟任何邮箱客户端、
不重写你的 CSS。**你交什么，文件里就是什么。** 只有两件事在背后发生，两件都只影响预览：

- 预览把文件塞进一个 `srcdoc` sandbox iframe（无 same-origin）里用 Chromium 渲染。
- 文中引用的 `uploads/xxx.png` 会被读盘换成 `data:` URI（`src/renderer/src/components/artifacts/dcRuntime.ts:232`，
  注释写明"这里只管 srcdoc 预览"）。**交付文件里仍是那条相对路径。**

推论直接进下一节。

## 8. 约束与静默失败（不知道就会踩，踩了不报错）

1. **预览 ≠ 邮箱。** 预览是 Chromium，你的 flex 会好好排、圆角会圆、`<style>` 一条不少。
   这些在经典 Outlook 里会全数失效，而预览永远不会告诉你。**预览只用来看内容和信息层级，
   不用来判断兼容性。**
2. **预览里那个 600px 是你自己写的。** 宿主没有任何邮件相关处理（在
   `src/renderer/src/components/artifacts/HtmlPreview.tsx` 里搜 `email` / `mail` 零命中），
   宽度完全来自你那张 `width="600"` 的版心表。别把"预览看着对"当成兼容性证据。
3. **预览有图 ≠ 收件人有图。** `uploads/` 只在预览内联；发出去的文件里那条相对路径解析不到任何东西。
   即便你手动内联成 `data:` URI 也没用——主流邮箱普遍拦截 `data:` 图片。图片只能是托管的 https 地址。
4. **Gmail 按体积裁剪。** 超过约 102KB 的 HTML 会被折叠到"查看完整邮件"链接后面，
   裁掉的部分包括页脚的退订行。留余量，正文控制在 90KB 以内。
5. **`<style>` 整块消失是常态**，且无任何提示。所以内联样式必须能独立撑住排版。
6. **现代 CSS 被静默剥掉**：没有报错、没有降级提示，收件人只看到一封散架的邮件。
7. **`export_artifact` 六种格式里四种对这个文件无效**：`mp4`（要动画 dc）、`pptx`（要 deck dc）、
   `handoff` 与 `project-zip`（都要 dc）一律被拒，拒绝文案见 `src/main/export-artifact-validate.ts:22-55`。
   `pdf` 和 `standalone-html` 能跑通，但都不是可投递的邮件格式——**邮件的交付物就是这个 HTML 源码本身**，
   由用户粘进他的发信工具。
8. **`List-Unsubscribe` 一键退订头不归你写**——那是发信服务在 SMTP 头里加的。你能做的是正文里那条
   可见的退订链接和邮政地址。商业邮件两者都要有（多数司法辖区的反垃圾邮件法规要求；
   Gmail/Yahoo 自 2024 年起对大批量发信方另有一键退订头的要求，提醒用户在发信工具侧配置）。

## 9. 纪律

- **单栏优先。** 堆叠行在所有客户端和所有屏宽下都成立，并排列不是。每多一栏就多一处窄屏赌注。
- **按钮永远是 padded `<td>`**，不是图片（图片默认不加载就没了 CTA）、不是 `<button>`（不渲染也不可点）。
- **先写文案层级再写样式。** 邮件的阅读时长以秒计：一个主张、一个动作、一条 CTA。
  正文超过三屏就该改成"摘要 + 落地页链接"。
- **preheader 单独写**，不要留空——留空时客户端会抓正文开头（往往是"在浏览器中查看"这种废话）
  当预览文字。
- **写完不要自己声称在 Outlook 里验证过**——你没有。交付时如实说明：这是 send-ready 的 HTML，
  建议用户在真实客户端或邮件测试服务上过一遍再群发。

## 10. 交付前自检

1. `render_artifact(id)` —— 至少确认没有 console 报错、页面结构完整。
   （注意它证明的只是"这段 HTML 是合法网页"，不证明任何邮箱兼容性。）
2. 在自己的产物里逐条搜，命中即改：
   - `<script`（必须零命中）
   - `display:flex` / `display:grid` / `position:` / `float:`（必须零命中）
   - 外链字体的 `<link rel="stylesheet"`（必须零命中）
   - 只写在 `<style>` 块里、内联没有对应值的关键样式（每一处都是一次赌博）
3. 体积：整份 HTML 控制在 90KB 以内。
4. 逐项核对：`lang` 有了 / preheader 有了 / 每张图有 `alt` / 每个链接是真实 https /
   商业邮件有退订行 + 邮政地址 / 每条 `line-height` 前面有 `mso-line-height-rule:exactly`。
5. 回复里交代三件事：这是可直接投入发信工具的 HTML；图片需替换成托管地址；
   建议群发前做一次真实客户端测试。
