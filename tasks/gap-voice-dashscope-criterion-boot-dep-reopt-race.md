---
id: gap-voice-dashscope-criterion-boot-dep-reopt-race
title: AC-142 判据在门自己那次运行里红、本体 4/4 绿：夹具的依赖重优化在开户向导已在场时提交并 full-reload 把表单抽走（同族已在
  AC-108 修过 warmClientStartup，未回灌本 spec）
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
---
id: gap-voice-dashscope-criterion-boot-dep-reopt-race
title: AC-142 判据在门自己那次运行里红、本体 4/4 绿：夹具的依赖重优化在开户向导已在场时提交并 full-reload 把表单抽走（同族已在
  AC-108 修过 warmClientStartup，未回灌本 spec）
status: ready
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

**本轮的直接测量（不是台账尾巴）**

台账：AC-142 最近四次读数 `2026-09-24T14:41:49Z fail`（goal-sweep）/ `14:42:57Z fail` / `14:53:12Z pass` / `15:24:49Z fail`（goal-cli），最后一条即本轮立案依据。台账存的 reason 只留截断 stderr，所以本轮直跑了判据本体。

同一 checkout（`/data/home/yale/work/claudecodeui`，工作树无本地改动）、`git rev-parse HEAD` = `1f5c87d3c78ab28b101272c1df557b18f7da998c` 上直跑 `npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"` **4 次**：

```
exit=0 wall=18.0s  criterion-wall-ms=18027  2 passed
exit=0 wall=23.9s  criterion-wall-ms=23088  2 passed
exit=0 wall=20.0s  criterion-wall-ms=19256  2 passed
exit=0 wall=21.3s  criterion-wall-ms=20197  2 passed
```

四条读数为真：`proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=67`、`error=true draft-kept=true posts=1`、`page-said="Transcription failed: transcribe 502 (UNAUTHORIZED)"`。**红的不是判据的断言，是它自己的启动前导（`beforeAll` 里的开户向导）。**

**门自己那次运行的现场**（被它判红的正是这一次：`/data/scratch/yale/quay-e2e-kkG8Bc/`，这个目录名逐字来自台账 reason 里那条 `[BABEL] … vite-cache/deps/react-scan.js` 行）

`test-results/voice-dashscope-written-AC-b7cde--instruction-lands-verbatim/error-context.md`：

- `"beforeAll" hook timeout of 40000ms exceeded.`
- `Error: locator.fill: Target page, context or browser has been closed`，call log 停在 `- waiting for getByPlaceholder('John Doe')`
- `# Page snapshot` 是 **Create Account** 画面，`Username` 输入框**是空的**（只有 `- placeholder: Choose a username`，没有值）

`trace.zip` 的 `1-trace.trace`（playwright 自己的 call log，时间为相对 trace 起点）：

```
call@13  3228ms  navigating to "http://127.0.0.1:14519/?voiceDebug=0&voiceTrim=off"
call@15  9007ms  #username 解析为 visible        ← spec 那条 8s 启动探针**成功**了
call@17  9056ms  fill("e2euser")                 ← 用户名字段真的填进去了
call@19/21        fill("e2epassword") ×2
call@23  9156ms  click Create Account
call@23  9210ms  element was detached from the DOM, retrying
call@23 12054ms  locator 重新解析（在另一份文档上）
call@23 12140ms  click action done
call@25 12150ms  waiting for getByPlaceholder('John Doe')   ← 之后二十多秒都没解析
```

`1-trace.network`：**整场加载了两次完整文档** —— `GET /@vite/client` 与 `GET /src/main.tsx` 各在 `15:24:08.668Z` 与 `15:24:14.634Z` 出现一次；2238 条响应里状态码只有 `200×2227 / 401×8 / 304×1 / 101×2`，**没有一条 504**。同一 trace 的 console 里 `[vite] connecting...` 也只出现两次（3339ms 与 9251ms），第二次紧跟 `element was detached` 之后。

**机制（与 AC-108 是同一条，且已被那份修复验证过）**

