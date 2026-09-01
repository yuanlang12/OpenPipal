import { expect, test } from '@playwright/test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchIsolatedElectron } from './helpers'

const ARTIFACTS_DIR = 'tests/artifacts/acp-desktop-live'
const mainEntry = join(process.cwd(), 'out', 'main', 'index.js')
const adapterEntry = join(process.cwd(), 'openpipal-acp', 'dist', 'index.js')
const CUSTOM_AGENT_ID = 'a1b2c3d4-e5f6-4711-8899-aabbccddeeff'
const BASE_URL = 'http://127.0.0.1:3031'

/**
 * 真机验收：**真** Electron 主进程 + **真** :3031 HTTP/SSE + **真**适配器二进制经 stdio
 * 说 ACP，落的是真的会话文件。只有 HOME 是隔离的临时目录（不碰用户自己的
 * ~/.openpipal），模型指向一个不存在的端口——人格相关的每一步都发生在调模型之前，
 * 所以不花钱也能验完。
 */

interface AcpClient {
  child: ChildProcessWithoutNullStreams
  updates: any[]
  call(method: string, params?: unknown, timeoutMs?: number): Promise<any>
  stop(): void
}

function startAdapter(home: string): AcpClient {
  const child = spawn(process.execPath, [adapterEntry], {
    env: { ...process.env, HOME: home, USERPROFILE: home, OPENPIPAL_ACP_V2: '1', OPENPIPAL_BASE_URL: BASE_URL },
    stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams

  let buffer = ''
  let nextId = 1
  const pending = new Map<number, (message: any) => void>()
  const updates: any[] = []

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.method === 'session/update') updates.push(message.params)
      else if (message.method && message.id !== undefined) {
        // 反向请求（授权等）：真机这条路本轮用不到，礼貌地拒绝，别把适配器挂住
        child.stdin.write(`${JSON.stringify({
          jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } }
        })}\n`)
      } else if (pending.has(message.id)) {
        pending.get(message.id)!(message)
        pending.delete(message.id)
      }
    }
  })
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[adapter] ${chunk}`))

  return {
    child,
    updates,
    call(method, params, timeoutMs = 20_000) {
      const id = nextId++
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timeout waiting for ${method}`))
        }, timeoutMs)
        pending.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
      })
    },
    stop() { child.kill('SIGTERM') }
  }
}

/**
 * :3031 是固定端口。上一轮没退干净的实例会把它占住，新实例静默跳过 HTTP server——
 * 这时 /health 答的是那个**旧**进程，测试会一路跑到某个莫名其妙的地方才炸。
 * 所以开跑前先确认端口是空的，报错要说人话。
 */
