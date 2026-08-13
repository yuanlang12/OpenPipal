// 为测试中注入的 mock 对象声明全局类型
interface MockBus {
  listeners: Record<string, Function[]>
  on(event: string, fn: Function): () => void
  emit(event: string, ...args: any[]): void
}

interface MockCall {
  method: string
  args?: any
}

declare global {
  interface Window {
    __mockBus: MockBus
    __mockCalls: MockCall[]
  }
}

export {}
