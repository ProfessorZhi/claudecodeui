---
id: gap-voice-falsify-copies-inside-tsc-program
title: voice 判据的瞬时副本仍在 tsc 的 program 里：server/tsconfig.json 的 include 是
  ./**/*.ts，而四个 false-forms 副本与 AC4(b) 的 20 次 churn 都写在 server/modules/voice/ 下
  ⇒ 并发 typecheck 删除竞态报 TS6053（已观测 5 次、挡住 2 个任务），种一个带类型错误的副本更会无需竞态地报 TS2322；site
  1 的 exclude 修法盖不到
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

**这条通道已经被观测到 5 次，每次都是同一个文件、同一条子命令、同一个路径，而到目前为止无人立案。**

`server/modules/voice/tests/voice-capture-off.false-forms.test.ts` 的 AC6 会跑 `npm run typecheck`；suite 并发 16 时它红成（逐字，五次同形，只有 worktree 不同）：

```
AC6 FAIL cases=n/a :: npm run typecheck (exit=2)
| sig: error TS6053: File '<worktree>/server/modules/voice/__criterion-falsify-ac8probe-19.ts' not found.
```

点名格式是 `gap-voice-capture-off-ac6-red-not-attributable`（已 done）加的；在这之前这条红只吐一句静态文案，所以四次都读不出来。

**已知的五次实例**（`.quay/fan-in-suite-*.log`）：

| # | 时间 | 任务 | 日志 |
|---|---|---|---|
| 1 | 2026-09-26 | `gap-session-hosts-lease-driven-lifecycle` | `…lease-driven-lifecycle~wk-prod-anchor~1790424810960-d02f6c.log` |
| 2 | 2026-09-26 20:53 | `gap-session-hosts-rest-list-endpoint` | `…rest-list-endpoint~wk-prod-anchor~1790427161401-078e1c.log` |
| 3 | 2026-09-26 21:16 | `gap-session-hosts-claude-per-run-driver` | `…claude-per-run-driver~wk-prod-anchor~1790428436889-6039b5.log` |
| 4 | 2026-09-26 21:46 | `gap-debug-agent-host-driver` | `…debug-agent-host-driver~wk-prod-anchor~1790430384172-7a51c2.log` |
| 5 | 2026-09-26 | `gap-session-hosts-claude-per-run-driver`（本轮） | `…claude-per-run-driver~wk-prod-anchor~1790428823628-e49d55.log` |

其中第 3、5 次直接把这一个任务挡在 `needs-human`。**每一次的三条剔除读数都成立**：delta 里没有 `server/modules/voice/` 下的文件、该任务自己的 `## Touches` 判据在同轮 `passed=true`、同日志的 `typecheck`/`lint` 两行是**独立的绿行**（不是 AC6 那个子命令）。

**机制（与已修的 site 1 同类，但 site 1 的修法盖不到它）。**

`server/tsconfig.json` 的 `include` 是 `["./**/*.js", "./**/*.ts", …]`，相对 `server/` 解析 —— 于是**任何**在 `tsc` glob 的那一刻存在于 `server/` 之下的 `.ts` 都会进入 program。判据在跑的时候会往里写两种瞬时文件：

- **site 2（本条的主诉）**：`voice-dashscope-settings.false-forms.test.ts:1179` 的 AC4(b) 20 次 churn，逐个写又删 `server/modules/voice/__criterion-falsify-ac8probe-<i>.ts`（前缀 `:529`）。写者自己的 kept child log 直接点名它：`.quay/suite-logs/<run-id>/server__modules__voice__tests__voice-dashscope-settings.false-forms.test.ts.out:20` → `falsify/git-status-clean=false (tree was already dirty before this run): ?? server/modules/voice/__criterion-falsify-ac8probe-2.ts`。
- **site 3**：四个 `voice-*.false-forms.test.ts` 各写 `__criterion-falsify-<mut>-{base,mut}-<pid>.ts`。

两种红法都实测过（在树上种文件再跑 `tsc`）：

