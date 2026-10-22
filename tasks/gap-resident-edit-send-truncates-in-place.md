---
id: gap-resident-edit-send-truncates-in-place
title: resident 会话的「编辑重发」在原会话内真正截断：关 host（rewind）→ 带 resumeSessionAt 重拉起 →
  追加替换消息，不新建会话
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测）：`grep -l "resumeAnchorId\|resumeSessionAt" tasks/*.md` 只命中 `gap-fork-from-assistant-reply-anchor` 与 `gap-fork-inherits-lifecycle-mode`（二者谈 fork，不碰 edit-send 的 resident 路径，且均已 done）；`gap-session-hosts-lease-driven-lifecycle` 只登记了 `closeReason: 'rewind'` 这个枚举值，称其产品路径「属 AC-158/AC-159」，但没有任务认领 resident 的编辑重发。⇒ 本条不是重复。

**现象（人的报告）**：暂停（abort）一次输入的处理后，点界面上的「编辑」重新编辑最后一条消息再发出，被暂停的那条消息及其处理痕迹仍留在会话里。

**根因（代码读数，未在线复现）**：
1. `chat.edit-send`（`server/modules/websocket/services/chat-websocket.service.ts` 的 `handleChatEditSend`）经 `resolveEditAnchor` 算出 `resumeThroughId`（编辑目标之前最近的 assistant 行），作为 `resumeAnchorId` 随 `extraRuntimeOptions` 交给运行时。
2. 这个选项只在 per-run 运行时被消费：`claude-runtime.provider.ts` 把它映射成 SDK 的 `resumeSessionAt`（该处注释：`resumeSessionAt` 包含其所指 uuid，所以传的是要保留的最后一行）。全库 `grep resumeAnchorId|resumeSessionAt|resumeFromScratch`，除这两个文件外无任何读取方——**resident 的 host 驱动（`claude-host-driver.provider.ts`）完全不读**。
3. 能力矩阵对 Claude 统一声明 `supportsMessageEditing: true`（`provider-capabilities.service.ts:121`），不区分 per-run 与 resident，前端因此给 resident 会话也显示编辑按钮。
4. 所以 resident 会话的编辑重发实际等于「向活着的进程追加一条普通消息」：被暂停的旧消息与其痕迹仍在进程上下文里（模型仍能看到）；追加不会让两条用户 prompt 共享同一个 `parentUuid`，`dropSupersededPromptBranches`（`claude-sessions.provider.ts`）剪不掉旧分支；前端先收到 `history_truncated` 把旧消息暂时藏起来，`complete` 之后重读 transcript，旧消息又回来了。
5. 旁证：`session-host-manager.service.ts` 已有 `rewind(appSessionId)`（关宿主，`closeReason='rewind'`，注释写「Consumed by the edit-send rebuild path」），全库无任何调用方——设计意图在、消费方缺。
6. 数据旁证：最近 400 个会话里只有 2 个存在「同父节点两条 prompt」的编辑分支，且都是 per-run。

**人的裁定（2026-10-07）**：resident 会话编辑重发要**留在原会话里**（用户在会话列表里不得看见新会话）；不走「编辑即 fork 成新会话」的方案。

**方案**：
- `handleChatEditSend` 在 resident 会话上：先 `sessionHostManager.rewind(sessionId)` 关闭当前 host（等它真正退出），再以 `resume=<provider_session_id>` + `resumeSessionAt=<resumeThroughId>`（首条 prompt 被编辑时 `resumeFromScratch`）重新拉起 resident host，并把替换消息作为这个新进程的第一轮；会话的 app id、`provider_session_id`、`lifecycle_mode` 不变，jsonl 仍是同一个文件，被替换的分支靠既有的 `dropSupersededPromptBranches` 在读取时剪掉。
- host 驱动的启动路径（`startResidentSession` / `startResidentHost`）接受并透传 `resumeAnchorId` / `resumeFromScratch`，映射成 SDK 的 `resumeSessionAt`；占用检查（`findBackgroundSessionOwner`）、`resolveResumeModel`、Remote Control 门保持原行为。
- 重建期间 `history_truncated` 先发（沿用现有顺序，避免旧消息闪烁）；重建失败要结束本次 run 并发 `complete`，让客户端重读 transcript 还原，沿用 per-run 路径的失败语义。
- **止血**：在重建路径落地之前或同时，不允许 resident 会话静默走「普通追加」——要么走新路径，要么拒绝并给明确错误，不得再沉默地做错事。

