/**
 * 主目录/全盘遍历防线：遍历类 bash 命令（find/rg/du/tree、grep -r、ls -R）以主目录根
 * 或更上层为目标时需用户确认（2026-07-22 实案：模型全盘 find 找粘贴图 → TCC 连环弹窗）。
 * 边界要求：明确子目录不拦（防线对准隐私暴露面，不是读操作本身）。
 */
import { describe, it, expect } from 'vitest'
import os from 'os'

const { detectHomeWideScan } = await import('../../src/main/pi-security')

const HOME = os.homedir()

describe('detectHomeWideScan：应拦截', () => {
  it.each([
    [`find ${HOME} -name "image.png" 2>/dev/null | head -10`],
    ['find ~ -name "*.png"'],
    ['find / -name foo 2>/dev/null'],
    ['find /Users -maxdepth 2 -name x'],
    ['grep -r "secret" ~'],
    [`rg pattern ${HOME}`],
    ['ls -laR ~'],
    ['du -sh ~'],
    ['tree $HOME'],
    [`find "${HOME}" -type f`]
  ])('%s', (cmd) => {
    expect(detectHomeWideScan(cmd)).toBeTruthy()
  })
})

describe('detectHomeWideScan：不应误伤', () => {
  it.each([
    ['find ./src -name "*.ts"'],
    [`find ${HOME}/Documents/code -name "*.ts"`],
    ['find ~/Desktop/project -name x'],
    ['grep -r pattern src/'],
    ['ls -laR /Users/example/Documents/code'],
    ['rg pattern src/main'],
    ['echo ~'],
    ['cat ~/.openpipal/config.json'],
    ['du -sh ~/Downloads'],
    ['find $HOME/.openpipal/skills -name SKILL.md']
  ])('%s', (cmd) => {
    expect(detectHomeWideScan(cmd)).toBeNull()
  })
})
