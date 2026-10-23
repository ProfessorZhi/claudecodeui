---
id: gap-desktop-local-server-bundle-url-points-at-fork
title: 桌面版 Local 运行时的默认下载地址写死上游 siteboon：fork 发布的桌面包选 Local 模式会 404，改指 yaleh 并重发
  v1.38.1 桌面包
status: done
needs_human_cause: unclassified
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Finding

<!-- dedup-ref --> 机制去重读数（2026-09-30 立案时实测）：`ls tasks | grep -iE 'desktop|local-server|bundle'` 无命中；相邻的 `gap-fork-github-release-pipeline`（done）只让 fork 的 Release/Desktop Release 能跑通并产出 Local 运行时资产，没有碰桌面版**下载**这些资产的地址；本条是它漏掉的另一半。

**现象**：本 fork 的桌面版（`v1.38.0` 已发布 `cloudcli-desktop-1.38.0-win-x64.exe`）在用户选 "Local CloudCLI" 时，会去**上游**仓库下载 Local 运行时，而不是本 fork。

**证据（本轮直读）**：
1. `electron/serverInstaller.js:17`：`const DEFAULT_BUNDLE_BASE_URL = 'https://github.com/siteboon/claudecodeui/releases/download';`，`:37` 的 `bundleBaseUrl = process.env.CLOUDCLI_SERVER_BUNDLE_URL || DEFAULT_BUNDLE_BASE_URL` 是唯一的覆盖口，需要用户自己设环境变量，普通用户不会设。
2. `getBundleUrl()`（`:65-`）拼出 `${bundleBaseUrl}/${bundleReleaseTag}/cloudcli-local-server-${version}-${platform}-${arch}.tar.gz`。`desktop-release.yml` 把 `electron/server-bundle-config.json` 写成 `{"releaseTag":"cloudcli-local-server-<tag>"}`，所以 fork 的 `v1.38.0` exe 会请求 `https://github.com/siteboon/claudecodeui/releases/download/cloudcli-local-server-v1.38.0/cloudcli-local-server-1.38.0-win-x64.tar.gz`——上游没有这个 tag ⇒ 404，Local 模式起不来。
3. fork 侧的资产是存在的：`gh release view cloudcli-local-server-v1.38.0 -R yaleh/claudecodeui` 有 `cloudcli-local-server-1.38.0-win-x64.tar.gz(.sha256)`。即数据在 fork，地址却指上游。
4. 仓库里另有 3 处引用该机制：`electron/localServer.js`、`.github/workflows/desktop-release.yml`、`desktop-windows-branch-build.yml`、`desktop-macos-branch-build.yml`——workflow 侧只写 `server-bundle-config.json`，不含仓库地址。

**根因**：默认下载地址是上游仓库的字面量，fork 化时没有跟着改。

**要建的东西（最小充分集）**：把默认下载基址改为 `https://github.com/yaleh/claudecodeui/releases/download`，`CLOUDCLI_SERVER_BUNDLE_URL` 环境变量覆盖口保持不变；新增一个测试钉住"默认地址指向 fork、不含 `siteboon`"与"环境变量仍可覆盖"；然后重发桌面版，让已发布的桌面包用上新地址。

**非目标**：不改 `build-server-bundle.js`；不改上游的任何东西；不引入构建期注入仓库名的新机制（字面量改一处即可，改坏由测试兜住）；不新增 macOS/Linux 桌面包。

## AC

