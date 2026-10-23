---
id: gap-ac239-sdk-zod-declared-in-dependencies
title: AC-239 SDK 与 zod 声明进 dependencies：SDK 范围锁 1.29 波浪号线、zod 允许已安装 4.x，lock 与
  package.json 一致且未标 dev；判据
  server/modules/mcp-gateway/tests/dependency-declaration.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-239
---
## Proposal

AC-239（GOAL-020 退出条件 1；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §105 与 §514）要求：`@modelcontextprotocol/sdk` 与 `zod` 声明进 `dependencies`，因为生产是 `npm install -g`（不装 devDependencies），且不能依赖传递安装的副本。判据文件 `server/modules/mcp-gateway/tests/dependency-declaration.test.ts` 读 `package.json` 与 `package-lock.json` 的 JSON（不做文本匹配），四条读数：(a) `dependencies` 同时含两包，且二者不只出现在 `devDependencies`/`peerDependencies`；(b) SDK 范围是波浪号且锁在当前小版本线（1.29 线），`zod` 范围允许已安装的 4.x；(c) node_modules 里实际安装的版本满足各自范围；(d) `package-lock.json` 根包条目的 `dependencies` 与 package.json 一致，二者在 lock 里没有被标成 dev。

现状（红态基线）：判据文件不存在，AC-239 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/dependency-declaration.test.ts`。经实测：`@modelcontextprotocol/sdk` 1.29.0 与 `zod` 4.3.6 已装在 `node_modules`（worktree 的 `node_modules` 是指向主检出 `node_modules` 的符号链接，因此各 worktree 与主检出读到同一份），但两者都不在 `package.json` 的 `dependencies` 或 `devDependencies`，也不在 `package-lock.json` 根包 `packages[""].dependencies`——它们目前只是 `@anthropic-ai/claude-agent-sdk` 在 lock 第 177-178 行声明的 `peerDependencies`（`"@modelcontextprotocol/sdk": "^1.29.0"`、`"zod": "^4.0.0"`）传递安装进来的副本（lock 里 `node_modules/@modelcontextprotocol/sdk` 标 `peer: true`、`node_modules/zod` 无 dev 标）。这正是 AC 要消除的「依赖传递安装的副本」。

要交付：

1. **声明依赖（`package.json`）**：在顶层 `dependencies` 加入 `"@modelcontextprotocol/sdk": "~1.29.0"` 与 `"zod": "^4.3.6"`。二者绝不能只进 `devDependencies` 或 `peerDependencies`（生产 `npm install -g` 既不装 devDeps，也不把 peer 提升为直接依赖）。`~1.29.0` 是波浪号范围、锁在 1.29 线；`^4.3.6` 接纳已安装的 4.3.6 且不跨到 3.x/5.x。

2. **同步 lock（`package-lock.json`）**：优先 `npm install --package-lock-only`（无网时加 `--offline`；两包已在 node_modules 且已有 lock 条目，无需新解析）。同步后根包 `packages[""].dependencies` 里必须出现这两个键、值与 package.json 一致，且 lock 根 `devDependencies` 不含它们、`node_modules/<包>` 条目不带 `dev: true`。若 npm 因无网不可用，退路是手工把这两个键按其 package.json 范围写进 lock 根 `packages[""].dependencies`（不新增解析、不动其它条目），随后仍以判据 (d) 读回验证。

3. **判据文件 `server/modules/mcp-gateway/tests/dependency-declaration.test.ts`（红先行）**：仅用 `node:test` / `node:assert/strict` 与 `node:fs` / `node:path` / `node:url`（node 内置），从 `import.meta.url` 上溯到仓库根（判据在 `server/modules/mcp-gateway/tests/` 下，上溯四级），读 `package.json`、`package-lock.json`、`node_modules/@modelcontextprotocol/sdk/package.json`、`node_modules/zod/package.json` 的 JSON。不 import 任何其它模块（含传递副本的 `semver`——它在 node_modules 但无 `@types/semver`，import 会让 `npm run typecheck` 在 server/tsconfig 的 strict 下报 TS7016）。范围判定自带一个最小 `satisfies(range, version)`（只支持 `~x.y.z`、`^x.y.z`、精确 `x.y.z`、`*` 四种形态，足够本判据），四条读数各写成独立断言并逐字写出原始值：
   (a) `pkg.dependencies` 同时含 `@modelcontextprotocol/sdk` 与 `zod`；并断言「只在 dev/peer 而不在 dependencies」的形态失败。
   (b) SDK 范围匹配 `^~1\.29\.\d+$`；`satisfies(zodRange, installedZodVersion)` 为真且 installedZod 落在 4.x。
   (c) 读两个 `node_modules/<包>/package.json` 的 version，各自 `satisfies(range, version)` 为真。
   (d) `lock.packages[""].dependencies` 与 `pkg.dependencies` 深度相等（至少两键逐键相等），两包不在 `pkg.devDependencies` / `lock.packages[""].devDependencies`，且 `lock.packages["node_modules/<包>"]` 不带 `dev: true`。

4. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 把 SDK 从 `dependencies` 挪到 `devDependencies` ⇒ (a) 必须红；
   (ii) 把 SDK 范围改成 `*`（或把 zod 范围改成 `^2`）⇒ (b) 必须红；
   (iii) 把 lock 根 `packages[""].dependencies` 里的两键回退（lock 未同步）⇒ (d) 必须红。
   每条记录变异前后的 `git diff`、判据的逐字失败行、恢复命令，并在恢复后重跑判据确认回绿。

<!-- dedup-ref -->
边界（dedup）：本任务只做依赖声明 + lock 同步 + 该判据。不创建 `server/modules/mcp-gateway/index.ts`——该 barrel 属于传输任务 AC-240 的第一个消费者，此刻无消费者，创建空 barrel 会违反 backend-module-standards 的「不导出无消费者符号」；不改 SPEC，不改 node_modules，不实现 AC-240 的传输、AC-241 的认证等。与 GOAL-019 的 AC-230–AC-238 任务无重叠。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-239 的命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/dependency-declaration.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/dependency-declaration.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/dependency-declaration.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) `dependencies` 同时含 `@modelcontextprotocol/sdk` 与 `zod`，且二者不只出现在 `devDependencies` / `peerDependencies`；判据读 package.json 的 JSON，写下两个 range。
- [x] AC4 (b) SDK 范围是波浪号且锁在 1.29 线（匹配 `^~1\.29\.\d+$`）；`zod` 范围接纳已安装版本且该版本在 4.x 线；写下两个 range 与判定结果。
- [x] AC5 (c) node_modules 实际安装版本满足各自范围：写下 `node_modules/@modelcontextprotocol/sdk/package.json`、`node_modules/zod/package.json` 的 version 与各自 range，逐条断言 satisfies。
- [x] AC6 (d) `package-lock.json` 根包条目的 `dependencies` 与 package.json 一致，二者在 lock 里没有被标成 dev：写下 lock 根两键值与 `dev: true` 检查结果。
- [x] AC7 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) SDK 挪到 devDependencies ⇒ AC3 红；(ii) 范围改成 `*` 或 `^2` ⇒ AC4 红；(iii) lock 未同步 ⇒ AC6 红。每条记录恢复命令并在恢复后重跑判据回绿。
- [x] AC8 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；`git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增判据文件用 ASCII ` (new)` 标注，新文件之外只改 `package.json` 与 `package-lock.json`）。

