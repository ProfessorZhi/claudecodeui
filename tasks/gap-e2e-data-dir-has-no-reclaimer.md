---
id: gap-e2e-data-dir-has-no-reclaimer
title: e2e 运行目录没有回收者（24h 内 1794 个 / 103G）耗尽用户配额 ⇒ 判据在启动前以 EDQUOT(errno −122)
  死、读起来像 AC-153 为假；给数据目录加有界保留（TTL + 清扫）并重测判据为绿
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-153
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-28T13:05:56Z，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `a273da48b194202a9892fa9738da037f2e36b6bf`）：`grep -rn "^goal_ac: *AC-153" tasks/*.md` → 2 命中，两条都是 `done`（`gap-voice-error-notice-browser-e2e`、`gap-ac153-ledger-red-is-host-quota`），全量 228 条 `tasks/*.md` 里没有第三条，`for f in tasks/*.md` 扫 `todo|ready|needs-human` 也**没有任何在飞认领者**。按「更早的修复没守住 ⇒ 立新条」的默认读法立案。与它**同机制**的相邻任务只有 `gap-e2e-data-dir-lands-on-a-full-root-fs`（AC-122，done：给数据目录的**选择**加余量地板，`scripts/e2e-data-dir-selection.mjs`）；那条的模块注释白纸黑字把**回收**让了出去（见下），本条认领的正是它让出的那一格，不是它的重做。

### 一、本轮的直接测量：判据死在**启动前**，不是 AC-153 的行为退化

我在同一 checkout 上直跑判据本体（不是读台账尾巴），`date -u` = `Mon Sep 28 01:05:56 PM UTC 2026`，`git rev-parse HEAD` = `a273da48b194202a9892fa9738da037f2e36b6bf`：

```
$ npx playwright test e2e/voice-error-messages.spec.ts
Error: Unknown system error -122: Unknown system error -122, open
  '/data/scratch/yale/playwright-transform-cache-1004/99/991a22c72e_c6fd304_e2edatadirselection.map'
    at Object.writeFileSync (node:fs:2482:20)
    at addToCache (…/node_modules/playwright/lib/common/index.js:162:27)
    at loadUserConfig (…/index.js:1268:52)
    ... errno: -122, syscall: 'open'
EXIT=1
```

失败点是 Playwright **加载自己的配置文件时写 transform cache**，连 `playwright.config.ts` 都没加载完 —— **一个测试用例都没开始跑**。errno −122 是 Linux 的 `EDQUOT`（**用户配额耗尽**，不是容量）。这条红与 AC-153 的浏览器行为无关。

**立案动作本身也被它打死了**：随后 `task_write` 落库时返回 `Unknown system error -122: … open '/data/home/yale/work/claudecodeui/tasks/gap-e2e-data-dir-has-no-reclaimer.md.lock'` —— 连任务文件的锁都创建不出来。为了把这条任务立起来，本轮的立案者**先手工回收了最老的 400 个运行目录**（`find -maxdepth 1 -type d -name 'quay-e2e-*' -mmin +60 | sort -n | head -400 | xargs rm -rf`）：`ls | wc -l` `1791 → 1391`、`du -sh` `103G → 88G`，之后 `task_write` 才成功。这既是本条的现场证据，也说明**只靠人工 `rm` 不是解法**（下一节 AC 要把它接成运行路径上的一次有界清扫）。

**同一条判据上一次真的跑起来时是绿的，而且此后源码一个字节没动。** `f9c996a4..HEAD` 只改了 `tasks/gap-ac153-ledger-red-is-host-quota.md` 一个文件（`git diff --name-only f9c996a4..a273da48` 就这一行）：`gap-ac153-ledger-red-is-host-quota` 的完成记录里逐字抄着判据当天的全套读数（`legs=4 passed=4 criterion-wall-ms=24906`、`coded=4 chinese=4`、`visible-after-4s=true`、`text-unchanged=true`、`closed=true`、`cleared-on-next-recording=true`、`drafts-kept=4/4 notices-shown=4/4`、`collapsed-hides-code=true`、`expanded-shows-status=true`、`expanded-shows-upstream=true`、`concat-hits=0`、`equal=true both-equal-vocab=true`，`1 passed (24.8s)`）。**判据的绿色对象没变，变的是它能不能启动。**

台账侧同形。`.quay/gate-events.jsonl` 里 AC-153 的 `gate=goal` 读数共 **1795** 条，尾巴是 **10 连 `pass`**（`2026-09-27T22:52:37Z` → `2026-09-28T11:17:15Z`）之后接两条 `fail`：

```
2026-09-28T13:03:17.810Z  goal-sweep  fail  ENOENT .env + copyfile 'database/auth.db' -> '~/.cache/quay-e2e-tmp/…/auth.db'  (Unknown system error -122)
2026-09-28T13:04:52.286Z  goal-cli    fail  mkdtemp '~/.cache/quay-e2e-tmp/quay-e2e-XXXXXX'  (Unknown system error -122)
```

