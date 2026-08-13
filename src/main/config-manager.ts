/**
 * 运行时配置管理
 * 优先从 ~/.openpipal/config.json 读取模型配置，.env 作为回退
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { resolveCacheRetentionForModel } from './prompt-cache-fifo'
import {
  normalizeLocalePreference,
  type LocalePreference
} from '../shared/i18n/contract'
import {
  getOpenPipalConfigBackupPath,
  getOpenPipalConfigPath
} from './credential-paths'

const OPENPIPAL_DIR = getDataRoot()
const CONFIG_PATH = getOpenPipalConfigPath()

export type ThinkingLevelChoice = 'low' | 'medium' | 'high'

/** Qwen thinking_budget 的三档 token 上限。档位是 OpenPipal 语义，线上发送的是整数预算。 */
export interface ThinkingBudgets {
  low: number
  medium: number
  high: number
}

/**
 * 官方 Qwen3 混合思考模型的保守默认档位。
 * 服务商或单模型均可覆盖；不直接使用官方几十万 token 的最大值，避免简单任务过度思考。
 */
export const DEFAULT_QWEN_THINKING_BUDGETS: ThinkingBudgets = {
  low: 2_048,
  medium: 8_192,
  high: 32_768
}

export interface ModelConfig {
  provider: string       // openai, deepseek, openrouter, custom
  baseUrl: string
  apiKey: string
  model: string
  /**
   * 模型是否支持 reasoning/thinking。
   * - undefined: 走 Pi 内置模型注册表的 reasoning 字段（默认行为）
   * - true:  即使 Pi 不知道这个 model 也强制开启 thinking（用户手动勾选/自动检测得出）
   * - false: 即使 Pi 知道支持也不开（用户手动取消）
   * 自定义 OpenAI 兼容端点必须靠用户/检测来声明，因为 Pi 兜底模板默认 reasoning=false
   */
  supportsThinking?: boolean
  /**
   * 模型是否支持图片输入（视觉）。
   * - undefined/true: 按多模态处理（历史图片原样发送）
   * - false: 纯文本模型——pi-ai 会把历史图片自动降级为占位文本，避免网关 400
   *   （历史实案：litellm 网关的 qwen3.7-max 文本组收到 image_url 项报
   *    InternalError.Algo.InvalidParameter "Unexpected item type in content"）
   */
  supportsImages?: boolean
  /**
   * 模型上下文窗口（token）。自定义端点的 Pi 模板残留值不可信（8192），
   * 历史压缩阈值用这个；不填按 131072 估。
   */
  contextWindow?: number
  /**
   * custom provider 的上游协议格式。
   * - undefined（默认，等价于 'openai'）：现行为逐字节不变——走 createCustomCompatModel，
   *   即 OpenAI 兼容 completions 协议（POST {baseUrl}/chat/completions）。
   * - 'anthropic'：第三方网关抄 Anthropic Messages 协议（POST {baseUrl}/v1/messages，
   *   头带 x-api-key + anthropic-version）——走 createCustomAnthropicModel。
   *   baseUrl 填「根地址」，不带 /v1（SDK 内部固定拼 /v1/messages，比照官方模板
   *   baseUrl='https://api.anthropic.com' 核实）。
   * - 'openai-responses'：第三方网关抄 OpenAI Responses API 协议（POST {baseUrl}/responses，
   *   即完整端点形状是 {根地址}/v1/responses）——走 createCustomResponsesModel。baseUrl 填法
   *   与默认 'openai' completions 分支一致：带 /v1（官方模板 baseUrl='https://api.openai.com/v1'，
   *   OpenAI SDK 内部只拼 '/responses'，/v1 必须留在 baseUrl 里）。
   * 只对 provider === 'custom' 生效；官方 'openai'/'anthropic' provider 不读这个字段。
   */
  apiFormat?: 'openai' | 'anthropic' | 'openai-responses'
  /**
   * OpenAI Chat Completions 兼容端点的思考参数方言。
   * 传输层仍是 /chat/completions；这里只决定“如何开关思考”：
   * - auto：按 provider/model 自动识别（GLM→zai，DeepSeek→deepseek，Qwen→qwen）
   * - zai：thinking:{type:'enabled'|'disabled'} + tool_stream（GLM 5.x）
   * - qwen：enable_thinking:boolean
   * - deepseek：thinking:{type:...} + reasoning_effort
   * - openai：reasoning_effort
   */
  thinkingFormat?: 'auto' | 'openai' | 'qwen' | 'deepseek' | 'zai'
  /**
   * Qwen thinking_budget 档位。
   * - undefined：继承服务商默认；没有默认时仅对官方 Model Studio 的 Qwen3 自动启用保守档位
   * - null：该服务商+模型明确只支持开关，不发送 thinking_budget
   * - object：该服务商+模型自己的低/中/高 token 上限
   */
  thinkingBudgets?: ThinkingBudgets | null
  /**
   * 可选的模型级系统提示词补丁。共同提示词仍是唯一主体；只有评测证明某个
   * 服务商+模型组合确有稳定行为差异时才填写。切换模型时按解析后的 preset 注入，
   * 未配置即零字节，不靠模型名自动猜测。
   */
  systemPromptAdapter?: string
}

export interface ModelPreset {
  id: string
  name: string           // 显示名，如 "Qwen 3.6 Plus (302.AI)"
  /**
   * 所属服务商实体（configVersion 2 起）。存在时连接字段（provider/baseUrl/apiKey/apiFormat）
   * 以服务商实体为准（resolvePresetConfig 合并）；config 里的同名字段是迁移遗留缓存，
   * 仅在 providerId 悬空（服务商被删）时兜底。模型级字段永远住 config。
   */
  providerId?: string
  config: ModelConfig
}

/**
 * 服务商实体（configVersion 2）：连接信息的唯一事实源。
 * 一个服务商可挂多个模型预设——换 key/换网关改这里一处生效。
 */
export interface ModelProvider {
  id: string
  /** 显示名：custom → baseUrl 域名；内置 → '内置服务'（红线：不暴露内置连接信息） */
  name: string
  /** 协议模板选择（与 ModelConfig.provider 同域） */
  provider: string
  baseUrl: string
  apiKey: string
  apiFormat?: 'openai' | 'anthropic' | 'openai-responses'
  /** 该服务商的默认思考方言；模型显式选择非 auto 时优先。 */
  thinkingFormat?: 'openai' | 'qwen' | 'deepseek' | 'zai'
  /** 该服务商下 Qwen 模型的默认预算；null 表示该网关仅支持思考开关。 */
  thinkingBudgets?: ThinkingBudgets | null
  /** .env 内置服务：Settings 不展示连接字段与模型名、不可编辑/删除（CLAUDE.md 红线） */
  builtin?: boolean
}

export interface VoiceConfig {
  /** openai (兼容 302.ai) | azure */
  provider: string
  /** OpenAI: wss endpoint base, e.g. https://api.302.ai/v1/realtime
   *  Azure:  resource base, e.g. https://<resource>.openai.azure.com (可省 /openai/realtime)
   */
  baseUrl: string
  apiKey: string
  /** OpenAI 路径下作为 URL 查询参数；Azure 路径下若未配 deployment 则作为 fallback */
  model: string
  /** Azure 部署名（用户在 portal 给部署起的别名） */
  deployment?: string
  /** Azure api-version */
  apiVersion?: string
  /** 语音风格：alloy/echo/shimmer/ash/coral/sage/verse/ballad/marin/cedar */
  voice?: string
  /** 豆包同传专用:Resource-Id(固定 volc.service_type.10053)。OpenAI/Azure 路径不用。 */
  resourceId?: string
  /** 同传源语言(如 'en')。仅 interpreter + 豆包路径用,单向首版。 */
  sourceLanguage?: string
  /** 同传目标语言(如 'zh')。s2s 时必须是 zh/en。 */
  targetLanguage?: string
}

export interface OpenPipalConfig {
  role?: string
  /** 界面语言：system 跟随操作系统；缺失或非法旧值按 system 处理。 */
  localePreference?: LocalePreference
  /** 应用跟随总开关：缺失（旧配置）默认开启。每应用 disabledApps 状态独立保留。 */
  appFollowingEnabled?: boolean
  disabledApps?: string[]
  detectedApps?: string[]
  modelConfig?: ModelConfig
  modelPresets?: ModelPreset[]     // 已保存的模型预设列表
  modelProviders?: ModelProvider[] // 服务商实体列表（configVersion 2 起）
  activePresetId?: string          // 当前激活的预设 ID
  /** 配置结构版本。缺省=1（预设自含连接信息）；2=服务商实体化。loadConfig 惰性迁移。 */
  configVersion?: number
  autoMemoryEnabled?: boolean      // 自动记忆提取（默认 true）
  lastExportDir?: string           // 产物导出目录（默认 ~/Downloads；用户在导出弹窗改过就记住）
  voiceConfig?: VoiceConfig        // P2: 语音通话服务配置
  voiceConfigDoubao?: VoiceConfig  // 豆包同声传译2.0:仅 interpreter 角色语音走它(与 voiceConfig 并存,不互踩)
  /**
   * 窗口置顶模式:
   * - false / 未设置(默认): 普通窗口层级,可被其它 app 盖住,也能自由截图
   * - true: screen-saver 层级,覆盖全屏应用(适合 ClassIn 侧挂等场景)
   * 用户可在 Settings → 通用 里切换,tray 菜单也有快捷开关
   */
  alwaysOnTop?: boolean
  /**
   * Phase 6d 悬浮球模式开关:
   * - true / 未设置(默认): 前台应用全屏时主窗口自动缩成 72×72 球（OrbView）
   * - false: 禁用此自动行为,主窗口保持原 dock 大小,UI 正常
   * 关闭后 Phase 6d 的 STT/Presenter 等基于 orb 的能力仍然存在,只是不再自动触发显示。
   */
  orbModeEnabled?: boolean
  /**
   * 冷启动引导完成标记。
   * 首次启动 / 字段缺失时,UI 渲染 OnboardingOverlay 引导用户配模型+授屏录权限;
   * 用户点完成或跳过,写入 true,后续启动不再弹出。
   */
  onboardingCompleted?: boolean
}