- **删除竞态 → TS6053**：`collect-then-read` 窗口里文件被删，`tsc` 报 `File … not found`。这是五次实例的形状（`-19` 是 `AC4B_DELAYS_MS` 的最后一档 1300ms，活得最久，所以最容易撞上）。
- **不需要竞态 → TS2322**：种一个带类型错误的 `server/modules/voice/__criterion-falsify-typeerr.ts` 就会让 typecheck `exit=2`，没有删除竞态参与。这条危害更大，而且正是「一次没清掉的 stale 副本」会产生的形状。

**为什么不能靠目录 exclude 盖住。** 已经落地的 `cfd66cea` 只把 `./modules/voice/tmp`（site 1 的探针目录）加进 `exclude`。site 2/3 的副本**必须**贴在它们复制的模块旁边（副本里的相对 import 要能解析），而那个目录装的是真源码，所以没有目录级 exclude 可用。

**修法（二选一，实现者择优并在完成记录里写明依据）。**

- **(a) 名字级 exclude**：在 `server/tsconfig.json` 的 `exclude` 里加 `"./**/__criterion-falsify-*"`。判据自己的 arm tsconfig **刻意设了 `exclude: []`**（它们不该继承 server 配置的意见），所以这条路不会让 arm 编译不到副本 —— **这一条必须由 AC 验证**（见 AC3）。
- **(b) 收窄 `include` 到真正的源码根**，或把副本迁到仓根的 `tmp/`（本仓已有这个正确范本：`server/modules/voice/tests/voice-error-classification.false-forms.test.ts:96` 用仓根 `tmp/`；`include` 相对 `server/` 解析，`<repo>/tmp` 不在其中）。注意别把 `server/tmp/` 当成仓根 `tmp/` —— 前者仍在 include 里。

⛔ 不变式：不改任何判据的**语义** —— AC4(b) 的 20 次 churn 与四个 false-forms 判据的副本机制都保留原样（churn 是 AC8 扫描的扰动源，删了等于把判据变成不承重）；不删断言；不动 `scripts/test.sh`；不改判据命令。

<!-- dedup-ref -->
**边界。** 这不是 `gap-tsc-sees-transient-probe-file`（已 done，`cfd66cea`）—— 那条修的是 site 1（`server/modules/voice/tmp/__stray-shipping-probe.ts`），且它的 Finding 明确把 site 2/3 划出范围、只登记为「预测但未观测」。本条接手的是已观测到 5 次的那两个 site。与 `gap-voice-capture-off-ac6-red-not-attributable`（已 done）无关：那条只让红变得可归因，本条修归因暴露出来的真因。

## AC

- [x] AC1 先拿到两种确定的红（改前，读数照抄进完成记录）：
  (i) **删除竞态**：在树上让 `server/modules/voice/__criterion-falsify-ac8probe-probe.ts` 存在一小段后被删，**同时**跑 `tsc --noEmit -p server/tsconfig.json`，使它在收进之后发现文件已消失 → 退出非 0 且含 `error TS6053` 与那个路径。
  (ii) **无需竞态**：种一个带类型错误的同前缀文件（如 `const x: number = "not a number"`）→ 同一命令退出非 0 且含 `error TS2322`。
- [x] AC2 改后同一对读数变绿：同一脚本在改后的树上重跑 (i) 与 (ii)，两次都退出 0，且 `tsc -p server/tsconfig.json --listFiles | grep -c '__criterion-falsify'` 为 **0**（改前该计数在种一个文件时 ≥1，把改前改后的计数并排登记）。
- [x] AC3 判据自身的编译面没被一起拿掉（这条是本任务的负控制）：四个 `voice-*.false-forms.test.ts` 各自单独跑 `exit 0`、`fail 0`，且它们的 arm 读数仍在（至少 `voice-dashscope-settings.false-forms.test.ts` 的 AC4(b) churn 与 `voice-error-contract.false-forms.test.ts` 的 `alignment=…` 读数逐字出现）。若选了 (a)，还需证明 arm tsconfig 的 `exclude: []` 确实生效（例如给出 arm 编译仍报出副本里的错误一次的读数）。
- [x] AC4 `voice-capture-off` 的 AC6 转绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts` 退出 0，且它打印的六条 `AC6 exit=` 全为 0（尤其 `npm run typecheck`）。
- [x] AC5 门与范围：`npm run typecheck`、`npm run lint` 退出 0；`git diff --stat develop...HEAD` 只含 `## Touches` 列出的文件。

## DoD

