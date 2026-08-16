import { ipcMain, BrowserWindow, dialog, shell, clipboard, app } from 'electron'
import { writeFileSync, readFileSync, copyFileSync, mkdirSync, statSync } from 'fs'
import type { FSWatcher } from 'fs'
import os, { homedir } from 'os'
import path, { basename, join } from 'path'
import { checkScreenCapturePermission } from './screenshot'
import { persistChatImages, readUploadAsset, writeArtifactSidecar, readArtifactSidecar } from './chat-uploads'
import { getAgentRuntime, setAgentRuntimePermissionHandler } from './agent-runtime'
import type { ChatMessage, RunningAgentHandle } from './agent-runtime/contracts'
import {
  listConversations, createConversation, getConversation, getConversationMessages, getConversationMessagesSerialized,
  appendMessages, deleteConversation, updateConversationTitle, updateConversationRole, replaceMessages,
  updateConversationConfig, setTitleUpdateCallback, StoredMessage
} from './conversation-store'
import type { ConversationConfig } from './conversation-store'
import { saveConversationAttachment, loadConversationAttachment, type AttachmentKind } from './attachment-store'
import type { ConversationGoal } from './goal-checker'
import {
  getEffectiveModelConfig, saveModelConfig, getProviders, testConnection, hasApiKey, isUserCustomConfig, clearModelConfig, supportsEffortDial,
  ModelConfig, getWorkingDir, setWorkingDir,
  getAvailableModels, listModelPresets, saveModelPreset, deleteModelPreset, switchToPreset,
  listModelProviders, updateModelProvider, getModelProviderFull,
  getModelPresetFull, updateModelPreset,
  getOnboardingCompleted, setOnboardingCompleted,
  getExportDir, setExportDir, getEffectiveModelConfigForDisplay,
  getEffectiveSearchConfigForDisplay, saveSearchConfig, clearSearchConfig, type SearchConfig
} from './config-manager'
import { testSearchConnection } from './web-search'
import {
  setRealtimeWindowRef, getRealtimeConfig, startRealtimeSession, stopRealtimeSession, sendRealtimeEvent,
  testRealtimeConnection, previewVoice, stopVoicePreview
} from './realtime-session'
import { saveVoiceAudio, readVoiceAudio } from './voice-audio'
import { getEffectiveVoiceConfig, saveVoiceConfig, getDoubaoVoiceConfig, setInterpretTargetLanguage } from './config-manager'
import type { VoiceConfig } from './config-manager'
import { listSkillsMeta, setSkillDisabled, getSkillDetails, reloadSkills } from './skill-manager'
import { importScan, importApply, deleteUserSkill, type ImportSource, type ImportApplyPayload } from './skill-import'
import { listPlugins } from './plugin-manager'
import { installPlugin, uninstallPlugin, togglePlugin, type PluginInstallSource } from './plugin-import'
import { getMcpServerStatus, addMcpServer, removeMcpServer, testMcpConnection, authorizeMcpServer, revokeMcpServerAuth, isMcpServerBindingVisible } from './mcp-manager'
import { callMcpToolFromApp } from './mcp-app-tool-call'
import { getMcpAppPermissions, approveMcpAppPermissions, sanitizeCapabilities } from './mcp-app-permissions'
import { getAvailableClis, addUserCliTool, removeUserCliTool, refreshClis, isAvailable } from './cli-registry'
import { parseFile } from './file-parser'
import { completeInArtifact } from './simple-completion'
import {
  resolvePermissionRequest,
  approveToolForSession,
  clearSessionApprovals,
  pendingPermissionResolvers,
  setPermissionRequestSettlementHandler
} from './pi-security'
import type { PermissionHandler, PermissionRequest, SessionApprovalScope } from './pi-security'
import { isBrowserWriteTool, targetHostForCommand, grantSessionHost } from './browser-policy-store'
import { writePermissionToStream } from './http-server'
import { listAgentTemplates, getAgentTemplate, createAgentTemplate, updateAgentTemplate, deleteAgentTemplate } from './agent-template-manager'
import { resolveAgentOverrides, resolveExecutionRoleName } from './agent-overrides'
import { listWorkspaces, getWorkspace, getWorkspaceDir, createWorkspace, deleteWorkspace, getAgentOutputsDir } from './agent-workspace-store'
import {
  listTasks, getTask, createTask, updateTask, deleteTask
} from './task-store'
import { selectEvolverTaskCandidates } from './evolver-task-migration'
import { scheduleTask, unscheduleTask, rescheduleTask, executeTask } from './scheduler'
import { executeExtraction } from './memory-extractor'
import { executeAgentDreaming } from './agent-dreamer'
import { executeAutoDream, forceAutoDream } from './memory-dreamer'
import { isAutoMemoryEnabled, setAutoMemoryEnabled } from './config-manager'
import { getCurrentRole, getRoleConfig, getRoleAssetsDir, listRoleAssets, listRoleSystemFolders, listRoleSystemTree, listDesignSystems, getDesignSystemManifest, readRoleManifest, getDsReview, saveDsReview, DsReview } from './role-manager'
import { getDesignSystemResourceCapability, readDesignSystemJsonResource, readDesignSystemResource } from './design-system-resource'
import { scanMemoryFiles, readMemoryFile, deleteMemoryFile, getGlobalMemoryDir, getMemoryRoot, listArchivedMemories, restoreArchivedMemory, isWithinMemoryRoot } from './memory-store'
import { saveArtifact as saveArtifactToDisk, loadArtifact as loadArtifactFromDisk, deleteArtifactsForConversation, listArtifactHistory, loadCompiledArtifact, findArtifactFileById, coarseTypeFromFile, EPHEMERAL_ARTIFACT_TYPES, listConversationArtifacts, evictThumbCache } from './artifact-store'
import { getArtifactStore } from './artifact-registry'
import { exportDcBundle, exportArtifactPdf, exportZip, exportStandaloneHtml } from './dc-export'
import { exportArtifactMp4 } from './dc-video-export'
import { exportArtifactPptx } from './dc-pptx-export'
import { exportArtifactHandoff } from './dc-handoff-export'
import { saveOutput, listOutputHistory } from './memory-manager'
import { listSources, getSource, addSource, removeSource, updateSourceStatus } from './sources-manager'
import type { AddSourceParams, SourceStatus, SourceStatusPatch } from './sources-manager'
import { resolve } from 'path'
import {
  acquireConversationExecution,
  getConversationExecution,
  isCurrentConversationExecution,
  type ConversationExecutionLease
} from './conversation-execution-coordinator'
import {
  acknowledgeTranscriptPersistence,
  awaitTranscriptPersistence,
  markTranscriptPersistenceRendererReady,
  markTranscriptPersistenceRendererUnavailable,
  type TranscriptPersistenceAck
} from './desktop-transcript-persistence'
import { getLocaleState, updateLocalePreference } from './locale-manager'
import { mainError, tMain } from './main-i18n'
import { dataPath, getDataRoot } from './data-root'

// Agent Runtime 全栈懒加载：router 保留 legacy 的按需加载和失败重试语义。
const agentService = getAgentRuntime

let registered = false
// 每会话一个运行槽（per-conversation）——取代旧的单一全局 currentAbort/currentAgent/currentAgentCid。
// 旧模型"单激活会话"：新 chat:send 无条件 abort 上一个 → 在 B 会话发消息会杀掉 A 的活/后台流（真·中断源）。
// key = cid（|| '' 保留无 cid 时的单槽兜底语义）。agent 句柄供 chat:steer/chat:queue 注入（现可作用于任意后台会话）。
interface RunSlot { abort: AbortController; agent: RunningAgentHandle | null }
const runs = new Map<string, RunSlot>()
// 记录权限请求 ID → {工具名, 会话}（用于会话级审批）
// cid 必须一起记：approveToolForSession 没有 cid 就直接丢弃授权——历史 bug 就是这里只存了工具名，
// 导致"本次会话允许此类操作"对非浏览器工具从来没生效过（2026-07-29 修）
const pendingPermissionTools = new Map<string, {
  tool: string
  args: Record<string, any>
  approvalScope?: SessionApprovalScope
  conversationId?: string
  executionId?: string
}>()
// 浏览器写命令的权限请求 ID → {对话, 目标 host}（"本次会话允许"时按站点授权,而非按工具）
const pendingBrowserGrant = new Map<string, {
  conversationId?: string
  executionId?: string
  host: string
}>()

// 工作区文件面板 fs.watch 推送——取代 FilesSection/FilesPanel 原来的定时轮询。
// key = dirKey（'outputs:<workspaceId>' / 'tree:<workspaceId>'，workspaceId 空串=全局），模块级幂等管理。
interface WorkspaceWatchEntry { watchers: FSWatcher[]; timer: ReturnType<typeof setTimeout> | null }
const workspaceWatchers = new Map<string, WorkspaceWatchEntry>()

/**
 * 从 dirKey 解析出实际要 watch 的绝对目录，与 workspace:list-outputs / workspace:get-agent-tree
 * 的目录计算逻辑保持一致（workspaceId 为空串 = 全局）。dirKey 格式非法/未知 kind 时返回 null。
 */
function resolveWatchDirs(dirKey: string): string[] {
  const path = require('path') as typeof import('path')
  const os = require('os') as typeof import('os')
  const sep = dirKey.indexOf(':')
  if (sep < 0) return []
  const kind = dirKey.slice(0, sep)
  const workspaceId = dirKey.slice(sep + 1)
  if (kind === 'outputs') {
    return [workspaceId ? getAgentOutputsDir(workspaceId) : dataPath('outputs')]
  }
  if (kind === 'tree') {
    // get-agent-tree 会把 workspace/assets 作为顶层虚拟节点合并进树——watch 覆盖范围须与渲染内容一致
    const assets = dataPath('workspace', 'assets')
    return workspaceId
      ? [dataPath('agents', workspaceId), assets]
      : [dataPath('memory'), assets]
  }
  return []
}

/**
 * 记忆抽取该不该跳过——按**会话归属的角色**判断（而非全局 currentRole，可能已被语音/HTTP 切走）。
 * 取会话记录的 role 优先，取不到（如无 conversationId）才退回全局 currentRole。
 */
function shouldSkipMemoryExtraction(
  conversationId: string | null | undefined,
  capturedRoleName?: string
): boolean {
  // A running turn owns the role snapshot captured when its lease started.
  // UI edits made while it is running apply to the next turn; mixing the new
  // policy flag with the old turn's extraction target would cross role bounds.
  const roleName = capturedRoleName || (conversationId ? getConversation(conversationId)?.role : undefined) || getCurrentRole().name
  const roleCfg = getRoleConfig(roleName)
  if (roleCfg?.memoryEnabled === false) {
    console.log(`[Memory] 角色 ${roleName} 已关闭记忆抽取（memory: off），跳过本次 executeExtraction`)
    return true
  }
  return false
}

