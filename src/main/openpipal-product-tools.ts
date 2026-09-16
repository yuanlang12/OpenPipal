/**
 * OpenPipal product tools.
 *
 * This module intentionally contains no legacy CLI coding-tool imports. Runtime
 * adapters compose these product tools with their own public execution tools.
 */

import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { resolveExecutionAgent, resolveExecutionRoleName } from './agent-overrides'
import type { AgentPolicies } from './agent-registry'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getEffectiveModelConfig, getWorkingDir } from './config-manager'
import { createTemporaryCodeFile } from './code-execution-temp'
import { formatCodeExecutionOutput } from './code-execution-output'
// memory-store: AI 用通用 read/write/grep 操作 memory 文件，不再需要专用工具导入

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1048576) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1048576).toFixed(1)}MB`
}
import { captureTargetWindow } from './screenshot'
import { getCurrentConfig, getEnvironmentSnapshot, isDockedToTargetApp } from './window-tracker'
import { webSearch, formatSearchResults } from './web-search'
import { createBrowserControlTools, isBrowserControlAvailable } from './browser-tools'
// Stage 2: skill-manager 的 load/write helpers 不再被 pi-tools 使用
// AI 通过通用 read/write 工具完成 skill 加载和创建
import { getActiveContext, formatContext } from './accessibility'
import { getDsReview } from './role-manager'
import { READONLY_TIER_TOOLS, type PermissionTier } from './pi-security'
import {
  listConversationArtifacts,
  compileJsxArtifact, findSimilarArtifact, coarseTypeFromFile, normalizeArtifactLanguage,
  artifactFilePath
} from './artifact-store'
import { getArtifactStore, evaluateArtifactWriteGuard, buildExternalEditEvidence } from './artifact-registry'
import { fileToolHint } from './file-tool-hint'
import { compileDesignSystem } from './ds-compile'
import { inlineDcForHeadless } from './dc-headless'
import { OVERLAP_LINT_JS } from './overlap-lint'
import { PAGE_TEXT_SUMMARY_JS } from './dc-text-summary'
import { saveOutput } from './memory-manager'
import { getBrowserContext } from './browser-context-store'
import {
  listTasks, getTask, createTask, updateTask, deleteTask
} from './task-store'
import { getTaskSchedulerControl } from './task-scheduler-control'
import type { ChildAgentUpdate } from './subagent-runner'
import { describeAvailableProfiles, listSubagentProfiles } from './subagent-manager'
import {
  addTeamMember, createTeamMember, readTeam, removeTeamMember, renameTeam, resolveTeamScope, setTeamLead, updateTeamMd
} from './team-store'
import { ACCESSORY_HINTS, PAL_ACCESSORIES } from '../shared/agent-mark-catalog'
import { listWorkspaces } from './agent-workspace-store'
import { formatPeerList, listPeerConversations, readPeerConversation, sendPeerMessage } from './conversation-peer'
import { capInsert, computeStickyInclude } from './prompt-cache-fifo'
import { normalizeQuestionsPanelTitle, normalizeQuestionsV2Items } from './pi-event-adapter'
import { dcRuntimeDir, exportArtifactPdf, exportStandaloneHtml, exportZip, exportDcBundle } from './dc-export'
import { exportArtifactMp4 } from './dc-video-export'
import { exportArtifactPptx } from './dc-pptx-export'
import { exportArtifactHandoff } from './dc-handoff-export'
import { mp4FormatGateMessage, pptxFormatGateMessage, handoffFormatGateMessage, projectZipFormatGateMessage, formatMp4ValidationText, formatPptxValidationText, formatHandoffValidationText, formatFileValidationText, type Mp4ProbeData } from './export-artifact-validate'
import { sliceArtifactContent, formatArtifactReadHeader, formatArtifactTruncationNote, formatArtifactOffsetOutOfRangeNote } from './read-artifact-slice'
import type { ChatSource } from './agent-runtime/contracts'
import { createSetRuleTool } from './hooks/set-rule-tool'
import { dataPath, outputsDirFor } from './data-root'
import { getBuiltInSkillsDir } from './openpipal-skill-sources'
import { resolveCodeExecutionLanguage } from './code-execution-language'
import { isRenderArtifactConsoleNoise } from './render-artifact-diagnostics'

// 'acp' = 外部 ACP 客户端（openpipal-acp 经 HTTP 转发）：无浏览器页面也无桌面 UI 在场，
// 不注入 extension/desktop 专属工具；服务端负责会话落盘（renderer 不在场）
export type { ChatSource } from './agent-runtime/contracts'

// ---- prompt 前缀缓存 P3：工具组 per-conversation 粘滞 ----
// 浏览器扩展（MV3 service worker）连接/断开是常态，subagent profile 目录也可能中途增删；
// tools 数组整段参与 OpenAI 兼容前缀缓存的字节比对，同会话两轮之间若某工具组整组消失，
// 会导致全量缓存失配。粘滞语义="本会话见过该工具组就一直保留"——断连期调用由工具自身的
// 明确报错兜底（见 browser-control.ts:221），不会静默失败。上限 100 会话，FIFO 淘汰最旧。
const TOOL_STICKY_CAP = 100
const toolStickiness = new Map<string, { browser?: boolean; subagent?: boolean }>()

// ---- 工具结果辅助函数 ----

function textResult(text: string, details?: any): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text }],
    details: details || {}
  }
}

/** 把“已交付文件”作为结果元数据保留下来，供会话级输出区精确归属；不靠扫描全局 outputs 猜来源。 */
function exportedFileResult(title: string, filePath: string, text: string): AgentToolResult<any> {
  return textResult(text, {
    displayResult: text,
    args: {
      title,
      filePath,
      fileName: path.basename(filePath),
      fileType: path.extname(filePath).slice(1).toLowerCase() || 'file'
    }
  })
}

// ---- ask_user 占位符（当前 ask_user 通过事件适配器直接发给前端，Agent 循环在此中断） ----

export class AskUserResolver {
  // 预留：未来实现 Agent 内等待用户输入时在此添加 Promise 逻辑
}

// ---- 工具定义 ----

function createCaptureScreenshotTool(): AgentTool {
  const config = getCurrentConfig()
  // 未挂靠时描述里不带应用名 —— 工具描述本身也是进提示词的,写死名字等于在没挂靠的
  // 会话里也告诉模型「用户在用 X」。
  const target = isDockedToTargetApp() ? config.displayName : '前台应用'
  return {
    name: 'capture_screenshot',
    label: '截图',
    description: `截取 ${target} 当前窗口的截图。当需要查看用户屏幕上的内容时调用。仅在 OpenPipal 挂靠到某个应用时可用。`,
    parameters: Type.Object({}),
    execute: async (_id, _params) => {
      // 截屏是最强的一次读取:未挂靠 = 用户没有同意 OpenPipal 观察任何应用,直接拒绝,
      // 不去碰 captureTargetWindow(它会按 currentConfig 找窗口,未挂靠时语义本就不成立)。
      if (!isDockedToTargetApp()) {
        return textResult('未挂靠到任何应用，无法截图。请先在设置里开启应用跟随，或让 OpenPipal 贴靠到目标应用旁。')
      }
      const screenshot = await captureTargetWindow()
      if (screenshot) {
        return {
          content: [{ type: 'text', text: '截图已完成，图片如下。请根据截图内容回答用户的问题。' }],
          details: { screenshot }
        }
      } else {
        const displayName = getCurrentConfig().displayName
        return textResult(`截图失败，${displayName} 窗口未找到或无屏幕录制权限。`)
      }
    }
  }
}

function createReadScreenTool(): AgentTool {
  return {
    name: 'read_screen',
    label: '读取屏幕',
    description: '读取目标应用的选中文本和窗口标题。速度极快，无需截图。当用户问"选中了什么""这段文字"等文本相关问题时，只用此工具即可，不需要再截图。仅当用户明确要看图像或布局时才用截图。',
    parameters: Type.Object({}),
    execute: async () => {
      const ctx = await getActiveContext()
      const formatted = ctx ? formatContext(ctx) : ''
      const result = formatted || '当前没有选中文本。请先在目标应用中选中要读取的内容。'
      return textResult(result, { displayResult: formatted || '无选中文本' })
    }
  }
}

function createReadPageContentTool(): AgentTool {
  return {
    name: 'read_page_content',
    label: '读取页面',
    description: '读取用户当前浏览器页面的详细内容。包括页面正文和视频字幕（如有）。当用户询问页面/视频相关问题时调用此工具获取内容，而非猜测或搜索。已支持 PDF 页面全文解析（含扫描版提示）；正文过长时分段返回，用 offset 续读。',
    parameters: Type.Object({
      offset: Type.Optional(Type.Number({ description: '页面正文起始字符偏移，默认 0' })),
      maxChars: Type.Optional(Type.Number({ description: '本次最多返回的正文字符数，默认且上限 15000' }))
    }),
    execute: async (_id, params) => {
      const p = params as { offset?: number; maxChars?: number }
      const offset = Math.max(0, p.offset || 0)
      // 上限钉死 15000（约 9375 tokens）：20000 字符会越过 context-window-policy.ts 的
      // MAX_TOOL_RESULT_TOKENS=12000，被 capToolResultText 从正文中段静默挖空，而续读提示
      // 仍宣称"完整交付"，模型会永久跳过那段缺口——请求值只能更小，不能更大。
      // 非正数（含模型用 0 表达"不限"）一律退回默认值，不夹成 1 个字符。
      const maxChars = p.maxChars && p.maxChars > 0 ? Math.min(p.maxChars, 15000) : 15000
      const ctx = getBrowserContext()
      let result = ''
      if (ctx) {
        if (ctx.title) result += `页面标题: ${ctx.title}\n`
        if (ctx.url) result += `URL: ${ctx.url}\n`
        if (ctx.contentNote) result += `[说明] ${ctx.contentNote}\n`
        if ((ctx as any).subtitles) result += `\n视频字幕:\n${(ctx as any).subtitles}\n`
        if (ctx.pageContent) {
          const total = ctx.pageContent.length
          if (offset >= total) {
            result += `\n[offset 超出范围：正文共 ${total} 字符]\n`
          } else {
            const end = Math.min(offset + maxChars, total)
            const slice = ctx.pageContent.substring(offset, end)
            // 续读提示的 end 用实际返回切片的长度算，不直接信任 offset+maxChars 的理论值
            const returnedEnd = offset + slice.length
            result += `\n页面正文:\n${slice}\n`
            if (returnedEnd < total) result += `[正文共 ${total} 字符，本次返回第 ${offset}–${returnedEnd} 字符；继续阅读请带 offset=${returnedEnd} 再次调用]\n`
          }
        }
        if (ctx.selectedText) result += `\n用户选中文本:\n${ctx.selectedText}\n`
      }
      if (!result) result = '当前没有浏览器页面上下文。'
      return textResult(result, { displayResult: result.substring(0, 200) + '...' })
    }
  }
}

function createWebSearchTool(): AgentTool {
  return {
    name: 'web_search',
    label: '搜索',
    description: '搜索互联网获取信息。当需要查找知识点解释、公式、历史事件、最新资料等信息时调用。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索关键词' })
    }),
    execute: async (_id, params) => {
      const query = (params as any).query || ''
      const outcome = await webSearch(query)
      const formatted = formatSearchResults(outcome)
      return {
        content: [{ type: 'text', text: formatted }],
        details: { searchResults: formatted }
      }
    }
  }
}

// Skill tools (load/create) removed — AI uses generic read/write via workspace layout prompt
// 这样做的好处：
// 1. Tokens: 节省 ~500 tokens/turn（删除 3 个工具的 schema + description）
// 2. Tier 3 渐进式: AI 读 SKILL.md 后按需 read 子资源（而非一次性吃完）
// 3. 统一心智: 一套 read/write 工具处理 skills / memory / artifacts / tools
//
// 历史实现参考 git log 或 memory/pi_skills_refactor.md

function createQuestionsV2Tool(): AgentTool {
  return {
    name: 'questions_v2',
    label: '整页问答',
    description: `整页结构化问答面板——比 ask_user 表达力更强，支持色板/图标/多选 chip/滑块等可视化选项。适合需要多维度收集偏好的任务（设计、写作、规划等初始 intake）。

调用后结束本轮，等用户在整页问答界面提交答案。答案会作为一条新 user message 回到对话。

字段类型（kind）：
- 'text-options'：文字选项按钮组（用 options 数组；multi=true 允许多选）
- 'svg-options'：可视化选项（每个 option 含 svg 字符串，适合色板、图标块、风格预览、字体配对）
- 'slider'：数值滑块（需 min/max/step/default）
- 'freeform'：自由文本输入
- 'multi-chip'：紧凑多选 chip（options 数组）

**强烈偏好 svg-options**——视觉问题一定要给视觉选项，不要用文字列表让用户"脑补颜色"。具体触发场景 + SVG 模板：

1) 色板选择（主色 / accent 组合）：
   svg: '<svg viewBox="0 0 80 56" xmlns="http://www.w3.org/2000/svg"><rect width="80" height="56" fill="#0F3D2E"/><rect x="48" y="8" width="24" height="24" fill="#D9A441"/><rect x="8" y="36" width="16" height="12" fill="#F5F1E8"/></svg>'
   —— 80×56 viewBox，主色铺底，accent 和中性色小块展示

2) 圆角/形状偏好：
   svg: '<svg viewBox="0 0 80 56" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="12" width="64" height="32" rx="16" fill="#2A2A2A"/></svg>'  (full)
   svg: '<svg viewBox="0 0 80 56" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="12" width="64" height="32" rx="4" fill="#2A2A2A"/></svg>'   (subtle)
   svg: '<svg viewBox="0 0 80 56" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="12" width="64" height="32" fill="#2A2A2A"/></svg>'          (sharp)

3) 字体配对预览：
   svg: '<svg viewBox="0 0 80 56" xmlns="http://www.w3.org/2000/svg"><text x="8" y="26" font-family="Space Grotesk" font-size="18" font-weight="600">Aa</text><text x="8" y="48" font-family="serif" font-size="12">Body text</text></svg>'

4) 布局/密度/阴影风格等——同理，用几何形状代表

设计指导：
- 问题 ≥ 4 个
- **每当问题涉及颜色、圆角、形状、字体、视觉密度、阴影、动效风格，必须用 svg-options，不是 text-options**
- 目标/受众/信息层级等纯概念问题才用 text-options / multi-chip / freeform
- 前端自动为 option 类问题附加“其他”。**不要在 options 里写“随便/你决定/交给 AI”这类兜底项**——面板顶部已经写死一条规则：用户没选的题就是交给你判断，提交时会填成“请 AI 根据已有信息判断”
- 必须由用户本人裁决的题（写入/保存/删除个人档案这类）设 allowAiDecision: false —— 它会被标成「必答」并拦住提交，不受上面那条豁免
- 某道题的最准答案是一份原件时（校本模板、上节课教案、学生作业、参考截图、品牌素材），给该题加 attach: true，可配 attachHint 一句引导语——上传位直接长在这道题下方，用户传的文件会标注归属这道题回来。不要为"请传文件"单独占一道题位`,
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: '可选的面板顶部标题，如 "关于音乐 App 首页设计的几个问题"；不传时 UI 使用本地化默认标题' })),
      questions: Type.Array(
        // 容错：弱模型偶尔把整个问题元素发成纯字符串（而非 {id,kind,title,...} 对象），
        // 一律走 Type.Object 会让 Pi 框架在 execute 前就拒绝整条 tool call（校验层面，
        // execute 里的兜底代码根本收不到参数）。这里 Union 放行字符串，字段也全 Optional
        // 化（弱模型常漏 id/kind），execute 里统一补默认值。
        Type.Union([
          Type.Object({
            id: Type.Optional(Type.String({ description: '字段 id（snake_case）— 答案 key' })),
            kind: Type.Optional(Type.String({ description: '字段类型：text-options / svg-options / slider / freeform / multi-chip' })),
            title: Type.Optional(Type.String({ description: '问题标题' })),
            subtitle: Type.Optional(Type.String({ description: '问题副标题/提示' })),
            allowAiDecision: Type.Optional(Type.Boolean({ description: '是否允许用户把这题交给 AI 代选。涉及个人风格写入、保存或删除等本人确认时必须设为 false' })),
            options: Type.Optional(Type.Array(Type.Any(), { description: '选项数组。text-options/multi-chip 用字符串；svg-options 用 {value, label, svg}' })),
            multi: Type.Optional(Type.Boolean({ description: 'text-options 多选' })),
            min: Type.Optional(Type.Number()),
            max: Type.Optional(Type.Number()),
            step: Type.Optional(Type.Number()),
            default: Type.Optional(Type.Any()),
            placeholder: Type.Optional(Type.String({ description: 'freeform 占位提示' })),
            attach: Type.Optional(Type.Boolean({ description: '这道题下方放文件上传位——当这道题的最准答案是一份原件（模板/作业/参考图）时设 true' })),
            attachHint: Type.Optional(Type.String({ description: '上传位引导语（配合 attach），如"直接传几张学生作业照片，比文字描述准"' }))
          }),
          Type.String({ description: '容错：直接给字符串时视为该问题的 title，其余字段用默认值（text-options + 是/否）' })
        ]),
        { description: '问题列表，建议 ≥ 4 个。元素通常是 {id,kind,title,...} 对象' }
      )
    }),
    execute: async (_id, params) => {
      const p = params as any
      // Empty means "use OpenPipal's stable localized default". Do not write a
      // catalogue string into the model-owned title field; the renderer keeps
      // this provenance as titleKey so a system-language change can re-render.
      const title = normalizeQuestionsPanelTitle(p.title)
      // 容错：有的模型把数组 JSON-stringify 再传；尝试 parse 一次
      let rawQuestions: any[] = []
      if (Array.isArray(p.questions)) {
        rawQuestions = p.questions
      } else if (typeof p.questions === 'string') {
        try {
          const parsed = JSON.parse(p.questions)
          if (Array.isArray(parsed)) rawQuestions = parsed
        } catch {
          // parse 失败就当空数组，下面统一走"无可用问题"报错
        }
      }
      // 规范化每个元素（字符串→默认 text-options；对象补 id/kind/title/options 默认值）——
      // 纯函数逻辑放在 pi-event-adapter.ts（零 electron 依赖，供单测直接验证）
      const questions = normalizeQuestionsV2Items(rawQuestions)

      if (questions.length === 0) {
        // 抛出而非软返回：让框架标记 isError=true，走统一 tool_end 错误路径
        // （chatStore 据此清理僵尸 questions tab），同时把清晰指引带回给模型重试。
        throw new Error('没有可用问题：questions 数组为空或所有元素都无法规范化。重新调用 questions_v2，并给出至少 1 个 {id, kind, title, options} 对象。')
      }

      return {
        content: [{ type: 'text', text: title }],
        details: { questionsV2: { title, questions }, args: { title, questions } }
      }
    }
  }
}

function createAskUserTool(resolver: AskUserResolver): AgentTool {
  return {
    name: 'ask_user',
    label: '询问用户',
    description: `向用户提问并收集信息。支持两种模式：

