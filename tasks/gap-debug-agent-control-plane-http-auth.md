---
id: gap-debug-agent-control-plane-http-auth
title: 调试 Agent 的 dev-only 控制面：HTTP + 既有 authenticateToken，门控而非鉴权才是安全边界
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-debug-agent-engine-and-scenario-ops
  - gap-debug-agent-gate-structural-off
goal_ac: AC-128
---
## Proposal

**交付物：调试 Agent 的 dev-only 控制面——一个挂在既有鉴权中间件下的 HTTP 路由。** 据 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md` 决策 1 与决策 6 实现：控制面负责「**装载场景**、**推进时钟**、**读引擎自检结果**」这三类请求/应答式操作；引擎产出逻辑不在本任务内（本任务只驱动它）。

**为什么走 HTTP 而不新增 WS 通道、不新增 CLI 脚本（决策 6）。** 这三类操作没有服务端推送需求，新增一条 WS 通道意味着新增一套握手、鉴权与重连语义，收益为零。脚本则会**绕过鉴权中间件**，把控制面变成「本机任何进程都能驱动」的面；而且脚本一旦存在就会成为第二个入口，与 HTTP 面争夺「谁是控制面」。

**安全边界是门控，不是鉴权（本决策最容易读错的一句）。** `authenticateToken` 保护的是「已登录用户」；而调试 Agent 在**关闭态下对已登录用户也必须不存在**——它不该出现在任何用户的 capabilities 里，也不该有任何路由可打。鉴权回答「你是谁」，门控回答「这个东西是否存在」。二者都不能替代对方：门控开着但没有鉴权，等于把产出源交给任何能连上端口的人；有鉴权但门控只是一个布尔检查，则任何一处漏检都会把它暴露给已登录用户。

**因此本任务的两条硬约束。** (1) 路由**只在门控开启时被 attach**（关闭态不给 403、不给 401，而是**这里什么都没有**）。(2) 关态判据**不得写成「返回 404」**：本仓库 `static-assets.module.ts` 的 SPA catch-all 对任何**无扩展名**的路径渲染 `dist/index.html`，未挂载的 `/api/...` 返回 `200 text/html`；写 404 的判据在实现完全正确时也必红，且会让它的取假变体一起失效（关闭态真实现与假实现的状态码相同，红不了）。现场读数见 `adr/ADR-003-验证记录.md` 的 a。

**裁决 B 转交给本任务的一项未决。** 调试 Agent 不进 `LLMProvider` 联合，因此它在 `provider-capabilities.service.ts` 的闭集字面量里没有条目，`getProviderCapabilities('<id>')` 会返回 `undefined`。该路径**应当**回退还是显式处理，ADR 未裁决也未实测——由本任务的判据给出读数并收口。

**本任务不做**：不实现引擎；不实现门控模块本身（只消费它）；不实现外部写入路径；不改 `docs/architecture/02-realtime-stream.md`（其已被证伪的断言是否一并修正，是 ADR 留给评审的开放问题）。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「控制面 / dev-only HTTP / 场景装载端点」检索无命中。相邻但机制不同的是 `gap-scripts-static-gates-and-mint-token`（脚本类静态门禁与凭据铸造），它不提供请求/应答式的场景驱动面。

## Plan

1. 路由模块独立成文件，**导出 router 而不自行 attach**；attach 的动作在有门控的那一处（服务入口）。
2. 三个动作各自成端点；「读自检结果」在无记录时给出**可辨的 404**（与控制面的「不存在」区分开：这里是「有这个东西，但这份记录没有」）。
3. 复用既有的 `authenticateToken`，与其它受保护路由**同形**——不新造鉴权路径。
4. 凭据有效但无权限（403）与凭据缺失（401）不混用。
5. 对裁决 B 转交的 `undefined` 一项：先取读数（该调用返回什么、前端拿到后会怎样），再决定回退还是显式处理，并把读数与决定写进完成记录。

## AC

- [x] AC1 控制面判据——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-control-plane.test.ts` 退出码 0。该用例即 `goals/AC-128`：门控开启时 (1) 三个动作各自可达，且「读自检结果」在无记录时给出**可辨的 404 而非空 200**；(2) **缺凭据返回 401**；(3) 401 与 403 不混用；门控关闭时同一路径**不以控制面的应答作答**（**不得写成 404**——理由见 Proposal）。打印每一侧的状态码与 content-type。
- [x] AC2 抗假变体（**真跑并留输出**）：**门控关闭但仍挂载路由**。`AC1` 的命令必须因此**退出码非 0**。注意到本条变体在「判据写 404」时是**失效**的——故本 AC 必须在本任务改正判据**之后**跑，并在输出里同时给出变体前后的两次读数，证明鉴别力来自判据而非巧合。跑完还原，`git status` 干净。
- [x] AC3 三个动作**真跑一次**并与引擎自检对上：命令装载一个场景、推进时钟、读回自检结果，断言自检块里的行数读数与产物文件的实际行数一致（即控制面读到的不是缓存的自述）。取假形态：让「读自检结果」返回引擎的自述而非产物读数时，本判据必须红。
- [x] AC4 裁决 B 转交项取读数并收口：命令打印 `getProviderCapabilities('<id>')` 的实际返回值，以及前端/路由在该返回值下会走的分支；完成记录里写明选了回退还是显式处理及其理由。**不预设结论**——只要求读数存在且决定被写下。
- [x] AC5 本任务未触及 Touches 之外的文件。命令：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到 Touches 内的一条；命中之外时逐行打印并以非 0 退出。

