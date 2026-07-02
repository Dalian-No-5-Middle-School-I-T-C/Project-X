# GitHub 仓库规则

本文档说明 Project-X 仓库在 GitHub 上的协作规则，以及如何在本地维护与应用这些规则。

## 当前规则概览

| 规则集 | 目标 | 状态 | 作用 |
|--------|------|------|------|
| `main protect` | 默认分支 `main` | 启用 | PR 合并、审查、线性历史、CI 必须通过 |
| `release tag protect` | 版本标签 `v*` | 启用 | 禁止随意修改或删除已发布版本标签 |

规则定义文件位于 [`.github/rulesets/`](../.github/rulesets/)，可用脚本一键同步到 GitHub。

### `main` 分支保护细则

1. **禁止直接推送**：必须通过 Pull Request 合并。
2. **至少 1 人审查**：新提交会使旧审查失效（dismiss stale reviews）。
3. **解决全部 Review 讨论**：合并前需标记讨论已解决。
4. **线性历史**：禁止向 `main` 推送 merge commit。
5. **禁止强制推送与删除分支**。
6. **CI 必须通过**（且需基于最新代码）：
   - `Typecheck & Test`
   - `Build`

对应工作流：[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)

### 版本标签保护

匹配 `v*` 的标签（如 `v1.6.5`）创建后不可被普通成员修改或删除，避免发布版本被覆盖。

## 辅助配置

| 文件 | 用途 |
|------|------|
| [`.github/dependabot.yml`](../.github/dependabot.yml) | 每周自动检查 npm 与 GitHub Actions 依赖更新 |
| [`.github/CODEOWNERS`](../.github/CODEOWNERS) | 代码所有者（可按需启用 CODEOWNERS 审查） |
| [`.github/pull_request_template.md`](../.github/pull_request_template.md) | PR 描述模板 |

## 应用 / 更新规则

需要仓库 **Admin** 权限，并已登录 GitHub CLI（`gh auth login`）。

```bash
chmod +x scripts/apply-github-rulesets.sh
./scripts/apply-github-rulesets.sh
# 或指定仓库：./scripts/apply-github-rulesets.sh Dalian-No-5-Middle-School-I-T-C/Project-X
```

脚本会按 JSON 文件名 **创建或更新** 同名 ruleset，不会删除其他已有规则集。

也可在 GitHub 网页手动导入：  
**Settings → Rules → Rulesets → New ruleset → Import a ruleset**

## 修改规则的建议流程

1. 编辑 `.github/rulesets/*.json`
2. 若新增/改名 CI 检查，同步修改 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 中的 job `name`
3. 在 PR 中说明规则变更原因
4. 合并后由管理员执行 `scripts/apply-github-rulesets.sh` 同步到 GitHub

## 常见问题

**Q: CI 检查名称对不上，PR 一直合并不了？**  
A: 规则中的 `context` 必须与 GitHub PR 页「Checks」里显示的名称完全一致。修改 workflow 的 `jobs.<id>.name` 后，需同步更新 `main-protect.json` 并重新 apply。

**Q: 能否临时绕过规则？**  
A: 仓库 Admin 可在 Ruleset 中配置 Bypass actors；日常开发请走 PR + 审查流程。

**Q: `verify:auth` 有一个已知失败用例怎么办？**  
A: 当前 CI 仍运行完整 `verify:auth`；若该用例持续失败，应优先修复测试或在 workflow 中拆分/标记，而不是关闭分支保护。