1. 按钮选择：提供 options 数组，用户点击按钮选择。适合简单的是/否/多选题。
2. 表单输入：提供 fields 数组，用户在输入框中填写。适合需要收集多项文本信息的场景（如课程名称、目标、时间安排等）。

优先使用 fields 模式收集结构化信息，这比在消息中列出问题清单更友好。用户可以一次性填写所有字段并提交。`,
    parameters: Type.Object({
      question: Type.String({ description: '主标题或引导语' }),
      options: Type.Optional(Type.Array(
        Type.Object({
          label: Type.String({ description: '按钮显示文字' }),
          value: Type.String({ description: '选项值' })
        }),
        { description: '按钮选项列表（与 fields 二选一）' }
      )),
      fields: Type.Optional(Type.Array(
        Type.Object({
          label: Type.String({ description: '字段标签，如"课程主题"' }),
          placeholder: Type.Optional(Type.String({ description: '占位提示文字' })),
          type: Type.Optional(Type.String({ description: '输入类型：text(单行默认)、textarea(多行)、select(下拉)' })),
          options: Type.Optional(Type.Array(Type.String(), { description: 'select 类型的选项列表' })),
          required: Type.Optional(Type.Boolean({ description: '是否必填' }))
        }),
        { description: '表单字段列表（与 options 二选一）' }
      ))
    }),
    execute: async (_id, params) => {
      const p = params as any
      const question = p.question || ''
      const options = p.options || []
      const fields = p.fields || []
      return {
        content: [{ type: 'text', text: question }],
        details: { askUser: { question, options, fields }, args: params }
      }
    }
  }
}

// Memory tools (save/recall) removed — AI uses generic write/grep/read via workspace layout prompt

/**
 * 容错解析 artifact id → 磁盘 sidecar 文件。委托给 artifact-registry（单一权威）：注册表内
 * 保留了容错纠正（唯一子串 ≥4 位 / 本会话单 artifact 直接对上）与"绝不引导新建"的错误清单，
 * 有 conversationId 时按本会话隔离解析（P2 会在注册表里加"按标题解析"）。
 * 返回形状 {file,id,corrected}|{error} 不变，create/edit/render 调用点零改。
 */
function resolveArtifactId(given: string, conversationId?: string): { file: string; id: string; corrected: boolean } | { error: string } {
  const r = getArtifactStore().resolve(given, conversationId)
  if ('error' in r) return { error: r.error }
  // ephemeral 过程物（todos/questions/goal/mcp-app）不落盘、没有真实 path——干净报错，
  // 别让下游 fs.readFileSync('') 直接 ENOENT 崩掉整个工具调用
  if (!r.record.path) {
    return { error: `"${r.record.title || r.record.id}" 是过程态内容（任务清单/问答等），不支持 edit_artifact / render_artifact / create_artifact 这类常规产物操作。` }
  }
  return { file: r.record.path, id: r.record.id, corrected: r.corrected }
}

/** dc 逻辑块语法校验：vm 编译（不执行）。实测编辑锚点落错边界会造出 SyntaxError 的废稿——工具层当场拦截。 */
function dcLogicSyntaxError(content: string): string | null {
  const m = /<script[^>]*\bdata-dc-script\b[^>]*>([\s\S]*?)<\/script>/i.exec(content)
  if (!m || !m[1].trim()) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    new (require('vm').Script)(m[1])
    return null
  } catch (err: any) {
    return err?.message || 'SyntaxError'
  }
}

/**
 * read_artifact —— 补齐产物工具族缺失的"读"能力。跨轮 tool 消息会被历史压缩/上下文裁剪清理，
 * 模型对已有 artifact"现在长什么样"未必仍有可见记忆；edit_artifact 要求 old_string 逐字命中，
 * 凭记忆猜片段大概率不中。闭环：清单（<session-artifacts> 有什么）→ read（现在长什么样）→
 * edit（外科手术）→ render（验证）。
 */
function createReadArtifactTool(conversationId?: string): AgentTool {
  return {
    name: 'read_artifact',
    label: '读稿',
    description: `读取已有 artifact 的当前原文内容（不加行号前缀，切出来的片段可直接摘取用作 edit_artifact 的 old_string）。

**修改产物前若不确定其当前内容，先用本工具读取，再用 edit_artifact 精确替换**——跨轮工具消息可能已被历史压缩清理，凭记忆猜片段去 edit 大概率不命中。

默认从头返回全文；内容较长时会在约 800 行或约 30KB 处截断，用 offset/limit 分批继续读取剩余部分。`,
    parameters: Type.Object({
      id: Type.String({ description: '要读取的 artifact 的 id 或标题（与 edit_artifact 同一解析规则：历史 tool 结果里的 (id: artifact-XXXX)，或直接写它的标题——系统会按本会话标题解析）' }),
      offset: Type.Optional(Type.Number({ description: '起始行号（1-based），省略则从第 1 行开始' })),
      limit: Type.Optional(Type.Number({ description: '返回的最大行数，省略则读到文件末尾（仍受单次 30KB 上限保护）' }))
    }),
    execute: async (_id, params) => {
      const p = params as any
      // 直接走 store.resolve() 拿完整 record（含 title/type）——resolveArtifactId() 那层薄封装
      // 会把 title/type 丢在半路，逼下游再查一次仅内存态的 getRecord()（重启/新进程后必空，
      // 头部会退化成"标题=id"）。read_artifact 的价值就在"准确反映当前状态"，这里不能将就。
      const resolved = getArtifactStore().resolve(p.id, conversationId)
      if ('error' in resolved) {
        return { content: [{ type: 'text', text: resolved.error }], details: {} }
      }
      const { record, corrected } = resolved
      // ephemeral 过程物（todos/questions/goal/mcp-app）不落盘、没有真实 path——同 resolveArtifactId()
      // 的既有护栏，别让下面 fs.readFileSync 拿空路径去读 ENOENT/读错东西。
      if (!record.path) {
        return { content: [{ type: 'text', text: `"${record.title || record.id}" 是过程态内容（任务清单/问答等），不支持 read_artifact 这类常规产物操作。` }], details: {} }
      }
      const { path: file, id: artifactId, title, type } = record
      const content = fs.readFileSync(file, 'utf8')
      // diff 证据链（对账门闩的下半程）：mtime 只能证明"被改过"，这里把"改了什么"算出来附在读取
      // 结果里——模型上下文里未必有它自己上一版的原文，没有这份 diff 它无从识别哪些字是用户的修改。
      // 只附在第一页（offset 缺省/为 1），分页续读不重复；快照缺失（重启后/legacy）自然退化为纯读取。
      const priorAgentContent = getArtifactStore().getRecord(artifactId)?.lastAgentContent
      const editEvidence = (p.offset ?? 1) <= 1 && priorAgentContent !== undefined
        ? buildExternalEditEvidence(priorAgentContent, content)
        : null
      // 写入对账门闩：读过即视为"看过用户的外部修改"，刷新基线解锁下次 create_artifact 覆盖式重发。
      try { getArtifactStore().touch(record, fs.statSync(file).mtimeMs) } catch { /* 竞态删除不阻塞读结果 */ }
      const sizeBytes = Buffer.byteLength(content, 'utf8')
      const slice = sliceArtifactContent(content, p.offset, p.limit)
      const note = corrected ? `（你给的 id "${p.id}" 不存在，已自动对到本会话唯一匹配 ${artifactId}）\n` : ''
      const evidenceBlock = editEvidence ? `\n\n${editEvidence}` : ''
      const header = `${note}${formatArtifactReadHeader(title || artifactId, type, slice.totalLines, sizeBytes)} (id: ${artifactId})${evidenceBlock}`
      if (slice.content === '' && slice.startLine > slice.totalLines) {
        return { content: [{ type: 'text', text: `${header}\n\n${formatArtifactOffsetOutOfRangeNote(slice.startLine, slice.totalLines)}` }], details: {} }
      }
      const truncNote = slice.truncated ? formatArtifactTruncationNote(slice.endLine, slice.totalLines) : ''
      return {
        content: [{ type: 'text', text: `${header}\n\n${slice.content}${truncNote}` }],
        details: {}
      }
    }
  }
}

function createEditArtifactTool(conversationId?: string): AgentTool {
  return {
    name: 'edit_artifact',
    label: '改稿',
    description: `对已有 artifact 做精确字符串替换（外科手术式小修改，不重发全文）。

**小改动一律用这个**：改文案 / 换颜色 / 调一段样式 / 修一处 bug / 在锚点后插入一个新区块。old_string 必须在当前内容中**唯一**出现（带上前后几行上下文保证唯一）；new_string 为替换后的完整片段。替换后的完整内容由系统回填预览，你不需要重发文件——**永远不会超输出预算**。
只有结构性重写（整体换布局/换方向）才用 create_artifact 同 id 全量重发。`,
    parameters: Type.Object({
      id: Type.String({ description: '要修改的 artifact 的 id 或标题（历史 tool 结果里的 (id: artifact-XXXX)，或直接写它的标题——系统会按本会话标题解析）' }),
      old_string: Type.String({ description: '要替换的原文片段——必须与当前内容逐字一致且唯一' }),
      new_string: Type.String({ description: '替换后的新片段' })
    }),
    execute: async (_id, params) => {
      const p = params as any
      const resolved = resolveArtifactId(p.id, conversationId)
      if ('error' in resolved) {
        return { content: [{ type: 'text', text: resolved.error }], details: {} }
      }
      const { file, id: artifactId, corrected } = resolved
      const content = fs.readFileSync(file, 'utf8')
      const first = content.indexOf(p.old_string)
      if (first === -1) {
        return { content: [{ type: 'text', text: `old_string 在当前内容中不存在（注意逐字一致，包括空白）。可先用 read_artifact 读取当前内容，复制精确片段后重试。` }], details: {} }
      }
      if (content.indexOf(p.old_string, first + p.old_string.length) !== -1) {
        return { content: [{ type: 'text', text: `old_string 出现了不止一次，不唯一——带上更多前后文再试。` }], details: {} }
      }
      const next = content.replace(p.old_string, p.new_string)
      const synErr = dcLogicSyntaxError(next)
      if (synErr) {
        return { content: [{ type: 'text', text: `已拒绝：这次替换会让逻辑类产生语法错误（${synErr.slice(0, 120)}）——常见原因是插入位置落在了声明中间。检查锚点边界后重试。` }], details: {} }
      }
      fs.writeFileSync(file, next, 'utf8')
      // jsx 场景：改稿后立刻重新预编译同目录 <id>.compiled.js（不等 IPC 存盘），失败回传让模型自修
      let compileNote = ''
      if (file.endsWith('.jsx')) {
        const out = file.replace(/\.jsx$/, '.compiled.js')
        const res = compileJsxArtifact(next)
        if (res.error) {
          try { if (fs.existsSync(out)) fs.rmSync(out) } catch {
            // The diagnostic below is still useful if stale output cleanup races.
          }
          compileNote = `\n⚠️ 重新预编译失败：${res.error} —— 这次替换让 jsx 无法编译，修正后重试。`
        } else {
          try { fs.writeFileSync(out, res.js || '', 'utf8') } catch {
            // Preserve the successful source edit; the preview reports compilation state.
          }
        }
      }
      const meta = getArtifactStore().getRecord(artifactId) || { type: file.endsWith('.html') ? 'html' : 'markdown', title: artifactId }
      const note = corrected ? `（你给的 id "${p.id}" 不存在，已自动对到本会话唯一匹配 ${artifactId}）` : ''
      // jsx 场景带回 language，避免异步 saveArtifact 按缺失 language 落成 <id>.txt（污染 sidecar 解析）
      const language = file.endsWith('.jsx') ? 'jsx' : undefined
      // 写入对账门闩：edit 是"改过"事件，刷新基线——同上，避免自己这次写入被下次操作误判为外部修改。
      // 第三参把写出的全文同步进 diff 证据基线：edit 后的文件（含用户此前的直改）就是 Agent 认可的最新版。
      try { getArtifactStore().touch({ id: artifactId, type: meta.type, title: meta.title, language: language ?? (meta as any).language, path: file }, fs.statSync(file).mtimeMs, next) } catch { /* 竞态删除不阻塞编辑结果 */ }
      return {
        content: [{ type: 'text', text: `已替换并更新预览: ${meta.title} (id: ${artifactId})，当前 ${next.length} 字符${note}${compileNote}` }],
        details: { artifact: { id: artifactId, type: meta.type, title: meta.title, content: next, ...(language ? { language } : {}) } }
      }
    }
  }
}

export function createRenderArtifactTool(conversationId?: string, workingDir?: string): AgentTool {
  return {
    name: 'render_artifact',
    label: '自检',
    description: `把已有 artifact（或一个本地 HTML 文件）在隐藏窗口里真实渲染一遍，回传 console 错误/警告（含 dc 运行时的"逻辑类语法错误"与"空穴 never resolved"）。

两种用法（二选一）：
- id：自检会话里的 artifact
- path：自检磁盘上的 HTML 文件（设计系统的 specimen 预览卡 / ui_kit index.html 用这个——file:// 加载，相对引用的 styles.css / assets 全部生效）

