---
id: gap-fork-github-release-pipeline
title: 把 develop 发布到 yaleh/claudecodeui：参照上游 release-it + Desktop Release
  两步流水线，去掉 npm 与 macOS dmg，只发 GitHub Release + Windows 安装包 + local-server 运行时
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

<!-- dedup-ref --> 机制去重读数（2026-09-29 立案时实测）：`grep -rliE 'release-it|desktop-release|release\.yml' tasks/*.md` 只命中 `gap-session-fork-lineage-list.md`（会话 fork 谱系，与发布流水线无关）⇒ 无人认领，不是重复。

**目标**：把 `develop`（`author` 自动同步、内容一致，本地二者同为 `6a8536b5`）正式发布到人 yale 自己的 GitHub 账号 `yaleh/claudecodeui`，形态参照上游 `siteboon/claudecodeui`：两步流水线——(1) `Release` workflow：release-it 升版本、更新 `CHANGELOG.md`、提交 `chore(release): vX.Y.Z`、打 tag、建 GitHub Release；(2) `Desktop Release` workflow：构建桌面包与 local-server 运行时并上传到 (1) 的 Release。人 yale 已裁定：**不合并上游 `origin/main`**（实测 `author` 相对 `origin/main` 领先 2927、落后 20 提交，928 文件 +206947/−1666，我们一侧远多于上游）；**没有 Apple 签名证书，不发布 macOS dmg**；不发 npm。

**现状（本轮直读）**：
1. `.release-it.json`：`npm.publish: true`（包 `@cloudcli-ai/cloudcli` 的 scope 不属于人 yale，必败）、`git.requireBranch: "main"`、无 `pushRepo`（`origin` 指上游 `siteboon/claudecodeui`，`yaleh` 才是可推的 fork remote）。
2. `.github/workflows/release.yml`：依赖 `RELEASE_PAT`、npm 可信发布（`registry-url`、`npm install -g npm@^11.5.1`、`id-token: write`）。
3. `.github/workflows/desktop-release.yml`：`build-macos` 任务硬校验 `CSC_LINK`/`APPLE_ID` 等 5 个 secret，缺一即红；`publish` 任务 `needs` 含 `build-macos`，并断言 `*.dmg` 与 `SHASUMS256-macos.txt` 存在；Windows 任务在无证书时已自动走未签名路径。`scripts/release/build-server-bundle.js` 按运行平台出包（`mapPlatform`），所以只出 Windows 的 local-server 包，macOS 桌面版不发。
4. `yaleh` 的默认分支现为 `main`（`git ls-remote --symref yaleh HEAD` ⇒ `refs/heads/main`，指 `fd424f3f`，即上游旧点）；`workflow_dispatch` 只有在**默认分支**上有该 workflow 文件时才可触发，所以必须把默认分支切到 `develop`（或把 workflow 合入 `main`）——这是仓库设置动作，需人 yale 授权，见 AC7。

**要建的东西（最小充分集）**：
1. `.release-it.json`：`npm.publish=false`；`git.requireBranch="develop"`；`git.pushRepo="yaleh"`（remote 名，不写 URL）；`github.release` 保持。
2. `release.yml`：去掉 npm 相关步骤与 `id-token: write`、`registry-url`；`checkout`/`GITHUB_TOKEN` 继续用 `secrets.RELEASE_PAT`（人 yale 自建的 PAT，权限：contents 写）；`release-it` 参数补 `--no-npm.publish`，`ref` 明确为 `develop`。
3. `desktop-release.yml`：删掉 `build-macos` 任务；`publish.needs` 去掉 `build-macos`；`Verify release assets` 去掉 `.dmg` 与 `SHASUMS256-macos.txt` 的断言，改断言 `*.exe` 与 `SHASUMS256-windows.txt` 与 Windows 的 `cloudcli-local-server-*.tar.gz(.sha256)`；`server-release-macos` 相关下载/上传随任务一并消失。Windows 任务保留。
4. 新增一个静态守卫测试，钉住上面三处不再回退（见 AC1/AC2）。

**非目标**：不动 `docker.yml`（推上游 Docker Hub，与本目标无关）、不动 `*-branch-build.yml`、不改应用代码、不合并 `origin/main`、不发 npm、不做 Linux/macOS 桌面包（若后续要 Linux 包另立任务）。

## Plan

