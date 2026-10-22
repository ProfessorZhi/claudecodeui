---
id: gap-ac153-ledger-red-is-host-quota
title: AC-153 的台账读数被宿主配额耗尽（EDQUOT）在判据启动前冒名成红：重跑判据与反假控制并重建读数，钉住「宿主启动死 ≠ 判据假」
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-153
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，宿主本地 2026-09-28 05:1x CST = UTC 2026-09-27 21:1xZ，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `01afb8cbb98cf1ee55c46f9997a5718a2b593927`）：`grep -rn "^goal_ac: *AC-153" tasks/*.md` → 2 命中，两条都是 `done`（`gap-voice-error-notice-browser-e2e`、`gap-ac142-refusal-leg-copy-repoint`），全量 227 条 `tasks/*.md` 里没有第三条，也没有任何 todo/ready/needs-human 的认领者。按本轮规则的默认读法是「更早的修复没守住 ⇒ 立新条」，**本条的直接测量推翻了这个默认读法**，所以本条不是「再修一次」。

**本轮的直接测量（我在同一 checkout 上重跑判据本体，不是台账尾巴）**

```
$ npx playwright test e2e/voice-error-messages.spec.ts
legs=4 coded=4 distinct=3 chinese=4
empty-200="录音里没有检测到人声——请靠近麦克风重新录制。" server-422="录音里没有检测到人声——请靠近麦克风重新录制。" equal=true both-equal-vocab=true
visible-first=true visible-after-4s=true text-unchanged=true closed=true cleared-on-next-recording=true
drafts-kept=4/4 notices-shown=4/4
collapsed-hides-code=true collapsed-hides-upstream=true expanded-shows-status=true expanded-shows-upstream=true status-read=403 upstream-read=AccessDenied.Unpurchased concat-hits=0
legs=4 passed=4 criterion-wall-ms=24796 watchdog-line=false
  1 passed (24.8s)
EXIT=0
```

AC-153 的 expect 点名的每一条读数都在场：四条腿各自的 code 文案（`coded=4`）、中文界面读到中文文案（`chinese=4`）、4 秒之后仍可见（`visible-after-4s=true`）且逐字未变（`text-unchanged=true`）、点关闭后消失（`closed=true`）、下次录音时被清除（`cleared-on-next-recording=true`）、草稿逐字保留（`drafts-kept=4/4`，`notices-shown=4/4` 是它的正对照）、折叠详情行展开前读不到 code 与 upstreamCode 而展开后读得到、无拼接句（`concat-hits=0`）、空 200 与服务端 422 同一条文案（`equal=true both-equal-vocab=true`）。

同一棵树上，判据所依赖的**承重反假控制**也全绿（`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`，exit 0，3 passed / 1.33s）：

```
mutation=four-second-timer lever=the pre-change timer restored in the failure handler … base-green=true mutant-red=true which=AC4 visible-after-4s outside-family-green=true (AC4 closed-on-close-control)
mutation=concat-message … base-green=true mutant-red=true which=AC2 sentence-equals-code-copy + AC6 concat-hits outside-family-green=true (AC4 visible-after-4s)
mutation=clear-draft-on-failure … base-green=true mutant-red=true which=AC5 draft-kept outside-family-green=true (AC4 visible-after-4s)
```

⇒ 这是**可证伪的绿**：三条取假形态各自被指名打红，且读的是同一棵出货组件。

**为什么台账尾巴读 fail：宿主配额耗尽（errno −122 = EDQUOT）在判据启动前把它打死**

`.quay/gate-events.jsonl` 里 AC-153 的 `gate=goal` 读数共 1771 条，**尾巴是 14 连 `pass` 之后接 2 条 `fail`**：

