/**
 * Pi Event Adapter
 * 将 Pi Agent 的事件映射到 OpenPipal 现有的 AgentEvent 格式。
 * 保持前端零改动——IPC 事件名和 SSE 格式完全不变。
 */

import { StreamingJsonExtractor } from './streaming-json-extractor'
import { compactSubagentCardData } from './tool-content-compactor'
import { capToolResultText } from './context-window-policy'
import type { AgentEvent as OpenPipalAgentEvent } from './agent-runtime/events'
import { tMain } from './main-i18n'
import { sanitizeQuestionsPreview } from '../shared/safe-svg'

export type { AgentEvent as OpenPipalAgentEvent } from './agent-runtime/events'

// Pi Agent 的事件类型（来自 @earendil-works/pi-agent-core）
import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core'

// 需要流式提取 JSON 字段的工具
// questions_v2:参数是 { title, questions:[{...}] } 嵌套结构,不能用扁平 StreamingJsonExtractor
// (会被嵌套的 "title" key 污染),改用下方 extractStreamingQuestions 按括号深度增量提取完整问题对象。
const STREAMING_TOOLS = new Set(['create_artifact', 'create_visualizer', 'questions_v2'])

/** Empty/whitespace-only means "use the localized product default". */
export function normalizeQuestionsPanelTitle(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : ''
}

/**
 * 从（可能不完整的）questions_v2 工具参数 JSON 中增量提取「已成型的完整问题」。
 *
 * 参数结构:{ "title": "...", "questions": [ {id,kind,title,...}, ... ] }。
 * 只返回在 questions 数组里、已闭合且能 JSON.parse 成功的顶层对象——尚未写完的最后一个问题
 * 被自然丢弃,直到它闭合的下一次调用才出现。title 只取 questions 数组之前的顶层 title,
 * 避免被问题对象内嵌套的 title 覆盖。
 *
 * 纯函数,无副作用,供单测直接验证。
 */
export function extractStreamingQuestions(raw: string): { title?: string; questions: any[] } {
  const questions: any[] = []
  const qKeyIdx = raw.indexOf('"questions"')

  // title:只在 questions 数组之前的片段里找顶层 title(避免命中问题对象的 title)
  let title: string | undefined
  const titleScanEnd = qKeyIdx >= 0 ? qKeyIdx : raw.length
  const titleMatch = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw.slice(0, titleScanEnd))
  if (titleMatch) {
    try { title = JSON.parse(`"${titleMatch[1]}"`) } catch { title = titleMatch[1] }
  }

  if (qKeyIdx < 0) return { title, questions }
  const arrStart = raw.indexOf('[', qKeyIdx)
  if (arrStart < 0) return { title, questions }

  let depth = 0
  let objStart = -1
  let inStr = false
  let esc = false
  for (let i = arrStart + 1; i < raw.length; i++) {
    const ch = raw[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') {
      if (depth === 0) objStart = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && objStart >= 0) {
        try { questions.push(JSON.parse(raw.slice(objStart, i + 1))) } catch { /* 未成型/非法,跳过 */ }
        objStart = -1
      }
    } else if (ch === ']' && depth === 0) {
      break // questions 数组闭合
    }
  }
  return { title, questions }
}

/**
 * text-options / multi-chip 的 options 元素规范化：每个元素必须收敛成非空字符串。
 * 弱模型常见坏形状：把选项发成 {label,value} 对象而非字符串（React 渲染字符串位置收到对象
 * 直接抛 #31 崩溃整棵树）。优先取 label（最贴近展示文案），其次 value，再其次 title；
 * number 元素字符串化；其余（null/嵌套对象/空字符串）丢弃。
 */
function sanitizeTextOptions(rawOptions: any): string[] {
  if (!Array.isArray(rawOptions)) return []
  const out: string[] = []
  for (const o of rawOptions) {
    if (typeof o === 'string') {
      const s = o.trim()
      if (s) out.push(s)
      continue
    }
    if (typeof o === 'number' && Number.isFinite(o)) {
      out.push(String(o))
      continue
    }
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const cand = [o.label, o.value, o.title].find((v) => typeof v === 'string' && v.trim())
      if (cand) out.push(cand.trim())
    }
  }
  return out
}

