/**
 * 主目录/全盘遍历防线的 Windows 形态：`C:\`、`C:\Users[\name]`、Git Bash 的 `/c/`、
 * `%USERPROFILE%`、`$env:USERPROFILE`，以及 PowerShell 的 `Get-ChildItem -Recurse`。
 * platform / home 走测试接缝，在 macOS 上用 path.win32 算。
 */
import { describe, expect, it } from 'vitest'
import { detectHomeWideScan } from '../../src/main/pi-security'

const HOME = 'C:\\Users\\Alice'
const win = (cmd: string) => detectHomeWideScan(cmd, 'win32', HOME)

describe('Windows：应拦截', () => {
  it.each([
    'Get-ChildItem C:\\ -Recurse',
    'dir D:\\ -Recurse',
    'Get-ChildItem -Path C:\\Users\\Alice -Recurse -Filter *.png',
    'gci -Recurse $env:USERPROFILE',
    'gci -rec $env:UserProfile',
    'dir C:\\Users -Recurse',
    'rg pattern %USERPROFILE%',
    'find /c/ -name x',
    'find /c/Users/Alice -name x',
    'find /c/Users -maxdepth 2',
    'find ~ -name "*.png"',
    'ls -R C:/Users/alice',
    'tree $HOME'
  ])('%s', (cmd) => {
    expect(win(cmd)).toBeTruthy()
  })

  it('提示语不提 iCloud / 系统授权弹窗——那是 macOS 的事', () => {
    const reason = win('Get-ChildItem C:\\ -Recurse')!
    expect(reason).toContain('整块磁盘')
    expect(reason).not.toContain('iCloud')
  })
})

describe('Windows：不应误伤', () => {
  it.each([
    'Get-ChildItem -Recurse src',
    'gci -Recurse C:\\Users\\Alice\\code',
    'dir D:\\code -Recurse',
    'find /c/Users/Alice/Documents -name x',
    'rg pattern %USERPROFILE%\\Documents',
    'Get-Content C:\\Users\\Alice\\notes.txt',
    'Get-ChildItem C:\\Users\\Alice\\Desktop\\project',
    'find ./src -name "*.ts"'
  ])('%s', (cmd) => {
    expect(win(cmd)).toBeNull()
  })
})

describe('macOS 行为不变：Windows 形态的 token 在 macOS 上算不出家目录，不拦', () => {
  it.each([
    'find /c/ -name x',
    'Get-ChildItem C:\\ -Recurse'
  ])('%s', (cmd) => {
    expect(detectHomeWideScan(cmd, 'darwin', '/Users/alice')).toBeNull()
  })
})