// 预设服务商
export const PROVIDERS: Record<string, { name: string; baseUrl: string; models: string[] }> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo']
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner']
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4', 'google/gemini-2.5-flash', 'openai/gpt-4o']
  },
  siliconflow: {
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3']
  },
  zai: {
    name: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    models: ['glm-5.2', 'glm-5.1', 'glm-5-turbo', 'glm-4.7']
  }
}

function ensureDir(): void {
  if (!existsSync(OPENPIPAL_DIR)) {
    mkdirSync(OPENPIPAL_DIR, { recursive: true })
  }
}

export function loadConfig(): OpenPipalConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const config: OpenPipalConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
      // 惰性 schema 迁移（v1→v2 服务商实体化）。configVersion 守卫让绝大多数调用零开销；
      // 首次迁移前留 .bak（本文件此前从无备份先例，动 schema 必须补上）。
      if (needsProviderMigration(config)) {
        try {
          writeFileSync(getOpenPipalConfigBackupPath(), JSON.stringify(config, null, 2))
        } catch { /* 备份失败不阻断迁移 */ }
        const migrated = migrateToProviderEntities(config)
        saveConfig(migrated)
        console.log(`[Config] schema v1→v2：${migrated.modelProviders?.length || 0} 个服务商实体，${migrated.modelPresets?.length || 0} 条预设已挂接`)
        return migrated
      }
      return config
    }
  } catch {
    // ignore
  }
  return {}
}

