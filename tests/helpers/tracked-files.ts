import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import * as path from 'path'

/**
 * 列出仓库里的文本文件 —— 优先问 git，没有 .git 时退回文件系统遍历。
 *
 * 为什么需要兜底：发行树是脚本裁出来的、tarball 是解压出来的，**都没有 .git**。
 * 直接 `git ls-files` 会在那里抛错，于是全仓扫描类的锁在最该生效的地方反而跑不起来。
 * 这个坑踩过两次（product-name 锁一次、tailwind 锁一次），所以收成一个函数。
 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'release', '.qa-tmp'])

function walk(root: string, dir = ''): string[] {
  const abs = path.join(root, dir)
  return readdirSync(abs, { withFileTypes: true }).flatMap(entry => {
    if (SKIP_DIRS.has(entry.name)) return []
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    return entry.isDirectory() ? walk(root, rel) : [rel]
  })
}

/** `subdir` 只作为前缀过滤，两条路径下语义一致 */
export function trackedFiles(repoRoot: string, subdir = ''): string[] {
  let files: string[]
  try {
    files = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf-8' }).split('\n')
  } catch {
    files = walk(repoRoot)
  }
  return files.filter(f => f && (!subdir || f.startsWith(subdir)))
}
