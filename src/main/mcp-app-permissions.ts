/**
 * MCP Apps permissions store
 *
 * 持久化用户对各 MCP server 的 App 权限授予状态:`~/.openpipal/mcp-app-permissions.json`
 *
 * 数据形态:
 * {
 *   "[\"v2\",\"<serverName>\",\"<opaque connection id>\"]": ["microphone", "clipboard-write"]
 * }
 *
 * 同一条 server 连接一旦授权,该连接所有的 App 都享受同一组权限(粒度到连接,不到 tool)。
 * 这样用户不会被同 server 的多个 App 反复打扰,也避免误把 App A 授权应用到 App B 上是因为
 * 粒度太粗导致——所以把粒度限定在 server,信任边界就是"我信任这个 server 的代码"。
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { dirname } from 'path'
import { getMcpAppPermissionsPath } from './credential-paths'

const STORE_PATH = getMcpAppPermissionsPath()

// iframe allow 属性能识别的标准能力 — 收到未知名称会被丢弃,防止任意 attribute 注入
const ALLOWED_CAPABILITIES = new Set([
  'microphone',
  'camera',
  'geolocation',
  'clipboard-read',
  'clipboard-write',
  'fullscreen',
  'autoplay',
])

type PermStore = Record<string, string[]>

let cache: PermStore | null = null

function load(): PermStore {
  if (cache) return cache
  if (!existsSync(STORE_PATH)) {
    cache = {}
    return cache
  }
  try {
    const fd = openSync(STORE_PATH, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0))
    let serialized: string
    try {
      serialized = readFileSync(fd, 'utf-8')
    } finally {
      closeSync(fd)
    }
    const raw = JSON.parse(serialized)
    cache = (raw && typeof raw === 'object') ? raw as PermStore : {}
  } catch {
    cache = {}
  }
  return cache
}

function save(store: PermStore): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true, mode: 0o700 })
  const fd = openSync(
    STORE_PATH,
    fsConstants.O_WRONLY
      | fsConstants.O_CREAT
      | fsConstants.O_TRUNC
      | (fsConstants.O_NOFOLLOW || 0),
    0o600
  )
  try {
    fchmodSync(fd, 0o600)
    writeFileSync(fd, JSON.stringify(store, null, 2), 'utf-8')
  } finally {
    closeSync(fd)
  }
  cache = store
}

function permissionKey(serverName: string, serverBinding: string): string | null {
  if (
    typeof serverName !== 'string'
    || serverName.length === 0
    || serverName.length > 16 * 1024
    || typeof serverBinding !== 'string'
    || serverBinding.length === 0
    || serverBinding.length > 128
  ) return null
  return JSON.stringify(['v2', serverName, serverBinding])
}

/** 返回某条具体 server 连接已被用户授予的权限列表。 */
export function getMcpAppPermissions(serverName: string, serverBinding: string): string[] {
  const key = permissionKey(serverName, serverBinding)
  return key ? load()[key] || [] : []
}

/** 把合法能力加入当前连接的授权清单；旧 name-only grant 不会被继承。 */
export function approveMcpAppPermissions(
  serverName: string,
  serverBinding: string,
  requested: string[]
): string[] {
  const key = permissionKey(serverName, serverBinding)
  if (!key || !Array.isArray(requested)) return []
  const store = { ...load() }
  const current = new Set(store[key] || [])
  for (const p of requested) {
    if (typeof p === 'string' && ALLOWED_CAPABILITIES.has(p)) current.add(p)
  }
  const next = Array.from(current)
  store[key] = next
  save(store)
  return next
}

/** 撤销某条具体 server 连接的所有权限(预留,UI 当前未触发) */
export function revokeMcpAppPermissions(serverName: string, serverBinding: string): void {
  const key = permissionKey(serverName, serverBinding)
  if (!key) return
  const store = { ...load() }
  delete store[key]
  save(store)
}

/** 把一组能力名字过滤为合法值,用于渲染 iframe allow 属性时防注入 */
export function sanitizeCapabilities(perms: string[]): string[] {
  return perms.filter(p => ALLOWED_CAPABILITIES.has(p))
}
