/**
 * 流式 JSON 字段提取器
 *
 * 从逐字符到达的 JSON 字符串中实时提取指定字段值。
 * 用于在 AI 生成工具参数（如 create_artifact 的 content）时，
 * 不等 JSON 完整就开始提取 title、type、content 等字段。
 *
 * 状态机：
 *   IDLE → 扫描 key → KEY_FOUND → 跳过冒号和空白 → VALUE_START → 累积 value → VALUE_END → IDLE
 */

type State = 'idle' | 'in_key' | 'before_value' | 'in_value'

export class StreamingJsonExtractor {
  private buffer = ''
  private fields = new Map<string, string>()
  private watchKeys: Set<string>

  // 解析状态
  private state: State = 'idle'
  private currentKey = ''
  private currentValue = ''
  private escaped = false  // 上一个字符是 \

  constructor(watchKeys: string[]) {
    this.watchKeys = new Set(watchKeys)
  }

  /**
   * 追加增量 delta，推进解析状态机。
   */
  feed(delta: string): void {
    this.buffer += delta

    for (const ch of delta) {
      switch (this.state) {
        case 'idle':
          // 寻找 key 的开始引号
          if (ch === '"') {
            this.state = 'in_key'
            this.currentKey = ''
          }
          break

        case 'in_key':
          if (ch === '"') {
            // key 结束，检查是否是我们关注的字段
            if (this.watchKeys.has(this.currentKey)) {
              this.state = 'before_value'
            } else {
              this.state = 'idle'
            }
          } else {
            this.currentKey += ch
          }
          break

        case 'before_value':
          // 跳过 : 和空白，等待 value 的开始引号
          if (ch === '"') {
            this.state = 'in_value'
            this.currentValue = ''
            this.escaped = false
          } else if (ch !== ':' && ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
            // 非字符串值（number/bool/null/object/array），跳过
            this.state = 'idle'
          }
          break

        case 'in_value':
          if (this.escaped) {
            // 处理转义字符
            switch (ch) {
              case '"': this.currentValue += '"'; break
              case '\\': this.currentValue += '\\'; break
              case 'n': this.currentValue += '\n'; break
              case 'r': this.currentValue += '\r'; break
              case 't': this.currentValue += '\t'; break
              case '/': this.currentValue += '/'; break
              // \uXXXX 简化处理：保留原始转义，让后续消费者处理
              default: this.currentValue += '\\' + ch; break
            }
            this.escaped = false
          } else if (ch === '\\') {
            this.escaped = true
          } else if (ch === '"') {
            // value 结束
            this.fields.set(this.currentKey, this.currentValue)
            this.state = 'idle'
          } else {
            this.currentValue += ch
          }
          // 实时更新正在写入的字段（即使未结束）
          if (this.state === 'in_value') {
            this.fields.set(this.currentKey, this.currentValue)
          }
          break
      }
    }
  }

  /**
   * 获取已解析的字段值。字段可能仍在写入中（不完整）。
   */
  getField(name: string): string | undefined {
    return this.fields.get(name)
  }

  /**
   * 获取原始 buffer 长度
   */
  get bufferLength(): number {
    return this.buffer.length
  }

  reset(): void {
    this.buffer = ''
    this.fields.clear()
    this.state = 'idle'
    this.currentKey = ''
    this.currentValue = ''
    this.escaped = false
  }
}
