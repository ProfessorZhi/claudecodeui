---
id: gap-claude-host-per-run-delta-scope-gate
title: claude-host-per-run 的 AC6 用「当前分支的 delta」当代理判 driver 是否被读：fan-in
  merge-develop 后 develop...HEAD 就是当前 worktree 自己的分支 delta ⇒ 任何 delta 非空且不含
  driver 的兄弟任务必红（同日两条 delta 交集为空的任务、同一句、900ms 即抛）；该断言在 owner 分支上是对的，缺的是按分支设门
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Finding

**现象。** `server/modules/providers/tests/claude-host-per-run.test.ts` 的 `AC6`（`:575-613`）在**任何** worktree 的 suite 里、只要当前分支对 develop 的 delta 非空就断言：

    const vsDevelopText = gitMaybe(['diff', '--name-only', 'develop...HEAD']);
    const vsDevelop = vsDevelopText === null ? null : filesOf(vsDevelopText);
    …
    if (vsDevelop !== null && vsDevelop.length > 0) {
      assert.equal(vsDevelop.includes(DRIVER_PATH), true,
        `the develop delta does not mention the driver, so it is not the delta being read: ${DRIVER_PATH}`);
    }

`DRIVER_PATH = 'server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts'`。fan-in 的 `merge-develop` 之后 `develop` 是 HEAD 的祖先 ⇒ `develop...HEAD` 恰好是**当前 worktree 自己那条分支的 delta**。只有创建该 driver 的那一条分支（`task/gap-session-hosts-claude-per-run-driver`，已 done；其 worktree 与分支名都已回收）才含 `DRIVER_PATH`，**其它任何带非空 delta 的分支**都不含 ⇒ 必红。

**实测（fleet 级：两条 delta 交集为空的任务、同一时段、同一个唯一红）**

| 任务 | delta | suite 尾 | 唯一红 |
|---|---|---|---|
| `gap-voice-error-notice-browser-e2e` | 8 个文件（`e2e/` + `src/modules/chat/`） | `# tests 246 / pass 245 / fail 1`，`suite-end 2026-09-27T04:19:19Z` | `claude-host-per-run.test.ts`（890ms） |
| `gap-ac027-gateway-wait-weaker-than-assertion` | 单个文件 `e2e/model-library.spec.ts` | `# tests 245 / pass 244 / fail 1`，`suite-end 2026-09-27T04:21:56Z` | 同一文件、同一句（931ms） |

逐字文案：

    not ok - server/modules/providers/tests/claude-host-per-run.test.ts:
      AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts

第一条任务的 standalone 读数（工作树逐字干净）把「它读的是谁的 delta」钉死了：

    gitDiff workingTreeFiles=0 vsDevelopFiles=8 containsNeighbour=false driverExists=true driverInDelta=false

`vsDevelopFiles=8` 就是那条任务 Touches 列表里的 8 个文件 —— 它一个 `providers/**` 文件都没有。反过来，**在判据自己的任务分支上它是绿的**：`gap-session-hosts-claude-per-run-driver` 的完成记录 AC6 打印 `vsDevelopFiles=4 … driverInDelta=true`。

**为什么这是判据的缺陷，不是 fleet 的负载抖动。** 该断言对「delta 非空且不含 driver」的**每一个** worktree 都成立，900ms 内即抛（无 spawn、无超时）。自 `05db7d4a` 于 `2026-09-27T03:21:16Z` 随 owner 任务的 fan-in 落到 develop 之后，**每一条带代码 delta 的任务**的全量 suite 都会停在它上面（上面的两个任务就是它落地后的头两次全量 suite）。立案时 develop 上没有任何修复提交：`git log --all --oneline -- server/modules/providers/tests/claude-host-per-run.test.ts` 只有 `05db7d4a`（判据自身的落地提交）。

**判据本来要守的不变量是对的**：这条判据必须证明它读的是**真的 delta**、不是一棵陈旧的树（`:600-606` 的注释写明了这一点，`:588` 的 `driverInDelta` 读数行也是为此存在的）。问题只在于它用「**当前**分支的 delta」当代理，而当前分支不一定是它自己的分支。

**修法（实现者择优，并在完成记录里写明依据）。**

