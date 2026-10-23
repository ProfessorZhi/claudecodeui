---
id: gap-ac142-recording-evidence-load-flake
title: AC-142 判据在宿主并发下红在录音腿：固定 1.5s 捕获窗零帧时应用不发请求（useVoiceInput.ts:1124
  空捕获静默），15s POST 谓词超时 ⇒ 红；把录音证据改成有界可回放并让失败可分辨，不改产品行为与任何读数
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-142
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测）：`grep -rn "^goal_ac: *AC-142" tasks/*.md` → 3 命中，全为 `done`（`gap-voice-dashscope-written-browser-e2e`、`gap-voice-dashscope-criterion-boot-dep-reopt-race`、`gap-ac142-refusal-leg-copy-repoint`），**没有** todo/ready/needs-human 的认领者；`grep -rln "voice-dashscope-written" tasks/*.md` → 13 命中亦全为 `done`。⇒ 按本轮规则，done 的认领不是重复，是「更早的修复没守住」的证据。近机制但不同条（登记以免被当成新发现）：`gap-ac122-shared-assembly-starves-leg-budget`（done，AC-122）在本文件的姊妹 spec 上修过「宿主并发下共享阶段/腿预算被饿死」；`gap-voice-dashscope-criterion-boot-dep-reopt-race`（done）修的是启动依赖重优化竞态；`gap-ac142-refusal-leg-copy-repoint`（done）只重指了 refusal 腿的**文案期望**。本条认领的是它们都没覆盖的那一格：**录音证据本身在负载下红**。

**本轮的直接测量（不是台账尾巴）**

同一 checkout、立案时 `git rev-parse HEAD` = `fd1639000639d0657a85945ab2ba3030b9640ed2`（此后 HEAD 被 driver 的 `task_write` 提交继续推进），直跑判据本体 **3 次**：

```
npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"
exit=0   2 passed   criterion-wall-ms=21900 / 23958 / 27256   （三次同形，全绿）
```

三条读数都在：`proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=67`；`before-said-unauthorized=false after-said-unauthorized=true`；`draft-kept=true posts=1 aliyuncs-refusal=0`；三句文案 `distinct=3/3`。⇒ **criterion 现在是 TRUE**。

**红的那一次：台账最后一条 fail 是负载下的 flake，不是保证破了**

`gate-events.jsonl` 里 AC-142 的最后一条是 `verdict: fail`（`2026-10-07T08:42:29Z`，treeSha `a544a56fbc69`，即当刻 HEAD `fd163900` 的树）。但同一台账里它此前 **35 连绿**（06:44–08:24，跨多个 tree）；driver 自己 `08:40:30Z` 的 frozen recheck 也是 `AC-142 pass`（durationMs 43686、load1 45.63）；而 2 分钟前的 08:40 与 2 分钟后的 08:43 是姊妹 e2e **AC-172 红/绿对调**，三条红共享同一段 stderr 尾巴（`react-scan.js` 500KB BABEL deopt + DEP0190 弃用告警）——那是 WebServer 噪声，不是断言。⇒ 分辨力在宿主并发（load1≈45），不在判据的保证。

**红在哪（读失败运行的 trace，不是读 reason 里的 stderr 尾巴）**