真实落地判据是**那两条红法都不再可能**：AC1 在改前两种形态各读到一次红（原文登记），AC2 证明同一对读数在改后都绿、且副本已不在 tsc 的 program 里，AC3 证明判据自己的编译面（arm）没被一起拿掉 —— 三条合起来才算「副本仍在、但不再进 typecheck」。完成记录必须写明：本条只动 `tsc` 看见什么，不改判据语义；以及一条可复查的落地证据 —— 此后任何 `fan-in-suite-*.log` 里再出现 `AC6 FAIL :: npm run typecheck` 时，其 `sig:` 里不应再是 `__criterion-falsify-*`（现在这已是点名格式，有真因必然读得出来）。五条历史实例的日志路径一并在完成记录里列出，证明落点对症。

## Touches

- server/tsconfig.json
- server/modules/voice/tests/voice-dashscope-settings.false-forms.test.ts
- server/modules/voice/tests/voice-capture-off.false-forms.test.ts
- server/modules/voice/tests/voice-capture-text.false-forms.test.ts
- server/modules/voice/tests/voice-error-contract.false-forms.test.ts
- tasks/gap-voice-falsify-copies-inside-tsc-program.md

## Completion

执行者：quay worker（分支 `task/gap-voice-falsify-copies-inside-tsc-program`，实现提交 `7e6d0744`）。
实现提交只含 `server/tsconfig.json` 一个文件。

**落点：`server/tsconfig.json` 的 `exclude` 加一条 `"./**/__criterion-falsify-*"`（选 (a)），一处改动，site 2 与 site 3 一并覆盖。**

选 (a) 而非 (b) 的依据：site 2/3 的副本**必须**贴在它们复制的模块旁边（副本里的相对 import 要能解析），所以 (b) 的「迁到仓根 `tmp/`」等于改判据的副本机制本身，还要四个 false-forms 文件各自重写 import 重定根逻辑；而 (b) 的「收窄 `include`」要把 `./**/*.ts` 拆成真实源码根清单、并另行判断 `../shared/**`，面大且容易把判据自己的 arm 编译面一起改掉。名字级规则是一条只作用于 `tsc` 项目 program 的过滤：副本仍在、仍被判据自己的扫描器与 arm 编译看见，只是不再进项目的 typecheck。

**验证脚本**（本 worktree 的 `tmp/` 下，`tmp/` 在 `.gitignore` 里故不进 `git diff`；跑完即删）：

```bash
# (i) 删除竞态：种探针 -> 起 tsc -> 600ms 后删 -> 读退出码与 sig
printf '// a sibling-shaped in-flight temp copy\n' > server/modules/voice/__criterion-falsify-ac8probe-probe.ts
( npx tsc --noEmit -p server/tsconfig.json ) > out 2>&1 &
python3 -c "import time; time.sleep(0.6)" ; rm -f server/modules/voice/__criterion-falsify-ac8probe-probe.ts
wait ; grep -m1 'error TS' out
# (ii) 无需竞态：种一个带类型错误的同前缀文件 -> 同一命令
printf 'const x: number = "not a number";\nexport { x };\n' > server/modules/voice/__criterion-falsify-typeerr.ts
npx tsc --noEmit -p server/tsconfig.json ; grep -m1 'error TS' ; rm -f ...
# AC2 的 program 成员计数
printf '// a sibling-shaped in-flight temp copy\n' > server/modules/voice/__criterion-falsify-ac8probe-probe.ts
npx tsc -p server/tsconfig.json --listFiles | grep -c '__criterion-falsify'
```

**改前窗口的标定**（为什么取 600ms）：在**未改**的树上把删除延迟扫 0/200/…/2000ms，读数四档为红、其余为绿 —— `collect-then-read` 窗口约 300–1100ms，600ms 落在正中（也解释了为什么历史实例总是 `ac8probe-19`：1300ms 那一档存在得最久，最容易正好落在别处的 tsc 读窗口里）。

### AC1 —— 改前，同一条命令的两种红（原文）