export function saveConfig(config: OpenPipalConfig): void {
  ensureDir()
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

// ---- 服务商实体化（configVersion 2）----

function needsProviderMigration(config: OpenPipalConfig): boolean {
  if ((config.configVersion || 1) >= 2) return false
  // 空配置/无预设也升版本号，避免每次 loadConfig 重复判定
  return true
}

function hostnameOf(baseUrl: string): string {
  try { return new URL(baseUrl).hostname } catch { return baseUrl }
}

function providerDisplayName(mc: { provider: string; baseUrl?: string }): string {
  return mc.provider === 'custom' ? hostnameOf(mc.baseUrl || '') : mc.provider
}

/**
 * 服务商实体的身份 = 它自己拥有的那组连接字段（provider/baseUrl/apiKey/apiFormat）。
 * 只比 (baseUrl, apiKey) 会漏掉方言：用户只改"接口格式"时找回的还是旧实体，
 * 而 resolvePresetConfig 又用实体的 apiFormat 覆盖预设——刚改的方言原地失效。
 * 同网关不同 key 视为不同租户，不合并（同理不同方言 = 不同实体）。
 */
function sameProviderConnection(p: ModelProvider, mc: ModelConfig): boolean {
  return p.provider === mc.provider
    && p.baseUrl === mc.baseUrl
    && p.apiKey === mc.apiKey
    && (p.apiFormat || undefined) === (mc.apiFormat || undefined)
}

/**
 * 在 config.modelProviders 里按整组连接字段找同源服务商，没有则创建。返回服务商 id。
 */
function findOrCreateProvider(
  config: OpenPipalConfig,
  mc: ModelConfig,
  opts?: { builtin?: boolean }
): string {
  if (!config.modelProviders) config.modelProviders = []
  const found = config.modelProviders.find(p => sameProviderConnection(p, mc))
  if (found) return found.id
  const id = `prov_${Date.now()}_${config.modelProviders.length}`
  config.modelProviders.push({
    id,
    name: opts?.builtin ? '内置服务' : providerDisplayName(mc),
    provider: mc.provider,
    baseUrl: mc.baseUrl,
    apiKey: mc.apiKey,
    ...(mc.apiFormat ? { apiFormat: mc.apiFormat } : {}),
    ...(opts?.builtin ? { builtin: true } : {})
  })
  return id
}

/**
 * v1→v2 迁移：为每条预设按 (baseUrl, apiKey) 找/建服务商实体并挂 providerId。
 * 预设 config 里的连接字段原样保留（providerId 悬空时的兜底 + 回滚零损失）；
 * modelConfig（当前激活快照）保持扁平不动。幂等：已挂 providerId 的预设跳过。
 */
export function migrateToProviderEntities(config: OpenPipalConfig): OpenPipalConfig {
  const next: OpenPipalConfig = { ...config, configVersion: 2 }
  next.modelPresets = (config.modelPresets || []).map(p => ({ ...p }))
  next.modelProviders = (config.modelProviders || []).map(p => ({ ...p }))
  for (const preset of next.modelPresets) {
    if (preset.providerId) continue
    if (!preset.config?.baseUrl) continue
    const builtin = preset.name.includes('内置')
    preset.providerId = findOrCreateProvider(next, preset.config, { builtin })
  }
  return next
}

/**
 * 预设的解析视图：providerId 命中 → 服务商实体的连接字段覆盖预设缓存（换 key 一处生效），
 * 模型级字段一律取预设自身；悬空 → 预设缓存兜底（迁移前行为）。
 */
export function resolvePresetConfig(preset: ModelPreset, config?: OpenPipalConfig): ModelConfig {
  const cfg = config || loadConfig()
  const provider = preset.providerId
    ? (cfg.modelProviders || []).find(p => p.id === preset.providerId)
    : undefined
  if (!provider) return preset.config
  const modelThinkingFormat = preset.config.thinkingFormat
  const effectiveThinkingFormat = modelThinkingFormat && modelThinkingFormat !== 'auto'
    ? modelThinkingFormat
    : (provider.thinkingFormat || modelThinkingFormat)
  const modelOwnsBudgets = Object.prototype.hasOwnProperty.call(preset.config, 'thinkingBudgets')
  const effectiveThinkingBudgets = modelOwnsBudgets
    ? preset.config.thinkingBudgets
    : provider.thinkingBudgets
  return {
    ...preset.config,
    provider: provider.provider as ModelConfig['provider'],
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    ...(provider.apiFormat ? { apiFormat: provider.apiFormat } : { apiFormat: preset.config.apiFormat }),
    ...(effectiveThinkingFormat ? { thinkingFormat: effectiveThinkingFormat } : {}),
    ...(effectiveThinkingBudgets !== undefined ? { thinkingBudgets: effectiveThinkingBudgets } : {})
  }
}

/** 产物导出目录：用户上次选的目录（仍存在才算数）→ 否则 ~/Downloads */
export function getExportDir(): string {
  const saved = loadConfig().lastExportDir
  if (saved && existsSync(saved)) return saved
  return join(homedir(), 'Downloads')
}

export function setExportDir(dir: string): void {
  const config = loadConfig()
  config.lastExportDir = dir
  saveConfig(config)
}

/** 冷启动引导状态:用户走完(或跳过)首次引导后置 true,后续启动不再弹 OnboardingOverlay */
export function getOnboardingCompleted(): boolean {
  return loadConfig().onboardingCompleted === true
}

export function setOnboardingCompleted(value: boolean): void {
  const config = loadConfig()
  config.onboardingCompleted = value
  saveConfig(config)
}

/** 界面语言偏好；历史配置缺失或被手工写入非法值时安全回落到 system。 */
export function getLocalePreference(): LocalePreference {
  return normalizeLocalePreference(loadConfig().localePreference)
}

export function setLocalePreference(value: unknown): LocalePreference {
  const preference = normalizeLocalePreference(value)
  const config = loadConfig()
  config.localePreference = preference
  saveConfig(config)
  return preference
}

/**
 * 获取当前生效的模型配置
 * 优先级：config.json > .env > 默认值
 */
export function getEffectiveModelConfig(): ModelConfig {
  const config = loadConfig()
  if (config.modelConfig?.apiKey) {
    return config.modelConfig
  }
  // 从 .env 回退
  return {
    provider: 'custom',
    baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o'
  }
}

/**
 * 红线：判定生效配置是否在用内置凭证（.env 注入或 builtin 服务商实体的 key）。
 * 以 key 等值判定——要遮蔽的正是这份凭证对应的连接信息与模型名。
 */
export function isBuiltinModelCredential(mc: ModelConfig): boolean {
  if (!mc.apiKey) return false
  if (process.env.OPENAI_API_KEY && mc.apiKey === process.env.OPENAI_API_KEY) return true
  const config = loadConfig()
  return (config.modelProviders || []).some(p => p.builtin && !!p.apiKey && p.apiKey === mc.apiKey)
}

/**
 * 展示口径的生效模型配置——IPC/HTTP 出口统一走这里：key 恒掩码；
 * 内置凭证时 model/baseUrl 一并遮蔽（红线：内置连接信息与模型名不出主进程）。
 */
export function getEffectiveModelConfigForDisplay(): ModelConfig & { builtin: boolean } {
  const mc = getEffectiveModelConfig()
  const builtin = isBuiltinModelCredential(mc)
  return {
    ...mc,
    apiKey: maskApiKey(mc.apiKey),
    ...(builtin ? { model: '内置模型', baseUrl: '' } : {}),
    builtin
  }
}

/**
 * 保存模型配置
 */
export function saveModelConfig(modelConfig: ModelConfig): void {
  const config = loadConfig()
  config.modelConfig = modelConfig

  // 自动保存为预设（如果同名模型不在预设列表中）
  if (!config.modelPresets) config.modelPresets = []
  const exists = config.modelPresets.some(p => p.config.model === modelConfig.model && p.config.baseUrl === modelConfig.baseUrl)
  if (!exists) {
    const presetName = modelConfig.provider === 'custom'
      ? modelConfig.model
      : `${modelConfig.model} (${modelConfig.provider})`
    const id = `preset_${Date.now()}`
    config.modelPresets.push({ id, name: presetName, providerId: findOrCreateProvider(config, modelConfig), config: modelConfig })
    config.activePresetId = id
  } else {
    const preset = config.modelPresets.find(p => p.config.model === modelConfig.model && p.config.baseUrl === modelConfig.baseUrl)
    if (preset) config.activePresetId = preset.id
  }

  saveConfig(config)
  console.log(`[Config] 模型配置已更新: ${modelConfig.provider} / ${modelConfig.model}`)
}

/**
 * 获取服务商列表
 */
export function getProviders() {
  return PROVIDERS
}

// ─── Voice (Realtime) 配置 ───────────────────────────────────────────────────

/**
 * 获取当前生效的语音配置
 * 优先级：config.json > .env > 默认值
 */
export function getEffectiveVoiceConfig(): VoiceConfig {
  const config = loadConfig()
  if (config.voiceConfig?.apiKey) {
    return {
      provider: config.voiceConfig.provider || 'openai',
      baseUrl: config.voiceConfig.baseUrl,
      apiKey: config.voiceConfig.apiKey,
      model: config.voiceConfig.model,
      deployment: config.voiceConfig.deployment,
      apiVersion: config.voiceConfig.apiVersion,
      voice: config.voiceConfig.voice || 'alloy'
    }
  }
  return {
    provider: process.env.REALTIME_PROVIDER || 'openai',
    baseUrl: process.env.REALTIME_API_URL || 'https://api.302.ai/v1/realtime',
    apiKey: process.env.REALTIME_API_KEY || '',
    model: process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17',
    deployment: process.env.REALTIME_DEPLOYMENT || '',
    apiVersion: process.env.REALTIME_API_VERSION || '2025-04-01-preview',
    voice: process.env.REALTIME_VOICE || 'alloy'
  }
}

/**
 * 豆包同声传译2.0 凭证(从 config.voiceConfigDoubao 读)。
 * 未配置 / 无 apiKey → 返回 null(调用方据此回落到普通语音路径)。
 * 默认值:端点 = AST v2,Resource-Id 固定,源/目标语种 en→zh(单向首版,可在 config 覆盖)。
 */
export function getDoubaoVoiceConfig(): VoiceConfig | null {
  const d = loadConfig().voiceConfigDoubao
  if (!d || !d.apiKey) return null
  return {
    provider: 'doubao',
    baseUrl: d.baseUrl || 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate',
    apiKey: d.apiKey,
    model: d.model || '',
    resourceId: d.resourceId || 'volc.service_type.10053',
    sourceLanguage: d.sourceLanguage || 'zh',
    targetLanguage: d.targetLanguage || 'en',
    voice: d.voice
  }
}

/**
 * 保存语音配置
 */
export function saveVoiceConfig(voiceConfig: VoiceConfig): void {
  const config = loadConfig()
  config.voiceConfig = voiceConfig
  saveConfig(config)
  console.log(`[Config] 语音配置已更新: ${voiceConfig.provider} / ${voiceConfig.model || voiceConfig.deployment}`)
}

/**
 * 同传(interpreter)目标语言设置。源固定 'auto'(豆包自动识别),只改目标。
 * 仅在已配豆包凭证(voiceConfigDoubao 存在)时生效;否则 no-op。
 */
export function setInterpretTargetLanguage(target: string): void {
  const config = loadConfig()
  if (!config.voiceConfigDoubao) return
  // s2s 不支持 source='auto'(豆包报 "speak: not found")。源取目标的互补语(zh↔en),
  // 即"译成英语"=中→英、"译成中文"=英→中,单控件实现双向。
  const source = target === 'zh' ? 'en' : 'zh'
  config.voiceConfigDoubao = { ...config.voiceConfigDoubao, sourceLanguage: source, targetLanguage: target }
  saveConfig(config)
  console.log(`[Config] 同传 ${source}→${target}`)
}

/**
 * 获取当前模型名
 */
export function getCurrentModel(): string {
  return getEffectiveModelConfig().model
}

function nonApiResponseMessage(baseUrl: string): string {
  return `网关返回了网页而非 API 响应：baseUrl 可能缺 /v1（当前：${baseUrl}）`
}

/**
 * 网关错误文本友好化（纯函数，可单测）。
 * HTML 首页（SPA catch-all）是最阴险的假成功：HTTP 200 但不是 API 响应，
 * 最常见根因是 baseUrl 缺 /v1。其余错误原样透传网关文本（含状态码/message），
 * 不吞、不泛化成"连接失败"。
 */
export function friendlyProviderError(raw: string, baseUrl: string): string {
  const text = raw && raw.trim() ? raw : '连接失败'
  if (/<!doctype|<html/i.test(text)) {
    return nonApiResponseMessage(baseUrl)
  }
  return text
}

/**
 * baseUrl 结尾（忽略尾部斜杠、大小写）是否需要补 /v1。
 * 已经以 /v1 结尾（含 /compatible-mode/v1 这类前缀在中间的形态）→ false，不重试。
 * 纯函数，可单测。
 */
export function shouldRetryWithV1(baseUrl: string): boolean {
  const trimmed = (baseUrl || '').trim().replace(/\/+$/, '')
  return !/\/v1$/i.test(trimmed)
}

/**
 * 去尾斜杠后追加 /v1。纯函数，可单测。
 */
export function appendV1(baseUrl: string): string {
  return (baseUrl || '').trim().replace(/\/+$/, '') + '/v1'
}

export type ResolvedThinkingFormat = 'openai' | 'qwen' | 'deepseek' | 'zai'

/**
 * 解析 OpenAI Chat Completions 端点使用的思考参数方言。
 * 未显式配置时按模型族识别；最后回落 qwen 以保持历史自定义端点行为。
 */
export function resolveThinkingFormat(mc: ModelConfig): ResolvedThinkingFormat {
  if (mc.thinkingFormat && mc.thinkingFormat !== 'auto') return mc.thinkingFormat

  const model = (mc.model || '').trim()
  // OpenRouter 自己封装 reasoning 参数；即使 model id 是 z-ai/glm-* 也不能发 Z.AI 直连方言。
  if (mc.provider === 'openrouter') return 'openai'
  if (mc.provider === 'qwen-token-plan' || mc.provider === 'qwen-token-plan-cn') return 'qwen'
  if (mc.provider === 'zai' || /^(?:z-ai\/|zai\/)?glm(?:[-_.]|$)/i.test(model)) return 'zai'
  if (mc.provider === 'deepseek' || /deepseek/i.test(model)) return 'deepseek'
  if (/qwen/i.test(model)) return 'qwen'

  // 历史兼容：OpenPipal 过去对所有 custom+thinking 端点都使用 qwen 方言。
  return 'qwen'
}

function usesOpenAICompletions(mc: ModelConfig): boolean {
  if (mc.provider === 'custom') return !mc.apiFormat || mc.apiFormat === 'openai'
  return mc.provider !== 'openai' && mc.provider !== 'anthropic'
}

/** GLM 5.2 判定的唯一维护处（payload 适配 / zai 模板 / 档位能力推导三处共用，分写会漂移） */
export function isGlm52Model(model: string | undefined): boolean {
  return /^(?:z-ai\/|zai\/)?glm-5\.2(?:$|[-_.])/i.test(model || '')
}

/**
 * 该模型是否支持思考"档位"（low/medium/high），供输入框决定显示档位菜单还是纯开关。
 * 按方言协议推导（能力位体系口径：确定支持才亮，不确定不显示）：
 * - openai / deepseek 方言：原生 reasoning_effort 字段
 * - zai 方言且 GLM 5.2：payload 适配器注入 reasoning_effort（2026-07-28 网关实测
 *   low/medium/high 全部 200；且缺省不发= 不思考，开思考必须带档位）
 * - anthropic 协议：pi 把 thinkingLevel 映射成 effort / budget_tokens
 * - qwen 方言：Token Plan Qwen3.8 使用 Pi 原生 effort 映射；Qwen3.7 则仅在
 *   服务商/模型明确支持 thinking_budget 时显示档位
 */
export function supportsEffortDial(mc: ModelConfig): boolean {
  if (!mc.supportsThinking) return false
  if (mc.provider === 'custom' && mc.apiFormat === 'anthropic') return true
  if (mc.provider === 'anthropic' || mc.provider === 'openai') return true
  if (!usesOpenAICompletions(mc)) return false
  const format = resolveThinkingFormat(mc)
  if (format === 'openai' || format === 'deepseek') return true
  if (format === 'zai') return isGlm52Model(mc.model)
  if (format === 'qwen') return resolveQwenThinkingControl(mc) !== 'toggle'
  return false
}

function validThinkingBudgets(value: unknown): value is ThinkingBudgets {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const budgets = value as Record<string, unknown>
  const values = [budgets.low, budgets.medium, budgets.high]
  if (!values.every(v => typeof v === 'number' && Number.isInteger(v) && v > 0)) return false
  const [low, medium, high] = values as number[]
  return low <= medium && medium <= high
}

/** 只有直连 Model Studio 才使用 OpenPipal 的 Qwen3.7 token 预算默认值。 */
function isDirectDashScopeEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    return /^dashscope(?:-[a-z0-9]+)?\.aliyuncs\.com$/.test(hostname)
      || hostname.endsWith('.dashscope.aliyuncs.com')
  } catch {
    return false
  }
}

function isAutoBudgetQwenModel(model: string): boolean {
  const normalized = model.toLowerCase()
  return /qwen3(?:[._-]\d+)?/.test(normalized) && !/coder/.test(normalized)
}

/**
 * Qwen 思考预算的唯一解析口径。
 * 显式模型/服务商配置优先；只有官方 Model Studio 的非 Coder Qwen3 才自动启用默认档位，
 * 第三方网关保持保守（纯开关），由设置页显式声明其是否透传 thinking_budget。
 */
export function resolveQwenThinkingBudgets(mc: ModelConfig): ThinkingBudgets | null {
  if (resolveThinkingFormat(mc) !== 'qwen') return null
  // Token Plan 的 Qwen3.8 原生支持 reasoning_effort；给它附加 3.7 的
  // thinking_budget 会把两个代际的协议混在同一个请求里。
  if (usesNativeQwenReasoningEffort(mc)) return null
  if (mc.thinkingBudgets === null) return null
  if (validThinkingBudgets(mc.thinkingBudgets)) return { ...mc.thinkingBudgets }
  if (isDirectDashScopeEndpoint(mc.baseUrl) && isAutoBudgetQwenModel(mc.model)) {
    return { ...DEFAULT_QWEN_THINKING_BUDGETS }
  }
  return null
}

