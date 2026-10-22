---
id: gap-tsc-sees-transient-probe-file
title: server/tsconfig.json 的 include 扫到 voice 判据的瞬时探针：voice-dashscope-settings
  的 AC4(b) 正控制在 server/modules/voice/tmp/ 写下 __stray-shipping-probe.ts 又删掉，并发的
  voice-capture-off AC6 typecheck 收进它之后报 TS6053 ⇒ 全舰队 suite 红、两个任务连停 6/7 轮
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

**真因（两条都有，逐字）。** 2026-09-26 的两轮 fan-in，红的是同一个文件、同一条断言，只是 worktree 路径不同：

```
not ok - server/modules/voice/tests/voice-capture-off.false-forms.test.ts:
  AC6 FAIL cases=n/a :: npm run typecheck (exit=2)
  | sig: error TS6053: File
    '/data/home/yale/work/claudecodeui-worktrees/<task-worktree>/server/modules/voice/tmp/__stray-shipping-probe.ts'
    not found.
```

两轮分别落在 `gap-session-hosts-default-wrap-four-providers`（10:12）与 `gap-claude-resident-phase0-experiments`（10:15）的 worktree 里，其余 237 个文件全绿。**这两个任务连停 7 轮 / 6 轮，根因就是这一条。**

**机制（三件事凑在一起）。**

1. `server/modules/voice/tests/voice-dashscope-settings.test.ts` 的 AC4(b) 正控制会**在仓内**造一个探针：`AC4B_POSITIVE_DIR = <voice 模块目录>/tmp`（`:1120`）、`AC4B_POSITIVE_FILE = …/__stray-shipping-probe.ts`（`:1121`），`:1218` `mkdir` + 写，用例收尾 `:1235` `rm -rf AC4B_POSITIVE_DIR`。这是 AC8 扫描要求的形态（必须在 `tests/` 之外、且是 `.ts`），设计上没错。
2. `server/tsconfig.json` 的 `include` 是 `["./**/*.js", "./**/*.ts", "../shared/**/*.js", "../shared/**/*.ts"]`，`exclude` 只有 `../dist` / `../dist-server*` / `../node_modules` / `../src` —— **`server/modules/voice/tmp/**` 在 include 里**。于是这个瞬时文件会被 `tsc` 收进 program。
3. `voice-capture-off.false-forms.test.ts` 的 AC6 会跑 `npm run typecheck`（= `tsc --noEmit -p tsconfig.json && … -p server/tsconfig.json && … -p scripts/tsconfig.json`）。suite 并发 16，两个文件同时在跑：tsc 收进探针 → 探针被 `rm -rf` → **TS6053**。

**为什么以前读不出来。** `voice-capture-off` 的 AC6 原来只断言「六个子命令退出码全为 0」，失败文案是静态字符串 `a surface this task must not have moved is red`，逐条读数只进 stdout，而 runner 的 per-file 输出随 `$TMP` 删除。`gap-voice-capture-off-ac6-red-not-attributable`（已 done）把命令名、退出码与子命令输出尾部带进消息之后，**同一条红第一次就点出了 TS6053**。本条接的就是它暴露出来的真因。

**影响面。** 这不是那两个任务的 delta（它们的 `## Touches` 与该文件无交集，且各自的两个 Touches 文件在同轮 `passed=true`）；它也不只打它们：任何在 suite 里跑 `voice-capture-off` 的轮次都会随这个竞态红，是**全舰队**的。

**修法（最小且对准根因）。** 把探针目录从 `tsc` 的视野里拿掉：在 `server/tsconfig.json` 的 `exclude` 里加上 `"./modules/voice/tmp"`。理由：

- AC8 的扫描是**直接走文件系统**（`collectSourceFiles(SERVER_DIR)` 递归 `readdir`），不看 tsconfig，所以探针照旧能被扫到、正控制照旧成立；
- `tsc` 从此不再看见这个目录，瞬时文件的出现/消失不再能影响任何一次并发的类型检查；
- 改动只有一行，不碰判据语义、不碰 `voice-dashscope-settings.test.ts` 的用例。