```
delay=0 exit=0 ts6053=no sig=(none)
delay=200 exit=0 ts6053=no sig=(none)
delay=400 exit=2 ts6053=yes sig=error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-voice-falsify-copies-inside-tsc-program/server/modules/voice/__criterion-falsify-ac8probe-probe.ts' not found.
delay=600 exit=2 ts6053=yes sig=error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-voice-falsify-copies-inside-tsc-program/server/modules/voice/__criterion-falsify-ac8probe-probe.ts' not found.
delay=800 exit=2 ts6053=yes sig=error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-voice-falsify-copies-inside-tsc-program/server/modules/voice/__criterion-falsify-ac8probe-probe.ts' not found.
delay=1000 exit=2 ts6053=yes sig=error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-voice-falsify-copies-inside-tsc-program/server/modules/voice/__criterion-falsify-ac8probe-probe.ts' not found.
delay=1200 exit=0 ts6053=no sig=(none)
```

`(ii)` 无需竞态那一半，同一命令、同一个未改的树：

```
$ printf 'const x: number = "not a number";\nexport { x };\n' > server/modules/voice/__criterion-falsify-typeerr.ts
$ npx tsc --noEmit -p server/tsconfig.json
server/modules/voice/__criterion-falsify-typeerr.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
exit=2
```

改前的树 = 本 worktree 的 `develop` 版 `server/tsconfig.json`（`git show develop:server/tsconfig.json > server/tsconfig.json`，跑完 `git checkout HEAD -- server/tsconfig.json` 还原）。**反向腿用 `git checkout` 而不是 `git stash`**：修法已经 commit，`git stash` 在已提交的树上是一次空操作（第一次尝试正是这样假绿的），换成 checkout 后同一脚本立刻读到红。

### AC2 —— 改后，同一脚本，两次都绿

```
(i)  race      exit=0 ts6053=no sig=(none)
(ii) typeerr   exit=0 ts2322=no sig=(none)
listFiles __criterion-falsify count (clean probe planted) = 0
```

改后（延迟 200/400/600/800/1000/1200 全档）：`exit=0 ts6053=no` —— 改前读到 TS6053 的 400/600/800/1000 四档现在无一红。

并排登记：

| 读数 | 改前 | 改后 |
|---|---|---|
| (i) 删除竞态 `delay=600` | `exit=2 ts6053=yes` | `exit=0 ts6053=no` |
| (ii) 类型错误副本 | `exit=2 ts2322=yes` | `exit=0 ts2322=no` |
| `tsc -p server/tsconfig.json --listFiles \| grep -c '__criterion-falsify'`（种一个探针） | **1** | **0** |

### AC3 —— 判据自己的编译面（负控制）

四个 `voice-*.false-forms.test.ts` 各自单独跑（`npx tsx --tsconfig server/tsconfig.json --test <file>`）：

```
voice-capture-off.false-forms.test.ts        exit=0  tests 4  pass 4  fail 0
voice-dashscope-settings.false-forms.test.ts exit=0  tests 3  pass 3  fail 0
voice-capture-text.false-forms.test.ts       exit=0  tests 6  pass 6  fail 0
voice-error-contract.false-forms.test.ts     exit=0  tests 4  pass 4  fail 0
```

arm 读数仍在（逐字）：

- AC4(b) churn —— `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-dashscope-settings.test.ts` → exit 0、tests 32 / pass 32 / fail 0：
  ```
  ac8-churn n=0 delay-ms=0 ok=true server-branch-scan
  ac8-churn n=19 delay-ms=1300 ok=true server-branch-scan
  ac8-churn-summary repetitions=20 distinct-files-counts=1 files=336 all-ok=true
  ac8-positive-control ok=false server-branch-scan files=337 shipping-hits=1 [modules/voice/tmp/__stray-shipping-probe.ts] test-fixture-hits=5 [modules/database/tests/voice-settings.db.integration.test.ts modules/voice/tests/voice-dashscope-default-model.test.ts modules/voice/tests/voice-dashscope-settings.test.ts modules/voice/tests/voice-error-contract.test.ts modules/voice/tests/voice-provider-dispatch.test.ts] (equivalent: grep -rn "'dashscope-omni'" server/)
  ```
  20 次 churn 全绿、文件计数恒为 336、正控制仍红并点名探针 ⇒ 副本机制与判据的扫描面一字未动。