## DoD

真实落地判据（不是「路由能被 curl 到」）：**门控是这条面的存在性来源，而不是它的一道检查。** 承重性由三件事正面证明：

(a) **关闭态的读数与开启态逐字节不同**（AC1：`200 application/json` 对 `200 text/html`），且判据没有被状态码骗过；
(b) **「关掉门控但仍挂载」的变体真跑过并变红**（AC2），且改正判据前后的两次读数都在，证明红来自鉴别力；
(c) **控制面读到的是产物而不是引擎的自述**（AC3）——否则「读自检结果」这个动作本身就是假的。

另需如实登记：裁决 B 转交的 `undefined` 一项的读数与决定（AC4），以及**本任务未实测**的部分（例如未在真实浏览器里点过控制面——它是 dev-only 面，无 UI）。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制的 dev-only 控制面，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的三侧读数与 AC2 的变体承担。
L_G 本目标的判据是 `goals/AC-128`（控制面在门控开启时可用、缺凭据 401，且门控而非鉴权才是安全边界），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体。

## Touches

- server/modules/debug-agent/debug-agent.routes.ts (new)
- server/modules/debug-agent/index.ts
- server/modules/debug-agent/tests/debug-agent-control-plane.test.ts (new)
- server/index.ts
- tasks/gap-debug-agent-control-plane-http-auth.md

## 完成记录

**改动面**：`server/modules/debug-agent/debug-agent.routes.ts`（新，313 行）、`server/modules/debug-agent/tests/debug-agent-control-plane.test.ts`（新，1055 行）、`server/modules/debug-agent/index.ts`（+13/-2）、`server/index.ts`（+20）。实现提交 `c1af7d97`，其后两次 `git merge --no-edit develop`（`b3fe1bf7`、`9e0aaf7d`）把 develop 带进来，解决冲突的方式是 develop 侧新增文件（`debug-agent-external-write.test.ts`、`debug-agent-display-identity.test.ts`）自动并入，无手工冲突。`git diff --stat "$(git merge-base develop HEAD)"` 仅列上述 4 个文件（+1399/-2）。

