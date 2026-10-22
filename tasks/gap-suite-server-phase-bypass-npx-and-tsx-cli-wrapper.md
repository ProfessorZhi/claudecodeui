---
id: gap-suite-server-phase-bypass-npx-and-tsx-cli-wrapper
title: 服务端阶段每个测试文件经 npx → tsx CLI → node --test → 子进程起 5–6 个进程、约 525 MB：改为 node
  --import tsx --test（2 个进程、约 307 MB），为后续抬并发腾出内存余量
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象（2026-10-06 微基准，`/proc` 每 15ms 采样整棵进程树的最大进程数与最大 RSS 之和；机器负载约 11.7；每种调用各跑 3 次）**：`scripts/test.sh` 服务端阶段对每个测试文件执行 `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test "$f"`（`:894`、`:896`），一个文件的进程链是 `npx` → tsx CLI → `node --test` 运行器 → 被测子进程。

| 调用方式 | `image-assets.service.test.ts`（轻） | `sessions-name-source.integration.test.ts`（数据库集成） |
|---|---|---|
| 今天：`npx tsx --test` | 1.10s、5–6 个进程、约 525 MB | 5.1s、5–6 个进程、约 575 MB |
| `node_modules/.bin/tsx --test`（只去掉 npx） | 0.90s、3 个进程、约 447 MB | — |
| **`node --import tsx --test`** | **0.68s、2 个进程、约 307 MB** | **4.4s、2 个进程、约 347 MB** |
| `node --import tsx <文件>`（连运行器也去掉） | 0.64s、1–2 个进程、约 260 MB | — |

即每个文件省约 0.4–0.7s、约 40% 的内存。按 232 个服务端文件估算约省 115 CPU 秒（占台账 11:32Z 那轮 server 阶段 Σ 约 1445s 的 8%，**推算值**）。真正的收益是内存：16 路并发时服务端阶段峰值已测得 14.2G（24G 上限下），每路的内存就是并发上限能抬到多高的约束；对照 quay，它用 `node --experimental-strip-types` 直接起进程，才开得起 128 路（单文件中位 2.1s）。**`NODE_COMPILE_CACHE` 已量过，对 tsx 没有收益**（缓存目录仅 1.2 MB，耗时与不开持平，在噪声内），不属于本任务。

**改动（只改 `scripts/test.sh` 服务端阶段那一处调用，两个分支都要改：有 `timeout` 与没有 `timeout`）**：把 `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test "$f"` 换成 `env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test "$f"`。`TSX_TSCONFIG_PATH` 是承载点：`@/*` → `server/*` 的路径别名原先由 tsx CLI 的 `--tsconfig` 提供，纯 `node --import tsx` 不带它会以 `ERR_UNKNOWN_FILE_EXTENSION` 失败（负控已测）；带上则 `import('@/modules/auth/index.js')` 解析成功（已测）。`env` 在该调用里直接 exec 成 `node`，不增加进程。

**保留 `node --test` 运行器进程，不改成直接跑文件**：直接跑文件还能再省约 0.04–0.08s、约 45 MB，但会改掉 `classify_failure_kind` 读取的 `ℹ fail N` / `# fail N` 汇总路径与看门狗的字节普查所依赖的输出形态，改动面与收益不成比例，另行决定。

**不做**：不改 `--test-concurrency` 与 `QUAY_TEST_CONCURRENCY_CEILING`（16）——现在的下界是最长单文件（139s），不是并发数，抬上限要等长杆缩短之后另做决定，并以本任务落地后测得的每路内存为依据；不改 `npm run test:server` / `test:scripts`（仍走 tsx CLI，另议）；不改 `scripts/resident-smoke.mjs`、`scripts/mcp-smoke.mjs`，以及自己再拉起 `npx tsx` 的测试文件；不引入 `NODE_COMPILE_CACHE`。

**风险（须由 AC 与 DoD 覆盖，未假设等价）**：tsx CLI 会转发信号并做退出码映射，改为直接 `node` 后信号与退出码语义应当相同或更直接，但 `timeout` 的 `124`/`--kill-after` 路径、`kill_tree`（按 `pgrep -P` 找后代，链更短不影响）与看门狗必须实测；`classify_failure_kind` 读的 `ℹ fail` / `# fail` 汇总行必须仍出现；个别测试是否依赖「被 tsx CLI 拉起」（例如读 `process.argv`、`process.execArgv`）未经全量验证。

<!-- dedup-ref -->相关但机制不同：`gap-asr-trim-capability-node-alias-unresolved`（已完成：纯 node 下解析不到 `@/` 别名，同一根因，这里用 `TSX_TSCONFIG_PATH` 解决）；`gap-npm-test-server-scripts-bounded-concurrency-and-memory-scope`（已完成：给 npm 入口加并发与内存上限，不动 `test.sh` 的调用）；`gap-suite-server-dispatch-longest-first-and-parallel-static-stages`（已完成：同一文件的派发顺序与静态阶段并行，不涉及单个文件的进程链）。