两条 `fail` 的失败点是 **`copyfile` / `mkdtemp`**，都发生在判据启动**之前**；加上我自己那条（`open` transform cache）与本轮立案那条（`open … .lock`），四条落在**四个不同的路径**上，errno 都是 −122 ⇒ 这是**用户配额**整体耗尽，不是某一个目录满了。

### 二、触发源：`~/.cache/quay-e2e-tmp` 没有回收者，24 小时堆了 103G

```
$ ls ~/.cache/quay-e2e-tmp | wc -l        → 1793   （本轮立案者回收 400 个之后 1391）
$ du -sh ~/.cache/quay-e2e-tmp            → 103G   （回收后 88G）
$ find ~/.cache/quay-e2e-tmp -maxdepth 1 -type d -mtime -1 | wc -l  → 1794
$ find ~/.cache/quay-e2e-tmp -maxdepth 1 -type d -mtime +1 | wc -l  → 0
$ df -h /data                             → /dev/vdb 4.0T 717G 3.3T 18%   (容量不紧张 ⇒ df 对 EDQUOT 无读数)
$ du -sh ~/.cache/* | sort -h | tail -2   → 4.5G ac122-tmp / 103G quay-e2e-tmp   (占 ~/.cache 108G 的 95%)
```

**全部 1794 个目录的 mtime 都在最近 24 小时内**：这是纯粹无人回收的累积速率（约 100G/天），不是历史遗留。上一轮立案时（2026-09-27T21:17Z）同一目录是 **572 个 / 25G** —— 16 小时翻了两番，与「每次 e2e 跑完都把 data dir 留在原地」一致。

**没有任何回收者，而且是设计上让出去的**：`scripts/e2e-data-dir-selection.mjs` 的模块注释逐字写着

> Recycling the directories an earlier run left behind is deliberately not this module's job (a run that cannot start is the condition worth failing on; **housekeeping is a separate concern**)

而那个「separate concern」**至今不存在**：在 `scripts/*.mjs`、`e2e/*.ts`、`package.json` 的 scripts 里 grep `reclaim|retention|TTL|maxAge|rmSync|rm -rf` 对 `quay-e2e-tmp` 的删除路径，一处都没有（命中的 `rmSync` 全是各脚本自己临时目录的自清理）。`scripts/e2e-data-dir-selection.test.mjs` 的 15 个用例也没有任何一条钉住「不回收」——**加回收不会与既有不变量冲突**。

### 三、为什么更早的修复没有守住

上一轮 `gap-ac153-ledger-red-is-host-quota`（`done`）是 **verification-only**：它把判据直跑读数与「宿主启动死 ≠ 判据假」的判法入档，并在 AC6 里明确写「该根因的修复属于**另一条任务**，本条只登记、不在这里夹带」。**那条「另一条任务」从来没有被立案**（`ls tasks/ | grep -i "reclaim\|retention\|reclaimer"` 为空）。于是触发源原封不动留在这里：16 小时后同样的签名复发，而且落到了**第四个**路径上（`/data/scratch/yale/playwright-transform-cache-*`，以及 `.lock`）。只登记不修根因，台账就会一直回到红 —— 本条要断的就是这个循环。

### 四、本条的交付面

给 e2e 数据目录一个有界保留（bounded retention）：**回收逻辑归属由模块注释让出的那个「separate concern」**，即一个**新模块** `scripts/e2e-data-dir-retention.mjs`（纯决策函数 + 薄清扫入口），**不改** `scripts/e2e-data-dir-selection.mjs` 的选择语义（它的注释「recycling is not this module's job」在新布局下仍然成立，因为它说的正是「不是本模块的事」，不是「没人该做」）。清扫在 **owner 路径**上挂一次（`playwright.config.ts` 里 `isDataDirOwner` 为真、即真正选目录的那次调用），并提供一个手动入口（`npm run e2e:reclaim`）供操作者与判据直接测量。

**形态约束（这几条是安全边界，不是风格）**：

- **TTL 有界且可覆盖**：只有 mtime 早于 TTL 的目录才可回收，默认 TTL **不小于 6 小时**（远长于任何一次运行），并像既有的 `QUAY_E2E_DATA_DIR_MIN_FREE_MB` 一样由环境变量覆盖 —— 是读数，不是埋在代码里的常量。
- **TTL 读不出来就不删**（fail-closed 落在「不删」一侧）：`0` / 非数 / 负值一律不回收，而不是退化成「删掉一切」。
- **前缀与排除集**：只回收父目录下匹配运行目录前缀（`quay-e2e-`）的项；**绝不**碰名字不匹配的项（别的工具的缓存就在同一父目录旁边），也**绝不**回收本次运行正在用的那一个（`QUAY_E2E_DATA_DIR` 指向的目录）。
- **best-effort、绝不致命**：清扫失败只记一行，不得让运行以非零退出（今天的红恰恰是「基础设施把判据打死」，不能换成另一个同形）。
- **不动邻居**：`~/.cache/ac122-tmp`、`/data/scratch/yale`、其他用户的目录一律不碰；只动选择器自己会创建的那一个父目录下的、超过 TTL 的运行目录。

