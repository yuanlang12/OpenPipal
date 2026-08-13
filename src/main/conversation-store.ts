import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  promises as fsp,
} from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { generateTitle } from './title-generator'
import { isSafeConversationStorageId, loadConversationAttachment } from './attachment-store'
import { loadConfig } from './config-manager'
import { isReplayableToolMessage } from './tool-trail'
import type { ConversationGoal } from './goal-checker'
import { dataPath } from './data-root'

const CONVERSATIONS_DIR = dataPath('conversations')
const NO_FOLLOW = fsConstants.O_NOFOLLOW || 0

/**
 * 按会话 id 串行化 read-modify-write 全程（append/replace 落盘专用）。
 * 后一次操作必须等前一次的读+写都完全结束后才开始自己的读，否则两个并发调用可能
 * 各自基于同一份过期磁盘状态计算结果，后写入者会整体覆盖、悄悄丢掉前一个的内容
 * （比"写坏 JSON"更隐蔽的数据丢失）。跨会话 id 互不阻塞。
 */
const writeQueues = new Map<string, Promise<unknown>>()

function serializeWrite<T>(id: string, task: () => Promise<T>): Promise<T> {
  if (!isSafeConversationStorageId(id)) {
    return Promise.reject(new Error('conversationId 格式无效'))
  }
  const prev = writeQueues.get(id) ?? Promise.resolve()
  const run = prev.then(task, task) // 上一环失败也不阻塞本环排队
  // 链条里只存"排队用的时序锚点"，吞掉 reject——真正的错误仍通过 run 传给本次调用方
  writeQueues.set(id, run.catch(() => undefined))
  return run
}

// 标题更新回调（由 ipc-handlers 注入，用于通知前端）
let _onTitleUpdated: ((id: string, title: string) => void) | null = null
export function setTitleUpdateCallback(cb: (id: string, title: string) => void): void {
  _onTitleUpdated = cb
}

export interface StoredMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  messageVersion?: number
  messageKind?: string
  messageSubtype?: string
  /** Offset of OpenPipal's tagged stream-error suffix; display-only metadata. */
  syntheticErrorOffset?: number
  screenshot?: string
  images?: string[]
  /** images 的磁盘落点（相对本会话 artifacts 目录）——模型载荷注入"已存盘"事实用，纯透传 */
  imagePaths?: string[]
  /** 旧版本遗留字段；新版不再据此卸载模型图片。 */
  imagesDroppedFromPayload?: boolean
  searchResults?: string
  timestamp: number
  toolName?: string
  /** 新版 questions_v2 的轻量持久化协议标记；不包含题目正文。 */
  questionsV2Version?: number
  toolArgs?: string
  /** UI 展示参数与真实入参不同时，跨轮模型回放使用此字段。 */
  modelToolArgs?: string
  /** Pi 侧的工具调用 id——工具轨迹回放靠它配对 assistant.toolCall 与 toolResult。 */
  toolCallId?: string
  thinkingContent?: string
  visualizerHtml?: string
  visualizerHeight?: number
  askQuestion?: string
  askOptions?: { label: string; value: string }[]
  askFields?: { label: string; placeholder?: string; type?: string; options?: string[]; required?: boolean }[]
  permissionRequest?: { requestId: string; tool: string; args: Record<string, any>; risk: string; reason: string }
  permissionStatus?: 'pending' | 'approved' | 'denied'
  fileAttachments?: { fileName: string; fileType: string; sizeBytes: number }[]
  /** 消息触发创建的 artifact 的元数据引用（content 存磁盘 sidecar，不进 agent context）*/
  artifactRef?: { id: string; type: string; title: string; path: string; language?: string }
  /** screenshot 已卸载到 attachments/ sidecar 的文件名；有 ref 时内联 base64 会在落盘投影里被剥离 */
  screenshotRef?: string
  /** mcpAppPayload 已卸载的附件文件名（payload 本身经 normalizeStoredMessage 透传，此处不建模） */
  mcpAppRef?: string
}

export interface InitialAsset {
  /** 'role-system' = 角色资产库里的长期档案文件夹（如教师的教学风格），由代码自动注入而非用户手选 */
  category: 'brand' | 'refs' | 'docs' | 'kits' | 'design-system' | 'role-system'
  fileName: string
  path: string
  /** 'library' = 从资产库勾选的既有条目（如设计系统文件夹），非本次上传 */
  sourceType: 'upload' | 'figma' | 'codebase' | 'screenshot' | 'library'
  sizeBytes?: number
}

