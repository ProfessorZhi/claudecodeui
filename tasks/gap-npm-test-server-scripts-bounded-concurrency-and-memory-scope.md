---
id: gap-npm-test-server-scripts-bounded-concurrency-and-memory-scope
title: 会话里跑服务端测试会撞 8G 会话上限被 OOM 杀掉：npm run test:server / test:scripts 默认走
  with-memory-cap.sh 并限并发，AGENTS.md 加一条指向分层表的短规则，并记录 test.sh 服务端阶段入 scope
  的评估结论（暂不做）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象（2026-10-06 取证，journal + 会话转录）**：08:55:54 一个 CloudCLI 会话（`db94ee35-61bf-43db-8314-4e9a8f0e0ce2`，scope `claudecodeui-session-1139210-30b7ae49`）被 OOM 杀掉。它的最后一条命令是 `timeout 580 npx tsx --tsconfig server/tsconfig.json --test server/modules/oauth/tests/*.test.ts server/modules/mcp-gateway/tests/*.test.ts`（34 个文件），约 1.5 秒后返回 `Exit code 137`。机制：`node --test` 默认并发是 `availableParallelism()-1`，本机 128 核即 127，34 个文件同时起，每个 `tsx --test` 进程约 0.3 GB（仓库自己量的），其中解析 `server/index.ts` 的更重，合计冲破会话 scope 的 `MemoryMax=8GiB`（`claude-session-scope.service.ts`，`gap-claude-session-cgroup-scope` 引入）。另有实测：服务端阶段 16 路并发时整个服务的内存峰值 **14.2G**（journal `Consumed … memory peak`），起跑 8 秒时即达 11.9G。

**这个形状在仓库自己的入口上同样存在**：`npm run test:server` 是 `tsx --test "server/**/*.test.ts" "server/**/*.test.js"`（约 232 个文件），**无并发上限、不在任何内存 scope 里**；`test:scripts` 同理（`node --test "scripts/**/*.test.mjs"`）。运维文档（`docs/operations/process-isolation-and-memory-caps.md`）里「第二层：测试放进自己的 scope」只挂在 `test:client` 与 `scripts/test.sh` 的 client 阶段两个调用点。这一点是由 Node 默认并发推出的，没有真跑全量验证。

**改动一：`package.json` 两个脚本**（`scripts/with-memory-cap.sh` 已存在，只复用，**不得修改它**——`scripts/vitest-heap-limit-check.sh` 明文要求它一个字都不许动）：

- `test:server` → `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test --test-concurrency=16 "server/**/*.test.ts" "server/**/*.test.js"`
- `test:scripts` → `node scripts/list-script-tests.mjs && bash scripts/with-memory-cap.sh node --test --test-concurrency=16 "scripts/**/*.test.mjs"`

并发取 16：与 `scripts/test.sh` 的夹取上限一致，也是唯一实测过的值（24G 上限下峰值 14.2G，墙钟拐点；A/B：N=4 401.0s 对 N=16 202.7s）。没有 systemd 用户管理器的环境（macOS、容器、CI）下 `with-memory-cap.sh` 自己降级为不限内存并在 stderr 提示，16 路只是排队。其余脚本（含 `test:client`、`test`）逐字不动。

**为什么不是更「干净」的别的写法（已核对）**：把 `systemd-run` 直接写进 `package.json`——macOS、Windows、容器、GitHub 的 ubuntu runner 没有用户级 systemd，会直接失败，而降级逻辑正是 `.sh` 存在的理由；`NODE_OPTIONS=--test-concurrency=…`——Node v24.21.0 明确拒绝（`is not allowed in NODE_OPTIONS`）；Node 配置文件——仍是 `--experimental-config-file`，且 `.nvmrc` 是 v22 与本机 v24 不一致；新写 `.mjs` 包装器——要重做降级逻辑，且 `scripts/*.mjs` 会被 `npm run typecheck` 扫到；每进程 `--max-old-space-size`——只限单个 V8 堆，限不住 N 个进程的总和与原生/Buffer 内存。**并发上限与内存 scope 缺一不可**：并发 4 时若同时落到 4 个会再起 `typecheck`/vitest 子进程的重文件，仍可能超 8G（推断，未实测）。

