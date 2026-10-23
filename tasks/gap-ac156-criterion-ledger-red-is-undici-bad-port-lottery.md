---
id: gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery
title: AC-156 判据台账红是 undici bad-port 抽签：判据命令 npx tsx --test 直跑绕开了只接在测试通道的
  scripts/undici-blocked-ports-preload.mjs，净检出三跑 7/7/0 — verification-only
  归因入档，不重新实现
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-156
---
## Proposal

来源：本轮 gap-filing 的**直接测量 + 机制归因**（不是台账尾巴本身）。GOAL-012（`status: achieved`，非 `long-term`）的 AC-156（`goals/AC-156-get-api-session-hosts-列出所有-provider-的宿主-含状态-绑定-保活理由与关闭原因-需鉴权.md`，`status: achieved`）被判 CURRENTLY FALSE 交办。认领 AC-156 的唯一任务 `gap-session-hosts-rest-list-endpoint`（`goal_ac: AC-156`）已是 `done`。故本轮先直跑判据 + 归因，判定「早先的修复是否真的没兜住」。

判据物（逐字取自该 goal 文件的 `criterion:`）：

```
npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts
```

**本轮直接现测：判据在当前检出（`/data/home/yale/work/claudecodeui`，branch `author`）上退出 0，`tests 7 / pass 7 / fail 0`（三跑一致）。** AC-156 的保证——需鉴权的 `GET /api/session-hosts` 用宿主层快照列出全部 provider 的宿主（含 state/pid/bindings/closeReason）、lingering 可见、关闭原因有注入时钟的保留窗口——逐条通过。

**机制：undici bad-port 抽签，不是 AC-156 回归。** 判据本体用 `app.listen(0, '127.0.0.1')`（`server/modules/session-hosts/tests/session-hosts-routes.test.ts:393`）再用全局 `fetch`（`:430` 的 `getListing`）打回自己。内置 undici 对 18 个端口直接拒绝（`[TypeError: fetch failed] { [cause]: Error: bad port }`，发生在打开 socket 之前）；本机 `ip_local_port_range = 1024 65535`，内核给 `listen(0)` 分配端口时有概率落在其中，于是该文件随机红、单独重跑就绿——即内存 `undici-bad-port-lottery-in-listen0-route-tests` 的同一机制。

**为什么「早先的修复」没覆盖这一格：不是失效，是没接进判据通道。** repo 已有任务 `gap-undici-blocked-ports-held-in-server-test-lane`（`status: done`）落地了 `scripts/undici-blocked-ports-preload.mjs`，让测试通道的进程提前占住这 18 个端口。但它只把预加载接在**测试通道**两处：`package.json:55` 的 `test:server`、`scripts/test.sh:894` 与 `:896` 的 server 阶段（`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test "$f"`）。AC-156 的判据命令是**直接** `npx tsx --tsconfig server/tsconfig.json --test <file>`（不带 `--import`），由 goal 驱动器逐字执行 ⇒ 预加载不生效，抽签仍在。AC-156 的实现本身是对的（净树 7/7）。

**台账证据（`.quay/gate-events.jsonl`，`item_id=AC-156`、`gate=goal`）。** 判据落地后长期连绿；10-06 只有两个孤立红点：`2026-10-06T02:16:47.932Z` fail@tree `b694336b8e6c93b557d108471f844598e40ec845`、`2026-10-06T02:38:25.589Z` fail@tree `daa9c8958655c6c1cfef04a5432eed60d8ee0af6`；同一窗口另有 6 拍 pass（`02:17:48Z`…`02:35:32Z`）。红拍理由被存储截断（`… [truncated, 4324 chars of stdout omitted]`），保留的尾部是判据文件自身的 fetch 栈：`…/session-hosts-routes.test.ts:430:26) at <anonymous> (…:507:27) at withServer (…:397:11) at process.processTicksAndRejections`，**无任何断言文案**。同款指纹的同文件红也在别的任务（路径不相交）的 scoped gate 里出现过（`/tmp/fan-in-step-gap-occupied-session-read-only-mode-wk-prod-anchor-scoped-gate.log`：`__PERFILE__ … passed=false`、`__PERFILE_KIND__ … kind=assert`、文件级 `not ok - server/modules/session-hosts/tests/session-hosts-routes.test.ts:   [TypeError: fetch failed] {`）。`.quay/goal-round.jsonl` 连续 round 154–159 的 `frozenRecheck` 里 AC-156 全部 `verdict=pass` / `outcome=cleared` / `cause=now-true`。

