# Visualizer 设计文档

## 概述

Visualizer 是一个对话内联的轻量级渲染工具，与 Artifact 形成互补的**双层级渲染系统**。

## 架构定位

```
┌─────────────────────────────────────────────────────────────┐
│                     AI 决策层                               │
│  简单展示 → use_visualizer  |  复杂交互 → use_artifact        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                  独立存储层（不计入上下文）                   │
│  ┌──────────────────┐      ┌──────────────────┐              │
│  │ visualizerStore  │      │  artifactStore   │              │
│  │ (messageId → content)   │  (id → content)  │              │
│  └──────────────────┘      └──────────────────┘              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                     渲染层                                   │
│  ┌─────────────────────┐    ┌─────────────────────┐         │
│  │   VisualizerInline  │    │   ArtifactPanel     │         │
│  │   • 内联渲染        │    │   • 侧边栏持久化    │         │
│  │   • 无状态          │    │   • 可编辑下载      │         │
│  │   • 简单交互        │    │   • 复杂交互        │         │
│  └─────────────────────┘    └─────────────────────┘         │
└─────────────────────────────────────────────────────────────┘
```

## 使用场景对比

| 场景 | 推荐工具 | 原因 |
|------|---------|------|
| 展示一张数据图表 | Visualizer | 简单、一次性、无需交互 |
| 展示代码片段 | Visualizer | 轻量、内联、随消息滚动 |
| 个人简历卡片 | Visualizer | 单页面、展示为主 |
| 完整数据看板 | Artifact | 复杂交互、需独立滚动 |
| 多步骤表单 | Artifact | 需状态保持、长期参考 |
| 代码项目 | Artifact | 多文件、可下载编辑 |

## 技术实现

### 数据模型

```typescript
interface Visualizer {
  id: string           // 唯一标识
  messageId: string    // 关联的消息ID
  type: 'html' | 'svg' | 'chart'
  title: string
  content: string      // HTML/SVG 内容
  height?: number      // 建议高度
  createdAt: number
}
```

### Store 设计

```typescript
interface VisualizerState {
  visualizers: Map<string, Visualizer>  // messageId -> Visualizer
  
  getVisualizer: (messageId: string) => Visualizer | undefined
  setVisualizer: (messageId: string, visualizer: Visualizer) => void
  deleteVisualizer: (messageId: string) => void
}
```

### IPC 协议

```typescript
// 主进程 -> 渲染进程
window.api.onVisualizerCreate(callback: (v: Visualizer) => void)
window.api.onVisualizerUpdate(callback: (id: string, content: string) => void)

// 渲染进程 -> 主进程（可选，用于交互反馈）
window.api.visualizerEvent(id: string, event: string, data: any)
```

### 渲染策略

1. **Shadow DOM 隔离**：每个 Visualizer 使用 Shadow DOM，防止样式污染
2. **高度限制**：默认最大高度 600px，超出显示滚动条
3. **沙箱策略**：禁用 script 标签，仅允许静态展示（可配置）
4. **主题适配**：自动注入 CSS 变量支持 dark/light 模式

### 安全措施

```typescript
function sanitizeHtml(content: string): string {
  // 1. 移除 script 标签
  // 2. 移除事件处理器 (onload, onclick, etc.)
  // 3. 移除危险标签 (iframe, object, embed)
  // 4. 限制 CSS (禁用 position: fixed, etc.)
  return sanitized
}
```

## 与 Tools Search 的协作

Visualizer 本身**不涉及工具调用**，它是**纯展示层**。工具调用仍通过 Tools Search 进行，避免上下文膨胀：

```
User: "展示我的销售数据"

AI: <use_tool_search>
     <query>read sales_data.csv</query>
   </use_tool_search>

[Tools Search 返回数据]

AI: <use_visualizer>
     <type>chart</type>
     <title>销售数据趋势</title>
     <content>[图表HTML]</content>
   </use_visualizer>
```

## 实施计划

### 第一阶段：基础框架
1. [x] 创建设计文档
2. [ ] 实现 `visualizerStore`
3. [ ] 实现 `VisualizerInline` 组件
4. [ ] 添加基础 IPC 协议
5. [ ] 在 `MessageBubble` 中集成

### 第二阶段：完善功能
6. [ ] 实现 Shadow DOM 隔离
7. [ ] 添加 HTML 安全过滤
8. [ ] 实现主题适配
9. [ ] 添加高度自适应
10. [ ] 实现错误边界

### 第三阶段：E2E 测试
11. [ ] 编写基础渲染测试
12. [ ] 测试 Shadow DOM 隔离
13. [ ] 测试安全过滤
14. [ ] 测试主题切换
15. [ ] 性能测试（大量 Visualizer）

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/renderer/src/stores/visualizerStore.ts` | 新建 | Visualizer 状态管理 |
| `src/renderer/src/components/VisualizerInline.tsx` | 新建 | 内联渲染组件 |
| `src/renderer/src/components/MessageBubble.tsx` | 修改 | 集成 Visualizer 渲染 |
| `src/preload/index.ts` | 修改 | 添加 Visualizer IPC API |
| `src/main/ipc-handlers.ts` | 修改 | 添加 Visualizer 事件处理 |
| `src/renderer/src/utils/htmlSanitizer.ts` | 新建 | HTML 安全过滤工具 |

---

## 附录：与 Artifact 的详细对比

| 特性 | Visualizer | Artifact |
|------|-----------|----------|
| **存储位置** | `visualizerStore` (Map) | `artifactStore` (Array) |
| **生命周期** | 随消息，不可独立操作 | 持久化，可切换/关闭/重新打开 |
| **滚动行为** | 随消息流滚动 | 独立滚动区域 |
| **状态保持** | 无（重新渲染即重置） | 有（保持编辑状态、滚动位置） |
| **交互复杂度** | 低（点击、简单hover） | 高（表单、编辑、下载） |
| **多实例** | 每消息一个 | 可同时打开多个，切换查看 |
| **适用内容大小** | 小（< 100KB） | 大（无限制） |
| **主题适配** | 自动（CSS 变量） | 手动（通过 props 传递） |
| **安全沙箱** | Shadow DOM + 标签过滤 | iframe sandbox |

---

文档版本: 1.0  
创建日期: 2026-04-07  
作者: Claude Code  
状态: 设计中
