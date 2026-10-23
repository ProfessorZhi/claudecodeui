---
id: gap-debug-agent-gate-structural-off
title: 调试 Agent 的 env 门控：关闭即结构性不存在（registry 无键 / watcher 无根 / 路由未挂载三面），且 fail-closed
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-123
---
## Proposal

**交付物：调试 Agent 的 env 门控，以及「关闭即结构性不存在」这条性质的实现与判据。** 据 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md` 决策 3（并经评审**裁决 B** 收窄）实现：门控变量（如 `DEBUG_AGENT`）默认关闭；关闭时**不是「接口返回 403」，而是「这个东西不存在」**，且该性质在**三面**上同时成立。

**三面**（裁决 B 把原文的「四面」降为三面，理由见下）：

1. **registry 里没有键**——任何按 id 解析的路径拿到的是「未知 provider」，**与拼错一个 id 无从区分**；
2. **watcher 没有根**——fixture 根不在观察路径集合里，因而不会有任何 `session_upserted` 因为场景推进而广播出去；
3. **路由未挂载**——路由器根本没被 attach，所以没有任何请求能落到控制面的处理函数上。

**裁决 B 删掉的那一面及其理由。** 原文把「capabilities 没有条目」列为第四面，并说「四个面各自独立地读门控」。实测不成立：`PROVIDER_CAPABILITIES` 是 `Record<LLMProvider, ProviderCapabilities>` 的**闭集字面量**，不随 registry 增长——所以「关闭态没有条目」**恒真**，开着也没有。按本 ADR 自己的标准（判据若在假实现下仍绿，它测的就不是它声称要测的东西）那是假判据。**裁定：不计入四面，也不为了这一面去增加门控耦合。**

**「未挂载」不等于 404（承重的一条事实）。** `static-assets.module.ts` 的 SPA catch-all 对**任何无扩展名的路径**渲染 `dist/index.html`，而它挂在所有 `/api/*` 之后——因此一个未挂载的 `/api/...` 路径返回的是 **`200 text/html`**（前端壳），既不是 404 也不是 403；只有**带扩展名**的路径才 404。所以第 3 面**不得落成状态码断言**；本任务的判据用「该路径**不以控制面的应答作答**」。现场读数见 `adr/ADR-003-验证记录.md` 的 a。

**fail-closed 是承重的。** 变量缺失、取值不认识、或开了但没有 fixture 根，一律按**关闭**处理，且必须打印判定原因。门控在**进程启动时**求值，因此判据必须在**两个独立子进程**里各取一次读数（ESM 模块一旦求值就不能在同一进程内重来）。

**本任务不做**：不实现控制面路由本身（另有任务，本任务只保证它在关闭态不被挂载）；不实现词表守卫；不做 fixture 的清理顺序。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，不构成前置）**：`tasks/` 内无同机制任务——按「门控 / 结构性关闭 / env gate / fail-closed」检索无命中。相邻但机制不同的是 `gap-model-library-*` 系列的开关类任务（那是配置项读写，不是「不存在」语义）。

## Plan

1. 门控模块独立成文件，**是唯一读门控变量的地方**；三个消费点（registry、watcher、服务入口的路由挂载）都从它取结论，不各自解析 env。
2. registry 侧：键的注册在门控开启时才发生——关闭时那张表里**根本没有这一项**。
3. watcher 侧：观察路径集合由门控决定；fixture 根与既有四个根**重复时不重复观察**（两个 watcher 盯同一目录会让每个事件翻倍）。
4. 路由侧：在服务入口按门控决定是否 `app.use(...)`；关闭时**不 attach**。
5. 判据必须起两个子进程（关闭态 / 开启态各一），并在输出里打印每次判定的原因。

## AC

- [x] AC1 三面判据——`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-gate.test.ts` 退出码 0。该用例即 `goals/AC-123`：关闭态逐一断言 (1) registry 无键且解析失败**与拼错一个 id 逐字相同**；(2) fixture 根不在观察路径集合里且该目录不被创建；(3) 控制面路径**不以控制面的应答作答**（**不得断言 404**——见 Proposal 与 ADR 的 a）；开启态对照三面都存在；并断言 fail-closed（取值不认识、或开了但没有根，一律按关闭且打印原因）。打印三面的实际读数。
- [x] AC2 抗假变体（**真跑并留输出**）：**只关掉其中一面**——例如保留 registry 键但摘掉路由。`AC1` 的命令必须因此**退出码非 0**，且红因指明是哪一面漏了。跑完还原，`git status` 干净，并贴两次输出。这一条是「三面各自独立读门控」这个代价的正面覆盖。
- [x] AC3 判据自身不得被 404 骗过：对关闭态的同一个控制面路径，命令**同时**打印无扩展名与带扩展名两种写法各自的状态码与 content-type，使「200 text/html」与「404」的差别在输出里可见。取假形态：把第 3 面写成「关闭时返回 404」后，本判据在**实现完全正确**的前提下也必须红——若它仍绿，说明该面根本没被断言。
- [x] AC4 门控只有一个读点：命令断言除门控模块本身外，`server/` 下没有第二处直接读该 env 变量的位置（逐行打印命中）。取假形态：某个消费点自己解析 env 而绕过门控模块时，本判据必须红。
- [x] AC5 本任务未触及 Touches 之外的文件。命令：`git diff --name-only "$(git merge-base develop HEAD)"` 的每一行都必须能对应到 Touches 内的一条；命中之外时逐行打印并以非 0 退出。

## DoD

真实落地判据（不是「有个 if 判断了 env」）：**关闭态的「不存在」是结构性的，而不是某个检查返回了 false。** 承重性由三件事正面证明：

(a) **三面各自被独立断言过**（AC1），而不是断言了一个布尔值；
(b) **「只关掉一面」的变体真跑过并变红**（AC2）——这直接证明三面是三条独立的路径，而不是同一处判断的三个投影；
(c) **第 3 面的判据没有退化成状态码断言**（AC3），即它没有被本仓库的 SPA catch-all 骗过——现场实测过：未挂载的 `/api/...` 返回 `200 text/html`。

另需如实登记：`capabilities` 那一面**不在**本任务的三面内（裁决 B）。它的开启态行为——既然该 provider 不进联合，`getProviderCapabilities('<id>')` 会拿到 `undefined`——**本任务不实测、不裁决**，留给控制面任务的判据。

L_D 该轴仍暗，理由：本任务交付的是调试/测试机制的门控，不改变产品领域能力，没有可读出的产品领域读数；判定面由 AC1 的三面读数与 AC2 的变体承担。
L_G 本目标的判据是 `goals/AC-123`（门控关闭时三面都不存在，且「只关掉其中一面」的变体必须红），本任务的 AC1 即该判据的命令；AC2 是它的抗假变体。

## 验证记录（2026-09-22）

判据命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-gate.test.ts`（基线退出码 0，6/6，约 4.9s；门控的 60s 上限内）。

### AC1 基线：关闭态（`DEBUG_AGENT` 未设，而 `DEBUG_AGENT_HOME` 已在环境里——对该性质最强的形态）

```
[gate] CLOSED (DEBUG_AGENT is unset); home=<none>
[face 1 registry] registered=false resolve('debug')=AppError/UNSUPPORTED_PROVIDER/400 resolve('claud')=AppError/UNSUPPORTED_PROVIDER/400
[face 2 watcher] fixtureRoot=/data/scratch/yale/debug-agent-gate-closed-L48sak/fixture/.claude/projects listed=false created=false productRoots=4 productRootsCreated=4
[face 3 routes] mounted=false layersAdded=0 layers=[]
[face 3 routes] extension-less /api/debug-agent -> 200 text/html; charset=UTF-8 "<!doctype html><title>spa shell</title>"
[face 3 routes] with-extension  /api/debug-agent/scenarios.json -> 404 text/html; charset=utf-8 "Not found"
```

面 1 的「逐字相同」是断言出来的：`debug` 与 `claud` 的 errorName/code/statusCode 相等，且 message 把请求的 id 抹掉后逐字相等。面 2 的 positive control：同一次运行里 4 个产品根**都被列出且都被创建**，所以「fixture 根没被创建」不是「mkdir 根本没跑」。此外还断言「观察集合里没有任何一条归属于 debug agent 的根」——于是「换一个目录去看」也满足不了这一面。

### AC1 基线：开启态（另一个子进程）

```
[gate] OPEN (DEBUG_AGENT="on" with DEBUG_AGENT_HOME=".../fixture"); home=.../fixture
[face 1 registry] registered=true resolve('debug')=resolved resolve('claud')=AppError/UNSUPPORTED_PROVIDER/400
[face 2 watcher] fixtureRoot=.../fixture/.claude/projects listed=true created=true productRoots=4 productRootsCreated=4
[face 3 routes] mounted=true layersAdded=4 layers=["query","expressInit","authenticate","router"]
[face 3 routes] extension-less /api/debug-agent -> 401 application/json; charset=utf-8 "{...code\":\"AUTH_TOKEN_INVALID}"
```

（`query`/`expressInit` 是 express 首次 `use` 时自己的引导层；因此断言的是层的**内容与次序** `["authenticate","router"]`，不是层数。）

### AC1 基线：fail-closed（两个子进程，各自打印原因）

```
[gate] CLOSED (DEBUG_AGENT="enabled" is not a recognised value (expected one of 1/true/yes/on or 0/false/no/off))
[gate] CLOSED (DEBUG_AGENT is enabled but DEBUG_AGENT_HOME is empty: the fixture root is mandatory and is never defaulted to os.homedir())
```

### AC2 抗假变体：「只关掉其中一面」（真跑，4 个变体全部退出码非 0；每次跑完 `git checkout -- server/`，4 次跑完 `git status --short` 为空）

| 变体 | 改动 | 退出码 | 红因（断言消息） |
| --- | --- | --- | --- |
| v1 registry 无视门控 | 去掉 `registerDebugAgentProvider` 里的门控读 | 1 | `face 1: the key must not be written while the gate is closed` |
| v2 watcher 无视门控 | watcher 自己读 `DEBUG_AGENT_HOME` 拼根 | 1 | `face 2: the fixture root must not be in the observation set`（并同时红了 AC4 的读点扫描，命中 `sessions-watcher.service.ts:56`） |
| v3 路由无视门控 | 去掉 `mountDebugAgentControlPlane` 里的门控读 | 1 | `face 3: the control plane must not attach while the gate is closed` |
| v4 关闭态反而答 404 | 关闭时挂一个 404 处理函数 | 1 | `face 3: no middleware layer may be added at the control-plane path`（3 !== 0） |

v2 是这一条的正面覆盖：它只动 watcher 一面，**另外两面仍然绿**——三面确实是三条独立路径。

### AC3 判据不被 404 骗过

关闭态同一路径的两种写法（上面基线里已同时打印）：

- 无扩展名 `/api/debug-agent` → `200 text/html`（SPA 壳：**不是**控制面的应答，也**不是** 404）
- 带扩展名 `/api/debug-agent/scenarios.json` → `404 text/html`（真的没有这个文件）

假形态 v4（把第 3 面写成「关闭时返回 404」，其余实现完全正确）下判据红：

```
AssertionError: face 3: no middleware layer may be added at the control-plane path   (3 !== 0)
AssertionError: the extension-less variant is the SPA shell                          (404 !== 200)
```

即：若把这一面写成 404，本判据在**正确实现**下就会红——它测的是「不以控制面的应答作答」，不是状态码。

### AC4 只有一个读点

基线逐行打印的结论是 `no direct gate reads outside server/modules/debug-agent/debug-agent.gate.ts`（零命中）；v2 变体（消费点自己解析 env）下它红并逐行打印命中位置。该扫描对本用例文件自身也成立——用例是用 `process.env[NAME]` 的常量拼写取的，不是直接读字面量。

### AC5 未触及 Touches 之外的文件

`git diff --name-only "$(git merge-base develop HEAD)"` 与未跟踪文件合计 7 条，逐条对应 Touches；两条此前漏登记的（本任务新建的模块 barrel 与被扩展的 providers barrel）已补进 Touches：

- `server/modules/debug-agent/debug-agent.gate.ts` (new)
- `server/modules/debug-agent/index.ts` (new)
- `server/modules/debug-agent/tests/debug-agent-gate.test.ts` (new)
- `server/modules/providers/provider.registry.ts`
- `server/modules/providers/index.ts`
- `server/modules/providers/services/sessions-watcher.service.ts`
- `server/index.ts`

### 如实登记

- `capabilities` 那一面按裁决 B **不在**三面内；本任务不实测、不裁决（DoD 已登记）。
- 控制面路由的**端点**不在本任务范围。本任务只保证关闭态不被挂载，并把那个 router（`debugAgentControlPlaneRouter`）与挂载点（`mountDebugAgentControlPlane`）放在 `debug-agent.gate.ts` 里由门控模块自己持有：控制面任务把端点注册到同一个 router 上即可，`server/index.ts` 的挂载点无需改动。
- 判据里 auth 中间件用的是形状替身（401 + JSON，与真实中间件同形）：这一面测的是「有没有东西被 attach」，而真实中间件会在 import 期求值 app-config 数据库。控制面任务自己去测真实中间件。

## Touches

- server/modules/debug-agent/debug-agent.gate.ts (new)
- server/modules/debug-agent/index.ts (new)
- server/modules/debug-agent/tests/debug-agent-gate.test.ts (new)
- server/modules/providers/provider.registry.ts
- server/modules/providers/index.ts
- server/modules/providers/services/sessions-watcher.service.ts
- server/index.ts
- tasks/gap-debug-agent-gate-structural-off.md