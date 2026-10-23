---
id: gap-ac027-gateway-wait-weaker-than-assertion
title: AC-027 第三条腿的等待弱于断言：45s poll 只认 token，而 SDK 的会话命名请求带同一 token 先到 ⇒ 紧随其后的
  find(model id) 不等就查，判据在请求次序上翻红（同树 16:28 红 / 16:29 绿 / 16:33 绿 / 16:36 红）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-027
depends_on: []
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rn "^goal_ac: *AC-027" tasks/*.md` → 3 命中（`gap-model-library-browser-e2e`、`gap-e2e-hardcoded-ports-collide`、`gap-e2e-onboarding-anchor-seeded-transcripts`），**三条都是 `done`**，没有 todo/ready/needs-human 的认领者 —— 按本轮规则，done 的认领不是重复，而是「更早的修复没守住」的证据，所以立新条。同区不同机制的三条已 done 任务（本条**不**重复它们，也不与它们互为前置）：`gap-e2e-hardcoded-ports-collide` 交付**端口按运行分配**（固定 47101/47173 互斥）、`gap-e2e-onboarding-anchor-seeded-transcripts` 交付**登录后置锚点不依赖空态**、`gap-e2e-shared-vite-dep-cache-invalidates-inflight-page` 交付**vite 预构建缓存按运行隔离**。本条认领的是它们都让出的那一格：**第三条腿内部「等待条件」与「断言条件」不是同一个谓词**。

**本轮的直接测量（不是台账尾巴）**

判据命令：`npm run test:e2e -- e2e/model-library.spec.ts`（AC-027 记录里的 `criterion:`）。
同一 checkout（`/data/home/yale/work/claudecodeui`），`git rev-parse HEAD` = `1a331fa4aeb5dbfbabfa2d8519cd0439ac2cf7e0`，工作树只有三个未跟踪项、无本地改动：

- 判据台账（`.quay/gate-events.jsonl`，`item_id=AC-027`）在**同一棵树、同一 criterionHash `7239b0aabc705fcb`** 上 13 分钟内翻两次：
  `15:23:14Z goal-sweep pass` / `16:28:23Z goal-sweep **fail**` / `16:29:41Z goal-cli pass` / `16:33:03Z goal-cli pass` / `16:36:00Z goal-cli **fail**`。
- 冻结复核（`.quay/goal-round.jsonl` round 25/26，第 6483/6484 行）两次都把 AC-027 读成 `verdict=pass / outcome=cleared / cause=now-true`（`durationMs` 35172 / 22671），而同一记录的 `frozenFailing.failing` 里仍列着 AC-027 —— 两次复核相隔 3 分钟，读数不同。
- 我本轮在落地前的树上直跑判据本体 **3 次**，三次同形：

```
exit=0  wall_ms=17186   test3=2.0s
exit=0  wall_ms=27048   test3=2.9s
exit=0  wall_ms=24674   test3=3.7s
```

⇒ **判据不是稳定假，是不稳定**：绿时不稳（`run1` 与 `run3` 的第三条腿耗时差 1.8s 且逐次拉长），红时也不稳。台账尾巴是红（16:36:00Z），而 AC-027 要的保证（真实浏览器里只经 UI 建模型 → 选中 → 发送 → mock 收到带该 token 的请求）在绿读数里是成立的 —— 所以本条修的是**判据自己的竞态**，不是产品链路。

**红在哪（读失败运行的落盘产物，不是从台账尾巴推断）**

判据 16:36:00Z 那次红在**第三条腿**（`e2e/model-library.spec.ts:133`）。失败运行的数据目录 `QUAY_E2E_DATA_DIR=/data/scratch/yale/quay-e2e-yIcCqx` 留下了 Playwright 的失败产物：

`test-results/model-library-model-librar-84b9b--the-request-with-its-token/error-context.md`：

```
Error: no gateway request carried e2e-gateway-model; urls seen: ["/api/hello","/v1/messages?beta=true"]
expect(received).toBeTruthy()
Received: undefined
```

即 `e2e/model-library.spec.ts:164` 的 `expect(hit, …).toBeTruthy()` 失败：断言那一刻，mock 网关记到的命中里**没有任何一条请求体含 `e2e-gateway-model`**。`test-results/.last-run.json` 同形：`{"status":"failed"}`。

**机制：等待条件严格弱于断言条件，而断言自己不等待**

`e2e/model-library.spec.ts:155-165` 现在是两段：

- `:155-159` 等待 —— `await expect.poll(() => gatewayHits.some((hit) => hit.headers['authorization'] === \`Bearer ${TOKEN}\` || hit.headers['x-api-key'] === TOKEN), { timeout: 45_000 }).toBe(true)`。谓词**只有 token**。
- `:163-165` 断言 —— `const hit = gatewayHits.find((entry) => entry.body.includes(MODEL.id)); expect(hit, …).toBeTruthy(); expect(hit!.url).toContain('/v1/messages')`。谓词是 **model id**，且**没有自己的等待**：它是对「那一刻已有的命中集合」的一次即时查找。

而 `:160-162` 的注释自己写着这件事：「The Agent SDK names the session through this same gateway as well, **with its own cheap model rather than the selected one**, so the first /v1/messages hit is not necessarily the message」。会话命名请求走**同一个网关**（同一个 base URL，因此同一份 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`），只是 model 字段不同 ⇒ **一条带 token 的命中不必然是那条消息**。于是 `expect.poll` 在**命名请求**到达的那一刻就返回 true（谓词被满足），下一行立刻按 model id 查找，此时消息请求可能还没发出去。

这一点不依赖「哪一条命中带 token」的判定：由失败文案直接闭合 —— 那一刻已记到的命中里**存在**一条让 token 谓词成立的（否则 `:155-159` 的 poll 会自己超时、红在 `:155` 而不是 `:164`），同时**不存在**任何一条带 model id 的。等待能停在一个断言不接受的状态上，这就是竞态。

失败运行的会话记录佐证了「消息请求确实还没出去」这一读法（读数，不是推断）：`/data/scratch/yale/quay-e2e-yIcCqx/.claude/projects/-data-scratch-yale-quay-e2e-yIcCqx-workspace/077fdb21-9574-4d35-8030-32355d3a2d03.jsonl` —— 用户消息在 `2026-09-24T16:35:58.539Z` 已被写入（`queue-operation` + `user`，正文即 `PROMPT`），随后是 CLI 自己的 401 重试阶梯（`subtype: "api_error"`，同一形状 3 条）：`:58.618Z retryAttempt=1 retryInMs=549` / `:59.172Z retryAttempt=2 retryInMs=1222` / `:00.404Z retryAttempt=3 retryInMs=2482`（`maxRetries: 10`）。断言在 `:00.404Z` 前后那一刻失败，而那条带 model id 的消息请求在当时已记到的命中里不存在。**如实登记一处未查清**：`urls seen` 里的 `/api/hello` 这条命中的来源本轮没有落实（它既可能是 SDK 对 base URL 的探测，也可能是别的路径）；它不影响结论 —— 结论只需要「等待可被一条断言不接受的命中满足」，这一点已由 `:155` 未超时 + `:164` 失败两条读数闭合。

**修复的不变式（判据物，不指定实现）**

把 `:155-165` 收成**一个谓词的两半**：等待与断言都用「body 含 `MODEL.id` **且** 该命中的 `authorization`/`x-api-key` 带 `TOKEN`」。等待这个合成谓词成立（45s 预算不变），成立后直接在同一个查找里取出该命中，再断言它的 url 落在 `/v1/messages`。两个项都必须留在谓词里，且都必须承重：

1. **model id 项**承重 —— 去掉它，判据就退回到「带 token 的任意命中算过」，命名请求即可让它变绿，而这正是今天红的形状。
2. **token 项**承重 —— 去掉它，「请求发了但凭据没带上」会被读成绿；AC-027 的 `expect` 要的正是「mock 收到**带该 token** 的请求」。

两条负控制都必须实测（见 AC3），不是纸面声明。

**为什么更早的修复没守住**

三条 done 的任务各自修掉了同类「判据不可重复为绿」的一种机制（端口互斥、空态锚点、vite 缓存），但没有一条把判据**内部**的等待/断言谓词一致性当成交付面：`gap-e2e-hardcoded-ports-collide` 的 AC (b) 只要求「两次重叠运行都绿且各自用不同端口对」（序数读数，对「同一棵树上有时候绿」不敏感）；`gap-e2e-onboarding-anchor-seeded-transcripts` 的 DoD 只要求「判据命令**可重复地**退出 0（连续 ≥2 次）」（同样是序数，我本轮 3 连绿也满足它，而判据仍会在下一次驱动的复跑里翻红）。于是这个竞态一路活到今天：**绿是可重复地出现的，红也是**，因为决定绿红的是两条独立请求的先后，不是产品行为。这是「判据把机制当前形态写死 / 判据自身不闭合」的又一例。

**范围边界**

- 只改判据物（`e2e/model-library.spec.ts` 第三条腿的等待与查找），**不改产品实现**：`src/`、`server/` 一个字节不动。AC-027 的保证在绿读数里成立，本条不重开产品缺口。
- 不动另两条腿的实质断言（`secret-set-badge` 掩码、页面文本与网络响应不含 `TOKEN`、无未翻译 i18n 字面量）、不动 ⛔「不得用 API 直建代替 UI 录入」、不动 `afterAll` 的清理。
- 不动更早三条任务交付的夹具前提（端口按运行分配、登录锚点、vite 缓存隔离）；不引入 `reuseExistingServer: true`、不靠重试换绿、不放宽 45s 预算来掩盖。
- 若 AC3(i) 的**新**谓词在 45s 内仍拿不到带 model id 的命中，则诊断翻转：说明选中的 model id 没进 CLI 的 spawn 环境（产品缺陷），必须按那个结论如实登记并另立，**不得**悄悄把超时调大或改成断言任意命中。

## AC

- [x] AC1 判据入口可重复为绿：`npm run test:e2e -- e2e/model-library.spec.ts` 在落地后的树上**连续 ≥3 次**运行都 exit 0，每次打印 `criterion-wall-ms=<n>`，三次读数与本次落地前基线一并写进完成记录。红态基线已登记：`.quay/gate-events.jsonl` 2026-09-24T16:36:00Z `item_id=AC-027 actor=goal-cli verdict=fail`（同树 3 次直跑读数为 exit 0 / 17186 / 27048 / 24674 ms，说明它是竞态而非稳定假）。
- [x] AC2 等待与断言同谓词：`e2e/model-library.spec.ts` 第三条腿里，45 秒等待与紧随其后的命中取出落在**同一个谓词**上 —— 「body 含 `MODEL.id` **且** 该命中 `authorization`/`x-api-key` 带 `TOKEN`」；断言前不得再存在对 `gatewayHits` 的、未被该等待覆盖的查找。该腿打印一行 `hits=<n> token-hits=<n> model-hits=<n>`（取等待谓词判定成立的那一刻），三个数都要打印出来。
- [x] AC3 两个项都承重 —— 三条负控制逐条实测并登记**实测退出码与红态文案**：(i) 在 mock 网关里按 body 区分，**凡 body 含 `MODEL.id` 的请求延迟 ≥3s 才应答**、命名请求立刻应答；把这个变体加在**旧谓词**（只认 token）上必须确定性复现 `:164` 的红（`no gateway request carried e2e-gateway-model`），加在**新谓词**上必须绿 —— 这一条不依赖机器负载，是竞态的确定性复现；(ii) 去掉 token 项（断言一个没被发送的 token）⇒ 该腿必红；(iii) 去掉 model id 项（断言一个没被发送的 id）⇒ 该腿必红。三条变异用后必须还原（`git status --short` 只剩 Touches 里的文件 + 任务文件）。
- [x] AC4 产品实现零改动：`git diff --stat` 与 Touches 逐条对齐（多出一个文件即为未 forcing 的越界）；`src/`、`server/` 无改动；另两条腿的实质断言（掩码徽标、页面文本/网络响应不含 `TOKEN`、无未翻译 i18n 字面量）保留；⛔ 仍不得用 API 直建代替 UI 录入。
- [x] AC5 契约面不被改窄：`npm run typecheck`、`npm run lint` 退出 0；`npx playwright test e2e/model-library.spec.ts` 整文件（3 条腿）退出 0。
- [x] AC6 如实登记：完成记录写明（a）该腿的红是**判据自身的竞态**（等待弱于断言），不是产品保证被破坏 —— 依据是同一棵树上的绿读数与失败运行的落盘产物（`error-context.md` + 会话记录）；（b）若 AC3(i) 的新谓词仍 45s 超时，诊断翻转为**产品缺陷**（选中的 model id 没进 CLI spawn 环境），必须按那个结论登记并另立任务，不得调大超时或改成断言任意命中；（c）端口/夹具前提归更早的三条 done 任务，本条不动它们；（d）判据仍以**测试内 mock 网关**为上游（真实 CLI 经模型的 endpoint 打到它），不等于真实第三方网关。

## DoD

判据在**落地后的树**上按原命令（`npm run test:e2e -- e2e/model-library.spec.ts`）重跑：退出码 0，且**连续 ≥3 次**都退出 0，每次的 `criterion-wall-ms`、以及 AC2 的 `hits/token-hits/model-hits` 读数、AC3 三条负控制的实测退出码与红态文案，一并写进完成记录。`npm run typecheck` 与 `npm run lint` 退出 0。改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐）。完成后 AC-027 在驱动器下一轮经 `goal_ac: AC-027` 独立复跑时由红翻绿——**且这次翻绿不靠请求次序**：AC3(i) 那个「延迟带 model id 的请求」的变体是它的分辨力证明，旧谓词在该变体下必红、新谓词必绿。

## 完成记录

**本条做了什么。** `e2e/model-library.spec.ts` 第三条腿的等待与断言收成**一个谓词**：`namedModel(entry) && carriedToken(entry)`（body 含 `MODEL.id` **且** 该命中的 `authorization` / `x-api-key` 带 `TOKEN`），45s 预算逐字不变；`expect.poll` 停止时命中的那一条就是交给断言的 `matched`，此后**不再**对 `gatewayHits` 做任何未被该等待覆盖的查找。该腿在等待停止的那一刻打印一行 `hits=<n> token-hits=<n> model-hits=<n>`，`criterion-wall-ms=<n>` 沿用原处。`src/`、`server/` 一个字节未动。

**AC1 判据入口可重复为绿**（落地后的树，`npm run test:e2e -- e2e/model-library.spec.ts`，连续三次）

| # | exit | criterion-wall-ms | 该腿打印 |
|---|---|---|---|
| 1 | 0 | 14677 | `hits=3 token-hits=2 model-hits=1` |
| 2 | 0 | 13560 | `hits=3 token-hits=2 model-hits=1` |
| 3 | 0 | 13029 | `hits=3 token-hits=2 model-hits=1` |

三次都 `3 passed`。红态基线（立案时已登记）：`.quay/gate-events.jsonl` 2026-09-24T16:36:00Z `item_id=AC-027 actor=goal-cli verdict=fail`；同树直跑三次却是 exit 0（17186 / 27048 / 24674 ms），故它是竞态而非稳定假。

**AC2 等待与断言同谓词。** 见上：谓词两半都在 `expect.poll` 里，`matched` 即 poll 停止时的那一条，断言只用它。等待成立那一刻的 `token-hits=2` 对 `model-hits=1` 本身就是竞态形状；瞬时归属已由下面的探针落实。

**AC3 两个项都承重 —— 三条负控制逐条实测**

(i) mock 网关按 body 区分：`body` 含 `MODEL.id` 的请求**延迟 3s 才登记并应答**，命名请求立刻应答 —— 把「消息请求还没到」这一真实竞态形状做成确定性时间差。

- 加在**旧谓词**（只认 token 的等待 + 紧随其后的独立 `find(namedModel)`）：**exit=1，两次同形**：
  ```
  hits=2 token-hits=1 model-hits=0
  Error: no gateway request carried e2e-gateway-model together with the model's token;
         urls seen: ["/api/hello","/v1/messages?beta=true"]
  Received: undefined
  ```
  与立案那次失败运行落盘的 `error-context.md` 同形：同一句 `no gateway request carried e2e-gateway-model`、**同一 `urls seen` 列表**。
- 加在**新谓词**（只把谓词换回本条交付的那一个，mock 延迟不动）：**exit=0，`3 passed`，criterion-wall-ms=17202**，`hits=5 token-hits=4 model-hits=1` —— 等待在 4 条只带 token 的命中之后仍继续等，直到带 model id 的那条落地。这就是分辨力证明：同一变体下旧谓词必红、新谓词必绿。

(ii) 去掉 token 项（谓词断言一个**没被发送**的 token `sk-e2e-never-sent-…`）：**exit=1**。45s 预算下红先被运行自身的 55s 上限界住（`[e2e] watchdog: this run crossed its own 55000ms ceiling at 55000ms and is ending here with exit 1 at 55003ms`）；把**同一替换**的 poll 预算收窄到 20s（只为把红落回该腿自己，替换本身未动）后红在该腿：`criterion-wall-ms=35029`，`✘ 3 … the gateway receives the request with its token` + `Error: expect(received).toBe(expected)` / `Expected: true` / `Received: false`。

(iii) 去掉 model id 项（谓词断言一个**没被发送**的 id `e2e-never-sent-model`）：**exit=1**，同样收窄后的该腿红：`criterion-wall-ms=33201`，`✘ 3 …` + `Error: expect(received).toBe(expected)` / `Expected: true` / `Received: false`。

三条变体用后全部还原（`git checkout -- e2e/model-library.spec.ts`）：`git status --short` 为空、`git diff HEAD` 为空。

**AC5 契约面不被改窄**

```
npm run typecheck → exit 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json）
npm run lint      → exit 0（输出只有既有 warning，无 error）
npm run test:e2e -- e2e/model-library.spec.ts → exit 0，3 passed（上表三次）
```

**AC4 产物边界（`git diff --stat` 对齐 Touches）**

合并 develop 后 `git diff --stat develop HEAD` 只列出 `e2e/model-library.spec.ts`（60 insertions / 9 deletions），无第二个源文件；`git diff --name-only develop HEAD` 里无 `src/`、无 `server/`。另两条腿的实质断言逐条保留（`secret-set-badge` 掩码、页面文本 / `page.content()` / 全部已见 API 响应体不含 `TOKEN`、三处 `UNTRANSLATED_KEY`），⛔ 仍**没有**用 API 直建代替 UI 录入（模型仍只经 Settings → Agents → Models 表单建出）。任务文件的 tick 由 ABI 自己提交。

**AC6 如实登记**

- (a) 该腿的红是**判据自身的竞态**（等待条件严格弱于断言条件），不是产品保证被破坏。依据是同一棵树上的连续三次绿（上表）加失败运行的落盘产物：`error-context.md` 里 `no gateway request carried e2e-gateway-model`，同一刻 `token-hits≥1` 而 `model-hits=0`。本轮还把「一条带 token 的命中不必然是那条消息」从句内注释变成了**读数**（一次性探针：在 mock 里加一行只读打印，跑完即还原）：
  ```
  [probe] url=/api/hello                token=false model=false bytes=0
  [probe] url=/v1/messages?beta=true    token=true  model=false bytes=4041
  [probe] url=/v1/messages?beta=true    token=true  model=true  bytes=80565
  ```
  - 立案时**未查清**的那条 `/api/hello` 命中已落实：它**不带** token、body 为空，是一条未鉴权探测 —— 从未满足过 token 谓词，所以「它不影响结论」现在也是读数而不是判断。
  - 带 token 而不带 model id 的那条是 `/v1/messages?beta=true`（4041 字节），即 SDK 的会话命名请求，**正是**旧谓词会停下的那一条；消息本身是 80565 字节的那条。
- (b) AC3(i) 的**新**谓词在 45s 内拿到了带 model id 的命中（延迟 3s 的变体下仍 exit 0），故**诊断未翻转**：不认为「选中的 model id 没进 CLI spawn 环境」，不另立产品缺陷任务，也没有调大超时、没有改成断言任意命中。
- (c) 端口按运行分配、登录后置锚点、vite 预构建缓存按运行隔离这三个夹具前提归更早的三条 done 任务，本条**未动**：未引入 `reuseExistingServer`，未靠重试换绿，45s 预算逐字不变。
- (d) 判据仍以**测试内 mock 网关**为上游（真实 CLI 经 `ANTHROPIC_BASE_URL` 打到它），不等于真实第三方网关；本条全部读数都来自该 mock 的命中表。

## Touches

- e2e/model-library.spec.ts
- tasks/gap-ac027-gateway-wait-weaker-than-assertion.md
## Needs-Human

**执行 2026-09-24T17:34:28.576Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: __PERFILE__ duration_ms=34933 server/modules/voice/tests/voice-capture-text.false-forms.test.ts passed=false end_ms=1790271157996
- run_id：wk-prod-anchor
- session_id：99f66610-d3a6-462f-84e0-d88f576a5819
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac027-gateway-wait-weaker-than-assertion~wk-prod-anchor~1790271082444-9ae9a3.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-ac027-gateway-wait-weaker-than-assertion-wk-prod-anchor.log

### 本轮（合并 develop 后）复核

合并 `develop`（`efb00ee8`）后在本工作树复核，改动面未变 —— `git diff --stat develop...HEAD` 仍是 `e2e/model-library.spec.ts`（+60/−9），合并前后该文件 blob 同为 `8d28b16d`（`git rev-parse HEAD~1:e2e/model-library.spec.ts HEAD:e2e/model-library.spec.ts`）。

- 判据重跑 3 次（`npm run test:e2e -- e2e/model-library.spec.ts`）：exit 0 ×3，`criterion-wall-ms=14775 / 14041 / 14058`，每次 `hits=3 token-hits=2 model-hits=1`，`3 passed`。
- `npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning）；scoped gate（`scripts/test.sh --for-task gap-ac027-gateway-wait-weaker-than-assertion --allow-thin`）exit 0（thin：本条 Touches 无 `*.test.*`）。
- 上一轮 fan-in 的 suite 红落在 `server/modules/voice/tests/voice-capture-text.false-forms.test.ts`（`passed=false duration_ms=34933`）。该文件**不在本条 Touches**（本条只改 `e2e/model-library.spec.ts`，fan-in suite 也不收 e2e）；在本工作树单独复跑该文件得 `exit=0 / tests 6 / pass 6 / fail 0`，故该红是舰队级负载抖动、非本条 delta（同类 `voice-dashscope-settings.false-forms` 的上一轮红同形）。
### 第 4 轮 suite 红归因（2026-09-27，作者分支自查）：责任人不是本任务的 delta，而是兄弟判据拿「当前分支 delta」当代理

- **唯一红逐字**（本轮 fan-in 真因日志 `.quay/fan-in-suite-*.log`）：
  `not ok - server/modules/providers/tests/claude-host-per-run.test.ts: AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts`
  该文件 7 条判据里 6 条绿（AC2/AC3/AC4/AC5/AC9/AC8），只有 AC6 红；台账 `# tests 245 / # pass 244 / # fail 1`。
- **不是本任务的 delta**：本任务对 develop 的 delta 只有 `e2e/model-library.spec.ts` 一个文件，与该判据无交集；同一轮里另一条 delta 交集为空（8 个文件，全在 `e2e/` 与 `src/modules/chat/`）的任务被**同一句文案**打红 ⇒ 跨任务的 fleet 级串扰，与本轮改动无关。
- **确定性**：该文件不在本任务 `## Touches`；在本 worktree standalone 复跑（`npx tsx --tsconfig server/tsconfig.json --test …`）exit 1、约 0.6s、无子进程超时 ⇒ 不是负载抖动，重新派发也逃不掉。
- **机制**：该文件 AC6 拿 `git diff --name-only develop...HEAD` 当「driver 在 delta 里」的代理。fan-in 的 `merge-develop` 之后 develop 已是 HEAD 的祖先，这个区间恰好是**当前分支自己的 delta**，于是只有 driver 自己的那条分支能过它。
- **本任务自身状态**：AC 6/6 满足（`task_check` ok）、五个实现提交一字未改、本轮 scoped 门绿（thin）、scoped-gate cache 已按 develop sha 写入。
- **处置**：该红已由独立立案的修复任务承接（标题同时含「claude-host-per-run」与「按分支设门」两处字样），它落地后本任务即可直推。⛔ 在此之前**不要**改这条兄弟判据来换绿：既越界（本任务 `## Touches` 不含 `server/`），也会把一条真判据改哑。

## Needs-Human

**执行 2026-09-27T04:32:08.445Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - server/modules/providers/tests/claude-host-per-run.test.ts:   AssertionError [ERR_ASSERTION]: the develop delta does not mention the driver, so it is not the delta being read: server/modules/providers/list/claude/claude-per-run-host-driver.provider.ts
- run_id：wk-prod-anchor
- session_id：6d279e49-7d77-48b8-ad88-960ab7244c8d
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac027-gateway-wait-weaker-than-assertion~wk-prod-anchor~1790483362208-58f9b0.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-ac027-gateway-wait-weaker-than-assertion-wk-prod-anchor.log