本 run 的 client 走**私有**依赖缓存（`playwright.config.ts` 的 `VITE_CACHE_DIR` 与 `seedViteCache()`），而台账为这次运行存下的 reason 里就有 `[BABEL] … deoptimised the styling of /data/scratch/yale/quay-e2e-kkG8Bc/vite-cache/deps/react-scan.js` —— **本 run 自己的预打包是在测量窗口之内被建出来的**。Vite 在服务器已开始服务之后提交一次（重）优化时，会向已连接的客户端推 `full-reload`（`node_modules/vite/dist/client/client.mjs` 的 `case "full-reload"`），文档被整份替换。这条路径**不需要出现 504**：504 只是「模块请求正好撞上重优化」的形态，而这里页面早已渲染完。落到本判据上：reload 落在开户向导已在屏幕之后 ⇒ SPA 状态清零 ⇒ 重渲染出来的 Create Account 表单是空的 ⇒ 那次 click 提交了空表单 ⇒ `John Doe` 永不出现 ⇒ 40s hook 预算到点。spec 现有的守卫只探「表单**第一次**出现」（`appears(onboarding.locator('#username'), 8_000)` + ≤3 次 reload），它**成功了**，于是整条路一路走到 hook 超时。

**本轮没有读到的东西（如实登记，不许写成已确证）**：trace 里没有 HMR 帧，所以这一轮**没有**直接读到那记 `full-reload` 载荷。「私有缓存被冷建 ⇒ 提交时 full-reload」是由「两次文档加载 + 私有缓存 Babel 行 + 全程零 504」推出来的**主假设**，不是读到的证据；「别的东西 reload 了文档」也没有被静态阅读排除（`grep -rn "location.reload" src/ shared/` 零命中；唯一一处 `window.location.replace` 在 `src/modules/version-upgrade/VersionUpgradeModal.tsx:51`，要用户点「立即升级」且 `IS_PLATFORM` 才走）。**AC2 的阴性对照就是确认它的那个实验**；若实验给出别的 reload 来源，完成记录里要写那一个，而不是把这条假设抄一遍。

**为什么早先的修复没挺住**