**交付前必自检**：create_artifact / 一轮 edit_artifact / 写完预览卡后调用一次，有报错就修完再交——用户看到坏稿等于白交。返回"渲染干净"只说明没报错；结果会附上截图，**画面类产物要看图核对**（版式、图形、文案位置），画对没画对只在图里，不在 console 里。长页一次截 6 屏（5400 高），结果里写明截到哪、后面还剩多少；要看后面的就再调一次并传 scroll_y，像翻页验收一样一段段看完。`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '要自检的 artifact id 或标题（与 path 二选一；标题按本会话解析）' })),
      path: Type.Optional(Type.String({ description: '要自检的本地 HTML 文件绝对路径（OpenPipal 数据目录下的 workspace / outputs / design-systems / conversations/artifacts，或本会话工作目录内）' })),
      scroll_y: Type.Optional(Type.Number({ description: '从页面的这个高度（CSS 像素）起截，默认 0。上一次结果写着"N 以下没截到"就传 N 接着看' }))
    }),
    execute: async (_id, params) => {
      const p = params as any
      let file: string
      let fileMode = false
      let resolvedId = p.id as string | undefined
      if (p.id) {
        const resolved = resolveArtifactId(p.id, conversationId)
        if ('error' in resolved) {
          return { content: [{ type: 'text', text: resolved.error }], details: {} }
        }
        file = resolved.file
        resolvedId = resolved.id
      } else if (p.path) {
        const resolved = path.resolve(String(p.path))
        // 边界与 read/write/bash 同一口径：数据目录里的几个根 + 本会话的工作目录。之前私藏一份只认数据目录的白名单，
        // 模型把文件写进工作目录却不许自检，只能复制进数据目录再看——那边没有 vendor/预制件，再报一堆假问题
        const sessionWorkingDir = path.resolve(workingDir || getWorkingDir())
        const allowedRoots = [
          dataPath('workspace'),
          dataPath('outputs'),
          dataPath('design-systems'),
          dataPath('conversations', 'artifacts'),
          sessionWorkingDir
        ]
        if (!allowedRoots.some((r) => resolved.startsWith(r + path.sep) || resolved === r)) {
          return { content: [{ type: 'text', text: `path 必须在 OpenPipal 数据目录（workspace / outputs / design-systems / conversations/artifacts）或本会话工作目录 ${sessionWorkingDir} 内。` }], details: {} }
        }
        if (!fs.existsSync(resolved)) {
          return { content: [{ type: 'text', text: `文件不存在: ${resolved}` }], details: {} }
        }
        file = resolved
        fileMode = true
      } else {
        return { content: [{ type: 'text', text: `id 和 path 必须传一个。` }], details: {} }
      }
      const raw = fs.readFileSync(file, 'utf8')
      const isDc = /<x-dc[\s>]/i.test(raw)
      // 文件模式走 file:// 原样加载（保住相对引用）；artifact 模式内联 dc runtime 走 data:URL
      // baseDir = sidecar 父目录，供 x-import 链解析同会话的 ./artifact-<id>.jsx → <id>.compiled.js
      const html = fileMode ? raw : inlineDcForHeadless(raw, file ? path.dirname(file) : undefined)
      const { BrowserWindow, nativeImage } = require('electron')
      const win = new BrowserWindow({
        // 900 而不是 800：动画产物的播放条展开成剪辑轨后占 85px，800 高会把 720p 舞台
        // 压到 scale 0.99——自检帧没有尺寸断言，但给模型看的画面不该无谓地缩一档。
        // 2026-09-11 真机实测：没有这两项，macOS 把隐藏窗钳在屏幕工作区内（1512×982 的屏只截到 1280×839），
        // 首屏就不是 900、100vh 也跟着缩水；enableLargerThanScreen 解开这个钳位
        show: false, width: 1280, height: 900, useContentSize: true, enableLargerThanScreen: true,
        // backgroundThrottling:false 与逐帧导出窗口同因：隐藏窗口默认节流 rAF/timer，
        // 动画多帧自检要等双 rAF 落地（见下方 settleAt），被节流就只能干等超时。
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
      })
      const problems: string[] = []
      // 多帧自检要 reload 页面（每帧重放启动告警），reload 阶段不再计入 problems——只收首轮加载的真问题
      let collectConsole = true
      win.webContents.on('console-message', ({ level, message }: { level: string; message: string }) => {
        if (!collectConsole) return
        const msg = String(message)
        if (isRenderArtifactConsoleNoise(msg, isDc)) return
        if (level === 'warning' || level === 'error' || /never resolved|eval FAILED|SyntaxError|TypeError|ReferenceError/i.test(msg)) {
          if (problems.length < 20) problems.push(msg.slice(0, 200))
        }
      })
      let shotPath = ''
      let shotHeight = 900
      let docHeight = 0
      // 长页按段截：一次最多 SHOT_CAP 高（6 屏），从 scroll_y 起。上限是给模型上下文守的——每段图都占 token，
      // 页面多长不该由宿主替模型决定看多少；截到哪、后面还剩多少写在结果里，要看后面它再传 scroll_y 翻页。
      const SHOT_CAP = 5400
      let scrollY = Math.max(0, Math.round(Number(p.scroll_y) || 0))
      let clipFailed = ''
      const frames: Array<{ pct: number; time: number; path: string }> = []
      // 隐藏窗口 capturePage 在部分环境不重合成 → 逐帧字节全同（W2#11 真机 bug）。检出这种情况
      // 就不写等值假帧，只保留基帧并在文本说明——不误导模型以为已核过运动。
      let frameCaptureFrozen = false
      // 基帧截图 buffer——冒泡到 try 外，供 try 结束后按模型能力位决定是否转 base64 塞进 content
      let capturedBuf: Buffer | null = null
      // 页面文本摘要（核心修复）：dc 有 frame 结构就按 frame 分组，否则整页兜底
      let summary: { frames: Array<{ label: string | null; text: string }> } | null = null
      const shotName = resolvedId || path.basename(file).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_')
      try {
        if (fileMode) {
          await win.loadURL('file://' + encodeURI(file).replace(/#/g, '%23'))
        } else {
          await win.loadURL('data:text/html;base64,' + Buffer.from(html, 'utf8').toString('base64'))
        }
        await new Promise((r) => setTimeout(r, 5000)) // 等 CDN React + boot + 首帧
        // 首屏帧：动画多帧自检拿它做"合成器有没有冻结"的基准（下方 varying 判定），窗口始终 1280×900 不动
        const baseBuf = (await win.webContents.capturePage()).toPNG()
        capturedBuf = baseBuf
        // 长页截段：页面能滚动（长文/文档）就用 CDP 的 captureBeyondViewport 从 scroll_y 起截 SHOT_CAP 高，
        // 视口不动（100vh、吸顶、滚动入场都保持用户看到的样子），也绕开 capturePage 的 16384 像素硬顶。
        // 舞台类产物（deck 等 html/body 100% 高）scrollHeight == 视口高，走不到这里。
        // 2026-09-11 实撞：只截首屏时模型为了看下半页去找 Playwright、翻 conversations 目录；
        // 把窗拉到 6000 高一次截完则 8192 以上 UnknownVizError，超过的部分模型只能改 zoom 做副本自己看。
        docHeight = Number(await win.webContents
          .executeJavaScript('Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0)')
          .catch(() => 0)) || 0
        scrollY = Math.min(scrollY, Math.max(0, Math.round(docHeight) - 900))
        if (docHeight > 900 + 8 || scrollY > 0) {
          const clipHeight = Math.min(Math.round(docHeight) - scrollY, SHOT_CAP)
          const dbg = win.webContents.debugger
          try {
            dbg.attach('1.3')
            const shot = await dbg.sendCommand('Page.captureScreenshot', {
              format: 'png', captureBeyondViewport: true, clip: { x: 0, y: scrollY, width: 1280, height: clipHeight, scale: 1 }
            })
            capturedBuf = Buffer.from(String(shot?.data || ''), 'base64')
            shotHeight = clipHeight
          } catch (err: any) {
            // CDP 截不到就退回首屏，文案照实说只有首屏；这是宿主的事，不进 problems（那是让模型修的清单）
            capturedBuf = baseBuf
            shotHeight = 900
            scrollY = 0
            clipFailed = String(err?.message || err)
          } finally {
            try { if (dbg.isAttached()) dbg.detach() } catch { /* ignore */ }
          }
        }
        // 截图落本会话的产物目录（outputs/<conversationId>/.self-check/），模型 ls 自己的目录不会被拦
        const shotDir = path.join(outputsDirFor(conversationId), '.self-check')
        fs.mkdirSync(shotDir, { recursive: true })
        shotPath = path.join(shotDir, `${shotName}${scrollY > 0 ? `.y${scrollY}` : ''}.png`)
        fs.writeFileSync(shotPath, capturedBuf ?? baseBuf)
        // 文本重叠自检（弱模型排版常见坑：导航行/标签互相堆叠）：检测失败静默跳过，不阻断原有自检
        const overlaps: string[] = await win.webContents.executeJavaScript(OVERLAP_LINT_JS).catch(() => [])
        for (const o of overlaps) {
          if (problems.length < 20) problems.push(o)
        }
        // 页面文本摘要：截图 read 链路已证实全断（photon resize 在主进程恒断）+ 当前主模型不支持
        // 图片输入——弱模型全靠这段文本核对文案/品牌名/数据，"渲染干净"只代表无 JS 错误。
        summary = await win.webContents.executeJavaScript(PAGE_TEXT_SUMMARY_JS).catch(() => null)
        // 动画多帧自检（W2 条款6）：仅当产物含 data-openpipal-video-duration-secs（运行时的
        // seek 监听挂在该画布元素本体）时触发——无此属性→duration=0→整段跳过，非动画产物零回归。
        const duration: number = await win.webContents
          .executeJavaScript(
            `(function(){var el=document.querySelector('[data-openpipal-video-duration-secs]');if(!el)return 0;var d=parseFloat(el.getAttribute('data-openpipal-video-duration-secs'));return isFinite(d)&&d>0?d:0;})()`
          )
          .catch(() => 0)
        if (typeof duration === 'number' && duration > 0) {
          // 隐藏窗口只有 load 后的“首个合成帧”可靠（在位 seek 到旧帧上不重合成 → 假等值帧，见 W2#11）。
          // 改法：让 Stage 在**首帧**即定格到目标时间，逐帧重载后截首帧。Stage 初始时间读自
          // localStorage[persistKey+':t']（运行时契约 C7）——
          //   · 文件模式：origin 有 localStorage，直接预置每个 <persistKey>:t = time 再 reload
          //   · data 模式：opaque origin 无 localStorage，注入 stub 让运行时初值读到 time
          collectConsole = false // reload 会重放启动告警，后续不再计入问题清单
          /**
           * 重载后等画布出现，然后**显式派一次 seek**（运行时契约 C5：语义已含暂停 + 钉到该时刻）
           * 再截图。以前这里是 400ms 盲等：慢机器上 React 还没提交就截 → 空白帧；快机器上
           * autoplay 已经把播放头推走 → 采到的其实是 t+0.4s 左右。seek 是确定性的，两头都治。
           * 双 rAF 与导出链同一配方；rAF 在被节流的隐藏窗口里可能不回调，故整体设超时兜底。
           */
          const settleAt = async (time: number) => {
            let ready = false
            for (let i = 0; i < 40; i++) {
              ready = await win.webContents
                .executeJavaScript(`!!document.querySelector('[data-openpipal-video-duration-secs]')`)
                .catch(() => false)
              if (ready) break
              await new Promise((r) => setTimeout(r, 150))
            }
            if (!ready) {
              await new Promise((r) => setTimeout(r, 400)) // 画布始终没出现：退回原来的盲等
              return
            }
            const seeked = await win.webContents
              .executeJavaScript(
                `new Promise(function(resolve){var el=document.querySelector('[data-openpipal-video-duration-secs]');` +
                  `if(!el){resolve(false);return}` +
                  `el.dispatchEvent(new CustomEvent('openpipal:seek-to-time',{detail:{time:${time}}}));` +
                  `requestAnimationFrame(function(){requestAnimationFrame(function(){resolve(true)})});` +
                  `setTimeout(function(){resolve(true)},1500)})`
              )
              .catch(() => false)
            if (!seeked) await new Promise((r) => setTimeout(r, 400))
          }
          const candidates: Array<{ pct: number; time: number; buf: Buffer }> = []
          for (const pct of [10, 50, 90]) {
            const time = (pct / 100) * duration
            try {
              if (fileMode) {
                await win.webContents
                  .executeJavaScript(
                    `(function(){try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(/:t$/.test(k))localStorage.setItem(k,'${time}')}}catch(e){}})()`
                  )
                  .catch(() => {})
                await win.loadURL('file://' + encodeURI(file!).replace(/#/g, '%23'))
              } else {
                const stub = `<script>Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:function(k){return /:t$/.test(k)?'${time}':null},setItem:function(){},removeItem:function(){},clear:function(){},key:function(){return null},length:0}});</script>`
                const framed = html.replace(/<head([^>]*)>/i, (m) => `${m}${stub}`)
                await win.loadURL('data:text/html;base64,' + Buffer.from(framed, 'utf8').toString('base64'))
              }
              await settleAt(time)
              candidates.push({ pct, time, buf: (await win.webContents.capturePage()).toPNG() })
            } catch {
              // A failed optional frame must not hide the successful base render.
            }
          }
          // 诚实门闩：任一帧与基帧字节不同 → 合成器正常工作 → 写全部三帧；
          // 逐帧与基帧全同 → capturePage 冻结（本 bug）→ 不写假等值帧，标记降级。
          const varying = candidates.filter((c) => !c.buf.equals(baseBuf))
          if (varying.length > 0) {
            for (const c of candidates) {
              const framePath = path.join(shotDir, `${shotName}-t${c.pct}.png`)
              fs.writeFileSync(framePath, c.buf)
              frames.push({ pct: c.pct, time: c.time, path: framePath })
            }
          } else if (candidates.length > 0) {
            frameCaptureFrozen = true
          }
        }
      } catch (err: any) {
        problems.push(`页面加载失败: ${err?.message || err}`)
      } finally {
        win.destroy()
      }
      // 模型能力位：默认（undefined）按支持图片处理，显式 false 才是纯文本模型
      // （与 config-manager.ts buildModelFromConfig 的 input 字段判定同一约定）。
      const supportsImages = getEffectiveModelConfig()?.supportsImages !== false
      // 上限按最坏口径设防：部分网关把 data-URL 图按原始 base64 文本计 token（~1.5 字符/token），
      // 全尺寸 PNG（实测 ~700KB → base64 ~930KB）单图即 60 万 token，直接打爆 500k 上限致整轮 400。
      const MAX_IMAGE_B64 = 600 * 1024
      const imageBlocks: Array<{ type: 'image'; data: string; mimeType: string }> = []
      let imageNote = ''
      let tileNote = ''
      if (capturedBuf) {
        if (supportsImages) {
          // 发送用缩到 1024 宽的 JPEG（盘上仍存全尺寸 PNG，导出时用）。整页截图按 ≤1200 高切段、自上而下
          // 逐段附上：一张 6000 高的图缩成一张既超上限又糊成一团，模型只好自己 cp 出来再裁（2026-09-11 实测）。
          // 总量守 MAX_IMAGE_B64：先降质量再降宽度，实在装不下就只附前几段并把没附的说清楚。
          const TILE = 1200
          const tiles = Math.max(1, Math.ceil(shotHeight / TILE))
          let sent: Buffer[] = [capturedBuf]
          let sendMime = 'image/png'
          try {
            const full = nativeImage.createFromBuffer(capturedBuf)
            for (const [maxWidth, quality] of [[1024, 70], [1024, 55], [896, 50], [768, 45]] as Array<[number, number]>) {
              const scaled = full.getSize().width > maxWidth ? full.resize({ width: maxWidth }) : full
              const { width, height } = scaled.getSize()
              const tileH = Math.ceil(height / tiles)
              const bufs: Buffer[] = []
              for (let y = 0; y < height; y += tileH) {
                const piece = tiles === 1 ? scaled : scaled.crop({ x: 0, y, width, height: Math.min(tileH, height - y) })
                bufs.push(piece.toJPEG(quality))
              }
              if (bufs.some((b) => b.length === 0)) break
              sent = bufs
              sendMime = 'image/jpeg'
              if (bufs.reduce((n, b) => n + b.length, 0) * 4 / 3 <= MAX_IMAGE_B64) break
            }
          } catch { /* nativeImage 不可用（如单测环境）→ 原图走上限兜底 */ }
          let total = 0
          for (const buf of sent) {
            const b64 = buf.toString('base64')
            if (total + b64.length > MAX_IMAGE_B64) break
            total += b64.length
            imageBlocks.push({ type: 'image', data: b64, mimeType: sendMime })
          }
          if (imageBlocks.length === 0) {
            imageNote = `\n（截图太大没能随结果附上；完整 PNG 在 ${shotPath}，用 read 工具读它就能看图）`
          } else if (imageBlocks.length < sent.length) {
            imageNote = `\n（只附上了前 ${imageBlocks.length}/${sent.length} 段，再多就超出单次结果的图片上限；下面的部分用 read 工具读完整 PNG ${shotPath}）`
          } else if (imageBlocks.length > 1) {
            tileNote = `，自上而下切成 ${imageBlocks.length} 段`
          }
        } else {
          imageNote = '\n（当前模型不支持看图，未随结果发送截图——以下文本摘要即为核对依据）'
        }
      }
      // 之前的文案把截图说成给人看的，模型读成"图不是给我的"，只认"渲染干净"四个字就交稿。图是给它看的，说清楚。
      // 截到哪、后面还剩多少、下一次传什么，都写成事实；看不看后面是模型的判断。
      const totalHeight = Math.round(docHeight)
      const shotEnd = scrollY + shotHeight
      const cutOff = totalHeight > shotEnd + 8
        ? (clipFailed
            ? `，页面总高 ${totalHeight}，整页截图失败（${clipFailed}），只截到首屏`
            : `，页面总高 ${totalHeight}，${shotEnd} 以下没截到——要看后面再调一次并传 scroll_y: ${shotEnd}`)
        : ''
      const segment = scrollY > 0 ? `，本段 ${scrollY}–${shotEnd}${totalHeight > shotEnd ? '' : '（已到底）'}` : ''
      const shotScope = (shotHeight > 900 || scrollY > 0) ? `整页 1280×${shotHeight}${segment}${cutOff}${tileNote}` : `首屏 1280×900${cutOff}`
      const shotNote = shotPath
        ? (imageBlocks.length
            ? `\n截图（${shotScope}）已随本结果附上——看图核对版式、图形、文案位置；"渲染干净"只说明没报错。文件: ${shotPath}${imageNote}`
            : `\n截图（${shotScope}）已存盘: ${shotPath}${imageNote}`)
        : ''
      const framesNote = frames.length
        ? `\n动画多帧自检（初始定格 t=10%/50%/90% 各截一帧，逐帧核对运动是否连贯、有无卡帧/穿模）：\n${frames.map((f) => `- t${f.pct}% (${f.time.toFixed(2)}s): ${f.path}`).join('\n')}`
        : frameCaptureFrozen
          ? `\n动画多帧自检：已按 t=10%/50%/90% 注入初始时间并逐帧重载渲染，但本隐藏窗口的 capturePage 逐帧字节完全相同（合成层未随内容刷新）——为避免给出等值假帧，未输出逐帧图。运动是否连贯请在真实预览窗口目视核对。`
          : ''
      // 页面文本摘要拼装：dc 有 frame 结构（data-screen-label）按 frame 分组各截 400 字符；
      // 否则整页兜底截 1200 字符。动画产物文案随时间变化——取当前定格帧即可。
      const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)
      let summaryNote = ''
      if (summary && Array.isArray(summary.frames) && summary.frames.length) {
        const animPrefix = looksLikeAnimationDc(raw) ? '（动画取当前帧）\n' : ''
        const isSingleFallback = summary.frames.length === 1 && summary.frames[0].label === null
        const body = isSingleFallback
          ? truncate(summary.frames[0].text, 1200)
          : summary.frames.map((f, i) => `【${f.label || `#${i + 1}`}】${truncate(f.text, 400)}`).join('\n')
        summaryNote = `\n\n📄 页面文本摘要（核对文案/品牌名/数据用——"渲染干净"只代表无 JS 错误，不代表内容正确）：\n${animPrefix}${body}`
      }
      const text = problems.length
        ? `渲染发现 ${problems.length} 个问题（修完再交）：\n${problems.map((m) => `- ${m}`).join('\n')}${shotNote}${framesNote}${summaryNote}`
        : `渲染干净：无 console 错误、无未解析空穴。${shotNote}${framesNote}${summaryNote}`
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text }
      ]
      content.push(...imageBlocks)
      return { content, details: frames.length ? { frames } : {} }
    }
  }
}

const execFileAsync = promisify(execFile)

/** ffprobe 探测路径照抄 dc-video-export.ts 的 ffmpeg 探测模式（homebrew 优先 → PATH 兜底）。 */
function resolveFfprobeBin(): string {
  for (const c of ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']) {
    if (fs.existsSync(c)) return c
  }
  return 'ffprobe'
}

/**
 * 证据式校验（对齐官方 gen_pptx 的 validation flags）：导出后跑一遍 ffprobe，把分辨率/时长/
 * 真实帧数（-count_frames 逐帧解码计数，比 nb_frames 元数据更可信）交给模型自己判断这次导出对不对。
 */
async function probeMp4(filePath: string): Promise<Mp4ProbeData | { error: string }> {
  const bin = resolveFfprobeBin()
  try {
    const { stdout } = await execFileAsync(bin, [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_read_frames:format=duration',
      '-of', 'json',
      filePath
    ])
    const data = JSON.parse(stdout)
    const stream = data?.streams?.[0]
    const width = Number(stream?.width)
    const height = Number(stream?.height)
    const frames = Number(stream?.nb_read_frames)
    const durationSec = Number(data?.format?.duration)
    if (!width || !height || !Number.isFinite(durationSec) || durationSec <= 0) {
      return { error: 'ffprobe 未能解析视频元数据（文件可能损坏）' }
    }
    return { width, height, durationSec, frames: Number.isFinite(frames) ? frames : 0 }
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { error: 'ffprobe 未安装（brew install ffmpeg）——已导出但无法自动校验，请人工确认视频可正常播放' }
    }
    return { error: `ffprobe 探测失败：${err?.message || err}` }
  }
}

const EXPORT_FORMAT_LABELS: Record<string, string> = {
  mp4: 'mp4', pptx: 'pptx', handoff: 'handoff', pdf: 'pdf', 'standalone-html': 'standalone-html', 'project-zip': 'project-zip'
}

/**
 * export_artifact —— 对齐官方 Claude Design 的 gen_pptx 模式：工具自己执行导出 + 自己验一遍，
 * 把校验数据（不是简单的 ok/fail）放进返回文本，判断这次导出对不对、要不要重试的权力留给模型。
 * targetDir 固定 ~/.openpipal/outputs（全局“作品”可回看；本会话则依据工具结果元数据精确展示，
 * 不扫描全局目录猜归属）。不接导出弹窗的 getExportDir 记忆目录——那是用户手动导出场景，
 * Agent 自动交付走自有数据目录。
 */
function createExportArtifactTool(conversationId?: string): AgentTool {
  return {
    name: 'export_artifact',
    label: '导出',
    description: `把已有 artifact 导出成可交付的文件，落本会话的产物目录 ~/.openpipal/outputs/<会话id>/（结果里带完整路径；用户可在“作品”中回看，不用另外找路径）。