export interface ConversationConfig {
  workingDir?: string
  /** 会话专属模型：modelPresets 里某预设的 id。未设置/预设已删 → 跟随全局默认。
   *  只存引用不拷贝配置——apiKey/baseUrl 等敏感信息只住 config.json，不进会话文件。 */
  modelPresetId?: string
  /** 通用角色前置信息桶 — key 是 roleName，value 是该角色自定义的任意键值对 */
  roleBrief?: Record<string, Record<string, any>>
  /** 会话开始时用户已上传的资产 — 所有角色通用 */
  initialAssets?: InitialAsset[]
  /** 通用的项目名标签（如 design 工作台、未来 legal 案件名都可填）*/
  projectName?: string
  /**
   * 本会话是否开启思考模式（仅对支持 thinking 的模型有效）。
   * undefined = 默认开（如果模型支持），false = 用户在输入框关掉。
   * 该字段只决定后续发出消息的运行参数，不改变历史消息。
   */
  thinkingEnabled?: boolean
  /**
   * 思考档位（low/medium/high），undefined = 'low'。仅方言支持档位的模型
   * （supportsEffortDial）采纳；纯开关模型忽略此字段，配置预算的 Qwen 会映射为 thinking_budget。
   */
  thinkingLevel?: 'low' | 'medium' | 'high'
  /**
   * questions_v2 正在等待用户回答的状态。questions 是 ephemeral 过程物，不写 artifact
   * sidecar；答题前完整正文暂存在这里，切换/重启后据此恢复，提交答案后立即删除。
   */
  pendingQuestion?: {
    artifactId: string
    title: string
    questions: any[]
  }
  /**
   * 历史压缩缓存（history-compactor 写入）：更早消息的滚动摘要 + 覆盖水位。
   * 只影响发给模型的载荷投影，UI 与落盘消息永远是完整原文。
   */
  historyCompaction?: {
    summary: string
    coveredCount: number
    /** 摘要覆盖前缀的内容指纹；编辑/重新生成后不命中即重建，防止同条数复用旧事实。 */
    coveredDigest?: string
  }
  /**
   * 会话级目标(/goal slash 命令设置)。
   * undefined = 未启用 goal loop;有值则每轮 turn 结束后由 GoalChecker 判定是否继续。
   * 跟会话走、写磁盘、跨重启保留。详见 src/main/goal-checker.ts。
   */
  goal?: ConversationGoal
}

export interface Conversation {
  id: string
  title: string
  role: string
  agentId?: string
  workspaceId?: string
  config?: ConversationConfig
  createdAt: number
  updatedAt: number
  messages: StoredMessage[]
}

export interface ConversationSummary {
  id: string
  title: string
  role: string
  agentId?: string
  workspaceId?: string
  config?: ConversationConfig
  createdAt: number
  updatedAt: number
  messageCount: number
  lastMessage?: string
}