- [x] AC1 默认地址指向 fork：`node --test scripts/release/tests/server-installer-bundle-url.test.mjs` 退出 **0**，并打印 `bundle.default.host=github.com/yaleh/claudecodeui`、`bundle.default.upstream_refs=0`、`bundle.env_override=honored`；`grep -c siteboon electron/serverInstaller.js` 为 **0**。
- [x] AC2 取假必须红：把 `DEFAULT_BUNDLE_BASE_URL` 改回 `siteboon/claudecodeui` 后上面的测试退出非 **0**，红在 `bundle.default.upstream_refs` 那条断言；把 `CLOUDCLI_SERVER_BUNDLE_URL` 覆盖分支拿掉后同样红在 `env_override` 断言；恢复后复绿（登记变异 diff、失败断言逐字、退出码）。
- [x] AC3 URL 形状不变：测试对 `new ServerInstaller({version:'1.38.1', platform:'win32', arch:'x64', bundleReleaseTag:'cloudcli-local-server-v1.38.1'}).getBundleUrl()` 断言其等于 `https://github.com/yaleh/claudecodeui/releases/download/cloudcli-local-server-v1.38.1/cloudcli-local-server-1.38.1-win-x64.tar.gz`（只换了仓库段，文件名与 tag 段与现状逐字一致）。
- [x] AC4 未越界：`git diff --name-only $(git merge-base develop HEAD) HEAD` 全部落在 `## Touches` 内；`scripts/release/build-server-bundle.js` 与三份 workflow 字节不变。
- [x] AC5 `npm run typecheck` 与 `npm run lint` 退出 **0**。
- [x] AC6 真实落地（合入 `develop` 并推送 `yaleh` 之后）：触发 `Desktop Release`（`gh workflow run desktop-release.yml -R yaleh/claudecodeui --ref develop -f tag=v1.38.1`）成功；`gh release view v1.38.1 -R yaleh/claudecodeui --json assets` 含 `cloudcli-desktop-1.38.1-win-x64.exe` 与 `SHASUMS256-windows.txt`；`curl -sIL -o /dev/null -w '%{http_code}' https://github.com/yaleh/claudecodeui/releases/download/cloudcli-local-server-v1.38.1/cloudcli-local-server-1.38.1-win-x64.tar.gz` 打印 **200**。

## DoD

- fork 发布的桌面版在选 "Local CloudCLI" 时，请求的是 fork 自己的 `cloudcli-local-server-<tag>` prerelease，且该 URL 真实返回 200——不是"常量改了"，而是 `v1.38.1` 桌面包和它对应的运行时资产都已发布并可下载。
- 测试把"默认地址不含上游仓库"与"环境变量覆盖口仍在"两条同时钉住；取假真的跑过。
- 只动 `## Touches` 列出的文件。

## Touches

- `electron/serverInstaller.js`
- `scripts/release/tests/server-installer-bundle-url.test.mjs` (new)
- `tasks/gap-desktop-local-server-bundle-url-points-at-fork.md`

## Evidence

实现与本地验证完成，提交在 `task/gap-desktop-local-server-bundle-url-points-at-fork`（`fix(desktop): point the local-server bundle default at the fork`）。下面每条的读数见本文件 `## AC` 的勾选状态；**AC6 是人工闸**，需要合入 `develop` 并推送 `yaleh` 后触发 `Desktop Release` 才能勾选，故保持未勾选。

- AC1：`node --test scripts/release/tests/server-installer-bundle-url.test.mjs` 退出 **0**，三行读数逐字为 `bundle.default.host=github.com/yaleh/claudecodeui`、`bundle.default.upstream_refs=0`、`bundle.env_override=honored`；`grep -c siteboon electron/serverInstaller.js` 打印 `0`（退出 1 = 无命中行）。
- AC2：两处取假在最终形态（`035e0bb8`）上各自实测——
  (a) 把 `DEFAULT_BUNDLE_BASE_URL` 改回 `https://github.com/siteboon/claudecodeui/releases/download`（`1 file changed, 1 insertion(+), 1 deletion(-)`）：测试退出 **1**，`✖ the default bundle address points at the fork, not upstream`，失败断言逐字 `AssertionError [ERR_ASSERTION]: the upstream org siteboon still survives in electron/serverInstaller.js or the default URL (2 reference(s))` / `2 !== 0`；读数翻成 `bundle.default.host=github.com/siteboon/claudecodeui`、`bundle.default.upstream_refs=2`。
  (b) 把构造器默认值改成恒等于 `bundleBaseUrl = DEFAULT_BUNDLE_BASE_URL`（即删掉 `CLOUDCLI_SERVER_BUNDLE_URL` 覆盖分支，同样 `1 file changed, 1 insertion(+), 1 deletion(-)`）：测试退出 **1**，`✖ CLOUDCLI_SERVER_BUNDLE_URL still overrides the default`，失败断言逐字 `AssertionError [ERR_ASSERTION]: the environment override must win over the default base URL` / `+ 'ignored' - 'honored'`；读数翻成 `bundle.env_override=ignored`。
  两次都 `git checkout -- electron/serverInstaller.js` 复原，复原后复绿（退出 **0**）且 `git status --porcelain` 为空。
