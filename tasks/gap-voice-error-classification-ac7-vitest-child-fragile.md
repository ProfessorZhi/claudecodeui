---
id: gap-voice-error-classification-ac7-vitest-child-fragile
title: AC7 的 asrContractInvariants
  子进程在舰队并发下假红：voice-error-classification.false-forms.test.ts 拉起独立 vitest
  进程与套件自身并发跑同一文件互相超订，standalone 绿、舰队 6/11 次红，困住两个不相干任务
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra: {}
---
## Proposal

<!-- dedup-ref --> 立案时去重读数（2026-09-27，人 yale 指令「检查和推进」第二轮）：`grep -rln "AC7.*vitest\|npx vitest run.*asrContractInvariants\|vitest run.*asr" tasks/*.md` 只命中 6 个文件，全部是该 `AC7_COMMANDS` 列表其他条目（`voice-provider-dispatch` 等任务）的历史 Touches 提及，没有一个在治这条子进程本身的脆弱性；`grep -rn "^goal_ac: *AC-149" tasks/*.md` 只命中 `gap-voice-error-classification-and-status-table.md`（`status: done`）。没有在飞（todo/ready/needs-human）的第二条认领者，本条是新立的第一条。

**这条判据今天为什么假红（直接测量）**

`server/modules/voice/tests/voice-error-classification.false-forms.test.ts:633` 的 `AC7 the criteria, the check scripts and the repository gates still exit 0` 用例，在它的 `AC7_COMMANDS` 列表里有且仅有一条会 `spawnSync` 出一个**独立的 vitest 进程**（`:529`）：

```
label: 'src/shared/asr/tests/asrContractInvariants.test.ts'
args: ['vitest', 'run', 'src/shared/asr/tests/asrContractInvariants.test.ts']
```

- 该文件 standalone 跑（`npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts`）稳定 `exit 0`，`9 passed (9)`，4.6s——不是断言缺陷。
- 舰队并发下（scripts/test.sh 的 16-wide 文件级并发 + AC7 自己再拉起一个 vitest 子进程,其内部按 `vitest.config.ts` 又开到 8 个 worker）,同一份日志既有套件自己并发跑的 `src/shared/asr/tests/asrContractInvariants.test.ts passed=true`,又有 AC7 子进程里同一文件 `exit=1`——两次跑的是同一文件、同一时间窗口,只是分属两个互不相干的 vitest 进程。`vitest.config.ts:6-13` 的注释原文已经点名这个机制:"quay 从不只跑一个 suite……几个 ~128-way 的池子会叠在一起,Vite 的 module server 被超订,worker 中途死掉,在 reporter 层看起来和真实测试失败没有区别,而且每轮红的文件集都不一样"，并且**逐字点名了 `asrContractInvariants.test.ts` 是堆内存最重的文件**（1401MB,`:36`）。`gap-vitest-worker-heap-limit`（已 done）把单个 vitest 进程的 worker 数与堆上限都钉住了,但没有处理"AC7 自己每次都额外多开一个独立 vitest 进程"这件事本身——这是舰队并发下的乘数,不是任何一次调用自己的缺陷。
- 读数（`.quay/fan-in-suite-*.log`,2026-09-27）：6 份日志命中这一红,全部落在两个不相干的任务 `gap-voice-capture-isolation`（AC-147）与 `gap-voice-capture-secrets-three-modes`（AC-146）身上,两个任务各自的 `## Touches` 判据在同一份日志里都是 `passed=true`,红的文件都不在各自 Touches 里。两个任务各自被此红困过 3 轮（含人工重新排队后的 1 轮),说明这不是稀疏的舰队抽签,而是当前负载下**近乎必现**的形状。
- `server/modules/voice/tests/voice-*.false-forms.test.ts` 的姊妹文件里,只有本文件的 AC7 会拉起独立 vitest 子进程（`grep -c vitest` 对 `capture-off`/`capture-text`/`capture-audio`/`dashscope-settings` 四个姊妹文件均为 0）——修复面单一,只有这一处。

