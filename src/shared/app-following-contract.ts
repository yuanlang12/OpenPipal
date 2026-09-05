export interface AppSettingsState {
  enabled: boolean
  detected: string[]
  disabled: string[]
  browsers: string[]
  /** detected 里的键 → 给人看的名字；缺条目就显示键本身（macOS 上整张表是空的） */
  labels: Record<string, string>
}

export interface AppFollowingUpdateResult {
  ok: true
  enabled: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(item => typeof item === 'string')
}

export function parseAppSettingsState(value: unknown): AppSettingsState {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' ||
    !isStringArray(value.detected) || !isStringArray(value.disabled) || !isStringArray(value.browsers)) {
    throw new Error('OpenPipal app settings response is invalid')
  }
  // labels 是后加的字段：缺失按空表处理（旧服务端 / 插件对旧桌面端），形状不对才算坏响应
  if (value.labels !== undefined && !isStringRecord(value.labels)) {
    throw new Error('OpenPipal app settings response is invalid')
  }
  return {
    enabled: value.enabled,
    detected: [...value.detected],
    disabled: [...value.disabled],
    browsers: [...value.browsers],
    labels: { ...(value.labels ?? {}) }
  }
}

export function parseAppFollowingUpdateResult(
  value: unknown,
  expectedEnabled: boolean
): AppFollowingUpdateResult {
  if (!isRecord(value) || value.ok !== true || value.enabled !== expectedEnabled) {
    throw new Error('OpenPipal app following response is invalid')
  }
  return { ok: true, enabled: expectedEnabled }
}

export function parseAppListUpdateResult(value: unknown): { ok: true } {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error('OpenPipal disabled apps response is invalid')
  }
  return { ok: true }
}
