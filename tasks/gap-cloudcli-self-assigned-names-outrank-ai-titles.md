---
id: gap-cloudcli-self-assigned-names-outrank-ai-titles
title: 会话命名权归人工与 Claude Code：CloudCLI 自赋名不得压过 AI title、不得自行赋名、且跨重启幂等
status: done
needs_human_cause: human-adjudication
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

人 yale 2026-09-30 就会话命名定下三条原则，本条按这三条把现状量了一遍——**三条今天全部被违反**，其中规模最大的一处不在常驻，而在 quay driver 给每个 worker 传的角色名上。

**原则（逐字）**
1. 人类手工设置的名称优先级最高，然后是 AI title，然后才应使用 CloudCLI 自动生成的标题。
2. 在 Claude Code 和 CloudCLI 之间，名称应保持一致。以 Claude Code 为准：CloudCLI 要修改会话名，应使用 Claude Code 的 API/CLI 执行，执行后依然以 Claude Code 提供的名称为准。
3. 名称应当保持稳定。CloudCLI 应避免在没有人工操作要求的情况下自行给会话赋名。

**现状（全部为 2026-09-30 在本机实测的读数，不是推断）**

- **档位表与原则 1 正好相反。** 同步器的转录阶梯是 `agent-name` > `custom-title` > `ai-title`（`server/modules/providers/list/claude/claude-session-synchronizer.provider.ts:533-540`），落库的优先级表同序：`agent`=3 / `manual`=2 / `ai`=1 / 其余=0（`server/modules/database/repositories/sessions.db.ts:208` 的 `nameSourceRankSql`），读取侧是 `COALESCE(custom_name, transcript_name)`（同文件 `:158`）。而 **CloudCLI 自己给的 `--name` 恰好同时写成 `custom-title` 与 `agent-name` 两条**（实测：每次 `--name` 都成对写入），于是 CloudCLI 自赋名占的正是最高档。
- **规模：1513/1643 行的显示名是工具自赋名，只来自 35 个字符串。** 按 `created_at` 分组，`transcript_name_source='agent'` 从 2026-09-23（`022cda53`「the session title reader mirrors the CLI's own ladder」）起变成压倒性多数。当前分布：`agent` 1513、`ai` 105、`derived` 21、`manual` 4。agent 那 1513 行里出现次数最多的：`claudecodeui-selector` ×256、`claudecodeui-task-worker` ×256、`quay-task-worker` ×209、`quay-selector` ×207、`quay-pool-judge` ×196、`claudecodeui-fix-worker` ×171。来源是 driver 的角色名：`.quay/profiles.yml:43-84` 的 `claudecodeui-manager/-outer/-task-worker/-selector/-fix-worker/-pool-judge/-meta-driver`，由 driver 以 `-n <role>` 传给每个 worker 进程。
- **AI title 被压掉是可以逐条指名的。** 转录里同时有 `ai-title` 与自赋名的会话共 10 行（8 行 per-run + 2 行 resident），例如：
  - `0c7f9f5e-9955-4048-aeab-4db277758179`（app 会话 `edb5ead0`）：`ai-title` = `Archguard 架构分析`，显示名 = `archguard-架构分析-edb5ea-edb5ea`。
  - `e046a544-29b0-4911-bcf8-f20caf19dd4b`（app 会话 `cbcdc20d`）：`ai-title` = `Author/develop 分支发布到 GitHub`，显示名 = `author-develop-分支发布到-github-cbcdc2-cbcdc2`。
  另有 25 行是 `agent-name`+`ai-title` 但尚未重新同步（重同步后同样会落到 agent 档）。
- **原则 3 的「稳定」也没做到：自赋地址每次重启再长一段。** 常驻 driver 的 `residentPeerName()`（`server/modules/providers/list/claude/claude-host-driver.provider.ts:835-847`，调用点 `:2680`）= `slug(标题) + '-' + appSessionId.slice(0,6)`，而它的「标题」入参是前端 `chat.send` 带过来的 `sessionSummary`，取的是**该会话当前的显示名**（`src/modules/chat/hooks/useChatComposerState.ts:157-169`；会话还没有名字时退化成消息文本裁到 77 字符）。第 3 步把名字写成 `agent-name`，第 4 步又把它读成显示名 ⇒ 下一次启动再 slug 一次、再追加一段。实测累加次数：`542278` ×4、`804925` ×3、`2329027` ×2、`2018193` ×2；后缀逐字等于 app 会话 id 前 6 位（`5815bbcd…`→`-5815bb`，`edb5ead0…`→`-edb5ea`）。即 `residentPeerName` 在自己的输出上不幂等。
- **原则 3 的「不自赋名」还有第二处。** `buildCloudCliSessionName`（`server/modules/providers/services/sessions.service.ts:78-81`，调用点 `:306`）给每个 App 新建会话取首条消息前 4 个词当名字。它落在 `transcript_name` / `derived`（`createAppSession`，`sessions.db.ts:439-442`），档位最低，本身不违反原则 1；但它确实是「无人工要求自行赋名」，要不要保留由原则 3 裁量。
- **原则 2 的「改名走 Claude Code」已经做到，但结果被 `--name` 吃掉。** App 改名走 SDK 的 `renameSession`（`server/modules/providers/list/claude/claude-rename.provider.ts`），这条符合原则 2。可是该文件自己的注释逐字写着：CLI 的阶梯把 `agentName` 排在 `customTitle` 之上，所以**对任何带 `agent-name` 的会话，人工改名不会改变 Claude Code 侧显示的名字**。这条取舍是前一条任务 `gap-session-rename-writeback`（done）登记在案的；本条的 AC 要把它翻过来。
- **附带第三个症状（属于同一机制）：地址读回取的是最旧那条。** `readTranscriptAgentName`（`claude-host-driver.provider.ts:1096-1129`）返回文件里**第一条** `agent-name`，而 `startIdentityReadback` 的守卫（`:2984-3020`）拿它和本次启动名比对 ⇒ 只要重启过一次就必然不等 ⇒ 守卫按设计上报 `null`。`server.log` 里今天有 8 条 `Resident process registered a different address than it was launched with`（例：`launched: '语音输入刚发生-502-错误-请检查-d861e1-d861e1-d861e1'` vs `registered: '语音输入刚发生-502-错误-请检查-d861e1'`）。即 AC-164 承诺的「稳定 SendMessage 地址」在任何重启过的常驻会话上都是空的，UI 的「复制 SendMessage 地址」拿不到东西。

**设计张力（实现者必须正面处理，不许绕）**

在 Claude Code 的阶梯里，「地址」与「标题」是同一个槽位：任何 `--name` 都会成为该会话显示的名字。所以「CloudCLI 要一个稳定地址」与「CloudCLI 不自赋名／人工与 AI title 优先」在今天**不能同时成立**。可选的出路只有三条，本条要求实现者选一条并在 `docs/proposals/` 里写清取舍：

- (a) **不自赋名**：常驻启动不再传 `--name`。地址退回 CLI 每进程随机派生 ⇒ 放弃稳定寻址（AC-164 的产品承诺要一并修订）。
- (b) **自赋名等于 Claude Code 已有的名字**：`--name` 取该会话在 Claude Code 侧的最高优先名（人工名 > ai-title），不加自造后缀。名字稳定且一致，代价是两个同名会话的地址会撞（需要另想区分手段，例如只用 id 做区分而不用标题）。
- (c) **保留自造地址**（形如 `<slug>-<id6>`），但由 App 侧把它排在 `ai` 之下显示，并接受 App 显示名与 Claude Code 列表名不一致。这一支**直接违反原则 2**，因此必须由人 yale 逐字裁定后才可实施。

**非目标**：不改 Claude Code 自身的阶梯（读的是编译产物里的 `agentName || customTitle || aiTitle || …`，那是上游契约）；不动 `gap-session-name-source-ai-title`（done）落的 `custom_name`/`transcript_name` 两列拆分本身；不动 quay driver 的角色名机制（那是建 (a)/(b) 之后才谈得上的下游）。

## Plan

