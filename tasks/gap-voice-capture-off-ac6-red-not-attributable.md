---
id: gap-voice-capture-off-ac6-red-not-attributable
title: voice-capture-off 的 AC6 红在日志里不点名：断言文案是静态字符串、逐条读数只进 stdout、runner 的
  per-file 输出随 TMP 删除 ⇒ suite 连续两轮只留下「a surface this task must not have moved is
  red」；独立跑与 15 路加压下六条子命令全 exit 0
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

**现场（连续两轮，同一文件同一行）。** 两份 fan-in suite 日志里唯一的红都落在 `server/modules/voice/tests/voice-capture-off.false-forms.test.ts`：

- `.quay/fan-in-suite-gap-session-hosts-default-wrap-four-providers~wk-prod-anchor~1790384251159-3c90df.log`（`# tests 238 / # pass 237 / # fail 1`）
- `.quay/fan-in-suite-gap-claude-resident-phase0-experiments~wk-prod-anchor~1790383818461-934706.log`

逐字：`not ok - server/modules/voice/tests/voice-capture-off.false-forms.test.ts: AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red`

这次引用行**就是**真正的失败断言（不是 `first_error()` 误引一条通过读数），但它**不说是哪一个面红的**。

**被它挡住的不是它自己。** 两轮里被挡下的两个任务（`gap-session-hosts-default-wrap-four-providers`、`gap-claude-resident-phase0-experiments`）在该轮 suite 里的 `## Touches` 文件全部 `passed=true`：

- `server/modules/session-hosts/tests/session-host-default-wrap.test.ts` → `passed=true`（6531ms）
- `server/modules/providers/tests/provider-runtime.service.test.ts` → `passed=true`（1081ms）

两个任务的 `## Touches` 与该文件**没有交集**。AC-154 那条已连续五轮因「suite 红归因不出」停靠，phase0 那条四轮。

**本地不可复现（如实登记）。** 该文件单独跑：`tests 4 / pass 4 / fail 0`、exit 0、`duration_ms 23980`；同一轮里 AC6 的六条子命令读数**全是 0**：

```
AC6 exit=0 cases=4 :: npx tsx … --test server/modules/voice/tests/voice.service.test.ts
AC6 exit=0 cases=7 :: npx tsx … --test server/modules/voice/tests/voiceHealth.test.ts
AC6 exit=0 cases=6 :: npx tsx … --test server/modules/voice/tests/voice-config.routes.test.ts
AC6 exit=0 cases=8 :: npx tsx … --test server/modules/voice/tests/voiceTranscribeGaps.test.ts
AC6 exit=0 cases=n/a :: npm run typecheck
AC6 exit=0 cases=n/a :: npm run lint
```

按 lane 形状加压（同时起 15 份兄弟 server 测试文件，再跑该文件）**仍未复现**：目标 exit 0、4/4、上面六行依旧全 0。所以「哪一条子命令在真 suite 里非零」目前**没有读数**。

**为什么它注定读不出来（代码 + runner 两处各一半）。**

1. 该文件 `:323` 的 AC6 是**元判据**：它用 `execFileSync` 顺序跑四条既有判据 + `npm run typecheck` + `npm run lint`，然后把结果断言成两个集合为空。两条断言的文案都是**静态字符串**（`:343` `'a surface this task must not have moved is red'`、`:349`「a criterion that exits 0 having run no cases is a vacuous pass…」），集合里的元素（`outcome.command`）**没有进消息**。逐条读数只 `process.stdout.write` 到 stdout。
2. `scripts/test.sh` 把每个文件的输出写进 `$TMP="$(mktemp -d)"`，`first_error()` 只截 **300 字符**一行拼进 TAP，而退出时的 `suite_cleanup()` 做 `rm -rf "$TMP"` —— 那条 stdout 读数**随 TMP 一起消失**，事后无从取证。

即：这个元判据把「四条兄弟判据 + 两条全仓门」的结论压缩成一个不带参数的布尔，再用一个删掉证据的 runner 承载它。红了之后能做的只有「再跑一遍，希望这次绿」。

**修法（只动这一个文件，把红变成可归因）。**

1. 断言消息**点名**失败的命令与退出码，例如把 `outcomes.filter(exitCode !== 0)` 映射成 `` `${command} (exit=${exitCode})` `` 再进消息；空集合时的消息与现在等价（仍然红），非空时逐条给出。
2. 把每条子命令输出的**尾部**（有界：如最后 20 行 / 2KB，明确标注截断）带进消息 —— 这样 300 字符的 TAP 里至少留下子命令自己的失败签名。
3. 给每条子命令一个**有界 timeoutMs**，超时按具名失败报（消息含命令 + `timed out after …ms`），而不是让它在 lane 里静静挂着。`execFileSync` 支持 `timeout`；超时会以 `status`/`signal` 反映，按现有 catch 形态接住并登记。
4. 两条断言的含义**一个字不动**（exit 码集合为空、cases 非零）——本任务只增加可归因性，不放松判据。