失败运行目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-t9jQne/`（本地 16:42，gate 事件所指那次）。`test-results/voice-dashscope-written-AC-1a870--leaves-the-draft-untouched/` 的 `error-context.md` 与 `trace.zip`：

- 断言：`Error: the recording never reached the proxy stand-in` / `Expected: 1 / Received: 0` / `Timeout 15000ms exceeded while waiting on the predicate`，落在 **refusal 腿**（`spec:1048`，poll 在 `spec:1074-1077`）。
- 动作序列（`1-trace.trace`）：draft 填入 → health poll 过 → `Voice input` 可见 → **click 成功** → `Stop recording` **两次都可见**（确定起录了）→ `wait-for-timeout 1500` → **click stop 成功** → 之后 `the recording never reached the proxy stand-in` 重试 19 次全 0。
- 网络（`3-trace.network`，refusal 腿的 page@7923caaa）：只有 **1 次** document load（`?voiceTrim=off&voiceDebug=1`，08:42:10.652Z，**无 reload**），`GET /api/voice/capture` 200 @12.707Z（起录），此后到 28.541Z 只有 `/api/session-hosts`、`/api/providers/sessions/running` 的轮询 —— **整条腿一次 `/api/voice/transcribe` 都没有**。同一次运行里唯一那条 transcribe POST 是 **written 腿**的（page@594232bd，200 @10.577Z）。

**机制（产品侧的既有行为 × 判据的定时面）**

应用在「录到了零音频」时**故意不发请求、也不报错**：`src/modules/chat/hooks/useVoiceInput.ts:1124` 的 no-VAD 收尾路径只在 `session.wholeChunks.length > 0` 时把整段录音入队；`stopCapture` 随 `pending === 0` 静默 `finalizeSession`，其注释原文即「a stop with nothing buffered sends no request and reports no error」（`:1232-1233`）。空转静停守卫 `DEFAULT_IDLE_AUTOSTOP_SEC = 120`（`:120`）远大于一次 1.5s 捕获，故**不是**它触发的。`setState('recording')`（`:1238`）是在 `engine.start` 兑现后才设的，所以「`Stop recording` 可见」只证明引擎起了，不证明**出过帧**。⇒ 这一格红 =「固定 1.5s 捕获窗在负载下零帧」×「应用对空捕获静默」。判据的 `recordOnce`（`CAPTURE_MS = 1_500`，`spec:167` / `spec:755-764`）把「一次定长捕获必出音频」当保证，而它不是。

**为什么更早的修复没守住**

`gap-ac142-refusal-leg-copy-repoint`（done）只把 refusal 腿的**文案期望**从旧拼接句重指到按 code 选出的句子，**没有碰这条腿的定时面**（定长捕获窗 + 15s POST 谓词）；本轮红的是后者，是另一个机制。同族 `gap-ac122-shared-assembly-starves-leg-budget`（done）已在其姊妹 spec 上确立了「宿主并发下共享阶段/腿预算被饿死时要有界、失败点要响亮」的修法，本条把同一把尺子用到录音证据上。

**修复的不变式（判据物，不指定实现）**

1. 录音证据**有界、可回放**：不再把「一次定长捕获」当保证 —— 录一次；若在单次观察窗内没看到 POST，就**重录一次**（全新的一次捕获），累计到**由该腿自身预算派生的截止时刻**为止；不得把整个腿的时间烧在一次捕获上，也不得让重放把计数抬过 1（成功那次仍须恰好 1 个 POST）。
2. 每次尝试都**打印读数**：尝试序号、每次观察到的 `proxyPosts.length`、当次是否起录（`Stop recording` 是否出现）；成功那次的 POST 仍必须**恰好为 1**（按尝试重置/限定该腿的计数，或在产生 POST 的那次尝试上断言）。
3. 穷尽后**响亮失败且可分辨**：失败消息同时打印（a）累计 POST 数、（b）页面文本、（c）**录音器是否起录**（`Stop recording` 是否出现过）——使一次零帧捕获读作「起来了、没上传」，而不是裸的 15s 超时让「零帧」与「应用丢了到手的录音」同形。
4. **读数一个字不动**：written 腿仍打印 `proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=<n>`；refusal 腿仍打印 `before-said-unauthorized=false after-said-unauthorized=true`、`draft-kept=true posts=1 aliyuncs-refusal=0`、`copy[UNAUTHORIZED]`/`copy[NO_SPEECH_DETECTED]`/`copy[unknown]` 三句 `distinct=3/3`；`aliyuncs` 账本仍为 0，页面仍「逐字等于出货目录里那句」。
5. **⛔ 不改产品行为**：`useVoiceInput.ts:1124` 的「空捕获不发请求」保持一字不动；不改 12 个 `locales/*/chat.json`；不改 `e2e/voice-trim.spec.ts` 的诊断数组；不改 `spec:92-105` 的替身-真实差异登记。

## AC

- [x] AC1 判据入口：`npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"` 退出码 0，两条腿都 passed，同次运行打印 `criterion-wall-ms=<n>` 且 < 45000（门是 60 秒硬上限、不可调）。立案基线（三次直跑全绿）：`exit=0 / 2 passed / criterion-wall-ms=21900、23958、27256`；红态基线：refusal 腿 `exit=1 / Received: 0 / Timeout 15000ms exceeded`（spec:1048）。
- [x] AC2 有界可回放：录音证据步不再等同于「一次定长捕获」—— 完成后打印一行 `record-attempts=<k> per-attempt-posts=[…] deadline-ms=<n>`，且该步的耗时上限由本腿预算派生并在完成记录里给出推导；穷尽前若某次尝试产生 POST 则就此停手。
- [x] AC3 可分辨的响亮失败：把「捕获零帧」机械复现（见 AC5-ii）时，失败消息同时打印累计 `proxyPosts`、页面文本、以及录音器是否起录的读数 —— 三者都要在完成记录里逐字登记。
- [x] AC4 读数未改窄：同一次 `-g` 运行里 written 腿打印 `proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=<n>`；refusal 腿打印 `before-said-unauthorized=false after-said-unauthorized=true` 与 `draft-kept=true posts=1 aliyuncs-refusal=0`，且 `copy[...]` 三句 `distinct=3/3`；`grep -n "Transcription failed" e2e/voice-dashscope-written.spec.ts` 仍 0 命中。
- [x] AC5 取假形态逐条实测并登记实测退出码与红态文案：(i) 前端忽略 proxy-only 而直连（把 provider 的 transport 当 direct 用）⇒ 判据必须红（AC 记录自带的假形态）；(ii) 造出「捕获零帧」（例如把 `CAPTURE_MS` 临时压到 1ms，使引擎来不及出帧）⇒ refusal 腿必须在 **AC3 的可分辨失败读数**上红，而不是裸超时；(iii) 失败时清空草稿 ⇒ refusal 腿的 `draft-kept` 必须红。任一读绿须说明是哪一杠杆吸收的，不得静默换过、不得手改 tick。
- [x] AC6 契约面不被改窄：`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）与 `npm run lint` 退出 0；`npx playwright test e2e/voice-dashscope-written.spec.ts` 整文件（三条腿，含对照腿）退出 0。
- [x] AC7 如实登记：完成记录写明「只动判据的录音证据步；`src/modules/chat/hooks/useVoiceInput.ts:1124` 的『空捕获不发请求』一字未改」，登记失败运行目录（`quay-e2e-t9jQne`）、trace 里 refusal 腿零 transcribe 的读法、以及 `load1≈45` 的并发背景；并登记判据仍把 `/api/voice/transcribe` 与 aliyuncs 拦在浏览器侧（ADR-004 决策 8，真实冒烟归人工）。

## DoD

判据在落地后的树上按原命令重跑：退出码 0、两条腿 passed、`criterion-wall-ms` 打印且 < 45000，并附 AC2 的 `record-attempts` 行与 AC4 的四类读数打印；AC5 三条假形态的实测退出码与红态文案（含 AC5-ii 的**可分辨失败消息原文**）写进完成记录；`npm run typecheck` 与 `npm run lint` 退出 0；改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐，多出一个文件即为未 forcing 的越界）；完成记录随 AC tick 的那次 `task_write` 一并追加。

## Touches

- e2e/voice-dashscope-written.spec.ts
- tasks/gap-ac142-recording-evidence-load-flake.md

## 完成记录

**只动判据的录音证据步。** `src/modules/chat/hooks/useVoiceInput.ts:1124` 的「空捕获不发请求」保持一字未改；未改 12 个 `locales/*/chat.json`、未改 `e2e/voice-trim.spec.ts` 的诊断数组、未改 `spec:92-105` 的替身-真实差异登记。`git diff --stat` 只有 `e2e/voice-dashscope-written.spec.ts` 一个文件（`+125/−20`），与 Touches 逐条对齐。

- worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac142-recording-evidence-load-flake`
- branch：`task/gap-ac142-recording-evidence-load-flake`
- 实现 commit（HEAD）：`70e5f83709d46352412c47da1e9d2668c37bb348`
- 与 develop 的 merge-base：`3377d5cc58414d65bc04fe3c3e27a526db92eaee`
- 落地时间：2026-10-07T09:12Z（本地 UTC+8），宿主 load1 约 22–29