⇒ **判法：AC-156 的保证成立；台账红尾是 undici bad-port 抽签（判据命令 `npx tsx --test` 直跑绕开了只接在测试通道上的 `scripts/undici-blocked-ports-preload.mjs`）。** 本条**不重新实现**，也不改判据/实现/goals/测试文件。

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -rn "^goal_ac: *AC-156" tasks/*.md` 命中**仅 1 条** —— `tasks/gap-session-hosts-rest-list-endpoint.md`，`status:` 逐字 **done**；在飞扫描（`^status:` ∈ todo/ready/needs-human 且 `^goal_ac: *AC-156`）**0 命中** ⇒ 无在飞认领者，本条不是重复。相邻任务 `gap-undici-blocked-ports-held-in-server-test-lane`（done）修的是**测试通道**（`test:server`/`scripts/test.sh`），未覆盖判据直跑通道，其边界逐字写着「不改任何 `server/**/*.test.*`」；本条只归因、也不改该测试文件，两条的机制与交付物都不同。

## Plan

1. 建本条隔离 worktree（起点 = 开工时 `develop`），打印路径与 `git rev-parse HEAD`，确认 `git status --porcelain` 空。
2. 在净 worktree 里直跑判据**三次**（出货命令逐字不改），抄 `ℹ tests`/`ℹ pass`/`ℹ fail`、三次退出码与七条用例名。
3. 机械复核「判据命令绕开预加载」：`grep -n -- '--import' package.json scripts/test.sh`；`grep -n "listen(0" server/modules/session-hosts/tests/session-hosts-routes.test.ts`；`grep -n "await fetch" server/modules/session-hosts/tests/session-hosts-routes.test.ts`；`ls -l scripts/undici-blocked-ports-preload.mjs`。
4. 抄台账：AC-156 的 goal gate 判决序列（含 10-06 两红点与 6 拍 pass、`treeSha`）、红拍理由的截断形态与尾部 fetch 栈；抄 `.quay/goal-round.jsonl` 最近 round 的 `frozenRecheck` AC-156 条目。
5. 交付只落 `tasks/<本条 id>.md`。

## AC

- [x] AC1 判据在**净检出**（本条隔离 worktree，起点 = 开工时 `develop`，`git status --porcelain` 空；打印 worktree 路径与 `git rev-parse HEAD`）直跑三次：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts` 均退出 **0**，`ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0` 与七条用例名逐字入档（稳定绿：三跑读数一致）。红态基线（立案读数）：当前检出直跑 exit 0；台账末拍红 `2026-10-06T02:38:25.589Z`@tree `daa9c895` 退出 1。
- [x] AC2 机制归因的机械证据入档：(a) `grep -n -- '--import' package.json scripts/test.sh` 逐字显示 `scripts/undici-blocked-ports-preload.mjs` 只接在 `package.json:55` 的 `test:server` 与 `scripts/test.sh:894`/`:896` 的 server 阶段，**不**在判据命令里；(b) `grep -n "listen(0" server/modules/session-hosts/tests/session-hosts-routes.test.ts` → `:393`；(c) `grep -n "await fetch" server/modules/session-hosts/tests/session-hosts-routes.test.ts` → `:430`；(d) `ls -l scripts/undici-blocked-ports-preload.mjs` 存在。命令与逐字输出入档。
- [x] AC3 台账证据逐字入档：`.quay/gate-events.jsonl` 里 `item_id=AC-156`、`gate=goal` 的判决序列（明确含 `2026-10-06T02:16:47.932Z` fail@`b694336b`、`2026-10-06T02:38:25.589Z` fail@`daa9c895`，与同窗 6 拍 pass），红拍理由的被截断形态与尾部 fetch 栈（`:430:26` ← `:507:27` ← `withServer :397:11`，无断言文案）；`.quay/goal-round.jsonl` 最近 round 的 `frozenRecheck` 里 AC-156 全部 `verdict=pass` / `cause=now-true`。
- [x] AC4 判法写明：**「AC-156 的保证成立；台账红尾是 undici bad-port 抽签（判据命令 `npx tsx --test` 直跑绕开了只接在测试通道上的 `scripts/undici-blocked-ports-preload.mjs`）」**，并给出残留未钉死假设（抽签不可复现；红拍 stdout 的 `cause` 未被存储保留，机制由站点指纹与同族先例认定）。
- [x] AC5 承重面未触碰：`git diff --name-only develop...HEAD -- server src goals scripts package.json` 为空；`git status --porcelain` 与开工快照逐字相同；唯一交付物是 `tasks/<本条 id>.md`。