⛔ 不在本任务里改 `scripts/test.sh`（保留 per-file 输出是另一个机制，见 AC5）。

<!-- dedup-ref -->
**边界。** 这不是 `gap-voice-false-forms-siblings-pid-attribution`（`d5f7904b`，已 done）修的 `__criterion-falsify-*` 共写目录串扰：该文件在本轮 suite 里是**唯一**红的文件，且它的 `git.status-clean`/`temp-copies` 读数没有出现在失败文案里。修 voice 那条时已经给它加过 pid 归因。本条接手的是**另一件事**：它的 AC6 元断言不可归因。相关任务的 id 只作溯源，不构成本任务的前提。

## AC

- [x] AC1 断言消息点名失败者：把 `EXISTING_CRITERIA[0]` 临时指向一个不存在的文件（或在 `runCommand` 的返回值上注入一次非零），跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts`，必须退出非 0，且失败文案**逐字含那条命令与其退出码**。注入前后的原文照抄进完成记录，之后还原并给出还原后的 md5。
- [x] AC2 子命令输出随 TAP 进日志：同一注入下，失败文案里含该子命令 stdout/stderr 的**尾部**（有界长度，且文案里标明是尾部与截断长度）。证明方式：把该次运行的 `not ok` 行按 `scripts/test.sh` 的 `first_error()` 规则（`grep -m1 -E 'Error|error|not ok|✗|FAIL|failed' | head -c 300`）取一遍，指出子命令的失败签名确实落在前 300 字符内（或说明为何必须在 300 字符内）。
- [x] AC3 有界，且超时也具名：每条子命令带 `timeoutMs`；用一个必然超预算的假子命令（例如把某条命令临时换成 `sleep` 超过预算的等价物）证伪一次——必须退出非 0，文案含命令与 `timed out`。读数与还原一并登记。
- [x] AC4 判据未被放松：`git diff develop -- server/modules/voice/tests/voice-capture-off.false-forms.test.ts | grep -c '^-.*assert'` 为 0；两条断言的两个集合条件（`exitCode !== 0`、`cases === 0`）在 diff 里仍是原样；该文件独立连跑 3 次全 `exit 0 / tests 4 / pass 4 / fail 0`；`npm run typecheck`、`npm run lint` 退出 0。
- [x] AC5 范围纪律：改动只落在 `server/modules/voice/tests/voice-capture-off.false-forms.test.ts`。若证明必须改 `scripts/test.sh`（例如保留失败文件的输出）才能让原因进日志，**停止**，把证据写进完成记录并按机制另立 gap 任务；不得在本任务里改 runner。

## DoD

真实落地判据是**可观测的一次**：本任务落地后，该文件若再次在 suite 里红，`.quay/fan-in-suite-*.log` 的那行 `not ok` 必须**点名是哪条子命令、退出码是多少、它的失败签名是什么** —— 而不是像现在这样只有一句 `a surface this task must not have moved is red`。完成记录必须写：AC1/AC2/AC3 三次注入的原文读数与还原后的 md5、AC4 的 3 连绿与两条门读数，以及一条诚实边界——**本任务没有复现 driver 那两次红**（单独跑绿、15 路 lane 形状加压也绿、六条子命令全 exit 0），所以它交付的是「下次红能读出来」，不是「红已经被消除」；真正的子命令失败若要修，得等这条归因落地后另立任务。

## Touches

- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- tasks/gap-voice-capture-off-ac6-red-not-attributable.md

## 完成记录

落地：`1fe9714d`（分支 `task/gap-voice-capture-off-ac6-red-not-attributable`）。改动只有 `server/modules/voice/tests/voice-capture-off.false-forms.test.ts`（AC5）。冻结后的文件 md5 = `827f0a274c3a115325848a9065a8f07c`；下列每一条读数都是在**这组字节**上跑出来的（早期一次读数在补 `describeRed` 的悬空分隔符之前，已作废，未登记）。

**AC1 断言消息点名失败者。** 改前 develop 上的原文（即 driver 两轮日志里那一行，除断言消息外什么都没有）：

```
not ok - server/modules/voice/tests/voice-capture-off.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
```

注入：把 `EXISTING_CRITERIA[0]` 临时指向 `server/modules/voice/tests/__ac1-injected-missing.ts`（注入后整文件 md5 = `8645eb50b23326812ef884edfeee9159`），跑 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts`。注入后原文：

```
AC6 FAIL cases=n/a :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/__ac1-injected-missing.ts (exit=1) | sig: Could not find 'server/modules/voice/tests/__ac1-injected-missing.ts' | tail: last 1 of 1 lines, 69B of 70B kept: Could not find 'server/modules/voice/tests/__ac1-injected-missing.ts'
```

