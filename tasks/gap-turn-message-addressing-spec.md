---
id: gap-turn-message-addressing-spec
title: 调查设计：Turn/Message 稳定寻址与 retry/fork/resume 语义的最小公共接口（优先复用 Quay 已有概念，避免在
  CloudCodeUI 重复定义）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景（2026-10-07 与用户讨论，针对 session_search 衔接 session_read(mode=around) 之后的下一层需求）：当前 CloudCodeUI 对「一条消息/一轮对话」的寻址是多套并行且不完全统一的概念。

现状（已读代码核实）：
- `session_read(mode:'around', aroundId)` 按「provider 自己的 anchor id，否则合成 id」解析（`server/modules/providers/services/sessions.service.ts` 的 `fetchWindowAround` 注释），Claude 侧是 `entry.uuid`（JSONL 条目自带的 message uuid）。
- `session_read(mode:'outline')` 则是「用户轮次」粒度，返回 `{ id, index, timestamp, preview }`（`SessionTurnOutline`），这里的 `id` 与 `index` 分别是什么稳定性边界、与 message-level 的 `aroundId` 是不是同一个寻址体系，目前没有单一文档说清楚。
- 前端侧也有自己的寻址概念：`transcriptAnchorId`、`transcriptRowId`、`forkAnchorId`、`blockKey`（`src/modules/chat/utils/messageKeys.ts` 刚刚因 `gap-mcp-ui-visible-context-null-range-in-real-browser` 任务才被收敛成一条规则 `messageAnchorId(message) = transcriptAnchorId ?? transcriptRowId ?? id ?? null`），且该任务的记录明确写了「React key 要跨 provider 重铸 ids 存活，而地址只需跨一次读取存活，二者稳定性要求相反」——这说明「稳定寻址」这件事在前端已经踩过一次坑，但目前解法只覆盖了"当前这次渲染读取"范围内的稳定性，没有覆盖跨会话重启/跨 fork/跨 retry 的稳定性。
- `forkedFromSessionId` 是会话级（不是消息级）的分支标记，已经是 DB 字段与 UI 侧栏概念（`groupSessionsByLineage.ts`）；但「在某一条消息上 retry/fork 出一个新分支」这种**消息级**的操作语义，目前代码库里没有找到对应实现（`grep -rln "retryTurn\|resumeSession" server src` 命中的都是不相关的类型定义或本就无关的函数名）。
- 另一条已有教训（本仓库记忆）：常驻/流式会话（resident session）在每轮结束时总会写一个 `prompt_snapshot`+`stop_hook_summary` 的轮次收尾块，导致「中止后的 retry」与「原始 prompt」永远不共享同一个 `parentUuid`——任何「retry 必须共享一个 parentUuid」式的寻址假设在常驻会话上会结构性地不成立，必须在设计里正面处理这个事实，而不是假设 retry 总能对齐到某个共同祖先节点。

要交付（本任务是调查与设计，不实现代码；产出是一份可评审的设计文档）：

1. 盘点并列出当前所有已存在的「寻址/标识」概念（provider 的 `messageUuid`/`transcriptAnchorId`，outline 的 turn `id`/`index`，前端的 `transcriptAnchorId`/`transcriptRowId`/`forkAnchorId`/`blockKey`，会话级的 `forkedFromSessionId`），逐一标注各自的稳定性边界（跨渐进加载？跨会话重启？跨 provider 重新同步？跨 fork？）。
2. 明确调查 Quay 层（`.quay/`、quay 任务/goal/gate 体系）里是否已有可复用的"轮次/事件寻址"概念（例如 gate event、turn walk 的内部编号），以及 Quay 自己的设计文档（`docs/proposals/` 下与 quay 相关的 SPEC、本仓库 AGENTS.md 引用的 quay 方法论文档）是如何定义"一次轮次"的身份的；给出明确结论：能复用则说明如何复用、复用到什么程度；不能复用则说明具体障碍（例如 Quay 的编号假设了 quay 自己的任务执行模型，和 CloudCodeUI 的多 provider 聊天轮次是两个不同的实体）。
3. 针对 retry/fork/resume 三种后续操作，各自给出最小稳定语义定义：操作的输入需要哪个粒度的寻址（消息级还是轮次级）、操作后新产生的消息/会话如何与原节点关联、在当前已知的「常驻会话轮次收尾块打断 parentUuid 连续性」这个结构性事实下如何仍然给出一个可实现的关联方式（例如改用「轮次序号 + 时间戳」而不是「parentUuid 链」作为关联锚点）。
4. 产出一份设计文档（建议路径 `docs/proposals/turn-message-addressing-SPEC.md`，格式仿照本仓库现有 `docs/proposals/mcp-gateway-SPEC.md` 的背景/设计/风险/修订记录结构），明确给出一个最小公共接口提案（类型定义层面即可，不要求代码实现）供后续 retry/fork/resume 相关任务引用，并标注哪些部分需要人工决策、哪些可以直接按本文档实现。

<!-- dedup-ref -->机制上去重已核对：`task_list search="turn 语义"` 为空；全仓库现有任务里没有以「稳定寻址/turn 语义」为主题的任务。与同批另一个任务（暴露 session_search，消费 `messageUuid` 作为 `session_read` 的 `aroundId`）是**上下游参考**关系，不是重复：那个任务直接复用已有的 `messageUuid` 寻址，不等待本任务；本任务的产出是为后续 retry/fork/resume 一类需要"新建关联"而不只是"读取定位"的操作提供设计依据，范围更广，两者可独立并行推进。