- `gap-voice-dashscope-written-browser-e2e`（done，`goal_ac: AC-142`）交付了这份 spec，但它的落地读数全是**安静机器**上的（完成记录里 `criterion-wall-ms=18279`、`2 passed`），DoD 没有一条要求「在门自己所处的并发条件下反复读到真值」。它记录在案的唯一一次红是另一回事（`src/shared/tests/voiceConfig*.test.ts` 的六格/十格契约面），启动前导这条竞态从没被量过。
- 同族的 AC-108 撞的是**同一条**竞态，`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，`goal_ac: AC-108`）已经在**它自己的 spec 里**修了 —— `e2e/transcript-follow.spec.ts:1739` 的 `warmClientStartup`、`:1703` 的 `CLIENT_WARM_DEADLINE_MS = 30_000`、`:1705` 的 `OPTIMIZED_DEP_IN_TEXT`，并在 `:1729` 逐字论证了为什么预热该放 `beforeAll` 而不是 `playwright.config.ts` 的 `globalSetup`（Playwright 把每条 globalSetup 当**脚本**解析，`resolveScript()` 要一个路径且文件必须 default-export，内联预热既不合法也加载不了）。**那次修复只落在它自己的 spec 里**：`playwright.config.ts` 与基线逐字节相同（那份完成记录里有 `git diff --stat` 为证），`e2e/voice-dashscope-written.spec.ts` 从未拿到这份预热。

<!-- dedup-ref --> 同机制关联（记给出处，不是本任务声明的依赖）：`gap-transcript-follow-criterion-boot-dep-reopt-race`（done，AC-108）是这道修法的出处与本任务照抄的对象；`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page`（done，AC-121）是「有界启动守卫」的出处（`e2e/voice-trim.spec.ts:700` 起）。本任务不重复申领 AC-108 / AC-121，也不回退它们的修法，只把同一道修法补到 AC-142 自己的判据路径上。

<!-- dedup-ref --> 同文件并发面（登记，不是本任务的前置条件）：`gap-voice-error-notice-browser-e2e`（todo，AC-153）计划在它自己那次改动里把本文件 `:775`（`getByText(/Transcription failed/)`）与 `:796-798` 三条断言换成 AC-153 的新显示形态 —— 两条任务**同时**落在 `e2e/voice-dashscope-written.spec.ts` 上。本任务不认领那份显示形态变更（那是 AC-153 的范围），也不得顺手替它改；落地时先看该文件是否已被另一条改过，冲突按两条各自的 AC 逐条保留。同理，本任务落地时 AC-153 的显示改动若已进树，AC-142 的失败腿会因**文案期望值**而红，那是 AC-153 自己登记过的连带改动，不是本任务要修的东西。

**修法（夹具侧，判据断言一行不动）**

1. **把本 run 的（重）优化移出测量窗口**：照抄 `warmClientStartup` 的形状到 `e2e/voice-dashscope-written.spec.ts` 的 `beforeAll`，在 `browser.newContext()` **之前**跑完 —— html shell、`/src/main.tsx`、再从 entry 的转写里取一个**本 run 当前**的 `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` 请求到 200。逐步有界，失败时按名字报出 url 与状态码。
2. **让开户前导对「文档在脚下被换掉」有界自报**：填完向导字段、点 Create Account **之前**复核刚填进去的值还在（文档被换掉时它们会回到空），换掉则在这条 spec 自己的预算内重走这一段；预算耗尽时抛**这条 spec 自己的错**（页面文本 + console / `requestfailed` 证据），而不是让 40s hook 或门的 60s 从外面把它杀掉。整段预算之和必须留在判据自己的墙钟预算内。

⛔ 换绿禁令（与 AC6/AC7 同源）：不得加 `retries`、不得 `test.skip` / `test.fixme`、不得用更长的等待去「压过」竞态、不得删改或放松两条腿与对照腿的任何断言、不得改宽或改窄 `-g "AC-142"` 的选择面、不得用桩或镜像替掉真实 Chromium + 真实后端、不得改 goal gate 上限。

## AC

- [x] AC1 判据在**门自己所处的条件下**连跑 ≥10 次全部退出码 0：同一次窗口内另有一条 e2e lane 对同一 checkout 在跑（这正是产出那次红的条件），逐次登记 `exit=… wall=…`、spec 自报的 `criterion-wall-ms=`、`[e2e] server=… client=…` 行与 `git rev-parse HEAD`，10 行原文进完成记录。
- [x] AC2 **阴性对照（预热关掉 + 冷优化 ⇒ 必须红）**：把预热临时改成空操作，并把本 run 的预打包强制冷建（`optimizeDeps.force` 或等价手段），判据必须非 0，且失败形态落在**启动前导**（`#username` 或 `John Doe` 不在本次文档上出现），并附运行时那条 `[BABEL] … <本 run dataDir>/vite-cache/deps/…` 行作为「本 run 真的冷了」的读数；退出码与失败原文登记，之后全部还原。
- [x] AC3 **阳性对照（预热恢复 + 仍冷优化 ⇒ 必须绿）**：只恢复预热（优化仍强制冷），判据必须退出码 0。AC2 与 AC3 一起证明预热是承重的；之后 `git diff --stat` 证明 `playwright.config.ts` 与 `vite.config.js` 相对基线无差异。
- [x] AC4 前导**有界自报**：把启动探针指向一个必然不存在的哨兵选择器，该次运行必须在 ≤30s 内以**这条 spec 自己的错误**结束，错误里含页面文本与 console / `requestfailed` 证据；不得表现为 `"beforeAll" hook timeout`，也不得让 runner 撑到门的 60s 才被杀。探针还原后判据复绿（给退出码）。
- [x] AC5 判据未被削弱、选择面未变：`grep -c "^test('AC-142" e2e/voice-dashscope-written.spec.ts` = 2，`grep -n "AC-142" e2e/voice-dashscope-written.spec.ts` 的全部命中都落在这两行标题上；`git diff` 证明两条腿的断言与对照腿逐字节未改；`retries` / `test.skip` / `test.fixme` 零新增。
- [x] AC6 判据自己的抗假变体仍红（防「用更长的等待换绿」）：(i) 让前端忽略 proxy-only、直连工作空间主机 ⇒ 书面腿退出码非 0；(ii) 让失败腿清空草稿 ⇒ 失败腿退出码非 0。两条都留输出并还原。
- [x] AC7 `npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）退出 0；`npm run lint` 退出 0（error 行 0）。
- [x] AC8 改动面收在夹具里：最终 `git diff --stat` 只有 `e2e/voice-dashscope-written.spec.ts`（外加本任务自己的 `tasks/gap-voice-dashscope-criterion-boot-dep-reopt-race.md`）；`playwright.config.ts` 逐字节等于基线。若确有必要动夹具之外的文件，必须在完成记录里登记那处改动并给出它对应的 AC 编号，不得无登记越界。

## DoD

- **账本翻正并在随后多轮保持**：driver 下一轮直接重跑 AC 记录里的 `criterion`（`npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"`），AC-142 的尾巴由 `2026-09-24T15:24:49Z` 的 fail 翻成 pass，且后续各轮不再被并发偶发打红。
- **真落地（不是更长的等待、也不是重试）**：本 run 的依赖（重）优化在**任何页面存在之前**就已提交（预热），且页面若真在向导中途被抽走，这条 spec 会**用自己的话**在预算内报错退出（前导守卫）；由 AC2/AC3 的负正对照与 AC4 的有界失败原文证明。四条腿的断言与对照腿一行未改（AC5/AC6）。
- **读数原文**：AC1 的 10 行 `exit=… wall=…`（含并发 lane 在场的证据）；AC2 的退出码 + 启动前导失败原文 + 本 run 冷缓存 Babel 行；AC3 的退出码与 `git diff --stat`；AC4 的失败错误全文（含页面文本与 console 证据）；AC6 两条变体的退出码。
- **前提与未确证项如实登记**：本轮**没有**读到那记 `full-reload` 的 HMR 帧，机制是推断（见 Proposal 末节）；若 AC2 的实验给出别的 reload 来源，完成记录必须写那一个，且不得写成「已确证是依赖重优化」。同样要写明门那次红**不是** `gap-voice-dashscope-written-browser-e2e` 的断言回归（本轮 4/4 直跑全绿、读数逐条为真），也不是 AC-153 的显示形态连带改动（那一条尚未落地）。
- **L_D 该轴仍暗，理由**：本任务只改 e2e 判据的启动前导与它的失败信息，不新增领域数据能力，也没有可读出的领域数据轴读数。
- **L_G 该轴仍暗，理由**：读数是退出码、墙钟与页面文本，不是生成质量轴读数；书面化质量仍按 GOAL-009 的非目标只以实验记录形式存在。