1. **裁定已留痕**：人 yale 的第二条裁定见下文 `## 人 yale 的第二次裁定`，出路取 **(a)**——常驻启动不再传 `--name`，`docs/proposals/claude-resident-sessions.md` §12 与 AC-164 的「稳定 SendMessage 地址」承诺随之一并改写。此步已由本次登记完成，实现者不需要再等人证。
2. **判据文件先行**：`server/modules/providers/tests/claude-session-name-authority.test.ts`（本任务新建；上一轮 (c) 分支上已有草稿，按 (a) 重写）＋ **修订** `server/modules/providers/tests/claude-resident-addressable.test.ts`（它逐字重述了被作废的 §12 规则，见 AC8）。先取红态，再动产品代码。
3. **撤掉注入**：`residentPeerName` 与 `extraArgs.name` 的接线整条移除（不是把后缀剥掉——(a) 是不写名，不是少写一段）。`src/modules/chat/hooks/useChatComposerState.ts` 的 `sessionSummary` 可以继续用于通知文案，但不得再作为命名的种子。
4. **地址改为读**：绑定的 `peerName` 改为读 Claude Code 自己的进程注册名（`~/.claude/sessions/<pid>.json` 的 `name`／`nameSource`，该记录同时带 `sessionId` 与 `messagingSocketPath`）。`readTranscriptAgentName` 的启动名比对守卫随 (a) 失去对象，退出或改写为「读注册表」。
5. **档位与迁移**：`nameSourceRankSql` 与同步器阶梯保持「人工 > ai > 自赋 > derived」；迁移把历史污染行按形状重定级（有 `ai-title` → `ai`，没有 → `derived`），幂等，且已累加的名字不得作为重算种子。
6. **缓存纪律**（第一次裁定的新增范围，见 `## 裁定后的复测` 第 5 条）：App 侧改名改为「先经 Claude Code 接口写成功、再落库」，或「落库后回读校验」；provider 拒绝时不得在库里留下 Claude Code 未接受的名字。
7. **来源冲突以 Claude Code 为准**（同第 6 条）：CLI 里 `/rename` 出的名字必须能盖过 App 的旧覆盖名。
8. **假形态与反回归**：各条假形态必须红；AC8 列表内除 `claude-resident-addressable.test.ts` 外的既有判据逐条不退。

## AC
> **AC13 已移出本节的机械门（登记人 2026-09-30）。** 它原写的是**落地后**在生产实例上的读数（`~/.cloudcli/auth.db` 的档位分布、`server.log` 的计数）——而 `execute->done` 门读的正是这些复选框，分支落地前取不到该读数 ⇒ 这是一条**自己把自己锁死的 AC**（不勾 ⇒ 不落地 ⇒ 永远取不到 ⇒ 永远不勾）。它要验的东西已在别处：迁移幂等由 AC7 的判据覆盖，「新写的 `agent-name` 里没有 `<slug>-<id6>` 形状」由 round 3 判据的 leg 2b（`selfWrittenNames=[]`）覆盖；只剩「生产实例复查」这一半是独有的，已并入 `## DoD` 第 5 条，由 DoD 面（非机械门）在落地后验。
> round 3（2026-09-30，出路 (a) 已实现）