/**
 * svg-options 的 options 元素规范化：每个元素必须收敛成含字符串 value 的对象。
 * 字符串元素 → 包装成 {value, label}；对象缺 value 但有 label → 补 value=label；
 * 都没有则丢弃该选项（svg-options 的默认值没有意义，不能兜底猜一个）。
 *
 * 预览图单独判生死：模型给的 svg 字段只有「能离线渲染」的两种形态算数——静态 SVG 白名单
 * 之后仍成立的内联标记，或形状合法的 data:image/* URI。外链（http(s)：产物沙箱断网 + CSP）、
 * 坏 base64、畸形/不闭合 SVG 一律判为无预览。**丢的只是预览，不是选项**——选项文字照常
 * 可选，渲染层给中性占位卡，用户不该看到浏览器裂图。
 */
function sanitizeSvgOptions(rawOptions: any): Record<string, any>[] {
  if (!Array.isArray(rawOptions)) return []
  const out: Record<string, any>[] = []
  for (const o of rawOptions) {
    if (typeof o === 'string') {
      const s = o.trim()
      if (s) out.push({ value: s, label: s })
      continue
    }
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const value = typeof o.value === 'string' && o.value.trim() ? o.value.trim() : undefined
      const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : undefined
      const preview = sanitizeQuestionsPreview(o.svg)
      const svg = preview ? { svg: preview } : {}
      if (value) { out.push({ value, ...(label ? { label } : {}), ...svg }); continue }
      if (label) { out.push({ value: label, label, ...svg }); continue }
    }
  }
  return out
}

/**
 * questions_v2 execute 阶段的坏形状规范化。
 *
 * 弱模型常见坏形状：整个问题元素发成纯字符串、对象缺 id/kind/title/options，或者 options
 * 数组里的**叶子元素**发胖成对象（如 {label,value}）而非期望的字符串/svg-option 形状——
 * QuestionsV2Panel 把叶子元素当字符串直接渲染，对象穿透进去会触发 React error #31 崩掉整棵树。
 * pi-tools.ts 的 questions_v2 schema 已经把元素类型放宽成 Union<对象|字符串> 且对象字段全
 * Optional（否则 Pi 框架会在校验层直接拒绝整条 tool call，execute 根本收不到参数）——这里
 * 一并补齐语义默认值和叶子形状：
 * - 字符串元素 → 包成默认 text-options（options: 是/否）
 * - 对象元素缺 id/kind/title → 补默认值
 * - text-options/multi-chip 的 options：按 sanitizeTextOptions 收敛成字符串数组，收敛后为空则兜底是/否
 * - svg-options 的 options：按 sanitizeSvgOptions 收敛成 {value,...} 对象数组，收敛后为空则降级为
 *   text-options + 是/否（svg-options 没有有意义的默认视觉选项，降级比硬凑一个更安全）
 * - 无法规范化的元素（非字符串非对象、空字符串）被丢弃
 *
 * 纯函数、无副作用，供 pi-tools.ts execute() 和 pi-event-adapter 流式 delta 两处调用，也供单测直接验证。
 */
export function normalizeQuestionsV2Items(rawQuestions: any[]): Record<string, any>[] {
  // 部分兼容模型会把整个 questions 数组 JSON.stringify 后，作为数组里唯一的字符串元素发来。
  // 能还原时先展开；JSON 本身损坏时也不要把一长段原始 JSON 当题目展示给用户。
  const expandedQuestions: any[] = []
  for (const raw of rawQuestions) {
    if (typeof raw === 'string') {
      const text = raw.trim()
      if (text.startsWith('[') && text.endsWith(']')) {
        try {
          const parsed = JSON.parse(text)
          if (Array.isArray(parsed)) {
            expandedQuestions.push(...parsed)
            continue
          }
        } catch {
          expandedQuestions.push({
            kind: 'text-options',
            title: tMain('runtimeChrome.questions.malformedTitle'),
            options: [
              tMain('runtimeChrome.questions.malformedAccurate'),
              tMain('runtimeChrome.questions.malformedAdjust'),
              tMain('runtimeChrome.questions.malformedRetry')
            ]
          })
          continue
        }
      }
    }
    expandedQuestions.push(raw)
  }

  let autoIdx = 0
  return expandedQuestions
    .map((q: any) => {
      autoIdx++
      if (typeof q === 'string') {
        return q.trim() ? {
          id: `q${autoIdx}`,
          kind: 'text-options',
          title: q,
          options: [tMain('runtimeChrome.questions.yes'), tMain('runtimeChrome.questions.no')]
        } : null
      }
      if (q && typeof q === 'object' && !Array.isArray(q)) {
        const kind = typeof q.kind === 'string' && q.kind ? q.kind : 'text-options'
        const id = typeof q.id === 'string' && q.id ? q.id : `q${autoIdx}`
        const title = typeof q.title === 'string' && q.title
          ? q.title
          : tMain('runtimeChrome.questions.generatedTitle', { index: autoIdx })

        if (kind === 'svg-options') {
          const sanitized = sanitizeSvgOptions(q.options)
          if (sanitized.length === 0) {
            // 无可用视觉选项：降级为 text-options + 是/否,而不是硬凑一个没有意义的默认视觉块
            return {
              ...q,
              id,
              kind: 'text-options',
              title,
              options: [tMain('runtimeChrome.questions.yes'), tMain('runtimeChrome.questions.no')]
            }
          }
          return { ...q, id, kind, title, options: sanitized }
        }

        if (kind === 'text-options' || kind === 'multi-chip') {
          const sanitized = sanitizeTextOptions(q.options)
          return {
            ...q,
            id,
            kind,
            title,
            options: sanitized.length > 0
              ? sanitized
              : [tMain('runtimeChrome.questions.yes'), tMain('runtimeChrome.questions.no')]
          }
        }

        return { ...q, id, kind, title }
      }
      return null
    })
    .filter((q): q is Record<string, any> => q !== null)
}