```
2026-09-27T19:24:07.670Z  goal-sweep  pass
2026-09-27T21:04:41.412Z  goal-sweep  fail  Error: Unknown system error -122: Unknown system error -122, mkdtemp '/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-XXXXXX' at mkdtempSync (node:fs:3134:18) at makeTempDir (file:///…/scripts/e2e-data-dir-selection.mjs:268:59) at resolveE2eDataDir (…:294:19) at file:///…/playwright.config.ts
2026-09-27T21:05:56.704Z  goal-cli    fail  （同上，逐字相同）
```

两条 `fail` 的判词都是 **errno −122（Linux 的 `EDQUOT`，用户配额耗尽）**，失败点是 **`mkdtemp`**：判据本体**一次都没开始跑**，谈不上「AC-153 的行为退化了」。同一窗口（`21:04:31.986Z`–`21:05:56.704Z` = 本地 `05:04:31`–`05:05:56` CST）里，**同一原因的 `fail` 共 12 条、跨 7 条 AC**（AC-151×2、AC-153×2、AC-171、AC-172、AC-173×2、AC-174×2、AC-175×2）—— 这 7 条判据连文件都不共享，`12 条独立回归` 不成立；这是宿主故障的指纹。

**同一宿主上，红与绿的间距只有 8 分钟**：`21:02:40Z`–`21:04:31Z` 之间 `~/.cache/quay-e2e-tmp` 新出现 6 个 data dir，其中 **4 个内容为空**（`mkdtemp` 成功、写不进任何东西 ⇒ 启动即死，与那两条 `fail` 同形）；配额缓解之后，**同一条判据在 `21:13:07Z`（本地 `05:13:07` CST）直跑为绿**（上一节）。`/data` 上 `df` 全程显示 `14%` 不紧张 —— `EDQUOT` 是**配额**不是**容量**，`df` 对它无读数，这正是它容易被读成「AC 假」的原因。

**本条的交付面**

把上两节做成**可复核的入档读数**，并把「宿主启动死 ≠ 判据假」的区分钉成下次可机械复用的判法：判据直跑读数（AC1）、反假控制读数（AC2）、台账归因读数（AC3）、尾巴重建或如实登记（AC4）、空 delta 证明（AC5）、根因登记（AC6）。**本条不改任何实现、判据、宿主配置字节**：`~/.cache/quay-e2e-tmp` 无回收者是一个跨任务的共享资源问题（本条立案时实测 572 个目录 / 25G，且没有清理入口），属于另一条任务；本条只登记它，不在这里夹带修它。

## AC

- [x] AC1 判据直跑：`npx playwright test e2e/voice-error-messages.spec.ts` 退出 0；把判据自己打印的读数行**逐字**抄进完成记录（`legs=4 passed=4`、`coded=4`、`chinese=4`、`visible-after-4s=true`、`text-unchanged=true`、`closed=true`、`cleared-on-next-recording=true`、`drafts-kept=4/4`、`notices-shown=4/4`、`collapsed-hides-code=true`、`expanded-shows-status=true`、`expanded-shows-upstream=true`、`concat-hits=0`、`equal=true`、`both-equal-vocab=true`，以及 `EXIT=0`），并同时给出跑动时刻（`date -u`）与 `git rev-parse HEAD`。
- [x] AC2 反假控制承重：`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` 退出 0，且三例各自打印 `base-green=true mutant-red=true outside-family-green=true`；完成记录里按名字指出各自红的是哪条读数（`four-second-timer` → `AC4 visible-after-4s`；`concat-message` → `AC2 sentence-equals-code-copy + AC6 concat-hits`；`clear-draft-on-failure` → `AC5 draft-kept`）。
- [x] AC3 台账归因读数（机械、可被任何人复现）：用 `python3`/`jq` 读 `.quay/gate-events.jsonl`，打印 AC-153 的 `gate=goal` 读数总条数、尾巴的 `verdict` 序列（应为 14×`pass` 后接 2×`fail`），逐字给出那两条 `fail` 的 `payload.reason` 并指出其中含 `Unknown system error -122`、失败点是 `mkdtemp`；再打印同窗（`2026-09-27T21:04:31.986Z`–`21:05:56.704Z`）内同因 `fail` 的 AC 名单与条数（应为 12 条 / 7 条 AC）。
- [x] AC4 尾巴重建或如实登记：重跑之后若 AC-153 的 `gate=goal` 读数里出现新的 `verdict=pass`，逐字抄它；若 driver 的独立复核尚未发生，完成记录里必须逐字写明「台账尾巴仍是 fail」并附 AC1 的直跑读数，⛔ 不得把它写成已通过，⛔ 不得用组件层 jsdom 的绿替代浏览器层的绿。
- [x] AC5 空 delta：`git diff --name-only develop..HEAD` 为空（本条只写 `tasks/gap-ac153-ledger-red-is-host-quota.md`），且收尾时 `git status --porcelain` 与本任务启动时逐字相同（无变异副本、无临时工装残留）。
- [x] AC6 根因如实登记且**不在本条内修**：写明 `~/.cache/quay-e2e-tmp` 没有回收者导致配额耗尽，给出实测规模（目录数与占用）；同时声明本条**未**改 `scripts/e2e-data-dir-selection.mjs`、`playwright.config.ts`、`e2e/**`、`src/**`，并指明该根因的修复属于另一条任务。