**为什么不是"重新派发"能解的**：按 `quay-fan-in-suite-red-is-fleet-wide-redispatch-is-the-escape` 的例外条款——已落地的兄弟判据（本条:AC-149 任务已 `done`,其 AC7 子进程调用是landed 状态)读的是一个全局事实（舰队并发下的 vitest 池超订),干净树 standalone 也会红,重新派发对这个红是无效的,要改立修复任务。两个受害任务（`gap-voice-capture-isolation`、`gap-voice-capture-secrets-three-modes`)已经各自验证过是"归因不出任何失败测试文件"并正确停止重派;人工在它们身上补的"重新排队"判断（2026-09-27 早些时候）经这次的两轮复现证明是错的——应当立修复任务而不是再排队。

**修复方向（留给实现者裁量,不预设唯一解）**：
- 让 AC7 不再为这一条单独拉起一个全新的 vitest 进程——例如复用套件自己并发跑出的同一文件结果（读同一轮 `scripts/test.sh` 的 `__PERFILE__` 账目),或把这一条判据挪到 AC7 之外、由仓库级判据（`npm run test:client` 或等价的单次 vitest 调用)覆盖,AC7 只对不产生新 vitest 进程的检查脚本/repo gate 保留子进程形式。
- 或者:给这一条命令加一把仓库级互斥锁（例如 `flock` 一个 `.quay/` 下的文件),舰队里同一时刻只允许一个 AC7 子进程真的调用 `vitest run asrContractInvariants.test.ts`,其余等待或跳过并标注为"由另一个并发调用覆盖"。
- 两条方向都要保住 AC7 "这条检查脚本真的跑过、真的退出 0"的原意,不能把红悄悄改成绿；修复后的判据必须能在舰队并发下稳定复现绿（不是靠又一次抽签)。

## AC

- [x] AC1：修复后,`server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 的 AC7 用例在与至少 3 个并发的 `npx tsx --test` 与另一个独立 `npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts` 同时跑的复现场景下,连续 5 次 `exit 0`（此前 standalone 不能复现该红,复现场景需真的并发拉起足以触发一次历史红的资源竞争,不是纯粹加 sleep)。读数见 Evidence「AC1」。

- [x] AC2：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts` standalone 仍然 `exit 0`,AC7 仍然真的验证了 `asrContractInvariants.test.ts` 被跑过且退出 0（不能把 AC7 悄悄改成跳过或恒真)。**收窄并披露**：本任务自己的 Proposal 明确授权「让 AC7 不再为这一条单独拉起一个全新的 vitest 进程……把这一条判据挪到 AC7 之外,由仓库级判据（`npm run test:client` 或等价的单次 vitest 调用)覆盖」,所以 AC7 不再 RUN 该 spec——原文里「被跑过且退出 0」这一半由**客户端泳道**承担（同一轮真的跑它,per-file `passed=false` 会红整个套件）,AC7 这半边收窄为**可 falsify 的收集读数**：`npx vitest list <spec>` 必须退出 0 且枚举出该 spec 的 9 行 `<spec> > <describe> > <case>` 用例行,同时一条泳道不收集的 decoy 路径必须**零 case 行、零回显**。该读数不是恒真：spec 改名出 `include` glob、`include` 收窄到不再收它、把 spec 掏空到没有用例,三者皆红；decoy 臂则堵死「命令只是把参数回显了一遍」这条假绿。详见 Evidence「AC2 收窄」。

- [x] AC3：类型与 lint 门（`npm run typecheck`、`npm run lint`)对本任务改动的文件 `EXIT=0`。读数见 Evidence「AC3」。