六种格式：
- mp4：逐帧导出动画视频（无声）。**只对动画 dc 有效**（引用 animations.jsx / 用 useSprite·useTime / 定义 Stage 的产物），非动画产物会被拒绝并给出可选格式提示
- pptx：每页一张整幅截图的 PowerPoint（像素级还原、不可编辑）。**只对幻灯片（deck-stage）dc 有效**（引用 deck-stage.js 的产物），非 deck 产物会被拒绝并给出可选格式提示
- handoff：交接包（HANDOFF.md + design 源文件 + reference 截图 + tokens.json），给任意 coding agent（Claude Code/Cursor/Codex 等）拿去实现，不绑定任何目标框架。**对所有 dc 产物都有效**（deck/动画/静态页/画板，只要是 dc 就能导出），只有非 dc 产物会被拒绝
- pdf：文档/静态页直出 PDF（doc-page 分页文档效果最好）
- standalone-html：离线自足单文件 HTML（内联运行时+依赖，断网可开）
- project-zip：打包成 zip（含 support.js + React vendor，方便整体分享）

导出成功后返回文本里带**校验数据**（mp4 是分辨率/时长/帧数，pptx 是页数/分辨率，handoff 是截图数/文件数，其余是文件大小）——先核对这些数据再告诉用户"已导出"；数据明显异常（比如文件小到不合理）就重新导出一次或如实告知问题，不要盲目宣称成功。`,
    parameters: Type.Object({
      id: Type.String({ description: '要导出的 artifact 的 id 或标题（历史 tool 结果里的 (id: artifact-XXXX)，或直接写它的标题——系统会按本会话解析）' }),
      format: Type.Union(
        [Type.Literal('mp4'), Type.Literal('pptx'), Type.Literal('handoff'), Type.Literal('pdf'), Type.Literal('standalone-html'), Type.Literal('project-zip')],
        { description: '导出格式：mp4(动画视频，仅动画 dc) / pptx(截图版演示文稿，仅幻灯片 deck-stage dc) / handoff(交接包，给 coding agent 实现，任意 dc) / pdf(文档直出) / standalone-html(离线单文件) / project-zip(打包分享)' }
      )
    }),
    execute: async (_id, params) => {
      const p = params as any
      const resolved = resolveArtifactId(p.id, conversationId)
      if ('error' in resolved) {
        return { content: [{ type: 'text', text: resolved.error }], details: {} }
      }
      const { file, id: artifactId } = resolved
      const content = fs.readFileSync(file, 'utf8')
      const meta = getArtifactStore().getRecord(artifactId)
      const title = meta?.title || artifactId
      const format = String(p.format || '')
      if (!EXPORT_FORMAT_LABELS[format]) {
        return { content: [{ type: 'text', text: `未知导出格式: ${format}` }], details: {} }
      }
      // 按会话分目录（outputs/<conversationId>/）：结果里带完整路径，安全层放行自己的目录
      const outRoot = outputsDirFor(conversationId)

      if (format === 'mp4') {
        const gate = mp4FormatGateMessage(content)
        if (gate) {
          return { content: [{ type: 'text', text: `已拒绝：${gate}` }], details: {} }
        }
        const res = await exportArtifactMp4(title, content, artifactId, {}, outRoot)
        if (!res.ok || !res.path) {
          return { content: [{ type: 'text', text: `mp4 导出失败：${res.error || '未知错误'}` }], details: {} }
        }
        const probe = await probeMp4(res.path)
        if ('error' in probe) {
          return exportedFileResult(title, res.path, `已导出 mp4：${res.path}（校验失败：${probe.error}）`)
        }
        const size = fs.statSync(res.path).size
        return exportedFileResult(title, res.path, formatMp4ValidationText(res.path, probe, size))
      }

      if (format === 'pptx') {
        const gate = pptxFormatGateMessage(content)
        if (gate) {
          return { content: [{ type: 'text', text: `已拒绝：${gate}` }], details: {} }
        }
        const res = await exportArtifactPptx(title, content, artifactId, outRoot)
        if (!res.ok || !res.path) {
          return { content: [{ type: 'text', text: `pptx 导出失败：${res.error || '未知错误'}` }], details: {} }
        }
        const size = fs.statSync(res.path).size
        return exportedFileResult(
          title,
          res.path,
          formatPptxValidationText(
            res.path,
            { pageCount: res.pageCount || 0, width: res.width || 0, height: res.height || 0 },
            size
          )
        )
      }

      if (format === 'handoff') {
        const gate = handoffFormatGateMessage(content)
        if (gate) {
          return { content: [{ type: 'text', text: `已拒绝：${gate}` }], details: {} }
        }
        const res = await exportArtifactHandoff(title, content, artifactId, outRoot)
        if (!res.ok || !res.path) {
          return { content: [{ type: 'text', text: `交接包导出失败：${res.error || '未知错误'}` }], details: {} }
        }
        const size = fs.statSync(res.path).size
        return exportedFileResult(
          title,
          res.path,
          formatHandoffValidationText(
            res.path,
            { screenshotCount: res.screenshotCount || 0, fileCount: res.fileCount || 0 },
            size
          )
        )
      }

      if (format === 'pdf') {
        const res = await exportArtifactPdf(title, content, outRoot, artifactId)
        if (!res.ok || !res.path) {
          return { content: [{ type: 'text', text: `pdf 导出失败：${res.error || '未知错误'}` }], details: {} }
        }
        const size = fs.statSync(res.path).size
        return exportedFileResult(title, res.path, formatFileValidationText('pdf', res.path, size))
      }

      if (format === 'standalone-html') {
        const res = exportStandaloneHtml(title, content, artifactId, outRoot)
        if (!res.ok || !res.path) {
          return { content: [{ type: 'text', text: `html 导出失败：${res.error || '未知错误'}` }], details: {} }
        }
        const size = fs.statSync(res.path).size
        return exportedFileResult(title, res.path, formatFileValidationText('standalone-html', res.path, size))
      }

      // project-zip：先装配离线文件夹（同 ipc-handlers artifact:export 的 project-zip 分支），再 zip
      const zipGate = projectZipFormatGateMessage(content)
      if (zipGate) {
        return { content: [{ type: 'text', text: `已拒绝：${zipGate}` }], details: {} }
      }
      const bundle = exportDcBundle(title, [{ title, content, artifactId }], outRoot)
      if (!bundle.ok || !bundle.dir) {
        return { content: [{ type: 'text', text: `zip 导出失败：${bundle.error || '装配失败（可能不是 Design Component 内容）'}` }], details: {} }
      }
      const res = await exportZip(bundle.dir, title, outRoot)
      if (!res.ok || !res.path) {
        return { content: [{ type: 'text', text: `zip 导出失败：${res.error || '未知错误'}` }], details: {} }
      }
      const size = fs.statSync(res.path).size
      return exportedFileResult(title, res.path, formatFileValidationText('project-zip', res.path, size))
    }
  }
}

/** 动画 DC 特征（与反内联门闩共用一套判定，避免两处正则漂移）：引 animations.jsx / useSprite·useTime / 定义 Stage / <Beat> */
function looksLikeAnimationDc(c: string): boolean {
  return /from="[^"]*animations\.jsx/i.test(c) || /\b(useSprite|useTime)\s*\(/.test(c) || /\bfunction\s+Stage\s*\(/.test(c) || /<Beat[\s/>]/.test(c)
}

function createArtifactTool(
  conversationId: string | undefined,
  roleName: string,
  roleBrief: Record<string, Record<string, any>> | undefined,
  /** 这个 Agent 档案里的声明：整页 HTML 走不走 DC、jsx 要不要闸门 */
  agentPolicies: AgentPolicies
): AgentTool {
  return {
    name: 'create_artifact',
    label: '预览',
    description: `创建或更新一个 artifact（侧边栏的持久化预览作品）。