## DoD

- 判据本体（真实浏览器 spec，出货命令 `npx playwright test e2e/voice-error-messages.spec.ts`）在干净宿主上被**真的跑过一次**，读数行逐字入档 —— 不是「台账里有 pass」，也不是复述 expect 的文字。
- 承重反假控制（三个变异体）在同一棵树上被真的跑过一次，每条打印「未变异副本先绿 → 变异体在预测族里红一条并写明是哪条 → 族外至少一条仍绿」；这个绿必须是可证伪的绿。
- 归因段落里的每一条读数（errno −122 = `EDQUOT`、失败点在 `mkdtemp`、同窗 12 条 / 7 条 AC）都能由任何人在同一 checkout 上用 `python3`/`jq` 读同一条 jsonl 复现，不依赖本条的转述。
- 交付物只动 `tasks/gap-ac153-ledger-red-is-host-quota.md`：判据文件、实现、宿主配置、宿主缓存一个字节未动。

## Touches

- tasks/gap-ac153-ledger-red-is-host-quota.md
- e2e/voice-error-messages.spec.ts （本条只跑不改：AC1 的判据本体）
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx （本条只跑不改：AC2 的承重反假控制）
## 完成记录

本条是 **verification-only**：只把可复核的读数入档，不改实现、判据、宿主配置、宿主缓存一个字节。判据本体在**本条自己的隔离 worktree** 上被真的跑过一次（不是复述 expect、不是读台账尾巴）。

- worktree：`/data/home/yale/work/claudecodeui-worktrees/gap-ac153-ledger-red-is-host-quota`，分支 `task/gap-ac153-ledger-red-is-host-quota`
- `git rev-parse HEAD`（worktree）= `f9c996a4815413c38e87d1acf0f86c06a831d5db`（起点 = `develop` = `f9c996a4`）

### AC1 判据直跑（`npx playwright test e2e/voice-error-messages.spec.ts`）

跑动时刻 `date -u` = `Sun Sep 27 09:17:25 PM UTC 2026`（= `2026-09-27T21:17:25Z`）；`git rev-parse HEAD` = `f9c996a4815413c38e87d1acf0f86c06a831d5db`。判据自己打印的读数行**逐字**抄录：

```
[e2e] data-dir=/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-QVU3bB free-bytes=3787605217280 min-free-bytes=1073741824 (candidate /data/home/yale/.cache/quay-e2e-tmp)
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
legs=4 passed=4 criterion-wall-ms=24906 watchdog-line=false
  1 passed (24.8s)
EXIT=0
```