**AC1**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-control-plane.test.ts` 退出码 **0**，`ℹ pass 4` / `ℹ fail 0`。门控按**每进程读一次**的语义，故判据用「一个门控态一个子进程」（`execFileSync` + tsx CLI），每个子进程装配一个真 app：真 `authenticateToken`、真 `/api/auth` + `/api/providers` 路由、真 provider routes、以及真的 `createStaticAssetsMiddleware`（指向一个 scratch dist），请求走真 socket（`node:http`，不用 `fetch`——本仓库 `listen(0)` 路由测试有 undici 坏端口抽签）。打印的每一侧读数：

```
[gate] OPEN (DEBUG_AGENT="on" with DEBUG_AGENT_HOME="…/fixture")
[register] 200, token minted=true
[arm]                     POST /api/debug-agent/scenarios        credential=token -> 200 application/json; charset=utf-8
[advance the clock]       POST /api/debug-agent/clock            credential=token -> 200 application/json; charset=utf-8
[self-check]              GET  /api/debug-agent/self-check?…      credential=token -> 200 application/json; charset=utf-8
[self-check (no record)]  GET  /api/debug-agent/self-check?sessionId=not-a-session credential=token
                          -> 404 application/json; charset=utf-8 code=DEBUG_AGENT_NO_SELF_CHECK_RECORD   ← 可辨的 404，不是空 200
[advance the clock (unarmed session)] POST /api/debug-agent/clock credential=token
                          -> 404 application/json; charset=utf-8 code=DEBUG_AGENT_SCENARIO_NOT_ARMED
[arm (no credential)]     POST /api/debug-agent/scenarios        credential=none  -> 401 application/json; charset=utf-8 code=AUTH_TOKEN_INVALID
[arm (credential, path outside the fixture home)] POST /api/debug-agent/scenarios credential=token
                          -> 403 application/json; charset=utf-8 code=DEBUG_AGENT_PROJECT_OUTSIDE_FIXTURE_HOME
[gate] CLOSED (DEBUG_AGENT is unset)
[closed self-check (credential)]    GET /api/debug-agent/self-check?sessionId=not-a-session credential=token
                          -> 200 text/html; charset=UTF-8 :: "<!doctype html><title>spa shell</title>"
[closed self-check (no credential)] GET /api/debug-agent/self-check?sessionId=not-a-session credential=none
                          -> 200 text/html; charset=UTF-8 :: "<!doctype html><title>spa shell</title>"
```

关态的两行就是「**不以控制面的应答作答**」：状态码 200、content-type `text/html`、正文是 SPA 壳，与开态的 `200 application/json` **逐字节不同**。401 与 403 由两条不同路径给出且 code 不同（`AUTH_TOKEN_INVALID` vs `DEBUG_AGENT_PROJECT_OUTSIDE_FIXTURE_HOME`），未混用。

**AC2**：变体是把 `debug-agent.gate.ts` 的 `mountDebugAgentControlPlane` 改成**无条件 attach**（删掉 `if (!isDebugAgentEnabled()) return false;` 的提前返回），即「门控关闭但仍挂载路由」。同一份判据命令因此 **EXIT=1**，`ℹ pass 2 / ℹ fail 2`，失败的是该面的两条：

```
✖ the three actions answer while the gate is open, and the closed gate does not answer as the control plane
  AssertionError [ERR_ASSERTION]: the closed arm must not have attached anything   true !== false
✖ the reading is discriminating: attaching the same router while closed turns the closed path into a control-plane answer
  AssertionError [ERR_ASSERTION]: the control attaches the router DESPITE the gate, as a tampered build would   true !== false
