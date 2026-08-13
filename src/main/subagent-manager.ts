/**
 * Subagent Manager — 加载和管理 ~/.openpipal/subagents/*.md 子 agent 档位定义
 *
 * 设计原则（CLAUDE.md "文件式 > 字段式" + "默认 opt-in"）：
 * - 用户目录无 .md = subagent 工具发现可用列表为空 → 主 agent 不会调用
 * - 首启 seed 内置默认到用户目录；之后用户的改动具有持久权威（删除不被复活）
 * - frontmatter 决定 profile 的"能力边界"（tools/model）；body 是默认 system prompt
 * - 主 agent 调用时可 inline 传 persona 追加在 body 之后
 *
 * 与 skill-manager.ts 的关系：完全平行的两个独立体系。skill 是"指令包"，
 * subagent 是"被代理的小 agent"。共享同样的 opt-in 文件约定。
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { parseSimpleFrontmatter } from './simple-frontmatter'
import { dataPath } from './data-root'

export async function preloadSubagentEngine(): Promise<void> {
  // Kept for startup-call compatibility; the product-owned parser is eager and tiny.
}

/**
 * subagent profile = 一个能力档位。
 * frontmatter 字段：name / description / tools / model
 * body = 默认 system prompt（主 agent 可通过 persona 参数追加）
 */
export interface SubagentProfile {
  /** profile 名字（用于 subagent({ profile: "..." }) 调用） */
  name: string
  /** 描述给主 agent 看，决定它什么时候用这个 profile */
  description: string
  /**
   * 工具白名单（OpenPipal 工具名，逗号分隔写在 frontmatter）。
   * undefined / 空 = 继承主 agent 全工具集
   */
  tools?: string[]
  /**
   * 模型名（OpenPipal 已注册 model 字符串，如 'gpt-4o-mini' / 'deepseek-chat' / 自定义）。
   * undefined = 继承主 agent 当前模型
   */
  model?: string
  /**
   * Agent loop 最大轮数（防 runaway 安全网）。
   * undefined = 不限；正整数 = 达到该轮数后 runner 主动 abort
   * (stopReason='aborted')。借鉴 cc subagent 的 maxTurns 字段。
   */
  maxTurns?: number
  /** 默认 system prompt（body 部分） */
  systemPrompt: string
  /** 该 profile 加载自的 md 路径（debug 用） */
  filePath: string
  /** 是否来自内置 resources（true）还是用户自定义（false） */
  builtIn: boolean
}

// 全局缓存——每次 reload 重扫
let profiles: SubagentProfile[] = []

// ---- 路径 helpers ----

function getBuiltInSubagentsDir(): string {
  // 生产: process.resourcesPath/subagents
  // 开发: app 根/resources/subagents
  if (app.isPackaged) {
    return join(process.resourcesPath, 'subagents')
  }
  return join(app.getAppPath(), 'resources', 'subagents')
}

function getUserSubagentsDir(): string {
  return dataPath('subagents')
}

function getSeedSentinelPath(): string {
  return join(getUserSubagentsDir(), '.seeded')
}

// ---- seed 逻辑 ----

/**
 * 增量 seed：内置 profile 按**文件名台账**逐个补种到用户目录。
 * `.seeded` 从"跑过一次"的时间戳升级为"已种过哪些文件"的清单（每行一个文件名）——
 * 用户删除已种过的 md 不会被"复活"（文件名在台账里），但**新版本新增的内置 profile
 * 能到达老安装**（旧逻辑一次性 sentinel 让 advisor.md 这类新档位对所有升级用户永远不可见）。
 * 旧格式 sentinel（时间戳）平滑迁移：把当时已存在的用户文件记入台账。
 */