**不在本任务范围**：fork 按钮迁移与 fork 继承 `lifecycle_mode`（已由 `gap-fork-from-assistant-reply-anchor`、`gap-fork-inherits-lifecycle-mode` 完成）；Codex 的 resident（Codex 不支持 resident）；resident 排队消息（`chat.cancel-queued`）语义。

## Plan

1. **先取读数（未取到肯定读数不动产品代码）**：在 `/tmp` 的临时 HOME 里，用真 claude 进程验证 resident 形态（SDK 的 held-input 流式输入）下 `resume` + `resumeSessionAt` 是否被接受、新进程是否仍把后续行追加到**同一个** jsonl、追加的替换 prompt 与旧 prompt 是否共享同一 `parentUuid`。打印 `residentResumeAt=<accepted|rejected> sameFile=<true|false> sharedParent=<true|false>`。若 `rejected`，停手并 park needs-human，记录 CLI 的拒绝文案，不自行换方案。
2. **判据骨架先红**：在 `server/modules/websocket/tests/chat-edit-send.test.ts` 与 `server/modules/providers/tests/claude-resident-process.test.ts` 里先写各断言，在当前树上跑出红态文案（不得新增 `server/**/*.test.ts` 文件：仓库有按文件数 pin 的测试，新增会让它全线变红）。
3. **host 驱动透传**：`startResidentHost` 的启动 options 接受 `resumeAnchorId` / `resumeFromScratch`，沿用 per-run 运行时同一份映射逻辑（不复制第二份）。
4. **编辑重建路径**：`handleChatEditSend` 在 `sessionsDb.getSessionLifecycleMode(sessionId) === 'resident'` 时走「`rewind` → 等待关闭 → 带截断点重拉起 → 发替换消息」；per-run 路径字节不变。
5. **前端**：确认 resident 会话的编辑按钮在新路径下可用；如重建失败的报错需要展示，沿用既有的协议错误通道。
6. **收尾**：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 退出 0；按 AGENTS.md 单文件直接跑各判据，不做无界 fan-out；写完成记录（含第 1 步读数）。

## AC