```

**变体前后的两次读数**（同一路径、同一凭据，只有门控的实现变了）：

| 侧 | 变体前（真实现） | 变体后（关态但仍挂载） |
|---|---|---|
| closed self-check（带凭据） | `200 text/html; charset=UTF-8`，正文 SPA 壳 | `404 application/json; charset=utf-8`，`DEBUG_AGENT_NO_SELF_CHECK_RECORD` |
| closed self-check（无凭据） | `200 text/html; charset=UTF-8`，正文 SPA 壳 | `401 application/json; charset=utf-8`，`AUTH_TOKEN_INVALID` |

即：关闭态**真实现**与**假实现**的读数确实不同（`200 text/html` vs `404/401 application/json`）——判据的鉴别力来自判据本身，不是巧合。这一点正是 Proposal 里「不得写成 404」的反面证据：若判据写成 404，真实现（`200 text/html`）也会红，而假实现与真实现**无从区分**，本 AC 会一起失效。判据内另设一条**带内**正对照 `closed-forced-mount`（门控关、显式在关态挂同一 router），它给出 `404 json / 401 json`，与真关态的 `200 text/html` 并列，证明关态那一侧的读数不是「环境恰好没有 SPA 壳」之类的偶然。跑完已还原：`git checkout -- server/modules/debug-agent/debug-agent.gate.ts`，还原后 `git status --porcelain` 只剩本任务 4 处应改（`M server/index.ts`、`M server/modules/debug-agent/index.ts`、`?? debug-agent.routes.ts`、`?? tests/debug-agent-control-plane.test.ts`），`grep -rn TAMPER` 无命中。变体输出留存于 `/data/scratch/yale/gap-debug-agent-control-plane-http-auth/ac2-tampered.log`。

**AC3**：读自检结果**不缓存**——`GET /self-check` 每次请求都从磁盘重读产物行数、重判场景期望；run 记录里只存**装载（路径）与运行（引擎的逐步观测）**，不存评测。判据的做法是：装载场景 → 推进时钟 → 在控制面不知情的情况下**带外**往产物 jsonl 追加一行 → 再读一次自检，断言自检块里的行数与该文件的实际行数一致。

```
[file] 3 line(s) -> 4 after the out-of-band append
[self-check before the append] 200 rows=3 rowsDelta=1 lastRowBytes=403 lastRowGrew=true failures=[]
[self-check after the append ] 200 rows=4 rowsDelta=2 lastRowBytes=361 lastRowGrew=true failures=["rows: the run wrote 2 row(s) (2 -> 4); the scenario expects 1"]
```

**取假形态**：把评测在**推进时钟时**算好、存进 run 记录，`GET /self-check` 直接回放它（即返回引擎的自述）——本判据 **EXIT=1**，`ℹ pass 3 / ℹ fail 1`，红的恰是 AC3 那条：

```
✖ the self-check reads the artifact, so a row written after the run moves its answer
  AssertionError [ERR_ASSERTION]: after the append the row count must be the file's own new count (3 vs 4)   3 !== 4