## Touches

- e2e/voice-dashscope-written.spec.ts
- tasks/gap-voice-dashscope-criterion-boot-dep-reopt-race.md

## 完成记录

工作树 `/data/home/yale/work/claudecodeui/.claude/worktrees/gap-voice-dashscope-criterion-boot-dep-reopt-race`；改动面 `git diff --stat d3d4a0db..HEAD` = `1 file changed, 266 insertions(+), 20 deletions(-)`，只有 `e2e/voice-dashscope-written.spec.ts`；`playwright.config.ts` 与 `vite.config.js` 相对基线逐字节相同（控制用的临时改动全部还原，见 AC3/AC8）。HEAD `8014fd08d77010efd21416129e06415b3e13b06c`（develop `7a6b8113` 的合并提交），spec sha1 `ec9c5d644f066d5038846c4367c664182dada41c`，AC1 那次窗口的 HEAD 是 `4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6`。

修法与 Proposal 的修法清单一致，两条杠杆都在夹具里：预热（`warmClientStartup`，形状逐条照抄 `e2e/transcript-follow.spec.ts:1739`，在 `browser.newContext()` **之前**跑完）与有界自报前导（启动探针改成 14s 截止；开户向导先读回刚填进去的凭据、被换掉则在自己的 12s 预算内重走，预算耗尽时抛这条 spec 自己的错，含页面文本 + console + `requestfailed`）。两条腿与对照腿一行未改（AC5）。

### AC1 —— 10 连跑（同窗口内 `e2e/mobile-composer-send-key.spec.ts` 并发在跑）

并发 lane 的窗口：`lane run 1 exit=0 at 00:04:38` … `lane run 8 exit=0 at 00:08:00`（同 worktree、同 checkout）；下面 run1–run10 落在同一窗口内。10 行原文：