**迭代是默认操作，不是开新作品**：
- 用户说"改一下颜色 / 把那段改成 X / 标题再大点"——是迭代上一个 artifact，**必须**传入它的 id 来更新（同 id 会原地替换内容）
- 用户不满意要**推倒重做**也一样：沿用原 id 全量重发（原地替换）——只有用户明确说"新做一个 / 再做一份 / 保留旧版" 才创建新 artifact
- 新建时省略 id（由系统生成，不要自己编）；已有产物的 id 和标题在系统提示的 <session-artifacts> 清单里（本轮工具结果里也有 \`(id: artifact-XXXX)\`），改稿/重做时直接复用

不适用场景：轻量绘图/图表请用 create_visualizer。`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '已有 artifact 的 id 或标题（迭代修改/推倒重做时必传，会原地替换；写不出完整 id 时可直接写它的标题，系统按本会话解析）。新建时省略——id 由系统生成。' })),
      force_new: Type.Optional(Type.Boolean({ description: '强制新建：仅当用户明确要求"另做一份/保留旧版对比"时传 true，跳过同名/相近标题拦截。' })),
      type: Type.String({ description: '内容类型：html(网页/组件)、code(代码示例)、markdown(文档)、svg(矢量图)、document(结构化富文本文档，暂以 markdown 降级渲染)、canvas(真实可绘画的手写白板，学生可在上面手写/画图/擦除——非占位符)、design-system(设计系统画廊指针——技能收尾专用，content 填 {"name":"<文件夹名>"})' }),
      title: Type.String({ description: '内容标题' }),
      content: Type.String({ description: '完整内容。HTML 类型应包含完整的 <!DOCTYPE html> 文档，可内联 <style> 和 <script>。document 暂填 Markdown 源。canvas 类型固定填空字符串 \'{}\'——表示空白画布,学生会自己开始画;不要试图用 JSON 预生成笔迹。' }),
      language: Type.Optional(Type.String({ description: 'code 类型时指定编程语言，如 python、javascript、typescript' }))
    }),
    execute: async (_id, params) => {
      const p = params as any
      // 机制优于纪律（2026-07-03 实测）：模型"推倒重做"时会无视"迭代必传 id"的说明，
      // 不带 id 重建同名产物；编造的 id 也会静默生成新作品。两条路都在这里拦死。
      if (p.id && conversationId) {
        const resolved = resolveArtifactId(p.id, conversationId)
        if ('error' in resolved) {
          return { content: [{ type: 'text', text: resolved.error }], details: {} }
        }
        p.id = resolved.id
        // 写入对账门闩（机制优于纪律，2026-07-20）：create_artifact 同 id 全量重发从不读盘，
        // 用户经 UI 直改磁盘后会被静默覆盖。磁盘 mtime 领先于 Agent 最后一次读写基线超过容差 → 拒绝，
        // 逼模型先 read_artifact 看一眼再把用户的修改整合进新版本（read/edit 成功后会刷新基线，循环收敛）。
        let diskMtimeMs: number | undefined
        try { diskMtimeMs = fs.statSync(resolved.file).mtimeMs } catch { /* 文件竞态删除，交给后续正常创建流程处理 */ }
        if (diskMtimeMs !== undefined) {
          const guard = evaluateArtifactWriteGuard(diskMtimeMs, getArtifactStore().getRecord(resolved.id)?.lastKnownMtimeMs)
          if (guard.blocked) {
            return { content: [{ type: 'text', text: guard.message! }], details: {} }
          }
        }
      }
      if (!p.id && conversationId && !p.force_new) {
        // 门闩收窄（W2）：仅同 type 之间比较——html 薄壳与 code 场景标题相近可共存，html+html 相近仍拦。
        const store = getArtifactStore()
        const entries = listConversationArtifacts(conversationId).map((e) => {
          const rec = store.getRecord(e.id)
          return { id: e.id, title: e.title || rec?.title || '', type: rec?.type || coarseTypeFromFile(e.file) }
        })
        const dup = findSimilarArtifact(p.title, p.type, entries)
        if (dup) {
          const dupTitle = dup.title || store.getRecord(dup.id)?.title || dup.id
          return {
            content: [{ type: 'text', text: `已拒绝：本会话已有相近标题的产物「${dupTitle}」(id: ${dup.id})。**局部改稿优先用 edit_artifact**（带 id: ${dup.id}，只发要改的片段，更快更稳）；确要整篇推倒重做才用相同 id 重新调用 create_artifact（原地替换）。只有用户明确要求"另做一份/保留旧版对比"时才新建——那种情况加 force_new: true 重发。` }],
            details: {}
          }
        }
      }
      // dc 门闩（机制优于纪律）：声明了 artifacts: dc 的 Agent（design / teacher 内置声明；Pal 可在 agent.md frontmatter 里声明）
      // 整页 HTML 交付必须是 Design Component。实测模型跳过读 dc-authoring 技能时会退回普通 HTML（首轮 2/5 合规），工具级拒绝把纪律变成机制。
      if (agentPolicies.artifacts === 'dc' && p.type === 'html') {
        const c: string = p.content || ''
        const reject = (msg: string) => ({
          content: [{ type: 'text' as const, text: `已拒绝：${msg}` }],
          details: {}
        })
        // 模板门闩（机制优于纪律）：preflow 点选的 taskType 是用户的明确决定，但弱模型常按对话
        // 措辞重推任务类型（选了动画却交幻灯片）。拦"本会话首个 **html** 产物"——svg 草图/canvas
        // 便签/辅助 code 不解除门闩（曾用 length===0 判定，任何无关小件先落地就把门闩永久解除了）；
        // 首个 html dc 落地后视为方向已定，不再干预。用户改口的例外走 <!-- non-anim: 原因 --> 标记。
        if (roleBrief?.[roleName]?.taskType === '动画' && conversationId &&
            !listConversationArtifacts(conversationId).some((e) => coarseTypeFromFile(e.file) === 'html') &&
            !looksLikeAnimationDc(c) && !/<!--\s*non-anim\b/i.test(c)) {
          return reject('用户在新建对话时已点选模板=**动画**——首个交付物必须是动画 DC，不是静态页面/幻灯片。先 read 技能索引里 animation-basics 的 SKILL.md，按"场景 jsx + 薄壳 x-import"两步节奏产出；若用户已在对话中明确改口要非动画产物，在文件首行加 <!-- non-anim: 原因 --> 后重试。')
        }
        if (/<html[\s>]/i.test(c) && !/<x-dc[\s>]/i.test(c) && !/<!--\s*non-dc\b/i.test(c)) {
          // 给绝对路径而不是"技能索引里的"：独立 Pal 的索引里没有 dc-authoring，模型会去猜路径、翻目录、要搜全盘（2026-09-09 实撞）
          return reject(`整页 HTML 交付物必须是 Design Component（.dc.html）格式。先 read ${path.join(getBuiltInSkillsDir(), 'dc-authoring', 'SKILL.md')}，按其文件骨架重写内容后用相同参数重新调用 create_artifact。若确属纯 canvas/WebGL 例外，在文件首行加 <!-- non-dc: 原因 --> 后重试。`)
        }
        if (/<x-dc[\s>]/i.test(c)) {
          // 截断检测：实测模型超长生成会在字符串中途被切断（错误边界虽兜底但交付物残缺）
          // 反内联门闩（机制优于纪律，**先于**截断检测——内联撑爆输出上限时给"别内联"而非泛泛截断提示）。
          // 仅对**动画** dc 判定（引用 animations.jsx / 用 useSprite·useTime / 定义 function Stage / Beat），避免误伤普通 dc 画板。
          // 实测弱模型会误判"file:// 不生效"把引擎+场景内联进薄壳 → 超预算截断 + 连撞门闩反复 recreate（摸索黑洞）。
          const animCtx = looksLikeAnimationDc(c)
          if (animCtx) {
            const definesEngine = /\bfunction\s+Stage\s*\(/.test(c) || /Object\.assign\(\s*window\s*,\s*\{[^}]*\b(Stage|Sprite|Direction|Film|Scene)[A-Za-z]*\b/.test(c)
            // body 不跨 </script>：避免误伤 helmet（空 support.js）+ 合法大 data-dc-script 逻辑块 的跨界假阳
            const bigInlineScript = /<script(?![^>]*\bdata-dc-script\b)[^>]*>(?:(?!<\/script>)[\s\S]){4000,}<\/script>/i.test(c)
            if (definesEngine || bigInlineScript) {
              return reject('薄壳里检测到被内联的引擎/场景代码——**别内联**。动画薄壳必须"薄"：用 `<x-import ... from="./animations.jsx ./artifact-<场景id>.jsx">` 引用兄弟文件，宿主会自动读盘内联（不走 file:// fetch，artifact 系统托管照样解析，渲染没立刻出画是正常的）。把引擎/场景移回各自的 jsx artifact，薄壳只留 x-import + 布局。改场景就 edit 场景那个 id，别把它塞进薄壳。')
            }
          }
          // 截断检测：实测模型超长生成会在字符串中途被切断（错误边界虽兜底但交付物残缺）
          if (!/<\/html>\s*$/i.test(c.trim())) {
            return reject('内容未以 </html> 闭合——疑似超长被截断。对策：图标改用 Unicode 字形（◎ ⊞ ◈ 这类）替代内联 SVG 字符串省 token；数据列表精简；仍然太长就先交结构完整的骨架版（标签全闭合），再同 id 迭代填充细节。')
          }
          // data-props 合法性：必须是 HTML 转义（&quot;）后的合法 JSON，否则运行时静默丢弃、调参面板不出现
          const dp = /data-props="([^"]*)"/.exec(c)
          if (dp && dp[1].trim()) {
            try {
              JSON.parse(dp[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
            } catch {
              return reject('data-props 不是合法 JSON——键名和字符串值都必须用 &quot; 转义的双引号（如 {&quot;mode&quot;:{&quot;editor&quot;:&quot;enum&quot;,…}}），否则宿主解析失败、调参面板不会出现。修正后重发。')
            }
          }
          // 逻辑类语法校验：SyntaxError 的稿子渲染时整个逻辑层瘫痪
          const synErr = dcLogicSyntaxError(c)
          if (synErr) {
            return reject(`逻辑类有语法错误（${synErr.slice(0, 120)}）——修正后重发。`)
          }
          // 模板边界校验：</x-dc> 之后只允许 data-dc-script 脚本——实测模型把 deck 主体写在模板外，
          // 运行时编译到空模板、裸 section 被浏览器静态渲染，视觉上几乎看不出坏（翻页/交互全失效）
          const closeIdx = c.toLowerCase().lastIndexOf('</x-dc>')
          if (closeIdx >= 0) {
            const after = c.slice(closeIdx + 7)
              .replace(/<script[^>]*\bdata-dc-script\b[^>]*>[\s\S]*?<\/script>/i, '')
              .replace(/<\/(body|html)>/gi, '')
              .replace(/<!--[\s\S]*?-->/g, '')
            if (after.trim()) {
              return reject(`</x-dc> 之后出现了正文内容（前 80 字符：${after.trim().slice(0, 80)}）——页面全部内容（包括 deck 的 <x-import> 和所有 section）必须在 <x-dc>…</x-dc> 内部，闭合标签后只允许 <script data-dc-script> 一个脚本块。调整结构后重发。`)
            }
          }
        }
      }
      // jsx 场景截断门闩（机制优于纪律）：type='code' jsx 是真正的截断受害者（34KB 正片场景在 a7e26d1d 被砍），
      // 走不到上面的 dc(html) 门闩。size 预防 + 编译完整性两道，把"分批产出"从纪律变成机制。isUpdate 路径同样过闸。
      if (agentPolicies.artifactJsxGuards && p.type === 'code') {
        const c: string = p.content || ''
        // ① 尺寸预防（语言标签无关——弱模型把 jsx 误标 javascript / 省略 language 也拦得住）：过大单次生成极易被截断
        if (c.length > 28000) {
          return { content: [{ type: 'text', text: `已拒绝：内容过大（${Math.round(c.length / 1000)}KB，单次生成易被输出上限截断）。别一次成稿：先 create 一个**能编译/闭合的骨架**拿到 id，再用 edit_artifact 分批填充（动画场景就 8 幕各留唯一占位如 \`{/* FILL:BEAT-3 */ null}\`，逐幕补）。` }], details: {} }
        }
        // ② 完整性：按**动画场景形状**识别（不靠 language 标签——弱模型误标也拦得住；但只认场景专有 shape，
        // 不用泛化的大写标签匹配，否则 TSX(<Button/>) / TS 泛型(Array<Item>) 会被误当 jsx 编译而误拒）：
        const looksScene = String(p.language || '').toLowerCase() === 'jsx' ||
          /\buseSprite\s*\(|\buseTime\s*\(|<Stage[\s>]|<Beat[\s>]/.test(c) ||
          /const\s*\{[^}]*\b(Stage|Sprite)\b[^}]*\}\s*=\s*window/.test(c)
        const { error: jsxErr } = looksScene ? compileJsxArtifact(c) : { error: '' }
        if (jsxErr) {
          return { content: [{ type: 'text', text: `已拒绝：jsx 预编译失败（${jsxErr.slice(0, 120)}）——疑似被截断或有语法错。**别整篇重发**（大概率又截断）：先留一个能编译的骨架，再用 edit_artifact 补齐/修正缺失的幕。` }], details: {} }
        }
      }
      const isUpdate = !!p.id
      const artifactId = p.id || `artifact-${Date.now()}`
      const artifactLanguage = normalizeArtifactLanguage({ type: p.type, title: p.title, language: p.language })
      // 同步落盘到注册表（关竞态的关键）——返回 id 前内容已在权威里，下一步 render/edit(id) 立即可解析，
      // 不再"找不到 id"反复重试。无 conversationId（罕见子流程）时维持旧行为：仅走后续 details.artifact 事件。
      if (conversationId) {
        getArtifactStore().upsert(conversationId, { id: artifactId, type: p.type, title: p.title, content: p.content, language: artifactLanguage })
      }
      // 把 id 写进结果文本，agent 在历史 context 里能看到，下次改稿能复用
      const verb = isUpdate ? '已更新' : '已创建'
      // 环境感知提示（同 create_visualizer 的做法）
      const env = getEnvironmentSnapshot()
      const orbHint = env.mode === 'orb' && p.type === 'html'
        ? `\n\n⚠️ orb 模式下侧边栏不可见。如果希望用户现在就看到，调用 present_to_user({ content: <本次 content>, kind: 'interactive', title: '${p.title}' })。`
        : ''
      // 文件在哪直接说：模型要自己截图/用 bash 处理时不必去翻 conversations 目录（会撞跨会话边界）
      const fileNote = conversationId ? `\n文件: ${artifactFilePath(conversationId, artifactId, p.type, artifactLanguage)}` : ''
      // jsx 场景：即时预检编译（真实存盘走 saveArtifact 钩子），编译失败回传让模型自修
      let compileNote = ''
      if (p.type === 'code' && String(artifactLanguage || '').toLowerCase() === 'jsx') {
        const { error } = compileJsxArtifact(p.content || '')
        if (error) compileNote = `\n\n⚠️ jsx 预编译失败：${error} —— 用 edit_artifact 修正（别整篇重发；疑似过长被截断就先留能编译的骨架再逐幕补）；未修复前引用它的薄壳会渲染出空白/占位。`
      }
      // 设计系统收尾（W4）：type='design-system' 是"发布到画廊"手势，顺势 best-effort 编译预览产物
      // （manifest / bundle / adherence 以及离线 React vendor）。编译告警（如组件 jsx 语法错）
      // 附回工具结果让模型看见并自修；不阻断画廊指针存盘。
      if (p.type === 'design-system') {
        try {
          const dsName = JSON.parse(String(p.content || '{}'))?.name
          if (dsName && typeof dsName === 'string') {
            const res = compileDesignSystem(dsName)
            if (res.files.length) {
              compileNote += `\n\n🛠 已编译设计系统预览产物：${res.files.map((f) => f.split('/').pop()).join(', ')}`
            }
            if (res.errors.length) {
              compileNote += `\n\n⚠️ 设计系统编译告警：${res.errors.slice(0, 6).join('；')}`
            }
            // 画廊评审证据式提示：有被踩未解决项时随发布结果告知（不阻断——判断力归模型/用户）
            const rv = getDsReview(dsName)
            const downs = rv ? Object.entries(rv.cards || {}).filter(([, v]) => v?.verdict === 'down') : []
            if (downs.length) {
              const detail = downs.slice(0, 5).map(([rel, v]) => `${rel}${v.comment ? `（${v.comment.slice(0, 50)}）` : ''}`).join('；')
              compileNote += `\n\n⚠️ 画廊评审记录仍有 ${downs.length} 项被踩未解决：${detail}${downs.length > 5 ? '…' : ''}。建议先按反馈修改再定稿；修改后请用户在画廊重新评审。`
            }
          }
        } catch (err: any) {
          compileNote += `\n\n⚠️ 设计系统编译失败：${err?.message || String(err)}`
        }
      }
      return {
        content: [{ type: 'text', text: `${verb}预览: ${p.title} (id: ${artifactId})${fileNote}${orbHint}${compileNote}` }],
        details: {
          artifact: {
            id: artifactId,
            type: p.type,
            title: p.title,
            content: p.content,
            language: artifactLanguage
          }
        }
      }
    }
  }
}

// update_todos（W5 工作流轻件）：记录多步任务的待办清单，帮 AI 在长任务里保持方向不偏离。
// 全量替换语义（官方 update_todos）：每次发送**完整**当前列表，覆盖上一次；工具不阻塞（瞬时返回，立刻继续）。
// 复用通用 artifact 管道——details.artifact 自动经 pi-event-adapter 发 artifact 事件、存盘、进侧栏 tab（零改 adapter）。
// 稳定 id todos-<conversationId>：同会话反复调用同 id，前端 upsert 原地更新不抢焦点。
function createUpdateTodosTool(conversationId?: string): AgentTool {
  return {
    name: 'update_todos',
    label: '任务清单',
    description: `记录并更新一个多步任务的待办清单，帮你在长任务里保持方向不偏离。

**全量替换语义**：每次调用发送**完整的当前 todo 列表**，完全覆盖上一次——不是增量追加。改一项状态就重发整个列表。
**不阻塞**：调完立刻继续下一步，不用等用户确认。

何时用：任务有 3 步以上、或需要跨多轮保持方向时。开工先列计划（全 pending，把第一步标 in_progress）；每完成一步就把它标 completed、把下一步标 in_progress。`,
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          content: Type.String({ description: '这一步要做什么（一句话）' }),
          status: Type.Union(
            [Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')],
            { description: 'pending 未开始 / in_progress 进行中 / completed 已完成' }
          )
        }),
        { description: '完整的当前 todo 列表（全量替换上一次，不是增量）' }
      )
    }),
    execute: async (_id, params) => {
      const p = params as any
      // 容错：有的模型把数组 JSON-stringify 再传；尝试 parse 一次（同 questions_v2 做法）
      let todos: any[] = []
      if (Array.isArray(p.todos)) {
        todos = p.todos
      } else if (typeof p.todos === 'string') {
        try {
          const parsed = JSON.parse(p.todos)
          if (Array.isArray(parsed)) todos = parsed
        } catch {
          // Invalid model input is normalized to an empty todo list below.
        }
      }
      // 归一化 + 防脏数据：非法 status 落回 pending，空 content 丢弃
      const VALID = new Set(['pending', 'in_progress', 'completed'])
      todos = todos
        .map((t) => ({
          content: String(t?.content ?? '').trim(),
          status: VALID.has(t?.status) ? t.status : 'pending'
        }))
        .filter((t) => t.content)
      // 稳定 id：同会话复用（前端 upsert 原地更新不抢焦点）；无 conversationId 时退化为一次性 id
      const artifactId = conversationId ? `todos-${conversationId}` : `todos-${Date.now()}`
      const done = todos.filter((t) => t.status === 'completed').length
      const glyph = (s: string) => (s === 'completed' ? '☑' : s === 'in_progress' ? '◐' : '☐')
      const summary = todos.length
        ? `任务清单已更新（${done}/${todos.length} 完成）：\n${todos.map((t) => `${glyph(t.status)} ${t.content}`).join('\n')}`
        : '任务清单已清空。'
      return {
        content: [{ type: 'text', text: summary }],
        details: {
          artifact: {
            id: artifactId,
            type: 'todos',
            // Stable protocol title. Renderer chrome localizes this artifact by
            // its `todos` type; model context and persistence remain unchanged.
            title: '任务清单',
            content: JSON.stringify({ todos })
          }
        }
      }
    }
  }
}