- AC3：同一测试的第三个 case 断言 `new ServerInstaller({version:'1.38.1', platform:'win32', arch:'x64', bundleReleaseTag:'cloudcli-local-server-v1.38.1'}).getBundleUrl()` 逐字等于 `https://github.com/yaleh/claudecodeui/releases/download/cloudcli-local-server-v1.38.1/cloudcli-local-server-1.38.1-win-x64.tar.gz`（只换仓库段，tag 段与文件名与现状逐字一致）。
- AC4：`git diff --name-only $(git merge-base develop HEAD) HEAD` 为 `electron/serverInstaller.js` 与 `scripts/release/tests/server-installer-bundle-url.test.mjs`，均落在 Touches 内；`scripts/release/build-server-bundle.js`、`.github/workflows/desktop-release.yml`、`desktop-windows-branch-build.yml`、`desktop-macos-branch-build.yml` 相对 merge-base 的 `git diff --quiet` 各退出 **0**（逐字节未变）。
- AC5：`npm run typecheck` 退出 **0**（root + server + scripts 三环）；`npm run lint` 退出 **0**（仅存量 warning，无一条指向本次改动的两个文件）。

**一处实现说明（Proposal 未写，但让 `npm run typecheck` 保持绿所必需）**：`electron/` 不属于任何 tsc project——根 `tsconfig.json` 只 include `src`/`shared`/`vite.config.js`，`server/tsconfig.json` 是 `checkJs:false` 且不 include 它。测试若**静态** import `electron/serverInstaller.js`，`scripts/tsconfig.json` 的 `checkJs:true` 会把该文件拉进程序，冒出约 20 条与本次无关的存量 strict 错误（`TS7006 Parameter ... implicitly has an 'any' type` / `TS18046 'error' is of type 'unknown'` / `TS2810` …），`npm run typecheck` 立刻红。故测试改用 `await import(new URL('../../../electron/serverInstaller.js', import.meta.url).href)` 按 URL 动态载入：类型检查器不解析非字面量 specifier，该文件留在程序之外，而生产侧改动仍只有 Proposal 说的那一处字面量。

**AC6 未勾选的原因（人工闸，非代码侧可自证）**：`gh workflow run desktop-release.yml -R yaleh/claudecodeui --ref develop -f tag=v1.38.1`、`gh release view v1.38.1 --json assets`、以及 `curl` 运行时资产打印 200，都要求本次改动先经 fan-in 落到 `develop` 并推到 `yaleh`。为避免误报完成，AC6 保持未勾选；AC1–AC5 全绿而 AC6 未绿时，本条的正确终态是 `needs-human`，由人 yale 触发发布后再勾选。


## 完成记录

2026-09-30：修复合入 develop 后先跑 Release（run 36675718326）得 v1.38.2（桌面包必须来自含修复的提交，v1.38.1 不满足）；再触发 Desktop Release（run 36675857167，tag=v1.38.2）成功。AC6：`gh release view v1.38.2` 资产 = `cloudcli-desktop-1.38.2-win-x64.exe`、`SHASUMS256-windows.txt`；`curl -sIL` 打印 http_code=200 于 `https://github.com/yaleh/claudecodeui/releases/download/cloudcli-local-server-v1.38.2/cloudcli-local-server-1.38.2-win-x64.tar.gz`。旁注：同一次 Release 也把 `@yalehwang/cloudcli@1.38.2` 发到 npm，发布日志 `+ @yalehwang/cloudcli@1.38.2` 后约 8 分钟 registry 才可见（元数据同步延迟，不是发布失败）。
