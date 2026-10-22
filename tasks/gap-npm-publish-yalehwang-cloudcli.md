---
id: gap-npm-publish-yalehwang-cloudcli
title: 把 fork 以 @yalehwang/cloudcli 发到 npm：改包名与仓库指向、release-it 打开 npm 发布、Release
  workflow 走 NPM_TOKEN、清掉写死的旧升级命令并反转守卫
status: done
needs_human_cause: unclassified
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（2026-09-30 立案时实测）：`ls tasks | grep -iE 'npm|package-name'` 无命中；前置任务 `gap-fork-github-release-pipeline`（done）刻意把 npm 发布关掉（`.release-it.json` 的 `npm.publish=false`、`release.yml` 的 `--no-npm.publish`、守卫 `scripts/release/tests/fork-release-workflows.test.mjs` 钉住），本条是它的**有意反转**，不是重复。

**目标**：把本 fork 以 `@yalehwang/cloudcli` 发到 npm（人 yale 的 npm 用户名是 `yalehwang`，人已裁定包名 `@yalehwang/cloudcli`、可执行名 `cloudcli` 不变）。`@cloudcli-ai/cloudcli` 的维护者只有 blackmammoth 与 simossiteboon（`npm view @cloudcli-ai/cloudcli maintainers`），不是我们的，不能也不该发。`npm view @yalehwang/cloudcli` 于 2026-09-30 为 E404（名字空闲）。

**现状（本轮直读）**：
1. `package.json`：`name=@cloudcli-ai/cloudcli`，`repository.url` 指上游 `siteboon/claudecodeui`，`bin.cloudcli` 指 `dist-server/server/modules/cli/cli.js`，`files` 已含 `dist/`、`dist-server/`、`server/`、`shared/`、`electron/`、`scripts/`，`prepublishOnly=npm run build`。
2. `.release-it.json`：`npm.publish=false`；`release.yml` 有 `--no-npm.publish` 与注释"不发 npm"，且已去掉 `registry-url`、`id-token`。
3. 代码里写死旧包名、会让用户的"升级"命令装到上游包：`server/modules/cli/cli.module.ts`（`npm show …version`、`npm update -g …`）、`server/modules/cli/cli.service.ts:215`（手动升级提示）、`server/modules/system/system.service.ts:36`（`npm install -g …@latest`）、`server/modules/cli/sandbox.service.ts`（提示文案）、12 个 locale 的 `src/modules/i18n/locales/*/common.json`（`npmUpgradeCommand`）；`server/modules/system/tests/system.service.test.ts:62` 逐字断言旧命令。
4. `README.md` 有 32 处 `@cloudcli-ai` 提及（`npx`/`npm install -g`），需要按包名改写并注明这是 fork。
5. `docker/` 下的 Dockerfile 与 README 装的是上游包与上游镜像 `cloudcliai/sandbox`——**不在本条范围**，保持不动。`redirect-package/`（旧名 `@siteboon/claude-code-ui` 跳转壳）同样不动。

**要建的东西（最小充分集）**：
1. `package.json`：`name` 改 `@yalehwang/cloudcli`；`repository.url`/`bugs.url`/`homepage` 改指 `yaleh/claudecodeui`（`homepage` 只在有自己的页面时才改，否则指仓库）；补 `publishConfig: {"access": "public"}`。`package-lock.json` 顶部 `name` 同步。
2. `.release-it.json`：`npm.publish=true`，`npm.publishArgs=["--access public"]`。
3. `release.yml`：用 `NPM_TOKEN` secret 走 `NODE_AUTH_TOKEN`（`setup-node` 加 `registry-url: https://registry.npmjs.org`），去掉 `--no-npm.publish` 与"不发 npm"的注释；不启用 trusted publishing（fork 未在 npm 侧配置）。
4. 上面第 3 条列的 6 处代码 + 12 个 locale 的旧包名全部换成 `@yalehwang/cloudcli`，`system.service.test.ts` 的断言同步。
5. `README.md` 的安装段改成 `npx @yalehwang/cloudcli` / `npm install -g @yalehwang/cloudcli`，并加一句"本仓库是 siteboon/claudecodeui 的 fork"。
6. 守卫 `fork-release-workflows.test.mjs` 反转对应断言：`npm.publish===true`、`name==="@yalehwang/cloudcli"`、`release.yml` 含 `NODE_AUTH_TOKEN`、且**仓库内不再有面向用户的 `@cloudcli-ai/cloudcli` 升级命令**（`docker/`、`redirect-package/`、`CHANGELOG.md` 除外，并在守卫里写明这个排除清单）。

