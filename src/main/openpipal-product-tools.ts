/**
 * OpenPipal product tools.
 *
 * This module intentionally contains no legacy CLI coding-tool imports. Runtime
 * adapters compose these product tools with their own public execution tools.
 */

import { Type } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { resolveExecutionRoleName } from './agent-overrides'
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
import { isToolAllowed, getRoleConfig, getDsReview } from './role-manager'
import { READONLY_TIER_TOOLS, type PermissionTier } from './pi-security'
import {
  listConversationArtifacts,
  compileJsxArtifact, findSimilarArtifact, coarseTypeFromFile, normalizeArtifactLanguage
} from './artifact-store'
import { getArtifactStore, evaluateArtifactWriteGuard, buildExternalEditEvidence } from './artifact-registry'
import { containsReceiptPlaceholder } from './tool-content-compactor'
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
import { capInsert, computeStickyInclude } from './prompt-cache-fifo'
import { normalizeQuestionsPanelTitle, normalizeQuestionsV2Items } from './pi-event-adapter'
import { exportArtifactPdf, exportStandaloneHtml, exportZip, exportDcBundle } from './dc-export'
import { exportArtifactMp4 } from './dc-video-export'
import { exportArtifactPptx } from './dc-pptx-export'
import { exportArtifactHandoff } from './dc-handoff-export'
import { mp4FormatGateMessage, pptxFormatGateMessage, handoffFormatGateMessage, projectZipFormatGateMessage, formatMp4ValidationText, formatPptxValidationText, formatHandoffValidationText, formatFileValidationText, type Mp4ProbeData } from './export-artifact-validate'
import { sliceArtifactContent, formatArtifactReadHeader, formatArtifactTruncationNote, formatArtifactOffsetOutOfRangeNote } from './read-artifact-slice'
import type { ChatSource } from './agent-runtime/contracts'
import { dataPath } from './data-root'
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
      // 回执门闩：new_string 不得是压缩回执占位（old_string 允许——修复受损产物要靠它匹配）
      if (containsReceiptPlaceholder(p.new_string)) {
        return { content: [{ type: 'text', text: `已拒绝：new_string 里包含"[内容已保存…]"占位回执——那是上下文压缩标记不是正文。请先 read_artifact(id) 取回真实内容再编辑。` }], details: {} }
      }
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

