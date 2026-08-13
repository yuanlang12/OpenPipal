import WebSocket from 'ws'
import { readFileSync } from 'fs'
import { homedir } from 'os'
const c = JSON.parse(readFileSync(homedir()+'/.openpipal/config.json','utf8'))
const v = c.voiceConfig || {}
const base = (v.baseUrl||'').replace(/^http/,'ws').replace(/\/+$/,'')
const url = `${base}?model=${encodeURIComponent(v.model||'')}`
console.log('connecting:', base, 'model:', v.model)
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${v.apiKey}`, 'OpenAI-Beta': 'realtime=v1' } })
const t = setTimeout(()=>{ console.log('TIMEOUT (no session.created in 8s)'); ws.close(); process.exit(0) }, 8000)
ws.on('open', ()=> console.log('WS OPEN'))
ws.on('message', d => { try { const e = JSON.parse(d.toString()); console.log('EVENT:', e.type); if (e.type==='session.created'){ console.log('✅ session.created — headless realtime VIABLE'); clearTimeout(t); ws.close(); process.exit(0) } if (e.type==='error'){ console.log('SERVER ERROR:', JSON.stringify(e.error||e).slice(0,200)); clearTimeout(t); ws.close(); process.exit(0) } } catch {} })
ws.on('error', e => { console.log('WS ERROR:', e.message); clearTimeout(t); process.exit(0) })
ws.on('close', (code)=> console.log('WS CLOSED code=', code))
