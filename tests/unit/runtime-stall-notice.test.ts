/**
 * 契约锁：Runtime 写入记录的错误气泡必须语言中立，本地化只发生在渲染层。
 *
 * 背景：看门狗超时提示曾在 Runtime 侧就用 tMain 翻译好再写进 content，
 * 这会让同一条会话在中英文界面下产生逐字节不同的记录（验收矩阵要跨 Runtime
 * 比对记录、ACP 导出也依赖它），并撞上 agent-runtime-boundary 的
 * "keeps UI locale resources out of Runtime prompts and tool contracts"。
 * 现改为 Runtime 写哨兵 + messageDisplay 渲染时翻译，与 `[Error]` 前缀同一口径。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRendererI18n } from '../../src/renderer/src/i18n'
import { formatMessageContentForDisplay } from '../../src/renderer/src/chat/messageDisplay'
import { formatModelStallNotice, parseModelStallNotice } from '../../src/shared/runtime-notice'

const read = (path: string): string => readFileSync(resolve(path), 'utf8')

const stallMessage = (seconds: number) => ({
  role: 'assistant' as const,
  content: `\n\n[Error] ${formatModelStallNotice(seconds)}`,
  messageKind: 'incomplete' as const,
  messageSubtype: 'stream-error' as const,
  syntheticErrorOffset: 2
})

describe('模型停滞哨兵', () => {
  it('哨兵可往返，且不是哨兵的文本一律返回 null', () => {
    expect(parseModelStallNotice(formatModelStallNotice(120))).toBe(120)
    expect(parseModelStallNotice(formatModelStallNotice(59.6))).toBe(60)
    for (const foreign of ['429 Too Many Requests', '模型返回错误', '', 'openpipal:model-stall:abc']) {
      expect(parseModelStallNotice(foreign)).toBeNull()
    }
  })

  it('哨兵本身不含任何自然语言，两种界面语言下记录字节一致', () => {
    const notice = formatModelStallNotice(120)
    expect(notice).toBe('openpipal:model-stall:120')
    expect(/[一-鿿]/.test(notice)).toBe(false)
  })

  it('渲染层按当前语言翻译哨兵，并保留 [Error] 前缀的既有本地化', async () => {
    const i18n = await createRendererI18n('en')
    const english = formatMessageContentForDisplay(stallMessage(75), i18n.t)
    expect(english).toContain('75 seconds')
    expect(english).not.toContain('openpipal:model-stall')

    await i18n.changeLanguage('zh-CN')
    const chinese = formatMessageContentForDisplay(stallMessage(75), i18n.t)
    expect(chinese).toContain('75 秒')
    expect(chinese).not.toContain('openpipal:model-stall')
  })

  it('整分钟的阈值用分钟说——默认已是 5 分钟，"300 秒"读起来像机器在说话', async () => {
    const i18n = await createRendererI18n('zh-CN')
    expect(formatMessageContentForDisplay(stallMessage(300), i18n.t)).toContain('5 分钟')
    expect(formatMessageContentForDisplay(stallMessage(120), i18n.t)).toContain('2 分钟')
    // 不足两分钟或非整分钟仍按秒说，避免出现"1.25 分钟"这种读数
    expect(formatMessageContentForDisplay(stallMessage(90), i18n.t)).toContain('90 秒')

    await i18n.changeLanguage('en')
    expect(formatMessageContentForDisplay(stallMessage(300), i18n.t)).toContain('5 minutes')
  })

  it('网关原文（外部内容）仍逐字保留，不被当作哨兵处理', async () => {
    const i18n = await createRendererI18n('en')
    const raw = '429 Too Many Requests — provider said slow down'
    const display = formatMessageContentForDisplay({
      ...stallMessage(120),
      content: `\n\n[Error] ${raw}`
    }, i18n.t)
    expect(display).toContain(raw)
  })

  it('两个 Runtime 都写哨兵、都不引入界面语言资源', () => {
    for (const path of ['src/main/agent-runtime/pi-core-runtime.ts', 'src/main/pi-agent-service.ts']) {
      const source = read(path)
      expect(source).toContain('formatModelStallNotice(MODEL_STALL_TIMEOUT_MS / 1000)')
      expect(source).not.toContain('main-i18n')
      expect(source).not.toContain('tMain(')
    }
  })
})