function seedDefaultsIfNeeded(): void {
  const userDir = getUserSubagentsDir()
  const sentinel = getSeedSentinelPath()

  const builtInDir = getBuiltInSubagentsDir()
  if (!existsSync(builtInDir)) {
    console.warn(`[Subagents] 内置目录不存在，跳过 seed: ${builtInDir}`)
    return
  }

  mkdirSync(userDir, { recursive: true })

  // 读台账（旧时间戳格式 → 空台账，靠下面 existsSync 补记）
  const ledger = new Set<string>()
  if (existsSync(sentinel)) {
    for (const line of readFileSync(sentinel, 'utf-8').split('\n')) {
      const name = line.trim()
      if (name.endsWith('.md')) ledger.add(name)
    }
  }

  let copied = 0
  let changed = !existsSync(sentinel)
  for (const entry of readdirSync(builtInDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    if (ledger.has(entry.name)) continue
    const dst = join(userDir, entry.name)
    if (!existsSync(dst)) {
      copyFileSync(join(builtInDir, entry.name), dst)
      copied++
    }
    // 已存在（用户自建/旧版已种）同样记账——之后用户删除不复活
    ledger.add(entry.name)
    changed = true
  }

  if (changed) {
    writeFileSync(sentinel, Array.from(ledger).sort().join('\n') + '\n', 'utf-8')
  }
  if (copied > 0) console.log(`[Subagents] 已增量 seed ${copied} 个内置 profile 到 ${userDir}`)
}

// ---- 加载 ----

function loadFromDir(dir: string, builtIn: boolean): SubagentProfile[] {
  if (!existsSync(dir)) return []

  const result: SubagentProfile[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    if (entry.name.startsWith('.')) continue

    const filePath = join(dir, entry.name)
    let content: string
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch (e) {
      console.warn(`[Subagents] 读取失败 ${filePath}: ${(e as Error).message}`)
      continue
    }

    let parsed
    try {
      parsed = parseSimpleFrontmatter(content)
    } catch (error) {
      console.warn(`[Subagents] frontmatter 无效 ${filePath}: ${(error as Error).message}`)
      continue
    }
    const { frontmatter, body } = parsed

    if (!frontmatter.name || !frontmatter.description) {
      console.warn(`[Subagents] 缺少 name 或 description: ${filePath}`)
      continue
    }

    const tools = frontmatter.tools
      ?.split(',')
      .map(t => t.trim())
      .filter(Boolean)

    // maxTurns: frontmatter 字段是字符串，parseInt 后必须 > 0 才接受
    let maxTurns: number | undefined
    if (frontmatter.maxTurns) {
      const n = parseInt(frontmatter.maxTurns, 10)
      if (Number.isFinite(n) && n > 0) maxTurns = n
      else console.warn(`[Subagents] 无效 maxTurns 值 "${frontmatter.maxTurns}" in ${filePath}，已忽略`)
    }

    result.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model || undefined,
      maxTurns,
      systemPrompt: body.trim(),
      filePath,
      builtIn,
    })
  }
  return result
}

// ---- 公开 API ----

/** 初始化：seed 默认 → 扫描用户目录 */
export function initSubagents(): void {
  try {
    seedDefaultsIfNeeded()
  } catch (e) {
    console.warn(`[Subagents] seed 失败（不阻塞）: ${(e as Error).message}`)
  }
  reloadSubagents()
}

/** 重新扫描（用户在 IDE 改了 md 后可调用） */
export function reloadSubagents(): void {
  const userDir = getUserSubagentsDir()
  // builtIn=false 因为 seed 后这些文件已属于用户目录；用户可自由编辑
  profiles = loadFromDir(userDir, false)

  if (profiles.length > 0) {
    console.log(`[Subagents] 已加载 ${profiles.length} 个 profile: ${profiles.map(p => p.name).join(', ')}`)
  } else {
    console.log(`[Subagents] 未加载到任何 profile（${userDir} 为空或不存在）`)
  }
}

/** 列出所有可用 profile */
export function listSubagentProfiles(): SubagentProfile[] {
  return profiles.slice()
}

/** 按名字取单个 profile */
export function getSubagentProfile(name: string): SubagentProfile | undefined {
  return profiles.find(p => p.name === name)
}

/** 给主 agent 看的简短列表（用于工具描述） */
export function describeAvailableProfiles(): string {
  if (profiles.length === 0) return '(none)'
  return profiles.map(p => `${p.name}: ${p.description}`).join('; ')
}