- `alignment=…` —— `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-error-classification.false-forms.test.ts` → exit 0、tests 7 / pass 7 / fail 0：
  ```
  alignment=ASR_ERROR_CODE_ALIGNMENT typecheck-reds-on-drift=true baseExit=0 mutantExit=2 names-the-deleted-code=true names-the-alignment-type=true arm=tsc --noEmit -p <scratch>/tsconfig.<arm>.json (extends server/tsconfig.json, the project's own options; the shipping tree's own npm run typecheck is AC7's reading above) first-error=tmp/__criterion-falsify-voice-error-classification/drift-mut-2658720.ts(325,3): error TS2353: Object literal may only specify known properties, and 'NO_SPEECH_DETECTED' does not exist in type 'Readonly<Record<AsrErrorCode, true>>'.
  ```
- mutant 分支仍在承重（base 绿 / mutant 红），例如 `voice-error-contract`：`falsify/raw-body-copied-through mutant: ... baseExit=0 mutantRed=true whichLine=AC3 whichReading=AC3 code/upstream-401 red=9`；`voice-capture-text` 四条 mutation 全 `baseExit=0 mutantRed=true`。

**arm tsconfig 的 `exclude: []` 确实生效**（选了 (a) 就必须证明这一条）。两读数并排，同一条 `__criterion-falsify-*` 路径：

```
$ cat server/modules/voice/tsconfig.armprobe.json
{ "extends": "../../tsconfig.json", "include": ["./__criterion-falsify-armprobe.ts"], "exclude": [] }
$ npx tsc --noEmit -p server/modules/voice/tsconfig.armprobe.json
server/modules/voice/__criterion-falsify-armprobe.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.
arm exit=2

$ npx tsc --noEmit -p server/tsconfig.json      # 同一个文件，项目自己的配置
server exit=0
```

即：arm 配置（`exclude: []`）照旧把带前缀的副本收进 program 并报出它里面的错，项目配置不再看见它。临时 arm 配置与该文件跑完即删，`git status --porcelain` 为空。另一重保险是判据真正在用的那支 arm（`voice-error-classification.false-forms.test.ts` 的 AC8 drift）把副本写在**仓根 `tmp/`**、文件名不含前缀，本就不在新规则之下 —— 它上面的 `mutantExit=2` 与此处的 `arm exit=2` 相互印证。

### AC4 —— `voice-capture-off` 的 AC6 转绿

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-capture-off.false-forms.test.ts
EXIT=0
AC6 exit=0 cases=4 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice.service.test.ts
AC6 exit=0 cases=7 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voiceHealth.test.ts
AC6 exit=0 cases=6 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-config.routes.test.ts
AC6 exit=0 cases=8 :: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voiceTranscribeGaps.test.ts
AC6 exit=0 cases=n/a :: npm run typecheck
AC6 exit=0 cases=n/a :: npm run lint
ℹ tests 4 / pass 4 / fail 0
```

六条全 0，含 `npm run typecheck` —— 这一条在改前正是被 `__criterion-falsify-ac8probe-19.ts` 打红的那条。同一文件里的两条 mutation 读数（`falsify/gate-permanently-open`、`falsify/invalid-treated-as-text`）仍是 `baseExit=0 mutantRed=true`。

### AC5 —— 门与范围

```
npm run typecheck  → exit 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json 三支全跑）
npm run lint       → exit 0（仅既有 warning，无 error）

$ git diff --stat develop...HEAD
 server/tsconfig.json | 19 ++++++++++++++++++-
 1 file changed, 18 insertions(+), 1 deletion(-)

$ git diff --name-only develop...HEAD
server/tsconfig.json
```

只含 `## Touches` 列出的文件（真子集：按 (a) 四个 false-forms 文件无需改动，故未动）。`scripts/test.sh` 未动，无断言删除，无判据命令改动。

### DoD —— 真实落地的可复查证据

