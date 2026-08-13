/**
 * 4a 单测 —— 豆包 AST v2 Protobuf 帧编解码
 *
 * 用一套**独立的** protobufjs mirror schema(字段号与被测模块一致,但单独声明)当 oracle:
 *   - 解码我们 encode 出来的 TranslateRequest,验证 event/字段落在正确的 field number 上
 *   - 反过来 craft 一条 TranslateResponse 喂给 decodeResponse,验证我们按对的 field number 读
 * 这样测的是**线格式兼容性**(与字节跳动服务端互通的前提),而非自证自洽。
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import protobuf from 'protobufjs'
import {
  encodeStartSession,
  encodeTaskRequest,
  encodeFinishSession,
  decodeResponse
} from '../../src/main/doubao-ast-frame.ts'

// 独立 oracle:只声明测试需要触达的字段,字段号照协议事实。
const MIRROR = `
syntax = "proto3";
package oracle;
message RequestMeta { string SessionID = 6; string ResourceID = 4; int32 Sequence = 7; }
message Audio { string format = 4; int32 rate = 7; bytes binary_data = 14; }
message ReqParams { string mode = 1; string source_language = 2; string target_language = 3; }
message TranslateRequest {
  RequestMeta request_meta = 1;
  int32 event = 2;
  Audio source_audio = 4;
  Audio target_audio = 5;
  ReqParams request = 6;
}
message ResponseMeta { string SessionID = 1; int32 StatusCode = 3; string Message = 4; }
message TranslateResponse {
  ResponseMeta response_meta = 1;
  int32 event = 2;
  bytes data = 3;
  string text = 4;
}
`
const oracle = protobuf.parse(MIRROR, { keepCase: true }).root
const OReq = oracle.lookupType('oracle.TranslateRequest')
const ORes = oracle.lookupType('oracle.TranslateResponse')
const dec = (buf: Uint8Array) => OReq.toObject(OReq.decode(buf), { bytes: Uint8Array, enums: Number, defaults: false }) as any

test('StartSession(s2s): event=100 + 16k 源音频 + 目标音频 + 语种落在正确字段号', () => {
  const buf = encodeStartSession({
    sessionId: 'sess-1', connectionId: 'conn-1', sequence: 0, resourceId: 'volc.service_type.10053',
    mode: 's2s', sourceLanguage: 'zh', targetLanguage: 'en'
  })
  const m = dec(buf)
  assert.equal(m.event, 100)
  assert.equal(m.request_meta.SessionID, 'sess-1')
  assert.equal(m.request_meta.ResourceID, 'volc.service_type.10053')
  assert.equal(m.source_audio.rate, 16000)
  assert.equal(m.request.mode, 's2s')
  assert.equal(m.request.source_language, 'zh')
  assert.equal(m.request.target_language, 'en')
  assert.ok(m.target_audio, 's2s 必须带 target_audio')
  assert.equal(m.target_audio.format, 'pcm')
})

test('StartSession(s2t): 不带 target_audio', () => {
  const buf = encodeStartSession({
    sessionId: 's', connectionId: 'c', sequence: 0, resourceId: 'r',
    mode: 's2t', sourceLanguage: 'en', targetLanguage: 'zh'
  })
  const m = dec(buf)
  assert.equal(m.event, 100)
  assert.equal(m.request.mode, 's2t')
  assert.equal(m.target_audio, undefined, 's2t 不应带 target_audio')
})

test('TaskRequest: event=200 + 音频走 source_audio.binary_data(field 14) 原样回放', () => {
  const audio = new Uint8Array([1, 2, 3, 250, 0, 128, 255])
  const buf = encodeTaskRequest(audio, { sessionId: 's', connectionId: 'c', sequence: 7 })
  const m = dec(buf)
  assert.equal(m.event, 200)
  assert.equal(m.request_meta.Sequence, 7)
  assert.deepEqual(Array.from(m.source_audio.binary_data), Array.from(audio))
})

test('FinishSession: event=102', () => {
  const buf = encodeFinishSession({ sessionId: 's', connectionId: 'c', sequence: 9 })
  assert.equal(dec(buf).event, 102)
})

test('decodeResponse: 按字段号读 event/text/data/状态/会话', () => {
  // craft 一条译文数据帧(654)
  const frame = ORes.encode(ORes.fromObject({
    response_meta: { SessionID: 'sess-1', StatusCode: 20000000, Message: 'OK' },
    event: 654,
    text: 'Hello everyone'
  })).finish()
  const r = decodeResponse(frame)
  assert.equal(r.event, 654)
  assert.equal(r.eventName, 'TranslationSubtitleResponse')
  assert.equal(r.text, 'Hello everyone')
  assert.equal(r.statusCode, 20000000)
  assert.equal(r.sessionId, 'sess-1')
})

test('decodeResponse: TTS 音频帧(352)data 以 Uint8Array 返回', () => {
  const pcm = new Uint8Array([10, 20, 30, 40])
  const frame = ORes.encode(ORes.fromObject({ event: 352, data: pcm })).finish()
  const r = decodeResponse(frame)
  assert.equal(r.event, 352)
  assert.equal(r.eventName, 'TTSResponse')
  assert.ok(r.data instanceof Uint8Array)
  assert.deepEqual(Array.from(r.data!), Array.from(pcm))
})
