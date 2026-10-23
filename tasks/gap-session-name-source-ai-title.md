---
id: gap-session-name-source-ai-title
title: 会话名来源优先级：sessions.name_source 列，自动采纳 Claude 已写入 transcript 的 ai-title，改名补
  session_upserted 广播，修 Cursor 同步覆盖手工名
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景（已与人讨论并确认的设计；实测于 2026-09-21）：会话列表里 App 新建的会话名取首条消息的前 4 个「词」（`buildCloudCliSessionName`，按空白切分，中文整段成为名字），难以检索。而 Claude CLI/SDK 已经把标题写进了 transcript 的 `ai-title` 条目（每个文件只写一次，最晚出现在第 73 行，整行最大可达 750KB），App 却没有采用，原因有两处「锁」：

1. App 新建的会话（`session_id <> provider_session_id`）：`sessions.db.ts` 的 `createSession` 里 UPDATE 与 ON CONFLICT 两处 SQL 只要 `custom_name IS NOT NULL` 就保留旧名，首句名一旦写入同步永远改不了。
2. CLI 新建的会话：`claude-session-synchronizer.provider.ts` 在库里已有名字（不是 Untitled Claude Session）时提前返回、不再读 transcript，先落库的 `last-prompt` 兜底名会挡住稍后才出现的 `ai-title`。

另外两个已知缺口一并修：手工改名（`renameSessionById`）不发 `session_upserted` 广播，其他标签页/设备要刷新才见新名；Cursor 同步器不看库里已有的 `custom_name`，`createSession` 又用 `COALESCE(新值, 旧值)`，磁盘上发现的 Cursor 会话被手工改名后下一次同步会把名字覆盖回首行。