## DoD

- 出货判据（逐字不改；⛔ 不改断言、不改判据、不改实现）在净检出上真的跑过、退出 0，`7/7/0` 与七条用例名逐字入档——不是复述 AC 文字、不是读台账。
- 机制归因可由任何人在同一 checkout 上复现：判据命令无 `--import`、`test:server`/`scripts/test.sh` 有、`listen(0)`+`fetch` 的站点行号、预加载文件存在；命令与逐字输出写进完成记录。
- 台账序列与 `goal-round` recheck 读数逐字入档，含红拍理由的截断说明。
- 完成记录明确写出判法（见 AC4）与残留未钉死假设。
- 若净树直跑为**红**（红与抽签无关、判据真的坏了），本条必须**停手上报**：置 `needs-human` 并写明「判据在净检出上也是红的，归因不成立，应按缺陷任务重立」——⛔ 不得把环境红写成产品绿。
- 交付物只动 `tasks/<本条 id>.md`。

## 完成记录

**判法（AC4）：AC-156 的保证成立；台账红尾是 undici bad-port 抽签 —— 判据命令 `npx tsx --test` 直跑绕开了只接在测试通道上的 `scripts/undici-blocked-ports-preload.mjs`。** 本条 verification-only：未改判据、未改实现、未改 goals、未改任何测试文件，也未动承重面。净树直跑**为绿**，故不走 DoD 的停手上报分支。

### AC1 —— 判据在净检出上三跑稳定绿

- worktree：`/tmp/wt-gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery`
- `git rev-parse HEAD` = `b6d63fb6a25b850b452e3ff5010030587e85c718`（= 开工时 `develop` 尖）
- `git status --porcelain` = **空**（开工快照，且收工时逐字相同）