function createVisualizerTool(): AgentTool {
  return {
    name: 'create_visualizer',
    label: '可视化',
    description: '轻量绘图和可视化的默认工具——直接嵌入对话气泡内显示，不打开侧边面板。\n\n渲染位置：内联在对话消息中。\n适用场景：用户想直观「看到」某个东西——一张图、一个图表、一段示意——作为对话的一部分。内容是一次性展示的，不需要后续编辑或持久保存。典型高度 <400px。\n\n不适用：完整网页、交互式应用等需要独立窗口交互的复杂内容，应使用 create_artifact。',
    parameters: Type.Object({
      type: Type.String({ description: 'Content type: html(HTML snippet), svg(SVG graphic), chart(chart data)' }),
      title: Type.String({ description: 'Visualization title shown in the inline card header' }),
      content: Type.String({ description: 'HTML、SVG 或图表的完整内容' }),
      height: Type.Optional(Type.Number({ description: '建议高度(px)，默认 300' }))
    }),
    execute: async (_id, params, _context) => {
      const p = params as any
      const visualizerId = `viz-${Date.now()}`
      // 环境感知提示：orb 模式下内联气泡不可见，必须调 present_to_user 才能让用户看到
      // 这是"情境式渐进披露"——提示只在工具执行后才递达，不占 system prompt
      const env = getEnvironmentSnapshot()
      const orbHint = env.mode === 'orb'
        ? `\n\n⚠️ 当前在 orb 模式，用户**看不到**内联可视化。立即调用 present_to_user({ content: <本次的 content 字段原文>, kind: 'interactive', title: '${p.title}' }) 把它推到 Presenter 窗口。`
        : ''
      return {
        content: [{ type: 'text', text: `已创建可视化: ${p.title}${orbHint}` }],
        details: {
          visualizer: {
            id: visualizerId,
            type: p.type,
            title: p.title,
            content: p.content,
            height: p.height || 300
          }
        }
      }
    }
  }
}

function createGenerateDocumentTool(workspaceId?: string, conversationId?: string): AgentTool {
  return {
    name: 'generate_document',
    label: '生成文档',
    description: '生成结构化文档或注册已生成的文件。两种用法：\n1. 传 content 生成 Markdown 文档（笔记、总结、周报等）\n2. 传 filePath 注册已通过脚本生成的文件（docx/xlsx/pptx 等），让用户可以直接打开。',
    parameters: Type.Object({
      title: Type.String({ description: '文档标题' }),
      content: Type.Optional(Type.String({ description: '文档内容（Markdown 格式）。与 filePath 二选一。' })),
      filePath: Type.Optional(Type.String({ description: '已生成文件的绝对路径（docx/xlsx/pptx/pdf 等）。与 content 二选一。' })),
      docType: Type.String({ description: '文档类型：学习笔记、知识卡片、复习测试、教案、教学总结、周报、会议纪要、项目文档、报告、数据报表、演示文稿、其他' })
    }),
    execute: async (_id, params) => {
      const p = params as any
      const title = p.title || '未命名文档'
      const docType = p.docType || '其他'

      // 模式 2：注册已生成的文件（docx/xlsx/pptx 等）
      if (p.filePath) {
        const filePath = p.filePath as string

        if (!fs.existsSync(filePath)) {
          return textResult(`文件不存在: ${filePath}`, { displayResult: `文件 ${filePath} 不存在` })
        }

        const stats = fs.statSync(filePath)
        const ext = path.extname(filePath).toLowerCase().replace('.', '')
        const fileName = path.basename(filePath)
        const fileSize = stats.size
        const sizeStr = fmtSize(fileSize)

        const result = `📄 已生成${docType}「${title}」\n文件: ${fileName}（${sizeStr}）\n位置: ${filePath}`
        return textResult(result, {
          displayResult: result,
          args: { title, filePath, fileType: ext, fileSize, fileName, docType }
        })
      }

      // 模式 1：生成 Markdown 文档。落 outputs/ 文件 + 复用 artifact 管线(自动打开可编辑 ArtifactTab)
      // 结果只给回执不回显正文——正文是模型自己刚写的参数，回显等于同一份内容在上下文里携带两遍。
      const content = p.content || ''
      const filepath = saveOutput(title, content, workspaceId, conversationId)
      const result = `📄 已生成${docType}「${title}」\n保存位置: ${filepath}\n（${content.length} 字符，正文已保存，需要时可 read 该文件）`
      return textResult(result, {
        displayResult: result,
        args: { title, content, docType, filePath: filepath },
        artifact: { id: `doc-${Date.now()}`, type: 'markdown', title, content }
      })
    }
  }
}

export interface CodeExecutionRequest {
  command: string
  workingDir: string
  signal?: AbortSignal
}

export interface CodeExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type CodeExecutionBackend = (
  request: CodeExecutionRequest
) => Promise<CodeExecutionResult>

export function createExecuteCodeTool(
  workingDir?: string,
  backend?: CodeExecutionBackend
): AgentTool {
  return {
    name: 'execute_code',
    label: '运行代码',
    description: '在安全沙箱中执行 Python、Node.js 或 Shell。仅在可执行计算、数据转换、自动化或可复现验证能实质帮助当前任务时使用；不要仅为重复读取、改述或判断已有内容而调用。',
    parameters: Type.Object({
      language: Type.String({ description: '编程语言：python、javascript、bash' }),
      code: Type.String({ description: '要执行的代码' }),
      description: Type.Optional(Type.String({ description: '代码目的简述' }))
    }),
    execute: async (_id, params, signal) => {
      const p = params as any
      const languageSpec = resolveCodeExecutionLanguage(p.language)
      if (!languageSpec) {
        throw new Error(`不支持的代码语言: ${String(p.language || '(空)')}。仅支持 python、javascript、bash`)
      }
      const lang = languageSpec.language
      const code: string = p.code || ''
      const desc = p.description || ''

      const ext = languageSpec.extension
      const runner = languageSpec.runner

      // 每次调用使用独占目录和文件。Date.now() 会在并发 Agent 中碰撞，可能导致
      // A 覆盖/执行/删除 B 的代码；mkdtemp + wx 把这个边界交给操作系统原子保证。
      const temporaryCode = createTemporaryCodeFile(ext, code)
      const tmpFile = temporaryCode.path

      const startTime = Date.now()
      try {
        if (!backend) throw new Error('代码执行后端未配置')
        const command = `${runner} "${tmpFile}"`
        const result = await backend({
          command,
          workingDir: workingDir || getWorkingDir(),
          signal
        })

        const elapsed = Date.now() - startTime
        const stdout = (result as any).stdout || ''
        const stderr = (result as any).stderr || ''
        const exitCode = (result as any).exitCode ?? 0

        const output = formatCodeExecutionOutput(stdout, stderr)
        const status = exitCode === 0 ? '成功' : `失败 (exit ${exitCode})`
        const resultText = `[${lang}] ${status} (${elapsed}ms)\n${output}${fileToolHint(code)}`

        return {
          content: [{ type: 'text', text: resultText }],
          details: {
            displayResult: resultText,
            codeExecution: { language: lang, code, stdout, stderr, exitCode, elapsed, description: desc }
          }
        }
      } catch (err: any) {
        const elapsed = Date.now() - startTime
        const errorText = `[${lang}] 执行错误 (${elapsed}ms): ${err.message}`
        return {
          content: [{ type: 'text', text: errorText }],
          details: {
            displayResult: errorText,
            codeExecution: { language: lang, code, stdout: '', stderr: err.message, exitCode: 1, elapsed, description: desc }
          }
        }
      } finally {
        temporaryCode.dispose()
      }
    }
  }
}

// ---- 公开 API ----

/**
 * 构建 Pi 工具列表，根据 source 和角色过滤。
 */