## DoD

- `package.json` 的 `dependencies` 真的声明了两包（生产 `npm install -g` 会把它们装上），SDK 范围是 `~1.29.x`、zod 范围接纳已安装的 4.x；不是「判据文件存在」就算数。
- `package-lock.json` 由 npm（或按其 range 手工同步根条目）真的与 package.json 一致，两包没有被标成 dev。
- 判据读的是活的 `package.json` / `package-lock.json` / `node_modules`（非夹具），且对三条变异都敏感：先提交实现，再逐条变异证明变红，记录变异 diff、逐字失败行、恢复命令，恢复后重跑回绿。
- 不引入新依赖（判据只用 node 内置；不 import 传递副本的 semver）；不创建无消费者的 mcp-gateway barrel；遵守 `$backend-module-standards`（测试放 `server/modules/mcp-gateway/tests/`、TypeScript、不导出无消费者符号）。
- 越界不实现 AC-240–AC-257 的范围（传输/认证/工具/设置页/冒烟）。

## Touches

- package.json
- package-lock.json
- `server/modules/mcp-gateway/tests/dependency-declaration.test.ts` (new)（判据）
- tasks/gap-ac239-sdk-zod-declared-in-dependencies.md

## Notes

目标版本读数（主检出 node_modules，worktree 为其符号链接）：`@modelcontextprotocol/sdk` 1.29.0、`zod` 4.3.6。当前二者在 lock 里的来源是 `node_modules/@anthropic-ai/claude-agent-sdk` 的 `peerDependencies`（lock 第 177-178 行），即传递安装的副本——本任务把直接声明补上。

