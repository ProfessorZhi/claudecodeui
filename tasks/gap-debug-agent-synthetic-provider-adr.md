---
id: gap-debug-agent-synthetic-provider-adr
title: ADR-003：可控制的调试 Agent —— 不跑真 CLI 也能产生输出的测试与调试机制（只落设计文档，不实现）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
---
## Proposal

**交付物：一份设计文档，不是实现。** 新增 `adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md`，按 `adr/ADR-002` 的体例（frontmatter `id`/`title`/`status: proposed`/`supersedes`，正文 `## 背景` / `## 决策` 逐条编号 / `## 边界与不做的事` / `## 后续任务草案`）。实现与判据化（GOAL + AC）由人评审后再另行立案，**本任务不写任何代码、不改任何现有文档**。

**为什么需要这份文档。** 排查 transcript 贴底/流式这类输入输出问题时，今天没有可控的复现手段：唯一能端到端产生输出的路径是真 CLI 进程；`e2e/transcript-follow.spec.ts` 的 in-page wire double（`installWireDouble`/`__injectStreamFrame`/`startWireStream`）只替换浏览器 `window.WebSocket`、只注入 `stream_delta`/`stream_end`，完全跳过后端（runtime、归一化、`seq`/重放、`complete`、权限帧）；而被外部 CLI 写入、app 仅旁观的会话（chokidar → `session_upserted` → REST 重取整行）零 e2e 覆盖。

**实测证据（本任务立此文档的直接动因）。** 运行中的服务上，会话 `b1d82965` 在意图仍为「跟随」（`Scroll to bottom` 按钮全程未出现）时，每追加一行就把视口比底部多留 50–130px，20 秒累积到 552px 且跟随不再自行修复；每个新行首帧高度恰为 240px（`src/index.css` 的 `.chat-message.assistant` → `contain-intrinsic-size: auto 240px`），下一帧落到真实高度（24–71px）；随后 `judgeTranscriptGrowth`（`src/modules/chat/hooks/useChatSessionState.ts`）因 `|scrollTop − previousBottom| > TRANSCRIPT_FOLLOW_TOLERANCE_PX` 判定「用户把视口拿回去了」而拒绝再 pin。逐字读数与探针说明存于 `/data/scratch/yale/qa-follow-b1d8/evidence.md`（探针脚本与一次性凭据已回收）。

**文档必须记录的七条决策**（每条都要写明理由、代价、以及被否决的替代方案；这是本任务的实质内容，不是目录）：

1. 两个面、一个引擎：应用内一等公民的调试 Agent + dev-only 控制面，二者共用同一场景引擎与同一份场景文档。
2. 调试 Agent 用**运行期 provider id**（只加 registry 键 + 一次显式 id cast），**刻意不进 `LLMProvider` 联合**——因为联合是产品声明，进去就要改约 9 处编译强制点（`server/shared/types.ts`、`src/shared/types.ts` 的同名重复联合、`provider.registry.ts`、`provider-capabilities.service.ts`、`session-synchronizer.service.ts`、`useChatProviderState.ts`、`src/shared/constants.ts`、`sidebarProjectFormatting.ts`、`ProviderSkills.tsx`）外加约 10 处用户可见数组，并需要第二个门控把它摘出去；文档要给出这张代价表，并记录被否决的替代（顶替 claude runtime）及其代价（整个实例变合成）。
3. env 门控（`DEBUG_AGENT` 等），默认关闭且**关就是结构性关**：registry 无键、路由未挂载、watcher 无根、capabilities 无条目。
4. 必须写**真实形态 transcript**（claude 方言 JSONL，且行→帧交给真实 `normalizeMessage`）：app 不持久化任何消息，仅发帧的合成流会在 `complete` 触发的 REST 重取后与历史不一致；这条同时给出「禁止第二套词表」的静态守卫。
5. 两条摄入路径都要能驱动，含外部写入路径（`sync:false` 走真实 watcher，6s 轮询 + 500ms 去抖 ⇒ 判据要给 ≥8s 预算）。
6. 控制面走 HTTP + 既有 `authenticateToken`，**门控才是安全边界**；说明为何不新增 WS 通道、不新增 CLI 脚本。
7. 禁止第二套事件词表：调试模块只构造方言行，帧只能来自 `normalizeMessage`/`createNormalizedMessage`；用守卫测试与耦合表锁住。

**文档还要给出**（否则不足以支撑下一步派工）：场景文档的 schema（`at` 绝对毫秒、`op` 闭集、`row` vs `grow` 的分界、`dialect`/`transcript.mode`/`expect` 自检块）与 2–3 个可跑示例（含复现上述漂移的那个、以及就地增长的对照）；回放模式的输入/保真承诺与**不**保真的部分；fixture HOME 隔离与清理规则；以及 8 条后续任务（每条带判据 + 取假变体，变体至少覆盖：frames-only、绕过网关、把 `grow` 实现成新行、以及「纯几何断言挡不住 frames-only」这一点）。