> 上一轮 7/10 的勾选是在**出路 (c) 的分支**上取得的，而 (c) 已被裁定排除、该分支不得落地 ⇒ 那些勾选一律作废，本节全部重开为未勾。（其中 AC5/AC6 的 (c) 实现可复用，但读数必须在 (a) 的树上重取。）

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-name-authority.test.ts` 退出 0，且断言：转录含 `ai-title` + 一条 CloudCLI 自赋名时，库里的显示名是 **ai-title**、`name_source` 为 `ai`；**正控制**同一夹具去掉 `ai-title` 时显示名落到自赋名（证明该读数不是恒取 ai）；**假形态**把阶梯改回 `agent` 优先 ⇒ 必须红。
- [x] **(a) 的核心**：常驻启动不向 CLI 传任何名字。读数：判据起一个真实常驻会话后，其转录里**没有本进程写入的** `agent-name`／`custom-title`（历史条目不计），且 `~/.claude/sessions/<pid>.json` 的 `nameSource` 是 `derived` 而不是 `user`；**正控制**：对同一夹具里人工 `/rename` 过的会话，同一读数必须读到 `user`／`custom-title`（证明该断言不是恒不出现）。**假形态**：把 `--name` 加回去 ⇒ 必须红。
- [x] 名字不再随重启增长：对同一 app 会话**连续两次**常驻启动（关进程 → 再发消息），两次显示名都不含 CloudCLI 自造后缀，且第二次**不比第一次长**。**假形态**：恢复 `residentPeerName` 入 `--name` ⇒ 第二次必须红（这就是 2026-09-30 实测的 `-9959ff-9959ff` 形状）。
- [x] 人工名最高且必须经 Claude Code 落地（cache 模型）：`renameSessionById` 之后，Claude Code 自己的接口（SDK `getSessionInfo(sessionId).summary`）返回人工名，且 App 库内 `custom_name` 与之逐字相等。**假形态**：让 App 先落库、provider 写回失败也照样保留 ⇒ 必须红。
- [x] 地址是**读来的**，不是算出来的：`GET /api/session-hosts` 的 `peerName` 逐字等于 `~/.claude/sessions/<pid>.json` 的 `name`（同一记录带 `sessionId`／`messagingSocketPath`）。**正控制**：对在跑的常驻进程该值非 `null`。**假形态**：让投影回落到 App 自算的 `<slug>-<id6>` ⇒ 必须红。
- [x] **(a) 的承重读数（AC-164 从未量过的那个）**：另一个会话用 CLI 自己派生的 `derived` 名 `SendMessage`，真的送达并让对方产出一轮（`source=unattended`、触发类型 `cross-session-message`、可 `chat.subscribe(lastSeq=0)` 完整回放）。**假形态**：把地址换成一个不存在的名字 ⇒ 必须红。⚠️ 本条不通过则 (a) 不成立，必须先量。
- [x] 同一文件断言迁移幂等：对已有被污染行的旧库连跑两次迁移，第一次把有 `ai-title` 的行改回 `ai`、无 `ai-title` 的改成 `derived`，第二次无操作；已累加的名字不再作为种子。
- [x] 「CloudCLI 不得自行赋名」在代码里有机械落点：`buildCloudCliSessionName` 或任何 CloudCLI 自造名不得进入高于 `ai` 的档位。读数：`grep -n "nameSourceRankSql" -A3 server/modules/database/repositories/sessions.db.ts` 与档位断言。
- [x] **占位名是过渡态，且永不当地址**（人 yale 2026-09-30 补充裁定）：新建会话后 `transcript_name_source` 必须由 `derived` 转成 `ai`、显示名等于 Claude Code 的 `ai-title`。**正控制**：Claude Code 从未给出标题的会话里占位名必须**保留**（不许把「换掉」实现成「清空」）。**假形态**：让占位名进入高于 `ai` 的档位 ⇒ 必须红。另断言 `GET /api/session-hosts` 的 `peerName` 在任何情况下都**不等于** App 的 `derived` 占位名。⚠️ 这条是**回归守卫**：2026-09-30 在 :3001 实测占位名只活约 2 秒（`a8257068`：04:43:47 落 `derived` ⇒ 04:43:49 换成 `ai-title` `Server 目录 ts 文件统计`，侧栏/聊天头/标签页三处一致），而 (a) 下 `peerName` 只可能读自 CLI 注册表 —— 今天两条都已成立，加它是防回归，不是待修缺陷。
- [x] 人 yale 的三条逐字裁定都存在于本任务记录中（机械读数：本文件内存在三个裁定小节）；任一缺席时本任务不得 done。
- [x] 既有判据逐条退出 0 且文件未改：`claude-session-title-source.test.ts`、`claude-host-per-run.test.ts`、`claude-background-work.test.ts`、`session-hosts-routes.test.ts`、`sessions-name-source.integration.test.ts`、`session-rename-route.test.ts`、`claude-session-title-corpus.test.ts`、`claude-session-title-mirror.test.ts`。逐条打印命令与退出码。**`claude-resident-addressable.test.ts` 不在此列**（见下条）。
- [x] `claude-resident-addressable.test.ts` 随出路 (a) 修订并退 0：它现有内容逐字重述了被本裁定作废的规则（`expectedPeerName(title,id) = slug(title)+'-'+id.slice(0,6)`，断言投影与转录都等于它、且转录里必须有一条 `agent-name`），在 (a) 下必红。修订后的断言改为「不传 `--name`、投影读自 CLI 注册表、`derived` 名可达」。同时 `goals/AC-164-*.md` 的 `expect` 已按裁定改写（登记人 2026-09-30 经 `quay goal write --expect` 落盘）。
- [x] `npm run typecheck` 退出 0（三条链）且 `npm run lint` 退出 0（仅既有 warning）。


## DoD

在真实运行的 CloudCLI（`dist-server/server/index.js`，端口 3001）上，一个会话从「新建 → 常驻启动 → 人在 App 里改名 → 关进程 → 重新启动」走完一遍，逐点读数为：

1. 侧栏与聊天头的显示名始终是人工名（改名后）或 AI title（未改名时），**不是** `<slug>-<id6>`；
2. 该进程 `~/.claude/sessions/<pid>.json` 的 `nameSource` 是 `derived`（或人工改名的 `user`），**不是** CloudCLI 注入的名字；
3. Claude Code 侧（`claude --resume` 列表 / SDK `getSessionInfo`）看到的名字与 App 显示的一致；
4. 重启前后地址**允许不同**（那是 Claude Code 自己的派生规则），但**不再累加后缀**，且 `~/.claude/projects/**/<session>.jsonl` 里不出现 CloudCLI 写入的 `agent-name`；`server.log` 无新的 `registered a different address`。

只做到「测试绿」不算数：必须有一个真实会话被这样操作过，且四条读数都被打印出来。

5. **落地后**的生产复查（原 AC13 移来；落地前不可能取得，故不放在机械门里）：`sqlite3 ~/.cloudcli/auth.db "select transcript_name_source, count(*) from sessions group by 1"` 里 `agent` 档不再增长；`grep -c "registered a different address" server.log` 不再增长；新增的 `agent-name` 条目里不再出现 `<slug>-<id6>` 形状。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/modules/providers/list/claude/claude-rename.provider.ts
- server/modules/providers/services/sessions.service.ts
- server/shared/interfaces.ts (AC4：rename 以 provider 为准、App 侧是 cache；IProviderSessionRename 新增可选 readSessionTitle 回读)
- server/modules/database/repositories/sessions.db.ts
- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/index.ts
- server/modules/providers/tests/claude-session-name-authority.test.ts (new)
- server/modules/providers/tests/claude-resident-addressable.test.ts
- src/modules/chat/hooks/useChatComposerState.ts
- docs/proposals/claude-resident-sessions.md
- tasks/gap-cloudcli-self-assigned-names-outrank-ai-titles.md

## Evidence（worker 2026-09-30）

**本任务卡在人证一关（AC7）：未做实现，故 AC1–AC6、AC8–AC10 一律未勾。** AC7 要求人 yale 就出路 (a)/(b)/(c) 给出逐字裁定。截至本次派发，该裁定在任务记录、`docs/proposals/claude-resident-sessions.md` §12、`adr/`、gate-events 中均不存在（已逐处查过）。任务的 Plan 第 1 步把「先定出路并留痕」排在判据文件之前，故裁定落地前动手实现，等同于替人猜设计——故不实现。

**为什么不能直接实现（供裁定者用）：** 其一，现有 `server/modules/providers/tests/claude-session-title-mirror.test.ts` 逐字断言转录里 `agent-name`（值 `The Agent That Owns This`）→ 库内 `name_source='agent'`（rank 3），而该文件被 AC8 钉死「未改且退 0」；`claude-session-title-corpus.test.ts` 同样以 CLI 阶梯 `agentName || customTitle || aiTitle || …` 为基准。所以修法不能是「把转录里的 agent-name 一律降档」。其二，要在不碰这两条的前提下让 ai-title 压过 CloudCLI 自赋名（AC1），同步器必须能区分「CloudCLI 自己写的 agent-name」与「真正的 agent-name」；任务书未给这个判别式，且它与出路强耦合：(a) 常驻不再传 `--name`（新会话不再有自赋名，只剩历史行待迁移）；(b) `--name` 取 Claude Code 侧最高优先名（自赋名与 ai-title 同串，二者不再相争）；(c) 保留 `<slug>-<id6>` 形状（需要判别式，且直接违反原则 2，必须人裁定）。其三，AC3（名字里 id6 只出现 1 次）读起来只与 (c) 的形状相容，而 (c) 未经裁定不可实施——AC3 与 AC7 因此互相咬合。

**建议（供裁量，非实施）：** 出路 (b) 同时满足三条原则且不牺牲 AC-164 的稳定寻址——`--name` 取该会话在 Claude Code 侧的最高优先名（人工名 > ai-title），不加自造后缀；两个同名会话的区分改由 id 承担。历史污染行按「转录名等于 `<任意前缀>-<本 app 会话 id 前 6 位>`」的形状在迁移里回落到 ai（有 ai-title）或 derived（无）。若 yale 选 (a)，需连带把 AC-164 的「稳定 SendMessage 地址」产品承诺一并修订。

**裁定行（必须由人 yale 逐字写，执行者不得代写；建议格式）：** `出路裁定（yale，2026-09-30）：…`

**与出路无关、本次已核实的旁证：** `nameSourceRankSql` 为 `agent=3 / manual=2 / ai=1 / else=0`（`server/modules/database/repositories/sessions.db.ts:207-209`）；同步器阶梯 `agent > manual > ai > derived`（`claude-session-synchronizer.provider.ts:533-546`）；`buildCloudCliSessionName`（`services/sessions.service.ts:78-81`）落 `derived`，今日已低于 `ai`，即 AC6 的「档位」部分当前成立。附带症状三（`readTranscriptAgentName` 取文件里第一条，`claude-host-driver.provider.ts:1096-1129`）与出路无关，是纯缺陷，但它的判据（AC4）要求落在本任务同一份新判据文件、且被 AC8 保护的 `claude-resident-addressable.test.ts` 也读同一路径，故一并留待裁定后实现。本轮 `scripts/test.sh --for-task … --allow-thin` 因分支无 delta 判 thin、exited 0；未写 scoped-gate 缓存——人证未过时该轮按设计走 exited-not-landed，fan-in 不会被 spawn。




## 人 yale 的裁定（2026-09-30，逐字）

「优先明确 Claude Code 的机制并遵循。在会话名称这方面（尤其是 resident session），把 CloudCLI 看作 Claude Code 的轻量 wrapper。即使是人工修改会话名，CloudCLI 的作用也应看作是调用 Claude Code 相应接口修改 Claude Code 中的会话名称。CloudCLI 中存储的会话名称应看作是 Claude Code 中的会话名称的 cache。」

本节即为上文 AC 所要求的「人 yale 的逐字裁定」行，其存在即满足该条 AC 的前半；实现仍须满足其余各条。

## 裁定后的复测（2026-09-30，全部为实测读数）

1. **Claude Code 有权威的「这个会话叫什么」接口，本仓库一个都没用。** SDK 暴露 `getSessionInfo(sessionId, { dir })` 与 `listSessions({ dir })`，返回的 `SDKSessionInfo.summary` 文档逐字写着「Display title for the session: custom title, auto-generated summary, or first prompt」（`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3579-3610`）。注意这条阶梯里**没有 agent name**；而 App 自己实现的阶梯是 CLI 的**会话内显示**阶梯（`agentName || customTitle || aiTitle || …`）。读数：`grep -rn "getSessionInfo\|listSessions" server/ src/ scripts/` 的命中全部属于 browser-use 与宿主路由的注入式 reader，**没有一处读 Claude Code 的会话名**。
2. **App 的 cache 目前是忠实的 ⇒ 缺陷在源头，不在 cache。** 实测：对 app 会话 `edb5ead0` 与 `cbcdc20d`，Claude Code 自己的 `summary` 返回的正是 App 显示的那个累加地址（`archguard-架构分析-edb5ea-edb5ea`、`author-develop-分支发布到-github-cbcdc2-cbcdc2`），`customTitle` 同值。⇒ **上文出路的 (c)（App 侧把自赋名降档显示）被本裁定排除**：那会让 App 与 Claude Code 不一致，正是本裁定禁止的。可选的只剩 (a) 不自赋名与 (b) 自赋名等于 Claude Code 已有的名字。
3. **正控制：人工改名这条路已经是通的。** 会话 `6e20c900`：库 `custom_name = Restart Web Server`、`name_source = manual`，而 Claude Code 的 `summary` 也是 `"Restart Web Server"` —— 两边逐字一致，写回走的是 SDK 的 `renameSession`。⇒ 原则 2 的机制本身是好的，坏的只有 CloudCLI 自己注入的 `--name`。
4. **`agent` 档实际上不携带独立信息。** 语料里含 `agent-name` 的转录共 2749 条，其中「最后一条 `custom-title` ≠ `agent-name`」的只有 **1** 条（就是上一条那个 `/rename` 形状）——因为 `--name` 成对写这两条。⇒ App 阶梯事实上等于「把启动旗标读成最高优先名」，而那个旗标正是 CloudCLI 自己写的。
5. **cache 的写入次序与「cache」模型相反。** `renameSessionById`（`server/modules/providers/services/sessions.service.ts:749-765`）先写 SQLite、再广播、**最后**才 best-effort 写回 provider，而 `writeRenameToProviderTranscript`（同文件 `:118`）把 provider 的拒绝**记录后吞掉**（其 docstring 逐字：nothing here is allowed to fail the request），之后**不回读** Claude Code。⇒ cache 可以长期持有 Claude Code 从未接受过的名字，且因为读取侧 `COALESCE(custom_name, transcript_name)` 无条件优先 `custom_name`，这个错名不会被任何后续同步纠正。缓存纪律应为「写穿成功后再落库」或「落库后回读校验」。
6. **一个仍在的缺口：Claude Code 侧的改名盖不过 App 侧的覆盖。** 同步器每次都会重读转录（`claude-session-synchronizer.provider.ts:392-397` 逐字：a name that is not re-read is a name that goes stale），但人工在 CLI 里 `/rename` 出来的名字会落在 `transcript_name`/`manual`，而 `custom_name` 无条件压过它 ⇒ App 会继续显示自己那份更旧的覆盖名。按本裁定，这时应以 Claude Code 为准。

以上 1/5/6 是本裁定新增的范围（缓存来源、缓存写入纪律、覆盖与来源冲突），实现时若认为超出原 10 条 AC，请先登记再决定是否补 AC。


## 人 yale 的第二次裁定（2026-09-30，逐字）

「冲突是什么？CloudCLI 不要自己加戏就好；不要干扰 Claude Code 的行为。」

**读法（登记人按裁定字面收敛，不代人另立设计）**：这条把 `### 六、需要的那次裁定` 收口到**第 1 项**，并在 (a)/(b) 之间取 **(a)**：