function createManageTaskTool(
  contextWorkspaceId: string | undefined,
  contextConversationId: string | undefined,
  roleName: string
): AgentTool {
  return {
    name: 'manage_task',
    label: '自动化',
    description: '创建、查看、修改或删除任务。任务让 Agent 具备被触发的能力（时间/事件/门控），触发时执行 prompt。当用户提到"提醒我"、"定时"、"每天"、"每周"、"每隔"时使用。',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('create'),
        Type.Literal('list'),
        Type.Literal('update'),
        Type.Literal('delete'),
        Type.Literal('toggle')
      ], { description: '操作类型' }),
      name: Type.Optional(Type.String({ description: '任务名称' })),
      prompt: Type.Optional(Type.String({ description: '触发时发给 Agent 的消息（create/update 时必需）。webhook 触发时，请求 body + 关键 headers 会自动追加在 prompt 之后（"## Webhook 事件数据"小节），写 prompt 时可以提示 Agent 解析它（例如："根据下方事件数据中的 task_id 字段查询..."）' })),
      trigger_type: Type.Optional(Type.Union([
        Type.Literal('fixed'), Type.Literal('interval'), Type.Literal('cron'), Type.Literal('webhook')
      ], { description: '触发类型: fixed=固定时间, interval=时间间隔, cron=Cron表达式, webhook=HTTP 回调' })),
      time: Type.Optional(Type.String({ description: '时间 HH:MM (trigger_type=fixed)' })),
      days: Type.Optional(Type.Array(Type.String(), { description: '星期几 mon/tue/wed/thu/fri/sat/sun (trigger_type=fixed 可选)' })),
      interval_minutes: Type.Optional(Type.Number({ description: '间隔分钟数 (trigger_type=interval)' })),
      cron: Type.Optional(Type.String({ description: '5字段 Cron (trigger_type=cron)' })),
      webhook_secret: Type.Optional(Type.String({ description: 'Webhook secret，校验请求头 X-OpenPipal-Secret (trigger_type=webhook 必需)' })),
      smart_silence: Type.Optional(Type.Boolean({ description: '智能免打扰（默认开启）。开启时 Agent 判断事件不重要会静默处理，记入审计日志而不打扰用户。设 false 强制每次都通知' })),
      task_id: Type.Optional(Type.String({ description: '任务 ID (update/delete/toggle 必需)' })),
      enabled: Type.Optional(Type.Boolean({ description: '启用/禁用 (toggle 时使用)' })),
      workspace_id: Type.Optional(Type.String({ description: 'Workspace Agent ID。提供后任务挂在该 workspace 下；在 workspace 上下文中自动填充' })),
      agent_id: Type.Optional(Type.String({ description: '全局任务指定的 Agent 模板 ID (与 workspace_id 互斥)' })),
      conversation_mode: Type.Optional(Type.Union([Type.Literal('persistent'), Type.Literal('per-run')], { description: 'persistent=累积在同一会话, per-run=每次新建会话 (默认 per-run)' })),
    }),
    execute: async (_id, params: any) => {
      const p = params as Record<string, any>
      const wsId = p.workspace_id || contextWorkspaceId

      switch (p.action) {
        case 'list': {
          const tasks = listTasks()
          if (tasks.length === 0) return textResult('当前没有任务。')
          const summary = tasks.map(t => {
            const status = t.enabled ? '启用' : '禁用'
            const next = t.nextRun ? new Date(t.nextRun).toLocaleString('zh-CN') : '—'
            const scope = t.workspaceId ? `ws=${t.workspaceId.slice(0,8)}` : 'global'
            const triggerDesc = t.trigger.type === 'schedule' ? t.trigger.schedule.type : t.trigger.type
            return `- [${status}] ${t.name} (${triggerDesc}) | ${scope} | 下次: ${next} | ID: ${t.id}`
          }).join('\n')
          return textResult(`共 ${tasks.length} 个任务:\n${summary}`)
        }

        case 'create': {
          if (!p.name) return textResult('错误: 请提供任务名称 (name)')
          if (!p.prompt?.trim()) return textResult('错误: 请提供任务 prompt（触发时发给 Agent 的消息）')
          if (!p.trigger_type) return textResult('错误: 请提供触发类型 (trigger_type)')
          if (p.trigger_type === 'webhook' && !p.webhook_secret?.trim()) {
            return textResult('错误: Webhook 任务必须提供 webhook_secret；无密钥任务不会公开触发')
          }
          const scheduler = getTaskSchedulerControl()

          // 构建 trigger 配置
          let trigger: any
          if (p.trigger_type === 'webhook') {
            trigger = { type: 'webhook', secret: p.webhook_secret!.trim() }
          } else {
            const schedule: any = { type: p.trigger_type }
            if (p.trigger_type === 'fixed') { schedule.time = p.time || '09:00'; if (p.days) schedule.days = p.days }
            else if (p.trigger_type === 'interval') { schedule.intervalMs = (p.interval_minutes || 30) * 60000 }
            else { schedule.cron = p.cron || '0 9 * * *' }
            trigger = { type: 'schedule', schedule }
          }

          const task = createTask({
            name: p.name,
            enabled: true,
            role: roleName,
            // agent_id 是老参数（曾指模板）：模板并入 Pal 后就是 Pal id，一律进 workspaceId
            workspaceId: wsId || (p.agent_id || undefined),
            trigger,
            prompt: p.prompt,
            conversationMode: p.conversation_mode || 'per-run',
            // 溯源标签：标记此 task 由哪个 conversation 创建。
            // per-run 模式下 scheduler 会忽略此字段（见 scheduler.ts:201），所以不会
            // 误触发"复用对话"。仅作为保存为 Agent 时迁移 task 的精确锚点。
            boundConversationId: contextConversationId,
            smartSilence: p.smart_silence  // undefined = 默认启用；false = 强制关闭
          })
          scheduler.schedule(task)  // webhook 类型会被 scheduler 忽略（内部判断 type）

          const scope = task.workspaceId ? `Workspace ${task.workspaceId.slice(0,8)}` : '全局'
          if (p.trigger_type === 'webhook') {
            const url = `http://localhost:3031/webhook/task/${task.id}`
            const curl = `curl -X POST -H 'X-OpenPipal-Secret: ${p.webhook_secret!.trim()}' '${url}'`
            return textResult(`已创建${scope} Webhook 任务「${task.name}」\n\nURL: ${url}\n示例: ${curl}`)
          }
          const next = task.nextRun ? new Date(task.nextRun).toLocaleString('zh-CN') : '即将计算'
          return textResult(`已创建${scope}任务「${task.name}」(ID: ${task.id})，下次执行: ${next}`)
        }

        case 'update': {
          if (!p.task_id) return textResult('错误: 请提供任务 ID (task_id)')
          const existing = getTask(p.task_id)
          if (!existing) return textResult(`错误: 找不到任务 ${p.task_id}`)
          const scheduler = getTaskSchedulerControl()

          const updates: any = {}
          if (p.name) updates.name = p.name
          if (p.prompt) updates.prompt = p.prompt
          if (p.trigger_type) {
            const schedule: any = { type: p.trigger_type }
            if (p.trigger_type === 'fixed') {
              const old: any = existing.trigger.type === 'schedule' ? existing.trigger.schedule : {}
              schedule.time = p.time || old.time || '09:00'
              if (p.days) schedule.days = p.days
            } else if (p.trigger_type === 'interval') {
              schedule.intervalMs = (p.interval_minutes || 30) * 60000
            } else {
              const old: any = existing.trigger.type === 'schedule' ? existing.trigger.schedule : {}
              schedule.cron = p.cron || old.cron || '0 9 * * *'
            }
            updates.trigger = { type: 'schedule', schedule }
          }

          const updated = updateTask(p.task_id, updates)
          if (updated) scheduler.reschedule(p.task_id)
          return textResult(`已更新任务「${updated?.name || existing.name}」`)
        }

        case 'delete': {
          if (!p.task_id) return textResult('错误: 请提供任务 ID (task_id)')
          getTaskSchedulerControl().unschedule(p.task_id)
          const ok = deleteTask(p.task_id)
          return textResult(ok ? `已删除任务 ${p.task_id}` : `找不到任务 ${p.task_id}`)
        }

        case 'toggle': {
          if (!p.task_id) return textResult('错误: 请提供任务 ID (task_id)')
          const enabled = p.enabled ?? true
          const scheduler = getTaskSchedulerControl()
          const toggled = updateTask(p.task_id, { enabled })
          if (toggled) {
            if (enabled) scheduler.schedule(toggled)
            else scheduler.unschedule(p.task_id)
          }
          return textResult(toggled ? `任务「${toggled.name}」已${enabled ? '启用' : '禁用'}` : `找不到任务 ${p.task_id}`)
        }

        default:
          return textResult(`未知操作: ${p.action}`)
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Phase 6d：环境感知 + 内容呈现
// 两个工具都遵循"渐进式披露"——环境信息不注入 system prompt，AI 按需调 get_environment
// ════════════════════════════════════════════════════════════════════════════

/**
 * 运行时目录里可拷的预制件：HTML 里怎么引用就叫什么名（`animations.compiled.js` 对外叫 `animations.js`，
 * 与导出链路 resolveExportSibling 同一套改名）。文件存在即可选——加预制件不用改这里。
 */
export function listStarterComponents(runtimeDir: string): string[] {
  let names: string[] = []
  try { names = fs.readdirSync(runtimeDir) } catch { return [] }
  const kinds = new Set<string>()
  for (const n of names) {
    if (n.endsWith('.compiled.js')) kinds.add(n.replace(/\.compiled\.js$/, '.js'))
    else if (n.endsWith('.js')) kinds.add(n)
  }
  return Array.from(kinds).sort()
}

/** support.js 启动时 window.React 必须在场；本地双击打开没有宿主注入，vendor 得跟着一起落盘 */
const STARTER_VENDOR_FILES = ['vendor/react.production.min.js', 'vendor/react-dom.production.min.js']

/**
 * 对标原版 design agent 的 copy_starter_component：预制件住在项目目录里，模型显式拷进来。
 * 之前只靠宿主渲染时内联，磁盘上从来没有这些文件——模型按前端本能去找 `./support.js`，
 * 找不到就全盘 find（2026-09-11 实撞，两次触发主目录遍历确认）。
 */
export function createCopyStarterComponentTool(options?: { workingDir?: string; runtimeDir?: string }): AgentTool {
  // 无 electron 的测试宿主里 app 是 undefined；运行时目录拿不到就没有可选项，工具照样能构造
  let runtimeDir = options?.runtimeDir || ''
  if (!runtimeDir) { try { runtimeDir = dcRuntimeDir() } catch { runtimeDir = '' } }
  const kinds = listStarterComponents(runtimeDir)
  return {
    name: 'copy_starter_component',
    label: '拷贝预制件',
    description: `把 OpenPipal 自带的 dc 预制件拷进当前工作目录，让 HTML 里的 \`./xxx.js\` 相对引用在磁盘上成立（本地双击、自己截图、交接都能跑）。
可选 kind（文件名原样传）：${kinds.join(', ') || '（运行时目录不可用）'}
- support.js：dc 运行时，会连同 vendor/react*.js 一起拷；本地打开需在它之前加两行 \`<script src="./vendor/react.production.min.js">\` / \`<script src="./vendor/react-dom.production.min.js">\`（App 预览与导出会自行处理）
- 其它预制件（deck-stage.js 等）：support.js 不联网也不读盘，**不会自己去取 x-import 的 from 文件**——本地打开必须在 support.js 之前再加一行 \`<script src="./deck-stage.js"></script>\` 预载，x-import 的 from 照写不删
- 这些文件是冻结的运行时，不必 read；接口看对应技能的 SKILL.md
- 用 create_artifact 交付时不需要调本工具，宿主渲染会内联；写到工作区文件、要本地打开时才需要
- 不要去磁盘上搜这些文件，它们不在工作区里`,
    parameters: Type.Object({
      kind: Type.String({ description: `要拷的预制件文件名，必须是：${kinds.join(' | ')}` }),
      directory: Type.Optional(Type.String({ description: '工作目录下的子目录（如 "deck/"），默认工作目录根' }))
    }),
    execute: async (_id, rawParams: unknown) => {
      const params = (rawParams || {}) as { kind?: string; directory?: string }
      const kind = String(params.kind || '').trim()
      if (!kinds.includes(kind)) {
        return { content: [{ type: 'text', text: `没有 ${kind || '(空)'} 这个预制件。可选：${kinds.join(', ')}` }], details: { ok: false } }
      }
      const workingDir = path.resolve(options?.workingDir || getWorkingDir())
      const destDir = path.resolve(workingDir, params.directory || '.')
      const rel = path.relative(workingDir, destDir)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { content: [{ type: 'text', text: `directory 必须在工作目录 ${workingDir} 之内` }], details: { ok: false } }
      }
      const plain = path.join(runtimeDir, kind)
      const compiled = path.join(runtimeDir, kind.replace(/\.js$/, '.compiled.js'))
      const source = fs.existsSync(plain) ? plain : compiled
      const jobs: Array<[string, string]> = [[source, path.join(destDir, kind)]]
      if (kind === 'support.js') {
        for (const v of STARTER_VENDOR_FILES) jobs.push([path.join(runtimeDir, v), path.join(destDir, v)])
      }
      const written: string[] = []
      const unchanged: string[] = []
      for (const [from, to] of jobs) {
        const data = fs.readFileSync(from)
        if (fs.existsSync(to) && fs.readFileSync(to).equals(data)) { unchanged.push(to); continue }
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.writeFileSync(to, data)
        written.push(to)
      }
      const lines = [
        written.length ? `已拷贝：\n${written.map((p) => `- ${p}`).join('\n')}` : '',
        unchanged.length ? `已存在且内容一致：\n${unchanged.map((p) => `- ${p}`).join('\n')}` : '',
        kind === 'support.js'
          ? `HTML 里 \`<script src="./support.js">\` 之前先放两行 \`<script src="./vendor/react.production.min.js">\`、\`<script src="./vendor/react-dom.production.min.js">\`，本地打开才有 React。`
          : `HTML 里 x-import 按 \`from="./${kind}"\` 引用（路径逐字，导出与 PPTX 门闩都按它认）；support.js 不会自己去取这个文件，本地打开还要在 \`<script src="./support.js">\` 之前加一行 \`<script src="./${kind}"></script>\` 预载（2026-09-11 实测：少这行页面空白无报错）。`
      ].filter(Boolean)
      return { content: [{ type: 'text', text: lines.join('\n') }], details: { ok: true, written, unchanged } }
    }
  }
}

function createGetEnvironmentTool(): AgentTool {
  return {
    name: 'get_environment',
    label: '读取环境',
    description: `查询 OpenPipal 当前运行环境（挂靠模式、前台应用、是否全屏）。
返回 JSON：{ mode: 'orb'|'docked'|'undocked', foregroundApp: string, isFullscreen: boolean }
- mode='orb'：用户在全屏应用（如 ClassIn 黑板）中，OpenPipal 缩为悬浮球，用户**完全看不到**对话 UI。此时纯文本回复会丢失——必须调 present_to_user 或 ask_user 把输出推到屏幕
- mode='docked'：用户在普通应用旁，OpenPipal 为 400px 侧栏，用户**能直接看到**对话
- mode='undocked'：用户把 OpenPipal 拖离，独立窗口模式

宿主会在需要时把环境告诉你：orb 模式下每轮运行时上下文带一行提示，create_artifact / create_visualizer 的结果里也会提示。**不必在做事前先调本工具**；只有用户问起当前环境、或要按前台应用做判断时才调。`,
    parameters: Type.Object({}),
    execute: async () => {
      const snap = getEnvironmentSnapshot()
      return {
        content: [{ type: 'text', text: JSON.stringify(snap) }],
        details: {}
      }
    }
  }
}

function createPresentToUserTool(): AgentTool {
  return {
    name: 'present_to_user',
    label: '呈现到屏幕',
    description: `把最终答案"推送"到用户当前看到的屏幕上——**orb 模式的必备工具**。

**orb 模式下的核心约束**：用户看不到聊天 UI，所以：
- ❌ 纯文本回复等于沉默——用户不会收到
- ❌ 追问/澄清问题（"你是指哪个工具？"）会丢失——用户看不到追问
- ✅ **必须**要么 best-effort 产出内容并调 present_to_user，要么调 ask_user（它有独立 UI 浮层会显示）

**orb 模式的最佳行为模式**：
1. 收到语音请求后，如果请求**大致清楚**（即使 STT 有轻微误识别也能推测意图），直接产出
2. 产出后：短文本用 kind='text' 粘贴到前台应用；可视化/代码/长文用 kind='interactive' 开 Presenter
3. 只有请求**完全无法解析**时，才调 ask_user（有浮层 UI 用户能看到）；**不要**用纯文本输出追问

kind 选择：
- 'text'：短文本结论、公式、一句话回答（≤200 字）→ 粘贴到前台应用（ClassIn 黑板吃 HTML/图 paste）
- 'interactive'：可交互的 HTML/Artifact（函数图、表格、演示）→ 开 OpenPipal Presenter 窗口浮在上层，学生/观众从屏幕共享能看见

示例：
- text: present_to_user({ content: "答案是 x = 5", kind: "text" })
- interactive: present_to_user({ content: "<html>...可交互函数图...</html>", kind: "interactive", title: "f(x)=x²" })

docked 模式下用户能直接看对话，**不要调用**本工具。`,
    parameters: Type.Object({
      content: Type.String({ description: 'text: 文本内容；interactive: 完整 HTML 字符串' }),
      kind: Type.Union([Type.Literal('text'), Type.Literal('interactive')], {
        description: '内容类型，决定呈现方式'
      }),
      title: Type.Optional(Type.String({ description: 'Presenter 窗口标题（仅 interactive 有用）' }))
    }),
    execute: async (_id, params) => {
      const p = params as { content: string; kind: 'text' | 'interactive'; title?: string }
      if (!p.content || !p.content.trim()) {
        return { content: [{ type: 'text', text: 'error: content 为空' }], details: {} }
      }

      if (p.kind === 'text') {
        const { pasteTextToActiveApp } = await import('./paste-adapter')
        const r = await pasteTextToActiveApp(p.content)
        return {
          content: [{
            type: 'text',
            text: r.success
              ? `已粘贴到 ${r.targetApp}`
              : `粘贴失败: ${r.error}`
          }],
          details: {}
        }
      }

      if (p.kind === 'interactive') {
        const { openPresenter } = await import('./presenter-window')
        // 缺省标题交给 Presenter renderer 按当前界面语言显示；显式标题始终原样保留。
        openPresenter(p.content, p.title)
        return { content: [{ type: 'text', text: '已在 Presenter 窗口展示' }], details: {} }
      }

      return { content: [{ type: 'text', text: `error: 未知 kind: ${p.kind}` }], details: {} }
    }
  }
}

/**
 * subagent 工具：把一个子任务委派给 ~/.openpipal/subagents/ 里定义的子 agent 档位。
 *
 * 调用时同进程 new Agent() 启动隔离上下文，主对话历史不传递给子 agent；
 * 子 agent 跑完把 final text + 完整 message history 返回给主 agent。
 *
 * 适用场景（应当用 subagent 的信号）：
 * - 需要"开一个干净的上下文窗口"做信息收集，不想污染主对话历史
 * - 任务可以并行/独立完成，不依赖跟用户实时交互
 * - 需要不同档位的能力或模型（如轻量 explorer 做侦察）
 *
 * 不该用 subagent 的场景：
 * - 任务需要打断用户（subagent 不能用 ask_user / questions_v2）
 * - 任务最终产出物要给用户（subagent 不能用 create_artifact / present_to_user）
 * - 主 agent 自己几句话就能搞定（开 subagent 是成本，不要无脑用）
 *
 * 工具描述里会动态注入当前 ~/.openpipal/subagents/ 里可用的 profile 列表。
 */
function createSubagentTool(overrides?: {
  source?: ChatSource
  workspaceId?: string
  conversationId?: string
  roleName?: string
  workingDir?: string
  modelPresetId?: string
  teamId?: string
  channel?: string
}): AgentTool {
  // 团队话题：同一个工具加一个 `pal` 参数就是"交接给成员"（不新造工具，设计稿 §4）。
  // 可交接的 = 名单里除了自己（跑这条话题的 Lead）以外的人；交接次数按本轮给预算（§8 拐杖，team.md `handoff-budget: off` 关掉）
  const team = overrides?.teamId ? resolveTeamScope(overrides.teamId, overrides.channel) : null
  const handoffTargets = team ? team.members.filter(m => m.id !== overrides?.workspaceId) : []
  const handoffBudget = team ? team.handoffBudget : 'off'
  let handoffsUsed = 0
  // 团队话题里这个工具只做交接（所有者 2026-09-14：团队里的活给成员做，不放通用子 agent）：
  // 没有 profile 参数、pal 必填；要新角色先 manage_team 建成员再交接。规则住在参数 schema 里，说明只是把它讲给模型听
  const description = team
    ? `把活交接给团队「${team.name}」的成员：\`pal\` 填成员 id，它以自己的人设、记忆、技能做完再把结果带回来。\n` +
      `可交接的成员：\n` +
      (handoffTargets.map(m => `- ${m.name}：pal = ${m.id}${m.description ? `（${m.description}）` : ''}`).join('\n') || '- （名单里只有你自己；先用 manage_team 建成员）') +
      `\n交接条写在 task 里：任务 / 依据（文件路径与事实）/ 输出放哪 / 没解决的 / 下一步谁。成员看不到本话题，背景要写全。\n` +
      `本话题里没有通用子 agent：需要一个名单上没有的角色，先用 manage_team 的 create_member 把它建成成员，再交接给它。` +
      (handoffBudget === 'off' ? '' : `本轮最多交接 ${handoffBudget} 次。`)
    : `把一个独立子任务委派给隔离上下文的子 agent 完成。可用档位（从 ~/.openpipal/subagents/ 加载）：\n${describeAvailableProfiles()}\n\n` +
      `调用时机：当主任务需要"开一个干净的上下文窗口"做信息收集 / 评估 / 调研 / 执行隔离子任务时。\n` +
      `子 agent 不能调用 ask_user/questions_v2/create_artifact/create_visualizer/generate_document/present_to_user/subagent —— ` +
      `这些工具的语义是"主 agent 决定"，子 agent 只能把结果汇报回来由主 agent 决定下一步。\n` +
      `子 agent 跑完会返回它的 final text，作为本次工具的结果。`
  return {
    name: 'subagent',
    label: team ? '交接给成员' : '委派子 agent',
    // 注：曾尝试加 executionMode: 'parallel' (per-tool 并发 override)，实测无效——
    // Pi 框架 agent-loop.js:235 逻辑是"global toolExecution='sequential' 一票否决所有
    // per-tool parallel"。要让 subagent 真并发 execute 需要全局改 'parallel' 并给所有
    // 副作用工具加 sequential override，回归风险大，2026-05-19 决策"接受现状"。
    //
    // 独立子任务是否一次发出由通用工具规则和模型判断；Pi 当前仍串行 execute，
    // 但一次返回多个 toolCall block 仍能减少主 agent 的重复决策轮数。
    description,
    parameters: Type.Object({
      ...(team
        ? { pal: Type.String({ description: `要交接的成员的 Pal id（见工具说明里的名单）。` }) }
        : { profile: Type.String({ description: `档位名（必须是上面列出的）。决定子 agent 的工具白名单和默认 system prompt。` }) }),
      task: Type.String({
        description: `委派给子 agent 的任务描述。要具体、范围明确——子 agent 看不到主对话历史，所以任务里要包含完成它需要的全部背景。`,
      }),
      persona: Type.Optional(
        Type.String({
          description: `可选 inline 系统提示，会追加在档位默认 prompt 后。用于本次任务的额外角色细化（如"这次特别关注 React 18 之后的变化"）。不需要就省略。`,
        })
      ),
      model: Type.Optional(
        Type.String({
          description: `可选 model 字符串，必须是用户已经在 OpenPipal Settings 配过的预设（如 'gpt-4o-mini'）。找不到就 fallback 到主 agent 当前模型。多数情况不传，让它继承主模型即可。`,
        })
      ),
    }),
    execute: async (toolCallId, params, signal, onUpdate) => {
      const { profile, pal, task, persona, model } = params as {
        profile?: string
        pal?: string
        task: string
        persona?: string
        model?: string
      }
      const fail = (text: string, errorMessage = text) => ({
        content: [{ type: 'text' as const, text }],
        details: { subagent: { status: 'error', errorMessage, profileName: profile ?? pal } },
        isError: true,
      })

      // 参数 schema 已按有没有团队只留 pal 或 profile 一个；这两条只兜直接调 execute 的路（规则跳过校验时）
      if (team && !pal) {
        return fail('团队话题里 subagent 只做交接：pal 填成员的 id。需要名单上没有的角色，先用 manage_team 的 create_member 把它建成成员，再交接给它。')
      }
      if (pal) {
        // 交接给成员：名单校验 + 本轮预算。拒绝理由要带下一步（可交接的名单 / 先汇总再说）
        if (!team) return fail('本会话不属于任何团队，没有可交接的成员')
        const member = handoffTargets.find(m => m.id === pal)
        if (!member) {
          const list = handoffTargets.map(m => `${m.name}（${m.id}）`).join('、') || '（无）'
          return fail(`「${pal}」不是本团队可交接的成员。可交接：${list}`)
        }
        if (handoffBudget !== 'off' && handoffsUsed >= handoffBudget) {
          return fail(`本轮交接次数已用完（${handoffBudget} 次）。先把已有结果汇总回复，或如实回报卡在哪；下一轮再交接。`)
        }
        handoffsUsed++
        console.log(`[Team] 交接 → ${member.name} (${member.id.slice(0, 8)})，本轮第 ${handoffsUsed} 次${handoffBudget === 'off' ? '' : ` / ${handoffBudget}`}`)
      } else if (!profile) {
        return fail('要填 profile（子 agent 档位）')
      } else {
        // 提前校验 profile 名 —— 给主 agent 一个清晰错误而不是直接抛
        const profiles = listSubagentProfiles()
        if (!profiles.find(p => p.name === profile)) {
          const available = profiles.map(p => p.name).join(', ') || '(none)'
          return fail(`未知 profile: "${profile}"。可用: ${available}`, `Unknown profile: ${profile}`)
        }
      }
      const remaining = pal && handoffBudget !== 'off' ? `\n\n（本轮剩余交接次数：${handoffBudget - handoffsUsed}）` : ''

      // 透传 runner 的 onUpdate 给 Pi 的 onUpdate
      // 当前 pi-event-adapter 忽略 tool_execution_update（P4 会处理）—— 链路就位但 UI 端要 P4 才能看到流式
      const onChildUpdate = onUpdate
        ? (partial: ChildAgentUpdate) => {
            const summary = partial.lastTool
              ? `子 agent 调用 ${partial.lastTool.name}...`
              : partial.status === 'streaming'
                ? '子 agent 思考中...'
                : partial.status === 'complete'
                  ? '子 agent 已完成'
                  : `子 agent 错误: ${partial.errorMessage || '未知'}`
            onUpdate({
              content: [{ type: 'text', text: summary }],
              details: { subagent: partial },
            })
          }
        : undefined

      try {
        const { runChildAgent } = await import('./subagent-runner')
        const result = await runChildAgent({
          profile,
          pal,
          teamId: overrides?.teamId,
          channel: overrides?.channel,
          task,
          persona,
          modelOverride: model,
          signal,
          source: overrides?.source,
          workspaceId: overrides?.workspaceId,
          conversationId: overrides?.conversationId,
          roleName: overrides?.roleName,
          workingDir: overrides?.workingDir,
          modelPresetId: overrides?.modelPresetId,
          onUpdate: onChildUpdate,
        })

        if (pal) console.log(`[Team] 交接完成 ← ${result.profileName}：${result.errorMessage ? `出错 ${result.errorMessage.slice(0, 80)}` : `${result.usage.turns} 轮，${(result.finalText || '').length} 字回报`}`)
        // details.subagent 是给 pi-event-adapter 用的 — adapter 会把这些字段序列化进
        // mcpArgs JSON（cardData），SubagentCard 展开态从 message.toolArgs 反序列化渲染
        // 完整 child history（inline 折叠展示，不进 Workspace 侧栏）
        return {
          content: [{ type: 'text', text: (result.finalText || (pal ? '(成员无输出)' : '(子 agent 无输出)')) + remaining }],
          details: {
            subagent: {
              status: result.errorMessage ? 'error' : 'complete',
              profileName: result.profileName,
              ...(result.palId ? { palId: result.palId } : {}),
              modelId: result.modelId,
              task,
              persona,
              messages: result.messages,
              usage: result.usage,
              stopReason: result.stopReason,
              errorMessage: result.errorMessage,
              finalText: result.finalText,
            },
          },
          isError: !!result.errorMessage,
        }
      } catch (e) {
        const msg = (e as Error).message
        console.error(`[Subagent] 执行失败 ${pal ? `pal=${pal}` : `profile=${profile}`}:`, e)
        return fail(`${pal ? '交接' : 'Subagent'} 执行失败: ${msg}`, msg)
      }
    },
  }
}

/**
 * manage_team：团队自己的事（改名 / 章程 / 名单 / Lead）。只给**在 App 里跟主人聊的 Lead**——
 * 定时 / webhook 话题没有它（章程不能在没人看的时候漂），成员也没有（子代理黑名单）。
 * 这是设计稿 §5 第④层"治理只有人能改"的具体形态：人在场、由 Lead 代笔，写的还是同一份 team.md。
 */
/** create_member 的 look 参数说明：配饰清单 + 像什么角色。清单是常量，只拼一次 */
const LOOK_DESCRIPTION = '新成员头像上的配饰（create_member，可选）：按它的角色挑一个最像的，其余（颜色、轮廓）自动组合。可选：' +
  PAL_ACCESSORIES.map(a => `${a}=${ACCESSORY_HINTS[a]}`).join('；')

/**
 * 跨会话（所有者 2026-09-16）：列 / 读 / 发消息到这台机器上的其他单对话。一个工具三个动作，不拆三个。
 * 逻辑都在 conversation-peer；这里只做参数与文案。内置角色默认有，独立 Pal 要在 tools/config.json 点名（PAL_OPT_IN_TOOLS）。
 */
function createConversationsTool(ctx: { conversationId: string }): AgentTool {
  return {
    name: 'conversations',
    label: '其他对话',
    description:
      '这台机器上的其他对话（不含团队话题）：list 列出，read 读某条的记录，send 把消息发过去——对方会在它自己的对话里回复，' +
      '回复直接带回来；对方正忙就排队送达、稍后用 read 看结果。多线程任务要互通进展、问对方结论时用。',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('list'), Type.Literal('read'), Type.Literal('send')], { description: 'list=列出其他对话；read=读记录；send=发消息' }),
      conversation_id: Type.Optional(Type.String({ description: '目标对话 id（read / send；从 list 拿）' })),
      message: Type.Optional(Type.String({ description: 'send 的内容：说清楚你是哪条对话、要什么、希望对方回什么' })),
      limit: Type.Optional(Type.Number({ description: 'read 读最近几条，默认 30，最多 200' })),
    }),
    execute: async (_id, params, signal) => {
      const p = params as { action: string; conversation_id?: string; message?: string; limit?: number }
      switch (p.action) {
        case 'list':
          return textResult(formatPeerList(listPeerConversations(ctx.conversationId)))
        case 'read': {
          if (!p.conversation_id) return textResult('read 需要 conversation_id')
          const r = await readPeerConversation(p.conversation_id, p.limit)
          return textResult(r.ok ? r.text : r.error)
        }
        case 'send': {
          if (!p.conversation_id || !p.message) return textResult('send 需要 conversation_id 和 message')
          const r = await sendPeerMessage({ fromConversationId: ctx.conversationId, toConversationId: p.conversation_id, text: p.message, signal })
          if (r.status === 'replied') return textResult(`对方回复：\n${r.reply}`)
          if (r.status === 'queued') return textResult('对方正在忙，消息已排在它这一轮之后送达；之后用 read 看它的回复。')
          return textResult(`没发出去：${r.error}`)
        }
        default:
          return textResult(`未知 action: ${p.action}`)
      }
    }
  }
}