## AC

- [x] `docs/proposals/turn-message-addressing-SPEC.md` 文件存在，且 `grep -c "^## " docs/proposals/turn-message-addressing-SPEC.md` 的结果 ≥ 5（背景、现状盘点、Quay 复用评估、retry/fork/resume 语义、风险或待决问题，至少各占一个二级标题）。
- [x] `grep -n "transcriptAnchorId\|transcriptRowId\|forkAnchorId\|blockKey\|messageUuid\|forkedFromSessionId" docs/proposals/turn-message-addressing-SPEC.md` 命中数 ≥ 6（证明现状盘点真的逐一点名了现有概念，不是空泛描述）。
- [x] 文档里有一个二级或三级标题包含「Quay」字样，且该节落在明确结论：复用到什么程度，或列出不能复用的具体障碍（不能是模糊的「可以参考」）。
- [x] 文档里对 retry、fork、resume 三个操作各自有独立小节，且每节都提到"常驻会话轮次收尾块打断 parentUuid 连续性"这一已知结构性事实，并给出该事实下仍然可行的关联锚点方案（不能是"假设 parentUuid 链总是连续"的方案）。
- [x] 文档末尾有「修订记录」或等价的版本小节，注明初稿日期与基于的调查输入（本次 2026-10-07 的只读调查对话）。

## DoD

设计文档已落地在 `docs/proposals/turn-message-addressing-SPEC.md`，内容对照 AC 的各项逐一满足，且文档本身被（至少一次）人工评审确认"可以照此拆出后续实现任务"而不是停留在草稿状态——评审意见以 commit message 或任务 `## Notes` 补记的形式留痕。仅文件存在、未经评审确认可执行，不算完成。

## Touches

- docs/proposals/turn-message-addressing-SPEC.md
- tasks/gap-turn-message-addressing-spec.md

## Notes

本任务不实现任何 retry/fork/resume 的代码，也不改动现有的 `session_read`/`messageKeys.ts` 等寻址实现；产出只是设计文档，为后续独立任务提供依据。

### 完成记录（2026-10-07，worker）

- 交付物：`docs/proposals/turn-message-addressing-SPEC.md`（初稿 v1）。AC 五项逐一机械核实通过：`^## ` 计数 = 7（≥5）；六概念点名命中 = 24（≥6）；`## Quay 复用评估` 落在明确结论（复用 GateEvent 的记录形状与「解析不到即显式拒绝」的失败纪律，**不复用**其运行时，且不得把 CloudCodeUI 的轮次 id 取自 Quay，列出四条具体障碍）；retry/fork/resume 三节各含同一结构性事实并给出**非 parentUuid 链**的关联锚点；`## 修订记录` 含初稿日期 2026-10-07 与只读调查输入。
- 只读核查更正了 Proposal 的两处现状描述，已写入 SPEC：(1) 消息级 fork **已经实现**（`forkSessionById(sessionId,{upToAnchorId})`，`sessions.service.ts:432`），缺的不是 fork 本身而是分叉后新会话与原消息之间的机器可读关联字段；(2) `messageUuid` 在本仓库是**两个不同概念**——provider 的 JSONL 行 uuid（C1，`aroundId` 的来源）与 `session_cancel_queued` 的排队消息 uuid（C13，`mcp-session-cancel-queued.ts:90`，服务端铸造、只在队列存活期有效），二者不可互换。
- **DoD 的人工评审尚未获得。** DoD 明确写着「仅文件存在、未经评审确认可执行，不算完成」，且要求评审意见以 commit message 或 Notes 留痕；本 worker 不得代写评审结论。评审人未定评前，本任务保持 `needs-human`，**不得置 done**（对照同类先例 `gap-debug-agent-synthetic-provider-adr` 的 DoD：「未获评审前不得置 done」，其评审落于 `adr/ADR-003` 的 `## Adjudication` 小节）。
- 待评审的决策点（评审时请一并裁决）：**D-a** `forkedFromAnchorId` 的字段名与落库（DB 列 vs 事件 payload），以及它记录源会话地址还是新会话内新 id（SPEC 主张源会话地址）；**D-b** retry 的产物是新会话还是同会话新轮次（产品语义）；**D-c** `TurnAddress.index` 在 compaction/编辑下是否需 provider 侧轮次不变量。另有两条**未核实前提** U-1（Claude fork 是否逐一重铸所有 uuid，当前依据是 `claude-fork.provider.ts:13-15` 的注释，未逐份实测）、U-2（Codex fork 的 uuid 处理未核实），见文档「风险与待决问题」。

### 人工评审（2026-10-07）

以下为任务负责人（人类）于 2026-10-07 在对话中给出的裁定，由 quay-task agent 按原意记录，不含 agent 自己的判断：

- 评审结论：人已评审 SPEC（`docs/proposals/turn-message-addressing-SPEC.md`），并对三个阻塞性决策点作出裁定，可据此拆出后续实现任务。
- D-a：选择 DB 列，且 `forkedFromAnchorId` 记录**源会话**地址。
- D-b：retry 的产物是**同一会话**；从用户视角它是同一轮（同一条消息：之前发送失败，现在发送成功）。因此 RetryLink 挂在会话内的该轮（turn）上，而不是挂到新会话。
- D-c：暂时接受 `TurnAddress.index` 漂移；任何持久关联都不得依赖 index。
- U-1 / U-2 仍是未核实前提：后续实现任务在开工前必须先核实。