AC 点名的每一条读数都在场：`legs=4 passed=4`、`coded=4`、`chinese=4`、`visible-after-4s=true`、`text-unchanged=true`、`closed=true`、`cleared-on-next-recording=true`、`drafts-kept=4/4`、`notices-shown=4/4`、`collapsed-hides-code=true`、`expanded-shows-status=true`、`expanded-shows-upstream=true`、`concat-hits=0`、`equal=true`、`both-equal-vocab=true`、`EXIT=0`。四条腿各自的 code 文案、`visible-first=true`、`expanded-shows-upstream=true`（`status-read=403` / `upstream-read=AccessDenied.Unpurchased`）也在场。

### AC2 反假控制承重（`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx`）

跑动时刻 `date -u` = `Sun Sep 27 09:17:53 PM UTC 2026`。exit 0，`Test Files 1 passed (1)` / `Tests 3 passed (3)` / 1.35s。三例各自逐字打印：

```
mutation=four-second-timer lever=the pre-change timer restored in the failure handler, unmutated copy imported first base-green=true mutant-red=true which=AC4 visible-after-4s outside-family-green=true (AC4 closed-on-close-control) noticed=true
mutation=concat-message lever=the failure handler hands the notice the chain's own concatenated sentence base-green=true mutant-red=true which=AC2 sentence-equals-code-copy + AC6 concat-hits outside-family-green=true (AC4 visible-after-4s) noticed=true
mutation=clear-draft-on-failure lever=the failure handler clears the composer's own input through the channel it is given for it base-green=true mutant-red=true which=AC5 draft-kept outside-family-green=true (AC4 visible-after-4s) noticed=true
[voice-error-mutation] copies-written=3 removed-now=3 leftover-in-tree=[]
```

各自红的是哪条读数（按名字，与本条 AC2 的预测一致）：

- `four-second-timer` → **`AC4 visible-after-4s`**；族外仍绿：`AC4 closed-on-close-control`
- `concat-message` → **`AC2 sentence-equals-code-copy + AC6 concat-hits`**；族外仍绿：`AC4 visible-after-4s`
- `clear-draft-on-failure` → **`AC5 draft-kept`**；族外仍绿：`AC4 visible-after-4s`

⇒ 未变异副本先绿、每个变异体在**预测族里**被指名红一条、族外至少一条仍绿：**可证伪的绿**。三个变异体读的是同一棵出货组件；`leftover-in-tree=[]` 说明变异副本已全部移除（AC5「无变异副本残留」由此佐证）。

### AC3 台账归因读数（机械、任何人可复现）

脚本（在 checkout `/data/home/yale/work/claudecodeui` 上跑；用 `jq` 读同一条 jsonl 等价）：

```
$ python3 - <<'PY'
import json
rows=[]
for line in open('.quay/gate-events.jsonl'):
    line=line.strip()
    if not line: continue
    e=json.loads(line)
    if e.get('gate')=='goal' and e.get('item_id')=='AC-153': rows.append(e)
rows.sort(key=lambda e:e['timestamp'])
print('AC-153 gate=goal total:',len(rows))
tail=rows[-16:]
for e in tail: print(' ',e['timestamp'],e['actor'],e['verdict'],(e.get('payload') or {}).get('reason','')[:60])
for e in [x for x in rows if x['verdict']=='fail'][-2:]:
    print('---',e['timestamp'],e['actor']); print(repr((e.get('payload') or {}).get('reason')))
PY
AC-153 gate=goal total: 1771
  2026-09-27T05:12:53.650Z goal-cli pass acceptance passed (exit 0)
  …（连 14 条 pass）…
  2026-09-27T19:24:07.670Z goal-sweep pass acceptance passed (exit 0)
  2026-09-27T21:04:41.412Z goal-sweep fail acceptance failed (exit 1) — Error: Unknown system error -12
  2026-09-27T21:05:56.704Z goal-cli fail acceptance failed (exit 1) — Error: Unknown system error -12
```