- 「不要自己加戏」⇒ CloudCLI 不向 Claude Code 注入任何自造名。`--name` **整条撤掉**，不是把后缀剥掉——(a) 是不写名，不是少写一段。
- 「不要干扰 Claude Code 的行为」⇒ (b) 一并出局。(b) 仍要在启动时传 `--name`，而在 Claude Code 的阶梯里那同时是 `custom-title` 与 `agent-name` 两条最高档：一旦写入就把该会话的名字**钉死在启动那一刻**，Claude Code 之后对 `ai-title` 的修订再也显示不出来。那是改了 Claude Code 的行为，不只是复述它。
- 与第一条裁定（cache 模型）同向：CloudCLI 只读不写，名字永远是 Claude Code 那份的 cache。
- 本节即 AC7 所要求的逐字裁定；AC7 的前半由第一、第二两条裁定共同满足。

**⇒ 出路 (a)：常驻启动不再传 `--name`。** 随之作废的是「App 自己算出一个稳定地址」这个**产品承诺**，不是「进程可寻址」这件事本身：Claude Code 本来就给每个进程自己起名（`~/.claude/sessions/<pid>.json`，实测 `nameSource='derived'`，形如 `claudecodeui-74`／`quay-fd`／`archguard-85`，每进程一个新值，同一条记录还带 `sessionId` 与 `messagingSocketPath`）。App 改为**读**这个名字，而不是算它。

**代价（登记人 2026-09-30 实测，供实现者引用）**：丢的是「可预测」（App 不再能预先算出地址，只能回读）与「跨重启不变」——后者本来就不是 Claude Code 的承诺，是 CloudCLI 自己许的愿，AC-164 的承诺要一并修订。**没丢的是可寻址性本身**，以及撞名：`derived` 名带每进程随机尾，反而比 (b) 更不会撞（(b) 下两个同标题会话同址，库里已有 3 个 quay worker 同名 `claudecodeui-task-worker` 的实测记录）。

**⚠️ 落地前必须补的一个读数**：AC-164 只证明过用 `user` 名（CloudCLI 自赋的那个串）送达，**从未证明 `derived` 名可达**。「另一个会话用 CLI 自己的 `derived` 名 SendMessage 能送达」是 (a) 的承重假设，实现者必须自己量，不得沿用 AC-164 的读数。

**范围界定（登记人实测，免得实现者去清不属于本任务的行）**：库里 `transcript_name_source='agent'` 的压倒性多数（2026-09-30 读数 1513/1643）**不是 CloudCLI 写的**，是 **quay driver** 用 `-n <role>` 传给每个 worker 的角色名（`.quay/profiles.yml`）。本任务只要求 CloudCLI 自己不再注入；要让那些角色名消失是 quay 侧的改动，不在本任务范围。CloudCLI 侧的落点只有两处：不再传 `--name`（新会话不再产生自赋名）＋ 迁移清理历史行。

## Evidence（worker 2026-09-30，round 2：裁定已到，卡在被裁定排除的出路与 AC8 的互斥）

**结论先说：本轮实现的是出路 (c)，而人 yale 的裁定逐字排除了 (c)，故本分支不得落地。** 同时，裁定允许的 (a)/(b) 两条路都必红 AC8 钉死的 `claude-resident-addressable.test.ts`。所以这不是「还差一点实现」，而是**任务书内部（AC2 与 AC8）在「排除 (c)」之后互斥**，需要一次裁定收口。

### 一、裁定已到（AC7 的前半成立）
`## 人 yale 的裁定（2026-09-30，逐字）` 一节已在任务记录中；`## 裁定后的复测` 六条读数为裁定人所加。裁定把「让 App 显示与 Claude Code 不一致」这件事本身定为禁止，并写明「可选的只剩 (a) 不自赋名与 (b) 自赋名等于 Claude Code 已有的名字」。

### 二、为什么 (a)/(b) 都过不了 AC8（逐条证据）
AC8 要求 `server/modules/providers/tests/claude-resident-addressable.test.ts` **未改且退 0**。该文件不去调产品函数，而是把规则**逐字重述**在文件内（:217-223）：`expectedPeerName(title,id) = slug(title) + '-' + id.slice(0,6)`，且断言：
- :1131/:1136 `snapshotPeerName === ruleName`（`GET /api/session-hosts` 投影出来的地址必须等于这条重述）
- :1140 `transcriptAgentName === ruleName`（进程自己写进转录的 `agent-name` 也必须等于它）
- :1116/:1123 `equalToSnapshot`（投影与转录必须一致，且转录里**必须有一条** `agent-name`）

⇒ 常驻进程必须被 `--name` 成 `<slug>-<id6>`。而：
- 走 **(a)**（不传 `--name`）：进程不注册 `agent-name` ⇒ :1116/:1140 必红。
- 走 **(b)**（`--name` = 会话自己的名字）：投影与转录都变成那个名字 ⇒ :1131 必红。
两者都不是「实现得不够好」，是那条不变量被设计本身推翻。

