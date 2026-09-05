/**
 * 安全层的平台路径表（Windows 第 2 段）。
 *
 * 钉三件事：① POSIX 那一套与改动前逐字节相同——这份表以前是 pi-security.ts 里的字面量，
 * 搬家不能改味；② Windows 表从环境变量取真实位置（漫游配置重定向、非 C 盘系统盘），
 * 没设时退回约定默认；③ 平台常量（哪里有 OS 沙箱、哪里要折叠大小写、什么算盘根）。
 * 全是纯函数，所以 Windows 那一半能在 macOS 上跑。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deniedWorkspaceRootsFor,
  isCaseInsensitivePathPlatform,
  isDriveRoot,
  osSandboxAvailableOnPlatform,
  sensitiveDirsFor,
  systemDirsFor
} from '../../src/main/security-paths'

const POSIX_HOME = '/Users/alice'
const WIN_HOME = 'C:\\Users\\Alice'
const WIN_ENV = {
  SystemDrive: 'C:',
  SystemRoot: 'C:\\WINDOWS',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  APPDATA: 'C:\\Users\\Alice\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local'
}

describe('平台常量', () => {
  it('OS 沙箱只在 macOS / Linux 存在（镜像 sandbox-runtime 的 isSupportedPlatform）', () => {
    expect(osSandboxAvailableOnPlatform('darwin')).toBe(true)
    expect(osSandboxAvailableOnPlatform('linux')).toBe(true)
    expect(osSandboxAvailableOnPlatform('win32')).toBe(false)
  })

  it('只有 Windows 在比较时折叠大小写', () => {
    expect(isCaseInsensitivePathPlatform('win32')).toBe(true)
    expect(isCaseInsensitivePathPlatform('darwin')).toBe(false)
    expect(isCaseInsensitivePathPlatform('linux')).toBe(false)
  })

  it('盘根判定只认 Windows 的盘符形态', () => {
    expect(isDriveRoot('D:\\', 'win32')).toBe(true)
    expect(isDriveRoot('d:/', 'win32')).toBe(true)
    expect(isDriveRoot('D:', 'win32')).toBe(true)
    expect(isDriveRoot('D:\\code', 'win32')).toBe(false)
    expect(isDriveRoot('/', 'darwin')).toBe(false)
    expect(isDriveRoot('C:\\', 'darwin')).toBe(false)
  })
})

describe('系统目录（禁写）', () => {
  it('POSIX 表与搬家前的字面量逐条相同', () => {
    expect(systemDirsFor('darwin', {})).toEqual([
      '/etc', '/System', '/usr', '/sbin', '/bin',
      '/Library/LaunchDaemons', '/Library/LaunchAgents',
      '/private/etc'
    ])
    expect(systemDirsFor('linux', {})).toEqual(systemDirsFor('darwin', {}))
  })

  it('Windows 表从环境变量取，去掉尾分隔符', () => {
    expect(systemDirsFor('win32', { ...WIN_ENV, ProgramData: 'C:\\ProgramData\\' })).toEqual([
      'C:\\WINDOWS',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData'
    ])
  })

  it('环境变量缺失时退回 C 盘约定位置；系统盘不是 C 时跟着 SystemDrive 走', () => {
    expect(systemDirsFor('win32', {})).toEqual([
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData'
    ])
    expect(systemDirsFor('win32', { SystemDrive: 'D:' })[0]).toBe('D:\\Windows')
  })

  it('32 位进程里 ProgramW6432 指向真正的 64 位目录，也要进表', () => {
    const dirs = systemDirsFor('win32', {
      ...WIN_ENV,
      ProgramFiles: 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files'
    })
    expect(dirs).toContain('C:\\Program Files')
    expect(dirs).toContain('C:\\Program Files (x86)')
    expect(new Set(dirs).size).toBe(dirs.length)
  })
})

describe('工作根禁区', () => {
  it('POSIX 两类清单与搬家前逐条相同', () => {
    expect(deniedWorkspaceRootsFor('darwin', POSIX_HOME, {})).toEqual({
      equal: ['/', POSIX_HOME, '/Users', '/Volumes', '/home', '/mnt', '/media'],
      subtree: [
        path.posix.join(POSIX_HOME, 'Library'),
        path.posix.join(POSIX_HOME, '.config'),
        path.posix.join(POSIX_HOME, '.local'),
        path.posix.join(POSIX_HOME, '.cache'),
        '/Library',
        '/Applications',
        '/opt',
        '/private/var',
        '/var'
      ]
    })
  })

  it('Windows：盘根 / 家目录 / C:\\Users 等值拒；AppData 与系统目录按子树拒', () => {
    const denied = deniedWorkspaceRootsFor('win32', WIN_HOME, WIN_ENV)
    expect(denied.equal).toEqual(['C:\\', WIN_HOME, 'C:\\Users'])
    expect(denied.subtree).toEqual(expect.arrayContaining([
      'C:\\Users\\Alice\\AppData',
      'C:\\Users\\Alice\\AppData\\Roaming',
      'C:\\Users\\Alice\\AppData\\Local',
      'C:\\WINDOWS',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData'
    ]))
  })

  it('漫游配置被重定向到别的盘时，那个位置也在子树禁区里', () => {
    const denied = deniedWorkspaceRootsFor('win32', WIN_HOME, { ...WIN_ENV, APPDATA: 'D:\\Roaming\\Alice' })
    expect(denied.subtree).toContain('D:\\Roaming\\Alice')
    // 家目录下的默认位置仍然在——重定向不等于原位置就可以当项目目录
    expect(denied.subtree).toContain('C:\\Users\\Alice\\AppData')
  })
})

describe('敏感目录（凭据）', () => {
  it('POSIX 点目录那一套原样保留，按家目录拼成绝对路径', () => {
    const dirs = sensitiveDirsFor('darwin', POSIX_HOME, {})
    expect(dirs).toEqual(expect.arrayContaining([
      '/Users/alice/.ssh',
      '/Users/alice/.aws',
      '/Users/alice/.gnupg',
      '/Users/alice/.config/gcloud',
      '/Users/alice/.git-credentials',
      '/Users/alice/.config/gh',
      '/Users/alice/.gitconfig.local'
    ]))
    expect(dirs).toHaveLength(18)
    expect(dirs.every(d => d.startsWith(POSIX_HOME))).toBe(true)
  })

  it('Windows：点目录照搬（Git Bash 会带过来）再补 %APPDATA% 下同一批工具的凭据位置', () => {
    const dirs = sensitiveDirsFor('win32', WIN_HOME, WIN_ENV)
    expect(dirs).toEqual(expect.arrayContaining([
      'C:\\Users\\Alice\\.ssh',
      'C:\\Users\\Alice\\.config\\gcloud',
      'C:\\Users\\Alice\\.git-credentials',
      'C:\\Users\\Alice\\AppData\\Roaming\\GitHub CLI',
      'C:\\Users\\Alice\\AppData\\Roaming\\gcloud',
      'C:\\Users\\Alice\\AppData\\Roaming\\gnupg',
      'C:\\Users\\Alice\\AppData\\Roaming\\Microsoft\\Windows\\PowerShell\\PSReadLine',
      'C:\\Users\\Alice\\AppData\\Local\\Microsoft\\Credentials'
    ]))
  })

  it('%APPDATA% 没设时按家目录默认位置算', () => {
    const dirs = sensitiveDirsFor('win32', WIN_HOME, {})
    expect(dirs).toContain('C:\\Users\\Alice\\AppData\\Roaming\\GitHub CLI')
  })
})