### 机制

录音证据以前等同于「一次定长捕获」：`CAPTURE_MS = 1_500` 录一次、点停，再用 15s 的 POST 谓词等上传。但固定 1.5s 捕获窗在宿主并发下可能**一帧都没出**，而应用对空捕获**故意静默**（`useVoiceInput.ts:1124` 只在 `session.wholeChunks.length > 0` 时入队；`stopCapture` 随 `pending === 0` 静默收尾，注释原文「a stop with nothing buffered sends no request and reports no error」，`:1232-1233`）。`setState('recording')`（`:1238`）在 `engine.start` 兑现后才置位，所以「`Stop recording` 可见」只证明引擎起了、不证明出过帧。⇒ 判据把「一次定长捕获必出帧」当保证，而它不是；失败时零帧与应用丢录音同形（裸 15s 超时）。

改法（只动判据）：新增有界可回放的 `recordUntil(leg, evidence, what)`——每次尝试打印 `record-attempt=<k> posts=<n> started=<bool>`；单次尝试的观察窗 `POST_OBSERVE_MS = 4_000`，天花板取「截止时刻」与「本次观察窗」的较小者；若某次尝试看到 POST 立刻停手，否则**重录一次全新捕获**，直到由该腿自身预算派生的截止时刻。穷尽后抛出的失败消息同时打印累计 `proxyPosts`、每次是否起录、以及页面文本。