**改动二：文档与 `AGENTS.md`**。分层表只在一处维护：在 `docs/operations/process-isolation-and-memory-caps.md` 新增小节 `## Running tests from a Claude session`，含一张表——单个或几个文件：直接 `npx tsx … --test <文件>`；多文件、目录、glob：`bash scripts/with-memory-cap.sh … --test --test-concurrency=<N>`，两者缺一不可；任务自测：`bash scripts/test.sh --for-task <id>`；全量套件：不要在会话里跑，交给 fan-in，确需自己测就用 `with-memory-cap.sh` 包住；带 Chromium/Playwright/真实 server 的实验：一律 `with-memory-cap.sh`；需要脱离会话存活的长测量：独立 `systemd-run --user` service，**并显式传入所需环境变量**（实测 service 里 `DATABASE_PATH` 为空会让两个依赖环境的测试假红）。同时把该文档「Wired in at」清单补上 `npm run test:server` 与 `npm run test:scripts`。`AGENTS.md` 只新增 `## Running tests` 一小节（不超过 8 行非空行），写「会话里禁止无并发上限的多文件 `--test` 与全量套件；怎么跑见该文档对应小节」，并链接过去；既有两节不改。

**评估结论（第三件事）：`scripts/test.sh` 让服务端阶段自己入 scope——暂不做**，结论要原文写进同一份运维文档的子节 `### Not done: scripts/test.sh scopes its own server phase`：①fan-in 路径已在 runner 的 scope 与 fleet slice 里（`QUAY_TEST_SYSTEMD_RUN_LIMITS`，`MemoryMax=24G`），不需要；②会话里直接 `bash scripts/test.sh` 全量确实仍会撞 8G，这是真风险；③但在 `test.sh` 内部再套一层 `systemd-run --scope` 会让 fan-in 的 suite 逃出 fleet slice 的上限（`with-memory-cap.sh` 头注释：scope 不嵌套在调用者 cgroup 下，必须经 `QUAY_MEMORY_SLICE` 传递），并与 client 阶段已有的 `QUAY_MEMORY_UNIT` 加 journal 的 OOM 归因叠成两层；④`scripts/test.sh` 正被 `gap-suite-server-dispatch-longest-first-and-parallel-static-stages` 修改，本任务不碰它。**复评触发条件**：前两条落地后，若 journal 再出现 `claudecodeui-session-*.scope … oom-kill`，且被杀会话转录里的最后一条命令含 `scripts/test.sh`，则另开任务（方向：只在入口层包一次，必须透传 `QUAY_MEMORY_SLICE`，且已处于受限 scope 时跳过）。

**不做**：不改 `scripts/with-memory-cap.sh`、不改 `scripts/test.sh`、不改 `vitest.config.ts`、不新增 `scripts/*.mjs`（见 `npm run typecheck` 对 `scripts/` 的覆盖）；不改 CloudCLI 的会话 scope 上限（8G 是 `gap-claude-session-cgroup-scope` 的有意设计，这里的做法是把测试进程移出会话 scope，而不是放宽它）。

<!-- dedup-ref -->相关但机制不同：`gap-vitest-worker-heap-limit`（已完成：为 vitest 引入 `with-memory-cap.sh` 与 worker 堆上限，只覆盖 client 入口）；`gap-claude-session-cgroup-scope`（已完成：会话 scope 的 8G 上限，本任务绕开它而不是改它）；`gap-suite-server-dispatch-longest-first-and-parallel-static-stages`（todo：改 `scripts/test.sh`，与本任务无文件重叠）。

## AC