export function registerIpcHandlers(getWindow: () => BrowserWindow | null): void {
  if (registered) return
  registered = true

  // Permission promises live in the Runtime-neutral security layer while
  // transport ownership metadata lives here. Observe every terminal path
  // (response, abort, timeout, send failure) so abandoned UI metadata cannot
  // accumulate or be mistaken for a later execution of the same conversation.
  setPermissionRequestSettlementHandler(({ requestId }) => {
    pendingPermissionTools.delete(requestId)
    pendingBrowserGrant.delete(requestId)
  })

  // 注入桌面权限处理器（dialog 弹窗）。Runtime Host 会在惰性加载前暂存，
  // 并在选中的 Runtime 可用后统一装配。
  setAgentRuntimePermissionHandler(createDesktopPermissionHandler(getWindow))

  // 界面语言由 Main 持有唯一事实源：renderer 只消费解析后的状态。
  // 广播/原生菜单刷新由 locale-manager 的统一订阅者负责，避免多个入口各自补副作用。
  ipcMain.handle('locale:get-state', () => getLocaleState())
  ipcMain.handle('locale:set-preference', (_event, preference: unknown) =>
    updateLocalePreference(preference))

  // Renderer transcript persistence barrier protocol. Readiness keeps older
  // renderers and lightweight Electron mocks compatible; acknowledgements are
  // additionally bound to the exact webContents + executionId in the helper.
  ipcMain.on('chat:transcript-persistence-ready', (event) => {
    markTranscriptPersistenceRendererReady(event.sender)
  })
  ipcMain.on('chat:transcript-persistence-unready', (event) => {
    markTranscriptPersistenceRendererUnavailable(event.sender)
  })
  ipcMain.on('chat:transcript-persistence-ack', (event, ack: TranscriptPersistenceAck) => {
    acknowledgeTranscriptPersistence(event.sender, ack)
  })

  // 注册 AI 标题更新回调 → 通知前端刷新对话列表
  setTitleUpdateCallback((id, title) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('conv:title-updated', id, title)
    }
  })

  ipcMain.handle('screenshot:check-permission', async () => {
    return await checkScreenCapturePermission()
  })

  // 截取本窗口页面指定区域（画布圈画评论用——capturePage 拍的是渲染页面自身，含 iframe 内容与
  // 笔迹，不经系统屏幕录制权限，与 capture_screenshot 的"外部应用窗口截图"是两条路）
  ipcMain.handle('window:capture-region', async (_event, rect: { x: number; y: number; width: number; height: number }) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return null
    const r = {
      x: Math.max(0, Math.round(rect?.x ?? 0)),
      y: Math.max(0, Math.round(rect?.y ?? 0)),
      width: Math.round(rect?.width ?? 0),
      height: Math.round(rect?.height ?? 0)
    }
    if (r.width < 4 || r.height < 4) return null
    try {
      const img = await win.webContents.capturePage(r)
      return { base64: img.toJPEG(85).toString('base64') }
    } catch (err: any) {
      console.warn('[IPC] window:capture-region 失败:', err?.message)
      return null
    }
  })

  // ── 冷启动引导(OnboardingOverlay) ──────────────────────────────
  ipcMain.handle('onboarding:status', () => ({ completed: getOnboardingCompleted() }))
  ipcMain.handle('onboarding:complete', () => {
    setOnboardingCompleted(true)
    return { ok: true }
  })
  // 打开 macOS 系统设置的"屏幕录制"权限面板,引导用户授权
  ipcMain.handle('system:open-screen-recording-prefs', async () => {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    return { ok: true }
  })

  // 粘贴到挂靠的前台应用 — 委托给 paste-adapter（Phase 6a 抽取后的通用实现）
  ipcMain.handle('paste-to-target', async (_event, text: string) => {
    const { pasteTextToActiveApp } = await import('./paste-adapter')
    return pasteTextToActiveApp(text)
  })

  // 取消指定会话（cid 缺省 → '' 槽，兼容旧单槽语义）
  ipcMain.on('chat:abort', (_event, conversationId?: string) => {
    const cid = conversationId || ''
    const slot = runs.get(cid)
    if (slot) {
      slot.abort.abort()
      runs.delete(cid)
    }
  })

  // ── 消息插队（mid-loop injection）─────────────────────────────────
  // chat:steer — 立即软打断，下一轮 LLM call 前注入消息（Pi agent.steer()）
  // chat:queue — 跟单，等 agent 自然停止前注入（Pi agent.followUp()）
  // 返回 { ok: boolean }，ok=false 表示当前没有运行中 agent 或 conversationId 不匹配
  //   → renderer 应降级为普通 chat:send（开启新一轮 turn）
  ipcMain.handle('chat:steer', async (_event, conversationId: string, text: string, images?: string[]) => {
      const agent = runs.get(conversationId || '')?.agent
      if (!agent) return { ok: false }
      try {
        await agent.steer({ text, images })
        return { ok: true }
    } catch (err: any) {
      console.error('[chat:steer] failed:', err.message)
      return { ok: false }
    }
  })
  ipcMain.handle('chat:queue', async (_event, conversationId: string, text: string, images?: string[]) => {
      const agent = runs.get(conversationId || '')?.agent
      if (!agent) return { ok: false }
      try {
        await agent.followUp({ text, images })
        return { ok: true }
    } catch (err: any) {
      console.error('[chat:queue] failed:', err.message)
      return { ok: false }
    }
  })

  ipcMain.on('chat:send', async (_event, messages: ChatMessage[], agentId?: string, conversationConfig?: ConversationConfig, conversationId?: string, workspaceId?: string) => {
    const mainWindow = getWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return

    // Desktop turns are durable conversation operations. An empty id cannot
    // be isolated by the renderer, coordinator, permission owner, or transcript
    // barrier, so fail closed before creating any Runtime/tool side effect.
    if (!conversationId) {
      const message = '无法开始对话：缺少会话标识。请重新打开该对话后重试。'
      console.error('[chat:send] rejected request without conversationId')
      mainWindow.webContents.send('chat:stream-end', '', message)
      return
    }

    const cid = conversationId
    // 只顶掉**本会话**的旧流（同会话 regenerate/连发才 supersede）——不再 abort 别的会话，跨会话顶流 bug 根除
    runs.get(cid)?.abort.abort()
    const abort = new AbortController()
    const slot: RunSlot = { abort, agent: null }
    runs.set(cid, slot)
    // 被新 chat:send 顶掉的旧 handler 不得补发 stream-end/清状态：仅当本会话槽仍是本 handler（未被顶掉）
    // 或该会话槽已被显式 abort 删除时放行。catch 与尾部共用此闸,条件须一致。
    const canEmitStreamEnd = () => !mainWindow.isDestroyed() && (runs.get(cid)?.abort === abort || !runs.has(cid))

    let streamError: string | undefined
    let execution: ConversationExecutionLease | undefined
    let executionRoleName: string | undefined
    let terminalFailure = false

    try {
      execution = await acquireConversationExecution({
        // Missing ids retain the legacy single fallback slot, but never alias a
        // persisted conversation's coordinator key.
        conversationId: cid || 'openpipal-internal://desktop-stateless',
        owner: { entrypoint: 'desktop', ownerId: 'renderer' },
        policy: 'supersede',
        signal: abort.signal
      })
      // Role alignment and override resolution touch process-global product
      // state, so they run only after this entrypoint owns the conversation.
      const overrides = resolveAgentOverrides({ agentId, workspaceId, conversationConfig, conversationId })
      // The global current role can be changed by another conversation while
      // this Agent is running. Pin the conversation-owned role now so the
      // completion-side memory extractor cannot inherit a different run's role.
      executionRoleName = overrides?.roleName || getCurrentRole().name
      const { agentChat } = await agentService()
      for await (const event of agentChat(messages, execution.signal, 'desktop', overrides, (handle) => {
        // 挂到本会话运行槽，供 chat:steer/chat:queue 注入；被顶掉的旧槽是孤儿、置 agent 无害
        slot.agent = handle
      })) {
        if (execution.signal.aborted || mainWindow.isDestroyed()) break
        switch (event.type) {
          case 'text':
            mainWindow.webContents.send('chat:stream-chunk', cid, event.content)
            break
          case 'text_flush':
            mainWindow.webContents.send('chat:text-flush', cid)
            break
          case 'thinking':
            mainWindow.webContents.send('chat:thinking', cid, event.content)
            break
          case 'thinking_end':
            mainWindow.webContents.send('chat:thinking-end', cid)
            break
          case 'tool_progress':
            mainWindow.webContents.send('chat:tool-progress', cid, event.name, event.chars, event.path)
            break
          case 'tool_start':
            mainWindow.webContents.send('chat:tool-start', cid, event.name, event.toolCallId)
            break
          case 'tool_end':
            mainWindow.webContents.send(
              'chat:tool-end', cid,
              event.name, event.screenshot, event.searchResults,
              event.mcpResult, event.mcpArgs, event.visualizer, event.toolCallId,
              event.modelToolArgs
            )
            break
          case 'artifact':
            mainWindow.webContents.send('chat:artifact', cid, event.artifact, event.toolCallId)
            break
          case 'artifact_delta':
            mainWindow.webContents.send('chat:artifact-delta', cid, { id: event.id, title: event.title, artifactType: event.artifactType, delta: event.delta, offset: event.offset })
            break
          case 'visualizer_delta':
            mainWindow.webContents.send('chat:visualizer-delta', cid, { id: event.id, title: event.title, delta: event.delta, offset: event.offset, height: event.height })
            break
          case 'ask_user':
            mainWindow.webContents.send('chat:ask-user', cid, event.question, event.options, event.fields)
            break
          case 'questions_v2':
            mainWindow.webContents.send('chat:questions-v2', cid, event.title, event.questions)
            break
          case 'questions_v2_delta':
            mainWindow.webContents.send('chat:questions-v2-delta', cid, { id: event.id, title: event.title, questions: event.questions })
            break
          case 'visualizer':
            mainWindow.webContents.send('chat:visualizer', cid, event.visualizer)
            break
          case 'mcp_app_inline':
            mainWindow.webContents.send('chat:mcp-app-inline', cid, { messageId: event.messageId, payload: event.payload })
            break
          case 'goal_update':
            // 持久化到 conversationConfig + 通过通用 artifact-update 通道把进度推给 renderer
            if (conversationId) {
              const conv = getConversation(conversationId)
              if (conv) {
                const merged: ConversationConfig = { ...(conv.config || {}), goal: event.goal }
                updateConversationConfig(conversationId, merged)
              }
              mainWindow.webContents.send('chat:artifact-update', conversationId, {
                id: `goal-${conversationId}`,
                type: 'goal',
                title: tMain('runtimeChrome.artifacts.goalTitle'),
                content: JSON.stringify(event.goal)
              })
            }
            console.log(`[Goal] persisted+forwarded: status=${event.goal.status}, turnsUsed=${event.goal.turnsUsed}/${event.goal.maxTurns}`)
            break
          case 'error':
            terminalFailure = true
            streamError = event.content
            mainWindow.webContents.send('chat:stream-chunk', cid, `\n\n[Error] ${event.content}`)
            break
          case 'context_usage':
            mainWindow.webContents.send('context-usage', cid, {
              promptTokens: event.promptTokens,
              contextWindow: event.contextWindow,
              budget: event.budget,
              compacted: event.compacted
            })
            break
        }
      }
    } catch (err: any) {
      // AbortError 是正常的取消，不报错
      if (err.name === 'AbortError') {
        // noop
      } else {
        terminalFailure = true
        streamError = err?.message || String(err)
      }
    } finally {
      if (execution) {
        try {
          // stream-end first lets chatStore finalize its in-memory projection;
          // the dedicated request that follows then forces/waits for persistence.
          // A superseded handler deliberately emits neither a late stream-end nor
          // any state reset, but still requests a flush before yielding its lease.
          if (canEmitStreamEnd()) {
            try {
              mainWindow.webContents.send('chat:stream-end', cid, streamError)
            } catch (error) {
              console.error('[chat:send] failed to deliver terminal stream event:', error)
            }
          }
          if (conversationId) {
            const persistence = await awaitTranscriptPersistence({
              renderer: mainWindow.webContents,
              conversationId,
              executionId: execution.executionId
            })
            if (persistence.status !== 'acknowledged') {
              console.error(
                `[chat:send] transcript persistence barrier ${persistence.status} ` +
                `(conversation=${conversationId}, execution=${execution.executionId}): ${persistence.error || 'unknown failure'}`
              )
            }
          }
        } finally {
          // Renderer destruction, IPC send failure, save failure, and timeout
          // must all be fail-loud but bounded; none may strand the coordinator.
          execution.release()
        }
      }
    }

    // A rapid newer desktop send may supersede this handler while it is still
    // queued behind another entrypoint. It produced no turn, so do not run
    // memory/dreaming side effects for messages the Agent never consumed.
    if (!execution || execution.signal.aborted) {
      // No lease means acquisition itself failed/cancelled, so the finally
      // barrier had nothing to own. Preserve the legacy terminal signal.
      if (!execution && canEmitStreamEnd()) mainWindow.webContents.send('chat:stream-end', cid, streamError)
      if (runs.get(cid)?.abort === abort) runs.delete(cid)
      return
    }

    if (terminalFailure) {
      if (runs.get(cid)?.abort === abort) runs.delete(cid)
      return
    }

    // 只有本会话槽仍是本 handler（未被后来的 chat:send 顶掉）才清槽——被顶掉的旧 handler 不动新槽
    if (runs.get(cid)?.abort === abort) runs.delete(cid)

    // 自动记忆提取（fire-and-forget，不阻塞 UI）——会话角色关闭记忆（design）则跳过
    if (isAutoMemoryEnabled() && messages.length >= 2 && !shouldSkipMemoryExtraction(conversationId, executionRoleName)) {
      executeExtraction(messages, conversationId || null, executionRoleName!, (saved) => {
        const win = getWindow()
        if (win && !win.isDestroyed() && saved.length > 0) {
          win.webContents.send('memory:updated', { type: 'extracted', memories: saved })
        }
      }).catch((err) => {
        console.warn('[Memory] 自动提取失败:', err.message)
      })

      // Auto Dream：检查是否该执行定期整理（门控条件在 dreamer 内部判断）
      executeAutoDream((result) => {
        const win = getWindow()
        if (win && !win.isDestroyed() && result.actionsApplied > 0) {
          win.webContents.send('memory:updated', {
            type: 'dreamed',
            actionsApplied: result.actionsApplied,
            summary: result.summary
          })
        }
      }).catch(() => {})
    }

    // Agent Workspace dreaming（fire-and-forget）
    if (workspaceId && messages.length >= 2) {
      executeAgentDreaming(workspaceId, messages, (result) => {
        const win = getWindow()
        if (win && !win.isDestroyed() && (result.memories > 0 || result.agentMdUpdated)) {
          win.webContents.send('memory:updated', {
            type: 'agent-dreamed',
            workspaceId,
            memories: result.memories,
            agentMdUpdated: result.agentMdUpdated
          })
        }
      }).catch(() => {})
    }
  })

  // ---- Goal slash 命令 IPC ----
  // /goal <text> 在 InputBar 拦截后,走这三条通道(不混进 chat:send)
  ipcMain.on('chat:set-goal', (_event, conversationId: string, text: string) => {
    const mainWindow = getWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!conversationId || !text?.trim()) return
    const conv = getConversation(conversationId)
    if (!conv) return
    const goal: ConversationGoal = {
      text: text.trim(),
      maxTurns: 8,
      turnsUsed: 0,
      status: 'active',
      consecutiveBlocks: 0,
      createdAt: Date.now()
    }
    updateConversationConfig(conversationId, { ...(conv.config || {}), goal })
    mainWindow.webContents.send('chat:artifact-update', conversationId, {
      id: `goal-${conversationId}`,
      type: 'goal',
      title: tMain('runtimeChrome.artifacts.goalTitle'),
      content: JSON.stringify(goal)
    })
    console.log(`[Goal] /goal set: "${goal.text.slice(0, 60)}"`)
  })

  ipcMain.on('chat:clear-goal', (_event, conversationId: string) => {
    const mainWindow = getWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!conversationId) return
    const conv = getConversation(conversationId)
    if (!conv) return
    const rest = { ...(conv.config || {}) }
    delete (rest as any).goal
    updateConversationConfig(conversationId, rest as ConversationConfig)
    mainWindow.webContents.send('chat:artifact-update', conversationId, {
      id: `goal-${conversationId}`,
      type: 'goal',
      title: '',
      content: '',
      removed: true
    })
    console.log(`[Goal] /goal clear`)
  })

  ipcMain.on('chat:show-goal', (_event, conversationId: string) => {
    const mainWindow = getWindow()
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!conversationId) return
    const conv = getConversation(conversationId)
    if (!conv) return
    const goal = conv.config?.goal
    if (!goal) {
      // 无 goal:啥也不做,UI 不会自动打开侧栏(用户没设过就没东西可看)
      console.log(`[Goal] /goal show but no goal in conversation ${conversationId}`)
      return
    }
    mainWindow.webContents.send('chat:artifact-update', conversationId, {
      id: `goal-${conversationId}`,
      type: 'goal',
      title: tMain('runtimeChrome.artifacts.goalTitle'),
      content: JSON.stringify(goal)
    })
  })

  // ---- 记忆管理 IPC ----
  const isMemoryPath = (p: string) => isWithinMemoryRoot(p)

  ipcMain.handle('memory:list-global', () => {
    return scanMemoryFiles(getGlobalMemoryDir())
  })
  ipcMain.handle('memory:read', (_event, filePath: string) => {
    if (!isMemoryPath(filePath)) return null
    return readMemoryFile(filePath)
  })
  ipcMain.handle('memory:delete', (_event, filePath: string) => {
    if (!isMemoryPath(filePath)) return false
    return deleteMemoryFile(filePath)
  })
  ipcMain.handle('memory:force-dream', async () => {
    return new Promise<{ actionsApplied: number; summary: string }>((resolve) => {
      forceAutoDream((result) => resolve(result)).catch(() => resolve({ actionsApplied: 0, summary: '整理失败' }))
    })
  })
  ipcMain.handle('memory:get-config', () => {
    return { autoMemoryEnabled: isAutoMemoryEnabled(), globalDir: getGlobalMemoryDir() }
  })
  ipcMain.handle('memory:set-config', (_event, enabled: boolean) => {
    setAutoMemoryEnabled(enabled)
    return { ok: true }
  })
  ipcMain.handle('memory:list-archived', () => listArchivedMemories(getGlobalMemoryDir()))
  ipcMain.handle('memory:restore', (_event, filePath: string) => {
    if (!isMemoryPath(filePath)) return false
    return restoreArchivedMemory(filePath)
  })

  // ---- 对话管理 IPC ----
  ipcMain.handle('conv:list', () => listConversations())
  ipcMain.handle('conv:create', (_event, role: string, title?: string, agentId?: string, workspaceId?: string) => createConversation(role, title, agentId, workspaceId))
  ipcMain.handle('conv:get', (_event, id: string) => getConversation(id))
  // 序列化读（评审 H2）：切会话读历史必须排在该会话飞行中的后台 append 之后，否则水位线基于旧快照
  ipcMain.handle('conv:get-messages', (_event, id: string) => getConversationMessagesSerialized(id))
  // 消息附件卸载（截图 png / mcpApp json）：写侧由 chatStore 在事件到达时调用，
  // 读侧供渲染层懒加载（最近 6 条已由 getConversationMessages 重内联，无需再取）
  ipcMain.handle('conv:save-attachment', (_event, cid: string, messageId: string, kind: string, content: string) =>
    saveConversationAttachment(cid, messageId, kind as AttachmentKind, content))
  ipcMain.handle('conv:load-attachment', (_event, cid: string, ref: string) =>
    loadConversationAttachment(cid, ref))
  // 必须 await:落盘是异步队列,fire-and-forget 会让 renderer 误以为已落盘而推进水位线,
  // 真实写入失败(会话已删/磁盘异常)时静默丢数据
  ipcMain.handle('conv:append-messages', async (_event, id: string, messages: StoredMessage[]) => {
    return { ok: await appendMessages(id, messages) }
  })
  ipcMain.handle('conv:replace-messages', async (_event, id: string, messages: StoredMessage[]) => {
    return { ok: await replaceMessages(id, messages) }
  })
  ipcMain.handle('conv:delete', async (_event, id: string) => {
    // 会话删除前先枚举其 artifact id 清单——registry 内存表 + thumbCache 从不自动清理，
    // 这里同步清掉，避免长会话轮转下两处无界增长（磁盘目录本就靠 deleteArtifactsForConversation 删）。
    const artifactIds = listConversationArtifacts(id).map((e) => e.id)
    await deleteConversation(id)
    deleteArtifactsForConversation(id)
    const store = getArtifactStore()
    for (const aid of artifactIds) {
      store.delete(aid)
      evictThumbCache(aid)
    }
    return { ok: true }
  })
  ipcMain.handle('conv:update-role', (_event, id: string, role: string) => {
    return updateConversationRole(id, role)
  })

  ipcMain.handle('conv:update-title', async (_event, id: string, title: string) => {
    return { ok: await updateConversationTitle(id, title) }
  })
  ipcMain.handle('conv:update-config', async (_event, id: string, config: ConversationConfig) => {
    return { ok: await updateConversationConfig(id, config) }
  })

  // ---- 模型配置 IPC ----
  // 红线出口统一走展示口径：key 恒掩码，内置凭证时 model/baseUrl 一并遮蔽
  ipcMain.handle('config:get-model', () => getEffectiveModelConfigForDisplay())
  // 附带派生能力位 supportsEffortDial——档位菜单显隐由主进程按方言推导，renderer 不复刻判定逻辑
  // （能力位仍按真实配置推导，遮蔽只作用于展示字段）
  ipcMain.handle('config:get-model-full', () => ({
    ...getEffectiveModelConfigForDisplay(),
    supportsEffortDial: supportsEffortDial(getEffectiveModelConfig())
  }))
  ipcMain.handle('config:save-model', (_event, config: ModelConfig) => {
    saveModelConfig(config)
    return { ok: true }
  })
  ipcMain.handle('config:test-connection', (_event, config: ModelConfig) => testConnection(config))
  // 上下文窗口自动检测（网关 model/info → 模型列表元数据 → pi 注册表；全落空返回 null）
  ipcMain.handle('config:detect-context-window', async (_event, config: ModelConfig) => {
    const { detectContextWindow } = await import('./context-window-detector')
    return detectContextWindow(config)
  })
  // 向服务商本人要模型清单（远端决定"有哪些"，Pi 目录决定"是什么"）；拿不到就退回目录 + 手填
  ipcMain.handle('config:list-remote-models', async (_event, config: ModelConfig) => {
    const { listRemoteModels } = await import('./remote-model-list')
    return listRemoteModels(config)
  })
  ipcMain.handle('config:test-thinking', async (_event, config: ModelConfig) => (await agentService()).testThinkingSupport(config))
  ipcMain.handle('config:get-providers', () => getProviders())
  ipcMain.handle('config:has-key', () => ({ hasKey: hasApiKey() }))
  ipcMain.handle('config:available-models', () => getAvailableModels())

  // 随消息图片落盘（官方 uploads/ 形状）：返回相对路径，渲染层把它挂到消息元数据上
  ipcMain.handle('chat:persist-images', (_event, conversationId: string, images: string[]) =>
    persistChatImages(conversationId, images))

  // 会话 uploads 资源读取（srcdoc 预览把相对引用内联成 data URI 用；basename 级路径守卫在模块内）
  ipcMain.handle('artifact:read-upload', (_event, conversationId: string, name: string) =>
    readUploadAsset(conversationId, name))

  // 产物 sidecar（*.state.json）读写——image-slot 拖图持久化等官方组件契约;守卫在模块内
  ipcMain.handle('artifact:write-sidecar', (_event, conversationId: string, name: string, content: string) =>
    writeArtifactSidecar(conversationId, name, content))
  ipcMain.handle('artifact:read-sidecar', (_event, conversationId: string, name: string) =>
    readArtifactSidecar(conversationId, name))

  // 剪贴板图片兜底：macOS 上截图预览/微信等来源的图片常只有 TIFF flavor，DOM 剪贴板（clipboardData.items）
  // 看不见；主进程 clipboard.readImage 走 NSPasteboard 原生解码。
  // ⚠️ 权限最小化门槛：readImage 底层是 NSImage initWithPasteboard，会**解析剪贴板里的文件引用并读盘**——
  // 剪贴板若是"复制的文件"且文件在 iCloud 云盘/下载等 TCC 管辖目录，会触发系统授权弹窗（2026-07-22 实案）。
  // 先查 availableFormats（只读 pasteboard 类型声明，不碰盘），仅当存在**原始图像数据** flavor 才读；
  // 文件引用一律不解析——那是用户"复制了个文件"，不是"复制了张图"。
  ipcMain.handle('clipboard:read-image', () => {
    const formats = clipboard.availableFormats()
    if (!formats.some(f => f.startsWith('image/'))) return null
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    return img.toPNG().toString('base64')
  })
  ipcMain.handle('config:save-preset', (_event, name: string, config: ModelConfig) => saveModelPreset(name, config))
  ipcMain.handle('config:switch-preset', (_event, id: string) => switchToPreset(id))
  ipcMain.handle('config:delete-preset', (_event, id: string) => { deleteModelPreset(id); return { ok: true } })
  // 红线守卫：内置预设的连接信息（含明文 key/baseUrl/模型名）不出主进程——UI 对内置也不给编辑入口
  ipcMain.handle('config:get-preset', (_event, id: string) => {
    const preset = getModelPresetFull(id)
    return preset?.builtin ? null : preset
  })
  // 服务商实体：列表（key 掩码）/ 编辑（patch 语义，空 key=保留原值）/ 全量读取（预填新模型的连接字段）
  ipcMain.handle('config:list-model-providers', () => listModelProviders())
  ipcMain.handle('config:update-model-provider', (_event, id: string, patch: any) => ({ ok: updateModelProvider(id, patch) }))
  ipcMain.handle('config:get-model-provider', (_event, id: string) => getModelProviderFull(id))
  ipcMain.handle('config:update-preset', (_event, id: string, name: string, config: any) => updateModelPreset(id, name, config))
  ipcMain.handle('config:is-custom', () => ({ isCustom: isUserCustomConfig() }))
  ipcMain.handle('config:clear-model', () => { clearModelConfig(); return { ok: true } })

  // ---- 搜索服务（web_search）配置 IPC ----
  // 红线出口同样只给展示口径：key 恒掩码，内置回退打 builtin 标记，明文永不出主进程
  ipcMain.handle('config:get-search', () => getEffectiveSearchConfigForDisplay())
  // 空 apiKey = 保留原值（设置页只回显掩码，用户不改 key 时提交空串）
  ipcMain.handle('config:save-search', (_event, config: SearchConfig) => { saveSearchConfig(config); return { ok: true } })
  ipcMain.handle('config:clear-search', () => { clearSearchConfig(); return { ok: true } })
  // 连通测试可带一个还没保存的临时 key；返回只有成败与 errorKey，绝不回显 key
  ipcMain.handle('config:test-search', (_event, apiKey?: string) => testSearchConnection(apiKey))

  // ---- 导出对话 Markdown ----
  ipcMain.handle('dialog:save-markdown', async (_event, defaultName: string) => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: tMain('shell.nativeDialogs.exportConversation'),
      defaultPath: path.join(os.homedir(), 'Desktop', defaultName),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('file:write-text', async (_event, filePath: string, content: string) => {
    writeFileSync(filePath, content, 'utf-8')
    return { ok: true }
  })

  /**
   * 读取文件用于 workspace 预览。
   * - mode='text'（默认）：UTF-8 文本，限 2MB 防卡顿
   * - mode='base64'：二进制（图片/PDF 等小文件），限 5MB
   * 路径校验：只允许 ~/.openpipal/ + ~/Documents + ~/Desktop + ~/Downloads + /tmp 下的文件。
   */
  ipcMain.handle('file:read-for-preview', async (_event, filePath: string, mode: 'text' | 'base64' = 'text') => {
    const fs = require('fs') as typeof import('fs')
    const p = require('path') as typeof import('path')
    const os = require('os') as typeof import('os')
    const HOME = os.homedir()
    const ALLOWED = [
      getDataRoot(),
      p.join(HOME, 'Documents'),
      p.join(HOME, 'Desktop'),
      p.join(HOME, 'Downloads'),
      '/tmp',
      os.tmpdir()
    ]
    const resolved = p.resolve(filePath)
    let real: string
    try { real = fs.realpathSync(resolved) } catch { real = resolved }
    if (!ALLOWED.some(d => real.startsWith(d))) {
      return { ok: false, ...mainError('shell.workspace.filePreview.errors.outsideWorkspace', { path: filePath }) }
    }
    if (!fs.existsSync(real)) {
      return { ok: false, ...mainError('shell.workspace.filePreview.errors.notFound') }
    }
    const st = fs.statSync(real)
    if (!st.isFile()) return { ok: false, ...mainError('shell.workspace.filePreview.errors.notAFile') }
    const MAX_TEXT = 2 * 1024 * 1024
    const MAX_BIN = 5 * 1024 * 1024
    if (mode === 'text' && st.size > MAX_TEXT) {
      return { ok: false, ...mainError('shell.workspace.filePreview.errors.tooLargeText', { size: (st.size/1024/1024).toFixed(1) }) }
    }
    if (mode === 'base64' && st.size > MAX_BIN) {
      return { ok: false, ...mainError('shell.workspace.filePreview.errors.tooLargeBinary', { size: (st.size/1024/1024).toFixed(1) }) }
    }
    try {
      if (mode === 'base64') {
        const buf = fs.readFileSync(real)
        return { ok: true, data: buf.toString('base64'), size: st.size, mtime: st.mtimeMs }
      }
      return { ok: true, data: fs.readFileSync(real, 'utf-8'), size: st.size, mtime: st.mtimeMs }
    } catch (err: any) {
      return { ok: false, error: err.message }
    }
  })

  // file:reveal / file:open 已在下方"文件操作 IPC"段落注册，这里不重复

  // ---- 工作目录 IPC ----
  ipcMain.handle('dialog:select-directory', async () => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: tMain('shell.nativeDialogs.selectWorkingDirectory'),
      defaultPath: os.homedir()
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('config:get-working-dir', () => {
    return getWorkingDir()
  })

  ipcMain.handle('config:set-working-dir', (_event, dir: string) => {
    setWorkingDir(dir)
    return { ok: true }
  })

  // ---- MCP 服务器管理 IPC ----
  ipcMain.handle('mcp:list-servers', () => getMcpServerStatus())
  ipcMain.handle('mcp:add-server', async (_event, name: string, config: any) => {
    await addMcpServer(name, config)
    reloadSkills()  // server 可能带了 suggested skills
    return { ok: true }
  })
  ipcMain.handle('mcp:remove-server', async (_event, name: string) => {
    await removeMcpServer(name)
    reloadSkills()  // 清掉该 server 同步过的 skills
    return { ok: true }
  })
  ipcMain.handle('mcp:test-server', async (_event, config: any) => testMcpConnection(config))
  // OAuth: 用户主动触发授权(打开浏览器,等回调,完成连接)
  ipcMain.handle('mcp:authorize', async (_event, name: string) => {
    const r = await authorizeMcpServer(name)
    if (r.ok) reloadSkills()  // 新接的 server 可能带 suggested skills
    return r
  })
  // OAuth: 撤销授权(删 token,断开连接)
  ipcMain.handle('mcp:revoke-auth', async (_event, name: string) => {
    await revokeMcpServerAuth(name)
    reloadSkills()
    return { ok: true }
  })
  // MCP Apps: iframe 反向调用 — 三道门:
  // MCP App permissions
  ipcMain.handle('mcp-app:get-perms', (
    _event,
    serverName: string,
    serverBinding: string,
    conversationId?: string
  ) => isMcpServerBindingVisible(serverBinding, serverName, conversationId)
    ? getMcpAppPermissions(serverName, serverBinding)
    : [])
  ipcMain.handle('mcp-app:approve-perms', (
    _event,
    serverName: string,
    serverBinding: string,
    requested: string[],
    conversationId?: string
  ) => isMcpServerBindingVisible(serverBinding, serverName, conversationId)
    ? approveMcpAppPermissions(serverName, serverBinding, requested)
    : [])
  ipcMain.handle('mcp-app:sanitize-caps', (_event, perms: string[]) => sanitizeCapabilities(perms))
  // iframe 反向 tools/call 代理 — 同 server 绑定 + 风险分类 + 独立用户确认。
  // safe 轮询仍直接执行；needs_confirmation 必须由当前对话的权限卡批准。
  ipcMain.handle('mcp:call-from-app', async (
    _event,
    serverName: string,
    serverBinding: string,
    toolName: string,
    args: Record<string, unknown>,
    conversationId?: string
  ) => callMcpToolFromApp({ serverName, serverBinding, toolName, args, conversationId }))

  // ---- CLI 工具管理 IPC ----
  ipcMain.handle('cli:list', () => getAvailableClis())
  // 非法命令名不抛到渲染层（调用方未接 catch，抛出会卡住保存态）——返回 ok:false 即可
  ipcMain.handle('cli:add', (_event, tool: any) => {
    try {
      addUserCliTool(tool)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'invalid command' }
    }
  })
  ipcMain.handle('cli:remove', (_event, command: string) => { removeUserCliTool(command); return { ok: true } })
  ipcMain.handle('cli:validate', (_event, command: string) => !!isAvailable(command))
  ipcMain.handle('cli:refresh', () => refreshClis())

  // ---- Skills 管理 IPC ----
  ipcMain.handle('skills:list', (_event, workspaceId?: string) => listSkillsMeta(workspaceId))
  ipcMain.handle('skills:set-disabled', (_event, name: string, disabled: boolean) => {
    setSkillDisabled(name, disabled)
    return { ok: true }
  })
  ipcMain.handle('skills:get-details', (_event, name: string) => getSkillDetails(name))
  ipcMain.handle('skills:import-scan', (_event, source: ImportSource) => importScan(source))
  ipcMain.handle('skills:import-apply', (_event, payload: ImportApplyPayload) => importApply(payload))
  ipcMain.handle('skills:delete', (_event, name: string) => deleteUserSkill(name))

  // ---- Agent Plugins 插件管理 IPC ----
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:install', (_event, source: PluginInstallSource, opts?: { overwrite?: boolean }) =>
    installPlugin(source, opts))
  ipcMain.handle('plugins:uninstall', (_event, name: string) => uninstallPlugin(name))
  ipcMain.handle('plugins:set-disabled', (_event, name: string, disabled: boolean) => togglePlugin(name, disabled))

  // ---- Agent 模板 CRUD ----
  ipcMain.handle('agent:list', () => listAgentTemplates())
  ipcMain.handle('agent:get', (_event, id: string) => getAgentTemplate(id))
  ipcMain.handle('agent:create', (_event, data: any) => createAgentTemplate(data))
  ipcMain.handle('agent:update', (_event, id: string, data: any) => updateAgentTemplate(id, data))
  ipcMain.handle('agent:delete', (_event, id: string) => { deleteAgentTemplate(id); return { ok: true } })

  // ---- Agent Workspace ----
  ipcMain.handle('workspace:list', () => listWorkspaces())
  ipcMain.handle('workspace:get', (_event, id: string) => {
    const ws = getWorkspace(id)
    if (!ws) return null
    // 附加目录路径，方便 UI 展示和 reveal in Finder
    return { ...ws, dir: getWorkspaceDir(id) }
  })
  ipcMain.handle('workspace:delete', (_event, id: string) => { deleteWorkspace(id); return { ok: true } })

  /**
   * 列产物目录（per-agent 或全局）。
   * 入参 workspaceId 为空 → 扫 ~/.openpipal/outputs/（全局对话）
   * 入参 workspaceId 有值 → 扫 ~/.openpipal/agents/{id}/outputs/（该 Agent 私有）
   * 返回 [{ name, path, size, mtime, ext }]，按修改时间降序。
   */
  ipcMain.handle('workspace:list-outputs', (_event, workspaceId?: string) => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const os = require('os') as typeof import('os')
    const dir = workspaceId
      ? getAgentOutputsDir(workspaceId)
      : dataPath('outputs')
    if (!fs.existsSync(dir)) return []
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      const files = entries
        .filter(e => e.isFile() && !e.name.startsWith('.'))
        .map(e => {
          const p = path.join(dir, e.name)
          const st = fs.statSync(p)
          return {
            name: e.name,
            path: p,
            size: st.size,
            mtime: st.mtimeMs,
            ext: path.extname(e.name).toLowerCase().replace('.', '')
          }
        })
        .sort((a, b) => b.mtime - a.mtime)
      return files
    } catch (err: any) {
      console.error('[workspace:list-outputs] 读取失败:', err.message)
      return []
    }
  })
  // 仅供用户主动进入的“作品”使用：枚举全局 + 各 Agent outputs，不能拿来填充会话摘要。
  ipcMain.handle('workspace:list-output-history', () => {
    try {
      return listOutputHistory()
    } catch (err: any) {
      console.error('[workspace:list-output-history] 读取失败:', err?.message)
      return []
    }
  })
  /**
   * 列 Agent/全局文件目录 —— 返回完整目录树（多层结构）。
   *
   * - workspaceId 有值（Agent 会话）：root = ~/.openpipal/agents/{id}/
   *   （含 agent.md / me.md / memory/ / outputs/ / skills/ / tools/ / workspace/）
   * - workspaceId 空（全局会话）：root = ~/.openpipal/memory/
   *   刻意不暴露全局 agents 目录或 outputs 下的系统级产物 —— 全局 Agent 的系统提示词等敏感信息不外泄给用户。
   *
   * 为防止深层目录和非法链接导致无限递归，maxDepth 默认 4，且跳过符号链接。
   * 每个节点 kind='file'|'folder'；folder 的 children 递归展开，file 含 size/mtime/ext。
   */
  ipcMain.handle('workspace:get-agent-tree', (_event, workspaceId?: string) => {
    const fs = require('fs') as typeof import('fs')
    const path = require('path') as typeof import('path')
    const os = require('os') as typeof import('os')
    const root = workspaceId
      ? dataPath('agents', workspaceId)
      : dataPath('memory')
    if (!fs.existsSync(root)) return null

    const MAX_DEPTH = 4
    const MAX_NODES = 1000
    let nodeCount = 0

    type TreeNode = {
      name: string
      path: string
      kind: 'file' | 'folder'
      size?: number
      mtime?: number
      ext?: string
      children?: TreeNode[]
      truncated?: boolean
    }

    function walk(dir: string, depth: number): TreeNode[] {
      if (depth > MAX_DEPTH) return []
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        const items: TreeNode[] = []
        for (const e of entries) {
          if (e.name.startsWith('.')) continue
          if (e.isSymbolicLink()) continue
          if (++nodeCount > MAX_NODES) {
            items.push({ name: '…（已截断）', path: path.join(dir, '__truncated__'), kind: 'file', truncated: true })
            break
          }
          const p = path.join(dir, e.name)
          if (e.isDirectory()) {
            items.push({
              name: e.name,
              path: p,
              kind: 'folder',
              children: walk(p, depth + 1)
            })
          } else if (e.isFile()) {
            try {
              const st = fs.statSync(p)
              items.push({
                name: e.name,
                path: p,
                kind: 'file',
                size: st.size,
                mtime: st.mtimeMs,
                ext: path.extname(e.name).toLowerCase().replace('.', '')
              })
            } catch { /* ignore unreadable */ }
          }
        }
        // 文件夹在前，再按名字排
        items.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        return items
      } catch (err: any) {
        console.error('[workspace:get-agent-tree] walk 失败:', dir, err.message)
        return []
      }
    }

    try {
      const baseChildren = walk(root, 0)

      // 注入 workspace/assets/ 作为顶部虚拟节点——仅当资源库有真实用户内容时才显示
      // 判定"有内容"：递归扫到至少一个非 README 文件；README.md 视为脚手架噪音
      const assetsRoot = dataPath('workspace', 'assets')
      const extraChildren: TreeNode[] = []
      if (fs.existsSync(assetsRoot)) {
        const hasUserContent = (dir: string, depth = 0): boolean => {
          if (depth > 3) return false
          try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
              if (e.name.startsWith('.')) continue
              if (e.isFile() && e.name.toLowerCase() !== 'readme.md') return true
              if (e.isDirectory() && hasUserContent(path.join(dir, e.name), depth + 1)) return true
            }
          } catch { /* ignore */ }
          return false
        }
        if (hasUserContent(assetsRoot)) {
          extraChildren.push({
            name: '📚 Assets（资源库）',
            path: assetsRoot,
            kind: 'folder',
            children: walk(assetsRoot, 0)
          })
        }
      }

      const tree: TreeNode = {
        name: path.basename(root),
        path: root,
        kind: 'folder',
        children: [...extraChildren, ...baseChildren]
      }
      return tree
    } catch (err: any) {
      console.error('[workspace:get-agent-tree] 读取失败:', err.message)
      return null
    }
  })

  /**
   * fs.watch 推送启动 —— 替代 FilesSection(原 5s)/FilesPanel(原 8s)的定时轮询 IPC 扫描。
   * dirKey 幂等：已在 watch 中直接复用，不重复创建 watcher。
   * macOS FSEvents 支持 recursive:true。事件 300ms 防抖后推 'workspace:changed'。
   * 目录不存在 / 被删 / watch 出错一律静默降级（返回 { ok:false } 或关闭 watcher），不抛穿到渲染进程——
   * 两个面板保留了低频兜底轮询，不依赖这里 100% 可靠。
   */
  ipcMain.handle('workspace:watch-start', (_event, dirKey: string) => {
    if (workspaceWatchers.has(dirKey)) return { ok: true }
    const fs = require('fs') as typeof import('fs')
    const dirs = resolveWatchDirs(dirKey).filter((d) => fs.existsSync(d))
    if (dirs.length === 0) return { ok: false }
    const watchers: FSWatcher[] = []
    const onChange = (): void => {
      const entry = workspaceWatchers.get(dirKey)
      if (!entry) return
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('workspace:changed', { dir: dirKey })
      }, 300)
    }
    for (const dir of dirs) {
      try {
        const watcher = fs.watch(dir, { recursive: true }, onChange)
        watcher.on('error', (err: Error) => {
          console.error('[workspace:watch] fs.watch 出错，静默降级:', dirKey, dir, err.message)
          const entry = workspaceWatchers.get(dirKey)
          if (entry) {
            if (entry.timer) clearTimeout(entry.timer)
            for (const w of entry.watchers) { try { w.close() } catch { /* ignore */ } }
            workspaceWatchers.delete(dirKey)
          }
        })
        watchers.push(watcher)
      } catch (err: any) {
        console.error('[workspace:watch-start] 启动失败，静默降级:', dirKey, dir, err.message)
      }
    }
    if (watchers.length === 0) return { ok: false }
    workspaceWatchers.set(dirKey, { watchers, timer: null })
    return { ok: true }
  })
  ipcMain.handle('workspace:watch-stop', (_event, dirKey: string) => {
    const entry = workspaceWatchers.get(dirKey)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      for (const w of entry.watchers) { try { w.close() } catch { /* ignore */ } }
      workspaceWatchers.delete(dirKey)
    }
    return { ok: true }
  })

  ipcMain.handle('workspace:create-from-conversation', async (_event, conversationId: string) => {
    const messages = getConversationMessages(conversationId)
    if (!messages || messages.length < 2) {
      throw new Error('对话内容不足，至少需要 2 条消息')
    }
    const conv = getConversation(conversationId)
    const roleName = conv?.role || 'learner'

    // Evolver only receives tasks with exact conversation provenance. A broad
    // timestamp window is not ownership and could expose unrelated task IDs,
    // names, or migration capabilities during a long-lived conversation.
    const candidateTasks = selectEvolverTaskCandidates(listTasks(), conversationId)

    // 创建 workspace 目录（占位 meta）
    const meta = createWorkspace({
      name: tMain('agents.creating.name'),
      icon: '⏳',
      description: tMain('agents.creating.description'),
      sourceConversationId: conversationId
    })

    // Evolver Agent 直接用 write/edit 工具填充文件(动态 import:不进 boot 解析路径)
    const { evolverSaveAgent } = await import('./evolver-agent')
    const result = await evolverSaveAgent(
      getWorkspaceDir(meta.id),
      messages as ChatMessage[],
      roleName,
      conversationId,
      candidateTasks
    )

    if (!result.success) {
      console.error(`[Workspace] Evolver 失败: ${result.error}`)
      // 不删除 workspace — 用户可以看到"创建中..."的占位状态并手动清理
    }
    console.log(`[Workspace] Evolver 完成: ${meta.id.slice(0, 8)}`)
    return getWorkspace(meta.id)
  })

  // ---- 统一任务 CRUD（全局 + Workspace 任务走同一套）----
  ipcMain.handle('task:list', (_event, filter?: { workspaceId?: string; enabledOnly?: boolean }) => listTasks(filter))
  ipcMain.handle('task:get', (_event, id: string) => getTask(id))
  ipcMain.handle('task:create', (_event, data: any) => {
    // 自动填充 role（用户创建任务时的当前角色）— 决定任务执行后对话归属
    const withRole = { ...data, role: data.role || getCurrentRole()?.name }
    const task = createTask(withRole)
    scheduleTask(task)
    return task
  })
  ipcMain.handle('task:update', (_event, id: string, updates: any) => {
    const task = updateTask(id, updates)
    if (task) rescheduleTask(id)
    return task
  })
  ipcMain.handle('task:delete', (_event, id: string) => {
    unscheduleTask(id)
    return deleteTask(id)
  })
  ipcMain.handle('task:toggle', (_event, id: string, enabled: boolean) => {
    const task = updateTask(id, { enabled })
    if (task) {
      enabled ? scheduleTask(task) : unscheduleTask(id)
    }
    return task
  })
  // 立即触发：fire-and-forget；scheduler 内部已处理 running 锁、recordTaskExecution、
  // notifyRenderer 通知 UI 刷新 lastRun。立即触发会同步把 nextRun 重算到下个周期。
  ipcMain.handle('task:trigger-now', async (_event, id: string) => {
    const task = getTask(id)
    if (!task) return { ok: false, error: '任务不存在' }
    if (!task.enabled) return { ok: false, error: '任务已禁用，请先启用' }
    executeTask(id).catch(err => console.error(`[Task] 立即触发失败: ${task.name}`, err))
    return { ok: true }
  })

  // ---- 文件操作 IPC ----
  ipcMain.handle('file:open', async (_event, filePath: string) => shell.openPath(filePath))
  ipcMain.handle('file:reveal', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle('dialog:open-file', async (_event, accept?: 'image' | 'document' | 'any' | 'folder') => {
    const win = getWindow()
    if (!win) return null
    // 文件夹模式（代码库挂载）：只登记路径引用不拷贝，agent 用 ls/read 按需渐进式读取
    if (accept === 'folder') {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'multiSelections'],
        title: tMain('shell.nativeDialogs.selectFolder')
      })
      return result.canceled ? null : result.filePaths
    }
    const imageFilter = { name: tMain('shell.nativeDialogs.filters.images'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }
    const docFilter = { name: tMain('shell.nativeDialogs.filters.documents'), extensions: ['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'xml', 'html'] }
    const anyFilter = { name: tMain('shell.nativeDialogs.filters.allFiles'), extensions: ['*'] }
    // 按 accept 排列：传什么放第一位（macOS 默认选第一个 filter group）
    let filters: typeof imageFilter[]
    let title: string
    if (accept === 'image') {
      filters = [imageFilter, anyFilter]
      title = tMain('shell.nativeDialogs.selectImage')
    } else if (accept === 'document') {
      filters = [docFilter, anyFilter]
      title = tMain('shell.nativeDialogs.selectDocument')
    } else {
      filters = [docFilter, imageFilter, anyFilter]
      title = tMain('shell.nativeDialogs.selectFileOrImage')
    }
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title,
      filters
    })
    return result.canceled ? null : result.filePaths
  })

  ipcMain.handle('file:parse', async (_event, filePath: string) => {
    return await parseFile(filePath)
  })

  // 文件上传：复制到 workspace/uploads/，返回新路径
  ipcMain.handle('file:upload', async (_event, sourcePath: string) => {
    const uploadsDir = dataPath('workspace', 'uploads')
    mkdirSync(uploadsDir, { recursive: true })
    const name = `${Date.now()}-${basename(sourcePath)}`
    const destPath = join(uploadsDir, name)
    copyFileSync(sourcePath, destPath)
    return { fileName: basename(sourcePath), path: destPath, sizeBytes: statSync(destPath).size }
  })

  // ---- 通用角色前置能力（Preflow）+ 资产库 IPC ----
  // 文件式架构：~/.openpipal/system-agents/<role>/<feature>.json 存在即 feature 开启
  ipcMain.handle('chat:get-role-preflow', (_event, roleName: string) => {
    return readRoleManifest(roleName, 'preflow.json')
  })

  ipcMain.handle('assets:upload-to-category', async (_event, sourcePath: string, category: 'brand' | 'refs' | 'docs' | 'kits' | 'design-system') => {
    // category 只用于对 agent 的元数据标签（写入 conversationConfig.initialAssets），不作为文件夹
    if (category && !['brand', 'refs', 'docs', 'kits', 'design-system'].includes(category)) {
      throw new Error(`非法资产分类: ${category}`)
    }
    // 落 uploads/ 而非角色资产库：preflow 上传是**本次会话的来源**（过程物），靠 initialAssets
    // 按会话注入；资产库 assets/<role>/ 是跨会话常驻素材、system prompt 会指示模型主动扫——
    // 一次性来源灌进去会让无关会话捞到旧项目内容（2026-08 Q1 汇报 PPT 串味实案）。
    const destDir = dataPath('workspace', 'uploads')
    mkdirSync(destDir, { recursive: true })
    const origName = basename(sourcePath)
    // 同名文件 auto-rename：foo.png → foo-1.png → foo-2.png
    let destName = origName
    let n = 1
    while (require('fs').existsSync(join(destDir, destName))) {
      const dotIdx = origName.lastIndexOf('.')
      const stem = dotIdx > 0 ? origName.slice(0, dotIdx) : origName
      const ext = dotIdx > 0 ? origName.slice(dotIdx) : ''
      destName = `${stem}-${n}${ext}`
      n += 1
    }
    const destPath = join(destDir, destName)
    copyFileSync(sourcePath, destPath)
    const stats = statSync(destPath)
    return {
      category,
      fileName: destName,
      path: destPath,
      sourceType: 'upload',
      sizeBytes: stats.size
    }
  })

  ipcMain.handle('assets:list-tree', async () => listRoleAssets())

  // 角色资产库子文件夹里的"系统"（含 SKILL.md 的文件夹）——教学风格等角色专属长期档案，教师助手 P0 首个消费者
  ipcMain.handle('assets:list-role-systems', async () => listRoleSystemFolders())

  // 档案预览的目录树（路径限定在角色资产库内，main 侧校验；递归一次给全）
  ipcMain.handle('assets:list-role-system-tree', async (_e, dirPath: string) => listRoleSystemTree(dirPath))

  // 设计系统一等产物库（~/.openpipal/design-systems/）——与素材库分离，选用=简报注入指针
  ipcMain.handle('assets:list-design-systems', async () => listDesignSystems())

  // 单套设计系统画廊 manifest（扫卡片+kits+README）；name 非法或不存在返回 null
  ipcMain.handle('assets:design-system-manifest', async (_event, name: string) => getDesignSystemManifest(name))

  // 设计系统文本/图片预览：只接收系统名 + 相对路径，绝不让 renderer 读取任意绝对路径。
  ipcMain.handle('assets:read-design-system-resource', async (_event, name: string, rel: string) =>
    readDesignSystemResource(name, rel))
  ipcMain.handle('assets:design-system-capability', async (_event, name: string) =>
    getDesignSystemResourceCapability(name))

  // 设计系统画廊逐卡评审记录（赞/踩+评语）——文件式 _review.json，路径校验在 role-manager
  ipcMain.handle('assets:ds-review-get', async (_event, name: string) => getDsReview(name))
  ipcMain.handle('assets:ds-review-save', async (_event, name: string, review: DsReview) => saveDsReview(name, review))

  // 已编译新格式 manifest（官方 _ds_manifest.json，12 键）——只读，未编译/legacy/非法 name → null
  // 与 getDesignSystemManifest 完全独立：仅供画廊头部"已编译"标记消费，不影响 @dsCard 派生主逻辑
  ipcMain.handle('assets:compiled-ds-manifest', async (_event, name: string) => {
    return readDesignSystemJsonResource(name, '_ds_manifest.json')
  })

  ipcMain.handle('assets:delete', async (_event, assetPath: string) => {
    // 两个合法根：角色资产库（历史入库件）+ workspace/uploads（preflow 来源新落点）
    const roots = [getRoleAssetsDir(), dataPath('workspace', 'uploads')]
    if (!roots.some(r => assetPath.startsWith(r + '/') || assetPath.startsWith(r))) {
      throw new Error('拒绝删除资产目录外的文件')
    }
    require('fs').unlinkSync(assetPath)
    return { ok: true }
  })

  // ---- Sources（Cave 模式资料区）—— ~/.openpipal/workspace/sources/<id>/ ----
  // 每个 source 一个子目录 + meta.json，乐观 UI 的状态机基础
  ipcMain.handle('sources:list', () => listSources())
  ipcMain.handle('sources:get', (_event, id: string) => getSource(id))
  ipcMain.handle('sources:add', (_event, params: AddSourceParams) => addSource(params))
  ipcMain.handle('sources:remove', (_event, id: string) => removeSource(id))
  ipcMain.handle('sources:update-status', (_event, id: string, status: SourceStatus, patch?: SourceStatusPatch) =>
    updateSourceStatus(id, status, patch))

  // 历史产物枚举（preflow 首屏产物列表）——只读 artifactRef 元数据，不读 content
  ipcMain.handle('artifact:list-history', async (_event, role?: string, limit?: number) => {
    try {
      const items = listArtifactHistory({ role, limit })
      if (process.env.OPENPIPAL_TRACE_IPC === '1') {
        console.log(`[QA IPC] artifact:list-history home=${homedir()} items=${items.length}`)
      }
      return items
    } catch (err: any) {
      console.warn('[IPC] artifact:list-history 失败:', err?.message)
      return []
    }
  })

  // ---- Artifact 持久化（sidecar 文件；内容不进 agent prompt）----
  ipcMain.handle('artifact:save', async (_event, conversationId: string, artifact: { id: string; type: string; title: string; content: string; language?: string }) => {
    try {
      // ephemeral 过程物（todos/questions/goal/mcp-app）：saveArtifactToDisk 内部本就不落盘，
      // 直接短路，省去下面的 owned/内容比对（其 ref.path 恒为空）。
      if (EPHEMERAL_ARTIFACT_TYPES.has(artifact.type)) {
        return { ok: true, ref: saveArtifactToDisk(conversationId, artifact) }
      }
      const owned = getArtifactStore().getRef(conversationId, artifact.id)
      if (owned) {
        // owned 但 path 为空——理论上只有 ephemeral 会这样（上面已短路），这里仅做防御，不 readFileSync('')
        if (!owned.path) return { ok: true, ref: owned }
        // 内容比对：不同才真写盘（saveArtifactToDisk 顺带触发 jsx 重编译）——registry 拥有 id 不再
        // 无条件跳过。修复实案：UI Tweaks 调参 / markdown 编辑在会话内被静默丢弃、重启即回滚。
        let existing: string | null = null
        try { existing = readFileSync(owned.path, 'utf8') } catch { /* 文件缺失就当作"不同"，走真写 */ }
        if (existing !== null && existing === artifact.content) {
          return { ok: true, ref: owned }
        }
        return { ok: true, ref: saveArtifactToDisk(conversationId, artifact) }
      }
      // 未知 id（legacy 渲染器优先路径 / todos·questions·viz 等非 create_artifact 产物）：
      // 磁盘已有该 id 的 sidecar 时沿用其扩展名/类型，别再造 .txt 孪生
      // （实案：artifact-1783491258739.txt 与 .jsx 并存，重启后 byId 覆盖指错文件）
      const existingFile = findArtifactFileById(artifact.id)
      let toSave = artifact
      if (existingFile) {
        const ext = path.extname(existingFile).slice(1).toLowerCase()
        if (ext === 'jsx' || ext === 'tsx') {
          toSave = { ...artifact, type: 'code', language: ext }
        } else if (ext && ext !== 'txt') {
          toSave = { ...artifact, type: coarseTypeFromFile(existingFile) }
        }
      }
      return { ok: true, ref: saveArtifactToDisk(conversationId, toSave) }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'save failed' }
    }
  })

  ipcMain.handle('artifact:load', async (_event, ref: { id: string; type: string; title: string; path: string; language?: string }, conversationId?: string) => {
    const data = loadArtifactFromDisk(ref, conversationId)
    if (!data) return { ok: false, error: 'not found' }
    return { ok: true, artifact: data }
  })

  // dc 薄壳 x-import 链引用 ./artifact-<id>.jsx → 同会话 sidecar 的 <id>.compiled.js 文本（渲染端终态内联用）
  ipcMain.handle('artifact:load-compiled', async (_event, conversationId: string, artifactId: string) => {
    try {
      return loadCompiledArtifact(conversationId, artifactId)
    } catch {
      return null
    }
  })

  // ---- DC 设计交付物导出（离线自足文件夹：.dc.html + support.js + 本地 React vendor）----
  ipcMain.handle('artifact:export-dc', async (_event, projectName: string, artifacts: { title: string; content: string; artifactId?: string }[]) => {
    return exportDcBundle(projectName, artifacts || [])
  })

  // ---- PDF 直出（doc-page/dc 文档隐藏窗口渲染 → printToPDF → outputs/<title>.pdf）----
  ipcMain.handle('artifact:export-pdf', async (_event, title: string, content: string) => {
    return exportArtifactPdf(title || 'document', content || '')
  })

  // ---- 分享打包（产物文件夹 → 系统 zip → outputs/<name>.zip，源目录走白名单）----
  ipcMain.handle('artifact:export-zip', async (_event, sourceDir: string, outName: string) => {
    return exportZip(sourceDir || '', outName || 'share')
  })

  // ---- 导出弹窗三件套：目录记忆 + 目录选择 + 按格式导出（落用户可见目录并在访达中显示）----
  ipcMain.handle('artifact:get-export-dir', async () => ({ dir: getExportDir() }))

  ipcMain.handle('artifact:choose-export-dir', async () => {
    const win = getWindow()
    if (win) {
      const result = await dialog.showOpenDialog(win, {
        title: tMain('shell.nativeDialogs.selectExportDirectory'),
        defaultPath: getExportDir(),
        properties: ['openDirectory', 'createDirectory']
      })
      if (!result.canceled && result.filePaths[0]) setExportDir(result.filePaths[0])
    }
    return { dir: getExportDir() }
  })

  ipcMain.handle('artifact:export', async (_event, req: {
    format: 'project-zip' | 'standalone-html' | 'pdf' | 'source' | 'ds-zip' | 'mp4' | 'pptx' | 'handoff'
    title?: string
    content?: string
    id?: string
    filename?: string
    projectName?: string
    artifacts?: { title: string; content: string; artifactId?: string }[]
    dsName?: string
    durationSec?: number
    fps?: number
  }) => {
    const dir = getExportDir()
    let out: { ok: boolean; path?: string; error?: string }
    try {
      switch (req?.format) {
        case 'pdf':
          out = await exportArtifactPdf(req.title || 'document', req.content || '', dir, req.id)
          break
        case 'mp4': {
          const win = getWindow()
          out = await exportArtifactMp4(
            req.title || 'animation',
            req.content || '',
            req.id,
            { durationSec: req.durationSec, fps: req.fps || 30 },
            dir,
            (done, total) => {
              if (win && !win.isDestroyed()) win.webContents.send('export-progress', { done, total })
            }
          )
          break
        }
        case 'pptx': {
          const win = getWindow()
          out = await exportArtifactPptx(
            req.title || 'design',
            req.content || '',
            req.id,
            dir,
            (done, total) => {
              if (win && !win.isDestroyed()) win.webContents.send('export-progress', { done, total })
            }
          )
          break
        }
        case 'handoff': {
          const win = getWindow()
          out = await exportArtifactHandoff(
            req.title || 'design',
            req.content || '',
            req.id,
            dir,
            (done, total) => {
              if (win && !win.isDestroyed()) win.webContents.send('export-progress', { done, total })
            }
          )
          break
        }
        case 'standalone-html':
          out = exportStandaloneHtml(req.title || 'design', req.content || '', req.id, dir)
          break
        case 'project-zip': {
          // 先装配离线文件夹到 outputs（既有管线），再 zip 到导出目录
          const bundle = exportDcBundle(req.projectName || 'design', req.artifacts || [])
          if (!bundle.ok || !bundle.dir) { out = { ok: false, ...(bundle.error ? { error: bundle.error } : mainError('artifacts.shell.export.errors.assembleFailed', { detail: '' })) }; break }
          out = await exportZip(bundle.dir, req.projectName || 'design', dir)
          break
        }
        case 'ds-zip': {
          if (!req.dsName) { out = { ok: false, ...mainError('artifacts.shell.export.errors.missingDesignSystemName') }; break }
          out = await exportZip(dataPath('design-systems', req.dsName), req.dsName, dir)
          break
        }
        case 'source': {
          const safe = (req.filename || 'artifact.txt').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim()
          const p = join(dir, safe)
          mkdirSync(dir, { recursive: true })
          writeFileSync(p, req.content || '', 'utf8')
          out = { ok: true, path: p }
          break
        }
        default:
          out = { ok: false, ...mainError('artifacts.shell.export.errors.unknownFormat', { format: String(req?.format) }) }
      }
    } catch (err: any) {
      out = { ok: false, error: err?.message || 'export failed' }
    }
    // 导出成功直接在访达里选中文件——用户不用自己去翻文件夹
    if (out.ok && out.path) shell.showItemInFolder(out.path)
    return out
  })

  // ---- Artifact 内 LLM 调用（window.openpipal.complete）----
  // 版本检查：只在渲染层打开「关于」时被调一次，不在启动路径上
  ipcMain.handle('app:check-update', async () => {
    const { checkForUpdate } = await import('./update-check')
    return checkForUpdate(app.getVersion())
  })

  ipcMain.handle('openpipal:complete', async (_event, prompt: string, systemPrompt?: string) => {
    try {
      const content = await completeInArtifact(prompt, systemPrompt)
      return { ok: true, content }
    } catch (err: any) {
      return { ok: false, error: err.message || 'completion failed' }
    }
  })

  // ---- Realtime Voice IPC ----
  setRealtimeWindowRef(getWindow)

  ipcMain.handle('realtime:config', () => getRealtimeConfig())
  ipcMain.handle('realtime:start', (_event, ctx?: any) => startRealtimeSession(ctx))
  ipcMain.on('realtime:stop', () => stopRealtimeSession())
  ipcMain.on('realtime:send-event', (_event, data: any) => sendRealtimeEvent(data))

  // Voice (Realtime) 配置 IPC
  ipcMain.handle('voice:get-config', () => getEffectiveVoiceConfig())
  ipcMain.handle('voice:save-config', (_event, config: VoiceConfig) => {
    saveVoiceConfig(config)
    return { ok: true }
  })
  // 同传目标语言(interpreter 角色;源自动识别)。interpret.json 可 override 可选语言,默认 en/zh(s2s 约束)
  ipcMain.handle('voice:get-interpret-langs', () => {
    const manifest = readRoleManifest('interpreter', 'interpret.json')
    const targetLanguages: string[] = manifest?.targetLanguages || ['en', 'zh']
    const d = getDoubaoVoiceConfig()
    const current = d?.targetLanguage || manifest?.defaultTarget || 'en'
    return { targetLanguages, current }
  })
  ipcMain.handle('voice:set-interpret-target', (_event, target: string) => {
    setInterpretTargetLanguage(target)
    return { ok: true }
  })
  // 同传逐字稿归档(P5 最小):落 ~/.openpipal/outputs/{date}_同传.md
  ipcMain.handle('voice:archive-transcript', (_event, title: string, content: string) => {
    const path = saveOutput(title || '同传', content)
    return { ok: true, path }
  })
  ipcMain.handle('voice:test-connection', (_event, config: VoiceConfig) =>
    testRealtimeConnection(config)
  )
  // 音色试听:用临时配置 + 指定 voice 连一下,让模型读一句样例,音频流式推回 renderer
  ipcMain.handle('voice:preview', (_event, config: VoiceConfig, voice: string) =>
    previewVoice(config, voice)
  )
  ipcMain.on('voice:preview-stop', () => stopVoicePreview())
  // 语音音频留存(回听):存裸 PCM16→WAV / 读回 base64
  ipcMain.handle('voice:save-audio', (_event, conversationId: string, itemId: string, role: string, base64Pcm: string) =>
    saveVoiceAudio(conversationId, itemId, role, base64Pcm)
  )
  ipcMain.handle('voice:read-audio', (_event, path: string) => readVoiceAudio(path))
  // 语音会话结束 → 触发记忆提取(与文字模式每轮 stream-end 提取对齐;语音批在挂断时做)。
  // 语音转录走 upsertVoiceMessage,不经过文字 chat:send 路径,所以这里补一条入口。
  ipcMain.handle('memory:extract-conversation', (_event, history: any[], conversationId: string) => {
    if (!isAutoMemoryEnabled() || !Array.isArray(history) || history.length < 2) return
    const roleName = resolveExecutionRoleName({ conversationId })
    if (shouldSkipMemoryExtraction(conversationId, roleName)) return
    executeExtraction(history as any, conversationId || null, roleName, (saved) => {
      const win = getWindow()
      if (win && !win.isDestroyed() && saved.length > 0) {
        win.webContents.send('memory:updated', { type: 'extracted', memories: saved })
      }
    })
  })

  // ---- 权限审批 IPC（弹窗模式）----
  ipcMain.on('agent:permission-response', (_event, { requestId, approved }: { requestId: string; approved: boolean }) => {
    resolvePermissionRequest(requestId, approved)
  })

  // ---- 内联权限审批 IPC（会话流模式）----
  ipcMain.on('permission:inline-response', (_event, {
    requestId,
    approved,
    sessionApprove,
    executionId,
    conversationId
  }: {
    requestId: string
    approved: boolean
    sessionApprove?: boolean
    executionId?: string
    conversationId?: string
  }) => {
    // Desktop IPC is a trusted local transport. Older renderer bundles may not
    // echo the owner fields; the main process fills them from the pending entry
    // but still validates that execution is current before consuming it.
    resolveInlinePermission(
      requestId,
      approved,
      sessionApprove,
      executionId,
      conversationId,
      true
    )
  })

  // ---- 清空会话级审批（新建/删除对话时）----
  // 按 conversationId 清：多会话并发下，新建 A 不该把后台仍在跑的 B 的授权一起抹掉。
  // 不传 cid 仍是"全清"（保留给退出/重置类场景）。
  ipcMain.on('permission:clear-session', (_event, conversationId?: string) => {
    clearSessionApprovals(conversationId)
  })
}

