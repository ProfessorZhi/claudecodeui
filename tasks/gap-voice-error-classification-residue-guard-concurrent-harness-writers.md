---
id: gap-voice-error-classification-residue-guard-concurrent-harness-writers
title: AC-152 判据的 no-residue 守卫又把并发的、gitignore 的 harness 面（.playwright-mcp/
  日志）算成残留 ⇒ 驱动两轮 goal-gate 假红（同一文件在追写，368553→423578 字节）；上一轮只加了
  .quay，本轮必须按「谁在写就排除谁」这一类覆盖并发写者，并停止把纯 mtime 变更算残留
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-152
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何前置）：立案时 `grep -rln "^goal_ac: *AC-152" tasks/*.md` 命中两条，**都 status=done**（`gap-voice-error-single-classifier-two-paths`、`gap-voice-error-classification-residue-guard-excludes-quay-state`），**没有在飞（todo/ready/needs-human）的第三个认领者**；`grep -rln "treeSnapshot\|left files behind\|SNAPSHOT_AT_START" tasks/*.md` 只命中 `gap-voice-error-classification-residue-guard-excludes-quay-state`（done）。与那条 done 任务的关系是**证据关系，不是重复**：它把 `.quay` 加进 skip 集合并把读数框成「只覆盖 worktree 的 git 可见面」，本条处理的是**它没有覆盖的那一类并发写者**，以及那句框法本身的漏洞。`done` 的认领者在这里不是「已有修复」而是「上一轮修复没兜住」的证据，故必须新立一条把判据改回真。

**这条判据今天为什么是假（直接测量，不是台账尾巴）**

`AC-152` 的 `criterion:` 逐字是 `npx vitest run src/shared/tests/voiceErrorClassification.test.ts`。该文件里 `AC1: budget, doors, and no residue` 带一条自守断言：

- `src/shared/tests/voiceErrorClassification.test.ts:391-419` 的 `treeSnapshot()` 从 `REPO_ROOT` 递归走一遍，对每个文件记 `${path}:${mtimeMs}:${size}`（`:413`）；`:421` 在**模块加载时**取一次 `SNAPSHOT_AT_START`；`:677` 在 `AC1` 里再走一遍取差集；`:687` 是 `expect(residue, 'the run left files behind: …').toEqual([])`。
- `:392` 的 skip 集合逐字是 `['.git','node_modules','dist','coverage','artifacts','.vite','.quay']` —— **不含 `.playwright-mcp`**。

台账 `.quay/gate-events.jsonl` 里 `AC-152` 的最近两条读数**都是 `verdict=fail`**（`2026-10-06T01:18:16.056Z` actor=goal-sweep；`2026-10-06T01:19:37.136Z` actor=goal-cli），`payload.reason` 逐字含：

```
FAIL src/shared/tests/voiceErrorClassification.test.ts > AC1: budget, doors, and no residue
AssertionError: the run left files behind:
  /.playwright-mcp/console-2026-10-06T01-08-21-062Z.log:<mtime>:368553   ← 01:18 读数
  /.playwright-mcp/console-2026-10-06T01-08-21-062Z.log:<mtime>:423578   ← 01:19 读数
```

**同一个 MCP 日志文件、两次读数、体积在涨**（368553→423578 字节）—— 它是**在判据运行期间被 Playwright MCP 并发追写**的，不是本次运行写的。

**确定性复现（立案时在本仓实测，非推测）**：

1. 后台循环每 10ms `touch .playwright-mcp/console-2026-10-05T23-57-53-234Z.log`，跑一次判据命令 ⇒ **必红**，stderr 指名 `/.playwright-mcp/console-2026-10-05T23-57-53-234Z.log` 与 `/.playwright-mcp/console-2026-10-06T01-08-21-062Z.log`。
2. **不打任何探针**、直接连跑判据命令时，也出现过一次自发的红，残留正是 `.playwright-mcp/console-2026-10-06T01-08-21-062Z.log:508843` —— 该文件由浏览器 MCP 在运行中途追加，判据与它抢同一个文件。
3. 后台循环 `touch tasks/gap-voice-error-single-classifier-two-paths.md`（一个**被 git 跟踪**的文件）⇒ 也**必红**，stderr 指名 `/tasks/gap-voice-error-single-classifier-two-paths.md:<mtime>:32392`。

`.playwright-mcp/` 被 `.gitignore:172` 忽略，所以 `git status --porcelain` —— `AC1` 自称读的就是这个机制（`:377-379` 注释逐字如此）—— **永远看不到它**，与上一轮 `.quay` 的情形逐字同构。

**为什么上一轮修复没有兜住（所以这是新立的一条，done ≠ 重复）**

`gap-voice-error-classification-residue-guard-excludes-quay-state`（done，实现提交 `ecab9014`）只把 `.quay` 加进 `:392` 的 skip 集合，并把读数框成「只覆盖 worktree 的 git 可见面」。那句框法有**两处不成立**，本条要处理的就是这两处：