/** Qwen 的三种实际控制方式，必须按服务商 + 模型分辨，不能只按模型名猜。 */
export type QwenThinkingControl = 'toggle' | 'budget' | 'effort'

export function resolveQwenThinkingControl(mc: ModelConfig): QwenThinkingControl {
  if (resolveThinkingFormat(mc) !== 'qwen') return 'toggle'
  if (usesNativeQwenReasoningEffort(mc)) return 'effort'
  return resolveQwenThinkingBudgets(mc) ? 'budget' : 'toggle'
}

/**
 * Qwen 把思考 token 计入 completion 上限；部分兼容模板的 max_completion_tokens
 * 恰好等于 thinking_budget 会被服务端拒绝。原生 Qwen 模型元数据通常已经给出更大
 * 的上限；这里仅为旧/第三方模板补最小的 2K 输出余量，不改没有显式上限的请求。
 */
function ensureQwenBudgetOutputHeadroom(payload: Record<string, any>, thinkingBudget: number): void {
  for (const field of ['max_completion_tokens', 'max_tokens']) {
    const current = payload[field]
    if (typeof current === 'number' && Number.isFinite(current) && current <= thinkingBudget) {
      payload[field] = thinkingBudget + 2_048
      return
    }
  }
}

/**
 * 补齐 Pi 原生目录之外的模型方言：
 * - Z.AI：把旧 enable_thinking 改写为 thinking 对象，并注入 GLM 5.2 reasoning_effort
 * - Qwen3.7：保留 Pi 生成的 enable_thinking，并按 OpenPipal 档位注入 thinking_budget
 * - Token Plan Qwen3.8：完全保留 Pi 原生 payload（enable_thinking + reasoning_effort）
 * 返回新对象，不原地修改 Pi 提供的 payload，便于测试和并发安全。
 */
export function adaptModelRequestPayload(
  payload: unknown,
  mc: ModelConfig,
  opts?: { reasoningEffort?: ThinkingLevelChoice }
): unknown {
  if (!usesOpenAICompletions(mc)) return payload
  const format = resolveThinkingFormat(mc)
  if (format !== 'zai' && format !== 'qwen') return payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload

  const source = payload as Record<string, any>
  const next: Record<string, any> = { ...source }
  if (format === 'qwen') {
    if (source.enable_thinking === true) {
      const budgets = resolveQwenThinkingBudgets(mc)
      if (budgets && !Number.isInteger(source.thinking_budget)) {
        const thinkingBudget = budgets[opts?.reasoningEffort ?? 'low']
        next.thinking_budget = thinkingBudget
        ensureQwenBudgetOutputHeadroom(next, thinkingBudget)
        return next
      }
      return payload
    }
    if (Object.prototype.hasOwnProperty.call(source, 'thinking_budget')) {
      delete next.thinking_budget
      return next
    }
    return payload
  }

  const hasThinkingControl = Object.prototype.hasOwnProperty.call(source, 'enable_thinking')
    || (source.thinking && typeof source.thinking === 'object')

  if (hasThinkingControl) {
    const enabled = source.enable_thinking === true || source.thinking?.type === 'enabled'
    delete next.enable_thinking
    next.thinking = enabled
      ? { type: 'enabled', clear_thinking: false }
      : { type: 'disabled' }

    // GLM-5.2 开思考时必须带 reasoning_effort（2026-07-28 网关实测：缺省不发=不思考），
    // 档位优先级：pi 已生成的字段 > 用户所选档位（opts）> 'low'（辅助路径默认轻量）。
    if (enabled && isGlm52Model(mc.model)) {
      next.reasoning_effort = typeof source.reasoning_effort === 'string'
        ? source.reasoning_effort
        : (opts?.reasoningEffort ?? 'low')
    } else if (!enabled) {
      delete next.reasoning_effort
    }
  }

  // GLM 4.6+ 只有同时开启 stream + tool_stream 才会逐步返回工具参数。
  if (source.stream === true && Array.isArray(source.tools) && source.tools.length > 0) {
    next.tool_stream = true
  }

  return next
}

export function createModelPayloadAdapter(
  mc: ModelConfig = getEffectiveModelConfig(),
  opts?: { reasoningEffort?: ThinkingLevelChoice }
) {
  return (payload: unknown): unknown => adaptModelRequestPayload(payload, mc, opts)
}

/**
 * 单次连接尝试（原 testConnection 主体抽出，供编排层重试复用）。
 *
 * 与真实对话同源、同管线：
 * - buildModelFromConfig 构建 Model（custom 默认走 groq completions 模板；GLM 走 zai 模板）
 * - pi-ai 的 completeSimple 直接对该 Model 发请求（不经 OpenAI SDK，不经 Pi Agent 工具循环）
 * - 请求形状对齐对话：带一个 dummy 工具（工具序列化路径必须被覆盖）+ 按
 *   modelConfig.supportsThinking 复刻 pi-agent-service 的 thinkingLevel 决策
 *   （'low'/'off' → 对应方言字段），并经 onPayload 做 GLM 新协议改写
 * - apiKey 走 completeSimple 的 options.apiKey（pi-ai 各 provider 均优先用它，
 *   不改全局 env，避免并发测试互相污染）
 * - content-type 门闩：实测发现 baseUrl 缺 /v1 时网关返回 HTTP 200 + text/html（SPA
 *   catch-all）。pi-ai 请求时按 SSE 流解析 body，非法 SSE 帧被静默解析成 0 个 chunk——
 *   stopReason 仍是 'stop'、不报错，是最阴险的假成功。必须用 onResponse 读 content-type
 *   兜底，JSON/event-stream 之外一律判定为"网关返回了非 API 响应"
 * - nonApiResponse：content-type 门闩触发，或 friendlyProviderError 判定 raw 里含 HTML
 *   标签（网关返回了网页），两种情况都置 true——供编排层判断"要不要试着补 /v1 重试"
 */