- [x] 前置读数已取得并写进完成记录：真 claude 进程上 resident 形态的 `resume` + `resumeSessionAt` 实测，打印 `residentResumeAt=accepted sameFile=true sameBranchPoint=true`；任一项不是该值则不动产品代码，park needs-human。（2026-10-07 人类裁定：期望读数由 `sharedParent=true` 改为 `sameBranchPoint=true`；实测 `sharedParent=false`——回合结束块 prompt_snapshot+stop_hook_summary 夹在 assistant 截断点与被 abort 的 prompt 之间——保留在完成记录中。）— 已过：实测 `residentResumeAt=accepted sameFile=true sameBranchPoint=true`，见完成记录第 1–2 节。
- [x] host 驱动透传：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-process.test.ts` 退出码 0，且新增用例断言——带 `resumeAnchorId=X` 启动 resident host 时，交给 SDK 的启动选项含 `resumeSessionAt===X` 且含 `resume===provider_session_id`；带 `resumeFromScratch` 时**不含** `resume` 也不含 `resumeSessionAt`；不带这两个选项时启动选项与改前逐字相同（不回归普通 resident 启动）。— 10/10 exit 0（用例 (h)(i)(j)）。
- [x] 编辑重建（resident）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-edit-send.test.ts` 退出码 0，且新增用例在一个 `lifecycle_mode='resident'` 且 host 存活的会话上发 `chat.edit-send`，断言——旧 host 先被 `rewind` 关闭（`closeReason==='rewind'`）、关闭完成**之后**才起新 host；新 host 的启动选项带编辑目标之前最近 assistant 行的 uuid 作为 `resumeAnchorId`；会话的 app id、`provider_session_id`、`lifecycle_mode` 在重建前后逐字相同；`sessionsDb` 里没有新增会话行；`history_truncated` 帧先于重建发出。— 13/13 exit 0。
- [x] 同一用例的正控制：对 per-run 会话发 `chat.edit-send`，走原路径、**不**调用 `rewind`，`extraRuntimeOptions` 与改前逐字相同（防「所有会话一律走重建」）。— 同文件正控制用例通过。
- [x] 失败语义：同文件用例断言——重建过程中重拉起失败时，本次 run 以 `complete` 结束（不是永远 processing），并有一条 `EDIT_REWIND_FAILED` 协议错误；会话行未被改动。— 同文件用例通过。
- [x] 读取侧不回归：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` 退出码 0（该文件已有 `dropSupersededPromptBranches` 的用例，不得被本任务改红；仅在该文件里新增「resident 重建产生的同父双 prompt 夹具读出后只剩替换那条」用例，如需新增则声明在 Touches）。— 28/28 exit 0；本任务未改读取侧，故未新增该夹具（原因见完成记录）。
- [x] 假形态承重（实测红文案写进完成记录）：临时把 `handleChatEditSend` 里 resident 分支改回「直接追加、不 rewind」后，重建用例**必须变红**，还原后转绿；临时去掉 host 驱动对 `resumeSessionAt` 的映射后，透传用例**必须变红**，还原后转绿。— 两条红文案见完成记录。
- [x] 工具链：`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 均退出码 0。— 三者 exit 0。
- [x] 读取侧剪枝扩展（人类裁定 2026-10-07 新增）：`dropSupersededPromptBranches`（`server/modules/providers/list/claude/claude-sessions.provider.ts`）在原有「字面同 `parentUuid`」规则之外，额外丢弃一条更早的 user prompt 分支（连同其处理痕迹），当存在一条**更晚**的 user prompt **直接锚在**该早 prompt 的最近 assistant 祖先（分支点）上——即使该早 prompt 挂在回合结束块（prompt_snapshot / stop_hook_summary）之下。在 `server/modules/providers/tests/claude-sessions.test.ts` 验证：(a) run-4 链夹具（assistant 563a602f → 回合结束块 → 被 abort 的 user → `[Request interrupted by user]`；替换 user 锚在 563a602f）读出后只剩替换那条；(b) 负控制「abort 后另发新消息」（新 prompt 锚在被 abort 的 prompt 或其 interrupt 标记上，而非分支点）读出后**两条 prompt 都保留**；(c) 既有字面同 `parentUuid` 用例行为不变。单文件运行 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` 退出码 0；另加假形态：撤销该扩展后用例必须变红，红文案写进完成记录。— 30/30 exit 0；假形态 29/30 exit 1（红文案见完成记录「收尾」节），还原后 30/30。
- [x] 语料回归（人类裁定 2026-10-07 新增）：离线遍历 `~/.claude/projects` 下全部 transcript（上次计数 6143 份），对比旧规则与收窄后新规则；打印结果改变的 transcript 数量，并对**每一份**改变的 transcript 断言：额外被丢弃的 prompt 符合收窄后的形态（存在更晚的 prompt 直接锚在其分支点上）；任何「按收窄定义本不被替换、读出结果却变了」的 prompt 即为失败。各计数写进完成记录。— 6232 份 / 改变 15 份 / 额外丢弃根 prompt 15 / 派生行 110 / 少剪 0 / failures 0，RESULT PASS，见完成记录「收尾」节。

## DoD

真实落地：在真实服务实例（临时 `HOME` + 临时 `DATABASE_PATH`，真 claude 进程，非替身）里，对一个 `lifecycle_mode='resident'` 的会话走完整故事：(1) 发一条消息，等其回合结束；(2) 再发第二条消息并在其处理中途暂停（abort）；(3) 点编辑那条被暂停的消息，改写后发出（真实 `chat.edit-send` 帧）。读数写进完成记录：(a) 读库——该会话仍是同一行、`lifecycle_mode` 仍是 `resident`、会话总数未增加；(b) 读 `GET /api/providers/sessions/:id/messages`，在三种情形下各读一次——刚 `complete` 之后、切换到另一个会话再切回之后、重启服务（重开 CloudCLI）之后——三次读出的消息序列里都包含替换 prompt，且都**不含**被暂停的 prompt 及其处理痕迹（assistant/tool 行与 `[Request interrupted by user]`）；jsonl 本身按 append-only 保留被暂停的 prompt 属已接受（人类裁定 2026-10-07），原「共享同一 `parentUuid`」要求已删除；(c) 向该会话再发一问「我之前说过什么」，模型的回答里**没有**被暂停那条的内容（证明进程上下文也被截断，而不只是界面藏起来）。若本环境无可用的在线模型端点，如实写明取不到 (c)，不得以替身代写；此时 (a)(b) 仍须以真实服务实例取得。

## Touches

- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/websocket/tests/chat-edit-send.test.ts
- server/modules/providers/tests/claude-resident-process.test.ts
- server/modules/providers/tests/claude-sessions.test.ts
- tasks/gap-resident-edit-send-truncates-in-place.md

## 完成记录

**结论：机制已落地并逐条验证；但 DoD 读数 (b) 在真实实例上不成立，且 AC-1 的文字读数复现不出来 —— 按 AC-1 自带的逃生条款 park needs-human。**

commit `2ea22cec`（branch `task/gap-resident-edit-send-truncates-in-place`，已 pre-merge develop，无冲突）。改动文件即 Touches 前四项；`claude-host-driver.provider.ts` 声明但未改动（透传走共用映射 `mapCliOptionsToSDK`，未复制第二份）。

### 1. AC-1 前置读数（真 claude 进程，resident 形态）

DoD 故事形态（消息一 → 等回合结束 → 消息二 → 中途 abort → 真实 `chat.edit-send` 改写重发）：

    residentResumeAt=accepted sameFile=true sharedParent=false

- `accepted`：新进程带 `--resume <provider_session_id> --resume-session-at <assistant uuid>` 正常起来，CLI 无拒绝文案。
- `sameFile=true`：后续行仍追加到同一个 jsonl。
- `sharedParent=false`：被 abort 的 prompt 与被替换的 prompt **不**共享同一个 `parentUuid`。
  任务文字预期为 `true`；实测 `false` ⇒ 按本 AC 该条不动产品代码、park needs-human。

（早先一次「不等回合结束」的形态量到过 `sharedParent=true`；那正是差别所在——见下。）

### 2. 为什么 `sharedParent=false`（真 CLI 的文件形态）

run 4 实测 jsonl 的行链（报告留档 `/tmp/dod-run4.log`）：

    assistant  563a602f  "记住了"                              ← 截断点（resumeThroughId）
    attachment c0345d84  parent=563a602f  prompt_snapshot      ┐ 回合结束块（stop hook）
    system     b028bedb  parent=c0345d84  stop_hook_summary   ┘
    user       7bd121c5  parent=b028bedb  "暗号乙=绿色青蛙。…"   ← 被 abort 的 prompt
    user       5f453e5c  parent=7bd121c5  [Request interrupted by user]
    user       a8f8298b  parent=563a602f  "暗号乙=蓝色鲸鱼。…"   ← 替换 prompt
    assistant  9b5d420f  parent=a8f8298b  "好的"

替换 prompt 锚在 assistant 截断点上（`resume-session-at` 截断后直接追加）；被 abort 的 prompt 锚在**回合结束块**上（它发送时文件的叶子就是那个块）。于是两者共祖先（`sameBranchPoint=true`）、不共 `parentUuid`（`literalSibling=false`）。只有「不等回合结束就发第二条」时块还没写，两条才成为字面兄弟 —— 而 DoD 的步骤 (1) 明写「等其回合结束」，块必然已写。

全库旁证（`~/.claude/projects` 下 6143 份 transcript）：155 份含 `stop_hook_summary`、37 份存在「同父双 prompt」，两者交集只有 **1** 份（36/37 的同父形态都**没有** stop hook 块）。即 resident（永远有回合结束块）在结构上产生不出字面同父。

### 3. DoD 三处读数（真实服务实例：临时 HOME + 临时 DATABASE_PATH + 真 claude 进程 + 真实 `chat.edit-send` 帧）

(a) **成立**。同一 app 会话行；`provider_session_id` 前后同为 `bdd0e26a-903a-4beb-afdb-0bf421794183`；`lifecycle_mode` 前后均 `resident`；会话总数 1→1；无新会话行。重建本身：旧 host 以 `closeReason='rewind'` 关闭，新 host 新 pid（`hostChanged=true pidChanged=true`）。

(b) **不成立**。
- jsonl：`literalSibling=false`（`sameBranchPoint=true`），行链见上。
- 路由：`GET /api/providers/sessions/:id/messages` 返回 11 条，`dropSupersededAbortedPrompt=false`、`replacementPresent=true`。被 abort 的 prompt 仍在序列里：

      ["记住暗号：暗号甲=紫色河马。…", "…", "记住了",
       "暗号乙=绿色青蛙。然后请从 1 数到 300…",   ← 被 abort 的 prompt 仍在（处理痕迹亦在）
       "暗号乙=蓝色鲸鱼。只回复「好的」。", "…", "好的"]

- 根因：`dropSupersededPromptBranches`（`claude-sessions.provider.ts:644`）只按**字面 `parentUuid`** 聚合 user prompt 行、剪掉同父里早写的兄弟；回合结束块挡在 assistant 与下一条 prompt 之间，聚合键对不上，剪不动。⇒ 方案里「被替换的分支靠**既有的** `dropSupersededPromptBranches` 在读取时剪掉」这个前提被实测否证。

(c) **成立**。再问「我之前告诉过你哪些暗号？只列出暗号本身」，模型答 `暗号甲=紫色河马 / 暗号乙=蓝色鲸鱼` —— **没有** `绿色青蛙`。即：进程上下文确实被真正截断（不只是界面把旧消息藏起来），且替换与更早的上下文都在。

⇒ 机制本身有效：**上下文截断成立，漏在读取侧**。

### 4. 为什么没有顺手改读取侧

把「按字面 `parentUuid` 聚合」放宽成「按最近 assistant 祖先（分支点）聚合」，在 6143 份真实 transcript 上离线模拟：**28 份结果改变，其中 20 份多剪、10 份少剪**，且多剪的样本里有**没有** stop hook 块的会话（典型的「abort 后另发一条新消息」合法形态会被误剪）。读取侧改动既不在本任务 Touches，也不是安全的收窄（双向改变），故未取，留给人的裁定。

### 5. 假形态承重（AC-7，本树实测）

- 把 `handleChatEditSend` 的 resident 分支改回「直接追加、不 rewind」：`chat-edit-send.test.ts` **13 tests / 9 pass / 4 fail / exit 1**；红文案 `AssertionError: actual: [], expected: [ 'edit-session' ]`（×3，rewind 未落到宿主 seam）与 `actual: 1, expected: 0`。还原后 13/13 exit 0。
- 去掉 `mapCliOptionsToSDK` 对 `resumeSessionAt` 的映射：`claude-resident-process.test.ts` **10 tests / 9 pass / 1 fail / exit 1**；红文案 `AssertionError: the launch resumes at the turn the edit keeps — actual: undefined, expected: 'anchor-before-the-edit'`。还原后 10/10 exit 0。

### 6. 工具链

pre-merge develop 后在合并树上重跑：三个判据文件 10/10、13/13、28/28 均 exit 0；`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 均 exit 0（余下 warning 均为改动前既有、且不在本任务触及文件里）。

