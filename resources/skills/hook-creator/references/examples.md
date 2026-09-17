# 规则范例

三条都是纯逻辑，可以直接照抄改条件。

## 1. 读成绩表前先遮名字（tool_result）

用户说："以后读成绩表先把学生名字遮掉。"

```ts
// hooks/mask-names-in-grades.ts
import type { HookAPI } from 'openpipal/hooks'

export const description = '读成绩表前先遮名字'

export default function (hook: HookAPI) {
  hook.on('tool_result', (event) => {
    if (event.toolName !== 'read' && event.toolName !== 'bash') return
    const target = String(event.input.path ?? event.input.command ?? '')
    if (!/成绩|grade|score/i.test(target)) return
    let n = 0
    const mask = (text: string) => text.replace(/[一-龥]{2,4}(?=[\s,，\t\d])/g, () => `学生${++n}`)
    return {
      content: event.content.map((block) => (block.type === 'text' ? { ...block, text: mask(block.text) } : block))
    }
  })
}
```

## 2. 不许跑危险命令（tool_call 拦下）

用户说："别再跑 rm -rf 这种命令了。"

```ts
// hooks/no-destructive-commands.ts
import type { HookAPI } from 'openpipal/hooks'

export const description = '不跑 rm -rf、git push --force 这类危险命令'

const DANGEROUS = [/\brm\s+-[a-z]*r[a-z]*f/i, /\bgit\s+push\b.*--force/i, /\bmkfs\b/i]

export default function (hook: HookAPI) {
  hook.on('tool_call', (event) => {
    if (event.toolName !== 'bash') return
    const command = typeof event.input.command === 'string' ? event.input.command : ''
    if (DANGEROUS.some((re) => re.test(command))) {
      return { block: true, reason: `命令里有危险操作：${command}` }
    }
  })
}
```

## 3. python 一律走项目的 .venv（tool_call 改参）

用户说："以后跑 python 都用 .venv 里的。"

```ts
// hooks/python-uses-venv.ts
import type { HookAPI } from 'openpipal/hooks'

export const description = 'python 一律用 .venv 里的解释器'

export default function (hook: HookAPI) {
  hook.on('tool_call', (event) => {
    if (event.toolName !== 'bash') return
    const command = typeof event.input.command === 'string' ? event.input.command : ''
    // 只改行首或 && 之后紧跟的 python/python3/pip，别碰引号里的
    event.input.command = command.replace(/(^|&&\s*|;\s*)(python3?|pip3?)\b/g, '$1.venv/bin/$2')
  })
}
```

## 4. 每轮开工先加一句提示（before_agent_start）

用户说："以后每次都提醒你：答案要给小学生看得懂。"

```ts
// hooks/kid-friendly-answers.ts
import type { HookAPI } from 'openpipal/hooks'

export const description = '回答一律要小学生看得懂'

// 追加的文字每轮一模一样，不放时间和随机数
const NOTE = '\n\n<user-rule>回答要让小学生看得懂：短句、不用术语、先给结论再举例。</user-rule>'

export default function (hook: HookAPI) {
  hook.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + NOTE }))
}
```

## 5. 改完 Python 文件就自动跑测试（tool_result + ctx.callTool）

用户说："以后每次改完代码都跑一下测试再告诉我。"

```ts
// hooks/run-tests-after-edit.ts
import type { HookAPI } from 'openpipal/hooks'

export const description = '改完 .py 文件自动跑一遍 pytest'

export default function (hook: HookAPI) {
  hook.on('tool_result', async (event, ctx) => {
    if (event.toolName !== 'write' && event.toolName !== 'edit') return
    if (event.isError || !ctx.callTool) return
    const path = typeof event.input.path === 'string' ? event.input.path : ''
    if (!path.endsWith('.py') || path.includes('/test')) return
    let summary: string
    try {
      const r = await ctx.callTool('bash', { command: 'pytest -q 2>&1 | tail -5', timeout: 120 })
      summary = r.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n').trim()
    } catch (error) {
      // 被安全审核拒绝等情况：不让规则因此失效，把原因告诉模型就行
      summary = `没跑成：${(error as Error).message}`
    }
    return {
      content: [...event.content, { type: 'text', text: `\n[规则：改完自动跑测试]\n${summary}` }]
    }
  })
}
```

## 6. 改了代码却没跑测试，下一轮开工先提醒（agent_end + ctx.store + before_agent_start）

用户说："要是改了代码没跑测试，下次开始前先提醒我。"

```ts
// hooks/remind-tests-next-round.ts
import type { HookAPI } from 'openpipal/hooks'

export const description = '改了代码却没跑测试，下一轮开工先提醒'

// 追加的文字本身固定；只在"欠着测试"那几轮出现
const REMINDER = '\n\n<user-rule>上一轮改了代码但没有跑测试。这一轮先把测试跑一遍，再继续。</user-rule>'
const CODE_FILE = /\.(py|ts|tsx|js|jsx)$/i
const TEST_COMMAND = /\b(pytest|vitest|jest|npm test|pnpm test|go test|cargo test)\b/

export default function (hook: HookAPI) {
  // 收工时记账：这轮有没有改代码、有没有跑测试
  hook.on('agent_end', async (event, ctx) => {
    if (event.outcome !== 'completed') return
    const edited = event.toolCalls.some((call) =>
      (call.toolName === 'write' || call.toolName === 'edit') && !call.isError && CODE_FILE.test(String(call.input.path ?? ''))
    )
    const tested = event.toolCalls.some((call) => call.toolName === 'bash' && TEST_COMMAND.test(String(call.input.command ?? '')))
    await ctx.store.set('owesTests', edited && !tested)
  })
  // 下一轮开工时看账
  hook.on('before_agent_start', async (event, ctx) => {
    if (!(await ctx.store.get<boolean>('owesTests'))) return
    return { systemPrompt: event.systemPrompt + REMINDER }
  })
}
```