## AC

- [x] AC1 调用形态：`grep -vE '^[[:space:]]*#' scripts/test.sh | grep -c 'npx tsx'` 的输出为 `0`；`grep -vE '^[[:space:]]*#' scripts/test.sh | grep -cE 'node --import tsx .*--test "\$f"'` 的输出为 `2`（有无 `timeout` 两个分支）；`grep -vE '^[[:space:]]*#' scripts/test.sh | grep -c 'TSX_TSCONFIG_PATH=server/tsconfig.json'` 的输出 ≥ `1`。
- [x] AC2 别名承载点与负控：`env TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx -e "import('@/modules/auth/index.js').then(()=>process.exit(0),()=>process.exit(1))"` → 退出码 0；同一命令去掉 `TSX_TSCONFIG_PATH`（`env -u TSX_TSCONFIG_PATH node --import tsx -e "…同上…"`）→ 退出码非 0（证明该环境变量是承重的）。
- [x] AC3 经 `test.sh` 位置参数路径端到端：`env -u DATABASE_PATH bash scripts/test.sh --test-concurrency=4 server/modules/assets/tests/image-assets.service.test.ts server/modules/auth/tests/auth.service.test.ts server/modules/cli/tests/cli.service.test.ts server/modules/commands/tests/commands.test.ts server/modules/cli/tests/sandbox.service.test.ts server/modules/database/tests/sessions-name-source.integration.test.ts` → 退出码 0；stdout 恰有 6 行 `__PERFILE__ … passed=true`、无 `passed=false`，且含 `# tests 6` 与 `# fail 0`。
- [x] AC4 与旧调用逐文件等价（用例数与通过数不变）：对 AC3 中前 5 个轻量文件各跑一次旧命令（`env -u DATABASE_PATH npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test <文件>`）和一次新命令（`env -u DATABASE_PATH TSX_TSCONFIG_PATH=server/tsconfig.json node --import tsx --import ./scripts/undici-blocked-ports-preload.mjs --test <文件>`），各取去掉 ANSI 后 `^ℹ (tests|pass|fail|skipped) ` 四行，新旧完全相同；任一文件不同则命令以非 0 退出并打印 `DIFF <文件>`。整体退出码 0。
- [x] AC5 超时与杀进程语义不变：`bash scripts/suite-infra-attribution-check.sh` → 退出码 0；`bash scripts/suite-hang-watchdog-check.sh` → 退出码 0（均先在 develop 上读一次基线；若某个在 develop 上本就红，只证明改动前后读数相同）。
- [x] AC6 既有契约守卫不退化：`bash scripts/suite-scope-check.sh` → 0；`bash scripts/server-phase-concurrency-check.sh` → 0。
- [x] AC7 `npm run typecheck` → 退出码 0，`npm run lint` → 退出码 0。
- [x] AC8 范围受控：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列；其中不含 `package.json`、`scripts/with-memory-cap.sh`、`vitest.config.ts`、任何 `*.test.ts`。

## DoD

真实落地的标准是「全量服务端阶段与旧调用等价，且进程和内存确实变少」，不是单文件通过。须在**独立的、带上限的 service 里**（不要在会话 scope 里，会话上限 8G）各跑一次全量服务端阶段并贴出读数：`systemd-run --user --unit=<名字> -p MemoryMax=24G -p MemorySwapMax=0 -p WorkingDirectory=<树> …`，命令是 `bash scripts/test.sh --test-concurrency=16 <全部服务端测试文件>`（位置参数形式，同前面 A/B 的做法），**改动前的 develop 与改动后的分支各跑一次**，同机背靠背，且两次都显式传入同样的 `DATABASE_PATH`（已知两个 websocket 测试在该变量缺失时会因依赖环境假红）。须贴出：①两次的 `__PERFILE__` 标签到 `passed` 的映射完全相同，保留日志里各文件 `ℹ tests` 的总和相同；②服务端阶段墙钟、各文件耗时总和（预期较 11:32Z 那轮的约 1445s 至少降 5%）、journal 里该 service 的 `Consumed … memory peak`（对照 16 路下 14.2G 的基线，预期明显更低）；③用 `/proc` 采样复测 `image-assets.service.test.ts` 与 `sessions-name-source.integration.test.ts` 的进程树：进程数 ≤ 3、RSS 之和 ≤ 约 400 MB（基线 5–6 个、525–575 MB）。落地后第一轮真实 fan-in 的台账记录须无新增红，`server/` 项的 `perFile` 耗时总和低于上述参照。把测得的「每路内存」写进完成记录，作为之后评估把并发上限从 16 抬高的依据（本任务不抬）。未验证项：真实挂死场景下的信号与 `kill_tree` 行为，只由 AC5 的两个检查脚本间接覆盖，没有现场演练。

## Touches

- scripts/test.sh
- tasks/gap-suite-server-phase-bypass-npx-and-tsx-cli-wrapper.md