尾巴 `verdict` 序列 = **`14×pass` 后接 `2×fail`**；总条数 **1771**。两条 `fail` 的 `payload.reason` **逐字**：

```
2026-09-27T21:04:41.412Z  goal-sweep
"acceptance failed (exit 1) — Error: Unknown system error -122: Unknown system error -122, mkdtemp '/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-XXXXXX' at mkdtempSync (node:fs:3134:18) at makeTempDir (file:///data/home/yale/work/claudecodeui/scripts/e2e-data-dir-selection.mjs:268:59) at resolveE2eDataDir (file:///data/home/yale/work/claudecodeui/scripts/e2e-data-dir-selection.mjs:294:19) at file:///data/home/yale/work/claudecodeui/playwright.config.ts: … [truncated, 1378 chars of stderr omitted]"

2026-09-27T21:05:56.704Z  goal-cli
"acceptance failed (exit 1) — Error: Unknown system error -122: Unknown system error -122, mkdtemp '/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-XXXXXX' at mkdtempSync (node:fs:3134:18) at makeTempDir (file:///data/home/yale/work/claudecodeui/scripts/e2e-data-dir-selection.mjs:268:59) at resolveE2eDataDir (file:///data/home/yale/work/claudecodeui/scripts/e2e-data-dir-selection.mjs:294:19) at file:///data/home/yale/work/claudecodeui/playwright.config.ts: … [truncated, 1378 chars of stderr omitted]"
```

两条都含 **`Unknown system error -122`**，失败点都是 **`mkdtemp`**（`mkdtempSync` → `makeTempDir` → `resolveE2eDataDir`，即判据**启动前**的 data-dir 选择阶段）⇒ **判据本体一次都没开始跑**，谈不上「AC-153 的行为退化了」。

同窗（`2026-09-27T21:04:31.986Z`–`21:05:56.704Z`）内同因（`Unknown system error -122`）`fail`：

```
12 条 / 7 条 AC：AC-173×2, AC-174×2, AC-175×2, AC-151×2, AC-153×2, AC-171×1, AC-172×1
   2026-09-27T21:04:31.986Z goal-cli   AC-173  mkdtemp
   2026-09-27T21:04:32.786Z goal-cli   AC-174  mkdtemp
   2026-09-27T21:04:33.616Z goal-cli   AC-175  mkdtemp
   2026-09-27T21:04:40.864Z goal-sweep AC-151  open node_modules/.vite-temp（同 errno，非 mkdtemp）
   2026-09-27T21:04:41.412Z goal-sweep AC-153  mkdtemp
   2026-09-27T21:05:51.370Z goal-cli   AC-171  mkdtemp
   2026-09-27T21:05:52.172Z goal-cli   AC-172  mkdtemp
   2026-09-27T21:05:52.991Z goal-cli   AC-173  mkdtemp
   2026-09-27T21:05:53.810Z goal-cli   AC-174  mkdtemp
   2026-09-27T21:05:54.631Z goal-cli   AC-175  mkdtemp
   2026-09-27T21:05:55.920Z goal-cli   AC-151  open node_modules/.vite-temp（同 errno，非 mkdtemp）
   2026-09-27T21:05:56.704Z goal-cli   AC-153  mkdtemp
```

按 AC 计：`AC-173×2`、`AC-174×2`、`AC-175×2`、`AC-151×2`、`AC-153×2`、`AC-171×1`、`AC-172×1` —— **12 条 / 7 条 AC**，AC 名单与条数与 Proposal 一致（这 7 条判据互不共享文件，`12 条独立回归`不成立）。补一条逐字读数上的**差异**：AC-151 的两条虽同为 errno −122，失败点是 `open '/data/home/yale/work/claudecodeui/node_modules/.vite-temp/vitest.config.ts.timestamp-*.mjs'`（vitest 配置落盘），**不是** `mkdtemp`；Proposal 的概述把两条都归到 `mkdtemp`，以本段的逐字读数为准。