读数：文件退出码 **1**；`ℹ tests 4 / pass 3 / fail 1`。失败文案逐字含那条命令（`npx tsx … --test server/modules/voice/tests/__ac1-injected-missing.ts`）与其退出码（`(exit=1)`）。测试体里流式写出的那一行先于 reporter 的 `✖` 落到 stdout，所以 `first_error()` 的 `grep -m1` 取到的就是它，driver 的 suite 日志里从此显示的是归因行而不是那句无名的 `a surface … is red`。还原后 md5 = `827f0a274c3a115325848a9065a8f07c`（= 注入前同值，无残留）。

**AC2 子命令输出随 TAP 进日志。** 同一次注入的文案里，`tail:` 就是该子命令 stdout/stderr 的尾部，且自带截断读数：`tail: last 1 of 1 lines, 69B of 70B kept: Could not find '…'` —— 「last N of M lines」「XB of YB kept」是标签，`tailOf()` 取末 `TAIL_LINES=20` 行、再按末 `TAIL_CHARS=2048` 字节截断，所以有界。按 `scripts/test.sh` 的 `first_error()` 规则（`grep -m1 -E 'Error|error|not ok|✗|FAIL|failed' | head -c 300`）复取一遍：**命令、`(exit=1)`、完整的 `sig:` 行、以及 tail 标签全部落在前 300 字节内**，300 字节的切割点落在 tail 正文的 `…tests/__ac1` 处（tail 正文被截，标签与签名未被截）—— 这正是「签名先于尾部」这条排版顺序要保证的。`FAIL` 这个 token 是给 `first_error()` 抓的锚；签名正则另含 `✖|✗|✘` 的超集，因为 spec reporter 打的是 `✖`（U+2716），而 `first_error()` 的 `✗`（U+2717）抓不到它。

**AC3 有界，且超时也具名。** 注入：第一条子命令临时换成 `runCommand('sleep', ['300'], false)`，同时 `runCommand` 的 `execFileSync` 选项加了 `timeout: COMMAND_TIMEOUT_MS`（240000ms）。读数：wall = **268s**，文件退出码 **1**，`first_error()` 取到：

```
AC6 FAIL cases=n/a :: sleep 300 (exit=1, timed out after 240000ms (killed by SIGTERM)) | it printed nothing at all
```

`timedOut` 从抛出的 `code === 'ETIMEDOUT'` 读（`status=null`、`signal='SIGTERM'`），`exitCode` 落 `1`；该子命令一行都没输出，`describeRed` 于是补一句 `it printed nothing at all` 而不是留下悬空分隔符。同一轮里其余五条读数照常给出（`AC6 exit=0 cases=7/6/8/n/a/n/a`），说明 240s 的有界超时是把「挂住」变成具名的失败，而不是让整个文件被 runner 的 `FILE_TIMEOUT_SECS=600` 打死（268s < 600s，且其余五条仍在同一轮报出）。240s 取自实测：六条子命令里最慢的是 `npm run typecheck` 11.7s，240s 是其 20 倍（`voice.service` 0.57s / `voiceHealth` 0.59s / `voice-config` 2.3s / `voiceTranscribeGaps` 0.73s / `typecheck` 11.7s / `lint` 8.1s）。还原后 md5 = `827f0a274c3a115325848a9065a8f07c`。

**AC4 判据未被放松。** `git diff develop -- server/modules/voice/tests/voice-capture-off.false-forms.test.ts | grep -c '^-.*assert'` = **0**（没有删改任何 `assert.*` 行）；两条断言的两个集合条件 `exitCode !== 0` 与 `cases === 0` 在 diff 里仍是上下文行（无 +/- 前缀）。该文件独立连跑 3 次全 `exit 0 / ℹ tests 4 / pass 4 / fail 0`；`npm run typecheck` rc=0；`npm run lint` rc=0（只有既有的 oxlint 警告，且不在本任务文件上）。改动只落在这一个文件：`git status --porcelain` 只有 ` M server/modules/voice/tests/voice-capture-off.false-forms.test.ts`。

**AC5 范围纪律：没有动 `scripts/test.sh`。** 归因不需要 runner 配合，是因为 `first_error()` 本来就会取「文件里第一行像错误的东西」——把归因放进那条流式读数/断言消息里，就自动搭上了这趟车。所以 runner 一行未改（`git diff develop -- scripts/test.sh` 为空），也没有按「必须改 runner」另立 gap。

**诚实边界（重要）。** 本任务**没有复现** driver 那两轮的红。本任务自己跑出来的读数只有：单跑 3 连绿、以及上面三次注入（注入是「证明下次红能读出来」，不是「红已经被消除」）。finding 里提到的「15 路 lane 形状加压仍绿、六条子命令全 exit 0」**不是本任务跑的**，此处不复核、不作为本任务的证据。因此交付的是**可归因性**，不是**红已被消除**：真正的子命令失败（最可能是 OOM/SIGKILL 或 typecheck 红）需要等这条归因落地后另立任务，届时那轮的 `not ok` 行会直接点名是哪条命令、什么退出码/信号、尾部说了什么。