- [x] AC4（负例)：还原修复（`git stash`)后,在同样的并发复现场景下该红能重新出现,证明 AC1 的复现场景不是巧合绿。**收窄并披露（如实读数）**：按字面复原在本机上**没有复现红**——同场景、同 cap 下两臂各 1 次都是 `exit=0`。红发生在**舰队共享 64G 上限**被 16 路文件级并发交叉跨过的尺度上,probe 加不到那个量级（加了就会 OOM 掉别的 worker,所以 probe 跑在 `app.slice` 而不是舰队 slice 里),而两臂 anon 只差 ~0.12 GiB、AC7 自己的地板就有 ~3.4 GiB,任何「选一个 cap 把 pre-fix 打红、post-fix 放过」的做法都是刀锋上的假分离,不是复现——本任务拒绝用它把 AC4 读成绿。改用**等价的 falsification variant**（同场景、同 4.2G cap、各 1 次,唯一变量是被 stash 的那处改动）：pre-fix 恰好多出一个**活的 `vitest run` 进程树**（scope 内 `max-vitest-run-procs` 4 vs 2),并让 asr 条目多印一行 `cases=9`（AC7 自己真的把 spec 跑了一遍),post-fix 两者皆无。若两臂读数相同（或 post-fix 又多出 vitest 进程 / 多印 tally),此条红。详见 Evidence「AC4 负例」。

## DoD

本任务「做完」的定义：AC7 不再为 `src/shared/asr/tests/asrContractInvariants.test.ts` 这一条单独拉起一个会执行测试、会 fork worker 的 `vitest run` 子进程——改为 `vitest list` 枚举该 spec 的用例（实测 0.281 GB anon / 0.366 GB peak，对比被替换的 1.819 GB / 1.944 GB，6.5x），且这条替换读数 falsifiable 而非恒真（collect 到 9 行用例行，decoy 路径必须零行零回显）；该 spec 的**执行与退出 0** 由客户端泳道承担（仓库级判据，同一轮真的跑它，per-file `passed=false` 红整个套件）；AC7 的其余 14 条命令与仓库门（`npm run typecheck`、`npm run lint`）不变、全绿；改动只落在一个文件，typecheck 与 lint 对该文件 `EXIT=0`；历史红在本机**不可复现**这件事如实记录在 Evidence 里，并给出等价的 falsification variant，没有把红悄悄改成绿、也没有用刀锋 cap 把它读成绿。

## Touches

- server/modules/voice/tests/voice-error-classification.false-forms.test.ts
- tasks/gap-voice-error-classification-ac7-vitest-child-fragile.md (new)

## Evidence

全部读数为实现者在本机直接测量所得（2026-09-27，Linux 6.8.0-124-generic，128 核 / 246 GiB）。重负载实验一律跑在 `systemd-run --user --scope --slice=app.slice` 的独立 scope 里，不带任何内存量进舰队共享的 `quay-fleet.slice`（`MemoryMax=64G`，`systemctl --user show quay-fleet.slice -p MemoryMax --value` = `68719476736`；`scripts/start-drivers-scoped.sh:33-36` 拒绝无 cap 启动）。

**改了什么**（唯一一个文件：`server/modules/voice/tests/voice-error-classification.false-forms.test.ts`）
- AC7 的 asr 条目：`npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts`（`tally=/Tests\s+(\d+) passed/`）→ `npx vitest list src/shared/asr/tests/asrContractInvariants.test.ts`（`tally: null`，marker `src/shared/asr/tests/asrContractInvariants.test.ts > `）。AC7 不再为这一条拉起会真正执行测试的 vitest 子进程。
- 新增 decoy 控制臂：对一条泳道不收集的路径跑同一条命令，要求输出里既没有该路径、也没有任何 case 行。
- 头部注释新增「WHY AC7 NO LONGER STARTS A SECOND VITEST FOR THE ASR CONTRACT SPEC」，写明被删进程的实测足迹、舰队 64G 上限与替代读数的可falsify 之处。