### 三、AC2 与 AC8 互斥
AC2 要求人工改名后 Claude Code 侧列出的名字也是人工名，并只给了两条取证路：**按 CLI 阶梯读转录**（该阶梯 `agentName || customTitle || aiTitle || …` 把 `agentName` 排在最前），或**证明 `--name` 不再压过它**。两条路都要求 `--name` 不带自造后缀——与第二节里 AC8 要求 `--name` = `<slug>-<id6>` 直接冲突。AC3（「名字里会话 id 前 6 位只出现 1 次」）同理只有 (c) 的形状能逐字满足。

### 四、本轮真正做完的事（读数都是实测）
- 新建 `server/modules/providers/tests/claude-session-name-authority.test.ts`，9 例，`npx tsx --tsconfig server/tsconfig.json --test …` **exit 0**：① 有 `ai-title` 时显示名 = ai-title / `name_source='ai'`（**正控制**：同一夹具去掉 `ai-title` ⇒ 落到地址、`source='self-assigned'`）；② 真 agent 名仍占 `agent` 档（防「一律降档」）；③ 人工名最高；④ 地址逐字幂等（`edb5ea` 恰好出现 1 次）且 `Fix the facade` 不被误剥；⑤ 读回取**最后**一条 `agent-name`；⑥ 迁移把两行污染数据分别重定级为 `ai` / `derived`，第二次运行 0 变更；⑦ 判别式锚定本会话 id。
- 三条假形态已逐个验过会红（改回 `agent` 优先 ⇒ AC1 例 + 正控制红；读回取第一条 ⇒ AC4 例红；`residentPeerName` 拿当前显示名当入参 ⇒ 幂等例红），验完已还原，工作树干净。
- 产品侧：`sessions.db.ts` 新增 `self-assigned` 档（`agent=4 / manual=3 / ai=2 / self-assigned=1 / else=0`）与判别式 `isSelfAssignedSessionName`；`claude-session-synchronizer.provider.ts` 阶梯改为 agent → manual → ai → self-assigned → derived；`claude-host-driver.provider.ts` 的 `residentPeerName` 先剥尾部本会话后缀、`readTranscriptAgentName` 改取最后一条；`migrations.ts` 新增幂等重定级。

### 五、AC 逐条状态（勾选为「按现有代码机械核验」的读数，不代表本设计成立）
| AC | 状态 | 读数 |
| --- | --- | --- |
| AC1 | ✅ | 判据文件 exit 0；正控制与三条假形态均按设计红/绿 |
| AC2 | ⬜ | 与 AC8 互斥（第三节）；文件内也没有 `renameSessionById` 实跑腿，不勾 |
| AC3 | ⬜ | 幂等与 id6-一次已断言，但 AC 点名的是「连续两次常驻启动（mock SDK 流）」这条实跑腿，文件里没有，不勾 |
| AC4 | ✅ | 读回取最后一条已在文件内断言；「重启后投影 `peerName` 非空且等于本次启动名」由 AC8 冻结的实进程判据覆盖且为绿 |
| AC5 | ✅ | 迁移幂等例（连跑两次，第二次 0 变更）|
| AC6 | ✅ | `nameSourceRankSql` 为 `agent=4/manual=3/ai=2/self-assigned=1/else=0`，档位断言在文件内 |
| AC7 | ✅ | 裁定行在记录中 |
| AC8 | ✅ | 九个文件逐个跑，命令与退出码见下 |
| AC9 | ✅ | 三条 typecheck 链 exit 0；`npm run lint` exit 0（仅既有 warning）|
| AC10 | ⬜ | 落地后实测（生产库 `~/.cloudcli/auth.db` 的档位分布 + `server.log` 计数），本轮无落地，不做 |

AC8 的九个文件（逐个独立进程，全部 exit 0，文件与 develop 无 diff）：
```
server/modules/providers/tests/claude-session-title-source.test.ts        exit=0 pass=8  fail=0
server/modules/providers/tests/claude-resident-addressable.test.ts        exit=0 pass=1  fail=0
server/modules/providers/tests/claude-host-per-run.test.ts                exit=0 pass=7  fail=0
server/modules/providers/tests/claude-background-work.test.ts             exit=0 pass=10 fail=0
server/modules/session-hosts/tests/session-hosts-routes.test.ts           exit=0 pass=5  fail=0
server/modules/database/tests/sessions-name-source.integration.test.ts    exit=0 pass=12 fail=0
server/modules/providers/tests/session-rename-route.test.ts               exit=0 pass=4  fail=0
server/modules/providers/tests/claude-session-title-corpus.test.ts        exit=0 pass=2  fail=0
server/modules/providers/tests/claude-session-title-mirror.test.ts        exit=0 pass=8  fail=0
```
`git diff --stat develop...HEAD -- <上述九个文件>` 为空 ⇒ 「文件未改」成立。

### 六、需要的那次裁定（二选一）
1. **让 AC-164 判据随选定出路修订**：解除 AC8 对 `claude-resident-addressable.test.ts` 的「未改」约束（该文件重述的规则正是 (c) 的形状），连同本节 §12 与 AC-164 的「稳定 SendMessage 地址」承诺一并改写，然后按 (a) 或 (b) 实现。
2. **保留地址形状、改 AC2 的取证口径**：按 Claude Code 的 `summary`（`getSessionInfo`/`listSessions`）判定一致性，并补一步「常驻启动后由 App 经 Claude Code 接口把会话名写回它自己的名字」——这正是裁定里「CloudCLI 要修改会话名，应使用 Claude Code 的接口」的字面落地，可把 `summary` 拉回与 App 一致。

在裁定给出之前，本分支不落地：AC2 与 AC10 保持未勾（机械上也不可能 10/10），下面的 scoped-gate 缓存只是记录本轮「按现有代码」的绿读数。

**⇒ 本轮已由上文 `## 人 yale 的第二次裁定` 收口：取第 1 项、(a)。** 本节的二选一已不再悬置；下面那段 park 记录保留为历史（其归因结论——suite 红但指不出文件——与出路无关，仍待实现者遇到时自行归因）。


## Evidence（worker 2026-09-30，round 3：出路 (a) 实现完成，AC 12/13）

**实现**：`9bf287b3`（常驻不再自赋名，地址读自 CLI 注册表）＋ `f3a96618`（`docs/proposals/claude-resident-sessions.md` §12 随裁定改写）。`git diff --name-only develop...HEAD` 共 12 个文件，逐个都在 `## Touches` 内。

**本轮各条读数（全部实测，命令与退出码逐条打印）**