### 五、非目标

- 不改 `scripts/e2e-data-dir-selection.mjs` 的选择语义与它的 15 个既有用例（余量地板、候选顺序、拒绝文本都不动）。
- 不改任何 e2e spec、不改应用实现、不改 `e2e/voice-error-messages.spec.ts`（本条只跑它）。
- 不改 `~/.cache/ac122-tmp` / `/data/scratch/yale` 的保留策略（各归各的任务）。
- 不把 TTL 做成「每次跑之前清空一切」：`QUAY_E2E_DATA_DIR` 显式指定的目录必须原样活着（`playwright.config.ts:57-61` 的 owner 语义），否则 worker 重评估时会把自己的数据清掉。
- 本轮立案者那次手工 `rm -rf`（400 个）**不是**本条的交付物，只是让任务文件写得进去的前置动作；本条要交付的是**运行路径上的有界清扫**，不是又一次手工删除。

## AC

- [x] AC1 回收决策是**纯函数**且被单测钉住：`node --test scripts/e2e-data-dir-retention.test.mjs` 退出 0，用例各自打印自己的名字，至少覆盖 `keeps-entry-younger-than-ttl`（比 TTL 新的目录**不**进回收集）、`selects-entry-older-than-ttl`（比 TTL 旧且前缀匹配 ⇒ 进回收集）、`never-selects-non-run-dir-name`（名字不匹配的运行旁目录**永不**进回收集）、`never-selects-the-excluded-current-dir`（排除集里的目录即使超龄也不进）、`invalid-ttl-selects-nothing`（TTL 为 `0`/非数/负数 ⇒ 回收集为空，fail-closed 落在不删一侧）、`missing-parent-is-empty-not-throwing`（父目录不存在 ⇒ 空集且不抛）。完成记录里逐字抄 runner 的汇总行与 `EXIT=0`，并逐条指出通过的名字。
- [x] AC2 清扫**真的**回收了，读数前后成对：在同一 checkout 上跑手动入口（`npm run e2e:reclaim`，退出 0），逐字给出跑动前后的 `ls ~/.cache/quay-e2e-tmp | wc -l` 与 `du -sh ~/.cache/quay-e2e-tmp` 与 `df -h /data`，以及入口自己报告的回收获数与被回收字节数；要求**回收后目录数不高于回收前的 10%**、并给出回收后的空余读数（`[e2e]` 行里的 `free-bytes=` 或 `df`）。同时给出 `date -u` 与 `git rev-parse HEAD`。
- [x] AC3 **判据直跑为绿**：回收之后 `npx playwright test e2e/voice-error-messages.spec.ts` 退出 0；把判据自己打印的读数行**逐字**抄进完成记录，必须至少包含 `legs=4 passed=4`、`coded=4`、`chinese=4`、`visible-after-4s=true`、`text-unchanged=true`、`closed=true`、`cleared-on-next-recording=true`、`drafts-kept=4/4`、`notices-shown=4/4`、`collapsed-hides-code=true`、`expanded-shows-status=true`、`expanded-shows-upstream=true`、`concat-hits=0`、`equal=true`、`both-equal-vocab=true`，以及 `[e2e] data-dir=… free-bytes=… min-free-bytes=…` 那一行与 `EXIT=0`；同时给出跑动时刻（`date -u`）与 `git rev-parse HEAD`。⛔ 不得用组件层 jsdom 的绿替代浏览器层的绿。
- [x] AC4 清扫的**副作用面**由夹具钉死（纯决策之外的那一半）：在一个临时父目录里造 `quay-e2e-OLD`（mtime 30 天前）、`quay-e2e-FRESH`（现在）、`notours`（mtime 30 天前，名字不匹配）三项，把 `quay-e2e-FRESH` 作为排除集，跑清扫后断言并打印：`old-run-dir-removed=true`、`fresh-dir-survives=true`、`non-run-dir-name-survives=true`、`excluded-dir-survives=true`；夹具父目录用后即删。
- [x] AC5 既有选择器零回归：`node --test scripts/e2e-data-dir-selection.test.mjs` 退出 0（15/15），且 `npx tsc --noEmit -p tsconfig.json` 退出 0（`playwright.config.ts` 在本条 Touches 内，必须仍能通过类型检查）。两条命令的退出码与汇总行逐字入档。
- [x] AC6 台账尾巴如实登记：landing 后读 `.quay/gate-events.jsonl` 里 AC-153 的 `gate=goal` 读数，打印总条数与尾巴 `verdict` 序列。若出现新的 `verdict=pass`，逐字抄它；若 driver 的独立复核尚未发生，**逐字写明「台账尾巴仍是 fail」**并附上 AC3 的直跑读数。⛔ 不得把它写成已通过，⛔ 不得拿 AC1/AC4 的单元绿替代浏览器层的绿。

## DoD