**本任务不做**：不实现引擎/provider/控制面；不改 `docs/architecture/02-realtime-stream.md`（其已证伪的断言「Cursor and OpenCode stream; Claude and Codex do not」是否一并修正，作为评审时的开放问题写进文档）；不立 GOAL/Frontmatter 之外的状态变更（评审通过后另行立案，正文不点名任何未完成任务 id）。

<!-- dedup-ref -->
**同机制去重结论（仅溯源，非前置）**：`tasks/` 内无同机制任务——grep 「调试 Agent / 合成 provider / synthetic provider / 假 CLI / 场景脚本」零命中。相邻但机制不同的既有任务（`gap-e2e-hardcoded-ports-collide`、`gap-e2e-onboarding-anchor-seeded-transcripts`、`gap-claude-runtime-frame-forwarding-coverage`、`gap-scripts-static-gates-and-mint-token`）在测试机制这一片区域相邻，但分别处理端口、播种时序、转发覆盖、静态门禁，与本任务的「可控合成产出源」不是同一机制，因此不构成重复，也不作为本任务的前提。

## AC

- [x] `adr/ADR-003-*.md` 存在，且 frontmatter 的 `id: ADR-003`、`status: proposed` 可按行读出。命令：`ls adr/ADR-003-*.md && head -6 adr/ADR-003-*.md`；失败时输出 `missing ADR-003 file` 或逐行打印实际 frontmatter。
- [x] 七条决策各成一个 `### 决策 N：…` 小节。命令：`grep -c '^### 决策 ' adr/ADR-003-*.md` 必须等于 7，且命令打印实际计数（不足时打印命中的标题逐条）。
- [x] 每条决策都写明代价与被否决的替代。命令：`awk '/^### 决策 /{n++} /代价/{c++} /被否决|替代方案/{a++} END{printf "decisions=%d cost=%d alt=%d\n",n,c,a; if(n!=7||c<7||a<7) exit 1}' adr/ADR-003-*.md`，退出码 0。
- [x] 文档内引用一律用符号名，不出现 `文件:行号` 形式。命令：`grep -nE '[A-Za-z0-9_/.-]+\.(ts|tsx|js|mjs):[0-9]+' adr/ADR-003-*.md` 无输出（退出码 1）；命中时逐行打印。
- [x] 后续任务草案为 8 条，且每条都带判据与取假变体。命令：`grep -c '取假变体' adr/ADR-003-*.md` ≥ 8，并打印实际计数。
- [x] 场景 schema 有可跑示例 ≥2 个，其中至少一个断言「整行追加」（`op: "row"`）与一个断言「就地增长」（`op: "grow"`）。命令：`grep -c '"op": "row"' …` ≥1 且 `grep -c '"op": "grow"' …` ≥1，打印两个计数。
- [x] 本任务未产生任何代码或对既有文档的改动。命令：`git diff --name-only develop -- . ':!adr/ADR-003-*.md' ':!tasks/gap-debug-agent-synthetic-provider-adr.md'` 无输出。
- [x] 文档不写本机绝对路径（`/data/home/…`、`/data/scratch/…`）。命令：`grep -nE '/data/(home|scratch)/' adr/ADR-003-*.md` 无输出；命中时逐行打印。

## DoD

真实落地判据（不是「文件存在」）：这份 ADR 必须**能被下一步直接引用**——评审判定它的七条决策（含代价与被否决的替代）、控制面与场景 schema、门控与安全边界、以及 8 条带判据与取假变体的后续任务，足以支撑立目标与派工，而**不需要回来补设计**。承重性由三件事正面证明：

(a) 每条决策都点得出替代与代价（AC-2/AC-3 的读数），而不是单方面陈述；
(b) 文档引用的每处机制都能在代码里按符号名 grep 到（AC-4），即它不是凭记忆写的；
(c) 文档描述的能力**今天确实不存在**——`grep -rn 'debug-agent' server/ src/ e2e/ scripts/` 无输出，这条空读数既是本任务存在的理由，也防止把已实现的东西重述一遍冒充设计。

另需在完成记录里如实登记：探针与一次性观察凭据已回收（`scripts/mint-token.mjs revoke` 后 401 已验证）；本次设计所依据的现场读数来自一次会话一台设备的一种内容配比，**不是**可复现阈值——文档必须把「类」与「现场数字」分开，后续判据的阈值由运行导出或写成区间。

人评审是本任务 DoD 的一部分：结论（通过 / 要求修订）须记录在正文的 Adjudication 小节里；未获评审前不得置 done。

L_D 该轴仍暗，理由：本任务只落一份设计文档，不新增产品领域能力，也没有可读出的领域读数；判定面由 AC 的文件级机械检查与人的评审承担。
L_G 该轴仍暗，理由：同上——目标层判据（贴底漂移类的可复现性）属于评审后另立的目标，本任务不新增 goal 判据。

## Touches

- adr/ADR-003-可控制的调试-agent-不跑真-cli-也能产生输出.md (new)
- tasks/gap-debug-agent-synthetic-provider-adr.md