// ---- 内联权限响应处理（IPC 与 HTTP/SSE 共用）----
// 桌面经 permission:inline-response IPC、浏览器经 POST /api/permission 都走这里:
// resolve 在飞的请求 + 处理"本次会话允许"(浏览器按站点授权 / 其它按工具授权)+ 清理。
export function resolveInlinePermission(
  requestId: string,
  approved: boolean,
  sessionApprove?: boolean,
  executionId?: string,
  conversationId?: string,
  trustedDesktopResponse = false
): boolean {
  const grant = pendingBrowserGrant.get(requestId)
  const entry = pendingPermissionTools.get(requestId)
  const owner = grant || entry
  if (!owner) return false
  if (!pendingPermissionResolvers.has(requestId)) {
    pendingPermissionTools.delete(requestId)
    pendingBrowserGrant.delete(requestId)
    return false
  }

  const responseExecutionId = executionId || (trustedDesktopResponse ? owner.executionId : undefined)
  const responseConversationId = conversationId || (trustedDesktopResponse ? owner.conversationId : undefined)
  const ownerFieldsMatch = responseConversationId === owner.conversationId && (
    owner.executionId
      ? responseExecutionId === owner.executionId
      : trustedDesktopResponse
  )
  if (!ownerFieldsMatch) {
    console.warn(`[Security] 拒绝 owner 不匹配的权限响应: ${requestId}`)
    return false
  }
  if (
    owner.executionId &&
    (!owner.conversationId || !isCurrentConversationExecution(owner.conversationId, owner.executionId))
  ) {
    // The run is already gone. Consume the abandoned resolver as a denial so
    // it cannot linger, but never transfer approval to the next owner.
    pendingPermissionTools.delete(requestId)
    pendingBrowserGrant.delete(requestId)
    resolvePermissionRequest(requestId, false)
    console.warn(`[Security] 忽略已结束或已被替换执行的权限响应: ${requestId}`)
    return false
  }

  // Consume owner metadata before resolving the Agent promise: requestId is
  // single-use even if a client retries the same HTTP/IPC response.
  pendingPermissionTools.delete(requestId)
  pendingBrowserGrant.delete(requestId)
  resolvePermissionRequest(requestId, approved)
  if (approved && sessionApprove) {
    if (grant && grant.host) {
      // 浏览器:按站点授权（本对话内该 host 的写操作此后放行 —— 站点轴丝滑）
      if (grant.conversationId) grantSessionHost(grant.conversationId, grant.host)
    } else {
      if (entry?.tool) approveToolForSession(entry.tool, entry.conversationId, entry.args, entry.approvalScope)
    }
  }
  return true
}