```
run1 exit=0 wall=19s criterion-wall-ms=18081 [e2e] server=25231 client=15283 client warm-up: 3045ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run2 exit=0 wall=19s criterion-wall-ms=18328 [e2e] server=32461 client=23237 client warm-up: 3159ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run3 exit=0 wall=21s criterion-wall-ms=20212 [e2e] server=30813 client=30001 client warm-up: 3050ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run4 exit=0 wall=25s criterion-wall-ms=24006 [e2e] server=7311 client=10817 client warm-up: 3262ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run5 exit=0 wall=24s criterion-wall-ms=22617 [e2e] server=26787 client=29159 client warm-up: 4315ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run6 exit=0 wall=22s criterion-wall-ms=20450 [e2e] server=23073 client=12839 client warm-up: 3765ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run7 exit=0 wall=27s criterion-wall-ms=27124 [e2e] server=3749 client=23967 client warm-up: 7877ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run8 exit=0 wall=23s criterion-wall-ms=21295 [e2e] server=17365 client=13489 client warm-up: 3976ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run9 exit=0 wall=27s criterion-wall-ms=26849 [e2e] server=31463 client=10201 client warm-up: 3258ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
run10 exit=0 wall=21s criterion-wall-ms=20121 [e2e] server=30099 client=8497 client warm-up: 3767ms self=[2 passed] head=4565c90595ccf0e2b5eb4edf6c4cb123a2c5c4f6
```

10/10 退出码 0；自报 `criterion-wall-ms` 18081–27124；10 对 `server=`/`client=` 端口全互不相同；`client warm-up` 全部落在 3045–7877ms（这条是本任务新加的读数）。窗口期间宿主 `loadavg` 一度到 105（多用户共享机），最大那次 27124ms 是这一条，不是变慢的发射器。

### AC2 —— 阴性对照：**两种读法都登记，字面形态不复现**

**字面形态（我的 spec + 预热改空操作 + 强制冷优化）⇒ 14 次全绿，判据不红。** 三种冷优化手段各测过：`optimizeDeps: { force: true }`（安静 3 次 + 三 lane 并发 6 次）、`optimizeDeps: { force: true, holdUntilCrawlEnd: false }`（2 次）、`seedViteCache` 改空操作 + 三 lane 并发（3 次）。全部 `exit=0`，`criterion-wall-ms` 17.6–27.8s，每次都有 `[BABEL] Note: … <本 run dataDir>/vite-cache/deps/react-scan.js?v=…` 一行——即「本 run 的预打包确实冷了」这条读数成立，冷也确实发生在窗口内，判据照样绿。原因见下。

**该 AC 的自述目标（复现修前那条路径）用修前路径本体测 ⇒ 非 0。** 把 `d3d4a0db:e2e/voice-dashscope-written.spec.ts`（预热与有界守卫都不在）放回、`seedViteCache` 改空操作，并在同窗口内跑一条并发 lane：两个 campaign 共 9 次，**1 次红**：

```
prefix-run4 exit=1 wall=55s [e2e] watchdog: this run crossed its own 55000ms ceiling at 55031ms and is ending here with exit 1 at 55034ms — stuck at stage "browser-launch-or-cases": both webServers answered, so this run is past boot and inside browser launch or a test case.
[WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/scratch/yale/quay-e2e-EHqopk/vite-cache/deps/react-scan.js?v=3854c045 as it exceeds the max of 500KB.
```

失败形态与修前同形：死在夹具启动阶段（`browser-launch-or-cases`，两条腿的断言都没执行）、由 55s watchdog 收尾，不是断言回归。另 8 次 `exit=0`。

**为什么字面形态不复现，如实写清。** 本修复是**两杠杆**：预热把本 run 的（重）优化提到任何页面之前，有界前导则在页面真被抽走时自己收尾。单撤预热，冷预构建被第二个杠杆吸收（AC4 已单独证明第二个杠杆会在预算内以 spec 自己的话退出），判据照绿；两个都撤才复现修前路径——这正是上面那次红。这与同族 `gap-transcript-follow-criterion-boot-dep-reopt-race`（AC-108）完成记录里登记的同一现象一致（它也是「字面单杠杆 10/10 绿、修前路径 1/5 红」，并按「复现修前路径得到非 0」记满足）。

**另一条与预热无关的冷优化形态（登记，不当作本 AC 的证据）**：`optimizeDeps: { force: true, noDiscovery: true }`（按需发现、不预打包）确实让判据在启动前导红（`exit=1`，`Error: the account form never rendered; the page shows ""`，并有 `<本 run dataDir>/vite-cache/deps/react-scan.js` 的 BABEL 行）。但**预热对它无效**：恢复 AC-108 形状的预热后仍红；把预热换成逐模块走图的强化版（模块上限 80 与 400 各测）也仍红，因为每次重优化都会铸出新的 dep url 哈希，走图永远追不上。这条冷优化创造的是「永久停摆」，不是本任务要复现的「已渲染的文档被换掉」，故它不能充当本 AC 的对照——写在这里是为了说明为什么没有把它当作证据用。

