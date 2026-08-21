---
name: release
description: Package OpenPipal as a macOS DMG, install it, and prove the running binary is the build you just made. User-invoked only.
disable-model-invocation: true
---

# /release — 打包 → 安装 → 证明装机版就是新构建

三步一步都不许跳。任何一步没真正执行过命令，就不许说"运行时已验证"，只能说"尚未运行时验证"。

## 0. 打包前

- `git status` 干净，或明确知道脏在哪、且是故意的
- 改过 `openpipal-extension/` 就先 bump `manifest.json` version
- 记基线：`git rev-parse --short HEAD`

## 1. 构建 + 打包

```bash
npm run build:mac    # = electron-vite build && electron-builder --mac
```

产物：`dist/openpipal-<version>-<arch>.dmg` 与 `dist/mac-arm64/OpenPipal.app`。
**这步失败就停在这里报错，不要往下走。**

## 2. 安装到 /Applications

```bash
stat -f '即将替换: %N（打包于 %Sm）' -t '%Y-%m-%d %H:%M' /Applications/OpenPipal.app
rm -rf /Applications/OpenPipal.app
cp -R dist/mac-arm64/OpenPipal.app /Applications/
```

## 3. 证明跑的是新构建（关键，最容易被省掉的一步）

**版本号相等证明不了任何事**——`package.json` 的 version 在两次构建之间通常不动。2026-08-19 实测：装机版和源码都是 `1.0.0`，看着一致，但那个包打于 8 天前，中间隔了 100 个提交。所以要比的是内容指纹和时间，不是版本号。

```bash
A=$(shasum -a 256 /Applications/OpenPipal.app/Contents/Resources/app.asar | cut -d' ' -f1)
B=$(shasum -a 256 dist/mac-arm64/OpenPipal.app/Contents/Resources/app.asar | cut -d' ' -f1)
[ "$A" = "$B" ] && echo "✓ 装机版 == 刚打的包（asar ${A:0:12}）" || { echo "✗ 装机版不是刚打的包 — 第 2 步没生效"; exit 1; }

BUILT=$(stat -f %m /Applications/OpenPipal.app/Contents/Resources/app.asar)
BEHIND=$(git log --since="@$BUILT" --oneline | wc -l | tr -d ' ')
echo "打包于: $(date -r $BUILT '+%Y-%m-%d %H:%M')   HEAD: $(git log -1 --format=%cd --date=format:'%Y-%m-%d %H:%M')"
[ "$BEHIND" -eq 0 ] && echo "✓ 包含 HEAD" || { echo "✗ STALE BUILD — 落后 $BEHIND 个提交，回第 1 步重打"; exit 1; }
```

两条任一失败 = stale build，**直接报错，不许请用户上机测试**。
（`app.asar` 只有主进程/preload/renderer 的构建产物。原生模块或 Info.plist 的改动不进 asar——那类改动另外核对 `Contents/Info.plist`。）

## 4. 报告

- 版本 / 短 SHA / 打包时间 / asar 前 12 位 / DMG 路径
- 本次改动的验收清单：改了什么 → 在 App 里从哪儿能看出来
- 分两栏说：**已验证**（附证明它的命令或截图）/ **未验证**（老实写"尚未运行时验证"）

## 附：改了 `electron-builder.yml` 的 `files:` 怎么验

`files:` 是**正向白名单**——只有列出的才进 `app.asar`。改它属于动构建契约，漏掉一项的后果是"装机版才崩、dev 复现不了"，所以必须做对照实验，别靠读配置判断：

```bash
# A 组：改之前的配置。B 组：改之后。两组必须同一时刻、同一份 node_modules 打，只让配置一个变量动
npx electron-builder --mac --config.mac.target=dir --config.directories.output=dist-qa-base
npx asar list dist-qa-base/mac-arm64/OpenPipal.app/Contents/Resources/app.asar | sort > /tmp/base.txt
# ……改配置……
npx electron-builder --mac --config.mac.target=dir --config.directories.output=dist-qa-white
npx asar list dist-qa-white/mac-arm64/OpenPipal.app/Contents/Resources/app.asar | sort > /tmp/white.txt
comm -13 /tmp/base.txt /tmp/white.txt   # 只在 B 组多出的：期望 0 条
comm -23 /tmp/base.txt /tmp/white.txt   # 只在 A 组的：必须逐条认得出为什么该甩
```

- 输出目录用 `dist-qa*` 前缀——`files:` 里已排除它，否则实验产物会被下次打包吸进 asar（实测把 152MB 吹成 1.2GB）
- 文件清单相等还不够，**再跑一次冒烟**：直接执行 `dist-qa-white/mac-arm64/OpenPipal.app/Contents/MacOS/OpenPipal`，确认日志里没有 `Cannot find module` / `ENOENT`，且技能与 MCP 都加载了（那些来自 `extraResources`，能证明 asar 之外的资源没被牵连）
- 验完删掉 `dist-qa-*`
