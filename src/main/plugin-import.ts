/**
 * 插件安装 —— main 进程内核
 *
 * 两种来源(与技能导入同款):本地文件夹 / GitHub 仓库链接,GitHub 下载复用
 * skill-import 的 downloadGithubRepo(codeload tar.gz + /usr/bin/tar)。
 *
 * 一次调用完成 定位→校验→落盘→刷新:插件是单一安装单元,不需要技能导入那种
 * 逐项勾选的两阶段流程。同名冲突时返回 needsOverwrite,UI 确认后带 overwrite 重调。
 */

import { existsSync, statSync, readdirSync, mkdirSync, rmSync, cpSync, readFileSync } from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import {
  parsePluginManifest,
  getPluginsRootDir,
  listPlugins,
  removePlugin,
  setPluginDisabled,
  type PluginInfo
} from './plugin-manager'
import { downloadGithubRepo } from './skill-import'
import { reloadSkills } from './skill-manager'
import { reloadMcpServers } from './mcp-manager'
import { mainError, tMain, type MainErrorPayload } from './main-i18n'

export type PluginInstallSource =
  | { type: 'folder'; path: string }
  | { type: 'github'; url: string }

export interface InstalledPluginSummary {
  name: string
  version?: string
  skillCount: number
  mcpServerCount: number
  warnings: string[]
}

export type PluginInstallResult =
  | { ok: true; installed: InstalledPluginSummary[]; skipped: { name: string; reason: string }[] }
  | ({ ok: false; needsOverwrite?: boolean; conflictNames?: string[] } & MainErrorPayload)

// ---- 定位插件根:来源目录自身,或(仓库聚合形态)其直接子目录 ----

interface PluginCandidateDir {
  dir: string
  name: string
  invalid?: string
}

function probeManifest(dir: string): PluginCandidateDir | null {
  const manifestPath = path.join(dir, 'plugin.json')
  if (!existsSync(manifestPath)) return null
  try {
    const parsed = parsePluginManifest(readFileSync(manifestPath, 'utf-8'))
    if (!parsed.manifest) return { dir, name: path.basename(dir), invalid: parsed.invalid || tMain('toolsHub.plugins.errors.manifestInvalid') }
    return { dir, name: parsed.manifest.name }
  } catch (err: any) {
    return { dir, name: path.basename(dir), invalid: tMain('toolsHub.plugins.errors.readManifestFailed', { detail: err?.message || String(err) }) }
  }
}

function locatePluginDirs(rootDir: string): PluginCandidateDir[] {
  const atRoot = probeManifest(rootDir)
  if (atRoot) return [atRoot]
  // 仓库聚合形态:根目录没有 plugin.json,但直接子目录里有(一仓多插件)
  try {
    return readdirSync(rootDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => probeManifest(path.join(rootDir, e.name)))
      .filter((c): c is PluginCandidateDir => c !== null)
  } catch {
    return []
  }
}

// ---- 安装 ----

export async function installPlugin(
  source: PluginInstallSource,
  opts: { overwrite?: boolean } = {}
): Promise<PluginInstallResult> {
  let sourceDir: string
  let tempDir: string | undefined

  if (source.type === 'folder') {
    if (!source.path || !existsSync(source.path) || !statSync(source.path).isDirectory()) {
      return { ok: false, ...mainError('toolsHub.plugins.errors.notAFolder') }
    }
    sourceDir = path.resolve(source.path)
  } else {
    const dl = await downloadGithubRepo(source.url, `plugin-${randomUUID()}`)
    if (!dl.ok) return dl
    sourceDir = dl.repoDir
    tempDir = dl.tempDir
  }

  const cleanup = (): void => {
    if (tempDir) { try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }

  try {
    const candidates = locatePluginDirs(sourceDir)
    if (candidates.length === 0) {
      return { ok: false, ...mainError('toolsHub.plugins.errors.noPluginFound') }
    }

    const valid = candidates.filter(c => !c.invalid)
    const skipped = candidates.filter(c => c.invalid).map(c => ({ name: c.name, reason: c.invalid! }))
    if (valid.length === 0) {
      return { ok: false, ...mainError('toolsHub.plugins.errors.validationFailed', { detail: skipped.map(s => `${s.name}(${s.reason})`).join('; ') }) }
    }

    // 同名冲突整体先问一次,避免"装了一半再问"的中间态
    const existing = new Set(listPlugins().map(p => p.name))
    const conflicts = valid.filter(c => existing.has(c.name)).map(c => c.name)
    if (conflicts.length > 0 && !opts.overwrite) {
      return {
        ok: false,
        needsOverwrite: true,
        conflictNames: conflicts,
        ...mainError('toolsHub.plugins.errors.nameConflict', { names: conflicts.join(tMain('common.listSeparator')) })
      }
    }

    const root = getPluginsRootDir()
    mkdirSync(root, { recursive: true })
    const installed: InstalledPluginSummary[] = []
    for (const c of valid) {
      const target = path.join(root, c.name)
      try {
        if (existsSync(target)) rmSync(target, { recursive: true, force: true })
        cpSync(c.dir, target, { recursive: true })
      } catch (err: any) {
        skipped.push({ name: c.name, reason: tMain('toolsHub.plugins.errors.writeFailed', { detail: err?.message || String(err) }) })
        continue
      }
      installed.push({ name: c.name, version: undefined, skillCount: 0, mcpServerCount: 0, warnings: [] })
    }

    if (installed.length === 0) {
      return { ok: false, ...mainError('toolsHub.plugins.errors.installFailed', { detail: skipped.map(s => `${s.name}(${s.reason})`).join('; ') }) }
    }

    // 落盘后按正式扫描回填组件统计(以 plugin-manager 的校验结果为准)
    const infoByName = new Map(listPlugins().map(p => [p.name, p]))
    for (const item of installed) {
      const info = infoByName.get(item.name)
      if (info) {
        item.version = info.version
        item.skillCount = info.skillNames.length
        item.mcpServerCount = info.mcpServerNames.length
        item.warnings = info.warnings
      }
    }

    await refreshAfterPluginChange(installed.some(i => i.mcpServerCount > 0))
    console.log(`[Plugins] 已安装:${installed.map(i => `${i.name}${i.version ? '@' + i.version : ''}`).join('、')}`)
    return { ok: true, installed, skipped }
  } finally {
    cleanup()
  }
}

// ---- 生命周期操作(带组件刷新) ----

/** 技能索引每轮重扫无需显式刷新,但 MCP 连接是有状态的——涉及 MCP 的变更做全量重连 */
async function refreshAfterPluginChange(touchesMcp: boolean): Promise<void> {
  reloadSkills()
  if (touchesMcp) {
    try { await reloadMcpServers() } catch (err) { console.warn('[Plugins] MCP 重连失败:', err) }
  }
}

export async function uninstallPlugin(name: string): Promise<{ ok: boolean; error?: string }> {
  const info = listPlugins().find(p => p.name === name)
  const result = removePlugin(name)
  if (result.ok) {
    await refreshAfterPluginChange((info?.mcpServerNames.length ?? 0) > 0)
    console.log(`[Plugins] 已卸载:${name}`)
  }
  return result
}

export async function togglePlugin(name: string, disabled: boolean): Promise<PluginInfo[]> {
  const info = listPlugins().find(p => p.name === name)
  setPluginDisabled(name, disabled)
  await refreshAfterPluginChange((info?.mcpServerNames.length ?? 0) > 0)
  console.log(`[Plugins] ${disabled ? '已停用' : '已启用'}:${name}`)
  return listPlugins()
}
