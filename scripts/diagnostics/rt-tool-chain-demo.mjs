// 端到端演示:文字驱动真实 gpt-realtime-2(无麦克风),看它是否多工具链式(web_search → create_visualizer)。
// 镜像 app 的 create_response=false 手动接管:我们在 user 回合 + 每次 function_call_output 后发 response.create。
import WebSocket from 'ws'
import { readFileSync } from 'fs'
import { homedir } from 'os'

const c = JSON.parse(readFileSync(homedir() + '/.openpipal/config.json', 'utf8'))
const v = c.voiceConfig || {}
const url = `${(v.baseUrl || '').replace(/^http/, 'ws').replace(/\/+$/, '')}?model=${encodeURIComponent(v.model || '')}`

const TOOLS = [
  { type: 'function', name: 'web_search', description: '搜索互联网获取实时信息(天气/新闻/资料)', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { type: 'function', name: 'create_visualizer', description: '把数据画成图表/可视化,内联显示在聊天里。迭代修改时传上一次返回的 id,原地更新不新建。', parameters: { type: 'object', properties: { id: { type: 'string', description: '已有图的 id(改稿时传,原地更新)' }, title: { type: 'string' }, spec: { type: 'string', description: '图表内容描述' } }, required: ['title'] } }
]
const INSTR = '你通过实时语音和用户对话,回答口语化简短。完成一个任务可以连续调用多个工具:比如先 web_search 查,拿到结果再 create_visualizer 画,每步拿到结果直接继续下一步,不要停。'

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${v.apiKey}`, 'OpenAI-Beta': 'realtime=v1' } })
let turn = 1
const chainByTurn = { 1: [], 2: [] }   // 每个用户回合的工具调用顺序
let updateIdSeen = ''                    // 第2回合 create_visualizer 是否带上了原 id
let curRespHadCall = false
let finalText = ''
const done = (msg) => { console.log('\n=== 结果 ===\n' + msg); try { ws.close() } catch {}; process.exit(0) }
const hardStop = setTimeout(() => done(`超时。回合1工具链: [${chainByTurn[1].join(' → ') || '(无)'}] 回合2: [${chainByTurn[2].join(' → ') || '(无)'}]`), 60000)

const send = (o) => ws.send(JSON.stringify(o))

ws.on('open', () => console.log('WS OPEN — 连真实 gpt-realtime-2'))
ws.on('message', (d) => {
  let e; try { e = JSON.parse(d.toString()) } catch { return }
  switch (e.type) {
    case 'session.created':
      send({ type: 'session.update', session: { modalities: ['text'], instructions: INSTR, tools: TOOLS, tool_choice: 'auto', turn_detection: null } })
      break
    case 'session.updated':
      console.log('→ 发送用户回合(文字): "帮我查一下北京今天的天气，然后用图把它画出来"')
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我查一下北京今天的天气，然后用图把它画出来' }] } })
      send({ type: 'response.create' })
      break
    case 'response.created':
      curRespHadCall = false
      break
    case 'response.function_call_arguments.done': {
      curRespHadCall = true
      chainByTurn[turn].push(e.name)
      const argStr = e.arguments || ''
      if (turn === 2 && e.name === 'create_visualizer') {
        try { const a = JSON.parse(argStr); if (a.id) updateIdSeen = a.id } catch {}
      }
      console.log(`🔧 [回合${turn}] 工具: ${e.name}  args=${argStr.slice(0, 90)}`)
      // 回填 stub 结果(模拟工具执行),再 response.create 让它继续(可能链式调下一个)
      const stub = e.name === 'web_search'
        ? JSON.stringify({ ok: true, results: [{ title: '北京天气', snippet: '晴, 25°C, 西北风2级' }] })
        : JSON.stringify({ ok: true, id: 'visualizer-demo-1', message: '图已生成,显示在面板(id: visualizer-demo-1)' })
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: e.call_id, output: stub } })
      send({ type: 'response.create' })
      break
    }
    case 'response.text.delta':
      finalText += e.delta || ''
      break
    case 'response.done':
      // 这条 response 没有工具调用 = 模型给出了本回合最终回答
      if (!curRespHadCall) {
        if (turn === 1) {
          console.log(`💬 [回合1] 最终口语回答: ${finalText.trim().slice(0, 160)}`)
          // 第2回合:改稿 → 看模型是否复用上一个图的 id 原地更新
          turn = 2; finalText = ''
          console.log('\n→ 发送用户回合2(改稿): "把这个图改简洁一点"')
          send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '把这个图改简洁一点' }] } })
          send({ type: 'response.create' })
        } else {
          clearTimeout(hardStop)
          const chained = chainByTurn[1].length >= 2
          const inPlace = updateIdSeen === 'visualizer-demo-1'
          done(
            `【criterion 1 多工具链式】回合1: [${chainByTurn[1].join(' → ')}] → ${chained ? '✅ 是' : '❌ 否'}\n` +
            `【criterion 2 改稿原地更新】回合2: [${chainByTurn[2].join(' → ')}],create_visualizer 带的 id = "${updateIdSeen || '(无)'}" → ${inPlace ? '✅ 复用了原 id,原地更新' : '❌ 没复用原 id'}\n` +
            `【criterion 5 口语化】回合2 回答: ${finalText.trim().slice(0, 160)}`
          )
        }
      }
      break
    case 'error':
      console.log('SERVER ERROR:', JSON.stringify(e.error || e).slice(0, 200))
      break
  }
})
ws.on('error', (e) => done('WS ERROR: ' + e.message))