async function assertPortFree(): Promise<void> {
  // 上一条用例 dispose 之后端口释放有几百毫秒延迟，先给它一点时间再判死
  const deadline = Date.now() + 10_000
  for (;;) {
    let occupied = false
    try {
      occupied = (await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) })).ok
    } catch {
      occupied = false // 连不上正是我们要的
    }
    if (!occupied) return
    if (Date.now() >= deadline) {
      throw new Error(
        ':3031 一直被另一个 OpenPipal 实例占住（多半是上一轮没退干净）。'
        + '先 `lsof -iTCP:3031 -sTCP:LISTEN -t | xargs kill -9` 再重跑。'
      )
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

/** 就绪的唯一可信信号：**我们这个 home** 里出现了本机令牌文件（旧进程答的 /health 骗不了它） */
async function waitForOurDesktop(home: string): Promise<string> {
  const tokenPath = join(home, '.openpipal', 'acp-mcp.token')
  await waitFor(async () => {
    try {
      return (await readFile(tokenPath, 'utf8')).trim().length > 0 && (await fetch(`${BASE_URL}/health`)).ok
    } catch { return false }
  }, '本实例的 :3031 就绪')
  return (await readFile(tokenPath, 'utf8')).trim()
}

async function readDesktopConversation(token: string, conversationId: string): Promise<any> {
  const response = await fetch(`${BASE_URL}/api/conversations/${encodeURIComponent(conversationId)}`, {
    headers: { 'X-OpenPipal-ACP-Token': token },
  })
  expect(response.ok, `读取会话 ${conversationId} 应当成功`).toBe(true)
  return response.json()
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error(`Timeout waiting for ${what}`)
}

test('真机：编辑器经 ACP 选自定义 Agent、外部改动回推、设置页看得到这条连接', async () => {
  test.setTimeout(180_000)
  await assertPortFree()

  const deadModel = {
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'openpipal-live-acceptance',
    model: 'openpipal-live-acceptance-model'
  }
  const { app, home, dispose } = await launchIsolatedElectron({
    entry: mainEntry,
    config: { role: 'general', modelConfig: deadModel }
  })
  let client: AcpClient | undefined

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // 真的把一个自定义 Agent 存到磁盘上（listWorkspaces 每次现扫，不缓存）
    const agentDir = join(home, '.openpipal', 'agents', CUSTOM_AGENT_ID)
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'meta.json'), JSON.stringify({
      id: CUSTOM_AGENT_ID,
      name: '法务助手',
      icon: '⚖️',
      description: '真机验收用',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }), 'utf8')
    await writeFile(join(agentDir, 'agent.md'), '你是一个法务助手。\n', 'utf8')

    const token = await waitForOurDesktop(home)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    client = startAdapter(home)

    // 1) 握手：真适配器 ↔ 真桌面端
    const init = await client.call('initialize', {
      protocolVersion: 2,
      info: { name: 'openpipal-live-acceptance', version: '1.0.0' },
      capabilities: {}
    })
    expect(init.result.protocolVersion).toBe(2)
    const inventory = init.result._meta['openpipal.io/agents']
    expect(inventory.agents.map((agent: any) => agent.id)).toContain(CUSTOM_AGENT_ID)

    // 2) 新会话：真的内置角色 + 真的自定义 Agent 一起出现在选择器里
    const cwd = join(home, 'live-acceptance')
    const created = await client.call('session/new', { cwd })
    const sessionId = created.result.sessionId
    expect(sessionId).toBeTruthy()
    const values = created.result.configOptions[0].options.map((option: any) => option.value)
    expect(values).toContain('general')
    expect(values).toContain(`agent:${CUSTOM_AGENT_ID}`)

    // 3) 选中自定义 Agent → 真的落到会话文件里
    const picked = await client.call('session/set_config_option', {
      sessionId, configId: 'openpipal.role', type: 'id', value: `agent:${CUSTOM_AGENT_ID}`
    })
    expect(picked.result.configOptions[0].currentValue).toBe(`agent:${CUSTOM_AGENT_ID}`)
    const stored = await readDesktopConversation(token, sessionId)
    expect(stored.workspaceId).toBe(CUSTOM_AGENT_ID)
    expect(stored.config.acp).toMatchObject({ adapter: 'openpipal-acp', protocolVersion: 2 })

    // 4) 外部（这里用桌面端同一条 HTTP 写入口）把人格改回内置角色
    client.updates.length = 0
    const external = await fetch(`${BASE_URL}/api/conversations/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-OpenPipal-ACP-Token': token },
      body: JSON.stringify({ role: 'design', workspaceId: null })
    })
    expect(external.status).toBe(200)

    // 5) 常驻推送：**一条消息都不发**，编辑器就该收到人格已变
    //    这正是"在桌面端改了，Zed 那边立刻跟着变"的场景
    await waitFor(
      () => client!.updates.some(u => u.update.sessionUpdate === 'config_option_update'),
      '桌面端改人格后的即时推送', 15_000
    )
    const pushed = client.updates.find(u => u.update.sessionUpdate === 'config_option_update')
    expect(pushed.update.configOptions[0].currentValue).toBe('design')
    const conversationAfter = await readDesktopConversation(token, sessionId)
    expect(conversationAfter.workspaceId).toBeUndefined()
    expect(conversationAfter.role).toBe('design')

    // 5b) 换人格就是换技能：推送这条路也必须重报命令列表，否则编辑器的斜杠菜单
    //     还停在上一个人格。updates 在 4) 之前刚清过，建会话那次的早就过去了——
    //     此刻再来一条 available_commands_update，只可能是这次换人格引发的。
    await waitFor(
      () => client!.updates.some(u => u.update.sessionUpdate === 'available_commands_update'),
      '换人格后重报命令列表', 15_000
    )

    // 5c) 编辑器连上之后才存的 Agent：initialize 拉的那张清单里没有它。
    //     修之前会被适配器当成非法值直接拒绝（用户视角：桌面端明明有，编辑器里选不了）。
    const lateAgentId = 'c0ffee00-1111-4222-8333-444455556666'
    const lateDir = join(home, '.openpipal', 'agents', lateAgentId)
    await mkdir(lateDir, { recursive: true })
    await writeFile(join(lateDir, 'meta.json'), JSON.stringify({
      id: lateAgentId,
      name: '刚存的助手',
      icon: '🆕',
      description: '连上之后才存的',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }), 'utf8')
    await writeFile(join(lateDir, 'agent.md'), '你是刚存的助手。\n', 'utf8')

    const lateSession = await client.call('session/new', { cwd: join(home, 'live-late-agent') })
    const lateSwitch = await client.call('session/set_config_option', {
      sessionId: lateSession.result.sessionId,
      configId: 'openpipal.role',
      type: 'id',
      value: `agent:${lateAgentId}`
    })
    expect(lateSwitch.error, '新存的 Agent 必须能选').toBeUndefined()
    expect(lateSwitch.result.configOptions[0].currentValue).toBe(`agent:${lateAgentId}`)
    expect((await readDesktopConversation(token, lateSession.result.sessionId)).workspaceId).toBe(lateAgentId)

    // 推送已经把状态对齐了，下一轮开跑前的对账就该是 no-op（不重复推同一件事）
    client.updates.length = 0
    await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '真机验收' }] })
    await waitFor(
      () => client!.updates.some(u => u.update.sessionUpdate === 'state_update' && u.update.state === 'idle'),
      '本轮结束'
    )
    expect(client.updates.filter(u => u.update.sessionUpdate === 'config_option_update')).toHaveLength(0)

    // 6) session/list 认得这条真会话
    const listed = await client.call('session/list', { cwd })
    expect(listed.result.sessions.map((s: any) => s.sessionId)).toContain(sessionId)

    // 7) 真的设置页里看得到这条连接
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setSize(1000, 900)
    })
    await page.getByRole('button', { name: '设置', exact: true }).last().click()
    await page.getByRole('button', { name: '连接', exact: true }).click()
    const panel = page.getByTestId('acp-connections')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(panel).toContainText('127.0.0.1:3031')
    await expect(panel).toContainText('openpipal-live-acceptance · ACP v2')
    await page.screenshot({ path: `${ARTIFACTS_DIR}/live-acp-connections.png` })
  } finally {
    client?.stop()
    await dispose()
  }
})

test('真机：斜杠命令落到模型、流式产物走 tool_call_content_chunk、session/list 真分页', async () => {
  test.setTimeout(240_000)
  await assertPortFree()

  const { startQaProvider, QA_PROVIDER_MODEL, QA_PROVIDER_TOKEN } =
    await import('../../scripts/qa/openai-compatible-fixture.mjs' as string)
  const provider = await startQaProvider({ port: 0 })
  const providerPort = (provider.address() as { port: number }).port
  const fixtureModel = {
    provider: 'custom',
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    apiKey: QA_PROVIDER_TOKEN,
    model: QA_PROVIDER_MODEL
  }

  const { app, home, dispose } = await launchIsolatedElectron({
    entry: mainEntry,
    config: { role: 'design', modelConfig: fixtureModel }
  })
  let client: AcpClient | undefined

  try {
    await (await app.firstWindow()).waitForLoadState('domcontentloaded')

    // 真的往技能目录里放一个技能
    const skillDir = join(home, '.openpipal', 'skills', 'live-report')
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'),
      '---\nname: live-report\ndescription: 真机验收用的周报技能\n---\n\n照着模板写周报。\n', 'utf8')

    const token = await waitForOurDesktop(home)

    client = startAdapter(home)
    await client.call('initialize', {
      protocolVersion: 2,
      info: { name: 'openpipal-live-commands', version: '1.0.0' },
      capabilities: {}
    })

    // 1) 真的 skill-manager 扫出来的技能报成了斜杠命令
    const cwd = join(home, 'live-commands')
    const created = await client.call('session/new', { cwd })
    const sessionId = created.result.sessionId
    await waitFor(
      () => client!.updates.some(u => u.update.sessionUpdate === 'available_commands_update'),
      'available_commands_update'
    )
    const commands = client.updates
      .filter(u => u.update.sessionUpdate === 'available_commands_update')
      .at(-1)!.update.availableCommands
    expect(commands.map((c: any) => c.name)).toContain('live-report')

    // 2) 点命令 = 桌面端 @技能：跑完一整轮，磁盘上留下的是改写后的措辞
    client.updates.length = 0
    await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/live-report 帮我做份周报' }] })
    await waitFor(
      () => client!.updates.some(u => u.update.sessionUpdate === 'state_update' && u.update.state === 'idle'),
      '第一轮结束', 60_000
    )
    const idle = client.updates.find(u => u.update.sessionUpdate === 'state_update' && u.update.state === 'idle')
    expect(idle.update.stopReason).toBe('end_turn')
    const stored = await readDesktopConversation(token, sessionId)
    const userMessage = stored.messages.find((m: any) => m.role === 'user' && m.messageKind !== 'runtime-context')
    expect(userMessage.content).toBe('请使用技能 <skill-request>live-report</skill-request> 完成以下任务：\n\n帮我做份周报')

    // 3) 真产物流：create_artifact 的正文走 tool_call_content_chunk
    client.updates.length = 0
    await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'QA_DESIGN_ARTIFACT 画一张图' }] })
    await waitFor(
      () => client!.updates.some(u => u.update.sessionUpdate === 'state_update' && u.update.state === 'idle'),
      '产物轮结束', 90_000
    )
    const chunks = client.updates.filter(u => u.update.sessionUpdate === 'tool_call_content_chunk')
    expect(chunks.length).toBeGreaterThan(0)
    const chunkToolCallIds = new Set(chunks.map(u => u.update.toolCallId))
    expect(chunkToolCallIds.size).toBe(1)
    expect(chunks.map(u => u.update.content.content.text).join('')).toContain('<svg')
    // v2 的 content 是替换语义：收尾那帧再带 content，就会把刚才流出去的正文整个抹掉
    const completion = client.updates
      .filter(u => u.update.sessionUpdate === 'tool_call_update' && u.update.status === 'completed')
      .at(-1)
    expect(completion, '产物那次调用必须有收尾').toBeTruthy()
    expect(completion.update.content).toBeUndefined()

    // 4) /goal：改的是会话状态，且真的驱动桌面端的 goal loop
    client.updates.length = 0
    await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/goal 把周报写完' }] })
    await waitFor(
      () => client!.updates.some(u => u.update.sessionUpdate === 'state_update' && u.update.state === 'idle'),
      '/goal 这一轮结束'
    )
    const withGoal = await readDesktopConversation(token, sessionId)
    expect(withGoal.config.goal).toMatchObject({ text: '把周报写完', maxTurns: 8, status: 'active' })

    // 下一轮普通对话跑完后，goal loop 会把状态判回来并落盘（fixture 不返 JSON →
    // GoalChecker 走"失败放过"，判定 done）——证明 ACP 设的目标真的进了那个循环
    client.updates.length = 0
    await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '继续' }] })
    await waitFor(async () => {
      const conv = await readDesktopConversation(token, sessionId)
      return conv.config?.goal?.status === 'done'
    }, 'goal loop 判定回写', 60_000)
    // 终态要说人话：用户在编辑器里设了目标，得知道它是达成了还是撞了上限
    const goalNotice = client.updates
      .map(u => u.update.content?.text || '')
      .join('')
    expect(goalNotice).toContain('目标已达成')

    await client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/goal clear' }] })
    await waitFor(async () => {
      const conv = await readDesktopConversation(token, sessionId)
      return conv.config?.goal === undefined
    }, '/goal clear 落盘')

    // 5) 真分页：55 条同 cwd 的 ACP 会话，翻两页不漏不重
    const pagedCwd = join(home, 'live-paging')
    const headers = { 'Content-Type': 'application/json', 'X-OpenPipal-ACP-Token': token }
    const pagedIds: string[] = []
    for (let i = 0; i < 55; i++) {
      const conv = await (await fetch(`${BASE_URL}/api/conversations`, {
        method: 'POST', headers, body: JSON.stringify({ title: `[ACP] paged ${i}`, role: 'general' })
      })).json() as { id: string }
      await fetch(`${BASE_URL}/api/conversations/${conv.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ config: { workingDir: pagedCwd, acp: { adapter: 'openpipal-acp' } } })
      })
      pagedIds.push(conv.id)
    }

    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const res = await client.call('session/list', { cwd: pagedCwd, ...(cursor ? { cursor } : {}) })
      expect(res.error).toBeUndefined()
      expect(res.result.sessions.length).toBeLessThanOrEqual(50)
      seen.push(...res.result.sessions.map((s: any) => s.sessionId))
      cursor = res.result.nextCursor
      pages += 1
      expect(pages).toBeLessThanOrEqual(4)
    } while (cursor)

    expect(pages).toBe(2)
    expect(seen.length).toBe(55)
    expect(new Set(seen).size).toBe(55)
    expect([...seen].sort()).toEqual([...pagedIds].sort())
  } finally {
    client?.stop()
    await dispose()
    await new Promise<void>(resolve => provider.close(() => resolve()))
  }
})

