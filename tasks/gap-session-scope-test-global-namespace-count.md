---
id: gap-session-scope-test-global-namespace-count
title: claude-session-scope.test.ts 把 listClaudeSessionScopeUnits()
  的宿主全局计数当断言（等「恰好剩一个 scope」，10s 超时）：本机任何别的会话 scope 生产者（:3001 上的真实会话、并发 lane、DoD
  harness 起的临时 server）都会把它打红 —— 已连红两轮、挡住两个任务
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象（三次观测，同一断言）。** `server/modules/providers/tests/claude-session-scope.test.ts:262` 那条用例 `a session over its cap dies alone; a live sibling is untouched` 在 `:300` 用

```js
await waitUntil(() => listClaudeSessionScopeUnits().length === 1, 10_000,
  () => `one surviving session scope, saw ${JSON.stringify(listClaudeSessionScopeUnits())}`);
```

等的是**全宿主**的 `claudecodeui-session-*` 计数等于 1。`listClaudeSessionScopeUnits()`（`server/modules/providers/services/claude-session-scope.service.ts:363`）跑的是 `systemctl --user list-units 'claudecodeui-session-*' --no-legend --plain`，即操作员视角的完整列表，注释里也自陈「Consumed by stop, sweep and the session-scope tests' emptiness assertions」。**stop/sweep 读全局是对的**（它们的职责就是发现所有孤儿）；**测试把它当精确计数是错的**。

三次实测读数：

| 观测 | 实际列表 | 泄漏来源 |
|---|---|---|
| `.quay/fan-in-suite-gap-chat-edit-send-…~1790349548241-61217f.log` | `1173991-e710433d` / `1177720-a25be588` / `264422-f8cfcacc` | 三个**不同**属主 pid：两个并发 lane 的测试进程 + 当时活着的 `server/index.ts`(264422) |
| `.quay/fan-in-suite-gap-session-hosts-default-wrap-four-providers~wk-prod-anchor~1790350562645-af8de5.log` | 一长串 `2180019-*` | 单个属主 pid 名下**很多**个 scope（`2180019` 现在已死）——一个持有很多会话的进程，例如临时 server / DoD harness |
| 2026-09-26 我在主检出直接跑该文件 | `264422-016b7e1f` 等 **7** 个 | 当时活着的 `server/index.ts`(264422)，工作树无关 |

第三条最关键：**它不需要任何并发就能红** —— 只要这台机器上有一个真实 server 托着活跃会话（本机的常态；我读的时候 `systemctl --user list-units 'claudecodeui-session-*'` 有 2 个 active，里面是真在跑的 `claude --output-format stream-json`），这个断言就永远等不到 1。

**根因。** 该用例自己造的 scope 已经带属主 pid（`buildClaudeSessionScopeUnitName(process.pid, suffix)`，`:376` / `:395` 两处创建都在用），**只有读取那一侧没有归因**：`listClaudeSessionScopeUnits()` 返回混合列表，断言却按全局计数比较。

**修法（与 `d5f7904b` 对 voice 判据的修法同形：把读数归到本进程）。** 在测试侧加一个只属于本进程的读取：

```js
const ownScopes = () => listClaudeSessionScopeUnits()
  .filter((unit) => unit.startsWith(buildClaudeSessionScopeUnitName(process.pid, '')));
```

`:300` 的等待改成「**我的** scope 里恰好剩一个」，`:367` 那条 `stopping this server's scopes leaves none, and sweep takes only orphans` 同样按本进程前缀断言（它的孤儿用例本来就自己造带假 pid 的 unit，不受影响）。**不改产品侧** `listClaudeSessionScopeUnits()` 的全局语义（stop/sweep 依赖它）。README 式的说明写在测试文件的注释里：为什么断言必须带属主前缀。

**为什么不选另外两条路。** (a) 把断言放宽成 `>= 1`：会放过「两个 scope 都活着」这种真失败，判据失去分辨力。(b) 给服务函数加 owner 过滤参数：动产品面，而所有消费方（stop/sweep）要的正是全局列表，为一个测试改产品语义不划算。