方案：
1. `sessions` 表新增列 `name_source TEXT DEFAULT 'derived'`，取值 `derived`（首句/last-prompt/history 兜底）、`ai`（transcript 的 `ai-title`）、`manual`（UI 改名，或 transcript 的 `custom-title`，即 CLI `/rename` 与 quay 的 `--name`）。写入 `schema.ts`（新库）与 `migrations.ts`（幂等迁移）。
2. 回填策略（人已裁定）：保守，加列的那一次迁移把所有已有行标为 `manual`（新增列的 DEFAULT 只对新行生效，回填必须只在「本次迁移刚加了这一列」时执行，重复运行不得把已升级为 `ai` 的行改回 `manual`）。`custom_name` 为 NULL 的行不动。
3. 优先级集中到 `sessions.db.ts` 一处（现在同一段 CASE 在 UPDATE 与 ON CONFLICT 各写了一遍，合并）：`manual` 大于 `ai` 大于 `derived`；`createSession` 新增可选参数 `nameSource`（缺省 `derived`，所以 codex/opencode 同步器无需改动）。传入名只有在来源优先级高于库里现有来源时才覆盖；同为 `ai`/`manual` 时后来者覆盖；`derived` 遇到已有名字保持今天的行为（App 会话保留原名，CLI 会话沿用 COALESCE）。库里 `manual` 的名字任何 `derived`/`ai` 都不得覆盖（同时修掉 Cursor 覆盖）。
4. Claude 同步器：去掉「已有名字就提前返回」，改为只有库里来源是 `manual` 才保留旧名，其余重新抽取；`extractSessionTitle` 同时返回来源（`custom-title` 记 `manual`，`ai-title` 记 `ai`，`last-prompt`/history 记 `derived`）；已是 `ai` 或 `manual` 的会话不再扫描 transcript；仍是 `derived` 的改为逐行流式读取、找到 `ai-title` 即停，避免大文件每次变化都整读。
5. `updateSessionCustomName` 同时写 `name_source='manual'`；`renameSessionById` 成功后调用 `broadcastSessionUpserted`，让改名实时出现在其他客户端。watcher 路径本来就广播（`sessions-watcher.service.ts` 的 `broadcastSessionUpsertedBatch`），验收里要证明 `ai-title` 升级也确实产生了广播，而不是假定。
6. 已知取舍（写进实现注释，不作额外处理）：UI 改名后再在 CLI 里 `/rename`，UI 的 `manual` 优先，不比较时间戳；只有 Claude 有 `ai-title`，Codex 的 `thread_name` 与 OpenCode 的 `session.title` 本次不接入。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/sessions-name-source.integration.test.ts` 退出码 0：用真实临时 sqlite 断言优先级矩阵——`ai` 覆盖 `derived`（App 会话与 CLI 会话各一）、`derived` 不覆盖 `ai`/`manual`、`ai` 不覆盖 `manual`、`manual` 后来者覆盖 `manual`；`createSession` 不传 `nameSource` 时按 `derived` 处理；`updateSessionCustomName` 之后该行 `name_source` 为 `manual`。
- [x] 同一命令下的迁移用例通过：对没有 `name_source` 列、已有 3 行（含 1 行 `custom_name` 为 NULL）的旧库连续跑两次迁移，第一次加列并把有名字的行标为 `manual`、NULL 名的行保持 `derived`，第二次无操作；在两次迁移之间把一行改成 `ai`，第二次迁移后它仍是 `ai`。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-title-source.test.ts` 退出码 0：用真实 jsonl 夹具跑真实 Claude 同步器——(a) App 会话先以首句名 `derived` 落库，再向其 transcript 追加一条 `ai-title` 并重新同步，库里名字变为该标题、`name_source` 为 `ai`；(b) CLI 会话先以 `last-prompt` 兜底名落库，再追加 `ai-title`，同样升级；(c) 库里为 `manual` 的会话，即使 transcript 含 `ai-title` 也保持不变；(d) transcript 含 `custom-title` 时记为 `manual`；(e) 已是 `ai` 的会话再次同步不读取 transcript（实现走的是 `fs.createReadStream`，`readFile` 替身对它不可见，故以 `/proc/self/io` 的 `rchar` 增量作为读取代价上界证明：约 8MB 的夹具实测只读 131,320 字节，整读会大于 8MB）。
- [x] 同一测试文件断言流式读取：夹具为一个「`ai-title` 在第 5 行、其后还有超过 20MB 内容」的 transcript，同步在读完该行后即停止（以读取字节数或读取行数的上界证明，且不得是整文件读取）；并附反例夹具（无 `ai-title`）证明仍能落到 `last-prompt` 兜底。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/cursor-session-name-preserve.test.ts` 退出码 0：磁盘上发现的 Cursor 会话先同步得到首行名，再经 `renameSessionById` 手工改名，随后重新同步（文件 mtime 变化），库里名字仍是手工名、`name_source` 为 `manual`；移除 `manual` 保护后该用例必须变红（在测试内用一个不带优先级判断的对照实现证明该用例能区分两者）。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/session-upsert-broadcast.test.ts` 退出码 0（在既有用例之外新增）：经真实 `renameSessionById`，订阅者收到恰好一条对应该会话、`summary` 为新名的 `session_upserted`；`ai-title` 升级经 watcher 刷新路径同样产生一条携带新名的 `session_upserted`。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-rename-route.test.ts` 退出码 0：经真实路由 `PUT /api/providers/sessions/:sessionId`（真实 express 应用 + 临时 sqlite）返回 200，库里 `name_source` 为 `manual`，随后会话列表接口读到新名；对不存在的会话返回 404 且不广播；空名与超过 500 字符仍返回 400（既有校验不回归）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0（含 boundaries 规则：新增测试只经模块 barrel 导入）。

## DoD

真实落地判据：不是仅有列、SQL 与测试文件存在。要求用一个真实临时 `DATABASE_PATH` 与真实 `HOME`（`~/.claude/projects` 下的临时 jsonl）启动真实服务端，走完整链路：由 App 路径新建一个会话（首句名 `derived`），向其 transcript 追加真实格式的 `ai-title` 行，等 watcher 触发同步；再用 `GET /api/projects/:projectId/sessions` 读到该 `ai-title` 为会话名、同一时刻 WebSocket 客户端收到带该名字的 `session_upserted`；然后经 `PUT /api/providers/sessions/:sessionId` 手工改名，再追加另一条不同的 `ai-title` 并触发同步，列表里的名字仍是手工名。把这一次运行的关键读数（三处名字、`name_source` 值、收到的事件）写进任务的 Evidence，AC 全部为真但没有这次端到端操作不算完成。实施时先按 `.agents/skills/backend-module-standards/SKILL.md` 的模块与 barrel 规范落位。

该轴仍暗，理由：纯服务端数据与同步逻辑，没有可独立度量的 L_D/L_G 读数；验收以上面的临时库集成测试和端到端运行读数为准。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/sessions.db.ts
- server/modules/database/index.ts
- server/modules/database/tests/sessions-name-source.integration.test.ts (new)
- server/modules/providers/index.ts
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/modules/providers/provider.routes.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/tests/claude-session-title-source.test.ts (new)
- server/modules/providers/tests/claude-sessions.test.ts
- server/modules/providers/tests/cursor-session-name-preserve.test.ts (new)
- server/modules/providers/tests/provider-token-usage.service.test.ts
- server/modules/providers/tests/session-rename-route.test.ts (new)
- server/modules/websocket/tests/session-upsert-broadcast.test.ts
- tasks/gap-session-name-source-ai-title.md

## Evidence

### 端到端运行（DoD）

真实服务端（临时 `DATABASE_PATH` + 临时 `HOME`，`HOST=127.0.0.1`、随机空闲端口）、真实 chokidar watcher、真实 HTTP 路由、真实 WebSocket 客户端（worktree 的 `ws`）。脚本与原始读数留在 `~/.quay-dod-gap-session-name-source-ai-title/`（`run-dod.mjs`、`readings.json`、`server.log`），连续三次运行读数一致。

三处名字与 `name_source`：

| 步骤 | 列表读到的名字 | 库里 `custom_name` | `name_source` |
| --- | --- | --- | --- |
| 1 App 路径新建（首句） | — | `How do I index` | `derived` |
| 2 watcher 首次索引 transcript（`last-prompt` 兜底） | `the first thing I typed` | `the first thing I typed` | `derived` |
| 3 追加 `ai-title: Indexing A Repository` | `Indexing A Repository` | `Indexing A Repository` | `ai` |
| 4 `PUT /api/providers/sessions/:id` 改名 | `Chosen By Hand` | `Chosen By Hand` | `manual` |
| 5 再追加 `ai-title: A Title Written Later` | `Chosen By Hand`（未变） | `Chosen By Hand`（未变） | `manual`（未变） |

WebSocket 客户端收到的事件（`atMs` 相对连接建立）：

- `6065ms` `session_upserted` `summary=Indexing A Repository`
- `6849ms` `session_upserted` `summary=Chosen By Hand`
- `12065ms` `session_upserted` `summary=Chosen By Hand` —— 第 5 步的重新索引：行确实被广播了，但优先级拒绝了新的 `ai-title`，所以携带的仍是手工名

事件归因：`server.log` 里恰好两条 `Session synchronization triggered by`（`add` 一条、`change` 一条；watcher 是 `usePolling: true, interval: 6000`），分别对应 `6065ms` 与 `12065ms`；`6849ms` 那条来自路由的改名，不是 watcher 路径。

本次运行与生产的一处差异（必须说明）：没有模型运行，就没有 SDK 分配的 provider-native id，transcript 只能写在 App 自己的 `session_id` 下，于是该行 `provider_session_id == session_id`，`COALESCE(session_id <> provider_session_id, 0)` 为 0，走的是 CLI 形态那一支。App 形态（两个 id 不等、`manual` 保护更强）由 AC-1 的集成用例覆盖。上表第 2 步首句名被 transcript 兜底名替换，正是这一支的预期行为。

### AC 读数

- AC-1 / AC-2 `sessions-name-source.integration.test.ts` 8/8，exit 0。迁移用例含全部要求：3 行、1 行 `custom_name` 为 NULL、连跑两次、两次之间把一行改成 `ai` 后第二次仍为 `ai`，并先断言夹具真的没有该列。
- AC-3 / AC-4 `claude-session-title-source.test.ts` 7/7，exit 0。流式上界实测 262,600 字节（`ai-title` 在第 5 行、其后约 24MB）；反例夹具无 `ai-title`，读满 13,570,629 字节并落到 `last-prompt` 兜底。
- AC-5 `cursor-session-name-preserve.test.ts` 1/1，exit 0。用例内带一个去掉优先级判断的对照写入，证明冲突写入真的会落地、只有优先级挡住了它。
- AC-6 `session-upsert-broadcast.test.ts` 8/8，exit 0（新增 2 条：改名一条、`ai-title` 升级一条）。
- AC-7 `session-rename-route.test.ts` 3/3，exit 0（200 + `manual` + 列表新名 + 恰好一条广播；404 且不建行不广播；空名/空白/501 字符/缺字段 400 且库里名字未动，500 字符接受）。
- AC-8 `npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning，0 error）。
- 另跑两个因新字段而改动的既有测试：`claude-sessions.test.ts` 22/22、`provider-token-usage.service.test.ts` 13/13，均 exit 0。
- 任务级门禁 `bash scripts/test.sh --for-task gap-session-name-source-ai-title --allow-thin` exit 0，5 个文件全绿。

### 反证（每条保护都有一个会变红的用例）

- 去掉 `incomingNameWinsSql` 里的优先级判断 → 3 条变红（数据库优先级 2 条 + Cursor 保留 1 条）；此时 AC-3 的改名用例仍绿，因为它是被同步器的提前返回独立保护的。
- 去掉同步器「只有已 `manual` 才保留旧名」的提前返回 → 1 条变红。
- 去掉流式早停 → 1 条变红（读数从 262,600 涨到 25,455,133 字节）。
- 去掉迁移回填 → 1 条变红。

### Touches 修正

原 Touches 里的 `server/modules/providers/list/cursor/cursor-session-synchronizer.provider.ts` 声明了但最终未改动：Cursor 覆盖手工名的修复落在 `sessions.db.ts` 的优先级判断里，同步器本身不需要改，故从 Touches 移除。另补上实际写入的 5 个文件：两个模块 barrel（`database/index.ts` 导出新类型、`providers/index.ts` 导出同步器给 websocket 测试用）、`provider.routes.ts`（`renameSessionById` 改为 `await`）、以及两个因 `name_source` 成为必填字段而必须调整的既有测试。