**非目标**：不发 Docker 镜像、不动 `docker/`、`redirect-package/`、`CHANGELOG.md`；不做 Linux/macOS 桌面包；不修桌面版 `electron/serverInstaller.js` 写死上游 Local 运行时下载地址（另立任务）；不合并上游 `origin/main`。

## Plan

1. 先改守卫使其在当前代码上**红**（新断言：包名、`npm.publish`、`NODE_AUTH_TOKEN`、无旧升级命令），登记红的断言逐字。
2. 依 Proposal 第 1–5 条改 `package.json`/`package-lock.json`、`.release-it.json`、`release.yml`、6 处代码、12 个 locale、`README.md`；同步改 `system.service.test.ts`。
3. 守卫转绿；`npx release-it --dry-run --ci --increment=patch` 在 `develop` 上确认它会走 npm 发布步骤且目标包名是 `@yalehwang/cloudcli`。
4. `npm pack --dry-run` 读 tarball 清单：含 `dist/`、`dist-server/`、`server/`、`shared/`、`electron/`、`scripts/`、`README.md`，且 `package.json` 里 `name` 是新名；打印 `unpackedSize` 供参考。
5. 取假：把 `name`、`npm.publish`、任一 locale 的 `npmUpgradeCommand` 分别改回旧值，守卫各自必须红。
6. 人 yale 授权后：创建 npm Automation 令牌，`gh secret set NPM_TOKEN -R yaleh/claudecodeui`；触发 `Release`（`increment=patch`）发出下一个版本；`npm view @yalehwang/cloudcli version` 读回。
7. 写完成记录（版本号、npm 包链接、`npx @yalehwang/cloudcli --version` 的实测输出）。

## AC

- [x] AC1 守卫绿：`node --test scripts/release/tests/fork-release-workflows.test.mjs` 退出 **0**，并打印 `pkg.name=@yalehwang/cloudcli`、`npm.publish=true`、`auth.env=NODE_AUTH_TOKEN`、`legacy.upgradeCmds=0`。
- [x] AC2 取假必须红（承重，逐项）：分别把 (a) `package.json` 的 `name` 改回 `@cloudcli-ai/cloudcli`、(b) `.release-it.json` 的 `npm.publish` 改回 `false`、(c) `en/common.json` 的 `npmUpgradeCommand` 改回旧包名 之后，守卫各自退出非 **0** 且红在对应断言；恢复后复绿（登记每次变异 diff、失败断言逐字、退出码）。
- [x] AC3 升级命令全部换新：`grep -rn "@cloudcli-ai/cloudcli" server src` 命中数为 **0**；`server/modules/system/tests/system.service.test.ts` 通过其对应的 scoped 测试命令，退出 **0**（命令以任务 Touches 内的测试文件为准，`--for-task gap-npm-publish-yalehwang-cloudcli`）。
- [x] AC4 打包清单正确：`npm pack --dry-run --json` 退出 **0**，其 `name` 为 `@yalehwang/cloudcli`，`files[].path` 含 `dist-server/server/modules/cli/cli.js`、`dist/index.html`、`README.md`，且不含 `tasks/`、`goals/`、`experiments/`、`e2e/`。
- [x] AC5 dry-run 走 npm 且不误伤：`npx release-it --dry-run --ci --increment=patch` 退出 **0**，输出含 `npm publish` 与 `@yalehwang/cloudcli`，push 目标含 `yaleh`（不是 `origin`）。
- [x] AC6 未越界：`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内；`docker/`、`redirect-package/`、`CHANGELOG.md`、`electron/` 字节不变。
- [x] AC7 `npm run typecheck` 与 `npm run lint` 退出 **0**。
- [x] AC8 人工闸（需人 yale 授权）：`gh secret list -R yaleh/claudecodeui` 含 `NPM_TOKEN`。
- [x] AC9 真实落地：`npm view @yalehwang/cloudcli version` 打印刚发布的版本；在干净目录 `npx --yes @yalehwang/cloudcli --version` 退出 **0** 并打印同一版本；`npm view @cloudcli-ai/cloudcli version` 仍是上游值（证明没有碰上游包）。

## DoD

- `@yalehwang/cloudcli` 在 npm 上有一个由 `Release` workflow 发布出来的版本，且能被 `npx` 真正拉下来运行——不是"配置改好了"，而是流水线真被触发并发布过一次。
- 用户在应用里点"升级"、CLI 打印手动升级提示、README 的安装命令，全部指向 `@yalehwang/cloudcli`，仓库面向用户的文本里不再出现会把人引向上游包的旧命令。
- 守卫把包名、`npm.publish`、`NODE_AUTH_TOKEN`、旧命令清零四处形态钉住；取假真的跑过。
- 只动 `## Touches` 列出的文件。