- 判据本体（真实浏览器 spec）在**回收过、配额已缓解**的宿主上被**真的跑过一次**，它自己打印的读数行逐字入档 —— 不是「台账里有 pass」，也不是复述 expect 的文字；并且同一次交付里给出「源码自上次为绿以来未变」的机械证据（`git diff --name-only <绿的那次 HEAD>..HEAD`）。
- 清扫被**真的跑过一次**：回收前后的目录数与字节数是同一 checkout 上的成对读数；且**一次清扫前刚创建的目录在清扫后仍然活着**（AC4 的夹具或宿主上的等价读数），证明这不是「把父目录清空」。
- 触发源是被**接线**断掉的，不是靠一次手工 `rm`：运行路径上（owner 路径）有清扫，因此累积不会静默恢复；TTL、排除集、失败不致命这三条安全边界由 AC1/AC4 的可执行读数钉住，而不是由散文保证。
- 交付物只动 Touches 列出的文件；`~/.cache/ac122-tmp`、`/data/scratch/yale`、其他用户的目录一个字节未动，`scripts/e2e-data-dir-selection.mjs` 的选择语义一个字节未改（AC5 的 15/15 即是机械证明）。

## Touches

- tasks/gap-e2e-data-dir-has-no-reclaimer.md
- scripts/e2e-data-dir-retention.mjs (new)
- scripts/e2e-data-dir-retention.test.mjs (new)
- playwright.config.ts
- package.json

## 完成记录

### 交付物

| 文件 | 动作 |
| --- | --- |
| `scripts/e2e-data-dir-retention.mjs` | 新增。纯决策（`selectReclaimableDirs` / `retentionTtlMsFromEnv` / `dirSizeBytes`）+ 清扫（`reclaimDataDirs`）+ 父目录推导（`defaultRetentionParents`）+ 薄 CLI（`runRetentionCli`）。 |
| `scripts/e2e-data-dir-retention.test.mjs` | 新增。14 例。 |
| `playwright.config.ts` | owner 路径上挂一次清扫（`isDataDirOwner` 为真时），排除本次运行的 `dataDir`。 |
| `package.json` | `"e2e:reclaim": "node scripts/e2e-data-dir-retention.mjs"`。 |

分支 `task/gap-e2e-data-dir-has-no-reclaimer`，fork 自 `a0064a48`，实现提交 **`18c69a1b1670ee6be8b9b3567ee6a304b9edb7e8`**。`scripts/e2e-data-dir-selection.mjs` **零改动**（见 AC5）。

安全边界的落点：TTL 默认 6 h（`QUAY_E2E_DATA_DIR_RETENTION_TTL_HOURS` 覆盖）、前缀 `quay-e2e-`、uid 归属、`exclude` 集合（绝对路径会被规约成 basename 再比较）、运行路径 2 s 预算。清扫**不抛**：读不出来的项计入 `errors=` 继续走。

### AC1 回收决策的纯函数读数（`node --test scripts/e2e-data-dir-retention.test.mjs`）

```
[e2e] retention-fixture: old-run-dir-removed=true fresh-dir-survives=true non-run-dir-name-survives=true excluded-dir-survives=true
✔ AC1 keeps-entry-younger-than-ttl (1.171403ms)
✔ AC1 selects-entry-older-than-ttl (0.140457ms)
✔ AC1 never-selects-non-run-dir-name (0.154186ms)
✔ AC1 never-selects-the-excluded-current-dir (0.171776ms)
✔ AC1 invalid-ttl-selects-nothing (0.144367ms)
✔ AC1 missing-parent-is-empty-not-throwing (0.867649ms)
✔ AC1 the TTL is a reading: six hours by default, and the environment can move it either way (0.219465ms)
✔ AC1 the prefix reclaimed by is the prefix the selector actually creates (0.627365ms)
✔ AC1 another user’s directory is never reclaimed, and one unreadable entry does not stop the sweep (1.126084ms)
✔ AC1 the run-path sweep is budget-bounded, and says so when it stops early (0.539447ms)
✔ AC1 a removal that fails is recorded and the sweep carries on — housekeeping never ends a run (0.353962ms)
✔ AC4 old-run-dir-removed, fresh-dir-survives, non-run-dir-name-survives, excluded-dir-survives (1.144773ms)
✔ AC2/AC4 the manual entry sweeps the parents it is given, reports them, and exits 0 (1.030536ms)
✔ AC2/AC5 the default parents are the selector’s candidates, existing ones only (0.42804ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 57.096164
EXIT=0
```

AC 点名的六条逐字在场：

- `keeps-entry-younger-than-ttl` → `✔ AC1 keeps-entry-younger-than-ttl`
- `selects-entry-older-than-ttl` → `✔ AC1 selects-entry-older-than-ttl`
- `never-selects-non-run-dir-name` → `✔ AC1 never-selects-non-run-dir-name`
- `never-selects-the-excluded-current-dir` → `✔ AC1 never-selects-the-excluded-current-dir`
- `invalid-ttl-selects-nothing` → `✔ AC1 invalid-ttl-selects-nothing`
- `missing-parent-is-empty-not-throwing` → `✔ AC1 missing-parent-is-empty-not-throwing`