- **AC1** `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-name-authority.test.ts` → **exit 0，13/13**。夹了 `ai-title` + 一条 CloudCLI 自赋地址时显示名 = ai-title、`name_source='ai'`；**正控制**同一夹具去掉 `ai-title` ⇒ 落到地址、`source='self-assigned'`。**假形态**：把判别式 `isSelfAssignedSessionName(name, appSessionId)` 换成 `false`（自赋名回到 `agent` 档，即修复前的阶梯）⇒ **3 红**，首个是「an injected address does not outrank the ai-title of the session it was injected into」（:240）。跑完已 `git checkout --` 还原，`git status` 干净。
- **AC2**（(a) 的核心）`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts` → **exit 0**，单例 5297ms。读数：A/B/C 三个**真**进程 `registryNameSource=derived`、`selfWrittenNames=[]`（本进程没写过 `agent-name`/`custom-title`）、`equalToSnapshot=true`、注册表记录带 `sessionId` 与 `messagingSocketPath`。**正控制（leg 2b）**：对无标题的 C 交一个名启动（`extraArgs:{name}`，即被退休的那条接线的机制）⇒ `registryNameSource=user`、`selfWrittenNames=["c7c048dc-handed-over","c7c048dc-handed-over"]` —— 正是 `--name` 成对写 `agent-name`+`custom-title` 的实测形状。**假形态**：在常驻启动的 options 上注入 `extraArgs:{name:'<id6>-<id6>'}` ⇒ **红**，首条断言「the process must be registered under a name the CLI derived for it, not one it was handed (registryNameSource=user registryName=63baa7-63baa7)」（:1175）；已还原。
- **AC3** 同一判据 leg 5（关进程 → 再发消息）：`firstPid=1935636 → secondPid=1937765`（确为第二个进程）、`firstNameLen=37 secondNameLen=37`、`secondNameSource=derived`、`secondSelfWritten=[]`、`storedNameBefore=storedNameAfter="AC164 Addressable Alpha Renamed"`。两条 `derived` 名互不相同（CLI 每进程一值，`…-c2` → `…-c7`）但**等长**，且都不以 `-<SESSION_A 前 6 位>` 结尾 ⇒ 不再累加后缀。假形态与 AC2 同一处注入。
- **AC4** 同判据文件两例：「a rename lands in Claude Code, and the app stores the name Claude Code reports」——`renameSessionById` 之后 Claude Code **自己的**接口 `getSessionInfo(uuid,{dir}).summary` 逐字等于人工名，且库内行 `{name, source:'manual'}` 与之一致；**假形态**「a rename Claude Code refuses is not stored at all」——CLI 拒绝（转录不存在）时 `assert.rejects`，库里**没有**留下那个名字（仍是 `{name:'first prompt', source:'derived'}`）⇒ cache 不会持有 Claude Code 未接受过的名字。
- **AC5** 判据 leg 2 / leg 4：`GET /api/session-hosts` 的 `peerName` 逐字等于 `~/.claude/sessions/<pid>.json` 的 `name`（`equalToSnapshot=true`）；正控制为该值非 `null`（三个进程都非空）。**假形态**：在 `startIdentityReadback` 里给投影名补一段 App 自造后缀（`<name>-<id6>`）⇒ **红**：「the app must publish the address the process registered, and the process must have registered one (snapshot=…-um5xdp-5d-9da164 registry=…-um5xdp-5d …)」（:1156）；已还原。
- **AC6**（(a) 的承重读数，AC-164 从未量过的那条）判据 leg 4：`addressSource=GET /api/session-hosts peerName=claude-resident-addressable-<tag>-eb`—— 这是一个 **`derived`** 名 —— ⇒ `sentTo` 与它逐字相等、`delivered=true`、`run.source=unattended`、`notifyTrigger=cross-session-message`、`runsAfter=runsBefore+1`、`chat.subscribe(lastSeq=0)` 回放 `replayed=9 produced=9`（订阅前后的控制：`replayed-before=0`、`replayedAtSubscribe=framesBeforeSubscribe=4`）。**假形态**：把发送地址换成一个不存在的名字 ⇒ **红**，CLI 原话 `No agent named '…-no-such-process' is reachable.`、`delivered=false`、B 侧不开 run；已还原。
- **AC7** 同判据文件「the migration re-files rows named after an address, and its second run is a no-op」：第一次把有 `ai-title` 的行重定级为 `ai`、无 `ai-title` 的为 `derived`，第二次 0 变更（幂等）；累加过的名字不作为重算种子。
- **AC8** `grep -n "nameSourceRankSql" -A3 server/modules/database/repositories/sessions.db.ts` → `(CASE … WHEN 'agent' THEN 4 WHEN 'manual' THEN 3 WHEN 'ai' THEN 2 WHEN 'self-assigned' THEN 1 ELSE 0 END)`。CloudCLI 自造名只落 `self-assigned`(1) / `derived`(0)，都在 `ai`(2) 之下；档位断言在同判据文件「the rank table keeps every CloudCLI-made source below a real title」。
- **AC9** 本记录含两个逐字裁定小节：`## 人 yale 的裁定（2026-09-30，逐字）` 与 `## 人 yale 的第二次裁定（2026-09-30，逐字）`。本次写入只动 `## AC` 的方框并追加本节，两个裁定小节逐字保留（写后已回读比对）。
- **AC10** 八个文件逐个独立进程（本轮在最终树上重取）：

```
server/modules/providers/tests/claude-session-title-source.test.ts       exit=0 pass=8  fail=0
server/modules/providers/tests/claude-host-per-run.test.ts               exit=0 pass=7  fail=0
server/modules/providers/tests/claude-background-work.test.ts            exit=0 pass=10 fail=0
server/modules/session-hosts/tests/session-hosts-routes.test.ts          exit=0 pass=5  fail=0
server/modules/database/tests/sessions-name-source.integration.test.ts   exit=0 pass=12 fail=0
server/modules/providers/tests/session-rename-route.test.ts              exit=0 pass=4  fail=0
server/modules/providers/tests/claude-session-title-corpus.test.ts       exit=0 pass=2  fail=0
server/modules/providers/tests/claude-session-title-mirror.test.ts       exit=0 pass=8  fail=0
```

  `git diff --stat develop...HEAD -- <上述八个文件>` 为空 ⇒「文件未改」成立。`claude-resident-addressable.test.ts` 不在本列（随出路 (a) 修订，见下条）。
- **AC11** `claude-resident-addressable.test.ts` 已按 (a) 重写并退 0（读数见 AC2/AC3/AC5/AC6）：重述旧规则的那段被删，改为「读 `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` 作证 + 投影与注册表逐字相等 + 进程自己没写过名」；`goals/AC-164-常驻进程有稳定的-sendmessage-地址-…md` 的 `title` 与 `expect` 已按裁定改写（`expect` 逐字含「App 不传 `--name`…`nameSource` 为 `derived`；宿主快照的 `peerName` 逐字等于该注册表记录里的 `name`（读来的，不是 App 算出来的），不承诺跨重启不变…取假形态：让投影回落到 App 自造的 `<slug>-<id6>` ⇒ 必须红」，与本轮实测的假形态一致）。
- **AC12** `npm run typecheck` → **exit 0**（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三条链）；`npm run lint` → **exit 0**，输出仅既有 warning；本分支改动的 12 个文件在 lint 输出里零命中，唯一命中本任务 Touches 的是 `src/modules/chat/hooks/useChatComposerState.ts` 的既有 warning（该文件本分支未改，不在 `develop...HEAD` 的 delta 里）。
- **AC13 未勾**：本条要的是**落地后**在生产实例上的复查（`~/.cloudcli/auth.db` 的档位分布 + `server.log` 的计数），而本分支尚未落地（fan-in 未跑），落地前不可能取得该读数，故不预勾。为让落地后的复查有比对基准，先记落地前基线（2026-09-30 实测）：`select transcript_name_source, count(*) from sessions group by 1` = `agent 1528 / null 1317 / ai 107 / derived 21 / manual 4`；`grep -c "registered a different address" server.log` = **9**。

**声明修正（anti-drift）**：`anti-drift-touches-check` 在 `develop...HEAD` 的 12 个文件上报 **`out-of-declared: task wrote server/shared/interfaces.ts (matches no declared Touches glob)`**（HARD FAIL，无 waiver）。该文件承载 AC4 强制的契约改动：`IProviderSessionRename` 的语义从「App 侧权威、provider 侧 best-effort」翻转为「provider 侧权威、本 App 的副本是它的 cache」，并新增可选 `readSessionTitle` 回读（消费者三处：`claude-rename.provider.ts`、`services/sessions.service.ts`、本任务判据）；接口声明所在文件无法另置。原 `## Touches` 漏列，现补 `- server/shared/interfaces.ts (AC4：…)` 一行（不改 Touches 以绕过守卫：这是补声明，不是放宽）。复查：`ANTI-DRIFT OK: task … — 12 actual file(s), all within declared Touches (14 glob(s))`。
**范围界定（重申裁定后复测那条）**：`transcript_name_source='agent'` 的 1528 行绝大多数来自 **quay driver** 的 `-n <role>`（`.quay/profiles.yml`），不是 CloudCLI 写的。本任务只让 CloudCLI 自己不再注入、并迁移历史行；driver 侧的角色名不在本任务范围内。

## 人 yale 的补充裁定（2026-09-30，逐字）—— App 侧占位名

「正常情况下，这个名字应当只显示几秒，然后被 Claude Code 生成的名字换掉。我不指望用这个 derived 收发消息。」

