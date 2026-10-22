---
id: gap-voice-asr-provider-seam-adr
title: ADR-004：语音识别 Provider 缝 —— 环境中立的适配器契约与能力声明（只落设计文档，不实现）
status: done
needs_human_cause: unclassified
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
---
---
id: gap-voice-asr-provider-seam-adr
title: ADR-004：语音识别 Provider 缝 —— 环境中立的适配器契约与能力声明（只落设计文档，不实现）
status: done
needs_human_cause: unclassified
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
---
---
id: gap-voice-asr-provider-seam-adr
title: ADR-004：语音识别 Provider 缝 —— 环境中立的适配器契约与能力声明（只落设计文档，不实现）
status: done
needs_human_cause: unclassified
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
---
## Proposal

**交付物：对已落盘的 `adr/ADR-004-*.md`（第二版）的评审立案与机械核验。** 本任务不写实现、不改任何既有实现、不改任何目标或判据；可写面只有该 ADR（评审要求修订时）与本任务文件。

**为什么需要这条任务。** 语音链路今天只支持 OpenAI-compatible 一种识别服务，而「支持任意识别服务」是配置层面的假象：协议形状硬编码在**四处**（两跳各自的请求构造与响应解析），服务之间的能力差异在代码里没有任何地方可以表达（内联上限、计费单位、是否承认提示词、停顿线索对该识别器是破坏性还是有用）。ADR-004 把这件事立成九条决策与十条后续任务草案，本任务负责核验它**确实承载了这些**，并把它送人评审。

**本版（第二版）为什么重验。** 第一版曾以 8/8 绿 + done 结案，但那次结案发生在人评审之前——人评审当时写在 DoD 散文里，而门的机械判据只评估 AC 的勾选状态，不评估散文，于是机械 fan-in 把它置为 done（worker 自己的完成记录明确写了不置 done）。同时 ADR 已修订为第二版，本任务的形状判据随之变化。因此本次退回重验，并把「人评审」**从 DoD 散文提升为一条 AC**（见 AC9）。

**ADR 第二版相对第一版的实质修订**（本任务只核验，不复述论证）：协议硬编码点三处→四处且区分两跳；响应解析更正为两处、容忍度不同；CLI 由裸 node 改为 `npx tsx`；落点新增四个障碍与两条可选路径；后备方案新增「缺口一/三不可实现」的后果，两条后续任务转为有条件；内联上限更正为整个请求的预算并改名；MIME 白名单须按基类型匹配；缺口二更正为两层；补上 lib 对称的另一半、未注册 provider id 的 fail-closed 行为、以及一条须显式保留的安全不变式。

**文档承载的九条决策**（正文各成一个以「决策 N：」开头的三级小节）：

1. 差异用适配器缝加能力声明表达，不用配置字段表达。
2. 适配器必须环境中立；落点由边界探针决定，且探针的四个障碍必须先解决。
3. 边界探针是一个闸，后备方案必须连同「服务端不可达」的后果一起写死。
4. 三处既有缺口由能力声明驱动修复；但「单一计算点」这个说法是错的（必然分两层）。
5. 输出信封扩为 text / style / transformations 三字段，指标随之分轴。
6. 上下文偏置默认关闭，按服务分别测，且与内联请求预算相撞。
7. 保留直连拓扑；provider id 的真相源在用户级配置，且必须定义「认不出来」时的行为。
8. 区分「进 AC」与「只进实验记录」。
9. 既有「服务端保持纯透传」是阶段性约束，现提议修订（只提议，不执行）。

**本任务不做**：不实现适配器、不写命令行、不改任何服务端或前端代码；不改目标与判据；不新增任何阈值；不在正文点名任何未完成任务 id。

**同机制去重结论（仅溯源，非前置）**：`tasks/` 内无同机制任务。相邻但机制不同的既有语音任务分别处理静音裁剪、标识符修复、语音设置存储、录音回放与调试开关，与本任务的「可插拔识别服务缝的设计记录之评审」不是同一机制。