/** 无渲染层的落盘方（scheduler / ACP）从事件流还原出的一轮记录：助手正文段 + 工具轨迹，按事件顺序 */
export type TranscriptEntry =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; toolName: string; toolCallId?: string; content: string; toolArgs?: string; searchResults?: string }

/**
 * 从 agentChat 事件流收集这一轮的落盘素材（无渲染层的落盘方，如 scheduler / ACP 用）。
 * 助手正文按 text_flush 边界切段；Pi 在 tool 前后以及 message_end fallback 都可能发 text 事件
 * （streaming delta + fallback 完整文本），需要包含式去重——朴素 += 会把同段文本记两份。
 *
 * 工具轨迹同样收（口径同 chatStore 后台会话落盘：content=mcpResult /
 * toolArgs=modelToolArgs ?? mcpArgs，
 * 截图 base64 刻意不带）——ACP 客户端无状态，服务端不落工具消息则下一轮无从回放。
 * 顺序按事件到达排：PiEventAdapter 在 tool 执行前必发 text_flush，所以正文段与工具天然交错。
 */
export function createTranscriptCollector(): {
  feed: (event: { type: string; content?: unknown; [k: string]: unknown }) => void
  finish: () => string
  finishTranscript: () => TranscriptEntry[]
  finishRuntimeContext: () => { text: string; timestamp: number } | undefined
} {
  const segments: string[] = []
  const entries: TranscriptEntry[] = []
  let currentSegment = ''
  let runtimeContext: { text: string; timestamp: number } | undefined
  const commit = (): void => {
    const s = currentSegment.trim()
    currentSegment = ''
    if (!s || segments.some(existing => existing.includes(s) || s.includes(existing))) return
    segments.push(s)
    // 相邻正文段并进同一条助手消息——无工具的一轮落盘形状与只收文本时逐字节一致
    const last = entries[entries.length - 1]
    if (last?.kind === 'text') last.content += '\n\n' + s
    else entries.push({ kind: 'text', content: s })
  }
  return {
    feed(event) {
      if (event.type === 'text' && typeof event.content === 'string') currentSegment += event.content
      else if (event.type === 'text_flush') commit()
      // 重连是整轮重发，模型从零重写：本次尝试已累积的半截正文必须丢掉，
      // 否则第一次尝试的残句会和第二次的完整答案粘成一条落进历史。
      // （渲染层在 chatStore 的 onStreamRetry 里做同一件事；这里是无渲染层的那两条路
      //  ——定时任务与 ACP——唯一的写侧。）
      else if (event.type === 'stream_retry') currentSegment = ''
      // 本轮 RC 快照，主进程在 turn 开跑时广播一次。桌面由渲染层落盘，服务端两条路（ACP /
      // 定时任务）没有渲染层，只能在这里接住——不落盘则下轮无快照可回放，前缀缓存从这条消息
      // 断掉（pi-message-conversion.buildRuntimeContextMessage 要求回放与实发逐字节一致）。
      // 时间戳取事件到达时刻而非落盘时刻：它同时是 UI 的“agent 开跑”锚点（groupTurns.ts）。
      else if (event.type === 'runtime_context' && typeof event.text === 'string' && event.text) {
        runtimeContext = { text: event.text, timestamp: Date.now() }
      }
      else if (event.type === 'tool_end') {
        commit() // 兜底：适配器没来得及 flush 时也不让正文错位到工具之后
        const searchResults = typeof event.searchResults === 'string' ? event.searchResults : undefined
        const content = typeof event.mcpResult === 'string' && event.mcpResult
          ? event.mcpResult
          : (searchResults || '')
        // 无名/无载荷的工具（纯截图/可视化事件另有通道）不落盘：既回放不出去，也会在会话列表里留空卡
        if (!event.name || (!content && !searchResults)) return
        entries.push({
          kind: 'tool',
          toolName: String(event.name),
          toolCallId: typeof event.toolCallId === 'string' ? event.toolCallId : undefined,
          content,
          toolArgs: typeof event.modelToolArgs === 'string'
            ? event.modelToolArgs
            : (typeof event.mcpArgs === 'string' ? event.mcpArgs : undefined),
          searchResults
        })
      }
    },
    finish() {
      commit()
      return segments.join('\n\n')
    },
    finishTranscript() {
      commit()
      return entries
    },
    finishRuntimeContext() {
      return runtimeContext
    }
  }
}