多出来的 8 条把边界钉在**宿主上的真事**、而不是构造出来的假输入上：`the prefix reclaimed by is the prefix the selector actually creates` 不注入 `makeTempDir`，直接跑 `resolveE2eDataDir` 拿到真目录名再喂给前缀判定（前缀常量若与选择器漂移，这条红）；`another user’s directory is never reclaimed` 用真 uid 不匹配的条目；`the run-path sweep is budget-bounded` 注入从 `Date.now()` 起走的时钟，断言 `stoppedEarly=true` 且**回收集非空**（不是「没删东西所以停下了」）。

### AC2 清扫真的回收了 —— 同一 checkout 上的成对读数

判据要求 `npm run e2e:reclaim`，为把它从默认 6 h 拉到能触及**当时那份积压**，用了模块文档写明的覆盖（Proposal 要求「像既有的 `QUAY_E2E_DATA_DIR_MIN_FREE_MB` 一样由环境变量覆盖」）：

```
$ date -u
Mon Sep 28 01:14:18 PM UTC 2026
$ git rev-parse HEAD
a0064a4815a51d7a28818ff0dbb491889cb2f095
$ QUAY_E2E_DATA_DIR_RETENTION_TTL_HOURS=1 npm run e2e:reclaim

> @cloudcli-ai/cloudcli@1.37.3 e2e:reclaim
> node scripts/e2e-data-dir-retention.mjs

[e2e] retention: parent=/data/home/yale/.cache/quay-e2e-tmp ttl-ms=3600000 scanned=1397 reclaimable=1323 reclaimed=1323 bytes-reclaimed=77443382144 remaining=0 elapsed-ms=147166
[e2e] retention: parent=/tmp ttl-ms=3600000 scanned=22361 reclaimable=32 reclaimed=32 bytes-reclaimed=1397422064 remaining=0 elapsed-ms=1165 foreign-kept=3648
[e2e] retention: total parents=2 reclaimed=1355 bytes-reclaimed=78840804208
EXIT=0
```

**回收前**（同一 checkout，`date -u` = `Mon Sep 28 01:14:10 PM UTC 2026`）：

```
ls|wc -l = 1397
89G	/data/home/yale/.cache/quay-e2e-tmp
/dev/vdb        4.0T  718G  3.3T  18% /data
```

**回收后**（`date -u` = `Mon Sep 28 01:16:49 PM UTC 2026`）：

```
ls|wc -l = 78
4.8G	/data/home/yale/.cache/quay-e2e-tmp
/dev/vdb        4.0T  635G  3.4T  16% /data
--- /tmp quay-e2e-* remaining: 0
```

`78 / 1397 = 5.58% ≤ 10%` ✔。入口自报回收 **1355 个目录 / 78840804208 字节**（`/tmp` 那 32 个含在内）；`du` 侧 89G → 4.8G、`df` 可用 3.3T → 3.4T。回收后的空余读数另有一条独立来源，见 AC3 的 `free-bytes=3713973841920`。

**清扫不是「把父目录清空」**，两条读数：

1. 回收后的存活清单里逐字留着 `node-compile-cache` 与 `playwright-transform-cache-1004` —— 同一父目录下**名字不匹配**的两个租户，前缀边界在宿主上真的挡住了（`/tmp` 侧同形：`foreign-kept=3648` 是别的 uid 的目录）。
2. **清扫前刚创建的目录活着**：`quay-e2e-1oK7Vu` 既出现在 13:03:17 那条 `fail` 的 payload 里（`copyfile 'database/auth.db' -> '/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-1oK7Vu/auth.db'`），也出现在 13:14 清扫后的存活清单里 —— 它比 TTL 新，所以没被回收。这是 AC4 夹具在**宿主上的等价读数**。

### AC3 判据直跑为绿（真实浏览器，`npx playwright test e2e/voice-error-messages.spec.ts`）

在**已提交的** HEAD 上重跑（`git status --porcelain` 为空 ⇒ 提交的字节就是跑动的字节）：