### 7. 需要人裁定的问题

resident 重建已让**进程上下文**真正截断（读数 (c) 成立），但读取侧 `dropSupersededPromptBranches` 剪不掉被 abort 的分支（读数 (b) 不成立），因此前端在 `complete` 后重读 transcript 仍会显示被暂停的消息——**现象未完全消除**，且这需要改一个本任务 Touches 之外的共用读取路径。

请裁定下列之一：
1. 批准把读取侧剪枝放宽到「分支点」，并接受其在 6143 份真实 transcript 上 28 份（双向）的行为改变（可再收窄成「仅当存在一条更晚的 prompt 直接锚在分支点上」以消除「abort 后另发」误剪，但仍是新判据、需另行验证）；
2. 以别的判据重划本任务（例如把 (b) 的判据从「共享 `parentUuid`」改为「替换 prompt 锚在被 abort 那条的截断点上」，并把读取侧单列一条）；
3. 接受「上下文已截断」为本次交付边界，把「读取侧剪枝」另立一条 gap 任务。

（本行 park，不改产品代码；已落地的重建机制在工作树上、commit `2ea22cec`。）

### 人类裁定（2026-10-07）

任务负责人裁定：接受 jsonl 按 append-only 保留被取代的被 abort prompt（U2）；但 CloudCLI 界面必须**只显示替换 prompt、永不显示 U2**，且在每条进入路径上一致——留在会话内、从别的会话切回、重新打开 CloudCLI。即采用上文第 7 节选项 1（收窄版）：读取侧剪枝在**本任务内**扩展（不另立 gap）。据此：Touches 增加 `claude-sessions.provider.ts`；AC-1 的期望读数改为 `sameBranchPoint=true`（已按完成记录第 1–2 节勾选）；新增 AC「读取侧剪枝扩展」与「语料回归」；DoD (b) 改为三情形读数（complete 后 / 切换后 / 重启后），删除原「共享 parentUuid」要求；DoD (a)(c) 保留。