/**
 * 内置角色自带的技能，编辑器的斜杠菜单里也得有（此前只有模型的提示词里有）。
 *
 * 这条**不能**用 `entry: mainEntry` 起：那样 `app.getAppPath()` 是 `out/main`，
 * 仓库的 `resources/`（内置技能、system-agents）整个够不着，角色专属技能永远扫不到——
 * 那是测试脚手架的失真，不是产品行为。这里按用户真实的启动方式来：把仓库目录交给
 * Electron，由 `package.json` 的 main 决定入口，`getAppPath()` 才是仓库根。
 */
test('真机：内置角色的专属技能进得了编辑器的斜杠菜单，且不外溢到别的角色', async () => {
  test.setTimeout(120_000)
  await assertPortFree()

  const { app, home, dispose } = await launchIsolatedElectron({
    config: { role: 'teacher' }
  })
  let client: AcpClient | undefined

  try {
    await (await app.firstWindow()).waitForLoadState('domcontentloaded')
    const token = await waitForOurDesktop(home)
    const headers = { 'X-OpenPipal-ACP-Token': token }
    const skillsFor = async (query: string): Promise<string[]> => {
      const res = await fetch(`${BASE_URL}/api/skills${query}`, { headers })
      expect(res.ok, `/api/skills${query} 应当 200`).toBe(true)
      return ((await res.json()).skills as { name: string }[]).map(skill => skill.name)
    }

    // 真的 skill-manager + 真的 resources/system-agents/teacher/skills
    expect(await skillsFor('?role=teacher')).toContain('teacher-personal-style-authoring')
    // 别的角色和"不带 role"都不该看到它——角色专属不外溢
    expect(await skillsFor('?role=general')).not.toContain('teacher-personal-style-authoring')
    expect(await skillsFor('')).not.toContain('teacher-personal-style-authoring')
    // role 会被拼成 resources/system-agents/<role>/skills，只认名单里的
    expect((await fetch(`${BASE_URL}/api/skills?role=../../etc`, { headers })).status).toBe(400)

    // 端到端：适配器按会话角色取技能，编辑器拿到的命令列表里就有这一条
    client = startAdapter(home)
    await client.call('initialize', {
      protocolVersion: 2,
      info: { name: 'openpipal-live-role-skills', version: '1.0.0' },
      capabilities: {}
    })
    await client.call('session/new', { cwd: join(home, 'live-role-skills') })
    await waitFor(
      () => client!.updates.some(u => u.update.sessionUpdate === 'available_commands_update'),
      'available_commands_update'
    )
    const commands = client.updates
      .filter(u => u.update.sessionUpdate === 'available_commands_update')
      .at(-1)!.update.availableCommands
    expect(commands.map((c: any) => c.name)).toContain('teacher-personal-style-authoring')
  } finally {
    client?.stop()
    await dispose()
  }
})
