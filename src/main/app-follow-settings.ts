import { loadConfig, saveConfig } from './config-manager'

let cachedFollowingEnabled: boolean | null = null
let cachedDisabledApps: Set<string> | null = null
let cachedDetectedApps: Set<string> | null = null
let cachedDetectedAppLabels: Record<string, string> | null = null

function ensureSettingsCache(): void {
  if (cachedFollowingEnabled !== null && cachedDisabledApps && cachedDetectedApps && cachedDetectedAppLabels) return
  const config = loadConfig()
  // 默认关闭：只有用户在「设置 → 应用」里打开过才跟随（2026-09-02 所有者决定，产品不再主打贴边跟随）
  cachedFollowingEnabled = config.appFollowingEnabled === true
  cachedDisabledApps = new Set(config.disabledApps || [])
  cachedDetectedApps = new Set(config.detectedApps || [])
  cachedDetectedAppLabels = { ...(config.detectedAppLabels || {}) }
}

export function isAppFollowingEnabled(): boolean {
  ensureSettingsCache()
  return cachedFollowingEnabled!
}

export function setAppFollowingEnabled(enabled: boolean): void {
  const config = { ...loadConfig(), appFollowingEnabled: enabled }
  saveConfig(config)
  cachedFollowingEnabled = enabled
}

export function getDisabledApps(): string[] {
  ensureSettingsCache()
  return Array.from(cachedDisabledApps!)
}

export function getDetectedApps(): string[] {
  ensureSettingsCache()
  return Array.from(cachedDetectedApps!)
}

/**
 * 键 → 给人看的名字。只有键与名字不同时才有条目：macOS 上进程名就是应用名，这张表是空的；
 * Windows 上键是 exe 主文件名（WINWORD），名字取自版本信息（Microsoft Word）。
 */
export function getDetectedAppLabels(): Record<string, string> {
  ensureSettingsCache()
  return { ...cachedDetectedAppLabels! }
}

export function setDisabledApps(apps: string[]): void {
  const config = { ...loadConfig(), disabledApps: apps }
  saveConfig(config)
  cachedDisabledApps = new Set(apps)
}

/**
 * 记录检测到的应用。`label` 是给人看的名字，与键相同或没给就不存——设置页拿不到条目时
 * 直接显示键，和历史行为一样。名字随应用更新 / 系统语言变化时会被最新的一次覆盖。
 */
export function addDetectedApp(appName: string, label?: string): void {
  ensureSettingsCache()
  const nextLabel = label && label.trim() && label.trim() !== appName ? label.trim() : undefined
  const known = cachedDetectedApps!.has(appName)
  const labelUnchanged = nextLabel === undefined || cachedDetectedAppLabels![appName] === nextLabel
  if (known && labelUnchanged) return
  const nextDetectedApps = new Set(cachedDetectedApps!)
  nextDetectedApps.add(appName)
  const nextLabels = { ...cachedDetectedAppLabels! }
  if (nextLabel !== undefined) nextLabels[appName] = nextLabel
  const config = {
    ...loadConfig(),
    detectedApps: Array.from(nextDetectedApps),
    ...(Object.keys(nextLabels).length > 0 ? { detectedAppLabels: nextLabels } : {})
  }
  saveConfig(config)
  cachedDetectedApps = nextDetectedApps
  cachedDetectedAppLabels = nextLabels
}

export function isAppDisabled(appName: string): boolean {
  ensureSettingsCache()
  return cachedDisabledApps!.has(appName)
}

export function shouldFollowDetectedApp(appName: string): boolean {
  return isAppFollowingEnabled() && !isAppDisabled(appName)
}

export function resetAppFollowSettingsCacheForTests(): void {
  cachedFollowingEnabled = null
  cachedDisabledApps = null
  cachedDetectedApps = null
  cachedDetectedAppLabels = null
}