### 收尾（2026-10-07，第二轮：读取侧剪枝扩展 + 语料回归 + DoD 三情形读数）

**改动**：`server/modules/providers/list/claude/claude-sessions.provider.ts`（收窄 `dropSupersededPromptBranches`）与 `server/modules/providers/tests/claude-sessions.test.ts`（+131 行，两个新用例）。分支 `task/gap-resident-edit-send-truncates-in-place`。

**AC-8 读取侧剪枝扩展**：在原有「字面同 `parentUuid`」规则之外新增一条——一条 user prompt 若存在一条**更晚**的 user prompt **直接锚在**其「最近 assistant 祖先（分支点）」上（`candidate.parentUuid === branchPoint.uuid` 且 `candidate` 在文件中更晚），则该早 prompt 及其子树（含回合结束块、`[Request interrupted by user]` 等痕迹）在读取侧被丢弃。要求「直接锚在分支点」而非仅「共享分支点」，正是为了不误伤「abort 后另发一条新消息」——那条新 prompt 锚在 interrupt 标记上，不是分支点。

判据 `server/modules/providers/tests/claude-sessions.test.ts`：
- (a) run-4 链夹具（`assistant 563a602f → 回合结束块 → 被 abort 的 user → [Request interrupted by user]`；替换 user 锚在 563a602f）读出后 `['first prompt','first answer','replacement prompt','answer to the replacement']`（只剩替换那条）。
- (b) 负控制「abort 后另发新消息」读出后 `['first prompt','first answer','abandoned prompt','fresh question','answer to the fresh question']`（两条 prompt 都保留）。
- (c) 既有字面同 `parentUuid` 用例行为不变。

    npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts
    → ℹ tests 30 / pass 30 / fail 0 / exit 0

