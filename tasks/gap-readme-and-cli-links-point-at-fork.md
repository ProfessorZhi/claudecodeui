---
id: gap-readme-and-cli-links-point-at-fork
title: README 的桌面版下载/Releases/Issues 链接与 CLI 帮助回退值仍指向上游：改指 yaleh 并加守卫，保留上游自有服务链接
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Finding

<!-- dedup-ref --> 机制去重读数（2026-09-30 立案时实测）：`ls tasks | grep -iE 'readme'` 无命中；`gap-npm-publish-yalehwang-cloudcli`（done）已在 `README.md` 顶部加了 fork 声明并把 `npx`/`npm install -g` 改成 `@yalehwang/cloudcli`，但**没有处理**其余仍指向上游站点/仓库的链接（其 Proposal 只承诺了安装命令与 fork 声明）；本条收尾这一部分。

**现象**：README 与 CLI 帮助文字里，有一批"用户会点/会照着做"的链接仍指向上游，导致 fork 的用户被带到上游的下载页与 issue 页，拿到的是上游构建而不是 fork 发布物。

**证据（本轮直读）**：
1. `README.md:117-119`：桌面版下载写成 `https://cloudcli.ai/download/macos`、`/windows`、`/download`，及 `GitHub Releases and checksums` 指向 `https://github.com/siteboon/claudecodeui/releases`——这些是上游站点与上游 Releases，下到的是上游桌面包；fork 只发 Windows 桌面包，且没有 macOS。
2. `README.md:244`：`GitHub Issues` 指向 `https://github.com/siteboon/claudecodeui/issues`，fork 的问题会报到上游。
3. `server/modules/cli/cli.service.ts:166,169`：帮助文字的回退值 `https://github.com/siteboon/claudecodeui` 与 `.../issues`（仅当 `package.json` 的 `homepage`/`bugs` 缺失时用；`package.json` 现已指向 fork，所以是死回退，但字面量仍会在元数据缺失时把人指到上游）。
4. 明确**保留**的上游引用（不是缺陷）：`README.md` 里的 `cloudcli.ai` 文档站与 CloudCLI Cloud、Discord、插件模板 `github.com/cloudcli-ai/cloudcli-plugin-*`——这些是上游项目的服务与生态，fork 没有对应物；fork 声明（`README.md:7-9`）已交代来源。

**要建的东西（最小充分集）**：
1. `README.md` 桌面版段：去掉指向 `cloudcli.ai/download*` 的 macOS/Windows/Download 三个链接，改为指向 `https://github.com/yaleh/claudecodeui/releases`，并写明"目前只发布 Windows 安装包（无 macOS 版）"。
2. `README.md:244` 的 Issues 链接与 `Releases` 链接改指 `yaleh/claudecodeui`。
3. `server/modules/cli/cli.service.ts` 两处回退值改成 `https://github.com/yaleh/claudecodeui` 与 `.../issues`；`server/modules/cli/tests/cli.service.test.ts` 加一条断言：元数据缺失时帮助文字含 `yaleh/claudecodeui`、不含 `siteboon`。
4. 新增静态守卫（放进现有 `scripts/release/tests/fork-release-workflows.test.mjs`，不另起文件）：`README.md` 中所有 `github.com/siteboon/claudecodeui` 只允许出现在 fork 声明那一段（以 `> ` 引用块限定），其余出现即红。

**非目标**：不动 `cloudcli.ai` 文档/Cloud/Discord/插件模板链接；不改 `docker/`、`redirect-package/`、`CHANGELOG.md`；不处理桌面版下载地址（另有 `gap-desktop-local-server-bundle-url-points-at-fork`）。

## AC

- [x] AC1 README 不再把用户带去上游下载/问题页：`grep -n "cloudcli.ai/download\|siteboon/claudecodeui" README.md` 的每一处命中都位于以 `> ` 开头的 fork 声明引用块内（判据打印 `readme.upstream_refs_outside_notice=0`）；`README.md` 含 `github.com/yaleh/claudecodeui/releases` 与 `github.com/yaleh/claudecodeui/issues`。
- [x] AC2 守卫绿：`node --test scripts/release/tests/fork-release-workflows.test.mjs` 退出 **0** 且打印上一条的读数；取假：往 README 桌面段临时加一条 `https://github.com/siteboon/claudecodeui/releases` 后该守卫退出非 **0**，红在 `readme.upstream_refs_outside_notice`；恢复后复绿（登记变异 diff、失败断言逐字、退出码）。
- [x] AC3 CLI 回退值：`grep -c "siteboon" server/modules/cli/cli.service.ts` 为 **0**；`bash scripts/test.sh --for-task gap-readme-and-cli-links-point-at-fork --allow-thin` 退出 **0**，`__PERFILE__` 里含 `server/modules/cli/tests/cli.service.test.ts` 且 `passed=true`；取假：把回退值改回 `siteboon` 后该测试红。
- [x] AC4 未越界：`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内；`docker/`、`redirect-package/`、`CHANGELOG.md`、`electron/` 字节不变；README 中 `cloudcli.ai/docs`、Discord、`cloudcli-ai/cloudcli-plugin-*` 链接逐字保留（`grep -c` 与 `develop` 上的值相等）。
- [x] AC5 `npm run typecheck` 与 `npm run lint` 退出 **0**。

## DoD

- 一个 fork 用户从 README 出发：装 npm 包、下桌面包、看发布记录、报 issue，走到的都是 `yaleh/claudecodeui` 与 `@yalehwang/cloudcli`；仍指向上游的只剩上游自有的服务（文档站、Cloud、Discord、插件模板）和 fork 声明本身。
- 守卫把"README 里除 fork 声明外不再出现上游仓库链接"钉住；取假真的跑过。
- 只动 `## Touches` 列出的文件。

## Touches

- `README.md`
- `server/modules/cli/cli.service.ts`
- `server/modules/cli/tests/cli.service.test.ts`
- `scripts/release/tests/fork-release-workflows.test.mjs`
- `tasks/gap-readme-and-cli-links-point-at-fork.md`