```

同一场景下的两次读数对照：真实现 `before rows=3 → after rows=4`（跟着文件走）；假实现 `before rows=3 → after rows=3`（file 已是 4 行，自述仍停在 3），且 `failures` 也不再重判（假实现的 after 仍是 `[]`）。跑完已还原（三处编辑逐条回退），`grep -rn TAMPER` 无命中，重跑判据 `EXIT=0 / pass 4 / fail 0`。变体输出留存于 `/data/scratch/yale/gap-debug-agent-control-plane-http-auth/ac3-tampered.log`，还原后的绿跑为 `ac1-restored.log`。

**AC4（裁决 B 转交项）读数**：

```
[raw]      getProviderCapabilities('debug') -> undefined (JSON.stringify: undefined)
[raw]      the envelope around it: {"success":true}
[route]    GET /api/providers/capabilities -> 200, providers=["claude","cursor","codex","opencode"]
[route]    GET /api/providers/claude/capabilities -> 200 application/json（对照：联合成员上该路由可用）
[route]    GET /api/providers/debug/capabilities  -> 400 application/json code=UNSUPPORTED_PROVIDER
[frontend] useProviderCapabilities indexes by row.provider -> 一行都没有；useSessionForkingProviders 同样 false
[consumer] setSessionPermissionMode('claude', <sessionId>, 'default') -> "default"   （对照）
[consumer] setSessionPermissionMode('debug',  <sessionId>, 'default') -> null
```

读数是**两段式**的，必须一起看：查表本身返回 `undefined`（`data` 键随之消失，信封退化成 `{"success":true}`），**且**前端消费端在 `undefined` 下走的是回退分支——`rowFound=false`（capabilities 表按 `row.provider` 索引，无行）与 `forkable=false`（`useSessionForkingProviders` 保留 `false`），`setSessionPermissionMode('debug', …)` 返回 `null` 而不是抛错或写入。

**决定：选回退，不改动生产代码。** 理由三条。(1) 回退是可用的：每一个消费点都通过可选链 / `?? []` / `?? null` 降级，实测没有一处抛错、没有一处写入脏值——`null` 是「这个 provider 没有可记的权限模式」，而不是「未知状态」。(2) 显式处理需要给运行时 id 在闭集字面量里开一个条目，而那会把 `debug` 提升为「与 `claude` 并列的一等 provider」：ADR-003 决策 2 明确它**不进** `LLMProvider` 联合，开条目与那条决策相抵，且会把一个 dev-only 面的名字扩散到产品能力的公共枚举里。(3) 门控是存在性来源：门控关闭时这条 provider 在注册表里根本不存在，`getProviderCapabilities` 的入参就无从产生；门控开启时它只在 dev 会话里出现，回退分支的代价（无权限模式可选）正是 dev-only 面应得的形状。故本任务**不新增条目、不改 `provider-capabilities.service.ts`**，只把读数与理由登记在此。若评审认为应当在服务层显式回答「非联合成员一律 400」，那是一次**独立的行为变更**，应由新任务承载。

**AC5**：`git diff --name-only "$(git merge-base develop HEAD)"` 逐行：

```
server/index.ts                                              → Touches 第 4 条
server/modules/debug-agent/debug-agent.routes.ts             → Touches 第 1 条 (new)
server/modules/debug-agent/index.ts                          → Touches 第 2 条
server/modules/debug-agent/tests/debug-agent-control-plane.test.ts → Touches 第 3 条 (new)
```

4 行全部命中，无 Touches 之外的文件（本文件由 `task_write` 自身提交，不出现在该 diff 里）。

**门禁与静态检查**：`bash scripts/test.sh --for-task gap-debug-agent-control-plane-http-auth --allow-thin` 退出码 **0**，逐文件判决 `__PERFILE__ duration_ms=8598 server/modules/debug-agent/tests/debug-agent-control-plane.test.ts passed=true`——该文件确被 `## Touches` 选中并**真跑**（不是被 thin 跳过）。注意这里的 `# tests 1` 是脚本的**文件数**计数，与判据内的 4 条用例不是一个量，未混用。`npm run lint`（= `oxlint src/ server/ scripts/`）退出码 **0**；`npm run typecheck` 退出码 **0**（已核 `server/tsconfig.json` 的 `include` 覆盖 `server/**` 下的测试目录，故该绿不是空跑）。scoped-gate 缓存已写：`--develop-sha f7c90492`。

**行为改变量**：新增一条 dev-only 面，产品路径改动为零——门控关闭时（任何未显式设 `DEBUG_AGENT` 的部署，含生产）`mountDebugAgentControlPlane` 不 attach、`registerDebugAgentControlPlaneRoutes` 不注册，中间件栈与今天逐字节相同。开启时多三条 `/api/debug-agent/*` 路由，且仅在 `DEBUG_AGENT_HOME` 内写产物（`assertInsideFixtureHome` 对越界路径 403）。

**本任务未实测的部分（如实登记）**：未在真实浏览器里点过控制面——它是 dev-only 面，无 UI，也没有前端入口；判据全部走真 socket 但**未起真实 `server/index.ts` 进程**（判据自装配 app，装配顺序与 `server/index.ts` 对齐，但「真入口在真端口上」这一步没有读数）；未实测门控关闭时**真实生产部署**的 SPA 壳内容（判据用的是 scratch dist 里的一份最小壳）；未做并发/压力读数（控制面的 `runRecords` 是进程内 `Map`，多进程部署下各进程各自一份，本任务未测该形态）。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制的 dev-only 控制面，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的三侧读数与 AC2 的变体承担。
L_G 本目标的判据是 `goals/AC-128`（控制面在门控开启时可用、缺凭据 401，且门控而非鉴权才是安全边界），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体。