1. **`.playwright-mcp/` 同样是 gitignore 的面**，按「git 可见面」本该被排除，却漏了 —— 上一轮修的是**一个实例**（`.quay`），不是**一类**（「谁在写就排除谁」）。于是浏览器 MCP 一开始追写，判据立刻假红。
2. **驱动的任务/目标库 `tasks/**` 与 `goals/**` 是被 git 跟踪的（git 可见）**，却被驱动在运行期间并发改写 —— 它们既没被 skip，也不属于「git 可见面」能排除的范围。再加上 `:413` 的条目以 `mtimeMs` 为键，一次纯 `touch`（内容不变）就让判据红，而 `git status --porcelain` 对纯 mtime 变更**什么都不报**（上面复现 3 就是这条）。⇒ 判据**比它自称的机制更严**，两者不是同一个事实。

**根因**：守卫读的是「整棵树有没有任何东西变过」，而不是「本次运行有没有写东西」。本判据**按构造不写盘**（所有变异都在内存里、无临时文件、无子进程）。而并发写者（quay 驱动改写 `.quay/` 与 `tasks/`/`goals/`；Playwright MCP 追写 `.playwright-mcp/**`；应用自己的 `server.log`；vitest/vite 的缓存目录）写的都不是本次运行的残留，其中 gitignore 的那些对 AC1 点名的机制**根本不可见**。判据因此与它自己的驱动抢文件，每隔几轮假红一次。

**修法方向（实现者定杠杆，读数由 AC 钉死）**：让残留读数在**真实并发写者存在时**确定性地绿，同时**保住守卫的牙**。两条硬要求：

- **按类覆盖并发写者**，不是再加一个目录：至少把 `.playwright-mcp/`（已确认的自然红源）、`.quay/`（已在）以及**被驱动持有的已跟踪库 `tasks/`、`goals/`** 全部排除出「本次运行的残留」这一读数。仓库里已有这份类清单可派生：`.gitignore:158` 指名的 `plugin/scripts/quay-runtime-artifacts.txt`（quay 自身运行时产物的 manifest，覆盖 `.workflow-events/`、`orchestration/*`、`milestones/fast-mode-telemetry/*`、`tmp/`、`test-results/` 等），在此基础上补 `.playwright-mcp/`、`tasks/`、`goals/`。**排除面写成「其他进程拥有」这一条纪律**，并在注释里写明每一类的写者是谁 —— 不要再留下一个会随环境推移而失效的枚举。
- **不得把纯 mtime 变更当残留**：读数的条目/比较改成内容维度（`size`，或 `size` + 内容哈希），与 `git status --porcelain` 一致（后者只报内容差异）。这样任何并发 `touch`（含 `tasks/`/`goals/` 上的）都不再让判据假红。
- ⛔ **不得删掉守卫或拔掉它的牙**：一个真往 git 可见、非驱动路径写文件的判据必须仍被抓住（AC2 的正对照钉死这一条）。把判据改绿不算修好。

**改动面**：出货代码一行不动；被测文件只有 `src/shared/tests/voiceErrorClassification.test.ts` 一个，且只动 `:392` 的排除面与 `:413` 的条目/比较维度，及其紧邻解释注释（`:677` 的差集语义、`:687` 的断言形状、21 行夹具、两条取假形态、`:686` 的 doors 断言、`:688` 的 30s 预算都不动）。另一处是本任务自身的记录文件。

**边界（不做）**：不改分类器、码串表、状态表或任何出货代码（AC-149/150 的实质交付面原样）；不改 21 行夹具与两条取假形态；不写、不改、不删 `.quay/`、`.playwright-mcp/`、`tasks/`、`goals/` 里的任何驱动/浏览器文件（只读观察；探针是本任务唯一例外，用后即删）；不改 `.gitignore`；不做真实浏览器（AC-153）；不放宽 `:686` 的 doors 断言与 `:688` 的 30s 预算；不引入子进程（`AC1` 自守面要求判据无子进程，见 `:363-372` 与 `:374-389` 的注释）。

## AC