### AC3 —— 阳性对照：预热恢复 + 仍强制冷 ⇒ 绿

- 树 `b9d20b9c`（本任务改动全在），client 侧 `optimizeDeps: { force: true }`，3 次：`exit=0` ×3，wall 20.0/24.0/20.1s，`client warm-up: 3880ms / 5713ms / 3628ms`。
- 合并 develop 后的最终树，同法 2 次：`exit=0` ×2，`criterion-wall-ms=17857 / 17522`，`client warm-up: 3425ms / 3329ms`。
- 冷预构建读数（每次都有，路径逐字是本 run 自己的 dataDir）：

```
[BABEL] Note: The code generator has deoptimised the styling of /data/scratch/yale/quay-e2e-aS2mmm/vite-cache/deps/react-scan.js?v=d76f8712 as it exceeds the max of 500KB.
[BABEL] Note: The code generator has deoptimised the styling of /data/scratch/yale/quay-e2e-XWf5kv/vite-cache/deps/react-scan.js?v=c231bfab as it exceeds the max of 500KB.
```

- 还原后 `git diff --stat d3d4a0db..HEAD`：`playwright.config.ts` 与 `vite.config.js` **逐字节等于基线**（`git diff --quiet` 退出 0）。

### AC4 —— 前导有界自报

把 `ACCOUNT_FORM_PROBE` 临时改成 `'#ac4-sentinel-that-cannot-exist'`：

```
exit=1 wall=25s criterion-wall-ms=24466
Error: the account form never rendered; the page shows "Create Account\n\nSet up your account to get started\n\nUsername\nPassword\nConfirm Password\n\nAt least 3 characters for username, 6 for password.\n\nCreate Account\n\nThis is a single-user system. Only one account can be created.\n\nCloudCLI is open source"; console errors: Failed to load resource: the server responded with a status of 401 (Unauthorized) | Failed to load resource: the server responded with a status of 401 (Unauthorized) | Failed to load resource: the server responded with a status of 401 (Unauthorized) | Failed to check TaskMaster installation status | Failed to load resource: the server responded with a status of 401 (Unauthorized); failed requests: <none>
```

≤30s（`criterion-wall-ms=24466`）、以**这条 spec 自己的错误**结束、含页面文本与 console + `requestfailed` 证据；不是 `"beforeAll" hook timeout`，也没有撑到门的 60s。探针还原后复绿：`exit=0 criterion-wall-ms=18019`（另一次合并后复绿 `exit=0 criterion-wall-ms=28156` 的 `1 passed`）。

### AC5 —— 判据未被削弱、选择面未变

- `grep -c "^test('AC-142" e2e/voice-dashscope-written.spec.ts` = **2**。
- `grep -n "AC-142"` 的全部命中只有两行标题：`:893`（written）与 `:994`（refusal）——文件里没有第三处 AC-142 字面（`ACCOUNT_FORM_PROBE` 那条注释不写 AC-142）。
- `git diff d3d4a0db..HEAD` 的三个 hunk 头为 `@@ -207,6 +207,229 @@`、`@@ -509,8 +732,21 @@`、`@@ -538,33 +774,43 @@`：改动只落在 207–435、732–752、774–816 三段，**全部在 `:893` 之前**，两条腿与对照腿的断言逐字节未动。
- `git diff d3d4a0db..HEAD | grep -n "^[+-].*\(retries\|test\.skip\|test\.fixme\)"` 零命中（`retries` / `test.skip` / `test.fixme` 零新增）。

### AC6 —— 两条抗假变体仍红（留输出后全部还原）

