<!-- 生成稳定性诊断 · 多智能体调查 wf_f665ee2d · 4 agents · 5 会话取证 + 代码追踪 -->

I have verified the load-bearing spine directly (adapter id-strip at `pi-event-adapter.ts:403` + `toApiMessages` sending stripped content; no `saveArtifact()` call in `create_artifact`; disk-only `resolveArtifactId`; single global `currentAbort`) and cross-checked against the actual session logs. The two agents' "contradiction" is actually two distinct live mechanisms. Report follows.

---

## OpenPipal 生成稳定性诊断

### 一句话结论

用户把"生成经常中断"和"恢复后找不到文件、来回摸索"当成一个问题,但代码+5 个 design 重度会话的数据表明这是**两件事,且"摸索"是绝对主因、几乎全是自作(self-inflicted),不是真中断丢上下文**。可量化的自作失败/假警约 37 个 tool 结果(找不到 id 9 + render 自检 CSP 假阳性 21 + 内容截断被拒 6 + edit 不匹配 1),而"真被中断后重开、跨会话丢上下文重来"在 5 个会话里 **0 处**;网络级中断信号(Premature close/ECONNRESET/AbortError)**0 次**,显式"已停止"文本 **0 次**。用户感知的"中断"绝大多数是**长时间静默**(read / 自检 / thinking 空转)被读成卡死 —— 用户为此插话"停止了吗/还在处理吗"共 5 次,而每次插话后 agent 都还在跑、还能立刻继续。**摸索才是真痛点,根子是 artifact 产物"存进 store 但不落盘 + id 不进模型可见历史"。**

---

### 根因 1（最痛）:create → render/edit 的"找不到 id"重试循环 —— 两个独立机制叠加

这是"摸索"的头号来源。全库"找不到 id 为 artifact-XXX"命中 9 次,典型一次(e93af0c5 idx69–83)烧掉 4 次失败 render + 1 次无谓重建 = 5 个 tool 步,最后靠**彻底放弃 artifact-id、改写本地文件用 path 渲染**才绕过。同一个报错其实由**两个都还活着的机制**共同制造:

**机制 A —— 竞态:create 在主进程从不落盘,render/edit 只扫磁盘。**
`create_artifact.execute()`(`src/main/pi-tools.ts:686`)只把 id 写进内存 `artifactMetaCache` 并返回 `details.artifact`,**全函数没有任何 `saveArtifact()` / 写盘调用**(grep 确认 pi-tools.ts 内 0 处 `saveArtifact(`)。真正写盘发生在一条 `main → renderer → main` 的异步 IPC 往返末端:`pi-event-adapter.ts` push artifact 事件 → `webContents.send('chat:artifact')` → renderer `onArtifact` → `invoke('artifact:save')` → `ipc-handlers.ts` `saveArtifactToDisk`(唯一写盘点)。而 `render_artifact`/`edit_artifact` 解析 id 走 `resolveArtifactId → listConversationArtifacts → fs.readdirSync`(`artifact-store.ts`,注释明确写"磁盘 sidecar 目录是事实来源"),**既不查内存 metaCache、也拿不到刚返回的 content**。模型在同一 loop 拿到 id 立刻 render 时,渲染器那趟往返往往还没把文件写到盘 → `readdirSync` 命中不到 → 报"找不到 id"。agent 自述的"需要片刻索引/渲染延迟"(idx72/80)是**错觉**:代码里根本没有索引层,就是写盘时间差。

**机制 B —— id 不进模型可见历史:回执被改写剥掉 id。**
这里要修正数据取证组的措辞:`create_artifact.execute()` 的返回文本**其实带 id**(`` `${verb}预览: ${title} (id: ${artifactId})` ``)。但 `src/main/pi-event-adapter.ts:403` 把 create 的 tool_end 结果**改写成 `` `预览: ${details.artifact.title}` `` —— 剥掉了 id**;`chatStore.ts:1167` 又把这个无 id 版当作 tool 消息 `content` 持久化。后续任何一轮 `toApiMessages`(`chatStore.ts:86`,`content: msg.content`)送给模型的历史里,**create 结果就只剩"预览: 标题"、没有 id**。会话日志坐实:idx38/57/65/47/74/141 这些 create 回执持久化内容全是 `"预览: xxx.dc.html"`(无 id),而 `edit_artifact` 因**不在 adapter 的特判分支里、走默认通道**,回执保留了 `(id: artifact-…)`(idx79/153/156)。最扎心的证据 idx71:模型**凭空捏造** create "返回了 (id: artifact-1783403515993)",拿这个猜的 id 去 render,idx70/73 连续失败 —— 因为它历史里根本没有真 id,只能按创建时间戳瞎猜。

**为什么让用户觉得"不稳定":** 猜错 id(机制 B)叠加文件没落盘(机制 A)= 双重 miss。错误提示叫模型"从历史 tool 结果里找 `(id: artifact-…)` 的完整 id 重试",但那段文本恰恰被 adapter 剥掉了、历史里找不到 → 模型误诊成"索引延迟"反复空转 → 用户眼里就是长时间转圈、最后还得换赛道(写本地文件),全程"很多摸索步骤"。