- **(a) 按分支设门，保留满强度**：仅当 `git rev-parse --abbrev-ref HEAD` 等于 `task/gap-session-hosts-claude-per-run-driver` 时求值 `driverInDelta`；其它分支上**打印分支名与理由**、记为「不在此处求值」（读数行仍在，不是静默跳过）。fan-in 的 worktree 就在 `task/<id>` 分支上，所以需要它真的求值的那一轮仍然求值。
- **(b) 换成可移植的读法**：把「delta 是否含 DRIVER_PATH」换成对**本判据自己的任务记录**（`tasks/gap-session-hosts-claude-per-run-driver.md` 的 Touches 列表）的读取，或对 DRIVER_PATH 的 blob 与一份记录下来的基线逐 blob 比较。注意 (b) 读的是**声明**而不是树上的事实，弱于 (a)。

⛔ 不得把这条断言删掉、改成恒真或降为 print；实现必须配 AC3 的负控制，否则就是把判据变哑。同类先例 `gap-debug-agent-ac10-reads-the-whole-branch-delta`（已 done）用的就是修法 (a)，其落地提交 `b5d6c663` 已在 develop 上，读数行形如 `[AC10] … touched=… evaluated=… branch=…` —— 本条照它的形状办。

<!-- dedup-ref --> 边界：与 `gap-debug-agent-ac10-reads-the-whole-branch-delta`（已 done）同类 —— 都是「断言读了一个不属于它的全局事实（分支 delta）」；两条判据的文件、机制与不变量各自独立，互不重复。与 `gap-session-scope-test-global-namespace-count`（已 done）同类但对象不同（那条是 systemd 宿主全局命名空间）。与 `gap-voice-falsify-copies-inside-tsc-program`（已 done）无关。

## AC