- [x] AC1 `test:server` 形态：`node -e "const s=require('./package.json').scripts['test:server'];process.exit(/^bash scripts\/with-memory-cap\.sh tsx /.test(s)&&s.includes('--test-concurrency=16')&&s.includes('--import ./scripts/undici-blocked-ports-preload.mjs')&&s.includes('\"server/**/*.test.ts\"')&&s.includes('\"server/**/*.test.js\"')?0:1)"` → 退出码 0。
- [x] AC2 `test:scripts` 形态：`node -e "const s=require('./package.json').scripts['test:scripts'];process.exit(s.startsWith('node scripts/list-script-tests.mjs && bash scripts/with-memory-cap.sh node --test --test-concurrency=16 ')&&s.includes('\"scripts/**/*.test.mjs\"')?0:1)"` → 退出码 0。
- [x] AC3 `package.json` 只动了这两行：`git diff --unified=0 $(git merge-base HEAD develop) HEAD -- package.json | grep -E '^[+-][^+-]' | grep -vcE '"test:(server|scripts)"'` 的输出为 `0`。
- [x] AC4 改后的命令链真能跑（单个轻量文件，证明 `with-memory-cap.sh`、`tsx`、`--test-concurrency` 与 preload 的组合被接受）：`bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test --test-concurrency=16 server/modules/auth/tests/auth.service.test.ts` → 退出码 0 且输出含 `ℹ fail 0`；`bash scripts/with-memory-cap.sh node --test --test-concurrency=16 scripts/undici-blocked-ports-preload.test.mjs` → 退出码 0。
- [x] AC5 被包住的命令确实不在调用者的 cgroup 里：`[ "$(bash scripts/with-memory-cap.sh sed -n 's/^0:://p' /proc/self/cgroup)" != "$(sed -n 's/^0:://p' /proc/self/cgroup)" ]` → 退出码 0。
- [x] AC6 运维文档：`grep -c '^## Running tests from a Claude session' docs/operations/process-isolation-and-memory-caps.md` 为 `1`；该小节内有至少 4 行以 `|` 开头的表格行，且同时出现 `with-memory-cap.sh` 与 `--test-concurrency`；「Wired in at」清单里出现 `npm run test:server` 与 `npm run test:scripts`。
- [x] AC7 评估结论已记录：同一文档含子节 `### Not done: scripts/test.sh scopes its own server phase`，其中分别 `grep -c` 到 `QUAY_MEMORY_SLICE`、`gap-suite-server-dispatch-longest-first-and-parallel-static-stages`、`oom-kill`（复评触发条件）各至少 1 处。
- [x] AC8 `AGENTS.md`：含 `## Running tests`；`awk '/^## Running tests/{f=1;next} /^## /{f=0} f&&NF' AGENTS.md | wc -l` 的结果在 3 到 8 之间；该小节含 `docs/operations/process-isolation-and-memory-caps.md`；既有两节未被改动：`git diff --numstat $(git merge-base HEAD develop) HEAD -- AGENTS.md` 的删除列为 `0`。
- [x] AC9 范围受控：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列，且不含 `scripts/with-memory-cap.sh`、`scripts/test.sh`、`vitest.config.ts`。
- [x] AC10 既有守卫与卫生：`bash scripts/vitest-heap-limit-check.sh` → 退出码 0（动手前先读一次基线；若它在 develop 上本就红，只证明改动前后读数相同）；`npm run typecheck` → 退出码 0；`npm run lint` → 退出码 0。

## DoD

真实落地的标准是「在真实的 CloudCLI 会话里运行，而不是只通过形态检查」。要在一个 `memory.max=8589934592` 的会话 scope（`cat /sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)/memory.max` 核对）里完整跑一次 `npm run test:server` 和一次 `npm run test:scripts`，并把下列读数贴进完成记录：①运行期间测试进程所在 cgroup 是 `app.slice/run-u….scope`（或带 `QUAY_MEMORY_SLICE` 时的 fleet slice），`memory.max` 为 24 GiB；②journal 里该 scope 结束时的 `Consumed … memory peak`（实测预期约 14G，须低于 24G）；③跑的过程中与跑完后，会话自己的 scope `memory.peak` 远低于 8G、会话没有被杀；④两条命令各自的 `# tests / pass / fail` 汇总，任何红都要归因（已知：服务端有两个测试在 `DATABASE_PATH` 未设置时会因依赖环境假红，会话 shell 里该变量已设置，所以应为 0 红）。再做一个负控：`QUAY_MEMORY_MAX=1G bash scripts/with-memory-cap.sh node -e "const a=[];for(;;)a.push(Buffer.alloc(64<<20,1))"` 必须被杀，journal 出现该 `run-u….scope` 的 `killed by the OOM killer`，而会话 scope 的 `oom_kill` 计数不变——证明 OOM 被圈在测试自己的 scope 里。未验证项：quay 或其他外部流程是否依赖 `test:server` 当前的无上限行为——仓库的 `.github/workflows` 与 quay 源码里都没有对 `test:server` 的调用，但外部脚本无法在本仓内断言。

## Touches

- package.json
- AGENTS.md
- docs/operations/process-isolation-and-memory-caps.md
- tasks/gap-npm-test-server-scripts-bounded-concurrency-and-memory-scope.md