**备选（若实现者证明 exclude 不足以覆盖）**：让探针写到另一个已被 exclude 的目录、或把 `voice-capture-off` AC6 的类型检查改成不扫全仓。**不得**的做法：删掉正控制、把 AC6 放宽成「typecheck 可以非零」、或给 AC6 加 retry —— 那会把这条判据变成不承重的。

⛔ 不改 `scripts/test.sh`。

## AC

- [x] AC1 先拿到确定性复现（改前）：在一个 worktree 里，令探针文件存在一小段后被删，**同时**跑 `npm run typecheck`（`server/tsconfig.json` 那一支），使 `tsc` 在收进探针之后发现它已消失 → 退出码非 0 且文案含 `error TS6053` 与探针路径。把两侧命令、时序（探针创建/删除的时刻、tsc 起止）与红态原文抄进完成记录。这条读数在**未改**的树上取得，证明机制成立。
- [x] AC2 改后同一时序不再红：同一脚本在改后的树上重跑，同一时序下 `npm run typecheck` 退出 0（且不出现 TS6053）。读数与 AC1 并排登记。
- [x] AC3 正控制仍然成立：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-dashscope-settings.test.ts` 退出 0，且其 AC4(b) 正控制那一条读数仍为 `shipping-hits=1`（也就是说：探针仍旧被 AC8 的扫描找到，exclude 只对 `tsc` 生效，没有把判据的探测面一起拿掉）。给出该条读数原文。
- [x] AC4 门与回归：`npm run typecheck` 退出 0（三支 tsconfig 全跑）；`npm run lint` 退出 0；`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts` 退出 0、`pass 4 / fail 0`，其 AC6 六条子命令读数全 `exit=0`。
- [x] AC5 范围：`git diff --stat develop...HEAD` 只含 `server/tsconfig.json`（若实现者判定还必须动别的文件，按 Finding 的备选写明理由并只动那一处；不得动 `scripts/test.sh`、不得删任何正控制）。

## DoD

真实落地判据是**那个竞态不再能红**：AC1 在改前读到过 `TS6053`（原文登记），AC2 在同一时序下读到绿，AC3 证明判据的探测面没被一起拿掉。完成后，`voice-capture-off` 的 AC6 在 suite 里不应再因 `npm run typecheck` 非零而红——这可以在下一次 `gap-session-hosts-default-wrap-four-providers` 或 `gap-claude-resident-phase0-experiments` 的 fan-in 日志里读回来（同一行现在是点名格式 `AC6 FAIL … :: npm run typecheck (exit=…)`，有真因就必然看得见）。完成记录必须写明：本条**只修** `tsc` 看见瞬时文件这一条；`claude-sessions.test.ts` 那条 `open-a.jsonl was opened by a scan that should have skipped it` 是另一个机制（lane 负载受害者，独立跑 26/26 绿），不在本条范围。

## Touches

- server/tsconfig.json
- tasks/gap-tsc-sees-transient-probe-file.md

## Completion

**改动：** `server/tsconfig.json` 的 `exclude` 加 `"./modules/voice/tmp"`（+ 一段说明注释）。`git diff --stat develop...HEAD` = `server/tsconfig.json | 17 ++++++++++++++++-`，`1 file changed, 16 insertions(+), 1 deletion(-)`，name-only 恰为该一个文件。未动 `scripts/test.sh`，未删任何正控制。

### 复现脚本

改前/改后用的是**同一个**脚本，位于 worktree 的 git-ignored `.tmp/repro-ts6053.mjs`（不进 diff、不进 commits）：

```
node .tmp/repro-ts6053.mjs <worktree> --server-only <delay-ms...>   # 跑 npx tsc --noEmit -p server/tsconfig.json
node .tmp/repro-ts6053.mjs <worktree>             <delay-ms...>   # 跑 npm run typecheck（AC6 跑的那条整命令）
```

它按 `<delay-ms>` 造探针 → 起 typecheck → 到点 `rm -rf` 探针目录，逐轮打印 `probe(created=… deleted=…)`、`typecheck(start=… end=…)`、`exit`、`TS6053` 计数。

### AC1 —— 改前（未改的树，commit `cfd66cea` 之前）

三支 tsconfig 单独计时（`npm run typecheck` 内 server 那一支的偏移由此定出）：

```
tsconfig.json        exit=0 ms=8407
server/tsconfig.json exit=0 ms=3488
scripts/tsconfig.json exit=0 ms=1381
```

即 `npm run typecheck` 里 server 支活跃于 ~8.4s→~11.9s。

**A. `server/tsconfig.json` 那一支（--server-only），sweep 200…3000ms：**

```
delay= 400ms probe(created=0 deleted=400) typecheck(start=2 end=1581) exit=2 TS6053=1
   raw: error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-tsc-sees-transient-probe-file/server/modules/voice/tmp/__stray-shipping-probe.ts' not found.
