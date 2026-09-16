/**
 * 事实前移，拦截只剩真边界（2026-09-11 三张截图的根因）：
 *   1. get_environment 不再要求"做事前先调"；orb 时运行时上下文自带一行，其它模式什么都不加
 *   2. create_artifact 结果直接带文件路径——模型不必去翻 conversations 目录找自己的作品
 *   3. render_artifact 的边界与 read/write 同一口径：数据目录 + 本会话工作目录；截图是给模型看的
 *   4. 两条租户拒绝文案都写明替代路径（技能清单在 <available_skills>；自己的产物在哪）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-facts-'))
process.env.HOME = HOME
process.env.OPENPIPAL_ISOLATED_HOME = HOME

const env = vi.hoisted(() => ({ mode: 'undocked' as 'orb' | 'docked' | 'undocked' }))
vi.mock('../../src/main/window-tracker', () => ({
  getCurrentConfig: () => ({ displayName: 'Finder', processName: 'Finder' }),
  isDockedToTargetApp: () => false,
  getEnvironmentSnapshot: () => ({ mode: env.mode, foregroundApp: '', isFullscreen: env.mode === 'orb', connected: env.mode !== 'undocked' })
}))
vi.mock('../../src/main/sandbox-manager', () => ({ isSandboxed: () => true }))

const { createRenderArtifactTool } = await import('../../src/main/openpipal-product-tools')
const { buildOpenPipalRuntimeContext } = await import('../../src/main/agent-runtime/openpipal-prompt-core')
const { artifactFilePath } = await import('../../src/main/artifact-store')
const { assessToolScope } = await import('../../src/main/pi-security')

const productToolsSrc = fs.readFileSync('src/main/openpipal-product-tools.ts', 'utf8')

describe('环境：宿主主动说，模型不必先问', () => {
  it('get_environment 描述不再要求做事前先调', () => {
    const desc = productToolsSrc.slice(productToolsSrc.indexOf("name: 'get_environment'"), productToolsSrc.indexOf("name: 'present_to_user'"))
    expect(desc).not.toContain('先调本工具确认环境')
    expect(desc).toContain('不必在做事前先调本工具')
  })

  it('orb 时运行时上下文带一行提示；undocked/docked 一个字都不加', () => {
    env.mode = 'undocked'
    expect(buildOpenPipalRuntimeContext()).not.toContain('悬浮球')
    env.mode = 'docked'
    expect(buildOpenPipalRuntimeContext()).not.toContain('悬浮球')
    env.mode = 'orb'
    const ctx = buildOpenPipalRuntimeContext()
    expect(ctx).toContain('悬浮球（orb）模式')
    expect(ctx).toContain('present_to_user')
    env.mode = 'undocked'
  })
})

describe('产物：文件在哪直接说', () => {
  it('artifactFilePath 按类型给扩展名，落在本会话产物目录', () => {
    const p = artifactFilePath('conv-1', 'artifact-123', 'html')
    expect(p).toBe(path.join(HOME, '.openpipal', 'conversations', 'artifacts', 'conv-1', 'artifact-123.html'))
    expect(artifactFilePath('conv-1', 'artifact-9', 'code', 'jsx')).toMatch(/artifact-9\.jsx$/)
  })

  it('create_artifact 的结果文本紧跟 (id: …) 之后带"文件: <路径>"', () => {
    expect(productToolsSrc).toMatch(/\(id: \$\{artifactId\}\)\$\{fileNote\}/)
    expect(productToolsSrc).toMatch(/const fileNote = conversationId \? `\\n文件: \$\{artifactFilePath\(conversationId, artifactId, p\.type, artifactLanguage\)\}` : ''/)
  })
})

describe('render_artifact：边界与截图', () => {
  it('本会话工作目录内的路径放行（不存在才报文件不存在），目录外仍拒绝并说明边界', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openpipal-render-wd-'))
    const tool = createRenderArtifactTool('conv-1', work)
    const inside: any = await tool.execute('c1', { path: path.join(work, 'nope.html') } as any, undefined as any, undefined as any, undefined as any)
    expect(inside.content[0].text).toContain('文件不存在')
    const outside: any = await tool.execute('c2', { path: path.join(os.tmpdir(), 'elsewhere', 'x.html') } as any, undefined as any, undefined as any, undefined as any)
    expect(outside.content[0].text).toContain('本会话工作目录')
    expect(outside.content[0].text).toContain(work)
  })

  it('截图文案说明图是给模型看的，且区分整页/首屏；不再写"供人工/导出查看"', () => {
    const body = productToolsSrc.slice(productToolsSrc.indexOf('export function createRenderArtifactTool'), productToolsSrc.indexOf('const execFileAsync'))
    expect(body).not.toContain('供人工/导出查看')
    expect(body).toContain('已随本结果附上——看图核对版式、图形、文案位置')
    expect(body).toContain('整页 1280×${shotHeight}')
    // 2026-09-11 真机实测：没这两项，macOS 把隐藏窗钳在屏幕工作区内（首屏只截到 1280×839）
    expect(body).toContain('useContentSize: true, enableLargerThanScreen: true')
    expect(body).toContain('画对没画对只在图里')
    // 2026-09-11 真机实测：6000 高整页缩成一张 JPEG 超上限被跳过，模型只好 cp 出来自己裁成 5 段再 read
    expect(body).toContain('自上而下切成 ${imageBlocks.length} 段')
    expect(body).toContain('用 read 工具读它就能看图')
    expect(body).toContain('以下没截到')
  })

  it('长页按段截：视口不动、CDP 从 scroll_y 起截 5400 高；截到哪与下一次传什么写进结果', () => {
    const body = productToolsSrc.slice(productToolsSrc.indexOf('export function createRenderArtifactTool'), productToolsSrc.indexOf('const execFileAsync'))
    // 2026-09-12 实测：把窗拉高一次截完，Retina 下 8192 以上 capturePage 报 UnknownVizError；CDP clip 不动窗口就没这个顶
    expect(body).not.toContain('setContentSize(1280, shotHeight)')
    expect(body).toContain('captureBeyondViewport: true')
    expect(body).toContain('const SHOT_CAP = 5400')
    expect(body).toContain("scroll_y: Type.Optional(Type.Number(")
    expect(body).toContain('要看后面再调一次并传 scroll_y: ${shotEnd}')
    expect(body).toContain('本段 ${scrollY}–${shotEnd}')
    // 续截的段另存文件，不覆盖第一段
    expect(body).toContain("`${shotName}${scrollY > 0 ? `.y${scrollY}` : ''}.png`")
    // 宿主截不到是宿主的事，不进让模型修的 problems 清单
    expect(body).toContain('整页截图失败（${clipFailed}），只截到首屏')
  })
})

describe('outputs 按会话分目录：自己的随便列，根与别的会话拦枚举，具体文件不拦', () => {
  const outputs = path.join(HOME, '.openpipal', 'outputs')
  fs.mkdirSync(path.join(outputs, '.self-check'), { recursive: true })
  fs.mkdirSync(path.join(outputs, 'conv-1', '.self-check'), { recursive: true })
  fs.mkdirSync(path.join(outputs, 'conv-2'), { recursive: true })
  const scope = { conversationId: 'conv-1', workingDir: path.join(HOME, 'work') }
  const own = path.join(outputs, 'conv-1')

  it('cp 具体截图文件再 ls 工作目录里的副本：放行（2026-09-11 实撞的误杀）', () => {
    expect(assessToolScope('bash', { command: 'cp ~/.openpipal/outputs/.self-check/report.png shot.png && ls -la shot.png' }, scope)).toBeNull()
    expect(assessToolScope('bash', { command: `sips -g pixelHeight ${outputs}/.self-check/report.png` }, scope)).toBeNull()
  })

  it('本会话自己的产物目录：bash 与结构化发现工具都随便列', () => {
    for (const command of [`ls ${own}/`, 'ls -la ~/.openpipal/outputs/conv-1/.self-check', `find ${own} -name "*.png"`, `ls ${own}`]) {
      expect(assessToolScope('bash', { command }, scope), command).toBeNull()
    }
    expect(assessToolScope('ls', { path: own }, scope)).toBeNull()
    expect(assessToolScope('find', { path: path.join(own, '.self-check') }, scope)).toBeNull()
  })

  it('outputs 根、根下历史子目录、别的会话目录：拒绝，文案带本会话自己的目录', () => {
    for (const command of ['ls -la ~/.openpipal/outputs/.self-check/', `ls ${outputs}/.self-check`, `find ${outputs} -name "*.png"`, `ls ${outputs}/conv-2/`, 'ls ~/.openpipal/outputs/']) {
      const r = assessToolScope('bash', { command }, scope)
      expect(r?.level, command).toBe('risky')
      expect(r?.reason).toContain(`本会话自己的产物在 ${own}/`)
    }
    expect(assessToolScope('ls', { path: outputs }, scope)?.level).toBe('risky')
    expect(assessToolScope('ls', { path: path.join(outputs, 'conv-2') }, scope)?.reason).toContain(`本会话自己的产物在 ${own}/`)
  })

  it('没有会话 id（定时任务面）：根照旧拒绝，文案不指向任何目录', () => {
    const r = assessToolScope('bash', { command: `ls ${outputs}/` }, { workingDir: path.join(HOME, 'work') })
    expect(r?.level).toBe('risky')
    expect(r?.reason).not.toContain('本会话自己的产物在')
  })
})

describe('租户拒绝文案带替代路径', () => {
  const root = path.join(HOME, '.openpipal')
  fs.mkdirSync(path.join(root, 'conversations', 'artifacts', 'conv-1'), { recursive: true })
  fs.mkdirSync(path.join(root, 'skills'), { recursive: true })

  // 租户边界在 assessToolScope（authorizeToolCall 先于 classifyToolRisk 调它）；
  // bash 守卫只认 `~/.openpipal/...` 或 `/Users/<u>/.openpipal/...` 这两种写法（截图里模型就是这么写的）
  const scope = { conversationId: 'conv-1', workingDir: path.join(HOME, 'work') }

  it('枚举整个数据目录：告诉模型技能清单已在 <available_skills> 里', () => {
    const r = assessToolScope('bash', { command: 'ls ~/.openpipal/ 2>/dev/null; ls ~/.openpipal/skills/ | head -50' }, scope)
    expect(r?.level).toBe('risky')
    expect(r?.reason).toContain('<available_skills>')
    expect(r?.reason).toContain('按 location 直接 read')
  })

  it('扫别的对话目录：仍拒绝，且文案指向本会话产物与 create_artifact 的文件路径', () => {
    const r = assessToolScope('bash', { command: 'ls -la ~/.openpipal/conversations/artifacts/' }, scope)
    expect(r?.level).toBe('risky')
    expect(r?.reason).toContain('禁止扫描其他对话数据')
    expect(r?.reason).toContain(`本会话自己的产物在 ${path.join(root, 'conversations', 'artifacts', 'conv-1')}/`)
    expect(r?.reason).toContain('create_artifact 结果里也带文件路径')
    // 自己的产物目录不拦
    expect(assessToolScope('bash', { command: 'ls -la ~/.openpipal/conversations/artifacts/conv-1/' }, scope)).toBeNull()
  })
})
