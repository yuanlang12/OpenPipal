/**
 * 「已定下规则」提醒的链路守卫——主进程事件 → IPC 通道 → preload → 渲染层消息 → 气泡分流。
 *
 * 五段各在不同文件里，任何一段漏掉功能上都只是"提醒没出现"，没有编译期信号；
 * 与 runtime-context-projection-seam 同款手法按源码文本钉住。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const read = (rel: string): string => readFileSync(join(__dirname, '../..', rel), 'utf-8')

describe('hook_notice 链路', () => {
  it('运行时：写文件探针把结论推进事件队列并回给模型', () => {
    const runtime = read('src/main/agent-runtime/pi-core-runtime.ts')
    expect(runtime).toMatch(/probeWrittenFile:\s*async \(toolName, args\)/)
    expect(runtime).toMatch(/eventQueue\.push\(\{ type: 'hook_notice', notice \}\)/)
    expect(runtime).toMatch(/formatHookNoticeForModel/)
    // 后台（set_rule → Evolver）正在写规则时，shell 探针只刷基线不报——否则后台写的文件会被当成本轮模型建的
    expect(runtime).toMatch(/isRuleWriteActive\(\)[\s\S]*?refreshHookSignatures\(hookBaseline, hookScope\)/)
    // 规则清单每轮进系统提示（生效 / 没生效 / 后台正在写），用的是本会话刚装的那份清单，排在 before_agent_start 之前
    expect(runtime).toMatch(/formatHookStatusForPrompt\(hookReport, listPendingRuleDescriptions\(overrides\?\.conversationId\), hookScanError\)[\s\S]*?runBeforeAgentStartHooks/)
    expect(runtime).toMatch(/if \(hookStatus\) systemPrompt = /)
    expect(runtime).not.toMatch(/getHookReport/)
    // 写探针与 shell 探针同一个范围：写进别的 Agent 目录的文件对本会话不生效，不给"从下一轮开始执行"
    expect(runtime).toMatch(/probeHookFileWrite\(args\.path, workspace\.workingDir, undefined, hookBaseline, hookScope\)/)
  })

  it('主进程 → 渲染层：ipc-handlers 把 hook_notice 发到 chat:hook-notice，preload 暴露 onHookNotice', () => {
    expect(read('src/main/ipc-handlers.ts')).toMatch(/case 'hook_notice':[\s\S]*?webContents\.send\('chat:hook-notice', cid, event\.notice\)/)
    const preload = read('src/preload/index.ts')
    expect(preload).toMatch(/onHookNotice:[\s\S]*?ipcRenderer\.on\('chat:hook-notice'/)
    expect(preload).toMatch(/listHooks:.*'hooks:list'/)
    expect(preload).toMatch(/setHookEnabled:.*'hooks:set-enabled'/)
    const handlers = read('src/main/ipc-handlers.ts')
    expect(handlers).toMatch(/ipcMain\.handle\('hooks:list'/)
    expect(handlers).toMatch(/ipcMain\.handle\('hooks:set-enabled'/)
  })

  it('浏览器插件同一条路：web-api-shim 把 SSE 的 hook_notice 映射成 onHookNotice', () => {
    const shim = read('src/renderer/src/web-api-shim.ts')
    expect(shim).toMatch(/case 'hook_notice': emit\('hook-notice', cid, data\.notice\)/)
    expect(shim).toMatch(/onHookNotice: \(cb: Callback\) => on\('hook-notice', cb\)/)
  })

  it('渲染层：落成 inject-notice/hook 消息并落盘，气泡分流到 HookNoticeRow', () => {
    const store = read('src/renderer/src/stores/chatStore.ts')
    // cid 可空：后台（set_rule → Evolver）写的规则没有"本轮会话"，落当前会话
    expect(store).toMatch(/onHookNotice\(\(cid: string \| null, notice: HookNoticePayload\)/)
    expect(store).toMatch(/messageKind: 'inject-notice',\s*messageSubtype: 'hook',\s*hookNotice: notice/)
    const bubble = read('src/renderer/src/components/MessageBubble.tsx')
    expect(bubble).toMatch(/messageSubtype === 'hook' && message\.hookNotice[\s\S]*?<HookNoticeRow message=\{message\} \/>/)
  })

  it('持久化：StoredMessage 与渲染层 ChatMessage 都用 shared 那一份 HookNotice；inject-notice 不进模型载荷', () => {
    expect(read('src/main/conversation-store.ts')).toMatch(/hookNotice\?: HookNotice\b/)
    expect(read('src/main/conversation-store.ts')).toMatch(/import type \{ HookNotice \} from '\.\.\/shared\/hook-contract'/)
    expect(read('src/renderer/src/types/index.ts')).toMatch(/hookNotice\?: HookNoticePayload/)
    expect(read('src/renderer/src/types/index.ts')).toMatch(/HookNotice as HookNoticePayload, HookEntry, HookSource \} from '\.\.\/\.\.\/\.\.\/shared\/hook-contract'/)
    expect(read('src/preload/index.d.ts')).toMatch(/import type \{ HookEntry, HookNotice, HookToggleResult \} from '\.\.\/shared\/hook-contract'/)
    // 不能像 stream-retry 那样被 persistableMessages 过滤掉
    expect(read('src/main/session/pi-v4-jsonl-session-store.ts')).not.toMatch(/messageSubtype === 'hook'/)
  })

  it('文案两种语言都齐', () => {
    const i18n = read('src/shared/i18n/resources.ts')
    for (const key of ['hookRuleSet', 'hookRuleFailed', 'hookRuleRevoked', 'hookRuleDeleted', 'hookRuleView', 'hookRuleRevoke', 'hookRuleRestore']) {
      const count = (i18n.match(new RegExp(`\\b${key}:`, 'g')) || []).length
      expect(count, key).toBe(2)
    }
  })

  it('规则页：插件页第四个标签，按来源分组；胶囊「查看」直达它；对话里定的 local-rules 不当插件列', () => {
    const hub = read('src/renderer/src/components/ToolsHub.tsx')
    expect(hub).toMatch(/key: 'rules', labelKey: 'toolsHub\.tabs\.rules'/)
    expect(hub).toMatch(/function RulesTab\(\)/)
    expect(hub).toMatch(/rule\.source\.kind === 'agent'/)
    expect(hub).toMatch(/plugins\.filter\(p => p\.name !== LOCAL_RULES_PLUGIN\)/)
    expect(read('src/renderer/src/components/messages/HookNoticeRow.tsx')).toMatch(/openToolsHub\('rules'\)/)
    expect(read('src/renderer/src/stores/appStore.ts')).toMatch(/openToolsHub: \(tab\) => set\(\{ activeView: 'tools', toolsHubTab: tab \}\)/)
    const i18n = read('src/shared/i18n/resources.ts')
    for (const key of ['allAgents', 'fromPlugin', 'intro']) {
      expect((i18n.match(new RegExp(`\\b${key}:`, 'g')) || []).length, key).toBe(2)
    }
    expect((i18n.match(/\brules: '规则'/g) || []).length).toBe(1)
    expect((i18n.match(/\brules: 'Rules'/g) || []).length).toBe(1)
  })
})