1. 改 `.release-it.json`（Proposal 第 1 条），`npx release-it --dry-run --ci --no-npm.publish --increment=patch` 在 `develop` 上本地 dry-run，确认不触发 npm、目标 remote 是 `yaleh`。
2. 改 `release.yml`（第 2 条）、`desktop-release.yml`（第 3 条）；用 `node -e "require('yaml')…"` 或 `actionlint`（若已装）确认 YAML 合法、`publish.needs` 引用的任务都存在。
3. 写静态守卫 `scripts/release/tests/fork-release-workflows.test.mjs`（`(new)`）：解析三份文件，断言 (a) `.release-it.json` 的 `npm.publish===false` 且 `requireBranch==="develop"` 且 `pushRepo==="yaleh"`；(b) `release.yml` 不含 `registry.npmjs.org`/`id-token`/`npm publish`；(c) `desktop-release.yml` 不含 `macos-latest`/`CSC_LINK`/`APPLE_`/`.dmg`，且 `publish.needs` 不含 `build-macos`。
4. 取假：把三处逐一还原成旧形态，守卫必须各自红；恢复后转绿。
5. 提交并推送 `develop` 与 `author` 到 `yaleh`（需人 yale 授权，见 AC7；`yaleh/author`=`87f09b58`、`yaleh/develop`=`49c20478` 与本地 `6a8536b5` 都不同，推送前先核对谁是谁的祖先，不擅自 force）。
6. 人 yale 授权后：创建 `RELEASE_PAT` secret、把 `yaleh` 默认分支切到 `develop`；在 Actions 触发 `Release`（`increment=minor` 或 `patch`）→ 得到 `vX.Y.Z` Release；再触发 `Desktop Release`（`tag=vX.Y.Z`）。
7. 写完成记录（含 Release URL、Windows exe 与 local-server 资产清单）。

## AC

- [x] AC1 静态守卫绿：`node --test scripts/release/tests/fork-release-workflows.test.mjs` 退出 **0**，并打印 `npm.publish=false`、`requireBranch=develop`、`pushRepo=yaleh`、`macos.jobs=0`、`dmg.refs=0`、`npm.steps=0`。
- [x] AC2 取假必须红（承重，逐项）：分别把 (a) `npm.publish` 改回 `true`、(b) `desktop-release.yml` 重新加回 `build-macos` 或 `.dmg` 断言、(c) `release.yml` 加回 `id-token: write` 之后，守卫各自退出非 **0** 且红在对应断言；恢复后复绿（登记每次变异 diff、失败断言逐字、退出码）。
- [x] AC3 dry-run 不触 npm：在 `develop` 上 `npx release-it --dry-run --ci --increment=patch` 退出 **0**，输出不含 `npm publish`，打印的 push 目标含 `yaleh`（不是 `origin`）。
- [x] AC4 YAML 合法：`node -e "for (const f of ['release','desktop-release']) require('yaml').parse(require('fs').readFileSync('.github/workflows/'+f+'.yml','utf8'))"` 退出 **0**，且 `desktop-release.yml` 中 `publish.needs` 的每个 id 都是文件里真实存在的 job。
- [x] AC5 未误改范围：`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内；`docker.yml` 与两份 `*-branch-build.yml` 字节不变。
- [x] AC6 `npm run typecheck` 与 `npm run lint` 退出 **0**。
- [x] AC7 人工闸（需人 yale 授权，其余 AC 不依赖它）：`gh api repos/yaleh/claudecodeui --jq .default_branch` 打印 `develop`；`gh secret list -R yaleh/claudecodeui` 含 `RELEASE_PAT`。
- [x] AC8 真实落地：`gh release view vX.Y.Z -R yaleh/claudecodeui --json assets --jq '.assets[].name'` 含 `CloudCLI*.exe` 与 `SHASUMS256-windows.txt`，**不含** `.dmg`；`gh release view cloudcli-local-server-vX.Y.Z -R yaleh/claudecodeui` 存在且含 `cloudcli-local-server-*.tar.gz` 与 `.sha256`；`npm view @cloudcli-ai/cloudcli version` 仍是上游值（证明没有误发 npm）。

## DoD

- `yaleh/claudecodeui` 上有一个由 `Release` workflow 生成、tag 为 `vX.Y.Z` 的 GitHub Release（含 `CHANGELOG.md` 更新与 `chore(release)` 提交），随后 `Desktop Release` 已把 Windows 安装包与 local-server 运行时挂上——不是"文件改好了"，而是这条流水线真被触发并跑绿过一次。
- 发布物里没有 macOS dmg、没有 npm 发布，流水线也不再依赖任何 Apple/npm 凭据；上游 `origin/main` 未被合并，`origin` remote 未被推送。
- 静态守卫把这三处形态钉住，任何一处回退都会红；取假真的跑过。
- 只动 `## Touches` 列出的文件。