### AC4 尾巴重建或如实登记

**台账尾巴仍是 fail。** 本条只**直跑判据本体**（AC1），并未经过 `gate=goal` 那条路，所以重跑之后 AC-153 的 `gate=goal` 读数**总条数仍是 1771**，尾巴**仍是**（重读时刻 `date -u` = `Sun Sep 27 09:17:58 PM UTC 2026`）：

```
2026-09-27T21:04:41.412Z  goal-sweep  fail  （errno −122 / mkdtemp）
2026-09-27T21:05:56.704Z  goal-cli    fail  （errno −122 / mkdtemp）
```

**这不是「AC-153 已通过」**：driver 的独立复核（`gate=goal`）尚未发生。可以断言的只有两件事，且分属两层：判据本体在**浏览器层**直跑为绿（AC1 的读数），承重反假控制在**组件层 jsdom**可证伪地绿（AC2 的读数）。⛔ 不拿组件层的绿替代浏览器层的绿；⛔ 不把本条写成已通过。

### AC5 空 delta

```
$ git -C <worktree> diff --name-only develop..HEAD
（空）
$ git -C <worktree> status --porcelain
（空）
```

交付面只写 `tasks/gap-ac153-ledger-red-is-host-quota.md`，且是经 Provider ABI（`task_write`）落库、**不手改 `- [ ]` 字符**；worktree 内无变异副本（`leftover-in-tree=[]`）、无临时工装残留。`git status --porcelain`（主 checkout）与本任务启动时的快照逐字相同。

### AC6 根因如实登记（**不在本条内修**）

根因：`~/.cache/quay-e2e-tmp` **没有回收者**。`scripts/e2e-data-dir-selection.mjs` 只做**选择与创建**（`mkdtemp`），全文没有任何删除/回收/裁剪路径（对该文件 `grep -n "rm\|unlink\|rmdir\|prune\|cleanup\|purge\|sweep"` 只命中一处**注释里的英文单词**，无一处是删除代码）；`package.json` 与 `scripts/` 里也没有任何入口清理它。累积到用户配额上限后 `mkdtemp` 以 errno −122（`EDQUOT`）失败，判据在启动前即死。

实测规模（本条跑动**前**，本地 `2026-09-28 05:17 CST` = UTC `2026-09-27T21:17Z`）：

```
$ ls ~/.cache/quay-e2e-tmp | wc -l   → 572
$ du -sh ~/.cache/quay-e2e-tmp       → 25G
$ df -h /data                        → /dev/vdb 4.0T 567G 3.5T 14%   （容量不紧张 ⇒ EDQUOT 是配额不是容量，df 对它无读数）
其中 4 个目录为空（mkdtemp 成功却写不进任何东西 ⇒ 启动即死，与台账那两条 fail 同形）
```

本条**未改**：`scripts/e2e-data-dir-selection.mjs`、`playwright.config.ts`、`e2e/**`、`src/**`（AC5 的空 delta 即是机械证明）；也未改宿主配置、未删宿主缓存里的任何字节。该根因的修复（给 `~/.cache/quay-e2e-tmp` 一个回收者，或给选择器加 TTL/上限）属于**另一条任务**，本条只登记、不在这里夹带。

### 判法（可机械复用）

台账上某条 AC 的 `gate=goal` 读 `fail` 时，先读 `payload.reason`：若失败点是**判据启动前**的阶段（`mkdtemp` / `resolveE2eDataDir` / `.vite-temp`）且 errno 是 **−122（Linux `EDQUOT`，用户配额耗尽）**，那是**宿主资源死**，不是判据假 —— 判据本体一次都没跑。鉴别指纹：**同一时间窗内跨多条互不共享文件的 AC 出现同一 errno 的 `fail`**（本节实测 12 条 / 7 条 AC）。`df` 显示不紧张**不能**否证它（配额 ≠ 容量）。