// 流式 delta 节流：至少间隔 N 字符才发一次（小值 = 更流畅的渲染）
const DELTA_THROTTLE_CHARS = 30
// 运行期提取目标文件路径的工具(参数流里带 path/file_path)——进度事件顺带携带,前端显示文件名
const FILE_PATH_TOOLS = new Set(['edit', 'write', 'read'])
// 首次有 content 内容时立即发送 delta（不受节流限制），加快首屏渲染
const FIRST_CONTENT_IMMEDIATE = true

/**
 * 有状态的事件适配器。
 * 跟踪文本缓冲，在工具执行开始前自动发出 text_flush。
 * 对 create_artifact / create_visualizer 工具，流式提取 JSON 字段并发送 delta 事件。
 */
export class PiEventAdapter {
  private textBuffer = ''
  private isThinking = false
  private hasStreamedThinking = false  // 标记是否已通过 delta 流式输出过 thinking
  private hasStreamedText = false      // 同理，防止 message_end fallback 重复发送已流式的 text
  private activeToolName = ''
  private activeToolCallId = ''
  private toolArgBuffer = ''
  private toolArgBuffers = new Map<string, string>()
  private startedToolCallIds = new Set<string>()

  // 流式 artifact/visualizer 状态
  private streamingId = ''
  private jsonExtractor: StreamingJsonExtractor | null = null
  // 文件类工具运行期就显示目标文件名("编辑 xxx.tsx 中...")——按调用缓存首个提取到的 path
  private toolPathByCallId = new Map<string, string>()
  private lastDeltaChars = 0  // 上次发 delta 时的字符数
  private lastSentContent = ''  // 上次已发出的 content 前缀——delta 增量协议的生产侧水位
  private lastProgressChars = 0  // 上次发 tool_progress 时的字符数(按当前工具调用计数,调用结束重置)

  // 流式 questions_v2 状态(不走 jsonExtractor,用 extractStreamingQuestions 括号深度提取)
  private questionsTitleSent = false
  private lastQuestionsSig = ''  // `${count}|${title}` 变化才发新 delta,防重复