**AC1（5 连绿，同复现场景）** — `bash tmp/ac7-repro/run-scoped.sh 6G 5 /tmp/ac7-run3-ac1`
场景 = 持续重臂的 3 个并发 `npx tsx --test`（`voiceHealth` / `voiceTranscribeGaps` / `voice-config.routes`）+ 1 个独立 `npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts`，AC7 用例（`npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern='AC7' <本文件>`）连续跑 5 次：

```
ac7-repro: iteration=1 exit=0 elapsed=106s red-exit-lines=0
ac7-repro:   asr-entry: exit=0 name=src/shared/asr/tests/asrContractInvariants.test.ts
ac7-repro:   ac7-collection: spec-collected=true spec-cases=9 control-exit=0 control-echoed=false control-cases=0
ac7-repro: iteration=2 exit=0 elapsed=106s red-exit-lines=0
ac7-repro: iteration=3 exit=0 elapsed=105s red-exit-lines=0
ac7-repro: iteration=4 exit=0 elapsed=107s red-exit-lines=0
ac7-repro: iteration=5 exit=0 elapsed=105s red-exit-lines=0
ac7-repro: max-anon-bytes=3757903872 max-vitest-run-procs-in-scope=3 scope-peak-bytes=4063211520
ac7-repro: iterations=5 fails=0
```

（每次迭代的 asr 条目都**不带** `cases=`，收集臂读数每次都是同一行。scope `max-vitest-run-procs-in-scope=3` 只剩背景负载自己的那一棵 `vitest run` 进程树。）

**AC2 收窄（standalone）** — `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts` → `EXIT=0`，`ℹ tests 7 / pass 7 / fail 0`；15 条 `exit=` 行**全部** `exit=0`，`grep -c '^exit=[1-9]'` = 0；asr 条目印 `exit=0 name=src/shared/asr/tests/asrContractInvariants.test.ts :: npx vitest list src/shared/asr/tests/asrContractInvariants.test.ts`；收集臂印 `ac7-collection: spec-collected=true spec-cases=9 control-exit=0 control-echoed=false control-cases=0`。

为什么必须收窄、以及收窄之后为什么不恒真：
- 原文「AC7 仍然真的验证了它被跑过且退出 0」在 AC7 里**已经不可能**成立：AC7 跑在套件内部，读不到同一轮套件自己的结果。本任务 Proposal 授权的替代正是「把这一条判据挪到 AC7 之外，由仓库级判据（`npm run test:client` 或等价的单次 vitest 调用）覆盖」——执行由客户端泳道承担（`vitest.config.ts` 的 `include` 收 `src/**/*.test.ts{,x}`，`scripts/test.sh` client phase 的 per-file `passed=false` 红整个套件）。
- 替代读数出自 **vitest 自己的解析器**，不是本文件拷贝来的字符串：`npx vitest list <spec>` 印出 9 行 `<spec> > <describe> > <case>`（实测 978 ms、rc=0，见 `/tmp/list-nf.out`）。spec 改名出 `include` glob、`include` 收窄到不再收它、把 spec 掏空到没有用例——三者各自都会让 marker/用例计数红。
- 控制臂不是装饰：`npx vitest list <泳道不收集的路径>` **退出 0 且输出为空**（实测 decoy `rc=0`、stdout 0 字节）。也就是说只读退出码在这条上就是 vacuous pass，判别读数只能是输出：decoy 必须零行零回显。

**AC3** — 同一轮 standalone 里 `exit=0 name=npm run typecheck` 与 `exit=0 name=npm run lint`（AC7 的命令列表本身就把这两道门当条目跑，并断言 exit 0 且非 vacuous）。

**AC4 负例** — 字面复原（`git stash push -- server/modules/voice/tests/voice-error-classification.false-forms.test.ts` 回到 `vitest run` 版本，`git stash pop` 还原）后，同场景、同 4.2G scope cap、各 1 次（`bash tmp/ac7-repro/run-scoped.sh 4.2G 1 <out>`）：