三次直跑（命令逐字不改，在净 worktree 内执行）：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts
```

| 跑 | exit | ℹ tests | ℹ pass | ℹ fail | duration_ms |
|----|------|---------|--------|--------|-------------|
| 1 | 0 | 7 | 7 | 0 | 4004.998655 |
| 2 | 0 | 7 | 7 | 0 | 3490.444881 |
| 3 | 0 | 7 | 7 | 0 | 3521.240223 |

`ℹ suites 0` / `ℹ cancelled 0` / `ℹ skipped 0` / `ℹ todo 0` 三跑一致。七条用例名（三跑逐字相同）：

```
AC2: the listing needs a token, and the harness can also answer 200 html
AC3/AC4: two hosts — one run in flight and one whose turn ended while its run is still held
AC5: a closed host is readable inside the retention window and gone after it
AC6: the listing is JSON, enveloped, and every host carries exactly the declared keys
AC7: a manager that never dispatched a turn lists nothing
AC1/AC2: every session row carries occupiedBy, and it is the holder or null
AC3: one GET scans the registry directory once, and the next GET re-reads it
```

红态基线（对照，非本次读数）：台账末拍红 `2026-10-06T02:38:25.589Z`@tree `daa9c8958655` 退出 1 —— 见 AC3 的逐字理由。

### AC2 —— 判据通道绕开预加载的机械证据

(a) `grep -n -- '--import' package.json scripts/test.sh`，逐字输出（**判据命令不在其中**）：

```
scripts/test.sh:894:          npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test "$f" >"$TMP/srv-$i.out" 2>&1
scripts/test.sh:896:        npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test "$f" >"$TMP/srv-$i.out" 2>&1
package.json:55:    "test:server": "bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test --test-concurrency=16 \"server/**/*.test.ts\" \"server/**/*.test.js\"",
```

三处**全部**是测试通道（`package.json:55` 的 `test:server`、`scripts/test.sh:894`/`:896` 的 server 阶段）。goal 文件里逐字的判据命令（`sed -n '7,8p' goals/AC-156-…md`）：

```
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/session-hosts/tests/session-hosts-routes.test.ts
```

⇒ 判据命令**不带** `--import`，预加载不生效。

(b) `grep -n "listen(0" server/modules/session-hosts/tests/session-hosts-routes.test.ts`：

```
393:  const server = app.listen(0, '127.0.0.1');
```

(c) `grep -n "await fetch" server/modules/session-hosts/tests/session-hosts-routes.test.ts`：

```
430:  const response = await fetch(`${context.baseUrl}${route}`, { headers });
481:    const unmounted = await fetch(`${context.baseUrl}/api/session-hosts-does-not-exist`);
```

`:430` 在 `getListing` 里（每个用例都经过它）；`:481` 是 AC2 的正对照。两处都走全局 `fetch`。

(d) `ls -l scripts/undici-blocked-ports-preload.mjs`：

```
-rw-rw-r-- 1 yale yale 5908 Oct  6 10:45 scripts/undici-blocked-ports-preload.mjs
```

**旁证（正向对照，只读、未改任何文件）：** 该预加载模块自己的头注释逐字记录了同一机制——「undici (Node's built-in `fetch`) rejects 18 ports outright, before it opens a socket」、「this host: /proc/sys/net/ipv4/ip_local_port_range = "1024 65535"」、「the same file that is green on a rerun reds with `bad port`」，并逐字写明它只被 `package.json` 的 `test:server` 与 `scripts/test.sh` 的两处 server-file 调用加载。本机复核：`cat /proc/sys/net/ipv4/ip_local_port_range` → `1024	65535`。

**指纹复现（`node -e`，只读不写）：** 让一个**真实 socket 已在监听**的端口落进 18 个 blocked 端口（取 6667），再 `fetch` 它：

```
listening on 127.0.0.1:6667 (a real socket IS open)
name= TypeError
message= fetch failed
cause.name= Error
cause.message= bad port
toString= TypeError: fetch failed
```

即 `TypeError: fetch failed` / `cause: bad port` 在**服务端完全可达**的情况下依然发生 —— 拒绝发生在 undici 客户端层、开 socket 之前，与 AC3 红拍/sibling 日志里 `[TypeError: fetch failed] {` 的前缀逐字同型，也与内存 `undici-bad-port-lottery-in-listen0-route-tests` 同机制。

**同一判据补上缺失通道即为绿（诊断，非交付）：** `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/session-hosts/tests/session-hosts-routes.test.ts` → `ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0`，exit 0 —— 两条通道的唯一差别就是 `--import`。

### AC3 —— 台账逐字入档

**`.quay/gate-events.jsonl`，`item_id=AC-156`、`gate=goal`，2026-10-06 全窗口（含两红点与 6 拍 pass）：**

```
2026-10-06T02:16:47.932Z  verdict=fail  actor=goal-sweep   tree=b694336b8e6c
2026-10-06T02:17:48.264Z  verdict=pass  actor=goal-cli     tree=8f008347b8bc
2026-10-06T02:19:42.297Z  verdict=pass  actor=goal-cli     tree=8f008347b8bc
2026-10-06T02:21:49.104Z  verdict=pass  actor=goal-cli     tree=e53bd7988277
2026-10-06T02:24:18.067Z  verdict=pass  actor=goal-cli     tree=e53bd7988277
2026-10-06T02:27:00.033Z  verdict=pass  actor=goal-cli     tree=a77bf7b16582
2026-10-06T02:35:32.280Z  verdict=pass  actor=goal-cli     tree=260ef93c91f7
2026-10-06T02:38:25.589Z  verdict=fail  actor=goal-cli     tree=daa9c8958655
2026-10-06T02:46:00.354Z  verdict=pass  actor=goal-cli     tree=ab73ec168ce5
```

两个红点的**理由逐字**（存储上限截断，原样抄录）：

```
2026-10-06T02:16:47.932Z tree=b694336b8e6c93b557d108471f844598e40ec845 criterionHash=0711d343b4d94d23
acceptance failed (exit 1) — … [truncated, 4402 chars of stdout omitted] e/work/claudecodeui/server/modules/session-hosts/tests/session-hosts-routes.test.ts:430:26) at withServer.listSessions (/data/home/yale/work/claudecodeui/server/modules/session-hosts/tests/session-hosts-routes.test.ts:802:31) at withServer (/data/home/yale/work/claudecodeui/server/modules/session-hosts/tests/session-hosts-routes.test.ts:397:11) at process.processTicksAndRejections (node:internal/process/task_queues:104:5) }