delay= 500ms ... exit=2 TS6053=1   （同一行原文）
delay= 600ms ... exit=2 TS6053=1
delay= 700ms ... exit=2 TS6053=1
delay= 800ms ... exit=2 TS6053=1
delay= 900ms ... exit=2 TS6053=1
delay=1000ms ... exit=2 TS6053=1
delay=1100ms ... exit=2 TS6053=1
summary cmd="npx tsc --noEmit -p server/tsconfig.json" runs=18 \
  red=400,500,600,700,800,900,1000,1100 \
  green=200,300,1200,1400,1600,1800,2000,2300,2600,3000 ts6053-runs=400,500,600,700,800,900,1000,1100
```

**B. `npm run typecheck` 整条（AC6 原样），delay 落在 server 支上：**

```
delay=8400ms probe(created=0 deleted=8407) typecheck(start=3 end=9657) exit=2 TS6053=1
   raw: error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-tsc-sees-transient-probe-file/server/modules/voice/tmp/__stray-shipping-probe.ts' not found.
delay=8600ms probe(created=0 deleted=8610) typecheck(start=1 end=9424) exit=2 TS6053=1
summary cmd="npm run typecheck" runs=11 red=8400,8600 \
  green=8800,9000,9200,9400,9600,9800,10000,10400,10800 ts6053-runs=8400,8600
```

**顺带读到的旁证（红/绿可分辨）：** 红的那几轮，typecheck 在 ~1.5–1.7s（单支）/ ~9.4–9.7s（整条）就结束，绿的要 ~3.2–3.9s / ~11.5–12.9s —— `tsc` 报错即提前收工，所以「时长骤短」本身就是这条红的指纹。

### AC2 —— 改后同一时序（合并 develop 之后的树上）

同一脚本、同一 delay 集合、同一命令：

```
AC2a  npx tsc --noEmit -p server/tsconfig.json
delay=400 500 600 700 800 900 1000 1100ms → 全部 exit=0 TS6053=0（end 回到 3299–3858ms）
summary red=none green=400,500,600,700,800,900,1000,1100 ts6053-runs=none

AC2b  npm run typecheck
delay=8400 8600 8800 9000 9200 9400 9600 9800ms → 全部 exit=0 TS6053=0
summary red=none green=8400,8600,8800,9000,9200,9400,9600,9800 ts6053-runs=none
```

AC1 里红的 10 个时序（400–1100ms、8400/8600ms）在改后全部转绿，且时长回到 ~3.3s / ~12.5s（不再提前收工）。

**旁证（exclude 生效的直接读数）：** 探针**在盘上**时 `npx tsc --noEmit -p server/tsconfig.json --listFiles | grep -c "modules/voice/tmp"` = `0`，而 `grep -c "modules/voice/voice.service"` = `1` —— 目录被移出 program，模块本体还在。

### AC3 —— 正控制仍在（合并 develop 后）

`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-dashscope-settings.test.ts` → **exit 0**，`tests 32 / pass 32 / fail 0`，`elapsed-ms=9475`。

AC4(b) 正控制那一条读数原文：

```
ac8-positive-control ok=false server-branch-scan files=328 shipping-hits=1 [modules/voice/tmp/__stray-shipping-probe.ts] test-fixture-hits=5 [modules/database/tests/voice-settings.db.integration.test.ts modules/voice/tests/voice-dashscope-default-model.test.ts modules/voice/tests/voice-dashscope-settings.test.ts modules/voice/tests/voice-error-contract.test.ts modules/voice/tests/voice-provider-dispatch.test.ts] (equivalent: grep -rn "'dashscope-omni'" server/)
```

同一次运行的 churn 半边：`ac8-churn-summary repetitions=20 distinct-files-counts=1 files=327 all-ok=true`。

`files` 327（无探针）/ 328（有探针）：探针照旧被 `collectSourceFiles` 的递归 `readdir` 收进扫描、照旧让读数红、照旧被点名 —— exclude 只作用于 `tsc`，判据的探测面一点没少，正控制仍承重。

### AC4 —— 门与回归（合并 develop 后）

```
npm run typecheck   → exit 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json 三支全跑）
npm run lint        → exit 0（仅前端既有 warning，无 error）

npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts
                    → exit 0，tests 4 / pass 4 / fail 0，AC6 六条子命令：
AC6 exit=0 cases=4 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts
AC6 exit=0 cases=7 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voiceHealth.test.ts
AC6 exit=0 cases=6 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-config.routes.test.ts
AC6 exit=0 cases=8 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voiceTranscribeGaps.test.ts
AC6 exit=0 cases=n/a :: npm run typecheck
AC6 exit=0 cases=n/a :: npm run lint
```

同一轮的 leftovers 读数：`falsify/leftovers: git.status-clean=true unchanged=true own-temp-copies=none temp-copies-any=0 foreign-temp-copies=0 raw-unchanged=true added=0 removed=0`。

### AC5 —— 范围

```
$ git diff --stat develop...HEAD
 server/tsconfig.json | 17 ++++++++++++++++-
 1 file changed, 16 insertions(+), 1 deletion(-)

$ git diff --name-only develop...HEAD
server/tsconfig.json
```

### 本条不修的（照 DoD 要求写明）

1. **`claude-sessions.test.ts` 的 `open-a.jsonl was opened by a scan that should have skipped it` 不在本条范围。** 那是另一个机制（lane 负载受害者），独立跑 26/26 绿。本条只修「`tsc` 看见瞬时文件」这一条。
2. **同类的兄弟点位（已测量、本条未动）：** `server/tsconfig.json` 的 `include` 是 `./**/*.ts`，所以同一个 `collect-then-read` 窗口对**所有**写进 `server/` 树内的瞬时判据产物都成立，不止 `tmp/` 那一个。实测：
   - `server/modules/voice/__criterion-falsify-*.ts`（4 个 false-forms 文件写的 base/mut 副本，以及 `voice-dashscope-settings` AC4(b) churn 写的 `__criterion-falsify-ac8probe-*.ts`）**在 program 里**（`--listFiles | grep -c "__criterion-falsify"` = 1）；
   - 且它们**带着类型错误在盘上**时同样能把并发 typecheck 打红（实测：在 `server/modules/voice/` 放一个 `__criterion-falsify-typeerr.ts`（`const x: number = "not a number"`）→ `tsc --noEmit -p server/tsconfig.json` 报 `error TS2322`，`exit=2`）。
   - **为什么本条不动它们：** 这些副本必须与模块同目录（相对 import 要能解析，该目录里有真源码），无法按目录 exclude；按名字（`__criterion-falsify-*`）exclude 会把判据自己编译 mutant 的手臂也扫掉。该仓库已经有一份「正确解法」的先例：`voice-error-classification.false-forms.test.ts:96` 把自己的 scratch 放到**仓根 `tmp/`**（在 `server/tsconfig.json` 的 include 之外），并注明理由。真正的收敛方向是让那几个 false-forms 文件照做，或让 include 只列真正的源码根 —— 那是独立的一条。
   - **fleet 证据（为什么按 Finding 保持最小改动）：** `.quay/fan-in-*.log` 全部历史里 `error TS6053` 只有 **2 条，全部点名 `server/modules/voice/tmp/__stray-shipping-probe.ts`**，没有任何一条点名 `__criterion-falsify-*`。观测到的（也是唯一被记录过的）实例就是本条修掉的那一个，故按 Finding 只动这一处；兄弟点位在此登记，若将来真的红了，按上面两条改建。