假形态（把扩展判据临时改成 `const replaced = false && anchoredAtBranch.some(...)`）：

    ✖ an edit that resumes partway prunes the prompt the turn-end block hid from the parent check
    ℹ tests 30 / pass 29 / fail 1 / exit 1
    AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
      actual:   [ 'first prompt', 'first answer', 'abandoned prompt', 'replacement prompt', 'answer to the replacement' ]
      expected: [ 'first prompt', 'first answer', 'replacement prompt', 'answer to the replacement' ]

还原后 30/30 exit 0（`grep -c 'false &&' …claude-sessions.provider.ts` = 0）。

**AC-9 语料回归（离线，真实规则）**：脚本 `/tmp/corpus-regression/run.mts` 用文本切片从 `git show HEAD:<provider>`（旧规则）与工作树（新规则）各自提取**真实的** `isUserPromptRow` + `dropSupersededPromptBranches` 并动态导入，遍历 `~/.claude/projects/**/*.jsonl`，按 `parseTranscriptLine` 的口径（仅保留 `entry.sessionId === 文件名主干`）解析每一份，对比被丢弃的 uuid 集合，对每份改变的 transcript 断言：额外丢弃的**根** prompt 符合收窄形态（存在更晚 prompt 直接锚在其分支点上）；额外丢弃的非 prompt 行均从这类根派生；旧规则丢弃的行无一份被新规则保留（无少剪）。结果：

    transcriptsScanned 6232 / totalRows 1312269
    transcriptsChanged 15 / additionallyDroppedRootPrompts 15 / additionallyDroppedDescendantRows 110
    underDroppedRows 0 / failures 0 → RESULT: PASS