### 执行证据（worker gap-ac239-sdk-zod-declared-in-dependencies）

**AC1 红态基线（改动前）**
命令：`for f in server/modules/mcp-gateway/tests/dependency-declaration.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/dependency-declaration.test.ts`
输出（exit 1）：`缺判据文件：server/modules/mcp-gateway/tests/dependency-declaration.test.ts`

**AC2 判据绿**
同一命令 exit 0；读数 `# tests 4` / `# pass 4` / `# fail 0`（四条读数各为独立 test）。

**AC3 (a)** package.json `dependencies` = `{"@modelcontextprotocol/sdk":"~1.29.0","zod":"^4.3.6"}`；两包均不在 `devDependencies` / `peerDependencies`。

**AC4 (b)** sdkRange=`~1.29.0`（匹配 `/^~1\.29\.\d+$/`）；zodRange=`^4.3.6`，installedZod=4.3.6，`satisfies("^4.3.6","4.3.6")=true` 且 4.3.6 落在 4.x。

**AC5 (c)** installed `@modelcontextprotocol/sdk@1.29.0` satisfies `~1.29.0`；installed `zod@4.3.6` satisfies `^4.3.6`。

**AC6 (d)** lock 根 `packages[""].dependencies` = `{"@modelcontextprotocol/sdk":"~1.29.0","zod":"^4.3.6"}`，与 package.json 逐键相等；lock 根 `devDependencies` 不含两包；`lock.packages["node_modules/@modelcontextprotocol/sdk"]` 与 `["node_modules/zod"]` 均无 `dev: true`（npm 同步后 SDK 子树的 `peer: true` 标记已随直接依赖移除，`zod` 本无 dev 标）。`npm install --package-lock-only --offline` 的 diff 仅：两键加入根 `dependencies` + SDK 子树 30 余处 `peer: true` 标记移除，无版本变更、无条目删除。

**AC7 取假形态（先提交 `4a2d0ab4`，逐条变异→红→`git checkout -- <file>` 恢复→重跑 4/4 回绿）**
(i) SDK 移入 `devDependencies` ⇒ AC-239(a) 红，逐字失败行 `AssertionError [ERR_ASSERTION]: @modelcontextprotocol/sdk must be a top-level dependency, got undefined`；恢复：`git checkout -- package.json`。
(ii) SDK 范围改 `*` ⇒ AC-239(b) 红，逐字失败行 `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^~1\.29\.\d+$/. Input:`；恢复：`git checkout -- package.json`。
(iii) lock 根 `packages[""].dependencies` 回退两键 ⇒ AC-239(d) 红，逐字失败行 `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + undefined - '~1.29.0'`；恢复：`git checkout -- package-lock.json`。

**AC8 仓库门**
`npm run typecheck` exit 0；`npm run lint` exit 0，`: error ` 计数 0（仅存量 warning）；`git diff --stat develop...HEAD` = `package.json | package-lock.json | server/modules/mcp-gateway/tests/dependency-declaration.test.ts (new)`，与 `## Touches` 逐条对齐，新文件外只改 package.json / package-lock.json。

实现提交：`4a2d0ab4 feat(mcp-gateway): declare @modelcontextprotocol/sdk and zod as dependencies (AC-239)`。