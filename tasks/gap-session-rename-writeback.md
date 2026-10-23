---
id: gap-session-rename-writeback
title: App 改名写回 Claude Code：经 SDK renameSession 追加 custom-title，DB 先写、磁盘 best-effort
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-claude-title-ladder-mirror
---
## Proposal

现状：`server/modules/providers/services/sessions.service.ts` 的 `renameSessionById` 只写 SQLite 的 `custom_name` 并发一条 `session_upserted`；`server/modules/providers/provider.routes.ts` 的 `PUT /api/providers/sessions/:sessionId` 转调它。仓库里**没有任何代码把标题写进 `~/.claude`**（`history.jsonl` 只读；transcript 只被 debug-agent 的夹具根写过，而那个根结构性到不了真实 home）。唯一例外是 fork：`server/modules/providers/list/claude/claude-fork.provider.ts` 把标题交给 SDK，SDK 会写一条 `custom-title`。

后果：在终端 `claude --resume` 的列表、`searchSessionsByCustomTitle`、以及 `/resume` 的参数补全（CLI 内部是 `customTitle ?? aiTitle`）里都看不到 App 改的名，两个界面可以长期不一致。

SDK 提供了受支持的离线改名 API：

```
node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2438
/** Rename a session. Appends a custom-title entry to the session's JSONL file. */
export declare function renameSession(sessionId, title, options?): Promise<void>;
```

同族还有 `tagSession` / `deleteSession` / `forkSession`（`SessionMutationOptions`，可传 `dir` 指定项目目录）。
**不要**自己拼 JSONL 行去追加，也**不要**写 `custom-title.json` 边车——CLI 把该边车当可清理的临时文件（它出现在 CLI 的 retention cleanup 白名单里），不是契约。

已知取舍（写进实现注释，不在本任务处理）：CLI 的列表阶梯 `wze` 把 `agentName` 排在 `customTitle` 之上，所以对**有 `agent-name` 的会话**（本机语料 1172/1254），写回**不会**改变 CLI 列表里显示的标题。写回的价值在于该名字在 CLI 侧被记录、可被搜索、可出现在 `/resume` 的参数补全里。App 侧显示不受影响，因为显式覆盖列优先于转录侧列。

方案：

1. `renameSessionById` 的顺序固定为：DB 先写（`custom_name` = 显式覆盖，`name_source='manual'`）→ 发广播 → 再 best-effort 写盘。反过来（先写盘后写库）的失败模式更糟：磁盘改了、App 没改。
2. 写盘条件：行 `provider === 'claude'` 且 `jsonl_path` 非空且文件存在；`dir` 用行的 `project_path`。条件不满足时**跳过且不报错**——App 新建、尚无 transcript 的会话本来就没有文件可写。
3. 写盘失败只记日志，HTTP 仍返回 200（改名在 App 侧已经生效，不应因为磁盘问题让用户看到失败）。
4. SDK 调用按 `.agents/skills/backend-module-standards/SKILL.md` 落位：不要从 service 层深导入 providers 内部文件；若为此新增 provider 侧文件并经 barrel 暴露，把该文件补进 Touches。
5. 幂等/不抖动：写盘会让 watcher 再同步一次，读到同名 `custom-title`；断言名字不变、且不产生可见抖动。

本任务假定会话行已有 `transcript_name`（转录侧）与 `custom_name`（显式覆盖）两列——该结构由标题阶梯镜像的工作引入；若它尚未落地，先不要开始本任务。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-rename-writeback.test.ts` 退出码 0：用真实临时 `HOME`（含真实形状 transcript）+ 真实临时 sqlite + 真实路由 `PUT /api/providers/sessions/:sessionId`，断言三条互相独立——(a) transcript 末尾出现一条 `custom-title`，`customTitle` 等于新名（**正控**：改名前后各读一次该文件，行数与末尾条目必须真的变化，证明写入确实发生，而不是断言了一个本来就成立的状态）；(b) 库 `custom_name` 为新名、`name_source='manual'`；(c) 该行 `transcript_name` **不变**（证明写回不污染转录侧列）。
- [x] 同一命令下的跳过路径：对一条 `jsonl_path` 为空、或指向不存在文件的会话改名，HTTP 仍 200、库仍更新、且**没有发生任何文件写入**（对临时 HOME 做整目录快照比对，不是只检查目标文件不存在）。
- [x] 同文件断言幂等：对同一会话连续两次 PUT 同一名字，第二次之后库里状态与第一次后完全一致，且 transcript 里该名字的 `custom-title` 条数不增加（若实现确实每次都追加，则把该读数如实打印出来并在 Evidence 里记录为已知形态，不得静默放过）。
- [x] 抗假变体（两条，各自只许红指定的项）：(i) 把写盘调用整段注释掉后重跑同一命令，红的必须**只有 (a)**；(b)(c) 与跳过路径用例保持绿——它们断言的正是「DB 侧不受写盘影响」。还原后转绿。(ii) 把写盘改成无条件执行（去掉 `provider`/`jsonl_path` 条件）后，跳过路径用例必须变红；还原后转绿。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-rename-route.test.ts` 退出码 0（既有路由用例不回归：200 / 404 / 400 / 广播条数）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：不是仅有单测。要求在真实服务实例（临时 `DATABASE_PATH` + 临时 `HOME`，`HOST=127.0.0.1`）里，经**真实浏览器**在 UI 中给一个会话改名，然后取得三处独立读数：(1) 磁盘上该会话 transcript 末尾确实多了一条 `custom-title` 且值等于新名——直接读文件，不是读库；(2) 用 SDK 的 `listSessions`（或等价的 `getSessionInfo`）读回该会话，`customTitle` 等于新名——这是「CLI 侧真的看得见」的独立读数；(3) 库里的 `custom_name` / `transcript_name` 两列与预期一致。