## AC

- [x] AC1 `adr/ADR-004-*.md` 存在，frontmatter 的 `id: ADR-004` 与 `status: proposed` 可按行读出。命令：`ls adr/ADR-004-*.md && head -5 adr/ADR-004-*.md`。失败时输出 `missing ADR-004 file`，或逐行打印实际 frontmatter。取假形态：把 status 擅自改成 accepted 而未经人评审，本判据仍绿——故本判据只覆盖「文件与 frontmatter 存在」，评审状态由 AC9 承担。
- [x] AC2 九条决策各成一个以「决策 N：」开头的三级小节。命令：`grep -c '^### 决策 ' adr/ADR-004-*.md` 必须等于 9，且打印实际计数；不足时逐条打印命中的标题。
- [x] AC3 每条决策都写明代价与被否决的替代。命令：`awk '/^### 决策 /{n++} /^\*\*代价：\*\*/{c++} /^\*\*被否决的替代：\*\*/{a++} END{printf "decisions=%d cost=%d alt=%d\n",n,c,a; if(n!=9||c!=9||a!=9) exit 1}' adr/ADR-004-*.md`，退出码 0。取假形态：删掉任一条决策的「被否决的替代」段使 a 变 8，本判据必须红。
- [x] AC4 后续任务草案为 10 条，其中 8 条带逐条取假变体、2 条按决策 8 明确移出判据集。命令：`grep -c '^### 后续任务 ' adr/ADR-004-*.md` 等于 10，`grep -c '\*\*取假变体：\*\*' adr/ADR-004-*.md` 等于 8，`grep -c '不判据化' adr/ADR-004-*.md` 不小于 2；打印三个实际计数。**为什么是 8 而不是 10**：决策 8 已把「需要联网真跑」与「需要 style: written 服务」的两条排除出判据集，对它们再要求取假变体就与决策 8 自相矛盾。取假形态：只堆 10 个小节标题、在散文里提及「取假变体」凑数而不逐条给出 ⇒ 严口径计数不等于 8，必须红。
- [x] AC5 文档内引用一律用符号名，不出现「文件加行号」的引用形式。命令：`grep -nE '[A-Za-z0-9_/.-]+\.(ts|tsx|js|mjs|json|md):[0-9]' adr/ADR-004-*.md` 无输出（退出码 1）；命中时逐行打印。
- [x] AC6 文档不写本机绝对路径。命令：`grep -nE '/data/(home|scratch)/' adr/ADR-004-*.md` 无输出；命中时逐行打印。
- [x] AC7 设计提案与设计文档互引，且写明冲突时的权威顺序。命令：`grep -c 'voice-asr-provider-seam.md' adr/ADR-004-*.md` 不小于 1，`grep -c 'ADR-004' docs/proposals/voice-asr-provider-seam.md` 不小于 1，且两处都能命中「为准」二字；打印四处实际命中。取假形态：只保留单向引用使其中一条计数为 0，本判据必须红。
- [x] AC8 本任务未产生任何代码、未改动任何既有文档或目标。命令：`git diff --name-only "$(git merge-base develop HEAD)" -- . ':!adr/ADR-004-*.md' ':!tasks/gap-voice-asr-provider-seam-adr.md'` 无输出；命中时逐行打印。用 merge-base 而非裸 develop：develop 会随其它任务的 fan-in 前进，拿裸 develop 比会把别人的提交读成本任务的改动。
- [x] AC9 **人评审门：ADR 的评审裁定已由人给出。** 命令：`grep -c '^status: accepted' adr/ADR-004-*.md` 必须不小于 1（即在人授意下由 `proposed` 转为 `accepted`）。**这条 AC 不得由 worker 自行勾选。** 若裁定尚未给出，本 AC 保持未勾，本任务不得置 done，且必须停在 `needs-human` 等人工裁定。

## DoD