async function attemptConnection(modelConfig: ModelConfig): Promise<{ ok: boolean; error?: string; errorKey?: string; errorParams?: Record<string, string>; model?: string; nonApiResponse?: boolean }> {
  const model = buildModelFromConfig(modelConfig)
  const thinkingLevel: 'off' | ThinkingLevel = resolveAuxThinkingLevel(modelConfig, model)

  const context: Context = {
    messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    tools: [{ name: 'ping', description: '连接测试占位工具（不会被调用），用于覆盖工具序列化路径', parameters: Type.Object({}) }]
  }

  const TIMEOUT_MS = 15000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const TIMED_OUT = Symbol('timeout')
  let responseContentType = ''

  try {
    const completion = completeSimple(model, context, {
      apiKey: modelConfig.apiKey,
      maxTokens: 16,
      maxRetries: 1,
      reasoning: thinkingLevel === 'off' ? undefined : thinkingLevel,
      signal: controller.signal,
      timeoutMs: TIMEOUT_MS,
      onPayload: createModelPayloadAdapter(modelConfig),
      onResponse: (resp) => { responseContentType = resp.headers['content-type'] || resp.headers['Content-Type'] || '' }
    })
    const result = await Promise.race([
      completion,
      new Promise<typeof TIMED_OUT>((resolve) => setTimeout(() => resolve(TIMED_OUT), TIMEOUT_MS))
    ])

    if (result === TIMED_OUT || result.stopReason === 'aborted') {
      // race 甩开的 completion 在 abort 后才 reject，不接住会变成 unhandled rejection
      completion.catch(() => {})
      return { ok: false, error: '连接超时（15s）', errorKey: 'settings.model.errors.connectionTimeout' }
    }
    const ct = responseContentType.toLowerCase()
    if (ct && !ct.includes('json') && !ct.includes('event-stream')) {
      return {
        ok: false,
        error: nonApiResponseMessage(modelConfig.baseUrl),
        nonApiResponse: true,
        errorKey: 'settings.model.errors.nonApiResponse',
        errorParams: { baseUrl: modelConfig.baseUrl }
      }
    }

    // Pi 0.83 会把 text/html 当作一条无 finish_reason 的错误流；content-type
    // 是更早也更可靠的证据，必须先于 stopReason 判断，否则 /v1 探测退化失效。
    if (result.stopReason === 'error') {
      // errorMessage 为空时的 'API 返回错误' 是本进程自造的兜底文案（非网关原文）——只有这种
      // 情况才配 errorKey；一旦网关给了真实文本，翻译必须让位给原文透传（红线：不能篡改网关证据）。
      const errorMessageEmpty = !result.errorMessage
      const raw = result.errorMessage || 'API 返回错误'
      const nonApiResponse = /<!doctype|<html/i.test(raw)
      return {
        ok: false,
        error: friendlyProviderError(raw, modelConfig.baseUrl),
        nonApiResponse,
        ...(nonApiResponse
          ? { errorKey: 'settings.model.errors.nonApiResponse', errorParams: { baseUrl: modelConfig.baseUrl } }
          : errorMessageEmpty
            ? { errorKey: 'settings.model.errors.apiError' }
            : {})
      }
    }

    return {
      ok: true,
      model: result.responseModel || result.model || modelConfig.model
    }
  } catch (err: unknown) {
    const diag = extractDiagnosticError(err)
    const nonApiResponse = /<!doctype|<html/i.test(diag.message || '')
    return {
      ok: false,
      error: friendlyProviderError(diag.message, modelConfig.baseUrl),
      nonApiResponse,
      // diag.message 为空时 friendlyProviderError 内部兜底成 '连接失败'——同属本进程自造文案，
      // 复用既有 connectionFailed key，不新开条目。
      ...(nonApiResponse
        ? { errorKey: 'settings.model.errors.nonApiResponse', errorParams: { baseUrl: modelConfig.baseUrl } }
        : !diag.message
          ? { errorKey: 'settings.model.errors.connectionFailed' }
          : {})
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 测试 API 连接（编排层）。
 *
 * 用户只想填裸网址（如 https://x666.me），但不能固定拼 /v1——现有 preset 里既有
 * /compatible-mode/v1（前缀带 v1）也有 /v1/ai/cloudbase（v1 在中间）这类反例。
 * 策略：先按用户原样尝试；只有失败且判定为"网关返回了非 API 响应"、且 baseUrl 还不是
 * /v1 结尾时，才补 /v1 重试一次。补全成功则把 correctedBaseUrl 带回去（渲染层据此回填
 * 输入框），不自动写 config——保存动作仍由用户点保存触发。
 */
export async function testConnection(modelConfig: ModelConfig): Promise<{ ok: boolean; error?: string; errorKey?: string; errorParams?: Record<string, string>; model?: string; correctedBaseUrl?: string }> {
  const first = await attemptConnection(modelConfig)
  if (first.ok) return { ok: true, model: first.model }

  // Anthropic 格式的 baseUrl 约定和 OpenAI 兼容协议正相反：根地址不带 /v1，SDK 内部自己拼
  // /v1/messages（见 createCustomAnthropicModel 注释）。补 /v1 只会把请求打错（变成
  // <root>/v1/v1/messages 404），必须整段跳过这个探测重试，直接把原始错误透传回去。
  // 'openai-responses' 不在这条排除名单里：它的 baseUrl 约定和默认 'openai' completions
  // 分支同源——都是"根地址 + /v1"，OpenAI SDK 只在其后拼 /chat/completions 或 /responses
  // （见 createCustomResponsesModel 注释），所以补 /v1 探测重试对它同样合理，与 'openai' 同待遇。
  if (modelConfig.apiFormat === 'anthropic' || !first.nonApiResponse || !shouldRetryWithV1(modelConfig.baseUrl)) {
    return { ok: false, error: first.error, errorKey: first.errorKey, errorParams: first.errorParams }
  }

  const correctedBaseUrl = appendV1(modelConfig.baseUrl)
  const retry = await attemptConnection({ ...modelConfig, baseUrl: correctedBaseUrl })

  if (retry.ok) {
    return { ok: true, model: retry.model, correctedBaseUrl }
  }
  if (!retry.nonApiResponse) {
    // /v1 打到了真 API，只是网关另有问题（如 503）——比"返回了网页"更接近真相
    // 拼接模板本身是本进程自造文案（非网关原文）——单独开 key；内嵌的 retry.error 原样带入
    // 参数，网关原文该透传的部分继续透传，不因外层套了个翻译模板就被吞掉。
    return {
      ok: false,
      error: `已自动尝试 ${correctedBaseUrl}：${retry.error}`,
      errorKey: 'settings.model.errors.autoRetryFailed',
      errorParams: { baseUrl: correctedBaseUrl, error: retry.error || '' }
    }
  }
  // 补 /v1 也没用，别误导——返回原始错误
  return { ok: false, error: first.error, errorKey: first.errorKey, errorParams: first.errorParams }
}

/**
 * 检查是否已配置 API Key
 */
export function hasApiKey(): boolean {
  const mc = getEffectiveModelConfig()
  return !!mc.apiKey
}

/**
 * 判断是否使用用户自定义配置（而非内置 .env 回退）
 */
export function isUserCustomConfig(): boolean {
  const config = loadConfig()
  return !!config.modelConfig?.apiKey
}

/**
 * 清除用户自定义模型配置，回退到内置
 */
export function clearModelConfig(): void {
  const config = loadConfig()
  delete config.modelConfig
  saveConfig(config)
  console.log('[Config] 已清除自定义配置，回退到内置')
}

// --- Pi 模型配置 ---

import type { Model, Context, ThinkingLevel } from '@earendil-works/pi-ai/compat'
import { getModel as piGetModel, getModels as piGetModels, getProviders as piGetProviders, completeSimple, extractDiagnosticError } from '@earendil-works/pi-ai/compat'
import { Type } from 'typebox'
import { getDataRoot } from './data-root'

/**
 * OpenPipal provider → Pi provider 映射
 */
const PROVIDER_MAP: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  openrouter: 'openrouter',
  google: 'google',
  xai: 'xai',
  groq: 'groq',
  mistral: 'mistral',
  cerebras: 'cerebras',
  zai: 'zai',
  'qwen-token-plan': 'qwen-token-plan',
  'qwen-token-plan-cn': 'qwen-token-plan-cn',
}

type NativeQwenTokenPlanProvider = 'qwen-token-plan' | 'qwen-token-plan-cn'

const QWEN_TOKEN_PLAN_HOSTS: Readonly<Record<string, NativeQwenTokenPlanProvider>> = {
  'token-plan.ap-southeast-1.maas.aliyuncs.com': 'qwen-token-plan',
  'token-plan.cn-beijing.maas.aliyuncs.com': 'qwen-token-plan-cn'
}

function isNativeQwenTokenPlanProvider(value: string | undefined): value is NativeQwenTokenPlanProvider {
  return value === 'qwen-token-plan' || value === 'qwen-token-plan-cn'
}

function isQwenModel(model: string | undefined): boolean {
  return /(?:^|\/)qwen/i.test(model || '')
}

/**
 * Pi 0.81+ 把 Token Plan（国际/CN）列为原生 provider。已有配置仍可保持
 * provider='custom'：只要它指向官方 Token Plan 或直连 DashScope，并且模型在
 * Pi 的目录中，就自动使用这条原生模型定义，而不把用户迁移到新的设置格式。
 */
function resolveNativeQwenProvider(mc: ModelConfig): NativeQwenTokenPlanProvider | undefined {
  if (!isQwenModel(mc.model)) return undefined
  if (isNativeQwenTokenPlanProvider(mc.provider)) return mc.provider
  try {
    const host = new URL(mc.baseUrl).hostname.toLowerCase()
    const tokenPlanProvider = QWEN_TOKEN_PLAN_HOSTS[host]
    if (tokenPlanProvider) return tokenPlanProvider
  } catch {
    return undefined
  }
  // DashScope 直连没有单独的 Pi provider；复用同一官方 Qwen 模型目录作为
  // 元数据来源，但保留用户填写的 DashScope baseUrl 和 key。
  return isDirectDashScopeEndpoint(mc.baseUrl) ? 'qwen-token-plan-cn' : undefined
}

function getNativeQwenModelTemplate(mc: ModelConfig): Model<any> | undefined {
  const provider = resolveNativeQwenProvider(mc)
  if (!provider) return undefined
  const exact = piGetModel(provider as any, mc.model as any) as Model<any> | undefined
  if (exact) return exact

  // Pi 0.84.1 将目录里的预览名称收敛为 qwen3.8-max。旧 OpenPipal 配置仍可能
  // 保存 qwen3.8-max-preview；只借用新目录的能力元数据，createNativeQwenModel
  // 会把 id 覆盖回用户原值，避免升级后静默改发另一个模型名。
  if (mc.model === 'qwen3.8-max-preview') {
    return piGetModel(provider as any, 'qwen3.8-max' as any) as Model<any> | undefined
  }
  return undefined
}

/** Token Plan Qwen3.8 的 Pi 原生目录声明 supportsReasoningEffort=true。 */
function usesNativeQwenReasoningEffort(mc: ModelConfig): boolean {
  return !!(getNativeQwenModelTemplate(mc) as any)?.compat?.supportsReasoningEffort
}

/**
 * 从 Pi 原生 Qwen 目录构造运行时模型，并只覆盖用户配置的连接与能力字段。
 * 这样 Qwen3.7 Plus 拿到正确的 1M context / 64K maxTokens，Qwen3.8 则保留
 * Pi 的 thinkingLevelMap（UI 的“高”会由 Pi clamp 到 xhigh）。
 */
function createNativeQwenModel(mc: ModelConfig): Model<any> | undefined {
  const template = getNativeQwenModelTemplate(mc)
  if (!template) return undefined
  return {
    ...template,
    id: mc.model,
    baseUrl: mc.baseUrl || template.baseUrl,
    reasoning: mc.supportsThinking ?? template.reasoning,
    input: mc.supportsImages === false
      ? ['text']
      : (mc.supportsImages === true ? ['text', 'image'] : template.input),
    contextWindow: mc.contextWindow || template.contextWindow
  } as Model<any>
}

function createZaiCompatModel(mc: ModelConfig): Model<any> {
  const zaiModels = piGetModels('zai' as any)
  const template = zaiModels.find((m: any) => m.id === 'glm-5.1')
    || zaiModels.find((m: any) => m.reasoning)
    || zaiModels[0]
  if (!template) {
    throw new Error('[Config] Pi 内置 zai 模型表为空，无法构造 GLM 端点')
  }

  const isGlm52 = isGlm52Model(mc.model)
  return {
    ...template,
    id: mc.model,
    baseUrl: mc.baseUrl,
    reasoning: !!mc.supportsThinking,
    input: mc.supportsImages === undefined
      ? template.input
      : (mc.supportsImages ? ['text', 'image'] : ['text']),
    contextWindow: mc.contextWindow || (isGlm52 ? 1_000_000 : template.contextWindow),
    compat: {
      ...(template as any).compat,
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: isGlm52,
      thinkingFormat: 'zai',
      zaiToolStream: true,
    }
  }
}

/**
 * 创建自定义 OpenAI 兼容模型（用于非标准 provider）。
 * 基于 groq 的模型模板（使用 openai-completions API），覆盖 baseUrl 和 id。
 */
function createCustomCompatModel(mc: ModelConfig): Model<any> {
  const thinkingFormat = resolveThinkingFormat(mc)
  if (thinkingFormat === 'zai') {
    return createZaiCompatModel(mc)
  }

  // 用 groq provider 模型作为模板——使用标准 openai-completions API（/v1/chat/completions）
  // 不能用 openai provider：Pi 已全面迁移到 Responses API（/v1/responses），代理不支持
  const groqModels = piGetModels('groq' as any)
  const template = groqModels.find((m: any) => !m.reasoning) || groqModels[0]
  if (!template) {
    const openaiModels = piGetModels('openai' as any)
    return { ...(openaiModels[0] || {}), id: mc.model, baseUrl: mc.baseUrl, reasoning: !!mc.supportsThinking }
  }
  // 覆盖 id 和 baseUrl，保留 openai-completions 的 API 调用格式
  // 对自定义兼容端点，禁用 OpenAI 专有特性以兼容各类代理（302.ai、x666 等）
  const compat: any = {
    ...(template as any).compat,
    supportsStore: false,
    supportsStrictMode: false,
    supportsDeveloperRole: false,
  }
  // 用户声明 supportsThinking=true 时：注入已解析的思考方言。
  // Qwen 走 enable_thinking，DeepSeek/OpenAI 走各自参数；Z.AI 在上方独立分支处理。
  // 不声明则保持原有"模板默认行为"（一般是不发 thinking 字段，模型默认行为）。
  // 未配置时 resolveThinkingFormat 仍以 qwen 作历史兼容回落。
  if (mc.supportsThinking) {
    compat.thinkingFormat = thinkingFormat
    // openai 方言的档位靠 pi 的 reasoning_effort 分支，该分支要求 compat 位显式开
    //（groq 模板缺省不带）——否则档位菜单选了也发不出去，成为无实效的 UI 谎言。
    if (thinkingFormat === 'openai') compat.supportsReasoningEffort = true
  }
  // 图片能力按声明走：默认支持（Qwen-VL/GPT-4o 等多模态端点），显式 false = 纯文本模型，
  // 让 pi-ai 的 downgradeUnsupportedImages 把历史图片降级为占位文本而不是发给网关吃 400
  return {
    ...template,
    id: mc.model,
    baseUrl: mc.baseUrl,
    reasoning: !!mc.supportsThinking,  // Pi 内部条件之一：model.reasoning 必须为真
    compat,
    input: mc.supportsImages === false ? ['text'] : ['text', 'image']
  }
}

/**
 * 创建自定义 Anthropic Messages 格式模型（第三方抄 Anthropic 协议的网关）。
 * 基于 Pi 内置 anthropic provider 的模型模板，覆盖 baseUrl 和 id——与
 * createCustomCompatModel 对称的结构（模板取字段，只换 id/baseUrl/能力位）。
 *
 * baseUrl 约定（已读 node_modules/@earendil-works/pi-ai 的 anthropic provider 源码核实）：
 * - Pi 内置 anthropic 模板 baseUrl = 'https://api.anthropic.com'（不带 /v1）
 * - createClient() 用 `new Anthropic({ baseURL: model.baseUrl, apiKey, ... })`
 * - @anthropic-ai/sdk 内部固定 `client.post('/v1/messages', ...)`——baseURL 只是根地址，
 *   /v1/messages 由 SDK 自己拼接，不需要（也不应该）用户在 baseUrl 里带 /v1
 * 用户该怎么填：填网关的「根地址」（如 https://your-gateway.com），不要带 /v1 或
 * /v1/messages；填错带 /v1 会打到 <root>/v1/v1/messages 变 404。UI 提示文案需要体现这点。
 *
 * provider 字段刻意不覆盖，保留模板的 'anthropic'：
 * - ensurePiApiKey(model.provider) → setApiKeyEnv('anthropic', apiKey) →
 *   PROVIDER_ENV_MAP['anthropic'] = 'ANTHROPIC_API_KEY'（已登记，见下方），无需新增映射
 * - pi-ai 的 getEnvApiKey('anthropic') 兜底路径也认 ANTHROPIC_API_KEY，同源
 * 这与 createCustomCompatModel 不覆盖 groq 模板的 provider 字段是同一约定。
 */
function createCustomAnthropicModel(mc: ModelConfig): Model<any> {
  const anthropicModels = piGetModels('anthropic' as any)
  const template = anthropicModels.find((m: any) => !m.reasoning) || anthropicModels[0]
  if (!template) {
    // 理论不可达：Pi 内置 anthropic 模型表非空（截至集成时有 claude-3-5-haiku 等多个条目）。
    // 万一未来 Pi 版本清空了这张表，没有协议模板可抄，只能报错而不是伪造一个模型对象。
    throw new Error('[Config] Pi 内置 anthropic 模型表为空，无法构造自定义 Anthropic 端点')
  }
  // Claude Code 约定：模型名后缀 [1m] = 启用 1M 上下文。协议层实现是剥掉后缀发真实模型名，
  // 并附 anthropic-beta: context-1m-2025-08-07 请求头（Sonnet 4/4.5 世代 1M 是 beta opt-in；
  // 新世代模型 1M 默认开启、多带这个头无害）。国内网关普遍要求显式启用（实测报错
  // "请启用 1m 上下文后重试"），这里对齐 Claude Code 行为让用户填 xxx[1m] 即可。
  const oneMillion = /\[1m\]\s*$/i.test(mc.model)
  const realModelId = oneMillion ? mc.model.replace(/\[1m\]\s*$/i, '').trim() : mc.model
  return {
    ...template,
    id: realModelId,
    baseUrl: mc.baseUrl,
    reasoning: !!mc.supportsThinking,
    input: mc.supportsImages === false ? ['text'] : ['text', 'image'],
    // [1m] 时上下文窗口兜底 1M（用户手填的 contextWindow 仍优先）
    contextWindow: mc.contextWindow || (oneMillion ? 1_000_000 : template.contextWindow),
    ...(oneMillion
      ? { headers: { ...(template as any).headers, 'anthropic-beta': 'context-1m-2025-08-07' } }
      : {})
  }
}

/**
 * 创建自定义 OpenAI Responses API 格式模型（第三方抄 Responses 协议的网关）。
 * 与 createCustomAnthropicModel 结构对称：基于 Pi 内置 openai provider 的模型模板
 * （模板本身就是 api:'openai-responses'——Pi 已全面迁移 openai provider 到 Responses API，
 * 见 createCustomCompatModel 顶部注释），只覆盖 id/baseUrl/能力位。
 *
 * baseUrl 约定（已读 node_modules/@earendil-works/pi-ai 的 openai-responses provider 源码核实）：
 * - Pi 内置 openai 模板 baseUrl = 'https://api.openai.com/v1'（带 /v1）
 * - createClient() 用 `new OpenAI({ baseURL: model.baseUrl, ... })`
 * - openai SDK 的 client.responses.create() 内部固定请求 '/responses' 相对路径——baseURL
 *   只是"根地址+版本前缀"，/v1 必须留在 baseUrl 里，完整端点形状是 {baseUrl}/responses，
 *   即 {根地址}/v1/responses。这与默认 'openai' completions 分支（{baseUrl}/chat/completions，
 *   baseUrl 同样带 /v1）是同一约定，和 createCustomAnthropicModel 的"根地址不带 /v1"正相反。
 *
 * compat 字段刻意不覆盖：OpenAIResponsesCompat 只有 sendSessionIdHeader/
 * supportsLongCacheRetention 两个开关，默认值（true/true）对第三方网关无害，不像
 * completions 分支需要显式关掉 store/strictMode/developerRole 那些 OpenAI 专有特性。
 *
 * provider 字段同样不覆盖，保留模板的 'openai'——ensurePiApiKey/setApiKeyEnv 对 'openai'
 * 有专门兜底（见 setApiKeyEnv 注释），且 attemptConnection 已经把 apiKey 通过
 * options.apiKey 直传，不依赖环境变量这条路径。
 */
function createCustomResponsesModel(mc: ModelConfig): Model<any> {
  const openaiModels = piGetModels('openai' as any)
  const template = openaiModels.find((m: any) => !m.reasoning) || openaiModels[0]
  if (!template) {
    // 理论不可达：Pi 内置 openai 模型表非空（截至集成时有 gpt-4/gpt-4-turbo 等多个条目）。
    throw new Error('[Config] Pi 内置 openai 模型表为空，无法构造自定义 Responses 端点')
  }
  return {
    ...template,
    id: mc.model,
    baseUrl: mc.baseUrl,
    reasoning: !!mc.supportsThinking,
    input: mc.supportsImages === false ? ['text'] : ['text', 'image'],
    contextWindow: mc.contextWindow || template.contextWindow
  }
}

/**
 * 从 ModelConfig 构造 Pi Model 对象（纯函数版，不读全局）。
 * 1. custom + apiFormat==='anthropic'：走自定义 Anthropic Messages 协议
 * 1b. custom + apiFormat==='openai-responses'：走自定义 OpenAI Responses 协议
 * 2. 先尝试映射到 Pi 的内置 provider+model
 * 3. 对于未映射的 provider，尝试通过 openrouter
 * 4. 兜底：创建自定义 OpenAI 兼容模型（使用用户配置的 baseUrl）
 */
export function buildModelFromConfig(mc: ModelConfig): Model<any> {
  const nativeQwenModel = createNativeQwenModel(mc)
  if (nativeQwenModel) {
    console.log(`[Config] Pi 原生 Qwen 模型已映射: ${nativeQwenModel.provider}/${mc.model}`)
    return nativeQwenModel
  }

  const piProvider = PROVIDER_MAP[mc.provider]

  // 当前锁定的 Pi 0.74 尚未登记 GLM-5.2；用同 provider 模板补齐新版能力位。
  if (piProvider === 'zai' && !piGetModel('zai' as any, mc.model as any)) {
    return createZaiCompatModel(mc)
  }

  if (piProvider) {
    // 注：实测当前 @earendil-works/pi-ai 版本的 getModel() 对未知 model id 直接返回
    // undefined，不抛错（node -e 验证过）；下面的 try/catch 是防御性写法，真正兜底判断
    // 靠 `if (model)`。两条路径都不允许"偷偷换成 models[0]"——那是一个跟用户输入的
    // model id 毫不相干的模型，用户以为在跟 A 对话实际发给了 B，是本次要消灭的断点。
    let model: Model<any> | undefined
    try {
      model = piGetModel(piProvider as any, mc.model as any)
    } catch (err: any) {
      console.warn(`[Config] Pi 模型 ${piProvider}/${mc.model} 查询抛错: ${err.message}`)
    }
    if (model) {
      console.log(`[Config] Pi 模型已映射: ${piProvider}/${mc.model}`)
      return model
    }
    console.warn(`[Config] Pi 内置模型表没有 ${piProvider}/${mc.model}`)
    const models = piGetModels(piProvider as any)
    if (models.length > 0) {
      // 模板 + 覆盖 id：协议/baseUrl 取该 provider 任一模板（同 provider 协议一致），
      // id 强制覆盖成用户填的值——发出去的请求 model 字段仍是用户预期的那个，只是
      // Pi 内置定价/contextWindow 等元数据是模板占位值（不影响协议正确性）。
      // baseUrl 用户若显式填了也覆盖（如指向该 provider 的镜像/代理）。
      const template = models[0]
      console.log(`[Config] Pi 内置模型表缺 ${piProvider}/${mc.model}，用同 provider 模板覆盖 id 构造`)
      return { ...template, id: mc.model, baseUrl: mc.baseUrl || template.baseUrl }
    }
    // 连模板都没有：这个 provider 在 PROVIDER_MAP 里有映射，但 Pi 当前版本没注册任何
    // 该 provider 的模型（理论不可达——openai/anthropic/openrouter/google/xai/groq/
    // mistral/cerebras 在 Pi 内置表里目前都非空）。没有协议可抄，只能报错让上层
    // （testConnection/agentChat）显式暴露配置问题，而不是悄悄换成另一个协议。
    throw new Error(`Provider "${piProvider}" 在 Pi 内置模型表中没有任何模型，无法构造 "${mc.model}"`)
  }

  // 未映射的 provider，尝试 openrouter（同样不允许 undefined 静默当作"映射成功"返回）
  if (!piProvider && mc.provider !== 'custom') {
    try {
      const orModelId = `${mc.provider}/${mc.model}` as any
      const model = piGetModel('openrouter', orModelId)
      if (model) {
        console.log(`[Config] Pi 通过 OpenRouter 映射: openrouter/${orModelId}`)
        return model
      }
      console.warn(`[Config] OpenRouter 里没有 openrouter/${orModelId}，回落自定义兼容模型`)
    } catch (err: any) {
      console.warn(`[Config] OpenRouter 映射失败: ${err.message}`)
    }
  }

  // 兜底：custom provider（或以上映射全部失败）——按 apiFormat 分流协议
  if (mc.provider === 'custom' && mc.apiFormat === 'anthropic') {
    console.log(`[Config] Pi 使用自定义 Anthropic 端点: ${mc.baseUrl} / ${mc.model}`)
    return createCustomAnthropicModel(mc)
  }
  if (mc.provider === 'custom' && mc.apiFormat === 'openai-responses') {
    console.log(`[Config] Pi 使用自定义 OpenAI Responses 端点: ${mc.baseUrl} / ${mc.model}`)
    return createCustomResponsesModel(mc)
  }
  // apiFormat undefined/'openai'（默认，逐字节不变）：OpenAI 兼容 completions 协议
  console.log(`[Config] Pi 使用自定义兼容模型: ${mc.baseUrl} / ${mc.model}`)
  return createCustomCompatModel(mc)
}

/**
 * 获取当前生效的 Pi Model 对象（薄壳，读全局）。
 */
export function getPiModel(): Model<any> {
  return buildModelFromConfig(getEffectiveModelConfig())
}

/**
 * Pi 按 provider 名查环境变量获取 API key（如 groq → GROQ_API_KEY）。
 * 此函数确保我们的 API key 被设到 Pi 期望的环境变量中。
 */
const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  zai: 'ZAI_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
}

function setApiKeyEnv(piProvider: string, apiKey: string): void {
  const envVar = PROVIDER_ENV_MAP[piProvider]
  if (envVar) {
    process.env[envVar] = apiKey
  }
  // 自定义兼容模型走 openai provider，确保 OPENAI_API_KEY 被设置
  if (!envVar || piProvider === 'openai') {
    process.env.OPENAI_API_KEY = apiKey
  }
}

export function ensurePiApiKey(piProvider: string): void {
  const mc = getEffectiveModelConfig()
  if (!mc.apiKey) return
  // 用户在 UI 配置的 key 总是覆盖 .env 里的旧值
  setApiKeyEnv(piProvider, mc.apiKey)
}

/**
 * 为指定 ModelConfig（不依赖全局）设置 API key 环境变量。
 * 用于自动检测等场景——临时配置不污染全局 modelConfig。
 */
export function ensurePiApiKeyFor(piProvider: string, mc: ModelConfig): void {
  if (mc.apiKey) setApiKeyEnv(piProvider, mc.apiKey)
}

/**
 * 会话级流选项注入器——"按请求显式传递"的选项统一在此拼装（pi-ai 各 provider 均为
 * options 显式值优先于环境变量/默认值）：
 * - apiKey：根治并发互踩（2026-07-21 实案面）：会话专属模型上线后，同 provider 不同 key
 *   的会话并发时，经 process.env 承载的 key 会被后建 session 覆盖，在飞请求拿错 key → 401。
 *   注入后 env 不再承重（仍设置，给未覆盖路径兜底）。
 * - cacheRetention：提示缓存保留时长，按实际发往的 pi Model 门控（见
 *   resolveCacheRetentionForModel），未命中门控时不注入、走 pi-ai 默认 'short'。
 */
export function withSessionStreamOptions<T extends (...a: any[]) => any>(streamFn: T, mc: ModelConfig): T {
  const key = mc.apiKey || undefined
  return ((model: any, context: any, options?: any) => {
    const cacheRetention = resolveCacheRetentionForModel(model)
    if (!key && !cacheRetention) return (streamFn as any)(model, context, options)
    return (streamFn as any)(model, context, {
      ...options,
      ...(key ? { apiKey: key } : {}),
      ...(cacheRetention !== undefined && options?.cacheRetention === undefined ? { cacheRetention } : {})
    })
  }) as unknown as T
}

/**
 * 无会话上下文场景（辅助路径/连接测试/GoalChecker）的思考档位决策——与主链路
 * pi-agent-service 同一口径：ModelConfig.supportsThinking 能力位优先，回落 Pi 内置
 * model.reasoning；没有「用户开关」概念，等价于主链路默认想要（'low'）。
 * 硬编码 'off' 的教训（2026-07-23 实案）：qwen3.8-max-preview 等强制思考的模型会
 * 400 拒绝 enable_thinking=false，标题生成/记忆抽取/目标判定每轮静默失败。
 */
export function resolveAuxThinkingLevel(mc: ModelConfig, model: { reasoning?: unknown }): 'low' | 'off' {
  return (mc.supportsThinking ?? !!model.reasoning) ? 'low' : 'off'
}

/**
 * 辅助路径 completeSimple 的思考调参：开思考时必须同步抬 maxTokens——
 * completions 路径 pi-ai 不自动加思考余量，reasoning token 计入 completion 预算，
 * 标题生成的 30 tokens 会在思考阶段就被截断。+2048 对齐 pi 自身 low 档思考预算
 * （simple-options adjustMaxTokensForThinking 的默认值）。
 */
export function auxCompletionTuning(
  mc: ModelConfig,
  model: { reasoning?: unknown },
  baseMaxTokens: number
): { reasoning: 'low' | undefined; maxTokens: number } {
  return resolveAuxThinkingLevel(mc, model) === 'low'
    ? { reasoning: 'low', maxTokens: baseMaxTokens + 2048 }
    : { reasoning: undefined, maxTokens: baseMaxTokens }
}


// ---- 模型预设管理 ----

export interface ConversationModelResolution {
  config: ModelConfig
  /** 'conversation' = 命中会话专属预设；'global' = 跟随全局默认（含预设已删的回退） */
  source: 'conversation' | 'global'
  /** 会话引用的预设已被删除时回填其 id——调用方据此留日志/UI 标注，不硬报错 */
  danglingPresetId?: string
}

/**
 * 会话级模型解析：presetId 命中 → 该预设的完整配置；未设置/预设已删 → 全局 getEffectiveModelConfig。
 * 纯读取，不写任何全局状态——会话专属选择永不污染全局默认与其他会话。
 */
export function resolveConversationModelConfig(presetId?: string): ConversationModelResolution {
  if (presetId) {
    const preset = getModelPresetFull(presetId)
    if (preset) return { config: preset.config, source: 'conversation' }
    return { config: getEffectiveModelConfig(), source: 'global', danglingPresetId: presetId }
  }
  return { config: getEffectiveModelConfig(), source: 'global' }
}

export function listModelPresets(): ModelPreset[] {
  const config = loadConfig()
  return config.modelPresets || []
}

export function saveModelPreset(name: string, mc: ModelConfig): ModelPreset {
  const config = loadConfig()
  if (!config.modelPresets) config.modelPresets = []
  const id = `preset_${Date.now()}`
  const preset: ModelPreset = { id, name, providerId: findOrCreateProvider(config, mc), config: mc }
  config.modelPresets.push(preset)
  saveConfig(config)
  return preset
}

/**
 * 返回解析视图（连接字段以服务商实体为准）——所有消费方拿到的仍是完整扁平 ModelConfig。
 * 附带 builtin 标记：IPC 边界据此拒绝把内置连接信息交给渲染层（红线），
 * 主进程内部消费方（会话模型解析）不受影响。
 */
export function getModelPresetFull(id: string): (ModelPreset & { rawConfig: ModelConfig; builtin?: boolean }) | null {
  const config = loadConfig()
  const preset = (config.modelPresets || []).find(p => p.id === id)
  if (!preset) return null
  const provider = preset.providerId ? (config.modelProviders || []).find(p => p.id === preset.providerId) : undefined
  return {
    ...preset,
    config: resolvePresetConfig(preset, config),
    rawConfig: { ...preset.config },
    ...(provider?.builtin ? { builtin: true } : {})
  }
}

/** 服务商全量读取（含明文 key，供"该服务商下添加模型"预填连接字段）。builtin 拒绝返回。 */
export function getModelProviderFull(id: string): ModelProvider | null {
  const config = loadConfig()
  const provider = (config.modelProviders || []).find(p => p.id === id)
  if (!provider || provider.builtin) return null
  return { ...provider }
}

export function updateModelPreset(id: string, name: string, mc: ModelConfig): boolean {
  const config = loadConfig()
  const preset = (config.modelPresets || []).find(p => p.id === id)
  if (!preset) return false
  preset.name = name
  preset.config = mc
  // 连接字段与当前服务商不一致 → 重新挂接（找/建匹配的服务商实体），
  // 而不是改写原服务商——避免"编辑一个模型的 baseUrl"误伤同服务商的兄弟模型。
  // 比对必须与 findOrCreateProvider 用同一把尺子（整组连接字段）：两处口径一旦分叉，
  // 差集里的编辑（此前是"只改接口格式"）就会留在旧实体上，被解析视图默默覆盖回去。
  const current = preset.providerId ? (config.modelProviders || []).find(p => p.id === preset.providerId) : undefined
  if (!current || !sameProviderConnection(current, mc)) {
    preset.providerId = findOrCreateProvider(config, mc)
  }
  // 如果正在使用这个预设，同步更新 modelConfig
  if (config.activePresetId === id) {
    config.modelConfig = resolvePresetConfig(preset, config)
  }
  saveConfig(config)
  return true
}

export function deleteModelPreset(id: string): void {
  const config = loadConfig()
  config.modelPresets = (config.modelPresets || []).filter(p => p.id !== id)
  if (config.activePresetId === id) delete config.activePresetId
  saveConfig(config)
}

export function switchToPreset(id: string): boolean {
  const config = loadConfig()
  const preset = (config.modelPresets || []).find(p => p.id === id)
  if (!preset) return false
  config.modelConfig = resolvePresetConfig(preset, config)
  config.activePresetId = id
  saveConfig(config)
  console.log(`[Config] 切换到预设: ${preset.name} (${preset.config.model})`)
  return true
}

// ---- 服务商实体 CRUD ----

/** 展示用凭证掩码：任何长度都不向 renderer/browser 暴露原字符。 */
export function maskApiKey(apiKey?: string): string {
  return apiKey ? '••••••' : ''
}

/** 服务商列表（apiKey 掩码——渲染层展示用；编辑提交走 updateModelProvider 的 patch 语义） */
export function listModelProviders(): Array<Omit<ModelProvider, 'apiKey'> & { apiKeyMasked: string; modelCount: number }> {
  const config = loadConfig()
  const presets = config.modelPresets || []
  return (config.modelProviders || []).map(p => ({
    id: p.id,
    name: p.builtin ? '内置服务' : p.name,
    provider: p.provider,
    baseUrl: p.builtin ? '' : p.baseUrl,
    apiFormat: p.apiFormat,
    thinkingFormat: p.thinkingFormat,
    thinkingBudgets: p.thinkingBudgets,
    builtin: p.builtin,
    // 短 key 下"前6+后4"会整段泄露——不足 12 位一律全遮
    apiKeyMasked: p.builtin ? '' : maskApiKey(p.apiKey),
    modelCount: presets.filter(x => x.providerId === p.id).length
  }))
}

/**
 * 更新服务商实体（换 key/换网关一处生效，旗下所有预设经解析视图自动跟随）。
 * patch.apiKey 为空串/缺省 = 保留原 key（掩码展示下用户未重输属常态）。
 * builtin 服务商拒绝编辑（红线：内置连接信息不可见亦不可改）。
 */
export function updateModelProvider(
  id: string,
  patch: {
    name?: string
    baseUrl?: string
    apiKey?: string
    apiFormat?: 'openai' | 'anthropic' | 'openai-responses' | ''
    thinkingFormat?: 'openai' | 'qwen' | 'deepseek' | 'zai' | 'auto'
    thinkingBudgets?: ThinkingBudgets | null | 'auto'
  }
): boolean {
  const config = loadConfig()
  const provider = (config.modelProviders || []).find(p => p.id === id)
  if (!provider || provider.builtin) return false
  if (patch.name?.trim()) provider.name = patch.name.trim()
  if (patch.baseUrl?.trim()) provider.baseUrl = patch.baseUrl.trim()
  if (patch.apiKey?.trim()) provider.apiKey = patch.apiKey.trim()
  if (patch.apiFormat !== undefined) {
    if (patch.apiFormat) provider.apiFormat = patch.apiFormat
    else delete provider.apiFormat
  }
  if (patch.thinkingFormat !== undefined) {
    if (patch.thinkingFormat === 'auto') delete provider.thinkingFormat
    else provider.thinkingFormat = patch.thinkingFormat
  }
  if (patch.thinkingBudgets !== undefined) {
    if (patch.thinkingBudgets === 'auto') {
      delete provider.thinkingBudgets
    } else if (patch.thinkingBudgets === null || validThinkingBudgets(patch.thinkingBudgets)) {
      provider.thinkingBudgets = patch.thinkingBudgets
    } else {
      return false
    }
  }
  // 激活预设若挂在该服务商下，同步刷新 modelConfig 快照
  const active = (config.modelPresets || []).find(p => p.id === config.activePresetId)
  if (active?.providerId === id) {
    config.modelConfig = resolvePresetConfig(active, config)
  }
  saveConfig(config)
  console.log(`[Config] 服务商已更新: ${provider.name}`)
  return true
}

/**
 * 获取所有可用模型。
 * 如果有未存为预设的 modelConfig，自动补录为真实预设。
 */
export function getAvailableModels(): Array<{ id: string; name: string; model: string; active: boolean; supportsThinking: boolean; supportsEffortDial: boolean; providerId?: string; providerName: string; builtin: boolean }> {
  const config = loadConfig()
  if (!config.modelPresets) config.modelPresets = []

  // 自动补录 .env 内置模型
  const envModel = process.env.OPENAI_MODEL || ''
  const envBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  const envKey = process.env.OPENAI_API_KEY || ''
  if (envModel && envKey) {
    const envExists = config.modelPresets.some(p => p.config.model === envModel && p.name.includes('内置'))
    if (!envExists) {
      const id = `preset_env_${Date.now()}`
      const envConfig: ModelConfig = { provider: 'custom', baseUrl: envBaseUrl, apiKey: envKey, model: envModel }
      config.modelPresets.unshift({
        id, name: `${envModel} (内置)`,
        providerId: findOrCreateProvider(config, envConfig, { builtin: true }),
        config: envConfig
      })
      saveConfig(config)
    }
  }

  // 自动补录：modelConfig 存在但不在预设中 → 创建真实预设
  if (config.modelConfig?.apiKey) {
    const exists = config.modelPresets.some(p =>
      p.config.model === config.modelConfig!.model && p.config.baseUrl === config.modelConfig!.baseUrl
    )
    if (!exists) {
      const id = `preset_${Date.now()}`
      const name = config.modelConfig.provider === 'custom'
        ? config.modelConfig.model
        : `${config.modelConfig.model} (${config.modelConfig.provider})`
      config.modelPresets.push({ id, name, providerId: findOrCreateProvider(config, config.modelConfig), config: config.modelConfig })
      config.activePresetId = id
      saveConfig(config)
    } else if (!config.activePresetId) {
      const match = config.modelPresets.find(p =>
        p.config.model === config.modelConfig!.model && p.config.baseUrl === config.modelConfig!.baseUrl
      )
      if (match) {
        config.activePresetId = match.id
        saveConfig(config)
      }
    }
  }

  const providers = config.modelProviders || []
  return config.modelPresets.map(p => {
    const provider = p.providerId ? providers.find(x => x.id === p.providerId) : undefined
    const builtin = !!provider?.builtin
    const resolved = resolvePresetConfig(p, config)
    return {
      id: p.id,
      // 红线：内置模型的名称/连接信息不暴露——列表统一显示"内置模型"
      name: builtin ? '内置模型' : p.name,
      model: builtin ? '内置模型' : p.config.model,
      active: p.id === config.activePresetId,
      // 会话专属模型场景 renderer 需按所选预设算 thinking 图标的显隐，不能只看全局能力位
      supportsThinking: !!resolved.supportsThinking,
      // 同理：档位菜单显隐也按所选预设的方言推导
      supportsEffortDial: supportsEffortDial(resolved),
      providerId: p.providerId,
      // 空串留给 renderer 走 t('chat.modelControl.ungrouped') 本地化兜底（ModelControl 已按 group || fallback 处理）
      providerName: builtin ? '内置服务' : (provider?.name || ''),
      builtin
    }
  })
}

// ---- 自动记忆配置 ----

/**
 * 记忆总开关。默认**关闭**（opt-in）：召回目前是把整份索引无差别塞进每轮提示词，
 * 相关性挑选函数 findRelevantMemories 写好却从未接入，抽取质量也有已登记的污染实案。
 * 在这些打磨完成前不默认开启；已有记忆文件一律保留，用户在设置里可随时开回来。
 */
export function isAutoMemoryEnabled(): boolean {
  const config = loadConfig()
  return config.autoMemoryEnabled === true
}

export function setAutoMemoryEnabled(enabled: boolean): void {
  const config = loadConfig()
  config.autoMemoryEnabled = enabled
  saveConfig(config)
  console.log(`[Config] 自动记忆: ${enabled ? '已开启' : '已关闭'}`)
}

// ---- 工作目录管理 ----
let workingDir: string | null = null

export function getWorkingDir(): string {
  if (workingDir) return workingDir
  // 从 ~/.openpipal/config.json 读取
  try {
    if (existsSync(CONFIG_PATH)) {
      const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
      const configuredWorkingDir = typeof config.workingDir === 'string' ? config.workingDir : ''
      if (configuredWorkingDir) {
        workingDir = configuredWorkingDir
        return configuredWorkingDir
      }
    }
  } catch {
    // 配置缺失或损坏时保持默认工作目录。
  }
  return join(homedir(), 'Documents')
}

export function setWorkingDir(dir: string): void {
  workingDir = dir
  // 持久化
  try {
    let config: any = {}
    if (existsSync(CONFIG_PATH)) {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    }
    config.workingDir = dir
    ensureDir()
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[Config] 保存工作目录失败:', err)
  }
}