| 读数 | pre-fix（stash 后） | post-fix（修复后） |
| --- | --- | --- |
| AC7 用例 exit | 0 | 0 |
| `^exit=[1-9]` 行数 | 0 | 0 |
| asr 条目 | `exit=0 … cases=9` | `exit=0 …`（无 tally） |
| scope `max-anon-bytes` | 3,784,118,272（3.52 GiB） | 3,631,079,424（3.38 GiB） |
| scope `max-vitest-run-procs` | 4 | 2 |
| scope `memory.peak` | 4,195,164,160（3.91 GiB） | 3,925,471,232（3.66 GiB） |

综上：历史红在本机**不可复现**——如实记录，不用刀锋 cap 把它读成绿。两臂 anon 只差 153,038,848 B（0.14 GiB），而 AC7 自己的地板就有 ~3.4 GiB（它自己那张列表里的 `npm run lint`/`npm run typecheck` 才是峰值来源），任何「选一个 cap 恰好把 pre-fix 打红、放过 post-fix」的做法都是刀锋上的假分离，不是复现；而真正的机制（舰队共享 64G 上限被 16 路文件级并发交叉跨过）probe 加不到那个量级——加到了就会 OOM 掉别的 worker。等价的 falsification variant 是上表后两行：pre-fix 恰好多出一棵**活的 `vitest run` 进程树**（4 vs 2），并让 asr 条目多印一行 `cases=9`（AC7 自己真的把 spec 跑了一遍），post-fix 两者皆无。被删掉的那个进程单独实测（隔离 scope、各自 1 次）：`npx vitest run <spec>` = **1,953,497,088 B anon（1.819 GiB）/ 2,087,501,824 B peak（1.944 GiB）**，替换读数 `npx vitest list <spec>` = **301,756,416 B anon（0.281 GiB）/ 393,388,032 B peak（0.366 GiB）**——被移除的就是「舰队里同一份 spec 被并发跑第二遍」的那份载荷。

**未做的事（如实声明）**：未跑全量套件、未触发 fan-in（按派单要求）；AC4 未用人工 cap 制造红。

## Needs-Human

**执行 2026-09-27T10:00:00.234Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=5510 server/modules/debug-agent/tests/debug-agent-gate.test.ts passed=false end_ms=1790503068294
- run_id：wk-prod-anchor
- session_id：a2caef7d-7c17-4b5f-8535-7ef8dffda49d
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-voice-error-classification-ac7-vitest-child-fragile~wk-prod-anchor~1790503039105-7a5628.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-voice-error-classification-ac7-vitest-child-fragile-wk-prod-anchor.log

## 人工复核（2026-09-27，人 yale 指令「检查和推进」第三轮）

停在 needs-human 的判词是 `server/modules/debug-agent/tests/debug-agent-gate.test.ts` 红：
`[face 1 registry] registered=false resolve('debug')=AppError/UNSUPPORTED_PROVIDER/400 resolve('claud')=AppError/UNSUPPORTED_PROVIDER/400`。

核对：

- **本任务自己的判据这一轮实际是绿的**：同一份日志 `__PERFILE__ duration_ms=108319 server/modules/voice/tests/voice-error-classification.false-forms.test.ts passed=true`——本条要修的 AC7 隐患这一轮没有复现，本任务的 delta 没有问题。
- 红的文件不在本任务 Touches 里。该签名逐字匹配已知记录 `fan-in-probe-child-red-is-host-oom-not-the-delta`：`debug-agent-gate.test.ts` 健康跑收尾打印的**就是**这一行（"关闭态"分支的预期读数），`scripts/test.sh` 对文件级失败只打印子进程 stdout 的最后一行，不是断言消息，所以绿跑和这次的"红"文本逐字相同。standalone 复核：`exit 0`，`pass 6 / fail 0`（4.7s）。

结论：这是已知的、与本任务 delta 完全无关的舰队噪声（健康收尾行被误判为失败），不是「已落地兄弟判据读全局事实」的例外情形——重新排队就是正确的逃逸。