---

### 根因 2:存储身份分裂 —— "恢复后 agent 找不到自己刚产出的文件"

**现象:** 用户插话或开新子任务后,agent 回头引用之前的产物,连续 `read` 报 ENOENT,然后 `ls`/`grep` 满目录找。

**机制(会话原文):** e93af0c5 idx117 agent 自认"反复重试陷入了循环";idx121–123 read 连续 ENOENT;idx125 原话"文件不在本地磁盘 —— 之前是直接走 artifact 交付的,让我找到那些 artifact";idx126–131 连发 bash `ls` 满目录,idx131 才捞出 `/workspace/xuejing-animation/xuejing-film-a.dc.html`。根子是**存储身份二元分裂**:artifact 经 `create_artifact` 存进 artifact store(键是模型看不见的 opaque id,还因根因 1B 不进历史),而模型的心智模型以为产物是**磁盘文件**。一旦需要回引,模型既没有 id、又在盘上找不到(根因 1A:压根没落盘)→ ENOENT → 只能满目录摸。

**为什么让用户觉得"不稳定":** 这正是用户说的"恢复后找不到文件/artifact、需要很多摸索步骤"的机制原文。它和根因 1 同源(都根植于"存 store 不落盘 + id 不可见"),但表现为**恢复阶段**的摸索而非生成阶段的循环,所以用户体感是"接着做就乱套了"。

---

### 根因 3:感知性"中断" —— 长静默 + 自检假阳性 + 唯一的真·中断信号(参数截断)

**现象:** 用户反复问"怎么停止了/还在处理吗/都完成了吗/停止了吗"(5 次:e93af0c5 msg115/134/182、0ea7ad22 msg16、b79cc3ad msg125),但进程并没被杀。