2026-10-06T02:38:25.589Z tree=daa9c8958655c6c1cfef04a5432eed60d8ee0af6
acceptance failed (exit 1) — … [truncated, 4324 chars of stdout omitted] ata/home/yale/work/claudecodeui/server/modules/session-hosts/tests/session-hosts-routes.test.ts:430:26) at <anonymous> (/data/home/yale/work/claudecodeui/server/modules/session-hosts/tests/session-hosts-routes.test.ts:507:27) at withServer (/data/home/yale/work/claudecodeui/server/modules/session-hosts/tests/session-hosts-routes.test.ts:397:11) at process.processTicksAndRejections (node:internal/process/task_queues:104:5) }
```

两条均为 500 字符截断（存储上限），**无 `AssertionError`、无 `not ok`、无任何断言文案**；保留的尾部是判据文件自身的 fetch 栈。站点行号经本检出逐字核对：

```
:393 → const server = app.listen(0, '127.0.0.1');
:397 → await run({                        (withServer 内)
:430 → const response = await fetch(...)  (getListing 内)
:507 → const listing = await getListing(context);
```

即 `:430:26`（`getListing` 里的 fetch）← `:507:27` / `:802:31`（用例体调 `getListing`）← `withServer :397:11`。

**`.quay/goal-round.jsonl` 的 `frozenRecheck`（`facts[].value.frozenRecheck.entries`），AC-156 全部条目：**

```
round=154 ts=2026-10-06T02:18:11.482Z attempted=5  AC-156 verdict=pass outcome=cleared cause=now-true durMs=4088 head=4d5e4c9a7985 behindDevelop=0
round=155 ts=2026-10-06T02:20:05.477Z attempted=5  AC-156 verdict=pass outcome=cleared cause=now-true durMs=4182 head=4d5e4c9a7985 behindDevelop=0
round=156 ts=2026-10-06T02:22:14.003Z attempted=5  AC-156 verdict=pass outcome=cleared cause=now-true durMs=4325 head=0f8f9261ae90 behindDevelop=0
round=157 ts=2026-10-06T02:24:49.230Z attempted=5  AC-156 verdict=pass outcome=cleared cause=now-true durMs=4216 head=0f8f9261ae90 behindDevelop=0
round=158 ts=2026-10-06T02:33:33.775Z attempted=6  AC-156 verdict=pass outcome=cleared cause=now-true durMs=4664 head=c46961cb01ed behindDevelop=0
round=159 ts=2026-10-06T02:36:25.657Z attempted=6  AC-156 verdict=pass outcome=cleared cause=now-true durMs=4410 head=63fdabfd7eec behindDevelop=0
```

round 154–159 的 AC-156 **全部** `verdict=pass` / `outcome=cleared` / `cause=now-true`，与立案读数一致。

**本轮追加的全量基数（立案时未读，补齐以免以偏概全）：** 全时 `item_id=AC-156`+`gate=goal` 共 1584 拍，其中 1055 拍红**全部**落在 09-25/09-26 判据实现前（理由逐字为 `Could not find 'server/modules/session-hosts/tests/session-hosts-routes.test.ts'`），非本条机制。**判据落地（首拍 pass `2026-09-26T13:01:55.043Z`）之后共 532 拍：528 pass / 4 fail**（09-26 两拍、10-06 两拍）。四拍红的指纹**同型** —— 最内层都是 `getListing` 里的 `await fetch`，其上一帧是用例体，再上一帧是 `withServer`，**均无断言文案**；09-26 两拍只是文件更早版本的行号（`:384:26` ← `:593:27`/`:422:29` ← `withServer :351:11`），10-06 两拍是当前行号（`:430:26` ← `:507:27`/`:802:31` ← `withServer :397:11`）。另有 round 160（`ts=2026-10-06T02:44:18.869Z`）AC-156 `verdict=fail` / `outcome=confirmed-failing` / `cause=still-false`，理由与 02:38 那拍**逐字节相同**，而其后 `02:46:00.354Z` 的 goal gate 又是 pass —— 同一站点、相邻拍红绿翻转、无断言，即抽签的形状。

**sibling 先例（逐字，与 AC-156 路径不相交的任务）：** `/tmp/fan-in-step-gap-occupied-session-read-only-mode-wk-prod-anchor-scoped-gate.log`

```
__PERFILE__ duration_ms=2886 server/modules/session-hosts/tests/session-hosts-routes.test.ts passed=false end_ms=1790910310506
__PERFILE_KIND__ file=server/modules/session-hosts/tests/session-hosts-routes.test.ts kind=assert
not ok - server/modules/session-hosts/tests/session-hosts-routes.test.ts:   [TypeError: fetch failed] {
```

（`kind=assert` 是把基础设施红误分类成断言，但文件级文案逐字是 `[TypeError: fetch failed] {`。）

### AC4 —— 判法与残留未钉死假设

**判法：AC-156 的保证成立；台账红尾是 undici bad-port 抽签 —— 判据命令 `npx tsx --test` 直跑绕开了只接在测试通道上的 `scripts/undici-blocked-ports-preload.mjs`。**

支撑链：(i) 净检出三跑 7/7/0、七条用例名一致（AC1）；(ii) 判据命令逐字无 `--import`，三处 `--import` 全在测试通道（AC2a）；(iii) 判据体内 `listen(0)`+全局 `fetch` 的站点与红拍栈帧逐字对齐，且红拍**无断言文案**（AC2b/c、AC3）；(iv) blocked-port 拒绝可在**服务端可达**时复现（AC2 正向对照）；(v) 落地后 532 拍里 4 拍红、四拍同型站点、相邻拍红绿翻转（AC3）；(vi) 同族先例已有一次同文件同文案的红被记进别的任务的 scoped gate（AC3 sibling）；(vii) 补上 `--import` 即绿（AC2）。

**残留未钉死假设（本条未钉死，据实记录）：**

1. **抽签不可复现。** 命中 18/64512 个端口的概率按 7 次 `listen(0)` 估算 ≈ 0.195%/跑；实测落地后 4/532 ≈ 0.75%/跑 —— 同量级但高约 4×。本条的归因**不依赖**这个比率（它由站点指纹、无断言文案、相邻拍红绿翻转、可复现的指纹正向对照共同承载）；比率偏差本身未钉死（可能来自 `withServer` 之外的额外 `fetch` 站点、并发驱动器同刻多跑、或内核端口分配的非常数分布），未做进一步测量。
2. **红拍 stdout 的 `cause` 未被存储保留。** 存储只留 500 字符，`[TypeError: fetch failed] { [cause]: Error: bad port }` 的那截恰在 `… [truncated, N chars of stdout omitted]` 里。故「就是 bad port」是由**站点指纹 + 可复现的正向对照 + 同族先例**认定的，不是从该红拍自己的 stdout 里读到的。
3. **10-06 的日级聚集未解释。** 09-27…10-05 共 228 拍 0 红，10-06 单日 9 拍 2 红。日级聚集的成因（宿主负载、端口占用变化等）本条未测。

**未做的事（据 AC/DoD 边界）：** 未改判据、未改实现、未改 goals、未改任何 `server/**/*.test.*`（含判据本体）；未给判据命令补 `--import`（属测试通道/驱动器的改动面，越出本条 Touches）。

### AC5 —— 承重面未触碰

```
$ git -C /tmp/wt-gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery diff --name-only develop...HEAD -- server src goals scripts package.json
(空)

$ git -C /tmp/wt-gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery diff --name-only develop...HEAD
(空)

$ git -C /tmp/wt-gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery status --porcelain
(空)
```

HEAD = `b6d63fb6a25b850b452e3ff5010030587e85c718`，branch = `task/gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery`：工作树与 `develop` **逐字节相同**，`git status --porcelain` 与开工快照一致。唯一交付物是 `tasks/gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery.md`（经 `task_write` 落库）。

## Touches

- `tasks/gap-ac156-criterion-ledger-red-is-undici-bad-port-lottery.md`（自触）
- `server/modules/session-hosts/tests/session-hosts-routes.test.ts`（本条只跑不改：判据本体）
- `scripts/undici-blocked-ports-preload.mjs`（本条只读不改：测试通道的抽签缓解本体）
- `goals/AC-156-get-api-session-hosts-列出所有-provider-的宿主-含状态-绑定-保活理由与关闭原因-需鉴权.md`（本条只读不改：criterion/expect 逐字来源）