**边界。** 这不是 voice `__criterion-falsify-*` 那条串扰（`d5f7904b` 已修），也不是各任务自己的 delta：三次观测里被挡住的 `gap-session-hosts-default-wrap-four-providers` 与 `gap-chat-edit-send-unawaited-handler-lane-flake` 的 `## Touches` 都不含 `server/modules/providers/`。判据本身属于已 done 的 `gap-claude-session-cgroup-scope`，其存量通道无人接手，本任务接手。

## AC

- [x] AC1 读数归到本进程：`grep -n 'listClaudeSessionScopeUnits' server/modules/providers/tests/claude-session-scope.test.ts` 的每一处断言读法都带本进程属主前缀（`buildClaudeSessionScopeUnitName(process.pid, …)`），没有一处再对全局计数做等值断言；给出改动前后的 `grep -n` 输出对照。
- [x] AC2 有分辨力（本进程的失败仍然红）：在改动后的树上，把某个由本进程创建的 scope 在收尾前手动留下（例如注释掉 `finally` 里的一次 `stopClaudeSessionScopes()`，或在用例内多起一个本进程的 scope 而不停），该用例必须退出码非 0，红态文案点名**多出来的那个本进程 scope**。用后还原，读数与还原后的 md5 抄进完成记录。
- [x] AC3 外部 scope 不再打红（正对照，逐条登记）：在树上植入一个**外部**会话 scope（`systemd-run --user --scope --unit=claudecodeui-session-99999999-foreignprobe -- sleep 30`，属主 pid 不存在），随后跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts`，必须 **exit 0**；撤掉植入（`systemctl --user reset-failed` + 确认 `list-units` 里不再有该 unit）后再跑一次仍 exit 0。两次读数与 `systemctl --user list-units 'claudecodeui-session-*'` 的原文一并登记。
- [x] AC4 其余用例不回归：该文件整体 `tests N / pass N / fail 0`、exit 0；`npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat develop...HEAD` 只含 `## Touches` 里的文件（若诊断需要动产品文件，按 AC5 处理）。
- [x] AC5 范围纪律：改动只允许落在 `server/modules/providers/tests/claude-session-scope.test.ts`。若证明必须改产品侧（`claude-session-scope.service.ts`）才能修，**停止**，把证据写进完成记录并按机制另立 gap 任务；不得把改动伸到 Touches 之外。

## DoD

真实落地判据不是「把断言改松」：AC2 证明本进程的失败仍然红（判据没被削弱），AC3 证明外部 scope 在场时不再红（这正是三轮 fan-in 红的触发条件），两条合起来才是「读数已归因」的证据。完成记录必须写：三次观测的原始列表（含本机 :3001 上有活跃会话时的读数）、AC3 的植入命令与 `systemctl` 原文、AC2 的红态文案、还原后的 md5。收尾时本机不应留下本任务造的 scope（`systemctl --user list-units 'claudecodeui-session-*'` 与开工前一致，读数抄进记录）。

## Touches

- server/modules/providers/tests/claude-session-scope.test.ts
- tasks/gap-session-scope-test-global-namespace-count.md

## 完成记录（2026-09-26，worker，分支 task/gap-session-scope-test-global-namespace-count，提交 421b66dd）

**改动。** 只动 `server/modules/providers/tests/claude-session-scope.test.ts`（AC5）：加一个模块级 `ownScopes(startedHere)` 归因读取，8 处断言读法全部改走它；产品侧 `claude-session-scope.service.ts` 一字未动（stop/sweep 要的正是全局列表）。