`AC2 的耗时上限推导`：门是 60s 硬上限、`SINGLE_SPEC_CEILING_MS = 55_000`、`test timeout = 60_000`；该腿另有 15s 起录可见窗与 12s 健康/装配窗 ⇒ `45_000 − 15_000 − 12_000 = 18_000`，取更保守的 `RECORD_EVIDENCE_BUDGET_MS = 12_000`（打印为 `deadline-ms=12000`）。成功那次仍必须**恰好 1 个 POST**（产生 POST 的尝试即停手，计数按腿累计）。

### AC1 / AC2 —— 判据入口与有界可回放（实测绿）

```text
npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"
exit=0  2 passed  criterion-wall-ms=21536        （data dir quay-e2e-fj7bWw）
record-attempt=1 posts=1 started=true
record-attempts=1 per-attempt-posts=[1] deadline-ms=12000
```

AC1：退出码 0、两条腿 passed、`criterion-wall-ms=21536 < 45000`。
AC2：`record-attempts=1 per-attempt-posts=[1] deadline-ms=12000` —— 第一次尝试即产生 POST，故就此停手（`attempts=1` 而非烧满预算）。

### AC4 —— 读数未改窄（同一次 `-g` 运行）

```text
proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=67
before-said-unauthorized=false after-said-unauthorized=true
draft-kept=true posts=1 aliyuncs-refusal=0
copy[…] distinct=3/3
```

`grep -n "Transcription failed" e2e/voice-dashscope-written.spec.ts` → **0 命中**（保持）。

### AC3 / AC5 —— 三条假形态逐条实测（含 AC3 的可分辨失败读数）

**(i) 前端忽略 proxy-only 而直连** —— 把 `src/shared/api.ts` 的 `sharedBackendApplies` 临时改成 `return capabilities.locality === 'remote';`（即把 proxy-only provider 当 direct 用），其余不动：

```text
exit=1   （data dir quay-e2e-YAFzyj）
proxy=1 x-voice-provider=undefined aliyuncs=0 composer-len=67
Expected: "dashscope-omni"
Received: undefined
  落在 expect(post.headers['x-voice-provider']).toBe(PROXIED_PROVIDER_ID)（spec:1130）
refusal 腿：did not run    （spec 顶部 test.describe.configure({ mode: 'serial' }) 所致）
```

⇒ 判据必须红，实测红在 AC4 记录的那条路由头上（`x-voice-provider` 由 `dashscope-omni` 退化为 `undefined`）。refusal 腿因 serial 模式被跳过，未吸收该杠杆。

**(ii) 捕获零帧** —— 两次测量。(ii-a) 把 `CAPTURE_MS` 临时压到 `1`：

```text
exit=1   （data dir quay-e2e-JXO9aN）
record-attempts=3 per-attempt-posts=[0,0,0] deadline-ms=12000
Error: written: the recording never reached the proxy stand-in after 3 attempt(s)
  cumulative proxyPosts=0
  recorder-started=true per-attempt-started=[true,true,true]
  page text: "<…>"        （页面文本已读取，非 <unreadable>）
refusal 腿：did not run
```