真实落地判据（不是「文件存在」）：这份 ADR 必须**能被下一步直接引用**——评审判定它的九条决策（含代价与被否决的替代）、能力声明的逐字段出处、文件落点与边界探针（含四个障碍与后备方案的后果）、以及十条后续任务草案，足以支撑立目标与派工，而**不需要回来补设计**。承重性由三件事正面证明：

(a) 每条决策都点得出替代与代价（AC2/AC3 的读数）；
(b) 文档引用的每处机制都能在代码里按符号名 grep 到（AC5 反向保证它不以易变的行号定位）；
(c) 文档描述的能力**今天确实不存在**——对语音链路做一次「provider / 能力声明 / 适配器」的检索应当无命中。这条空读数既是本任务存在的理由，也防止把已实现的东西重述一遍冒充设计。

**人评审是本任务 DoD 的一部分，且已由 AC9 机械承载**（第一版把它写成散文，结果被机械 fan-in 绕过；这次不允许重演）。裁定结论记在 ADR 的 Adjudication 小节；若要求修订，修订落在同一份 ADR 内，本任务的形状判据随修订重跑。

**停在 needs-human 而不是 done**：若 AC1–AC8 已满足而 AC9 未满足，正确终态是 `needs-human`（等人工裁定），**不是** done。这条是本次退回重验的主要目的。

另需在完成记录里如实登记两点：三处缺口的现场依据来自一次对语音链路的完整通读，**未做运行期复现**；ADR 中引用的 20MB、25MB、10 秒下限、−89%、25.5% 等数字均为既有代码、官方文档或既有实验记录里的既成值，未新立阈值。

L_D 该轴仍暗，理由：本任务只核验一份设计文档并送评审，不新增产品领域能力，也没有可读出的领域读数；判定面由 AC 的文件级机械检查与人的评审承担。
L_G 该轴仍暗，理由：同上——目标层判据（新识别服务在直连、代理、命令行三条路径上真的可换）属于评审通过后另立的目标，本任务不新增 goal 判据。

## Touches

- adr/ADR-004-语音识别-provider-缝-环境中立的适配器契约与能力声明.md
- tasks/gap-voice-asr-provider-seam-adr.md

## Evidence

**本轮（2026-09-22，worker 续做）逐条核验 AC1–AC8，读数如下**（命令逐字取自上文，均在任务 worktree 内执行）：

- AC1：ADR 文件存在，frontmatter 前 5 行读出 `id: ADR-004` 与 `status: proposed`。
- AC2：三条小节严口径计数为 9，等于 9。
- AC3：awk 严口径读数 `decisions=9 cost=9 alt=9`，退出码 0。
- AC4：三条计数为「后续任务 10」「取假变体 8」「不判据化 5」；后两条分别等于 8、不小于 2。
- AC5：行号式引用检索无输出（退出码 1）。
- AC6：本机绝对路径检索无输出（退出码 1）。
- AC7：ADR 引设计提案 1 处，设计提案引 ADR 2 处，两处均命中「为准」。
- AC8：以 merge-base 为基线的 diff 无输出——本任务未产生代码、未改既有文档或目标。

**DoD 承重性两处的正面读数。**(b) 文档点名引用的既有符号可在代码里按符号名 grep 到：`VoiceRequestOverrides`、`sttModel`、`response_format` 均有命中；`LIMIT_FILE_SIZE` 命中的是同一 multer 错误码的判定位置，语音模块以 `limits: { fileSize: 25 * 1024 * 1024 }` 与之对应。`maxInlineRequestBytes`、`acceptsMime` 等零命中是**应当的**——它们是本文档新提议的能力字段名而非既有符号，文档本身正是以「原稿把它建模为音频字节上限」说明其改名。(c) 对语音链路检索 provider / 能力声明 / 适配器：`server/modules/voice/` 与语音相关前端路径下无一处命中该机制（唯一命中是一处测试标题里的 fetch 适配器一词，与识别服务缝无关）。空读数成立：文档描述的能力今天确实不存在。