```
$ date -u
Mon Sep 28 01:19:57 PM UTC 2026
$ git rev-parse HEAD
18c69a1b1670ee6be8b9b3567ee6a304b9edb7e8
$ npx playwright test e2e/voice-error-messages.spec.ts
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-LtbHIj free-bytes=3713973841920 min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)
[e2e] retention: parent=/data/home/yale/.cache/quay-e2e-tmp ttl-ms=21600000 scanned=83 reclaimable=0 reclaimed=0 bytes-reclaimed=n/a remaining=0 elapsed-ms=1
[e2e] assembly-scratch=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-LtbHIj/tmp prepared=now elapsed-ms=0 available-bytes=3713973841920
[e2e] server=8859 client=9075
audio-file=… exists=true workspace=… session-anchor=voice-error-messages own-rows=1
dataDir-owner=true
declared-fields=[dashscopeEndpoint,dashscopeApiKey,dashscopeModel] rendered-fields=[dashscopeEndpoint,dashscopeApiKey,dashscopeModel]
leg=account-403 status=403 code=ACCOUNT_ACCESS page-said="该账户无法使用这个语音服务——请确认订阅与模型权限已生效，然后重试。" expected="该账户无法使用这个语音服务——请确认订阅与模型权限已生效，然后重试。" equals=true is-chinese=true
leg=account-403 draft-before="keep this failure-message draft character for character 1 account-403" notice-shown=true draft-after="keep this failure-message draft character for character 1 account-403" drafts-kept=1/1
leg=model-404 status=404 code=MODEL_NOT_FOUND page-said="该账户用不了这个转写模型——请在语音提供方设置里换一个模型。" expected="该账户用不了这个转写模型——请在语音提供方设置里换一个模型。" equals=true is-chinese=true
leg=model-404 draft-before="keep this failure-message draft character for character 2 model-404" notice-shown=true draft-after="keep this failure-message draft character for character 2 model-404" drafts-kept=2/2
leg=empty-200 status=200 code=local-empty page-said="录音里没有检测到人声——请靠近麦克风重新录制。" expected="录音里没有检测到人声——请靠近麦克风重新录制。" equals=true is-chinese=true
leg=empty-200 draft-before="keep this failure-message draft character for character 3 empty-200" notice-shown=true draft-after="keep this failure-message draft character for character 3 empty-200" drafts-kept=3/3
leg=server-422 status=422 code=NO_SPEECH_DETECTED page-said="录音里没有检测到人声——请靠近麦克风重新录制。" expected="录音里没有检测到人声——请靠近麦克风重新录制。" equals=true is-chinese=true
leg=server-422 draft-before="keep this failure-message draft character for character 4 server-422" notice-shown=true draft-after="keep this failure-message draft character for character 4 server-422" drafts-kept=4/4
legs=4 coded=4 distinct=3 chinese=4
empty-200="录音里没有检测到人声——请靠近麦克风重新录制。" server-422="录音里没有检测到人声——请靠近麦克风重新录制。" equal=true both-equal-vocab=true
visible-first=true visible-after-4s=true text-unchanged=true closed=true cleared-on-next-recording=true
drafts-kept=4/4 notices-shown=4/4
collapsed-hides-code=true collapsed-hides-upstream=true expanded-shows-status=true expanded-shows-upstream=true status-read=403 upstream-read=AccessDenied.Unpurchased concat-hits=0
legs=4 passed=4 criterion-wall-ms=24978 watchdog-line=false
  ✓  1 e2e/voice-error-messages.spec.ts:719:1 › AC-153 four upstream conditions each show their own Chinese sentence, and the notice behaves (15.2s)

  1 passed (25.0s)
EXIT=0
```

AC 点名的 token 全部逐字在场：`legs=4 passed=4`、`coded=4`、`chinese=4`、`visible-after-4s=true`、`text-unchanged=true`、`closed=true`、`cleared-on-next-recording=true`、`drafts-kept=4/4`、`notices-shown=4/4`、`collapsed-hides-code=true`、`expanded-shows-status=true`、`expanded-shows-upstream=true`、`concat-hits=0`、`equal=true`、`both-equal-vocab=true`、`[e2e] data-dir=… free-bytes=… min-free-bytes=…`、`EXIT=0`。

这是浏览器层（`playwright test`，真 server + 真 Chromium），不是 jsdom：同一行里的 `[e2e] server=8859 client=9075` 与 `dataDir-owner=true` 就是这次运行自己的启动读数。同一条判据在 13:16:53（HEAD `a0064a48`，即本提交前的字节，由 `git status` 未变证明）也跑过一次，同样 `EXIT=0`、`1 passed (25.1s)`、`criterion-wall-ms=25123`、`legs=4 passed=4`。

⛔ 未使用的替代物：本条**没有**拿组件层 jsdom 的绿替代浏览器层 —— 现场没有跑任何 vitest 并把它的绿写进 AC3。

### AC4 副作用面夹具

夹具那一例在 AC1 的同一次运行里打印（逐字见上）：

```
[e2e] retention-fixture: old-run-dir-removed=true fresh-dir-survives=true non-run-dir-name-survives=true excluded-dir-survives=true
```

四个布尔都是 `true`，且是**断言**出来的、不是打印硬编码字符串：夹具在临时父目录里造 `quay-e2e-OLD`（mtime 30 天前）、`quay-e2e-FRESH`（现在）、`notours`（mtime 30 天前），以 `quay-e2e-FRESH` 为排除集跑 `reclaimDataDirs`，然后对文件系统断言；夹具父目录跑完即删。另有一例把**排除集是承重的**钉住：同一个超龄目录，加进 `exclude` 后必须活着、不加时必须被删 —— 否则「排除集生效」与「那个目录本来就不该被删」分不开。

### AC5 既有选择器零回归