function createManageTeamTool(ctx: { teamId: string; leadId: string }): AgentTool {
  const listPals = (): string => {
    const team = readTeam(ctx.teamId)
    const members = new Set(team?.members ?? [])
    const others = listWorkspaces().filter(w => !members.has(w.id))
    return others.length
      ? others.map(w => `- ${w.name}（pal_id: ${w.id}）${w.description ? `：${w.description}` : ''}`).join('\n')
      : '（没有可加入的现成 Pal；需要角色就 create_member）'
  }
  const describeTeam = (): string => {
    const team = readTeam(ctx.teamId)
    if (!team) return '团队不存在'
    const names = team.members.map(id => {
      const w = listWorkspaces().find(x => x.id === id)
      return `${w?.name ?? id.slice(0, 8)}${id === team.lead ? '（Lead）' : ''}（${id}）`
    })
    return `团队「${team.name}」\n成员：${names.join('、')}\n天花板：${team.tier}\n章程：${team.charter ? `\n${team.charter}` : '（空）'}`
  }
  return {
    name: 'manage_team',
    label: '团队',
    description:
      '团队自己的事：起名字、写章程、加成员、建新成员、移出成员、换 Lead。跟主人聊清楚一段就落一段，不用等最后。\n' +
      `主人现有、可以直接加进来的 Pal：\n${listPals()}`,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('show'), Type.Literal('rename'), Type.Literal('set_charter'), Type.Literal('add_member'),
        Type.Literal('create_member'), Type.Literal('remove_member'), Type.Literal('set_lead')
      ], { description: 'show=看当前状态；rename=改团队名；set_charter=整篇写章程（会替换）；add_member=加现成 Pal；create_member=建一个新成员；remove_member=移出；set_lead=换 Lead' }),
      name: Type.Optional(Type.String({ description: '团队名（rename）或新成员的名字（create_member）' })),
      charter: Type.Optional(Type.String({ description: '章程正文（set_charter）：目的 / 名单各管什么 / 怎么干活 / 东西放哪 / 几条坑。200 行以内，成员每次开工都整篇读' })),
      pal_id: Type.Optional(Type.String({ description: 'Pal id（add_member / remove_member / set_lead）' })),
      description: Type.Optional(Type.String({ description: '新成员的一句话介绍（create_member）' })),
      persona: Type.Optional(Type.String({ description: '新成员的人设（create_member）：它做什么、怎么做、不做什么；写成 Markdown' })),
      look: Type.Optional(Type.String({ description: LOOK_DESCRIPTION })),
    }),
    execute: async (_id, params) => {
      const p = params as { action: string; name?: string; charter?: string; pal_id?: string; description?: string; persona?: string; look?: string }
      try {
        switch (p.action) {
          case 'show':
            return textResult(describeTeam())
          case 'rename': {
            if (!p.name?.trim()) return textResult('错误：请给团队名（name）')
            const team = renameTeam(ctx.teamId, p.name)
            return textResult(`团队已改名为「${team.name}」`)
          }
          case 'set_charter': {
            if (p.charter === undefined) return textResult('错误：请给章程正文（charter）')
            updateTeamMd(ctx.teamId, { charter: p.charter })
            return textResult(`章程已写入（${p.charter.trim().split('\n').length} 行）`)
          }
          case 'add_member': {
            if (!p.pal_id?.trim()) return textResult('错误：请给 pal_id')
            const team = addTeamMember(ctx.teamId, p.pal_id.trim())
            return textResult(`已加入。现在的名单：${team.members.length} 人\n${describeTeam()}`)
          }
          case 'create_member': {
            if (!p.name?.trim() || !p.persona?.trim()) return textResult('错误：建成员要给 name 和 persona')
            const { memberId, mark } = createTeamMember(ctx.teamId, { name: p.name, description: p.description, persona: p.persona, look: p.look })
            return textResult(`成员「${p.name.trim()}」已建好并加入名单（pal_id: ${memberId}，头像：${mark.accessory} / ${mark.hue}+${mark.accent} / ${mark.shape}）。交接给它时 subagent 的 pal 填这个 id。`)
          }
          case 'remove_member': {
            if (!p.pal_id?.trim()) return textResult('错误：请给 pal_id')
            const team = removeTeamMember(ctx.teamId, p.pal_id.trim())
            return textResult(`已移出。现在的名单：${team.members.length} 人`)
          }
          case 'set_lead': {
            if (!p.pal_id?.trim()) return textResult('错误：请给 pal_id')
            const team = setTeamLead(ctx.teamId, p.pal_id.trim())
            return textResult(`Lead 已换成 ${team.lead}。注意：这条话题仍由你跑完；新话题起由新 Lead 接。`)
          }
          default:
            return textResult(`未知 action: ${p.action}`)
        }
      } catch (error) {
        return textResult(`失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}

export interface OpenPipalProductToolOptions {
  tools?: string[]
  disabledTools?: string[]
  /** Captured execution role; never re-read the process-global role mid-flight. */
  roleName?: string
  workingDir?: string
  /** Parent turn's conversation-scoped model selection. */
  modelPresetId?: string
  workspaceId?: string
  conversationId?: string
  roleBrief?: Record<string, Record<string, any>>
  executeCodeBackend?: CodeExecutionBackend
  /** 会话级权限档位（编码助手专属）。'readonly' 时写类工具连 schema 都不发给模型。 */
  permissionTier?: PermissionTier
  /** 团队话题：subagent 工具据此开放 `pal` 交接 */
  teamId?: string
  channel?: string
}

export function buildOpenPipalProductTools(
  source: ChatSource,
  askUserResolver: AskUserResolver,
  overrides?: OpenPipalProductToolOptions
): AgentTool[] {
  const tools: AgentTool[] = []
  // Compatibility callers (voice/standalone child agents) may not yet provide
  // roleName. Capture their UI default once while composing the tool graph so
  // later tool execution never observes a different conversation's role.
  const roleName = resolveExecutionRoleName(overrides)
  // 统一身份：产物闸门等专属行为读这个 Agent 档案里的声明，不再按角色名认
  const agentPolicies = resolveExecutionAgent(overrides).policies

  // 浏览器扩展专用
  if (source === 'extension') {
    tools.push(createReadPageContentTool())
  }

  // 桌面专用
  if (source === 'desktop') {
    tools.push(createCaptureScreenshotTool())
    tools.push(createReadScreenTool())
    // Phase 6d：orb 模式环境感知 + 呈现（只对桌面端有意义，extension 不需要）
    tools.push(createGetEnvironmentTool())
    tools.push(createPresentToUserTool())
  }

  // 工具组粘滞判定：conversationId 存在才粘滞（语音桥/子 agent 等无 conversationId 的路径
  // 沿用原行为，每次现算，不参与跨轮前缀缓存）
  const cid = overrides?.conversationId
  const sticky = cid ? toolStickiness.get(cid) : undefined
  // 团队话题里 subagent 是交接原语，没有 profile 也要在
  const includeSubagent = listSubagentProfiles().length > 0 || !!sticky?.subagent || !!overrides?.teamId
  const includeBrowser = isBrowserControlAvailable() || !!sticky?.browser
  if (cid) {
    // includeSubagent/includeBrowser 已经是"曾经true || 现在true"，直接写回即单调只进不出
    capInsert(toolStickiness, cid, { browser: includeBrowser, subagent: includeSubagent }, TOOL_STICKY_CAP)
  }

  // 通用工具
  tools.push(
    createWebSearchTool(),
    createAskUserTool(askUserResolver),
    createQuestionsV2Tool(),
    // 定规则：只递交要求，文件由后台 Evolver 写（hooks/set-rule-tool）
    createSetRuleTool({ conversationId: overrides?.conversationId, roleName, workspaceId: overrides?.workspaceId }),
    createGenerateDocumentTool(overrides?.workspaceId, overrides?.conversationId),
    createVisualizerTool(),
    createArtifactTool(overrides?.conversationId, roleName, overrides?.roleBrief, agentPolicies),
    createReadArtifactTool(overrides?.conversationId),
    createEditArtifactTool(overrides?.conversationId),
    createRenderArtifactTool(overrides?.conversationId, overrides?.workingDir),
    createExportArtifactTool(overrides?.conversationId),
    // 预制件拷进项目目录（对标原版 copy_starter_component）——磁盘上有文件，模型就不会全盘去找
    createCopyStarterComponentTool({ workingDir: overrides?.workingDir }),
    createUpdateTodosTool(overrides?.conversationId),
    createExecuteCodeTool(overrides?.workingDir, overrides?.executeCodeBackend),
    createManageTaskTool(overrides?.workspaceId, overrides?.conversationId, roleName),
    // 跨会话：有会话身份才有（语音桥 / 无 conversationId 的路径拿不到）；Pal 是否拿到由档案白名单决定（filterOpenPipalTools）
    ...(overrides?.conversationId ? [createConversationsTool({ conversationId: overrides.conversationId })] : []),
    // 团队自己的事：只给在 App 里跟主人聊的 Lead（scheduler 面没有；成员在子代理黑名单里拿不到）
    ...(overrides?.teamId && source === 'desktop' && overrides.workspaceId && overrides.workspaceId === resolveTeamScope(overrides.teamId, overrides.channel)?.lead
      ? [createManageTeamTool({ teamId: overrides.teamId, leadId: overrides.workspaceId })]
      : []),
    // subagent 委派工具 —— 本会话内曾经有 profile 就粘滞保留（opt-in 文件约定 + 前缀缓存粘滞）
    ...(includeSubagent
      ? [createSubagentTool({
          source,
          workspaceId: overrides?.workspaceId,
          conversationId: overrides?.conversationId,
          roleName,
          workingDir: overrides?.workingDir,
          modelPresetId: overrides?.modelPresetId,
          teamId: overrides?.teamId,
          channel: overrides?.channel
        })]
      : []),
    // 浏览器控制工具 —— 本会话内曾经连接过扩展就粘滞保留（断连后调用由工具自身报错兜底）
    ...(includeBrowser ? createBrowserControlTools() : [])
  )

  return tools
}

/** Apply the product-owned disabled/allow-list/role policy after composition. */
export function filterOpenPipalTools<TTool extends { name: string }>(
  tools: TTool[],
  overrides?: Pick<OpenPipalProductToolOptions, 'tools' | 'disabledTools' | 'roleName' | 'conversationId' | 'permissionTier'>
): TTool[] {
  const disabled = new Set(overrides?.disabledTools || [])
  let withoutDisabled = tools.filter((t) => !disabled.has(t.name))

  // 只读档：写类工具根本不发给模型。**在 schema 这一层收窄而不是只在执行时拒**——
  // 拿得到工具却每次被拒，模型会反复重试、换着法子绕（改用 bash 写文件之类），
  // 既浪费轮次又把上下文塞满。看不见就不会去想（pi-security 那道拦截留作纵深防御）。
  if (overrides?.permissionTier === 'readonly') {
    withoutDisabled = withoutDisabled.filter((t) => READONLY_TIER_TOOLS.includes(t.name))
  }

  // 按模板自带的白名单，或这个 Agent 档案里的白名单过滤（档案永远存在，不再回落到全局当前角色）
  const allowed = new Set(overrides?.tools ?? resolveExecutionAgent(overrides).tools)
  return withoutDisabled.filter(t => allowed.has(t.name))
}