**⇒ 结论：`buildCloudCliSessionName` 的占位名保留，不删。** 它是「Claude Code 还没给出名字」时的过渡显示名，两条硬要求随之成立：

1. **必须是过渡态**：Claude Code 自己的名字（`ai-title`）一到就换掉它。实测（2026-09-30 04:43，本机 :3001，新会话 `a8257068`）：`04:43:47` 落库 `derived` 占位名 `请统计 server 目录下一共有多少个 ts`（首条消息前 4 个词）⇒ `04:43:48` 用户消息进转录 ⇒ `04:43:49` 换成 `ai-title` 的 `Server 目录 ts 文件统计`，`transcript_name_source` 由 `derived` 变 `ai`；侧栏、聊天头、标签页三处一致。**占位名存活约 2 秒**，今天的行为已符合本条。
2. **永远不得作为地址**：`peerName` / 「复制 SendMessage 地址」在任何情况下都不得回落到这个占位名。占位名是显示用的临时值，不是进程地址。

**⚠️ 术语消歧（登记人，已向人确认）**：「derived」在这件事里是两个不同的东西，本节的裁定**只**针对前者：

| | 是什么 | 谁给的 | 裁定效果 |
|---|---|---|---|
| App 侧 `derived` | `buildCloudCliSessionName` 的占位显示名 | CloudCLI | 保留、必须过渡、不得当地址（本节） |
| CLI 侧 `derived` | 进程注册名 `~/.claude/sessions/<pid>.json` 的 `name`，形如 `claudecodeui-74` | Claude Code | **不受本条豁免**：AC6 的承重读数（另一个会话用这个 `derived` 名 `SendMessage` 能否送达）仍必须量 |

人 2026-09-30 确认「我不指望用这个 derived 收发消息」指的是 **App 侧占位名**，不是 CLI 进程名 ⇒ AC6 与 AC-164 的承诺按上文照旧。

## Needs-Human

**执行 2026-09-30T04:26:28.648Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：unclassified
- 失败步/判词：AC 未全勾（checked 7/10，剩余未勾 3）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：cb625e93-b02c-4e9f-a154-a8a67c995f31

## Needs-Human

**执行 2026-09-30T05:09:15.289Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 3 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：unclassified
- 失败步/判词：AC 未全勾（checked 12/13，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：f650faf3-05b7-4ce2-9de6-6d439f6912e9




## 重启场景的实测（2026-09-30，回答人 yale「重启时 Claude Code 能否保持名称不变」）

**方法**：同一会话（`fc544736-cb56-44e6-ab3a-d940dd2522b9`，cwd `/tmp/ccname-4179`）用 SDK 反复 resume，**一律不传 `name`**，每次进程起来后读 `~/.claude/sessions/<pid>.json`。前提：必须传 `pathToClaudeCodeExecutable`（App 在 `claude-runtime.provider.js:321-323` 就是这么做的，取自 `CLAUDE_CLI_PATH` 或 `claude`）；不传该选项时 SDK 会起它自带的 **2.1.165** CLI，而 App 用的是系统的 **2.1.285** —— 两者不是同一个 Claude Code，第一轮探针因此作废重做。

**读数**：

- 不传 `name` 时注册名 = `<cwd basename>-<2 个字符>`，`nameSource` 为 `derived`，且**每次启动重新随机**。同一会话连续 6 次重启得到 6 个不同标签：`80 / b0 / dd / e2 / f1 / b6`（唯一值 6/6）。⚠️ 我此前先测到两次逐字相同（都是 `ccname-4179-5c`），据此差点写成「跨重启逐字不变」——那是 1/256 的巧合；**这个探针必须多跑几次才有判别力**。
- 变化的是地址，不变的是标题：同一会话的 `ai-title`（`Single-word alpha reply`）在每次重启后都还在转录里，`getSessionInfo().summary` 与 App 的 cache 都不受重启影响。**所以「会话名」跨重启是稳的，「进程地址」跨重启不稳。**
- 代码侧解释了为什么：稳定地址是 Claude Code 自己的特性，不是 App 能造的。`vK()` 读 `getFeatureValue_SESSION_PINNED("tengu_session_stable_address", false)`，**默认 false**；打开时地址才是 `sid:<sessionId>`（`nmt`/`j8e`/`SUe`），关闭时按进程走（本机 13 个存活条目全是 `/run/user/1004/cc-socks/<pid>.sock`，**无 `sid:` 前缀 ⇒ 本机开关是关的**）。
- `derived → auto`（把注册名换成 AI 标题）的采纳路径在代码里存在（`Sft`：`g.source==="derived"` 时 `DF(r, n, "auto")`），但 resume 路径上未观察到触发：不传消息 45s、以及真跑完一轮之后，注册名都一直是 `derived`。故**不能**指望重启后名字自动变成 AI 标题。

**对人 yale 那条指令的结论**：新建会话不传 `--name` 成立；**重启会话「如果能保持名称不变就不要传」的前提不成立** —— Claude Code 保不住地址（每次重启换一个随机标签），因此不传 `--name` 的代价是每次重启换地址。按本裁定与 AC-164 修订（「不承诺跨重启不变」），正确做法仍是**不传 `--name`、读注册表里的名字**；若确实需要长期稳定的地址，那是 Claude Code 的 `tengu_session_stable_address` 开关的事，应当去要那个，而不是由 App 自造名字顶替。

## Evidence（worker 2026-09-30，round 4：只余 AC9，补判据并勾选）

**本轮只做一件事。** AC9 是上一轮残留的唯一未勾项，且它自述为**回归守卫**（「今天两条都已成立，加它是防回归，不是待修缺陷」）。故本轮**不动产品代码**——只把该条要的机械读数写进本任务自己的判据文件，逐条取绿，再勾选。

### AC9 的四条读数（全部实测）

- **占位名让位于 `ai-title`。** 新增 `claude-session-name-authority.test.ts` 例「a session opens on the app placeholder and gives it up to the title Claude Code writes」。夹具走**产品自己的**占位名入口 `sessionsService.createAppSession('claude', ws, 'count the typescript files under the server directory')`（不由测试自造字符串——测试自造的名字可能与产品已不再遵守的规则相符），先断言库内显示名 = `count the typescript files`、`name_source='derived'`；再接上 provider 会话 id、写入含 `ai-title` 的转录、`synchronizeFile` ⇒ 显示名 = `Archguard 架构分析`、`source='ai'`。
- **正控制：Claude Code 从未给出标题 ⇒ 占位名原样留下**（「换掉」不得实现成「清空/覆盖」）。例「a session Claude Code never titles keeps the placeholder rather than losing its name」：同一入口建会话，转录只有 CLI 开头的两条簿记行（无标题、也无首条消息）⇒ 显示名逐字仍是那个占位名、`source='derived'`。**该控制已验可红**：把同步器「行已有名字就保留它」那条分支拿掉、并让兜底路径走无条件写读列（`transcriptReading` 改 `true`）⇒ **exit 1**，红在该例：`actual {name:'Untitled Claude Session'}` vs `expected {name:'summarise the failing integration'}`。跑完已 `git checkout --` 还原。
- **假形态：占位名进入高于 `ai` 的档位 ⇒ 必须红。** 两处落点：(i) 新例「a placeholder filed in the override column still gives way to the title」——pre-split 形状，占位名躺在 override 列，而读取侧 `COALESCE(custom_name, transcript_name)` 无条件先读它，即「高于一切档位」；(ii) 档位表判据补 `derived` 档一对（守 + 正控制），使「占位名的档位在 `ai` 之下」也成为机械读数。**假形态实跑**：把 `writeTranscriptName` 里清除非人工 override 的 CASE 改成不清（`THEN NULL` → `THEN custom_name`）⇒ **exit 1**，首条红即该新例：`actual {name:'count the typescript files', source:'ai'}` vs `expected {name:'Archguard 架构分析', source:'ai'}`——占位名把标题挡在了后面。跑完已还原，`git status` 干净。
- **`peerName` 永不是 App 侧给会话的名字。** 在 `claude-resident-addressable.test.ts` 的 AC5 腿补一条断言：对 A/B/C 三条读数逐条比对 `GET /api/session-hosts` 的 `peerName` 与库内该会话的显示名（`sessionsDb.getSessionById(…).custom_name`，含在判据自身视角下「无标题」的 C，其库内名是 `AC164 Addressable Control`）——三者两两不等。该腿连同新增断言 **exit 0**。