```
$ node --test scripts/e2e-data-dir-selection.test.mjs
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 103.43528
EXIT=0

$ npx tsc --noEmit -p tsconfig.json
EXIT=0
```

`scripts/e2e-data-dir-selection.mjs` 一个字节未改：`git diff --name-only a273da48..18c69a1b` 里没有它（见下）。另外两环 typecheck 也顺带跑了，因为 `npm run typecheck` 是三环，fan-in 会三环一起读：`npx tsc --noEmit -p server/tsconfig.json` → `EXIT=0`，`npx tsc --noEmit -p scripts/tsconfig.json` → `EXIT=0`（新 `.mjs` 在 `scripts/tsconfig.json` 的 `checkJs`/`strict` 下也要过）。

### AC6 台账尾巴（如实登记）

`date -u` = `Mon Sep 28 01:19:44 PM UTC 2026`，`.quay/gate-events.jsonl`（22027371 字节）：

```
=== AC-153 gate=goal: total ===
1796
=== verdict tallies ===
   1759 fail
     37 pass
=== TAIL 12 ===
2026-09-27T23:00:15.097Z  pass  actor=goal-cli
2026-09-27T23:05:00.322Z  pass  actor=goal-sweep
2026-09-28T00:49:03.595Z  pass  actor=goal-sweep
2026-09-28T02:32:14.707Z  pass  actor=goal-sweep
2026-09-28T04:17:29.364Z  pass  actor=goal-sweep
2026-09-28T06:02:33.277Z  pass  actor=goal-sweep
2026-09-28T07:45:40.151Z  pass  actor=goal-sweep
2026-09-28T09:30:43.201Z  pass  actor=goal-sweep
2026-09-28T11:17:15.938Z  pass  actor=goal-sweep
2026-09-28T13:03:17.810Z  fail  actor=goal-sweep
2026-09-28T13:04:52.286Z  fail  actor=goal-cli
2026-09-28T13:17:17.941Z  pass  actor=goal-cli
```

**出现了新的 `verdict=pass`**，逐字抄它（台账里最后一条的完整记录）：

```json
{
  "id": "c9105e44-8ce9-45fc-bb35-f30ba14af836",
  "item_id": "AC-153",
  "pipeline_id": "AC-153",
  "gate": "goal",
  "actor": "goal-cli",
  "verdict": "pass",
  "timestamp": "2026-09-28T13:17:17.941Z",
  "payload": {
    "reason": "acceptance passed (exit 0)"
  }
}
```

它与 AC3 的直跑（13:16:53 → 13:17:18）**是两次不同的运行**：这条是 goal gate 自己在配额缓解后的宿主上重跑判据并拿到 `exit 0`，不是我的那次。两条 `fail` 的 payload 也逐字登记，因为它们是本条的现场证据而不是被推翻的读数：

```json
{"actor":"goal-sweep","verdict":"fail","timestamp":"2026-09-28T13:03:17.810Z","payload":{"reason":"acceptance failed (exit 1) — [WebServer] No .env file found or error reading it: ENOENT: no such file or directory, open '/data/home/yale/work/claudecodeui/.env' [WebServer] Could not migrate legacy database { [WebServer] error: \"Unknown system error -122: Unknown system error -122, copyfile '/data/home/yale/work/claudecodeui/database/auth.db' -> '/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-1oK7Vu/auth.db'\" } …","criterionHash":"5adc64011c3621fd"}}
{"actor":"goal-cli","verdict":"fail","timestamp":"2026-09-28T13:04:52.286Z","payload":{"reason":"acceptance failed (exit 1) — Error: Unknown system error -122: Unknown system error -122, mkdtemp '/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-XXXXXX' at mkdtempSync (node:fs:3134:18) at makeTempDir (file:///data/home/yale/work/claudecodeui/scripts/e2e-data-dir-selection.mjs:268:59) at resolveE2eDataDir (…:294:19) at file:///data/home/yale/work/claudecodeui/playwright.config.ts: …"}}
```

两条 `fail` 的失败点（`copyfile` / `mkdtemp`）都在判据启动之前，errno −122 与立案时的 `open` transform cache、`open … .lock` 一起构成四个不同路径上的同一签名 —— 与本条「触发源是用户配额、不是判据假」的判法一致。

⛔ 本条**没有**把台账尾巴写成「已通过」而略过 fail，也**没有**拿 AC1/AC4 的单元绿替代浏览器层的绿：AC6 的 `pass` 是 goal gate 的独立读数，浏览器层的绿由 AC3 自己承担。

### DoD 自证

**（a）判据本体在配额缓解后真的跑过一次，读数逐字入档** —— 见 AC3，两条独立运行（我的直跑两次 + goal gate 一次），都是浏览器层 `playwright test`，`EXIT=0`。

**（b）源码自上次为绿以来未变的机械证据**：