- [x] AC1 负对照（并发写者下确定性绿）：先做修复前基线 —— 后台循环每 10ms `touch` 一个 `.playwright-mcp/console-*.log`，连跑判据命令 ≥5 次，**≥5/5 红**且红在 `the run left files behind`（读数记入完成记录）；修复实现后同一根杠杆，连跑 **20 次退出 0**、每次 stdout 含 `git-clean-after=true` 与 `6 passed` ⇒ 20/20。再对 `tasks/`（或 `goals/`）下的一个文件起同样的循环，同样要求 20/20 绿（证明覆盖的是「被跟踪的驱动库」这一类，不只 gitignore 面）。跑完 `kill` 循环、不留探针、`git status --porcelain` 与本任务启动时逐字相同。
- [x] AC2 正对照（守卫的牙仍在）：跑前确认 `git check-ignore -v src/shared/tests/.ac152-residue-probe.tmp` **退出 1**（该路径不被 gitignore ⇒ 在任何「按类排除」的修法下都必须仍算残留）。随后 (a) `touch src/shared/tests/.ac152-residue-probe.tmp` 并起后台循环，(b) 另跑一次只在收尾前 `> src/shared/tests/.ac152-residue-probe.tmp`（新建/改写）—— 两种形态**都必须红**且 stderr 指名该探针。跑完删除探针，`git status --porcelain` 与本任务启动时逐字相同。此条证明修的是取景，不是把守卫拔掉。
- [x] AC3 实质读数不变（一次干净运行，退出 0）：stdout 逐条含 `rows=21`、`agreed=21`、`openai-family=4`、`classifier-defs=1 table-defs=1 adapter-local-tables=0 client-local-tables=0 client-imports-shared=true`、`mutation=client-second-table` 行的 `mutant-red=true`、`mutation=direct-status-only` 行的 `mutant-red=true`、`subprocess-imports=0`、`ports=0`；且 `6 passed`。
- [x] AC4 排除面与「本次运行的写」这一语义一致（源码读数）：`grep -nE "mtimeMs" src/shared/tests/voiceErrorClassification.test.ts` 在残留条目/比较处**零命中**（比较已改为内容维度），或该处逐字改为对 `size`/哈希的比较；`grep -n "playwright-mcp\|\.quay\|tasks\|goals" src/shared/tests/voiceErrorClassification.test.ts` 的命中落在排除面的**代码**里（不是只在注释里）；紧邻注释写明每类排除的写者是谁、以及它与 `.gitignore` / `git status --porcelain` 的关系。

## DoD

在**驱动真实的并发写者**下（锚进程按周期改写 `.quay/anchor.json`、Playwright MCP 追写 `.playwright-mcp/**`、驱动改写 `tasks/**` 与 `goals/**`）判据**连续 20 次全绿**，并且 `.quay/gate-events.jsonl` 里 `AC-152` 的**下一轮读数翻成 `verdict=pass`**（台账尾巴不再每隔几轮因 `.playwright-mcp/` 翻红）——即缺陷是在真实运行条件下消失的，不是靠运气没被并发命中。同时**正对照必须红**：同一根「并发写」杠杆，探针落在 git 可见且非驱动的 `src/shared/tests/` 下判据必红 —— 两臂只差探针落点，证明改的是**取景**（「本次运行写的」vs「整棵树变过的」），守卫的牙仍在。判据的实质读数（21 行逐行同码、`classifier-defs=1`、两条取假形态仍红、`subprocess-imports=0`、`6 passed`）逐条不变。探针清理后 `git status --porcelain` 与本任务启动时逐字相同；未新增 `*.test.*` 文件；未改任何出货代码。

## Touches

- src/shared/tests/voiceErrorClassification.test.ts
- tasks/gap-voice-error-classification-residue-guard-concurrent-harness-writers.md

## Notes

实现（commit `92664f8e`，merge develop `34a4f7f2`）：`treeSnapshot()` 的排除面改为按一条纪律分组——「该路径属于在判据运行时写 worktree 的另一个进程」，每类注明写者；条目键由 `${path}:${mtimeMs}:${size}` 改为 `${path}:${size}`（内容维度），并加一条从 `.gitignore` 整目录规则派生的尾巴防枚举过期。出货代码零改动。

实测读数（worktree `/data/home/yale/work/claudecodeui-worktrees/gap-voice-error-classification-residue-guard-concurrent-harness-writers`）：

- AC1 修复前基线：`.playwright-mcp/console-baseline.log` 上每 10ms `touch` 的循环下连跑 5 次 ⇒ **5/5 红**，每次 stderr 指名 `playwright-mcp/console-baseline.log`。
- AC1 修复后：同一 `.playwright-mcp` touch 循环 **20/20 绿**（每次 rc=0、含 `git-clean-after=true` 与 `6 passed`）；`tasks/gap-ac-001-criterion-repoint-to-migrated-test.md` 上的 touch 循环同样 **20/20 绿**。循环 kill、探针删除、`git status --porcelain` 与启动时一致（仅实现文件本身，已提交）。
- AC2：`git check-ignore -v src/shared/tests/.ac152-residue-probe.tmp` 退出 **1**。(a) `touch` 探针 + 后台内容写循环 ⇒ **红**，`the run left files behind: /src/shared/tests/.ac152-residue-probe.tmp:116`；(b) 收尾前 `> 探针`（stdout 触发，模块加载后、AC1 取快照前新建）⇒ **红**，`…probe.tmp:0`。补充臂：对既有探针的**纯 touch** 循环 ⇒ **绿**（`git-clean-after=true`），即「纯 mtime 变更不算残留」这条硬要求成立；两种正对照红形态均由**内容**（新建路径 / size 变化）触发，守卫的牙仍在。
- AC3 一次干净运行：`rows=21`、`agreed=21`、`openai-family=4`、`classifier-defs=1 table-defs=1 adapter-local-tables=0 client-local-tables=0 client-imports-shared=true`、`subprocess-imports=0`、`ports=0`、`6 passed`，两条 `mutation=` 行均 `mutant-red=true`。
- AC4：`grep -nE "mtimeMs"` **0 命中**；`grep -n "playwright-mcp\|\.quay\|tasks\|goals"` 命中在排除面代码 `:434`/`:436`（不止注释）；相邻注释写明每类写者及与 `.gitignore` / `git status --porcelain` 的关系。