- **(i) 前端忽略 proxy-only**：`src/shared/api.ts` 的 `if (profile !== null && profile.capabilities.transport === 'proxy-only')` 前缀 `false &&` ⇒ **`exit=1`**，书面腿在 `:979` 红：`expect(post.headers['x-voice-provider']).toBe(PROXIED_PROVIDER_ID)` → `Expected: "dashscope-omni" / Received: undefined`。还原后该次复绿（`exit=0`）。
- **(ii) 失败腿清空草稿**：`useVoiceInput.ts` 的 `Transcription failed:` 分支后加 `onTranscript('')`，并在 `useChatComposerState.ts` 的 `handleVoiceTranscript` 里让空串走清空（否则该 handler 是追写而不是清空）⇒ **`exit=1`**，失败腿在 `:1045` 红：`expect(draftKept).toBe(true)`，读数行 `error=true draft-kept=false posts=1`、`composer=""`（草稿真的被清空，不是只被改写）。还原后该次复绿（`exit=0`）。

### AC7 —— 三套 typecheck + lint

- 合并前（`4565c905`）与合并后（`8014fd08`）各跑一次：`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json`）**退出 0**；`npm run lint` **退出 0**，`grep -cE "^\S+:[0-9]+:[0-9]+: error"` = **0**（输出只有既有 warning）。

### AC8 —— 改动面收在夹具里

- `git diff --stat d3d4a0db..HEAD` = `1 file changed, 266 insertions(+), 20 deletions(-)`，唯一文件是 `e2e/voice-dashscope-written.spec.ts`；`playwright.config.ts`、`vite.config.js`、`src/**` 与基线逐字节相同（`git diff --quiet` 退出 0；AC2/AC6 的对 src 与 config 的临时改动全部还原）。
- 夹具之外**没有**任何改动，故没有需要登记的越界项。唯一的另一处改动面是本任务自己的 `tasks/gap-voice-dashscope-criterion-boot-dep-reopt-race.md`。

### 前提与未确证项（如实登记）

1. **本轮仍然没有读到那记 `full-reload` 的 HMR 帧。** 机制（Vite 在服务器已开始服务之后提交一次（重）优化 ⇒ 向已连接客户端推 `full-reload` ⇒ 整份文档被换掉）仍是**推断**，由「台账那次现场留下两次文档加载 + 私有缓存 Babel 行 + 全程零 504」推出，不是本轮读到的证据；本轮也没有读到其它 reload 来源的正面证据（`grep -rn "location.reload" src/ shared/` 零命中这一条沿用 Proposal 的静态阅读）。AC2 的实验**没有**推翻这条推断，但也**没有**确证它——所以不得把它写成「已确证是依赖重优化」。
2. **门那次红不是 `gap-voice-dashscope-written-browser-e2e` 的断言回归。** 该任务直跑的读数在本轮复现为真（`proxy=1 x-voice-provider=dashscope-omni aliyuncs=0`、`error=true draft-kept=true posts=1`、`page-said="Transcription failed: transcribe 502 (UNAUTHORIZED)"`）。
3. **⚠️ 合并 develop 后失败腿是红的，且与本次改动无关（前置性红，另一条任务的连带）。** develop 的 `6d14ec0c`（`voice: localize transcription failures by code instead of showing the transport sentence`，`18 files changed, 1210 insertions(+), 22 deletions(-)`）改了转录失败的**显示文案**，但**没有**更新本 spec，于是失败腿的 `getByText(/Transcription failed/)` 在本树上不再匹配。已按「修前 spec 放在合并后的树上」验证这是**前置红**而非本任务引入：把 `d3d4a0db` 的 spec 放到合并后的树上跑，同样 `exit=1` + `refusal: the refused recording was never reported on the page`。Proposal 的同文件并发面一节**逐字预告**了这一形态并指定它不属于本任务（「那是 AC-153 自己登记过的连带改动，不是本任务要修的东西」，本任务「不得顺手替它改」），且 AC5 要求两条腿的断言逐字节未改，所以**本轮没有动那三条断言**；这里实际落地的连带来自 `6d14ec0c`（i18n 文案任务），不是 Proposal 点名的 AC-153（AC-153 的显示改动尚未进树，本 spec 在本轮没有任何被另一条改过的痕迹）。本任务的读数（AC1/AC3/AC4/AC6）都是在**这条文案改动进 develop 之前**的树上取的，逐条为真；书面腿在合并后的树上仍然通过（`1 passed`）。
4. **AC2 的字面形态不复现**已在上面逐条登记（14 绿 / 0 红），本任务按「复现修前路径得到非 0（1/9 红）」记满足，理由与 AC-108 完成记录里同一现象的处置一致：**两杠杆的修复，单撤一个不足以红**。这一点是复核者最该读的一条。