  adapt(piEvent: PiAgentEvent): OpenPipalAgentEvent[] {
    const events: OpenPipalAgentEvent[] = []

    switch (piEvent.type) {
      case 'message_update': {
        const event = piEvent.assistantMessageEvent as any
        if (!event) break

        // 新版 Pi 事件格式（text_delta / thinking_delta）
        if (event.type === 'thinking_delta' || event.type === 'thinking_start') {
          this.isThinking = true
          this.hasStreamedThinking = true
          const delta = event.delta || ''
          if (delta) {
            events.push({ type: 'thinking', content: delta })
          }
          break
        }

        if (event.type === 'thinking_end') {
          this.isThinking = false
          events.push({ type: 'thinking_end' })
          break
        }

        if (event.type === 'text_delta' || event.type === 'text_start') {
          // 从 thinking 切到 text 时，结束 thinking
          if (this.isThinking) {
            this.isThinking = false
            events.push({ type: 'thinking_end' })
          }
          const delta = event.delta || ''
          if (delta) {
            this.textBuffer += delta
            this.hasStreamedText = true
            events.push({ type: 'text', content: delta })
          }
          break
        }

        // 工具调用开始：从 partial message 中提取工具名，立即显示工具指示器
        if (event.type === 'toolcall_start') {
          // flush 文本和 thinking
          if (this.textBuffer) {
            events.push({ type: 'text_flush' })
            this.textBuffer = ''
          }
          if (this.isThinking) {
            this.isThinking = false
            events.push({ type: 'thinking_end' })
          }
          // 从 partial message 中提取工具名
          const partial = event.partial as any
          const toolBlock = partial?.content?.[event.contentIndex]
          const toolName = toolBlock?.name || toolBlock?.toolName || ''
          const toolCallId = toolBlock?.id || `content-${event.contentIndex}`
          this.activeToolName = toolName
          this.activeToolCallId = toolCallId
          this.toolArgBuffer = ''
          this.toolArgBuffers.set(toolCallId, '')
          this.lastProgressChars = 0  // tool_progress 节流计数按本次调用重置(所有工具都发 progress,不止 STREAMING_TOOLS)

          if (toolName) {
            this.startedToolCallIds.add(toolCallId)
            events.push({ type: 'tool_start', name: toolName, toolCallId })
          }

          // 为支持流式预览的工具初始化提取状态
          if (STREAMING_TOOLS.has(toolName)) {
            this.streamingId = `streaming-${Date.now()}`
            this.lastDeltaChars = 0
            this.lastSentContent = ''

            if (toolName === 'questions_v2') {
              // questions_v2 走括号深度提取器,不初始化 jsonExtractor(扁平提取器会被嵌套 title 污染)
              this.jsonExtractor = null
              this.questionsTitleSent = false
              this.lastQuestionsSig = ''
              // 立即发空 delta,触发前端开 questions tab 占位
              events.push({ type: 'questions_v2_delta', id: this.streamingId, title: '', questions: [] })
            } else {
              this.jsonExtractor = new StreamingJsonExtractor(['type', 'title', 'content', 'height', 'language'])
              // 立即发空 delta，触发前端打开面板/预留位置
              if (toolName === 'create_artifact') {
                events.push({ type: 'artifact_delta', id: this.streamingId, delta: '', offset: 0 })
              } else {
                events.push({ type: 'visualizer_delta', id: this.streamingId, delta: '', offset: 0 })
              }
            }
          }
          break
        }

        // 工具调用增量：流式提取字段或显示进度
        if (event.type === 'toolcall_delta') {
          const delta = event.delta || ''
          if (!delta) break

          const partial = event.partial as any
          const toolBlock = partial?.content?.[event.contentIndex]
          const toolCallId = toolBlock?.id || this.activeToolCallId || `content-${event.contentIndex}`
          const toolName = toolBlock?.name || toolBlock?.toolName || this.activeToolName
          this.activeToolCallId = toolCallId
          this.activeToolName = toolName
          this.toolArgBuffer += delta
          this.toolArgBuffers.set(toolCallId, (this.toolArgBuffers.get(toolCallId) || '') + delta)

          // 流式工具：提取 JSON 字段，发 delta 事件
          if (this.jsonExtractor && this.streamingId) {
            this.jsonExtractor.feed(delta)
            const content = this.jsonExtractor.getField('content') || ''
            const charsSinceLastDelta = this.toolArgBuffer.length - this.lastDeltaChars

            // 首次检测到 content 时立即发送（不等节流），加快首屏渲染
            const isFirstContent = FIRST_CONTENT_IMMEDIATE && content.length > 0 && this.lastDeltaChars === 0
            // 节流：每 DELTA_THROTTLE_CHARS 字符发一次
            if (isFirstContent || charsSinceLastDelta >= DELTA_THROTTLE_CHARS) {
              this.lastDeltaChars = this.toolArgBuffer.length
              const title = this.jsonExtractor.getField('title')
              const artifactType = this.jsonExtractor.getField('type')

              // O(n) 增量:只发上次之后的新增子串。提取器理论上是单调追加的;
              // 万一它修正了已发前缀(escape 边界等罕见情形),回退 offset=0 全量重放自愈
              let deltaOut: string
              let offsetOut: number
              if (content.startsWith(this.lastSentContent)) {
                offsetOut = this.lastSentContent.length
                deltaOut = content.slice(offsetOut)
              } else {
                offsetOut = 0
                deltaOut = content
              }
              this.lastSentContent = content

              if (this.activeToolName === 'create_artifact') {
                events.push({
                  type: 'artifact_delta',
                  id: this.streamingId,
                  title,
                  artifactType,
                  delta: deltaOut,
                  offset: offsetOut
                })
              } else if (this.activeToolName === 'create_visualizer') {
                const heightStr = this.jsonExtractor.getField('height')
                events.push({
                  type: 'visualizer_delta',
                  id: this.streamingId,
                  title,
                  delta: deltaOut,
                  offset: offsetOut,
                  height: heightStr ? parseInt(heightStr, 10) || undefined : undefined
                })
              }
            }
          } else if (this.streamingId && this.activeToolName === 'questions_v2') {
            // questions_v2:每当有新问题闭合(delta 含 '}')或标题尚未捕获时,重解析整段 buffer。
            // 用 '}'-gate 把全量重扫限定在对象边界,避免逐字符 delta 造成 O(n²)。
            if (delta.includes('}') || !this.questionsTitleSent) {
              const { title, questions: rawQuestions } = extractStreamingQuestions(this.toolArgBuffer)
              // 流式预览稿也要过同一套坏形状收敛——弱模型的对象选项元素在这里就已经成型,
              // 不能只在 execute() 终态收敛,否则 QuestionsV2Panel 在流式阶段先崩一次。
              const questions = normalizeQuestionsV2Items(rawQuestions)
              if (title) this.questionsTitleSent = true
              const sig = `${questions.length}|${title || ''}`
              if (sig !== this.lastQuestionsSig) {
                this.lastQuestionsSig = sig
                events.push({ type: 'questions_v2_delta', id: this.streamingId, title, questions })
              }
            }
          }

          // 所有工具都发 progress（前端显示字符数）—— 节流:同 artifact_delta 的按字符数门槛(30),
          // 避免每个原始 delta chunk 都发一次 IPC。首次立即发(即时反馈),之后按 tool call 计数、
          // 满 DELTA_THROTTLE_CHARS 才发。tool_end 有自己的完整 payload,最终状态不受影响——
          // 这里只是粗粒度字符计数器,无 UX 变化。
          // edit/write/read:从累积参数流里提取目标文件路径(每调用一次)——运行中即可显示
          // "编辑 xxx.tsx 中..."而不必等 tool_end 才有 args(评审 ChatUI 对标 P2 项)
          let pathJustFound = false
          if (FILE_PATH_TOOLS.has(this.activeToolName) && !this.toolPathByCallId.has(toolCallId)) {
            const pm = /"(?:file_path|path|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(this.toolArgBuffers.get(toolCallId) || '')
            if (pm) {
              let p = pm[1]
              try { p = JSON.parse(`"${pm[1]}"`) } catch { /* 罕见转义失败,原样展示 */ }
              this.toolPathByCallId.set(toolCallId, p)
              pathJustFound = true
            }
          }

          const progressChars = this.toolArgBuffer.length
          const isFirstProgress = FIRST_CONTENT_IMMEDIATE && this.lastProgressChars === 0 && progressChars > 0
          // 路径刚提取到时不等节流立即发一次——文件名上屏时机就是价值本身
          if (isFirstProgress || pathJustFound || progressChars - this.lastProgressChars >= DELTA_THROTTLE_CHARS) {
            this.lastProgressChars = progressChars
            events.push({
              type: 'tool_progress',
              name: this.activeToolName,
              chars: progressChars,
              toolCallId,
              path: this.toolPathByCallId.get(toolCallId)
            })
          }
          break
        }

        // 旧版 Pi 事件格式（content 对象）
        if (event.type === 'content' && event.content?.type === 'text') {
          const delta = event.content.text
          if (delta) {
            this.textBuffer += delta
            this.hasStreamedText = true
            events.push({ type: 'text', content: delta })
          }
        }
        break
      }

      case 'message_end': {
        if (this.isThinking) {
          this.isThinking = false
          events.push({ type: 'thinking_end' })
        }
        // 非流式回退：某些 provider 不发 message_update，完整文本在 message_end 中
        const msg = piEvent.message as any
        if (msg?.role === 'assistant' && !this.textBuffer && Array.isArray(msg.content)) {
          // 先输出 thinking 内容（仅在未流式输出过时才发，避免重复）
          if (!this.hasStreamedThinking) {
            for (const block of msg.content) {
              if (block.type === 'thinking' && block.thinking) {
                console.log(`[Adapter] message_end fallback thinking (${block.thinking.length} chars)`)
                events.push({ type: 'thinking', content: block.thinking })
                events.push({ type: 'thinking_end' })
              }
            }
          }
          // 再输出 text 内容（仅在未流式输出过时才发，避免重复——
          // 工具调用前 textBuffer 会被 toolcall_start flush 为空，此时仅靠
          // !this.textBuffer 不够判，必须显式查 hasStreamedText）
          if (!this.hasStreamedText) {
            const text = msg.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('')
            if (text) {
              events.push({ type: 'text', content: text })
            }
          }
        }
        break
      }

      case 'tool_execution_start': {
        if (this.textBuffer) {
          events.push({ type: 'text_flush' })
          this.textBuffer = ''
        }
        if (this.isThinking) {
          this.isThinking = false
          events.push({ type: 'thinking_end' })
        }
        const startName = piEvent.toolName
        const toolCallId = piEvent.toolCallId
        this.activeToolName = startName
        this.activeToolCallId = toolCallId
        if (!this.toolArgBuffers.has(toolCallId)) {
          this.toolArgBuffers.set(toolCallId, JSON.stringify(piEvent.args || {}))
        }
        // 如果 toolcall_start 已经发过 tool_start，不重复发送
        if (!this.startedToolCallIds.has(toolCallId)) {
          this.startedToolCallIds.add(toolCallId)
          events.push({ type: 'tool_start', name: startName, toolCallId })
        }
        // 注意：不清空 toolArgBuffer — tool_execution_end 还要用它（提取 path 等参数显示在 UI）
        break
      }

      case 'tool_execution_end': {
        const result = piEvent.result as any

        // 保存当前 tool 的 args JSON（将在分支里被用来附加到 tool_end 事件）
        // 然后清理流式状态（包括 toolArgBuffer，为下一个 tool 腾位）
        const toolCallId = piEvent.toolCallId
        const currentToolArgs = this.toolArgBuffers.get(toolCallId) || ''
        this.toolArgBuffers.delete(toolCallId)
        this.startedToolCallIds.delete(toolCallId)
        this.jsonExtractor = null
        this.streamingId = ''
        this.lastDeltaChars = 0
        this.lastSentContent = ''
        this.lastProgressChars = 0
        this.questionsTitleSent = false
        this.lastQuestionsSig = ''
        if (this.activeToolCallId === toolCallId) {
          this.activeToolName = ''
          this.activeToolCallId = ''
          this.toolArgBuffer = ''
        }

        const name = piEvent.toolName
        const details = result?.details

        if (name === 'capture_screenshot' && details?.screenshot) {
          events.push({
            type: 'tool_end',
            name,
            toolCallId,
            screenshot: details.screenshot,
            mcpResult: '已捕获截图',
            mcpArgs: currentToolArgs || undefined
          })
        } else if (name === 'web_search' && details?.searchResults) {
          const searchText = capToolResultText(
            typeof details.searchResults === 'string'
              ? details.searchResults
              : JSON.stringify(details.searchResults)
          )
          events.push({
            type: 'tool_end',
            name,
            toolCallId,
            searchResults: searchText,
            mcpResult: searchText,
            mcpArgs: currentToolArgs || undefined
          })
        } else if (name === 'ask_user' && details?.askUser) {
          events.push({
            type: 'ask_user',
            question: details.askUser.question,
            options: details.askUser.options,
            fields: details.askUser.fields
          })
        } else if (name === 'questions_v2' && details?.questionsV2) {
          events.push({
            type: 'questions_v2',
            title: details.questionsV2.title,
            questions: details.questionsV2.questions
          })
        } else if (name === 'create_artifact' && details?.artifact) {
          // 顺序很关键：先发 tool_end → chatStore 把 create_artifact tool 消息 push 到 messages
          // 再发 artifact → onArtifact handler 才能找到那条消息并挂 artifactRef（持久化关键链）
          // 反过来会导致 artifactRef 找不到落点 → JSON 里没 ref → 切会话 / 重启后 artifact 消失
          // 工具轨迹跨轮原样回放；实际 toolCall 入参随回执一起落盘，不在 assistant
          // 消费后改写成占位。接近上下文上限时由整体历史压缩统一总结。
          events.push({
            type: 'tool_end',
            name,
            toolCallId,
            mcpResult: `预览: ${details.artifact.title} (id: ${details.artifact.id})`,
            mcpArgs: currentToolArgs || undefined
          })
          events.push({ type: 'artifact', artifact: details.artifact, toolCallId })
        } else if (name === 'subagent' && details?.subagent) {
          // subagent 工具：inline 折叠展示在 chat panel 内（不进 Workspace 侧栏）。
          // mcpResult 保留完整 finalText（只受统一单条工具结果上限约束）；
          // mcpArgs = cardData JSON 供 UI 展开，modelToolArgs = 模型实际调用入参供跨轮回放。
          // child transcript 经 compactSubagentCardData 收窄后才落 conversation.json——
          // 未压缩的完整过程实测可到上百 KB/卡，会拖累每次自动保存的整文件重写与展开时的 parse。
          const sub = details.subagent
          const finalText: string = sub.finalText || ''
          const cardData = JSON.stringify(compactSubagentCardData({
            profile: sub.profileName,
            modelId: sub.modelId,
            usage: sub.usage,
            task: sub.task,
            persona: sub.persona,
            messages: sub.messages,
            finalText: sub.finalText,
            stopReason: sub.stopReason,
            errorMessage: sub.errorMessage,
          }))
          events.push({
            type: 'tool_end',
            name,
            toolCallId,
            mcpResult: capToolResultText(finalText) || '(子 agent 无输出)',
            mcpArgs: cardData,
            modelToolArgs: currentToolArgs || undefined
          })
        } else if (name === 'create_visualizer' && details?.visualizer) {
          const vizMessageId = `viz-msg-${Date.now()}`
          events.push({
            type: 'visualizer',
            visualizer: { ...details.visualizer, messageId: vizMessageId }
          })
          events.push({
            type: 'tool_end',
            name,
            toolCallId,
            mcpResult: `可视化: ${details.visualizer.title}`,
            mcpArgs: currentToolArgs || undefined,
            visualizer: details.visualizer
          })
        } else if (name === 'execute_code' && details?.codeExecution) {
          events.push({
            type: 'tool_end',
            name,
            toolCallId,
            mcpResult: capToolResultText(details.displayResult || ''),
            mcpArgs: JSON.stringify(details.codeExecution),
            modelToolArgs: currentToolArgs || undefined
          })
        } else if (name === 'mcp_execute' && details?.mcpAppInline) {
          // MCP Apps inline:沙盒里调用了带 UI 的 tool → 给当前 mcp_execute 工具消息挂 mcpApp payload
          // 顺序:先 tool_end(消息进 messages 数组) → mcp_app_inline(chatStore 用 toolName === 'mcp_execute' 找最近一条挂载)
          events.push({
            type: 'tool_end',
            name,
            toolCallId,
            mcpResult: capToolResultText(details.displayResult || `MCP App: ${details.mcpAppInline.toolName}`),
            mcpArgs: currentToolArgs || undefined
          })
          events.push({ type: 'mcp_app_inline', messageId: '', payload: details.mcpAppInline })
        } else {
          const contentText = result?.content
            ?.filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n') || ''
          // mcpArgs 优先顺序：
          // 1. details.args（Pi 内建 tool 若显式放 args 字段，如 execute_code）
          // 2. currentToolArgs（从 toolcall_delta 流式积累的 JSON，适用于 read/write/edit 等 Pi 原生工具）
          // 这让 FileResultCard 能从 message.toolArgs 解析出 path 显示正确的文件名
          const rawArgsJson = details?.args
            ? JSON.stringify(details.args)
            : (currentToolArgs || undefined)
          const displayText = details?.displayResult || contentText
          events.push({
            type: 'tool_end',
            name,
            toolCallId,
            // 合法空结果（如 read 读到 0 字节文件）也要给非空占位——否则前端工具卡内容为空，
            // 后续断流时 failUnfinishedToolMessages 会把这张"其实已完成"的卡误标成失败。
            mcpResult: capToolResultText(displayText) || '(无输出)',
            mcpArgs: rawArgsJson,
            // browser_* 等工具把当前页面截图放在 details.screenshot(纯 base64)→ 透传给前端
            // ScreenshotCard 渲染(用户「不抢焦点,看截图」)。无截图时为 undefined,不影响其它工具。
            screenshot: details?.screenshot
          })
        }
        // 带 details.artifact 的工具(create_artifact 已在上面单独处理)→ 额外发 artifact 事件,
        // 复用 artifact 管线自动打开可编辑 ArtifactTab。tool_end 已先 push,满足"先 tool_end 后 artifact"。
        if (details?.artifact && name !== 'create_artifact') {
          events.push({ type: 'artifact', artifact: details.artifact, toolCallId })
        }
        break
      }

      case 'agent_end':
        this.textBuffer = ''
        this.jsonExtractor = null
        this.streamingId = ''
        this.questionsTitleSent = false
        this.lastQuestionsSig = ''
        this.activeToolName = ''
        this.activeToolCallId = ''
        this.toolArgBuffers.clear()
        this.startedToolCallIds.clear()
        break
    }

    return events
  }

  reset(): void {
    this.textBuffer = ''
    this.isThinking = false
    this.hasStreamedThinking = false
    this.hasStreamedText = false
    this.activeToolName = ''
    this.activeToolCallId = ''
    this.toolArgBuffer = ''
    this.toolArgBuffers.clear()
    this.startedToolCallIds.clear()
    this.streamingId = ''
    this.jsonExtractor = null
    this.lastDeltaChars = 0
    this.lastSentContent = ''
    this.lastProgressChars = 0
    this.questionsTitleSent = false
    this.lastQuestionsSig = ''
  }
}