- [x] AC1 复现（改前，在别人的树上）：在一条**非 owner 分支**的 worktree 里跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`，**必须**退出非 0 且文案逐字 `the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts`；把该次打印的 `gitDiff workingTreeFiles=… vsDevelopFiles=… driverExists=… driverInDelta=false` 那一行与红态原文一并抄进完成记录。现成实例：`gap-voice-error-notice-browser-e2e` 的 worktree（立案时仍在），或其 suite 日志 `.quay/fan-in-suite-gap-voice-error-notice-browser-e2e~wk-prod-anchor~1790482590611-a9ae5e.log`；第二实例见 `.quay/fan-in-suite-gap-ac027-gateway-wait-weaker-than-assertion~wk-prod-anchor~1790482623297-c7fc30.log`。
- [x] AC2 改后同一棵树转绿且**说明理由**：同一 worktree、同一命令 → 退出 0，且输出里有一行点明该断言**未在此分支求值**、带分支名与理由（例如 `[AC6] driverInDelta=… evaluated=false branch=task/gap-voice-error-notice-browser-e2e`）。读数原文登记。
- [x] AC3 负控制（判据没被变哑），三条读数把两个变量各自孤立：在一条**字面分支名**为 `task/gap-session-hosts-claude-per-run-driver` 的临时 worktree 里（`git worktree add -b task/gap-session-hosts-claude-per-run-driver <临时路径> develop`；owner 的 worktree 已被回收、分支也不存在，但这个名字可以现造，⛔ 不要用「把分支判定强制为真」的探针代替这一步，探针只在该分支确实造不出时作备选）安装修好的判据文件，然后 —— (1) delta 非空且不含 `DRIVER_PATH`（安装该文件本身即满足）→ 跑同一命令**必须**退出非 0 且文案同上；(2) 同树再对 `DRIVER_PATH` 本身做一处 scratch 改动 ⇒ delta 含 driver → 转绿；(3) 在**别的**分支的 worktree 上带同样的 (1) 号 delta → 绿且 `evaluated=false`。1 对 3 钉住「分支」，1 对 2 钉住「delta 是否含 driver」；读数原文、还原步骤与 `git status --porcelain` 干净一并登记（`git worktree remove --force` + `git branch -D`）。单条读数无法排除「把断言改哑了」。口径同 `gap-debug-agent-ac10-reads-the-whole-branch-delta` 的 AC3。
- [x] AC4 门与范围：`npm run typecheck`、`npm run lint` 退出 0；对 develop 的 delta 只含 Touches 列出的文件。
- [x] AC5 如实登记：完成记录写明本条改的是**求值范围**，不是不变量本身；并写明它救不了的情形（若将来某任务**故意**要改 `server/modules/providers/list/**` 且该判据在自己的分支上求值，读数仍应红 —— 这正是 AC3 保证的）。

## DoD

真实落地判据不是「不再红」，而是**该红的时候仍然红、不该红的时候不再红**：AC1 在别人的树上读到过红（原文登记），AC2 证明同一棵树在改后转绿且输出说明了理由，AC3 证明在 owner 分支上违反不变量时判据**仍然红**。三条合起来才排除「把断言改哑了」这一解释。完成后，任何 delta 不含该 driver 的兄弟任务不应再被这条断言挡下 —— 这可以从此后 `.quay/fan-in-suite-*.log` 里读回来：`claude-host-per-run.test.ts` 的 `__PERFILE__ … passed=` 在那些轮次里应为 `true`。完成记录必须写明：本条不改变那条不变量本身，也不评价该 driver 的实现。

## Touches

- server/modules/providers/tests/claude-host-per-run.test.ts
- tasks/gap-claude-host-per-run-delta-scope-gate.md

## Completion record

### 改的是求值范围，不是不变量

`server/modules/providers/tests/claude-host-per-run.test.ts`（Touches 内唯一代码文件），两处：

1. 新增常量 `CRITERION_OWNER_BRANCH = 'task/gap-session-hosts-claude-per-run-driver'`，doc comment 写明这条不变量归谁、以及为什么必须按分支设门（fan-in 把每条任务 check out 在 `task/<task-id>` 上，merge develop 之后三点 delta 就是**那条兄弟任务自己**的 delta）。
2. AC6 读一次 `git rev-parse --abbrev-ref HEAD`（`branch`），推出 `driverInDeltaEvaluated = branch === CRITERION_OWNER_BRANCH`，两者都打印，并且**只在该值为真时**求值 `driverInDelta` 断言。其它分支上额外打印一行点明分支名与理由；`evaluated=false` 是一行打印出来的读数，**不是静默跳过**。

用的是 Finding 里的修法 **(a)**，形状与先例 `gap-debug-agent-ac10-reads-the-whole-branch-delta`（`b5d6c663`，已在 develop）一致 —— 它的读数行是 `[AC10] … touched=… evaluated=… branch=…`，本条是 `[AC6] driverInDelta=… evaluated=… branch=…`。

另：断言读的 delta 现在是**已提交的 `develop...HEAD` 集合与未提交工作树 delta 的并集**（`[...new Set([...workingTree, ...vsDevelop])]`）。这比只看任一半都强，也是 AC3(1) 能在「仅安装文件、未提交」的状态下读到红的原因。

**本条没有做的事（AC5）。** 没有删掉、没有削弱、没有改成恒真、没有降为 print，没有动任何其它判据，也没有对该 driver 的实现作任何评价。不变量本身 —— *这条判据读的 delta 必须是真的 delta、是产出这棵树的那条 delta，而它正是加进 driver 的那条* —— 在拥有它的分支上以**全部原有强度**断言（AC3 证明它在那里仍然会红）。变的只是这条断言在**哪条分支上**求值。

**它救不了的情形（AC5）。** 若将来某任务**故意**要改 `server/modules/providers/list/**`（含该 driver）并且该判据在自己的分支上（即 `CRITERION_OWNER_BRANCH`）求值，读数仍然应该红 —— 这正是 AC3(1) 保证的：同样的 delta、同样的命令，在 owner 分支上 exit 1、文案逐字不变。换句话说，设门挡住的是「别人的 delta」，不是「真的违反了不变量」。

### AC1 — 红，在别人的树上（改前）

worktree `/data/home/yale/work/claudecodeui-worktrees/gap-voice-error-notice-browser-e2e`，分支 `task/gap-voice-error-notice-browser-e2e`，`git status --porcelain` 为空（逐字干净），命令 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-host-per-run.test.ts`：

    gitDiff workingTreeFiles=0 vsDevelopFiles=8 containsNeighbour=false driverExists=true driverInDelta=false
    ✖ AC6: the criteria this one leans on are untouched and still green (18.078918ms)
      AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts
    ℹ tests 7   ℹ pass 6   ℹ fail 1
    EXIT=1

读数行与立案正文逐字一致（`vsDevelopFiles=8`）。该 worktree 的 `git diff --name-only develop...HEAD` 就是立案表里那 8 个文件：`e2e/voice-error-messages.spec.ts`、`e2e/voice-trim.spec.ts`、`playwright.config.ts`、`src/modules/chat/composer/ChatComposer.tsx`、`src/modules/chat/composer/VoiceInputButton.tsx`、`src/modules/chat/hooks/useVoiceInput.ts`、`src/modules/chat/tests/voiceErrorMessages.test.tsx`、`src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` —— 一个 `providers/**` 都没有。

### AC2 — 同一棵树，改后转绿并说明理由

⛔ **偏差，如实登记。** AC2 要的是「同一 worktree」。立案后 fleet 于 `2026-09-27T04:19:43Z` 重新派发了 `gap-voice-error-notice-browser-e2e`，执行本步时它**仍在飞**（`.quay/worker-round.jsonl` round 3428 的 `in_flight_tasks` 点名了它），往那个 worktree 里装文件会与在飞 worker 的 fan-in 抢同一棵树。因此改用**该任务那次红所在的同一个 commit** `4cd4a5a44f55ba9065db4677a30db5b626241b43` 造探测树：

    git worktree add -b task/gap-voice-error-notice-browser-e2e-probe <tmp> 4cd4a5a44f55ba9065db4677a30db5b626241b43
    git -C <tmp> diff --name-only develop...HEAD | wc -l   →  8      # 与 AC1 的树同一组文件
    git -C <tmp> rev-parse --abbrev-ref HEAD               →  task/gap-voice-error-notice-browser-e2e-probe

**先证明这棵树就是 AC1 读的那棵树**（装修复前，同一命令）：

    gitDiff workingTreeFiles=0 vsDevelopFiles=8 containsNeighbour=false driverExists=true driverInDelta=false
    ℹ tests 7   ℹ pass 6   ℹ fail 1   →   EXIT=1
    AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts

读数行与 AC1 **逐字相同**（`vsDevelopFiles=8`、文案相同）⇒ 这棵探测树确实是 AC1 读到红的那棵树。再在同一棵树上装入修好的判据文件，跑同一命令：

    gitDiff workingTreeFiles=1 vsDevelopFiles=8 containsNeighbour=false driverExists=true driverInDelta=false
    [AC6] driverInDelta=false evaluated=false branch=task/gap-voice-error-notice-browser-e2e-probe
    [AC6] the develop-delta assertion is NOT evaluated here: this tree is on branch task/gap-voice-error-notice-browser-e2e-probe, and that invariant is decided on task/gap-session-hosts-claude-per-run-driver. A delta that does not name server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts on this branch is a sibling task's declared scope, not a violation of this criterion; the reading above is printed, not asserted.
    neighbour server/modules/providers/tests/claude-background-work.test.ts exit=0 tests=10 pass=10 fail=0
    parity server/modules/providers/tests/passthrough-parity.test.ts exit=0 tests=4 pass=4 fail=0
    ℹ tests 7   ℹ pass 7   ℹ fail 0   →   EXIT=0

转绿，且输出里有一行点明「未在此分支求值」并带分支名与理由 —— 与 AC2 要求的形状一致（AC 正文给的是「例如」，实际分支名是探测树自己的名字，因为该分支名此刻被在飞 worker 占用）。

### AC3 — 负控制，三条读数把两个变量各自孤立

owner 分支的临时 worktree（分支名**现造**，立案时该分支与 worktree 均已回收）：

    git worktree add -b task/gap-session-hosts-claude-per-run-driver <tmp> develop
    git -C <tmp> rev-parse --abbrev-ref HEAD   →  task/gap-session-hosts-claude-per-run-driver

读法同 `gap-debug-agent-ac10-reads-the-whole-branch-delta` 的 AC3：⛔ 没有用「把分支判定强制为真」的探针 —— 分支名真的造出来了。

**(1) delta 非空且不含 `DRIVER_PATH`（仅安装修好的判据文件，未提交）→ 必须红**

    git status --porcelain  →  " M server/modules/providers/tests/claude-host-per-run.test.ts"
    gitDiff workingTreeFiles=1 vsDevelopFiles=0 containsNeighbour=false driverExists=true driverInDelta=false
    [AC6] driverInDelta=false evaluated=true branch=task/gap-session-hosts-claude-per-run-driver
    ✖ AC6   AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts
    ℹ tests 7   ℹ pass 6   ℹ fail 1   →   EXIT=1

注意这里 `vsDevelopFiles=0`（HEAD 仍是 develop），delta 非空**完全由并集里的未提交那一半提供** —— 「安装该文件本身即满足」正是这么满足的。

**(2) 同树 + 对 `DRIVER_PATH` 本身做一处 scratch 改动 → 转绿**

    printf '\n// AC3 scratch probe line — reverted below\n' >> server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts
    gitDiff workingTreeFiles=2 vsDevelopFiles=0 containsNeighbour=false driverExists=true driverInDelta=true
    [AC6] driverInDelta=true evaluated=true branch=task/gap-session-hosts-claude-per-run-driver
    ℹ tests 7   ℹ pass 7   ℹ fail 0   →   EXIT=0

**(3) 别的分支的 worktree、带同样的 (1) 号 delta（同样只装那一个文件）→ 绿且 `evaluated=false`**

    git worktree add -b task/gap-ac3-scope-control <tmp> develop
    git status --porcelain  →  " M server/modules/providers/tests/claude-host-per-run.test.ts"      # 与 (1) 同 delta
    gitDiff workingTreeFiles=1 vsDevelopFiles=0 containsNeighbour=false driverExists=true driverInDelta=false
    [AC6] driverInDelta=false evaluated=false branch=task/gap-ac3-scope-control
    [AC6] the develop-delta assertion is NOT evaluated here: this tree is on branch task/gap-ac3-scope-control, and that invariant is decided on task/gap-session-hosts-claude-per-run-driver. …the reading above is printed, not asserted.
    ℹ tests 7   ℹ pass 7   ℹ fail 0   →   EXIT=0

**隔离。(1) 对 (3)**：delta 逐字相同（都只有那一个文件），只有分支不同 ⇒ 红/绿之差钉住的是**分支**。**(1) 对 (2)**：同一条 owner 分支，delta 从「不含 driver」变成「含 driver」⇒ 红/绿之差钉住的是 **delta 是否含 driver**。单看任一条读数都无法排除「把断言改哑了」，三条一起才排除。

**还原步骤与干净度。** 三个探测 worktree 拆除前的 `git status --porcelain`：

    /tmp/quay-ac2-probe-jQY1KG   task/gap-voice-error-notice-browser-e2e-probe   M server/modules/providers/tests/claude-host-per-run.test.ts
    /tmp/quay-ac3-owner-GCtF6j   task/gap-session-hosts-claude-per-run-driver     M server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts
                                                                                  M server/modules/providers/tests/claude-host-per-run.test.ts
    /tmp/quay-ac3-other-yi7YsF   task/gap-ac3-scope-control                       M server/modules/providers/tests/claude-host-per-run.test.ts

（即：只装了判据文件；owner 那棵另有 AC3(2) 的 scratch 行。）逐个拆除并删分支：

    git worktree remove --force <tmp>        # ×3，均成功
    git branch -D task/gap-session-hosts-claude-per-run-driver task/gap-voice-error-notice-browser-e2e-probe task/gap-ac3-scope-control
    git branch --list <上述三个名字>          →  空
    git worktree list | grep -c .            →  14

owner 分支与两个探测分支都已不存在，探测树的工作树改动随 worktree 一起丢弃；`gap-session-hosts-claude-per-run-driver` 这个名字回到立案时的状态（不存在）。

### AC4 — 门与范围

在本任务的 worktree（`/data/home/yale/work/claudecodeui-worktrees/gap-claude-host-per-run-delta-scope-gate`，分支 `task/gap-claude-host-per-run-delta-scope-gate`）内：

    npm run typecheck   →  TYPECHECK_EXIT=0
    npm run lint        →  LINT_EXIT=0        # 仅仓库既有的 warning，无 error
    git merge --no-edit develop              →  ort，无冲突（合入 tasks/gap-ac027-…md）
    git diff --name-only develop...HEAD      →  server/modules/providers/tests/claude-host-per-run.test.ts

delta 只含 Touches 里的代码文件（`tasks/gap-claude-host-per-run-delta-scope-gate.md` 由 `task_write` 自己提交，同样在 Touches 内）。

### 落地后如何读回来（DoD）

本条落到 develop 之后，任何 delta 不含该 driver 的兄弟任务在 fan-in 全量 suite 里：

    __PERFILE__ … server/modules/providers/tests/claude-host-per-run.test.ts passed=true

即 `claude-host-per-run.test.ts` 不再出现在 `.quay/fan-in-suite-*.log` 的红文件里；该判据自己那轮（owner 分支）仍然按 AC3(1) 的读数红。本条不改变那条不变量本身，也不评价该 driver 的实现。
