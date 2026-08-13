// 扩展 Window API 类型定义

export interface PermissionRequestData {
  requestId: string
  tool: string
  args: Record<string, any>
  risk: string
  reason: string
  conversationId?: string
  executionId?: string
}

// window.api 的完整契约唯一维护在 src/preload/index.d.ts；这里仅保留可复用数据类型。