- **两条红法都不再可能**：AC1 在改前的树上两种形态各读到一次红（原文在上），AC2 证明同一对读数在改后都绿、且副本已不在 program 里（成员计数 1 → 0），AC3 证明判据自己的编译面与 arm 没被一起拿掉。三条合起来 = 副本仍在、但不再进 typecheck。
- **只动 `tsc` 看见什么**：唯一改动是 `server/tsconfig.json` 的 `exclude`。判据的写者（AC4(b) 的 20 次 churn 与四个 false-forms 的 base/mut 副本）与读者（判据自己的扫描器、arm 编译）一字未改，AC3 的逐条读数即是证据。
- **此后如何复查落点**：任何 `fan-in-suite-*.log` 里再出现 `AC6 FAIL cases=n/a :: npm run typecheck` 时，其 `sig:` 里不应再是 `__criterion-falsify-*` —— `tsc` 已不收这类文件，同一条时序不再产生同一条 `sig`；点名格式已由 `gap-voice-capture-off-ac6-red-not-attributable` 落地，若再红必然读得出真因。
- **五条历史实例的日志路径**（`.quay/` 现存 15 个 `fan-in-suite-*.log`，逐个 grep `TS6053` 命中下面 5 个，逐字抄录其 `sig`）：

```
1. .quay/fan-in-suite-gap-claude-resident-phase0-experiments~wk-prod-anchor~1790388621399-a4b12a.log
   sig: error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-claude-resident-phase0-experiments/server/modules/voice/tmp/__stray-shipping-probe.ts' not found.        ← site 1（cfd66cea 已修）
2. .quay/fan-in-suite-gap-claude-resident-phase0-experiments~wk-prod-anchor~1790423985171-c7e044.log
   sig: error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-claude-resident-phase0-experiments/server/modules/voice/tmp/__stray-shipping-probe.ts' not found.        ← site 1
3. .quay/fan-in-suite-gap-claude-resident-phase0-experiments~wk-prod-anchor~1790476936243-800b73.log
   sig: error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-claude-resident-phase0-experiments/server/modules/voice/__criterion-falsify-ac8probe-19.ts' not found.  ← site 2（本条）
4. .quay/fan-in-suite-gap-session-hosts-claude-per-run-driver~wk-prod-anchor~1790428436889-6039b5.log
   sig: error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-session-hosts-claude-per-run-driver/server/modules/voice/__criterion-falsify-ac8probe-19.ts' not found.  ← site 2（本条）
5. .quay/fan-in-suite-gap-session-hosts-claude-per-run-driver~wk-prod-anchor~1790428823628-e49d55.log
   sig: error TS6053: File '/data/home/yale/work/claudecodeui-worktrees/gap-session-hosts-claude-per-run-driver/server/modules/voice/__criterion-falsify-ac8probe-19.ts' not found.  ← site 2（本条）
```

  **第 3 条就是落点对症的直证**：那个 worktree 属 `gap-claude-resident-phase0-experiments`，而该任务的 `## Touches` 是 `scripts/resident-experiment.mjs`、`scripts/resident-experiment.test.mjs`、两份 `docs/proposals/*.md`、`tasks/…md` —— **没有 `server/modules/voice/` 下的任何文件**；同样地第 4/5 条的 `gap-session-hosts-claude-per-run-driver` 只动 `server/modules/providers/list/claude/*` 与 `server/modules/providers/tests/claude-host-per-run.test.ts`。两个「被红」的任务都没有写过那个文件，而 `-19` 逐字对上 Finding 预测的 1300ms 那一档。

### 两处更正（Finding 的笔误，不影响机制与修法）

1. **site 2 的写者文件名**：20 次 churn 写在 `server/modules/voice/tests/voice-dashscope-settings.test.ts:1179`（主判据文件），不是 Finding 所记的 `.false-forms` 变体（该变体只有 324 行、没有 churn；`TEMP_COPY_PREFIX` 在 `:529`）。site 3 才是四个 `voice-*.false-forms.test.ts`。
2. **`alignment=…` 读数的家**：它在 `voice-error-classification.false-forms.test.ts` 的 AC8，不是 Finding 所记的 `voice-error-contract.false-forms.test.ts`（后者自己的 arm 读数是 `falsify/<mutation> mutant/base` 那一族，同样逐字登记在上）。
3. **五次实例表**：表里 `gap-session-hosts-lease-driven-lifecycle`、`gap-session-hosts-rest-list-endpoint`、`gap-debug-agent-host-driver` 三份日志已不在盘上（现存 15 个 `fan-in-suite-*.log` 里 grep `TS6053` 只有上面 5 条，其中 2 条是 site 1），故完成记录只登记盘上实存者；第 3、5 两条与表一致。