function resolveConversationsRoot(create: boolean): string | null {
  try {
    if (create && !existsSync(CONVERSATIONS_DIR)) {
      mkdirSync(CONVERSATIONS_DIR, { recursive: true, mode: 0o700 })
    }
    const info = lstatSync(CONVERSATIONS_DIR)
    if (!info.isDirectory() && !info.isSymbolicLink()) return null
    const real = realpathSync.native(CONVERSATIONS_DIR)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function ensureDir(): string {
  const root = resolveConversationsRoot(true)
  if (!root) throw new Error('会话目录不可用')
  return root
}

/**
 * Return only the exact regular JSON leaf below the canonical conversation root.
 * The root itself may be a user-managed symlink, but an individual conversation
 * file may not redirect reads/writes through a symlink.
 */
function filePath(id: string, mustExist: boolean): string | null {
  if (!isSafeConversationStorageId(id)) return null
  const root = resolveConversationsRoot(!mustExist)
  if (!root) return null
  const candidate = join(root, `${id}.json`)
  try {
    const info = lstatSync(candidate)
    if (!info.isFile() || info.isSymbolicLink()) return null
    const real = realpathSync.native(candidate)
    return real === candidate ? candidate : null
  } catch (err) {
    if (!mustExist && (err as NodeJS.ErrnoException)?.code === 'ENOENT') return candidate
    return null
  }
}

function readConversation(id: string): Conversation | null {
  const fp = filePath(id, true)
  if (!fp) return null
  let fd: number | undefined
  try {
    fd = openSync(fp, fsConstants.O_RDONLY | NO_FOLLOW)
    if (!fstatSync(fd).isFile()) return null
    const parsed = JSON.parse(readFileSync(fd, 'utf-8')) as Conversation
    // A file cannot claim another storage identity and later turn a sidebar
    // click into an attacker-chosen path lookup.
    return parsed && parsed.id === id ? parsed : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function writeConversation(conv: Conversation): void {
  if (!isSafeConversationStorageId(conv.id)) throw new Error('conversationId 格式无效')
  ensureDir()
  const fp = filePath(conv.id, false)
  if (!fp) throw new Error('会话文件路径不可用')
  let fd: number | undefined
  try {
    fd = openSync(
      fp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NO_FOLLOW,
      0o600
    )
    if (!fstatSync(fd).isFile()) throw new Error('会话文件不是普通文件')
    fchmodSync(fd, 0o600)
    writeFileSync(fd, JSON.stringify(conv, null, 2))
    summaryCache?.set(conv.id, buildSummary(conv))
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** append/replace 专用的异步落盘——避免大对话文件的同步写阻塞主进程事件循环。 */
async function writeConversationAsync(conv: Conversation): Promise<void> {
  if (!isSafeConversationStorageId(conv.id)) throw new Error('conversationId 格式无效')
  ensureDir()
  const fp = filePath(conv.id, false)
  if (!fp) throw new Error('会话文件路径不可用')
  const handle = await fsp.open(
    fp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | NO_FOLLOW,
    0o600
  )
  try {
    if (!(await handle.stat()).isFile()) throw new Error('会话文件不是普通文件')
    await handle.chmod(0o600)
    await handle.writeFile(JSON.stringify(conv, null, 2))
    summaryCache?.set(conv.id, buildSummary(conv))
  } finally {
    await handle.close()
  }
}

// ---- 会话摘要缓存 ----
// listConversations 原来对全目录 readdirSync + 逐文件 JSON.parse（几百个会话实测 ~186ms
// 同步阻塞主进程），而渲染层每次防抖落盘后都要刷一次侧栏列表。会话文件的写入已全部汇聚到
// writeConversation(Async)/deleteConversation 三个咽喉，在此维护缓存即可让 list 纯内存化。
let summaryCache: Map<string, ConversationSummary> | null = null

function buildSummary(conv: Conversation): ConversationSummary {
  const messages = normalizeStoredMessages(conv.messages || [])
  const lastMsg = [...messages].reverse().find(isSummaryCandidate)
  return {
    id: conv.id,
    title: conv.title,
    role: conv.role,
    agentId: conv.agentId,
    workspaceId: conv.workspaceId,
    config: conv.config,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: messages.length,
    lastMessage: getSummaryText(lastMsg)
  }
}

function inferStoredMessageKind(message: StoredMessage): string {
  if (message.messageKind) return message.messageKind
  if (message.permissionRequest) return 'permission_request'
  if (message.askFields?.length || message.askOptions?.length || message.askQuestion) return 'ask_user'
  if (message.role === 'tool' || message.toolName || message.screenshot || message.searchResults || message.visualizerHtml) {
    return 'tool'
  }
  if (message.role === 'assistant' && !message.content && message.thinkingContent) return 'thinking'
  return message.role === 'user' ? 'user' : 'assistant'
}

/**
 * 落盘消息 → 是否进模型载荷。主进程侧唯一口径，逐条对齐 renderer 的 shouldSendMessageToModel：
 * - 放行 finalized 工具轨迹（role:'tool' + toolName + 有内容）——跨轮工具记忆靠它（tool-trail.ts）；
 *   assistant 带截图等被 kind 推断误判成 'tool' 的消息不放行，与渲染层同样处理
 * - 过滤 thinking / 权限请求 / 注入提示：只服务 UI，进历史等于每轮向模型复读一遍
 * - 过滤合成错误气泡（`[Error] …`）：会让"请重试"被永久复读，还污染历史压缩的摘要
 * 只有从磁盘重建历史的路径（ACP）需要它——renderer/extension 自带的历史在渲染层已过滤过一遍。
 */
export function shouldReplayStoredMessage(message: StoredMessage): boolean {
  const legacySyntheticError = message.role === 'assistant' &&
    message.messageVersion === undefined &&
    message.messageKind === undefined &&
    message.messageSubtype === undefined &&
    /^\[Error\] [^\r\n]+$/.test(message.content || '')
  const taggedSyntheticError = message.role === 'assistant' &&
    message.messageKind === 'incomplete' &&
    message.messageSubtype === 'stream-error'
  if (legacySyntheticError || taggedSyntheticError) return false
  const kind = inferStoredMessageKind(message)
  // 工具档的判据只有一处定义（tool-trail.ts）——读侧放行什么、窗口治理认什么，必须同源，
  // 否则两边各自演化时磁盘取材与载荷裁剪会悄悄对不上，且没有编译期信号
  if (kind === 'tool') return isReplayableToolMessage(message)
  if (kind === 'thinking' || kind === 'permission_request' || kind === 'inject-notice' || kind === 'incomplete') return false
  return Boolean(message.content?.trim())
}

export function normalizeStoredMessage(message: StoredMessage): StoredMessage {
  const strictSingleLineError = /^\[Error\] [^\r\n]+$/.test(message.content || '')
  const oldestSyntheticError = message.role === 'assistant' &&
    message.messageVersion === undefined &&
    message.messageKind === undefined &&
    message.messageSubtype === undefined &&
    strictSingleLineError
  // Records written immediately before messageSubtype/offset were introduced
  // already carry v2 + incomplete. The exact one-line shape is safe to migrate;
  // partial model text with an appended suffix remains deliberately untouched.
  const preSubtypeSyntheticError = message.role === 'assistant' &&
    message.messageKind === 'incomplete' &&
    message.messageSubtype === undefined &&
    strictSingleLineError
  const legacySyntheticError = oldestSyntheticError || preSubtypeSyntheticError
  if (legacySyntheticError) {
    return {
      ...message,
      messageVersion: 2,
      messageKind: 'incomplete',
      messageSubtype: 'stream-error',
      syntheticErrorOffset: 0
    }
  }
  const messageKind = inferStoredMessageKind(message)
  return {
    ...message,
    messageVersion: message.messageVersion ?? 2,
    messageKind,
    messageSubtype: message.messageSubtype ?? (messageKind === 'tool' ? message.toolName : undefined)
  }
}

function normalizeStoredMessages(messages: StoredMessage[]): StoredMessage[] {
  return messages.map(normalizeStoredMessage)
}

function isSummaryCandidate(message: StoredMessage): boolean {
  const kind = inferStoredMessageKind(message)
  if (kind === 'tool' || kind === 'thinking' || kind === 'permission_request') return false
  return Boolean((message.askQuestion || message.content || '').trim())
}

function getSummaryText(message?: StoredMessage): string | undefined {
  if (!message) return undefined
  const text = (message.askQuestion || message.content || '').replace(/\n/g, ' ').trim()
  return text ? text.substring(0, 80) : undefined
}

function findFirstAssistantForTitle(messages: StoredMessage[]): StoredMessage | undefined {
  return messages.find((message) => {
    const kind = inferStoredMessageKind(message)
    if (message.role !== 'assistant') return false
    if (kind === 'thinking' || kind === 'tool' || kind === 'permission_request') return false
    return Boolean(message.content?.trim())
  })
}

/**
 * 列出所有对话（按 updatedAt 降序），不含消息体
 */
export function listConversations(): ConversationSummary[] {
  if (!summaryCache) {
    const root = ensureDir()
    summaryCache = new Map()
    const files = readdirSync(root).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const id = file.slice(0, -'.json'.length)
      if (!isSafeConversationStorageId(id)) continue
      const conv = readConversation(id)
      if (conv) summaryCache.set(id, buildSummary(conv))
    }
  }
  return Array.from(summaryCache.values()).sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 创建新对话
 */
export function createConversation(role: string, title?: string, agentId?: string, workspaceId?: string): Conversation {
  const now = Date.now()
  // 会话出生即钉住当时的全局激活模型预设（快照语义）：此后全局切换永不影响这条已存在的会话，
  // 彻底免疫"运行中被翻转到另一模型"。用户在会话内换模型仍走 config.modelPresetId 覆盖。
  // 只在存在时写入——无 activePresetId 则字段缺省，跟随全局默认。
  const activePresetId = loadConfig().activePresetId
  const conv: Conversation = {
    id: randomUUID(),
    title: title || '新对话',
    role,
    ...(agentId ? { agentId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(activePresetId ? { config: { modelPresetId: activePresetId } } : {}),
    createdAt: now,
    updatedAt: now,
    messages: []
  }
  writeConversation(conv)
  console.log(`[Conv] 创建对话: ${conv.id} (${conv.title})`)
  return conv
}

/**
 * 获取对话的所有消息
 */
/** 切会话回来时给最近几条消息重内联附件，避免最近卡片懒加载闪烁。
 * 更早的截图保留 ref；主进程会在整体 token 压缩之后按需读取进入模型的那部分。 */
const REHYDRATE_RECENT_ATTACHMENTS = 6

/**
 * 渲染层切会话/取历史专用：读**排进该会话的写队列之后**（评审 H2）。后台并发 append（非活跃
 * 会话的工具结果/产物锚点）在飞时，裸快照读会拿到旧状态——渲染层用它初始化 messages 与落盘
 * 水位线后，后续全量 replace 会把飞行中的 append 冲掉（数据丢失）。main 内部同步调用方
 * （artifact-store 扫描等）无此竞态，维持下方同步版。
 */
export function getConversationMessagesSerialized(id: string): Promise<StoredMessage[]> {
  if (!isSafeConversationStorageId(id)) return Promise.resolve([])
  return serializeWrite(id, async () => getConversationMessages(id))
}

export function getConversationMessages(id: string): StoredMessage[] {
  const conv = readConversation(id)
  const msgs = normalizeStoredMessages(conv?.messages || [])
  for (let i = Math.max(0, msgs.length - REHYDRATE_RECENT_ATTACHMENTS); i < msgs.length; i++) {
    const m = msgs[i] as StoredMessage & { mcpAppPayload?: unknown }
    if (m.screenshotRef && !m.screenshot) {
      const data = loadConversationAttachment(id, m.screenshotRef)
      if (data) m.screenshot = data
    }
    if (m.mcpAppRef && !m.mcpAppPayload) {
      const data = loadConversationAttachment(id, m.mcpAppRef)
      if (data) {
        try { m.mcpAppPayload = JSON.parse(data) } catch { /* 附件损坏则维持 ref，渲染层再兜底 */ }
      }
    }
  }
  return msgs
}

/**
 * 获取完整对话
 */
export function getConversation(id: string): Conversation | null {
  const conv = readConversation(id)
  if (!conv) return null
  return { ...conv, messages: normalizeStoredMessages(conv.messages || []) }
}

/**
 * 异步生成 AI 标题并回写——从 appendMessages/replaceMessages 里抽出来的公共尾巴。
 * 通过 serializeWrite 排到同一条会话 id 的落盘队列上：不然这个稍后才 resolve 的写
 * 很容易和后续的 append/replace 交叠，各自基于过期状态覆盖，悄悄丢内容。
 */
function scheduleTitleGeneration(convId: string, userContent: string, assistantContent: string): void {
  generateTitle(userContent, assistantContent).then(title => {
    serializeWrite(convId, async () => {
      const fresh = readConversation(convId)
      if (fresh && fresh.title !== title) {
        fresh.title = title
        await writeConversationAsync(fresh)
        // 通知前端标题已更新（由 ipc-handlers 注册监听器）
        _onTitleUpdated?.(convId, title)
        console.log(`[Conv] AI 标题: "${title}" (${convId.substring(0, 8)})`)
      }
    }).catch(() => {})
  }).catch(() => {})
}

/**
 * 追加消息到对话
 */
export function appendMessages(id: string, messages: StoredMessage[]): Promise<boolean> {
  if (!isSafeConversationStorageId(id)) return Promise.resolve(false)
  return serializeWrite(id, async () => {
    const conv = readConversation(id)
    if (!conv) return false

    conv.messages.push(...normalizeStoredMessages(messages))
    conv.updatedAt = Date.now()

    // 先用截断作为即时标题，再异步生成 AI 标题
    if (conv.title === '新对话') {
      const firstUserMsg = conv.messages.find(m => m.role === 'user')
      if (firstUserMsg) {
        conv.title = firstUserMsg.content.substring(0, 30).replace(/\n/g, ' ')
        if (firstUserMsg.content.length > 30) conv.title += '...'
      }

      // 有用户消息和助手回复后，异步生成 AI 标题
      const userMsg = conv.messages.find(m => m.role === 'user')
      const assistantMsg = findFirstAssistantForTitle(conv.messages)
      if (userMsg && assistantMsg) {
        scheduleTitleGeneration(conv.id, userMsg.content, assistantMsg.content)
      }
    }

    await writeConversationAsync(conv)
    return true
  })
}

/**
 * 更新对话标题
 */
export function updateConversationTitle(id: string, title: string): Promise<boolean> {
  if (!isSafeConversationStorageId(id)) return Promise.resolve(false)
  // 与 append/replace 同队列:防止同步写与飞行中的异步落盘交叠损坏文件
  return serializeWrite(id, async () => {
    const conv = readConversation(id)
    if (!conv) return false
    conv.title = title
    conv.updatedAt = Date.now()
    await writeConversationAsync(conv)
    return true
  })
}

/** 空会话的 role 跟随首次发送时的显式选择（欢迎页头像切换）——已开聊的会话人格锁定，防误切 */
export function updateConversationRole(id: string, role: string): Promise<boolean> {
  if (!isSafeConversationStorageId(id)) return Promise.resolve(false)
  return serializeWrite(id, async () => {
    const conv = readConversation(id)
    if (!conv) return false
    if ((conv.messages?.length ?? 0) > 0) return false
    conv.role = role
    conv.updatedAt = Date.now()
    await writeConversationAsync(conv)
    return true
  })
}

/**
 * 删除对话
 */
export function deleteConversation(id: string): Promise<boolean> {
  if (!isSafeConversationStorageId(id)) return Promise.resolve(false)
  // 必须入队:若同一会话有飞行中的异步 append/replace,不入队的同步 unlink 会被
  // 稍后落地的写入"复活"。入队后 delete 排在既有写入之后;delete 之后排队的写入
  // readConversation 读到 null 直接 return false,不会重建文件。
  return serializeWrite(id, async () => {
    const fp = filePath(id, true)
    if (!fp) return false
    try {
      await fsp.unlink(fp)
      summaryCache?.delete(id)
      console.log(`[Conv] 删除对话: ${id}`)
      return true
    } catch {
      return false
    }
  })
}

/**
 * 替换对话中的消息（用于编辑重发、重新生成场景、防抖保存）
 */
export function replaceMessages(id: string, messages: StoredMessage[]): Promise<boolean> {
  if (!isSafeConversationStorageId(id)) return Promise.resolve(false)
  return serializeWrite(id, async () => {
    const conv = readConversation(id)
    if (!conv) return false
    conv.messages = normalizeStoredMessages(messages)
    conv.updatedAt = Date.now()

    // 标题未生成时触发（与 appendMessages 同逻辑）
    if (conv.title === '新对话' || conv.title === messages[0]?.content?.substring(0, 30)?.replace(/\n/g, ' ')) {
      const firstUserMsg = messages.find(m => m.role === 'user')
      if (firstUserMsg) {
        conv.title = firstUserMsg.content.substring(0, 30).replace(/\n/g, ' ')
        if (firstUserMsg.content.length > 30) conv.title += '...'
      }
      const userMsg = messages.find(m => m.role === 'user')
      const assistantMsg = findFirstAssistantForTitle(conv.messages)
      if (userMsg && assistantMsg) {
        scheduleTitleGeneration(conv.id, userMsg.content, assistantMsg.content)
      }
    }

    await writeConversationAsync(conv)
    return true
  })
}

/**
 * 更新对话配置（技能、工作目录等）
 */
export function updateConversationConfig(id: string, config: ConversationConfig): Promise<boolean> {
  if (!isSafeConversationStorageId(id)) return Promise.resolve(false)
  return serializeWrite(id, async () => {
    const conv = readConversation(id)
    if (!conv) return false
    conv.config = config
    conv.updatedAt = Date.now()
    await writeConversationAsync(conv)
    return true
  })
}