对照：把聚合键放宽成「分支点」的朴素变体在同一语料上 **28 份改变、含双向**（会误剪「abort 后另发一条新消息」的合法形态）；收窄成「必须直接锚在分支点上」后误剪消失，仅剩单向多剪的 15 份（全部是「同分支点被更晚 prompt 取代」的真形态）。

**DoD 三情形读数（真实服务实例：临时 HOME + 临时 DATABASE_PATH + 真 claude 进程 + 真实 `chat.edit-send` 帧；endpoint `http://127.0.0.1:26510/`）**：

故事：消息一「记住暗号：暗号甲=紫色河马。只回复「记住了」。」→ 等回合结束 → 消息二「暗号乙=绿色青蛙。然后请从 1 数到 300，每行一个数字，不要使用任何工具。」→ 中途 abort → 真实 `chat.edit-send` 改写为「暗号乙=蓝色鲸鱼。只回复「好的」。」发出。

(a) **成立**：同一 app 会话行；`provider_session_id` 前后同为 `2f7eb936-927b-4a1d-bfb0-bf59a438b34d`；`lifecycle_mode` 前后均 `resident`；会话总数 1→1；无新会话行。重建：旧 host 以 `closeReason='rewind'` 关闭，新 host 新 pid（`hostChanged=true pidChanged=true`）。

(b) **三情形均成立**：
- 刚 `complete` 后（`GET /api/providers/sessions/:id/messages?limit=200`）：`messageCount=5`、`dropSupersededAbortedPrompt=true`（`绿色青蛙` 及其 `[Request interrupted by user]` 痕迹不在序列里）、`replacementPresent=true`。序列 `["记住暗号：暗号甲=紫色河马。…","…","记住了","暗号乙=蓝色鲸鱼。只回复「好的」。","好的"]`。
- 切换到另一个会话再切回后（先读另一会话 id，返回 404 `Session "…-away" was not found`；再读本会话）：`afterSwitch.messageCount=5`、`afterSwitch.dropSupersededAbortedPrompt=true`、`afterSwitch.replacementPresent=true`。
- 重启服务后（**新进程**，同一 HOME + DATABASE_PATH，重开 express + `providerRoutes`）：会话行仍在（`sessions=1`、`provider=claude`、`lifecycle_mode=resident`、`provider_session_id=2f7eb936…`）；`messageCount=7`（含 (c) 的追问轮）、`abortedMarkerAbsent=true`、`replacementPresent=true`。

jsonl 本身按 append-only 保留被 abort 的 prompt（`user 4087e451…` 仍在文件里），属人类裁定已接受；界面读取侧按上文剪掉。

(c) **成立**：再问「我之前告诉过你哪些暗号？只列出暗号本身，不要解释」，模型答 `暗号甲=紫色河马 / 暗号乙=蓝色鲸鱼` —— 没有 `绿色青蛙`。进程上下文确实被截断，且替换与更早上下文都在。

（DoD 探针为一次性脚本，位于工作树 `tmp-dod-resident-edit.mts` / `tmp-dod-restart-read.mts`，验证完毕即删。）

**工具链**：`claude-sessions.test.ts` 30/30、`claude-resident-process.test.ts` 10/10、`chat-edit-send.test.ts` 13/13 均 exit 0；`npm run typecheck`、`npm run lint`、`npx oxlint server/ src/` 均 exit 0。