再对一条 `agent-name` 存在的会话重复一次，如实记录：CLI 列表标题**未变**（`agentName` 优先），但读回的 `customTitle` 是新名。把这个差异原样写进 Evidence，不要粉饰成「已同步」。

L_D = CLI 侧读回的 `customTitle`：改名前为旧名或空，改名后等于用户输入的新名。这是从 CLI 自己的 session 元数据读出来的独立读数，不是测试通过与否。

## Touches

- server/shared/interfaces.ts
- server/modules/providers/list/claude/claude-rename.provider.ts (new)
- server/modules/providers/list/claude/claude.provider.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/provider.routes.ts
- server/modules/providers/index.ts
- server/modules/providers/tests/session-rename-writeback.test.ts (new)
- server/modules/providers/tests/session-rename-route.test.ts
- tasks/gap-session-rename-writeback.md

## Evidence

实现提交：`78317ff9 claude: an app rename is written back to the transcript the CLI reads`（分支 `task/gap-session-rename-writeback`）。全部读数在 worktree 内取得。

### AC 读数

1. 写回用例（`--test-reporter=tap`）：`# tests 4 / # pass 4 / # fail 0`，exit 0。三条断言互不相干：**(a)** 读 transcript 文件本身，且带正控——断言前先确认夹具末条是 `ai-title`（不是「已经成立的状态」），断言后行数 `+1` 且末条 `type='custom-title'`、`customTitle` = 新名；**(b)(c)** 读库：`custom_name` = 新名 + `name_source='manual'`，而 `transcript_name` 仍是 `Generated Title`（source `ai`）——写回不污染转录侧列。
2. 跳过路径在同文件的第三个用例内，三类行各一条：(i) `jsonl_path` 为空、但**同名（同一 session id）transcript 确实存在于 SDK 会去找的位置**——这是陷阱行，专为「按文件在不在决定写不写」的实现设；(ii) 指向已被删除的文件；(iii) codex（写不回去的 provider）。三条都 `200`、库都更新为 `manual`，且 `Map(path -> bytes)` 的**整目录快照前后深度相等**（不是只查目标文件）。
3. 幂等读数（如实打印，非断言）：`[rename-writeback] custom-title entries for "Renamed Twice": after 1st rename = 1, after 2nd = 2`。两次同名 PUT 后库行 `deepEqual`，条数用 `>=`（不减少）。**已知形态**：SDK 的 rename 是无条件追加，所以同名重命名会多一条同值条目；CLI 取最后一条，故读回的名字不变——不静默放过，记录在此。
4. 抗假变体 (i)：把 `await writeRenameToProviderTranscript(session, summary)` 整段注释掉重跑 → `ok 2 / ok 3 / ok 4` + `not ok 1 - (a)`，`# pass 3 / # fail 1`——**只有 (a) 红**，(b)(c) 与跳过路径保持绿。还原后 sha256 = `42952241367bf901f167e15408e1c49aca2306a0a476c33eedf66ee1a0186209`。
5. 抗假变体 (ii)：去掉 `rename` / `jsonl_path` / `provider_session_id` / 文件存在四个条件、改成无条件调用后重跑 → `not ok 3 - a session with nothing to write to is renamed in the app and writes no file anywhere`，`ok 1 / ok 2 / ok 4`，`# pass 3 / # fail 1`——红的正是跳过路径用例。TAP 的 diff 给出红的因果：该实现把 `{"type":"custom-title","customTitle":"Renamed With No Transcript",...}` 追加到了 `jsonl_path` 为空那条会话的 transcript 上，整目录快照因此不等。**这一条第一次跑时是绿的**：陷阱行的 transcript 当时按另一个 session id 命名，SDK 按行自己的 id 找不到文件，所以变体没有被打中——陷阱是假陷阱；把文件改成按该行自身的 id 命名后才红。这一步修正本身即是这次抗假的价值。还原后 sha256 同上。
6. 路由用例 `# tests 4 / # pass 4`（既有 3 条 + 新增 1 条「provider 写不回去的改名仍入库、仍广播、仍 200」），exit 0。
7. `npm run typecheck` exit 0；`npm run lint` exit 0（输出仅既有 warning，无新增）。