**机制三层:**
- **长静默被误读为卡死。** 每次插话前一步的 messageKind 都是 thinking/tool(任务在飞),且 thinking content 常为空 —— 长链 read/自检/thinking 期间没有 token 流到前端,用户把静默读成"停了"。
- **render 自检假阳性把静默拉长(78%)。** 全库 render 自检报"渲染发现 N 个问题(修完再交)"27 次,其中 **21 次(78%)只是宿主环境固有的 Electron CSP 安全警告**(无害),被当成"必须修完再交"的交付阻断项,于是 read 截图 → 复检 → 再 render,每次假阳性拖一串静默步;真错误(React #130 / dc-runtime error 等)只有 6 次。0ea7ad22 结尾 agent 自己都承认"警告都是 Electron 系统级的(CSP…),不影响实际渲染"—— 却照样为它多跑了自检。
- **唯一的真·生成中断信号 = 参数级截断,不是网络 abort。** `create_artifact` 校验 content 必须以 `</html>` 收尾,收到半截 HTML 即判"疑似超长被截断"拒收,全库 6 次(dcaae0ce 占 5);2/5 会话(b79cc3ad、dcaae0ce)**最后一条停在一个 content 为空、无 artifactRef 的 `create_artifact` 上**,turn 停在没完成的 create 里。这是数据中最接近"异常未收尾"的形态,但成因是**模型工具参数流被输出上限/流切断**,而非进程被杀(网络级 abort 全库 0 次)。

**为什么让用户觉得"不稳定":** 三者叠加把静默期拉长、放大"经常中断"的错觉;真正被切断的只有超长 create 的参数流。

---

### "中断"到底是什么引起的（逐项确切结论，基于代码）

| 途径 | 会 / 不会 / 取决于 | 依据 |
|---|---|---|
| **最小化 / 隐藏窗口** | **不会中断** | `index.ts:149` close 被 `preventDefault()+hide()` 拦成隐藏,不销毁 webContents;全仓无 blur/minimize/hide 钩子调 abort/reload/destroy(仅 `window-tracker` setBounds 重定位)。隐藏时 IPC 通道仍活、chunk 持续投递。 |
| **切换 / 新建会话** | **不 abort,但产物会隐性丢** | `switchConversation`/`newConversation` 均未调 abort,主进程流继续跑、正文经 `bgStreamBufs` 缓冲落库。但后台会话的 tool_end/artifact/visualizer/thinking 约 11 处有 `if (cid !== activeConversationId) return` 守卫 → 这些事件全丢,后台 stream-end 只存纯文本、不挂 artifactRef。表现:"生成没断但图表/工具结果不见了"(半中断/降级)。 |
| **在另一个会话发新消息** | **会中断 ——最可能的真实中断源** | `ipc-handlers.ts:61` `currentAbort` 是**单一全局**变量(注释:"单激活会话模型"),`chat:send` 无条件 `if (currentAbort) currentAbort.abort()`(:156)。会话 A 生成中 → 切到 B → 在 B 发消息 → A 后台流被静默顶掉。这和"后台流应该继续"的预期直接矛盾,最隐蔽。 |
| **点 Stop / 真正退出** | **会**(显式) | Stop 置 `currentAbort=null` → 补发 stream-end,正文残余存为 assistant 消息进历史;退出销毁 webContents。 |
| **权限确认超时** | **不 abort 整个生成** | `pi-security.ts:472` 超时 60s(browser 工具 300s)后 settle(false) 只阻断该工具,agent 带被拒结果继续;但期间 UI 无进展,像卡死。 |
| **网络级 abort(Premature close / ECONNRESET)** | **数据中 0 次,无证据** | 5 会话全无此类信号。 |
| **被打断后能否续接** | 正文能保住,半成品 artifact 会丢;**无专门 continue/resume** | 正文残余存为 assistant 消息进历史;但中途 create_artifact 未走到 tool_end → 残稿被 discard/clearArtifacts 清掉、从不进历史。"继续"靠再发一条消息带全量历史,文本续得上、半成品作废。 |

诚实边界:是否发生过某些**进程级杀流**(如异常退出),现有 5 会话数据既无窗口事件也无 abort 信号,**既不能证实也不能证伪**;但现有信号更支持"静默 + 参数截断 + 跨会话顶流",而非"切窗杀流"。

---

### 修复方案（分优先级 + 工作量）

**P0 —— 修 artifact-id 竞态 + id 可见性（直击根因 1，最小侵入，两处改动）**

- **(a) 同步落盘(治机制 A)。** 在 `create_artifact.execute()` 返回前,当 `conversationId` 存在时直接调 `saveArtifact(conversationId, { id, type, title, content, language })`(`artifact-store.ts` 已导出、`http-server.ts` 已在主进程这么用),再返回 id。这样返回 id 时文件已在盘,`render`/`edit` 的 `readdirSync` 必命中。**侵入=主进程加一行**;renderer 的 `onArtifact` 那次 save 退化为幂等覆盖写、且仍需保留它来挂 artifactRef,故 **renderer 零改动**。⚠️ 必须把 `language` 一并传(否则落成 `<id>.txt` 污染 sidecar 解析,pi-tools.ts:381 已有教训);jsx 场景 saveArtifact 内部会顺带产出 `.compiled.js`,反而提前消除渲染端时序缺口。
- **(b) 回执保留 id(治机制 B)。** 改 `pi-event-adapter.ts:403`,让 create 的 `mcpResult` 保留 `(id: ${id})`(与 `edit_artifact` 一致),后续轮 `toApiMessages` 送给模型的历史就带 id、不必猜。**侵入=改一行字符串。**
- 预期效果:消灭"猜错 id + 文件没落盘"双 miss,直接砍掉 9 次找不到 id + 那条"放弃 artifact 改写本地文件"的整条摸索路径。
- 备选对比:**B 方案**(resolveArtifactId 返回错误前轮询等往返)引入 sleep、且会掩盖真正不存在的 id,不宜作主方案;**C 方案**(主进程建内存 artifact Map,resolve 先查内存直取)治本但要维护内存↔磁盘一致、重启需 fallback,侵入更大。**推荐 A(同步落盘)+ (b)**。

**P1 —— 消除跨会话顶流 + 后台流降级（根因 2 + "中断"最可能真源）**

- 把单一全局 `currentAbort` 改成 `Map<cid, AbortController>`(`ipc-handlers.ts:61/156`),在 B 会话发消息不再 abort A 的后台流。**中等侵入**,直击最易踩、最违背预期的真实中断。
- 后台流不止缓冲 text:把非活跃 cid 的 tool_end/artifact 事件也缓冲/落盘并挂 artifactRef,切回会话 rehydrate 时能看回工具卡/artifact。消除"切走产物就丢"的隐性降级。
- 给 agent 一个"按 id/store 稳定定位产物"的入口(P0 落盘后模型可直接用 path 引用),终结 `ls`/`grep` 满目录的恢复摸索。

**P2 —— 自检降噪 + 静默反馈 + 真·中断收尾（根因 3）**

- render 自检把 Electron CSP 安全警告列入白名单(不计作"问题"),砍掉 78% 假阳性回炉 —— **低侵入、见效直接**。
- 长静默期(read/自检/thinking)给前端心跳/进度提示,缩短用户"停止了吗"的误判窗口。
- `create_artifact` 参数截断(6 次):收到半截 HTML 时提供"继续补全/精简重发"的显式路径而非硬拒;turn 停在空 create 时给"已停止 —— 是否继续"的入口。
- abort/stream-end 时对齐 visualizer 的 `finalizeStreaming`,把半成品 artifact 收尾保住而非 discard。

---

### 一句话总账

"中断"多是错觉(长静默 + 跨会话单一 AbortController 顶流),"摸索"才是主体、且约九成是自作 —— 病根是 artifact 产物**"存进 store 却不落盘 + id 被 adapter 剥出模型历史"**;**P0 两处改动(create 时同步落盘 + 回执保留 id)能同时压掉大半"中断感"和几乎全部"找不到 id/找不到文件"的摸索**,P1/P2 再收尾跨会话顶流、后台降级与自检假阳性。
