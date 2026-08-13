/**
 * P3c-2 单元测试 —— Voice 工具结果截断逻辑
 *
 * 运行: node --experimental-strip-types --test tests/unit/voice-tool-truncate.test.ts
 *
 * 这些是纯函数测试（无任何 electron / 业务依赖），跑得快、不需要 dev server。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { truncateForVoice, ARTIFACT_TOOLS, MAX_VOICE_RESULT_CHARS } from '../../src/main/voice-tool-truncate.ts'

test('Artifact 类工具回 ack + title + id，不喂原文', () => {
  const result = {
    content: [{ type: 'text', text: '<html>...10KB of HTML...</html>' }],
    details: { artifact: { id: 'artifact-123', title: 'SF 天气图表' } }
  }
  const output = truncateForVoice('create_artifact', result)
  const parsed = JSON.parse(output)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.id, 'artifact-123')
  assert.match(parsed.message, /SF 天气图表/)
  // id 必须回传给模型 —— 改稿时要用同一个 id 原地更新(语音模式之前丢了 id 才不能更新)
  assert.match(parsed.message, /artifact-123/)
  assert.match(parsed.message, /聊天面板/)
  // 不应包含 HTML 原文
  assert.ok(!parsed.message.includes('<html>'))
})

test('Artifact 工具无 id 时回落到只 ack + title', () => {
  const output = truncateForVoice('create_visualizer', {
    content: [{ type: 'text', text: '<svg/>' }],
    details: { visualizer: { title: '无ID图' } }
  })
  const parsed = JSON.parse(output)
  assert.equal(parsed.ok, true)
  assert.match(parsed.message, /无ID图/)
  assert.ok(!parsed.message.includes('<svg'))
})

test('generate_document 保留 filePath(把手在 details.args 里)', () => {
  // generate_document 在 ARTIFACT_TOOLS 里,但它的把手放 details.args,不是 details.document
  const output = truncateForVoice('generate_document', {
    content: [{ type: 'text', text: '📄 已生成...位置: /Users/x/.openpipal/outputs/报告.docx\n...10KB...' }],
    details: { args: { title: '季度报告', filePath: '/Users/x/.openpipal/outputs/报告.docx', fileType: 'docx' } }
  })
  const parsed = JSON.parse(output)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.filePath, '/Users/x/.openpipal/outputs/报告.docx')
  assert.match(parsed.message, /季度报告/)
  assert.match(parsed.message, /报告\.docx/)   // 路径要回传,供"打开/发送文件"等跟进
})

test('ARTIFACT_TOOLS 包含核心 artifact 工具', () => {
  assert.ok(ARTIFACT_TOOLS.has('create_visualizer'))
  assert.ok(ARTIFACT_TOOLS.has('create_artifact'))
  assert.ok(ARTIFACT_TOOLS.has('present_to_user'))
  assert.ok(ARTIFACT_TOOLS.has('generate_document'))
})

test('web_search 取前 5 条(含 url)，丢掉后面的', () => {
  const result = {
    content: [{ type: 'text', text: 'ignored' }],
    details: {
      results: [
        { title: '结果1', snippet: '内容1', url: 'a.com' },
        { title: '结果2', snippet: '内容2', url: 'b.com' },
        { title: '结果3', snippet: '内容3', url: 'c.com' },
        { title: '结果4', snippet: '内容4', url: 'd.com' },
        { title: '结果5', snippet: '内容5', url: 'e.com' },
        { title: '结果6', snippet: '内容6', url: 'f.com' }
      ]
    }
  }
  const output = truncateForVoice('web_search', result)
  for (const n of [1, 2, 3, 4, 5]) assert.match(output, new RegExp(`结果${n}`))
  assert.match(output, /a\.com/)   // url 也带上,便于模型引用/追问
  // 第 6 条应被丢弃
  assert.ok(!output.includes('结果6'))
})

test('web_search 无结果时返回 fallback', () => {
  const result = { content: [], details: { results: [] } }
  assert.equal(truncateForVoice('web_search', result), 'No results.')
})

test('普通工具：取 content[*].text 拼接', () => {
  const result = {
    content: [
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' }
    ],
    details: {}
  }
  const output = truncateForVoice('read_file', result)
  assert.equal(output, '第一段\n第二段')
})

test('超过 MAX_VOICE_RESULT_CHARS 的文本被截断并标注余量', () => {
  const longText = 'a'.repeat(MAX_VOICE_RESULT_CHARS + 500)
  const result = {
    content: [{ type: 'text', text: longText }]
  }
  const output = truncateForVoice('read_file', result)
  // 截断后总长度应远小于原文（前 MAX_VOICE_RESULT_CHARS 字符 + 截断提示）
  assert.ok(output.length < MAX_VOICE_RESULT_CHARS + 200)
  // 应包含截断提示
  assert.match(output, /截断了后续 500 字符/)
  assert.match(output, /聊天面板/)
})

test('content 为空且无 details：返回 JSON 化的结果对象', () => {
  const result = { content: [], details: { foo: 'bar' } }
  const output = truncateForVoice('unknown_tool', result)
  // 应该是 JSON 化的 details
  assert.ok(output.includes('foo'))
  assert.ok(output.includes('bar'))
})

test('非文本 content block 被过滤（image / audio 等）', () => {
  const result = {
    content: [
      { type: 'text', text: '保留这段' },
      { type: 'image', data: 'base64...' },
      { type: 'text', text: '也保留这段' }
    ]
  }
  const output = truncateForVoice('mixed_tool', result)
  assert.equal(output, '保留这段\n也保留这段')
})

test('字符串 result 直接被当文本处理', () => {
  const output = truncateForVoice('legacy_tool', 'a simple string result')
  assert.equal(output, 'a simple string result')
})