## Touches

- `.release-it.json`
- `.github/workflows/release.yml`
- `.github/workflows/desktop-release.yml`
- `scripts/release/tests/fork-release-workflows.test.mjs` (new)
- `tasks/gap-fork-github-release-pipeline.md`

## Evidence

实现与本地验证全部完成，提交在 `task/gap-fork-github-release-pipeline`。下列每条的读数见本文件 `## AC` 的勾选状态；**AC7/AC8 是人工闸**，需要人 yale 在 `yaleh/claudecodeui` 上授权后才能勾选，故保持未勾选。

- AC1：`node --test scripts/release/tests/fork-release-workflows.test.mjs` 退出 0，六行读数 `npm.publish=false / requireBranch=develop / pushRepo=yaleh / macos.jobs=0 / dmg.refs=0 / npm.steps=0`。
- AC2：四处变异逐一实测——(a) `npm.publish`→`true`、(b) `release.yml` 加回 `id-token: write`、(c) `desktop-release.yml` 加回 `build-macos` 任务、(d) 换回 `.dmg` 断言；每处各自退出 1 且红在对应断言，恢复后复绿。
- AC3：在隔离克隆（分支名 `develop`、带 `yaleh` remote）上跑 `npx release-it --dry-run --ci --increment=patch` 退出 0，输出不含 `npm publish`，push 目标为 `yaleh`。注意：`git.requireUpstream` 必须为 `false`——release-it 内置默认是 `true`，而本 fork 的 `develop` 无 tracking 分支，用默认值会在 dry-run 一开始就 `No upstream configured for current branch` 中止（已在实现中显式置 `false`）。
- AC4：两份 workflow YAML 均可被 `yaml` 解析；`desktop-release.yml` 的 `publish.needs` 只含 `resolve-release` 与 `build-windows`，两者都是文件里真实存在的任务。
- AC5：`git diff --name-only $(git merge-base develop HEAD) HEAD` 为 `.release-it.json`、`.github/workflows/release.yml`、`.github/workflows/desktop-release.yml`、`scripts/release/tests/fork-release-workflows.test.mjs`；`docker.yml` 与两份 `*-branch-build.yml` 字节未变。
- AC6：`npm run typecheck`、`npm run lint` 退出 0。

**AC7/AC8 未勾选的原因（人工闸，需人 yale 授权）**：本轮只读探测 `yaleh/claudecodeui` 现状为——`default_branch` 仍是 `main`；`gh secret list` 为空（无 `RELEASE_PAT`）；仓库无任何 Release。这两条都要求人 yale 在 GitHub 仓库设置里动作（切默认分支、建 PAT secret、推送 `develop`），随后才能真正触发两条 workflow 并产出 `vX.Y.Z`，不是代码侧可以自证的事项。为避免误报完成，保持 `- [ ]`。

**顺带补齐（Proposal 未写、但 `pushRepo: yaleh` 落地所必需）**：`actions/checkout` 只会创建 `origin` remote，而本 fork 的发布目标是 `yaleh`；`release.yml` 因此新增一步「Point the yaleh release remote at this repo」，把 `yaleh` remote 指向本次运行所在的仓库（用同一个 `RELEASE_PAT` 认证），否则 `git push yaleh` 会以 `does not appear to be a git repository` 失败。


## 完成记录

2026-09-29：AC7 `gh api repos/yaleh/claudecodeui --jq .default_branch` ⇒ `develop`，`gh secret list` 含 `RELEASE_PAT`。Release run 36596237035 成功 ⇒ v1.38.0（提交 `7c232932 chore(release): v1.38.0`）；Desktop Release run 36596465267 成功。AC8 资产：`cloudcli-desktop-1.38.0-win-x64.exe`、`SHASUMS256-windows.txt`，无 `.dmg`；prerelease `cloudcli-local-server-v1.38.0` 含 `cloudcli-local-server-1.38.0-win-x64.tar.gz(.sha256)`；`npm view @cloudcli-ai/cloudcli version` ⇒ 1.37.3（未误发 npm）。