```
$ git diff --name-only f9c996a4..a273da48          # 上一次为绿那次自己的 delta
tasks/gap-ac153-ledger-red-is-host-quota.md

$ git diff --name-only a273da48..18c69a1b          # 本条的 delta
package.json
playwright.config.ts
scripts/e2e-data-dir-retention.mjs
scripts/e2e-data-dir-retention.test.mjs
tasks/gap-e2e-data-dir-has-no-reclaimer.md

$ git diff --name-only a273da48..18c69a1b -- e2e src server shared
（空）

$ git show a273da48:e2e/voice-error-messages.spec.ts | sha256sum
c44bf412a8d0bf3415a202c83a7903353d95430f9b96ba599a3da8764bf4bd9d  -
$ sha256sum e2e/voice-error-messages.spec.ts
c44bf412a8d0bf3415a202c83a7903353d95430f9b96ba599a3da8764bf4bd9d  e2e/voice-error-messages.spec.ts
```

判据文件与 `e2e/ src/ server/ shared/` 在「上次为绿 → 本条 HEAD」这一段里**一个字节没动**（第三行的空集 + 第四、五行两侧 sha256 相同）。变的只有本条的四个交付文件加任务文件；而「上一次为绿」自己那一段（`f9c996a4..a273da48`）也只有一个 task 文件。

**（c）清扫真的跑过、且不是清空父目录** —— 见 AC2 的成对读数与两条存活证据（`node-compile-cache`/`playwright-transform-cache-1004` 两个非运行租户，以及清扫前刚创建、清扫后仍在的 `quay-e2e-1oK7Vu`）。

**（d）触发源是被接线断掉的**：`playwright.config.ts` 的 owner 分支每次真正选目录时都调 `reclaimDataDirs`，所以即使没有手动入口，池子也不会再不受限地长。宿主上的后验读数与之一致：13:14 清空到 78 之后，13:19 时同一父目录是 80 项 / 4.9G，且**最老的一个只有 63 分钟**（`count=78 min=1min median=35min max=63min`）—— 池子从「24 小时积压 103G」变成了「TTL 窗口内的稳态」。默认 6 h TTL 下同一次 dry run 是 `reclaimed=0`（没有任何一项够老），这正是「稳态」与「积压」的读数差别。

**（e）交付物只动 Touches 列出的文件**：`git diff --name-only a273da48..18c69a1b` 的五个文件名与 `## Touches` 逐条对上（任务文件本身经 Provider ABI 写入）。`~/.cache/ac122-tmp`、`/data/scratch/yale` 未被本条的代码路径触及 —— 候选父目录只来自 `dataDirCandidates()`（`TMPDIR` / `~/.cache/quay-e2e-tmp` / `os.tmpdir()`），两条都不在其中；清扫报告里 `/tmp` 那行的 `foreign-kept=3648` 是别的 uid 的目录被原样留下的读数。

### 已知残留（如实登记，不夹带修复）

1. **运行路径上的清扫不报字节数**（AC3 行里的 `bytes-reclaimed=n/a`）。这是刻意的：config evaluation 里再走一遍 `dirSizeBytes` 会把一次全量 walk 加进启动时间，而启动时间正是这条判据在量的东西。字节数由手动入口（`npm run e2e:reclaim`）承担，AC2 用的就是它。
2. **默认 6 h TTL 不会把稳态池子降到 10%**，它把池子**界定**在「TTL × 运行速率」而不是「无限增长」。AC2 的 10% 是在**积压**（1397 个，24 小时无人回收的产物）上达成的（5.58%）；修复之后同一读数不应再出现积压形态 —— 这是本条要达到的状态，不是没达到的指标。
3. **运行路径的 2 s 预算意味着积压要靠多次运行排空**。实测一次删除 3371 文件 / 63 M 用 89 ms ⇒ 约 38k 文件/秒；2 s 约合每次运行回收 ~20 个目录，而一次运行只产生 1 个。所以排空是收敛的，但**不是**瞬时的。手动入口不设预算（AC2 的 1323 个目录用了 147166 ms）。
4. **清扫在 `playwright.config.ts` 求值时同步执行**，因此首次遇到大积压的运行会慢最多 2 s。它排在 `resolveE2eDataDir()` 之后、任何 server 启动之前，不吃判据自己的 watchdog 预算。
5. 本条的清扫**不递归进子目录再判断**：只对父目录下一层的 `quay-e2e-*` 做 `rmSync(recursive)`，符合选择器 `mkdtemp(join(parent, 'quay-e2e-'))` 的形态。
## Needs-Human

**执行 2026-09-28T13:36:11.152Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=18343 server/modules/providers/tests/model-gateway-end-to-end.test.ts passed=false end_ms=1790602432061
- run_id：wk-prod-anchor
- session_id：2d09df9e-ac0e-42dc-bd7d-894c6b3f0763
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-e2e-data-dir-has-no-reclaimer~wk-prod-anchor~1790602375970-6667e9.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-e2e-data-dir-has-no-reclaimer-wk-prod-anchor.log


2026-09-29: suite red was model-gateway-end-to-end fleet flake (5/5 x3 standalone green); branch merged into author as bf1d1920; reclaimer swept 1058->461 dirs (rest <6h TTL).