### DoD 真实落地读数

真实服务实例：`playwright.config.ts` 的 `webServer` 原样起真实 server（`HOME` = 临时目录、`DATABASE_PATH` = 该目录下 `auth.db`、`HOST=127.0.0.1`）+ 真实 vite，浏览器是真实 Chromium，UI 路径为「会话行菜单 → Rename session → 输入 → Enter」。两条种子会话：A 普通（`ai-title` = `Alpha Seeded Title`）；B 带 `agent-name`（= `Beta Agent Title`）。

- **读数 1（磁盘，直接读文件）**：A 末条 = `{"type":"custom-title","customTitle":"Alpha Renamed By The App","sessionId":"4f1c2a90-…"}`；B 末条 = `{"type":"custom-title","customTitle":"Beta Renamed By The App","sessionId":"7d2e4b10-…"}`。
- **读数 2（SDK 读回，独立于库）**：A `getSessionInfo` → `customTitle="Alpha Renamed By The App"`（`listSessions` 同值）；B → `customTitle="Beta Renamed By The App"`（`listSessions` 同值）。
- **读数 3（App 库）**：A = `custom_name='Alpha Renamed By The App'`, `name_source='manual'`, `transcript_name='Alpha Seeded Title'`（source `ai`，未变）；B = `custom_name='Beta Renamed By The App'`, `name_source='manual'`, `transcript_name='Beta Agent Title'`（source `agent`，未变）。
- **侧栏（App 侧显示，settled 读数）**：改名前 `["Session options for Beta Agent Title","Session options for Alpha Seeded Title"]` → 改名后 `["Session options for Beta Renamed By The App","Session options for Alpha Renamed By The App"]`。第一次采样是在第二次改名后立刻取的、只看到一行，属客户端重取列表的过程态；加等待后是上面这个稳定的两行读数。

### agent-name 会话：没有变的东西（不粉饰）

- transcript 里的 `agent-name` 条目原样还在，且排在追加的 `custom-title` **之前**：`{"type":"agent-name","agentName":"Beta Agent Title"}`。CLI 的列表阶梯 `agent-name > custom-title` 因此仍取 agent 名。App 侧镜像该阶梯的列给出同一读数：`transcript_name` 仍是 `Beta Agent Title`、来源 `agent`。**CLI 列表标题未变**。
- **一个容易误读的字段，单独记下**：`getSessionInfo`/`listSessions` 返回的 `summary` 对 B **也变成了** `Beta Renamed By The App`。`SDKSessionInfo.summary` 的定义是 `customTitle ?? aiTitle ?? firstPrompt`，**没有 `agent-name` 这一级**，所以它**不是** CLI 的列表标题，不能拿它当「CLI 列表已同步」的证据。写回真正改变的是 `customTitle`——即该名字在 CLI 侧被记录、可被 `searchSessionsByCustomTitle` 搜到、可出现在 `/resume` 参数补全里——而不是列表显示名。

### L_D

CLI 侧读回的 `customTitle`：A `"Alpha Seeded Title"` → `"Alpha Renamed By The App"`；B `"Beta Generated Title"` → `"Beta Renamed By The App"`。（改名前的值是种子里已有的 `ai-title`，SDK 把它当 `customTitle` 报回来；关键是改名后等于用户输入的新名。）

### 复现方式（一次性 harness，未入库）

DoD 用一个**临时** spec（`e2e/rename-writeback-dod.spec.ts`）驱动，跑完即删，故不在本分支 delta 里；数据目录经 `QUAY_E2E_DATA_DIR` 预置，两条种子 transcript 写在 SDK 自己会去找的 `<home>/.claude/projects/<encoded-cwd>/` 桶下（注意：仓库既有 e2e 夹具把桶名写成工作目录的基名，那只是因为 App 的扫描不依赖桶名；SDK 的 rename 依赖桶名，所以这里必须按 SDK 的编码规则放）。运行：`QUAY_E2E_DATA_DIR=<dir> PLAYWRIGHT_BROWSERS_PATH=<机器缓存> npx playwright test e2e/rename-writeback-dod.spec.ts` → `1 passed`。另如实记一笔运行细节：spec 把 `process.env.HOME` 指向数据目录后，playwright 会连带从 `<HOME>/.cache/ms-playwright` 找浏览器可执行文件，因此要显式给 `PLAYWRIGHT_BROWSERS_PATH`（机器级浏览器缓存与「临时 HOME」不是一回事）；这是 harness 的细节，不是产品行为。
