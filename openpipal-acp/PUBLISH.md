# 发布流程（给 maintainer 参考）

> **当前状态：BLOCKED — 未批准发布。** 本文中的命令只是在所有门槛关闭后
> 使用的操作模板，不代表 `openpipal-acp` 或 OpenPipal 仓库已经可以公开发布。
> 当前精确候选的锁定安装、桌面真机链路、真实 provider、安全审查与最终
> maintainer 批准均未封存。总门槛见
> [`docs/open-source-readiness.md`](../docs/open-source-readiness.md) 和
> [`docs/release-acceptance.md`](../docs/release-acceptance.md)。

## 发布前 checklist

除明确标注仓库根目录的命令外，下列 ACP 命令均从 `openpipal-acp/` 执行。

- [ ] 固定一个不可变候选 commit，并确认源码与构建输入干净
- [ ] 根目录 plain `npm ci` 的 peer graph 问题已解决并通过；
      `npm --prefix openpipal-acp ci` 也从锁文件无覆盖安装成功
- [ ] `npm run typecheck` 0 错误
- [ ] `npm run build` 成功（dist/index.js 生成）
- [ ] `npm run test:protocol` 的 ACP v1/v2 离线兼容测试通过
- [ ] 桌面端开着的情况下，`node scripts/e2e-stage4.mjs` / `e2e-stage5.mjs` / `e2e-stage6.mjs` 全部 PASS
- [ ] README.md 配置 snippet 实测能跑通（在 Zed 里手测一次）
- [ ] 同一候选、同一客户端实例完成 Computer Use 用户视角验收，并完成真实
      provider 与 Runtime 回滚链路；本地 deterministic fixture 不能代替它
- [ ] 冻结的安全审查已恢复、封存并绑定到同一候选；法律、来源、历史与
      third-party notice 门槛均已批准
- [ ] CHANGELOG.md（如有）已更新
- [ ] package.json `version` 字段已 bump（semver）
- [ ] maintainer 对精确 package manifest、hash 和发布动作作出明确批准

## 首次发布（仅在 checklist 全部关闭后）

```bash
cd openpipal-acp

# 确认登录到正确的 npm 账号
npm whoami
npm login  # 如果未登录

# 试跑（不真发布）
npm publish --dry-run

# 真发布
npm publish --access public
```

注意：`prepublishOnly` 钩子会自动跑 build + typecheck。

## 后续版本（仅在对应候选重新验收后）

```bash
# bump 版本
npm version patch  # 0.1.0 → 0.1.1（bug fix）
npm version minor  # 0.1.x → 0.2.0（新功能）
npm version major  # 0.x.y → 1.0.0（breaking）

# 推 tag + 发布
git push --follow-tags
npm publish
```

## 紧急撤回

是否允许 `npm unpublish` 取决于 npm registry 当时的政策和包状态；执行前必须
查阅当期官方规则。对已经被用户安装或依赖的版本，通常优先使用可审计、不会让
依赖突然消失的 `npm deprecate`：

```bash
npm unpublish openpipal-acp@0.1.0  # 仅在当期 registry policy 明确允许时
npm deprecate openpipal-acp@0.1.0 "broken release, use 0.1.1"
```

## ACP Registry 注册（可选）

发布到 npm 后，可向 [ACP Registry](https://github.com/agentclientprotocol/registry) 提交 PR，让 OpenPipal 出现在官方 agents 列表里。

## 跨平台 / 跨编辑器测试

每个 release 至少在以下场景手动验证：

- [ ] Zed (macOS) — 主要目标客户端
- [ ] JetBrains 通过 Junie 或 Continue（如可用）
- [ ] Neovim 通过 acp.nvim
- [ ] Obsidian Agent Client 插件

## 当前开发状态（v0.2.0）

- 现有开发记录将 Stage 1-7 标为实现完成；这不是当前候选的发布验收。
- ACP v1 保持兼容：initialize / authenticate / session/new / session/prompt /
  session/cancel / session/set_mode
- ACP v2 Draft 可通过 `OPENPIPAL_ACP_V2=1` 开启：版本协商、异步 prompt lifecycle、
  message ID、state update、config options、session list/resume/close/delete
- OpenPipal 特色事件双轨 fallback：_meta + markdown
- 早期开发过程中有 ACP typecheck 与 v1/v2 离线 protocol smoke 的通过记录，
  但尚未在一个干净、不可变的最终候选上重新封存。
- 根目录 plain `npm ci` 仍受 peer graph 阻塞；当前仓库全量 lint 也未通过。
- 真机 ACP、真实 provider、跨编辑器矩阵、安全审查和最终发布批准仍为
  **NOT RUN / BLOCKED**。
- 结论：**当前不可发布。**