// ---- 内联权限请求发送（供 pi-security 使用）----
export function sendInlinePermissionRequest(getWindow: () => BrowserWindow | null, request: { requestId: string; tool: string; args: Record<string, any>; risk: string; reason: string; conversationId?: string; approvalScope?: SessionApprovalScope }): void {
  const execution = request.conversationId
    ? getConversationExecution(request.conversationId)
    : undefined
  if (execution?.aborted) {
    // Superseded/aborted owners retain the coordinator lease only for cleanup
    // and transcript persistence. They must not open a new authorization path.
    resolvePermissionRequest(request.requestId, false)
    return
  }
  // 记录工具名+会话/站点(IPC 与 SSE 共用,必须在任何 early-return 之前登记,否则"本次会话允许"丢授权)
  pendingPermissionTools.set(request.requestId, {
    tool: request.tool,
    args: request.args,
    approvalScope: request.approvalScope,
    conversationId: request.conversationId,
    executionId: execution?.executionId
  })
  // 浏览器写命令:记下目标 host,"本次会话允许"时按站点(而非按工具)授权
  if (isBrowserWriteTool(request.tool)) {
    pendingBrowserGrant.set(request.requestId, {
      conversationId: request.conversationId,
      executionId: execution?.executionId,
      host: targetHostForCommand(request.tool, request.args)
    })
  }
  // ⚠️ 历史教训(present_to_user 同款):某字段不是纯数据(pi-agent 把参数包成 Proxy/带
  // symbol 的校验值,或 reason/risk 是包装对象),直接 webContents.send 会抛 "Failed to
  // serialize arguments" → 气泡发不到前端 → 用户看不到确认 → 300s 超时自动拒绝(表现为
  // "导航极慢然后失败")。这里用 structuredClone(与 IPC 同款算法)逐字段定位,再统一 JSON
  // 深拷贝成纯数据发送;JSON 失败才降级为强制字符串化的最小载荷。
  const rawPayload: Record<string, unknown> = {
    requestId: request.requestId,
    tool: request.tool,
    args: request.args ?? {},
    risk: request.risk,
    reason: request.reason,
    conversationId: request.conversationId,
    executionId: execution?.executionId
  }
  try {
    structuredClone(rawPayload)
  } catch {
    for (const [k, v] of Object.entries(rawPayload)) {
      try { structuredClone(v) } catch (er) {
        console.warn(`[Security] 权限载荷不可克隆字段 ${k}: typeof=${typeof v} ctor=${(v as any)?.constructor?.name} — ${(er as Error)?.message}`)
      }
    }
  }
  let safePayload: Record<string, unknown>
  try {
    safePayload = JSON.parse(JSON.stringify(rawPayload))
  } catch (e) {
    console.warn('[Security] 权限载荷 JSON 序列化失败,降级为最小载荷:', (e as Error)?.message)
    safePayload = {
      requestId: String(request.requestId),
      tool: String(request.tool),
      args: {},
      risk: String(request.risk ?? 'needs_confirmation'),
      reason: String(request.reason ?? '需要确认此操作'),
      conversationId: request.conversationId ? String(request.conversationId) : undefined,
      executionId: execution?.executionId
    }
  }
  // 浏览器(SSE)优先:命中正在流式的会话则只写浏览器流,避免桌面窗口冒出一个无关会话的气泡。
  // 桌面 /chat 走 IPC、不登记活动流,故 desktop 请求这里返回 false → 回退到 webContents.send。
  if (writePermissionToStream(request.conversationId, safePayload)) return
  // Extension-owned requests must never fall through to an unrelated desktop
  // window if their SSE transport disappeared. ACP has no browser permission
  // response protocol, so it deliberately falls back to the trusted desktop.
  if (execution?.owner.entrypoint === 'http' && execution.owner.ownerId === 'extension') {
    console.warn('[Security] HTTP 权限流已不可用，自动拒绝:', request.tool)
    pendingPermissionTools.delete(request.requestId)
    pendingBrowserGrant.delete(request.requestId)
    resolvePermissionRequest(request.requestId, false)
    return
  }

  const win = getWindow()
  if (!win || win.isDestroyed()) {
    console.warn('[Security] 无法发送内联权限请求：窗口不可用')
    pendingPermissionTools.delete(request.requestId)
    pendingBrowserGrant.delete(request.requestId)
    resolvePermissionRequest(request.requestId, false)
    return
  }
  win.webContents.send('permission:inline-request', safePayload)
}