### 诚实声明（本条第四款的可证伪性）

第三款的假形态（占位名压过 `ai`）已如实跑为红；但第四款「`peerName` ≠ App 名」在本产品的历史形态下**本来就不可能相等**：退休的 `residentPeerName(title, id)` 产出的是 `slug(title)+'-'+id6`，带后缀，任何版本都不会与显示名逐字相同。故这条是**守**，不是测过的缺陷——其自然的假形态（投影回落到 App 自算名）经实跑确实会红，但红的落点在**同一腿上更早的** `equalToSnapshot` 断言（读数：`snapshot=AC164 Addressable Alpha registry=claude-resident-addressable-4lkxm3-2c registryNameSource=derived`），新加的这条是同一规则的另一句显式陈述。如实登记，不声称它是独立取证的。

### 判据文件的最终读数

```
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-name-authority.test.ts    exit=0  tests=16 pass=16 fail=0   （上一轮 13 例 → 本轮 16 例）
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts      exit=0  tests=1  pass=1  fail=0
```

AC1–AC8、AC11–AC13 不重取：本轮改动只落在上述两个判据文件内，未触任何产品代码，故它们上一轮逐条打印的读数在本树上原样成立（其中 AC11 的八个既有文件、AC13 的 `claude-resident-addressable.test.ts` 都在本轮的最终树上重跑过或未受影响）。`docs/proposals/claude-resident-sessions.md` §12 已含占位名的裁定与「永不当地址」一句（上一轮落盘），本轮无需改文档。

**`## Needs-Human` 段**：本节由 `quay task edit --body-file` 写入（Provider ABI，与 `task_write` 同一条存储写入路径），写后已回读比对——两段 `## Needs-Human` 与三段裁定小节逐字保留，只有 AC 那一行的方框由 `[ ]` 变为 `[x]`。

## Needs-Human

**执行 2026-09-30T06:11:00.943Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 4 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 成因类：human-adjudication
- 失败步/判词：step=suite: not ok - server/modules/voice/tests/voice-capture-audio.false-forms.test.ts:   AssertionError [ERR_ASSERTION]: a surface this task must not have moved is red
- run_id：wk-prod-anchor
- session_id：4c61f4bc-5430-40b0-919a-68cd67fc968d
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-cloudcli-self-assigned-names-outrank-ai-titles~wk-prod-anchor~1790748426795-bb77d9.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-cloudcli-self-assigned-names-outrank-ai-titles-wk-prod-anchor.log


## Evidence（登记人 2026-09-30，清掉挡住落地的那条红）

**上一轮 park 的 suite 红是真的、可归因的，而且已经修掉。** 判词点的是 `step=suite: not ok - server/modules/voice/tests/voice-capture-audio.false-forms.test.ts: AssertionError: a surface this task must not have moved is red`，当轮共 8 条红，但 **8 条同根**：

- **根因（唯一）**：`server/modules/providers/tests/claude-session-name-authority.test.ts:644` 的 `TS2345: Argument of type '"derived"' is not assignable to parameter of type '"manual"'`。`registerAppSession` 的第三个参数被写死成字面量 `'manual'`，而函数体是 `nameSource ?? 'derived'`（写死与实现不符），新加的「占位名落在 override 列仍要让位给标题」一例传的是 `'derived'`。
- **其余 7 条是它的下游，不是独立缺陷**：`voice-capture-off` 自己的判词就写着 `AC6 FAIL :: npm run typecheck (exit=2) | sig: …claude-session-name-authority.test.ts(644,54)`；另两条 `a surface this task must not have moved is red` 与三条 mutant 臂，都是「基线已被 typecheck 打红」的连带。

**修复**：分支 `task/gap-cloudcli-self-assigned-names-outrank-ai-titles` 上 `7362011c` —— 参数类型改为 DB 导出的 `SessionNameSource`（`derived | self-assigned | ai | manual | agent`）。**一处类型注解，产品代码未动。**

**修后读数（全部在本分支的 worktree 上实测）**：

- `npm run typecheck` → **exit 0**（tsconfig + server + scripts 三条链）
- 本任务判据 `claude-session-name-authority.test.ts` → **16/16，exit 0**
- `scripts/test.sh --for-task … --allow-thin` → **exit 0**，`__PERFILE__ … passed=true` ×2
- 被点名的那三条 voice 判据逐条重跑：`voice-capture-off` 4/4、`voice-capture-audio` 6/6、`voice-capture-secrets` 4/4，**全部 exit 0** ⇒ 那 7 条确系连带
- `npm run lint` → exit 0（仅既有 warning）

**⇒ 本任务 13/13 AC 已勾、`execute->done` 门可过，可直接重派落地。**

## 落地与生产复查（2026-09-30，DoD 第 5 条）

**落地**：driver 机械 fan-in `560e1af6`。fan-in 轨迹第二轮 `merge-develop → anti-drift → typecheck → ac-precheck → suite-end ok=True (220s) → anti-drift-land → ac-gate → ff` 全绿（第一轮 `suite-end ok=False` 就是那条 typecheck 红，已由 `7362011c` 修掉）。实现 `9bf287b3` 与修复 `7362011c` 均已在 develop。

**重建 + 重启**：`npm run build` exit 0（产物 14:52/14:53）；安全重启走 `~/.ccui-restart/restart-3001-unit.sh --delay 90`（把自己重起为独立 transient unit，脱离 `claudecodeui-server.service` 的 cgroup）。VERDICT **OK**：MainPID `533938 → 2577190`，listener pid `534003 → 2578273`，`GET /health`+`GET /` = 200/200，`Restart=on-failure`、`NRestarts=0`。新 bundle 载入可证：产物 14:53 生成、服务 14:55:40 起；`readCliSessionRegistration` 5 处、`residentPeerName` 0 处。

**DoD 第 5 条的读数（重启后，`:3001` 由新 pid 服务且 `/health=200` 之后取的）**：

- **迁移前 → 后**：`agent 1538 → 1527`、`ai 108 → 110`、`derived 21 → 33`、`null 1317`、`manual 4`。⇒ **14 行被重定级**（12 行落 `derived`、2 行落 `ai`），与重启前实测的「带自造地址形状的行 = 14」逐字相符；`agent` 净 −11 = −14 + 3 行新进的 quay 角色名。
- **仍带 App 自造地址形状（`<任意前缀>-<本行 app 会话 id 前 6 位>`）的行 = 0**（重启前 14）。
- `grep -c "registered a different address" server.log` = **9**，未增长（旧代码停跑后不再产生）。
- `agent` 那 1527 行仍是 **quay driver** 的 `-n <role>` 角色名，不在本任务范围（裁定已界定）。

**行为面的端到端读数（比档位更直接）**：

- `GET /api/session-hosts` 的两个宿主**都有非空 `peerName`**，且值逐字等于 `~/.claude/sessions/<pid>.json` 的 `name`：`435981 → quay-d3`、`4038061 → claudecodeui-83`（同记录带 `sessionId` 与 `messagingSocketPath`）。⇒ 之前「重启过的宿主 `peerName` 恒 `null`」的症状消失。
- 两个宿主进程的注册名 `nameSource` 均为 **`derived`**（`entrypoint: sdk-ts`，即 CloudCLI 起且**未传 `--name`**），而全机存活进程里 **`nameSource: 'user'` 的数量 = 0** —— 重启前那是 7 个（CloudCLI 的常驻进程全在 `user` 档，名字带累加后缀）。
- 两者启动于 15:09:59 / 15:33:04，均在 14:55:40 重启之后 ⇒ 确系新代码所起。

**结论：本任务的 DoD 五条读数全部取到，行为与档位两侧均符合裁定（CloudCLI 不自赋名、名字读自 Claude Code）。**