因 `spec:508` 的 `test.describe.configure({ mode: 'serial' })`，written 腿先红会跳过 refusal 腿（Playwright 记「did not run」），故补做 (ii-b)：把零帧**限定在 refusal 腿自己那次捕获**上（临时给 `recordOnce` 加 `captureMs` 参数，refusal 腿传 `1`）：

```text
exit=1   （data dir quay-e2e-EPC4Ht）
written 腿 1 passed
refusal 腿：
Error: refusal: the recording never reached the proxy stand-in after 3 attempt(s)
  cumulative proxyPosts=0
  recorder-started=true per-attempt-started=[true,true,true]
  page text: "<…>"
criterion-wall-ms=31494
```

⇒ **AC3 满足**：零帧失败读作「起来了（`recorder-started=true`）、一次都没上传（`cumulative proxyPosts=0`）、重录 3 次全零帧」，而不是裸的 `Timeout 15000ms exceeded`。这正是修复前那条失败（`quay-e2e-t9jQne`）长得一模一样的形态，现在被分辨出来了。

**(iii) 失败时清空草稿** —— 让 `src/modules/chat/composer/ChatComposer.tsx` 的 `handleVoiceError` 额外调用 `onInputChange({ target: { value: '', selectionStart: 0 } })`：

```text
exit=1   （data dir quay-e2e-QUT5KG）
draft-kept=false posts=1 aliyuncs-refusal=0
Expected: true
Received: false
  落在 expect(draftKept).toBe(true)（spec:1234）
```

⇒ refusal 腿的 `draft-kept` 实测红。

三处临时改动全部用 `git checkout --` 还原，落地树确认干净（`git diff --stat` 只剩 `e2e/voice-dashscope-written.spec.ts`）。

### AC6 —— 契约面不被改窄

```text
npm run typecheck   → exit 0   （根 + server/tsconfig.json + scripts/tsconfig.json 三套；注：根 tsconfig 不 include e2e/）
npm run lint        → exit 0   （仅 warning）
npx playwright test e2e/voice-dashscope-written.spec.ts   （整文件，三条腿含对照腿）
exit=0  3 passed  criterion-wall-ms=26720    （data dir quay-e2e-RD7t7c）
control-aliyuncs=1 control-proxy-posts=0 control-composer-len=55
```

对照腿（直连走 workspace host）读数不变：`control-aliyuncs=1 control-proxy-posts=0 control-composer-len=55`。

### AC7 —— 如实登记

- 失败运行目录：`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-t9jQne/`（本地 16:42，即 gate 事件所指那次，treeSha `a544a56fbc69`）。`test-results/…-leaves-the-draft-untouched/` 的 `trace.zip` 里 `3-trace.network`：refusal 腿的 page（`page@7923caaa`）整条腿**一次 `/api/voice/transcribe` 都没有**——只有 1 次 document load（`?voiceTrim=off&voiceDebug=1`，08:42:10.652Z，无 reload）、`GET /api/voice/capture` 200 @12.707Z 起录，此后到 28.541Z 只有 `/api/session-hosts` 与 `/api/providers/sessions/running` 的轮询。整个运行里唯一那条 transcribe POST 属于 **written 腿**（`page@594232bd`，200 @2026-10-07T08:42:10.577Z）；同一时间戳在两个 `*-trace.network` chunk 里各出现一次，是**一条**请求。`test.trace` 里该腿的红仍是修复前的裸形态：`the recording never reached the proxy stand-in` + `Timeout 15000ms exceeded while waiting on the predicate`。
- 并发背景：`load1≈45`（AC-142 此前同台账 **35 连绿**，06:44–08:24 跨多个 tree；driver `08:40:30Z` 的 frozen recheck 亦 `AC-142 pass`、durationMs 43686、load1 45.63）；红只出现在宿主并发最高的那一段，与判据的保证无关。
- 判据仍把 `/api/voice/transcribe` 与 `aliyuncs.com` 拦在浏览器侧（`page.route`）。真实冒烟归人工 —— 依 ADR-004 决策 8，本判据不代跑真实 provider。