## Evidence

**实现**：分支 `task/gap-npm-publish-yalehwang-cloudcli`，提交 `e433af35`，23 个文件全部落在 `## Touches` 内。

**AC1** `node --test scripts/release/tests/fork-release-workflows.test.mjs` → **EXIT 0**（6 tests / 6 pass），打印
`pkg.name=@yalehwang/cloudcli`、`npm.publish=true`、`auth.env=NODE_AUTH_TOKEN`、`legacy.upgradeCmds=0`，
另有 `requireBranch=develop`、`pushRepo=yaleh`、`macos.jobs=0`、`dmg.refs=0`。

**AC2 取假（逐项；均先提交再变异，`git checkout --` 还原后复绿）**：
- (a) `package.json` 的 `name` 改回旧值 → **EXIT 1**，红在
  `package.json must name the fork @yalehwang/cloudcli, not the upstream @cloudcli-ai/cloudcli`（`legacy.upgradeCmds` 同步变 1）；还原后 EXIT 0。
- (b) `.release-it.json` 的 `npm.publish` 改回 `false` → **EXIT 1**，红在
  `npm.publish must be true: the fork publishes @yalehwang/cloudcli`；还原后 EXIT 0。
- (c) `src/modules/i18n/locales/en/common.json` 的 `npmUpgradeCommand` 改回旧包名 → **EXIT 1**，红在
  `the repository still tells users to install the upstream package: src/modules/i18n/locales/en/common.json (1)`
  （`legacy.upgradeCmds=1`）；还原后 EXIT 0。

**AC3** `grep -rn "@cloudcli-ai/cloudcli" server src` → **0 命中**。
`bash scripts/test.sh --for-task gap-npm-publish-yalehwang-cloudcli --allow-thin` → **EXIT 0**
（`__PERFILE__ server/modules/system/tests/system.service.test.ts passed=true end_ms=1790725283557`，
`# tests 1 / # pass 1 / # fail 0`）。注：守卫 `.test.mjs` 不在 scoped 门的选择集内
（test.sh 的 `\.test\.[jt]sx?$` 不匹配 `.mjs`），故 AC1 的守卫按它自身的 `node --test` 命令跑。

**AC4** `npm run build` 后 `npm pack --dry-run --json` → **EXIT 0**，`name=@yalehwang/cloudcli`，
`unpackedSize=25074024`；`files[].path` 含 `dist-server/server/modules/cli/cli.js`、`dist/index.html`、`README.md`；
不含 `tasks/`、`goals/`、`experiments/`、`e2e/`。

**AC5** `npx release-it --dry-run --ci --increment=patch` → **EXIT 0**，输出含
`npm publish . --tag latest --dry-run --access public`、
`🚀 Let's release @yalehwang/cloudcli (1.38.0...1.38.1)`、
`git push --follow-tags --set-upstream yaleh develop`（push 行无 `origin`）。
该命令要求 HEAD 名为 `develop`（`.release-it.json` 的 `git.requireBranch`）；worker 的 worktree HEAD 是任务分支，
无法把 `develop` 检出到同一 worktree，故用一次性 `git clone --shared`（HEAD 命名 `develop`、内容即本任务提交、
补 `yaleh` remote、node_modules 符号链接）跑了**原样命令**，随后删除该 clone。
（另在任务 worktree 内以 `--git.requireBranch=<task-branch>` 覆盖跑过一次作旁证，输出同形。）

**AC6** `git diff --name-only 66625fd9 HEAD` → 上述 23 个文件，全部落在 `## Touches` 内；
`docker/`、`redirect-package/`、`CHANGELOG.md`、`electron/` 相对 merge-base **字节不变**。

**AC7** `npm run typecheck` → **EXIT 0**；`npm run lint` → **EXIT 0**（仅既有 warning，无 error）。

**AC8 / AC9 未满足——真堵塞点（人工闸，需人 yale 授权）**：本机无 npm 凭据
（`npm whoami` → `ENEEDAUTH`；`~/.npmrc` 无 `_authToken`），`gh secret list -R yaleh/claudecodeui`
只有 `RELEASE_PAT`、没有 `NPM_TOKEN`。既不能创建 npm Automation 令牌，也不能触发 `Release` 真发布。
需人 yale 执行：`npm token create`（Automation）→ `gh secret set NPM_TOKEN -R yaleh/claudecodeui` →
触发 `Release`（increment=patch）；之后 AC9 才可读回。