**AC9 未满足，诚实读数为 0。** `grep -c '^status: accepted'` 返回 0，ADR-004 仍为 `proposed`。且**人已在其裁决记录里写死这一点**（ADR 的 Adjudication 追加节，随 develop 的 `62aea1bf` 落盘）：七条开放问题已逐条裁定，但「总判定（通过 / 要求修订）尚未给出……AC9 因此保持未勾，本 ADR 保持 `proposed`」。故 AC9 依其自身文本不得由 worker 勾选。

**终态。** AC1–AC8 已满足而 AC9 未满足 ⇒ 依上文的 DoD 条目「停在 needs-human 而不是 done」，本任务不得置 done，正确终态是 `needs-human`（等人工裁定）。worker 不自行改写 `status:` 字段，本轮的收尾由 driver 机械完成。**人需要给出的唯一一项裁定是 ADR-004 第二版的「总判定」（通过 / 要求修订）**；人另需一并裁决作者自陈的过程性保留——第二版未经独立评审。

**DoD 要求如实登记的两点。** 其一，三处缺口的现场依据来自一次对语音链路的完整通读，未做运行期复现。其二，文中 20MB、25MB、10 秒下限、−89%、25.5% 等数字均为既有代码、官方文档或既有实验记录里的既成值，未新立阈值。

## Resolution

**执行 2026-09-22 — 人评审裁定已给出，AC9 的判据随之满足，本任务可合法结案。**

- 裁定人：人 yale。裁定日期：2026-09-22。裁定结论：**总判定「通过」**。
- ADR-004 的 frontmatter 已由**被授权的 ADR 写入路径**由 `proposed` 转为 `status: accepted`（提交 `068b0fcf`）。因此 AC9 的判据 `grep -c '^status: accepted' adr/ADR-004-*.md` 不小于 1 成立。
- 裁定正文记录在 ADR-004 的 Adjudication 小节（小节标题「总判定（人 yale 2026-09-22）」，随提交 `9f86bca3` 落盘）。
- 此前停在 `needs-human` 是 AC9 未满足时 DoD 规定的**设计终态**，非缺陷；现解除条件已由人给出，故先勾选 AC9，再退回并按 todo→ready→done 正常推进。
- 本小节登记的是**人的裁定**，不是 worker 的自我判定；worker 只据该裁定勾选 AC9 的机械判据，未改写任何其它字段。

## Needs-Human

**执行 2026-09-22T14:56:05.093Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- ⚠️ **订正（2026-09-22 23:13 记入，事后记录卫生订正）**：上面「阻碍原因」与「成因类」**均不成立**，不是本任务的真实阻碍。本任务是**纯文档 delta**，`.quay/fan-in-gap-voice-asr-provider-seam-adr-wk-prod-anchor.log` 明确记录 \`{"step":"delta","ok":true,"reason":"doc-only delta → skip suite"}\` 与 \`{"step":"suite-skip","ok":true,"reason":"doc-only-delta"}\` —— **套件被跳过、从未运行，故不存在任何可红的 suite**。「suite 红但归因不出失败测试文件」是重试上限机械翻转路径的兜底签名，不是观测；**不要据它去寻找失败测试文件**（那样的文件不存在）。真实阻碍即同段「判词」行：AC 未全勾（checked 8/9），唯一未勾者为 AC9（人评审门）—— 这正是本任务 DoD 规定的正确终态。
- ⚠️ **订正后的事实**：AC9 的条件已于 2026-09-22 由人 yale 的总判定「通过」满足（ADR-004 `### 总判定（人 yale 2026-09-22）` 小节；`status` 由 `proposed` 翻为 `accepted`，提交 `068b0fcf`）。顶层 `needs_human_cause: unclassified` 与 `extra.needs_human_cause: human-adjudication` 的不一致，以后者为准。
- 成因类：unclassified
- 失败步/判词：AC 未全勾（checked 8/9，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：247cc21a-a0e7-4742-aecd-3f810598af10