**与 Proposal 的偏差（Proposal 给的 `ownScopes` 只按本进程前缀，不够）。** `:367` 那条用例的两个孤儿 fixture 由 `buildClaudeSessionScopeUnitName(deadOwnerPid, suffix)` 造出，属主是**故意死掉的假 pid**，本进程前缀永远选不中它们：只按前缀过滤的话第 397 行 `length === 3` 恒为 1，用例必然 10s 超时（这属于把一条绿用例改成红的，不是修）。所以归因有两臂——本进程前缀（hook 造的 scope）+ 调用点自报名（`startScope` 造的 fixture，`ownScopes(startedHere)` 传入）。两臂都不会漏进外部 unit：`parseClaudeSessionScopeOwnerPid` 的正则是 `^claudecodeui-session-(\d+)-`，前缀是 `claudecodeui-session-${process.pid}-`，而 `startedHere` 只含本文件自己起的名字。

**AC1 改动前后 `grep -n 'listClaudeSessionScopeUnits'` 对照。**
改前 —— 8 处断言读法直接读全局列表（`length === 1` / `length === 3` / `deepEqual([], …)` / `deepEqual([survivor], …)`）：

```
299:      () => listClaudeSessionScopeUnits().length === 1,
302:      () => `one surviving session scope, saw ${JSON.stringify(listClaudeSessionScopeUnits())}`,
378:      () => owned.every((unit) => listClaudeSessionScopeUnits().includes(unit)),
380:      () => `three session scopes, saw ${JSON.stringify(listClaudeSessionScopeUnits())}`,
386:      listClaudeSessionScopeUnits(),
397:      () => listClaudeSessionScopeUnits().length === 3,
399:      () => `three scopes before the sweep, saw ${JSON.stringify(listClaudeSessionScopeUnits())}`,
405:      listClaudeSessionScopeUnits(),
```

改后 —— `listClaudeSessionScopeUnits` 全文件只剩 1 处调用，就在归因过滤器内部（第 93 行）；断言读法 8 处全部经 `ownScopes(...)`，没有一处再对全局计数做等值断言：

```
13:  listClaudeSessionScopeUnits,                                  <- import
72: * The unit names from {@link listClaudeSessionScopeUnits} that belong to this file.
91:const ownScopes = (startedHere: readonly string[] = []): string[] => {
92:  const ownPrefix = buildClaudeSessionScopeUnitName(process.pid, '');
93:  return listClaudeSessionScopeUnits().filter(
328:      () => ownScopes().length === 1,
331:      () => `one surviving session scope, saw ${JSON.stringify(ownScopes())}`,
407:      () => owned.every((unit) => ownScopes(owned).includes(unit)),
409:      () => `three session scopes, saw ${JSON.stringify(ownScopes(owned))}`,
415:      ownScopes(owned),
429:      () => ownScopes(fixtures).length === 3,
431:      () => `three scopes before the sweep, saw ${JSON.stringify(ownScopes(fixtures))}`,
437:      ownScopes([survivor]),
```

**三次观测的原始列表。** 任务正文登记的三次读数照抄在上表（`1173991-e710433d`/`1177720-a25be588`/`264422-f8cfcacc` 三属主 pid；`2180019-*` 一长串同属主；主检出 7 个 `264422-*`）。

**本机 :3001 的读数（开工前后，2026-09-26 08:33）。** `systemctl --user list-units 'claudecodeui-session-*' --no-legend --plain` → **空**（exit 0）。`server/index.ts` 确实在跑（pid 2853651，`pgrep -af` 原文：`node .../.bin/tsx --tsconfig server/tsconfig.json server/index.ts`），但那一刻它**不托活跃会话**，所以这台机器今天"恰好干净"——旧断言在干净机器上照样绿。这正是 AC3 必须植入外部 scope 的原因：不能靠"今天恰好没别人"来证明修好了。

**AC3 植入 + 两次读数。**
植入命令（原文，含 `setsid` 以脱离本工具调用的进程组）：

```
setsid systemd-run --user --scope --unit=claudecodeui-session-99999999-foreignprobe -- sleep 30 &
```

植入后 `systemctl --user list-units 'claudecodeui-session-*' --no-legend --plain` 原文：

```
claudecodeui-session-99999999-foreignprobe.scope loaded active running /usr/bin/sleep 30
```

跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-scope.test.ts` → `tests 9 / pass 9 / fail 0`，**exit 0**。

撤掉植入：该 unit 已被用例自身的 `sweepOrphanClaudeSessionScopes()` 收走（属主 pid 不存在 = 孤儿，stop + reset-failed 正是产品侧的正确行为），`list-units` 与 `list-units --all` 均已为空，`reset-failed` 回报 `Unit claudecodeui-session-99999999-foreignprobe.scope not loaded.`。再跑一次 → `tests 9 / pass 9 / fail 0`，**exit 0**。

**反证：同一植入下，改前的树是什么读数。** 把 develop 版原文取出来（md5 `a661edb979b03fe4bdf35236b6e27d6f`，与开工前的 md5 相同）跑同一命令，探针事先在 `list-units` 里核实过、并有逐 0.5s 的监视器采样证明它整个 10s 等待窗口都在列表里：

```
✖ a session over its cap dies alone; a live sibling is untouched (10745.903708ms)
ℹ tests 9
ℹ pass 8
ℹ fail 1
AssertionError [ERR_ASSERTION]: timed out after 10000ms waiting for: one surviving session scope,
saw ["claudecodeui-session-3715645-c4c8cae1.scope","claudecodeui-session-99999999-foreignprobe.scope"]
```

即外部 scope 在场时旧断言必红（exit 1），且红态文案里就点着外部 unit 的名字——三次观测的触发条件在本地复现了。临时文件跑完即删，`git status` 干净。

**AC2 分辨力（本进程的失败仍然红）。** 在改后的树上插一行本进程的额外 scope 并等它出现（避免竞态），该用例必须红：

```
✖ a session over its cap dies alone; a live sibling is untouched (10729.526455ms)
ℹ tests 9
ℹ pass 8
ℹ fail 1        exit 1
AssertionError [ERR_ASSERTION]: timed out after 10000ms waiting for: one surviving session scope,
saw ["claudecodeui-session-3790195-4cb3f5eb.scope","claudecodeui-session-3790195-extraneous.scope"]
```

红态文案点名了多出来的那个本进程 scope（`claudecodeui-session-3790195-extraneous.scope`）。判据没有被改松——AC3 的"不再红"不是靠放过真失败换来的。

**还原与 md5。** `git checkout -- server/modules/providers/tests/claude-session-scope.test.ts`；还原后 md5 **`e55a44104db3718ebd3bfd7780bd0a58`**，与已提交版本 `421b66dd` 的 blob md5（`git show HEAD:<file> | md5sum`）逐字节一致；还原后重跑 → `tests 9 / pass 9 / fail 0`，exit 0。

**AC4。** 该文件 `tests 9 / pass 9 / fail 0`、exit 0；`npm run typecheck`（`tsc --noEmit` × 3 个 tsconfig）exit 0；`npm run lint` exit 0（只有存量 warning）；`git diff --stat develop...HEAD` = `server/modules/providers/tests/claude-session-scope.test.ts | 50 ++++++----`（1 file changed, 41 insertions(+), 9 deletions(-)），只含 Touches 里的文件（另一条 Touches 就是本任务文件自身）。

**收尾读数。** `systemctl --user list-units 'claudecodeui-session-*' --no-legend --plain` → 空；`--all` → 空；`list-unit-files 'claudecodeui-session-*'` → 无匹配。与开工前一致，本任务没在机器上留下任何 scope。

**顺带观测（备查，不在本任务范围）。** 监视器显示 `systemctl --user list-units` 在机器繁忙时会**间歇返回空**（10 个采样里 6 个空，而同期明明有 scope 在跑）。`listClaudeSessionScopeUnits()` 在 `status !== 0 || !stdout` 时返回 `[]`，所以"全局计数等值"还有第三条误红路径：一次失败的 `systemctl` 读。归因之后这条路径只可能影响"本进程 scope 恰好为 0"那类断言；本文件剩下的都是单调逼近的等待式断言，不受影响。