function createRenderArtifactTool(conversationId?: string): AgentTool {
  return {
    name: 'render_artifact',
    label: '自检',
    description: `把已有 artifact（或一个本地 HTML 文件）在隐藏窗口里真实渲染一遍，回传 console 错误/警告（含 dc 运行时的"逻辑类语法错误"与"空穴 never resolved"）。

两种用法（二选一）：
- id：自检会话里的 artifact
- path：自检磁盘上的 HTML 文件（设计系统的 specimen 预览卡 / ui_kit index.html 用这个——file:// 加载，相对引用的 styles.css / assets 全部生效）

**交付前必自检**：create_artifact / 一轮 edit_artifact / 写完预览卡后调用一次，有报错就修完再交——用户看到坏稿等于白交。返回"渲染干净"才算完。`,
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: '要自检的 artifact id 或标题（与 path 二选一；标题按本会话解析）' })),
      path: Type.Optional(Type.String({ description: '要自检的本地 HTML 文件绝对路径（限 ~/.openpipal 工作区内）' }))
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
        const allowedRoots = [
          dataPath('workspace'),
          dataPath('outputs'),
          dataPath('design-systems'),
          dataPath('conversations', 'artifacts')
        ]
        if (!allowedRoots.some((r) => resolved.startsWith(r + path.sep) || resolved === r)) {
          return { content: [{ type: 'text', text: `path 必须在 ~/.openpipal 的 workspace / outputs / conversations/artifacts 下。` }], details: {} }
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
        show: false, width: 1280, height: 900,
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
        const img = await win.webContents.capturePage()
        const baseBuf = img.toPNG()
        capturedBuf = baseBuf
        const shotDir = dataPath('outputs', '.self-check')
        fs.mkdirSync(shotDir, { recursive: true })
        shotPath = path.join(shotDir, `${shotName}.png`)
        fs.writeFileSync(shotPath, baseBuf)
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
      let imageBlock: { type: 'image'; data: string; mimeType: string } | null = null
      let imageNote = ''
      if (capturedBuf) {
        if (supportsImages) {
          // 发送用缩小的 JPEG（盘上仍存全尺寸 PNG 供人工/导出查看）；缩图失败退回原图，仍受上限保护
          let sendBuf = capturedBuf
          let sendMime = 'image/png'
          try {
            let img = nativeImage.createFromBuffer(capturedBuf)
            if (img.getSize().width > 1024) img = img.resize({ width: 1024 })
            const jpeg: Buffer = img.toJPEG(75)
            if (jpeg.length > 0 && jpeg.length < sendBuf.length) {
              sendBuf = jpeg
              sendMime = 'image/jpeg'
            }
          } catch { /* nativeImage 不可用（如单测环境）→ 原图走上限兜底 */ }
          const b64 = sendBuf.toString('base64')
          if (b64.length > MAX_IMAGE_B64) {
            imageNote = '\n（截图过大已跳过随结果发送，仅存盘供人工查看；核对以下文本摘要为准）'
          } else {
            imageBlock = { type: 'image', data: b64, mimeType: sendMime }
          }
        } else {
          imageNote = '\n（当前模型不支持看图，未随结果发送截图——以下文本摘要即为核对依据）'
        }
      }
      const shotNote = shotPath ? `\n截图已存盘: ${shotPath}（供人工/导出查看）。${imageNote}` : ''
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
      if (imageBlock) content.push(imageBlock)
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
    description: `把已有 artifact 导出成可交付的文件，落 ~/.openpipal/outputs/（用户可在“作品”中回看，不用另外找路径）。

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
      const outRoot = dataPath('outputs')

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
      const bundle = exportDcBundle(title, [{ title, content, artifactId }])
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
  roleBrief?: Record<string, Record<string, any>>
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
      // 回执门闩（机制优于纪律，2026-07-15 实案）：模型把上下文里的压缩回执当正文复制，
      // 把 11KB 场景覆写成 73 字节占位。拦死并给证据式指路。
      if (containsReceiptPlaceholder(p.content)) {
        return { content: [{ type: 'text', text: `已拒绝：content 里包含"[内容已保存…]"占位回执——那不是正文，是上下文压缩标记。请先 read_artifact(id) 取回真实内容，修改后再提交；若要全新创作请直接写完整内容。` }], details: {} }
      }
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
      // dc 门闩（机制优于纪律）：design / teacher 角色的整页 HTML 交付必须是 Design Component。
      // 实测模型跳过读 dc-authoring 技能时会退回普通 HTML（首轮 2/5 合规），工具级拒绝把纪律变成机制。
      if (['design', 'teacher'].includes(roleName) && p.type === 'html') {
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
          return reject('整页 HTML 交付物必须是 Design Component（.dc.html）格式。先 read 技能索引里 dc-authoring 的 SKILL.md，按其文件骨架重写内容后用相同参数重新调用 create_artifact。若确属纯 canvas/WebGL 例外，在文件首行加 <!-- non-dc: 原因 --> 后重试。')
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
      if (roleName === 'design' && p.type === 'code') {
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
        content: [{ type: 'text', text: `${verb}预览: ${p.title} (id: ${artifactId})${orbHint}${compileNote}` }],
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

function createGenerateDocumentTool(workspaceId?: string): AgentTool {
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
      if (containsReceiptPlaceholder(p.content)) {
        return textResult(`已拒绝：content 里包含"[内容已保存…]"占位回执——那是上下文压缩标记不是正文，请写入真实文档内容。`, { displayResult: '已拒绝：占位回执不能作为文档内容' })
      }
      const content = p.content || ''
      const filepath = saveOutput(title, content, workspaceId)
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
            const scope = t.workspaceId ? `ws=${t.workspaceId.slice(0,8)}`
                        : t.agentId ? `agent=${t.agentId.slice(0,8)}`
                        : 'global'
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
            workspaceId: wsId,
            agentId: wsId ? undefined : p.agent_id,
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

function createGetEnvironmentTool(): AgentTool {
  return {
    name: 'get_environment',
    label: '读取环境',
    description: `查询 OpenPipal 当前运行环境（挂靠模式、前台应用、是否全屏）。
返回 JSON：{ mode: 'orb'|'docked'|'undocked', foregroundApp: string, isFullscreen: boolean }
- mode='orb'：用户在全屏应用（如 ClassIn 黑板）中，OpenPipal 缩为悬浮球，用户**完全看不到**对话 UI。此时纯文本回复会丢失——必须调 present_to_user 或 ask_user 把输出推到屏幕
- mode='docked'：用户在普通应用旁，OpenPipal 为 400px 侧栏，用户**能直接看到**对话
- mode='undocked'：用户把 OpenPipal 拖离，独立窗口模式

**重要调用时机**：当用户的请求**可能产出可视化内容、追问、或非对话式结果**（画图、写代码、生成文档等）时，先调本工具确认环境。docked 模式从上下文可明显推断时可跳过。`,
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
}): AgentTool {
  const available = describeAvailableProfiles()
  return {
    name: 'subagent',
    label: '委派子 agent',
    // 注：曾尝试加 executionMode: 'parallel' (per-tool 并发 override)，实测无效——
    // Pi 框架 agent-loop.js:235 逻辑是"global toolExecution='sequential' 一票否决所有
    // per-tool parallel"。要让 subagent 真并发 execute 需要全局改 'parallel' 并给所有
    // 副作用工具加 sequential override，回归风险大，2026-05-19 决策"接受现状"。
    //
    // 独立子任务是否一次发出由通用工具规则和模型判断；Pi 当前仍串行 execute，
    // 但一次返回多个 toolCall block 仍能减少主 agent 的重复决策轮数。
    description:
      `把一个独立子任务委派给隔离上下文的子 agent 完成。可用档位（从 ~/.openpipal/subagents/ 加载）：\n${available}\n\n` +
      `调用时机：当主任务需要"开一个干净的上下文窗口"做信息收集 / 评估 / 调研 / 执行隔离子任务时。\n` +
      `子 agent 不能调用 ask_user/questions_v2/create_artifact/create_visualizer/generate_document/present_to_user/subagent —— ` +
      `这些工具的语义是"主 agent 决定"，子 agent 只能把结果汇报回来由主 agent 决定下一步。\n` +
      `子 agent 跑完会返回它的 final text，作为本次工具的结果。`,
    parameters: Type.Object({
      profile: Type.String({
        description: `档位名（必须是上面列出的）。决定子 agent 的工具白名单和默认 system prompt。`,
      }),
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
      const { profile, task, persona, model } = params as {
        profile: string
        task: string
        persona?: string
        model?: string
      }

      // 提前校验 profile 名 —— 给主 agent 一个清晰错误而不是直接抛
      const profiles = listSubagentProfiles()
      if (!profiles.find(p => p.name === profile)) {
        const available = profiles.map(p => p.name).join(', ') || '(none)'
        return {
          content: [{ type: 'text', text: `未知 profile: "${profile}"。可用: ${available}` }],
          details: { subagent: { status: 'error', errorMessage: `Unknown profile: ${profile}` } },
          isError: true,
        }
      }

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

        // details.subagent 是给 pi-event-adapter 用的 — adapter 会把这些字段序列化进
        // mcpArgs JSON（cardData），SubagentCard 展开态从 message.toolArgs 反序列化渲染
        // 完整 child history（inline 折叠展示，不进 Workspace 侧栏）
        return {
          content: [{ type: 'text', text: result.finalText || '(子 agent 无输出)' }],
          details: {
            subagent: {
              status: result.errorMessage ? 'error' : 'complete',
              profileName: result.profileName,
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
        console.error(`[Subagent] 执行失败 profile=${profile}:`, e)
        return {
          content: [{ type: 'text', text: `Subagent 执行失败: ${msg}` }],
          details: { subagent: { status: 'error', errorMessage: msg, profileName: profile } },
          isError: true,
        }
      }
    },
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
  const includeSubagent = listSubagentProfiles().length > 0 || !!sticky?.subagent
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
    createGenerateDocumentTool(overrides?.workspaceId),
    createVisualizerTool(),
    createArtifactTool(overrides?.conversationId, roleName, overrides?.roleBrief),
    createReadArtifactTool(overrides?.conversationId),
    createEditArtifactTool(overrides?.conversationId),
    createRenderArtifactTool(overrides?.conversationId),
    createExportArtifactTool(overrides?.conversationId),
    createUpdateTodosTool(overrides?.conversationId),
    createExecuteCodeTool(overrides?.workingDir, overrides?.executeCodeBackend),
    createManageTaskTool(overrides?.workspaceId, overrides?.conversationId, roleName),
    // subagent 委派工具 —— 本会话内曾经有 profile 就粘滞保留（opt-in 文件约定 + 前缀缓存粘滞）
    ...(includeSubagent
      ? [createSubagentTool({
          source,
          workspaceId: overrides?.workspaceId,
          conversationId: overrides?.conversationId,
          roleName,
          workingDir: overrides?.workingDir,
          modelPresetId: overrides?.modelPresetId
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

  // 按 Agent 模板工具白名单或当前角色的白名单过滤
  if (overrides?.tools) {
    const allowed = new Set(overrides.tools)
    return withoutDisabled.filter(t => allowed.has(t.name))
  }
  const capturedRole = getRoleConfig(resolveExecutionRoleName(overrides))
  if (capturedRole) return withoutDisabled.filter(t => capturedRole.tools.includes(t.name))
  // Compatibility fallback is evaluated during synchronous composition, never
  // later from inside a running tool.
  return withoutDisabled.filter(t => isToolAllowed(t.name, false))
}