按「人工闸必须是 AC」的规矩，AC8/AC9 保持未勾。配置面（AC1–AC7）全部为真；当 AC1–AC7 全绿而 AC8/AC9 未满足时，
本任务的正确终态是 **needs-human，不是 done**。


## Touches

- `package.json`
- `package-lock.json`
- `.release-it.json`
- `.github/workflows/release.yml`
- `README.md`
- `server/modules/cli/cli.module.ts`
- `server/modules/cli/cli.service.ts`
- `server/modules/cli/sandbox.service.ts`
- `server/modules/system/system.service.ts`
- `server/modules/system/tests/system.service.test.ts`
- `scripts/release/tests/fork-release-workflows.test.mjs`
- `src/modules/i18n/locales/de/common.json`
- `src/modules/i18n/locales/en/common.json`
- `src/modules/i18n/locales/es/common.json`
- `src/modules/i18n/locales/fr/common.json`
- `src/modules/i18n/locales/id/common.json`
- `src/modules/i18n/locales/it/common.json`
- `src/modules/i18n/locales/ja/common.json`
- `src/modules/i18n/locales/ko/common.json`
- `src/modules/i18n/locales/ru/common.json`
- `src/modules/i18n/locales/tr/common.json`
- `src/modules/i18n/locales/zh-CN/common.json`
- `src/modules/i18n/locales/zh-TW/common.json`
- `tasks/gap-npm-publish-yalehwang-cloudcli.md`


【Round 2 复验 2026-09-30】HEAD d7d94771（已含 develop）。AC1–AC7 在 post-merge head 上逐条重跑全绿：AC1 守卫 node --test scripts/release/tests/fork-release-workflows.test.mjs EXIT 0（打印 pkg.name=@yalehwang/cloudcli、npm.publish=true、auth.env=NODE_AUTH_TOKEN、legacy.upgradeCmds=0）；AC2 三处取假各自 EXIT 1 且红在对应断言、git checkout -- 还原后复绿 EXIT 0；AC3 grep -rn "@cloudcli-ai/cloudcli" server src 0 命中、scripts/test.sh --for-task gap-npm-publish-yalehwang-cloudcli --allow-thin EXIT 0（server/modules/system/tests/system.service.test.ts pass 1 / fail 0）；AC4 npm pack --dry-run --json EXIT 0（name=@yalehwang/cloudcli、unpackedSize=25074024、含 dist-server/server/modules/cli/cli.js、dist/index.html、README.md，不含 tasks/ goals/ experiments/ e2e/）；AC5 release-it --dry-run --ci --increment=patch EXIT 0（含 npm publish . --tag latest --dry-run --access public、@yalehwang/cloudcli、git push --follow-tags --set-upstream yaleh develop，无 origin）；AC6 23 文件全在 ## Touches 内、docker/ redirect-package/ CHANGELOG.md electron/ 字节不变；AC7 npm run typecheck EXIT 0、npm run lint EXIT 0（仅既有 warning）。
【Round 2 AC8/AC9 仍为人工闸】本机无 npm 凭据（npm whoami→ENEEDAUTH、无 ~/.npmrc 与仓库 .npmrc）、gh secret list -R yaleh/claudecodeui 仍只有 RELEASE_PAT、npm view @yalehwang/cloudcli 仍 E404。正确终态仍为 needs-human：需人 yale 创建 npm Automation 令牌 → gh secret set NPM_TOKEN -R yaleh/claudecodeui → 触发 Release。

## 完成记录

2026-09-30：AC8 `gh secret list -R yaleh/claudecodeui` 含 `NPM_TOKEN`（人 yale 自行写入）。首次 Release run 36664310481 红在 `npm ci`（@vscode/ripgrep 匿名下载 GitHub 被限流 403，未到发布步，无 tag、无 npm 副作用）⇒ `release.yml` 的 `npm ci` 补 `GITHUB_TOKEN`（`98cd6141`）。重试 run 36664470242 成功 ⇒ v1.38.1，日志 `+ @yalehwang/cloudcli@1.38.1`。AC9：`npm view @yalehwang/cloudcli` ⇒ version 1.38.1、bin.cloudcli、maintainer yalehwang；干净目录 `npx --yes @yalehwang/cloudcli --version` 退出 0 并打印 `1.38.1`；`npm view @cloudcli-ai/cloudcli version` ⇒ 1.37.3（未碰上游包）。