// ---- 桌面权限处理器（dialog 弹窗）----

/**
 * 桌面模式权限处理器：发 IPC 事件给前端 React 弹窗组件。
 * 会话级白名单：用户点"始终允许"后，同名工具后续自动放行。
 */
export function createDesktopPermissionHandler(getWindow: () => BrowserWindow | null): PermissionHandler {
  return async (request: PermissionRequest): Promise<boolean> => {
    const win = getWindow()
    if (!win || win.isDestroyed()) {
      console.warn('[Security] 无可用窗口，自动拒绝:', request.tool)
      return false
    }

    // 发 IPC 事件给前端
    win.webContents.send('agent:permission-request', {
      requestId: request.requestId,
      tool: request.tool,
      args: request.args,
      risk: request.risk,
      reason: request.reason,
    })

    // 等待前端响应
    return new Promise<boolean>((resolve) => {
      pendingPermissionResolvers.set(request.requestId, (approved: boolean) => {
        resolve(approved)
      })

      // 60 秒超时自动拒绝
      setTimeout(() => {
        if (pendingPermissionResolvers.has(request.requestId)) {
          pendingPermissionResolvers.delete(request.requestId)
          console.warn('[Security] 权限请求超时，自动拒绝:', request.tool)
          resolve(false)
        }
      }, 60000)
    })
  }
}
