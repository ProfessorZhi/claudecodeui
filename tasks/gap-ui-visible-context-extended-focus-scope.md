---
id: gap-ui-visible-context-extended-focus-scope
title: 规划 ui_visible_context 扩展范围：focused/selected message、selected text、current
  diff、current task 四个维度各自的现状与落地范围（先定范围，避免过度扩展）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

背景（2026-10-07 与用户讨论）：`ui_visible_context`（已完成的任务 `gap-mcp-ui-visible-context`，后续又被 `gap-mcp-ui-visible-context-null-range-in-real-browser` 修过真实浏览器下的范围读取缺陷）目前已经覆盖：每台设备/标签页的 `visibility`、`hasFocus`、`navigationPolicy`、`panel`、`selectedProject`、`selectedSession`、`visibleMessages: {first,last}`（可见消息的**范围**，不是"聚焦的单条消息"）、`pendingApprovals`、`queuedMessages`。用户希望进一步规划四个新维度：focused/selected message、selected text、current diff、current task。这四个维度目前在代码库里的现状差异很大，直接开工容易过度扩展，所以本任务先摸清楚每个维度的现状与最小可行范围，再拆成可实施任务。

现状（已读代码核实，逐维度）：

1. **focused/selected message**：现有 `visibleMessages` 是「视口内第一条到最后一条」的**范围**，不是「用户当前正在看/操作的那一条」。代码库里没有找到「用户聚焦单条消息」的既有状态（例如 hover、点击选中、正在回复的消息）；这个概念需要先在前端确认有没有对应的交互（例如"引用回复"功能选中的消息），没有就要先定义"聚焦"的触发条件是什么，否则没有数据源可读。
2. **selected text**：`grep -rln "selectedText\|getSelection\|selectionchange" src` 只命中 `src/modules/shell/`（终端 xterm 的文本选择，与聊天转录无关）。聊天转录区域目前没有任何「浏览器文本选择」的读取逻辑。读取 `window.getSelection()` 需要考虑：选区可能跨多条消息、可能在非转录区域（例如侧边栏）、以及读取用户选中的文本本身是否构成需要在工具 description 与 scope 层面特别说明的隐私/敏感信息（选中的文本可能包含用户不希望被动读取的内容）。
3. **current diff**：`src/modules/git-panel/` 已经是成熟模块，`GitDiffViewer.tsx` + `useGitPanelController.ts` 管理 `gitDiff: GitDiffMap`（按文件路径的 diff 内容）与一堆面板状态（`currentBranch`、`isLoading`…），但**没有找到**「当前用户正展开/聚焦哪一个文件的 diff」这个单一状态（`grep -n "selectedFile\|activeFile\|currentFile" src/modules/git-panel/hooks/useGitPanelController.ts` 为空）——需要先确认 Git 面板的 UI 交互模型里"正在看哪个文件的 diff"是否是一个有意义、可读取的瞬时状态，还是多个文件 diff 同屏展开、没有单一"当前"的概念。
4. **current task**：`src/shared/types.ts` 里的 `QuayTaskCounts` 只是任务数量统计（给侧边栏徽标用），不是"当前选中/聚焦哪个 quay 任务"。全仓库前端代码里没有找到"任务面板选中单个任务"的概念——CloudCodeUI 的 UI 层目前可能根本没有一个"浏览/聚焦单个 quay 任务"的界面，这个维度可能需要先确认它是否存在于产品范围内，而不是假设它已经存在只是没接到 `ui_visible_context` 上。

要交付（本任务是规划/调查，不实现代码；产出是一份范围决策文档）：

1. 对四个维度逐一给出结论：现在就有数据源可读（可以直接拆出实施任务）、需要先补一个很小的前端状态才有数据源（说明需要补什么，范围多大）、或者该维度目前不构成一个有意义的产品概念（建议搭喂，不拆任务）。
2. 对判定为"现在就能做"或"补一点前端状态就能做"的维度，各写一段可以直接转成独立 `gap-*` 实施任务的范围描述（输入字段、输出字段、安全/隐私层面要不要降级展示——尤其 selected text 这种可能包含敏感信息的字段，是否需要新 scope 或默认不包含在无额外授权的返回里），并给出建议的下一个任务标题与大致 Touches 范围（不要求在本任务内创建它们，留给后续按此文档拆分）。
3. 明确排除/推迟的维度要写明理由，不要只是不处理也不说明。
4. 产出写进 `docs/proposals/ui-visible-context-extended-scope.md`。

<!-- dedup-ref -->机制上去重已核对：`task_list search="ui_visible_context"` 命中的六个任务全部是「设备身份/导航/状态往返的基础设施」或「真实浏览器下的缺陷修复」，没有一个涉及 focused message/selected text/diff/task 这四个新维度，不是重复，是在这些基础设施之上的下一层规划。

## AC

- [x] `docs/proposals/ui-visible-context-extended-scope.md` 文件存在，且对四个维度（focused/selected message、selected text、current diff、current task）逐一给出三态判定之一：「可直接拆实施任务」/「需要先补前端状态」/「暂不纳入」，缺一个维度的判定算不满足。
- [x] 对判定为「可直接拆实施任务」或「需要先补前端状态」的每个维度，文档里有一段范围描述，包含：读取的数据源（现有状态或待补状态的名字/文件）、`ui_visible_context` 返回里新增的字段名与类型、该字段是否需要新 scope 或降级展示的决定（尤其 selected text）、以及建议的下一个实施任务标题。
- [x] 对判定为「暂不纳入」的维度，文档里写明具体理由（不能是「以后再看」这种空泛说法，要点名缺失的前端概念或产品范围边界）。
- [x] `grep -n "selected text\|selectedText\|current diff\|currentDiff\|current task\|currentTask\|focused message\|focusedMessage" docs/proposals/ui-visible-context-extended-scope.md` 命中数 ≥ 4（证明四个维度确实都被点名讨论，不是漏项）。
- [x] `npm run typecheck` 退出码 0（确认本任务未意外改动任何前端/后端代码，只新增文档）。

## DoD

四个维度的范围判定已经写成可被后续任务直接引用的文字（不是停留在讨论里），文档内容具体到"下一个任务怎么拆"的程度，而不是停留在"值得做/不值得做"的模糊结论。仅完成一份泛泛而谈、无法直接转成下游任务 Proposal 的文档，不算完成。

## Touches

- docs/proposals/ui-visible-context-extended-scope.md
- tasks/gap-ui-visible-context-extended-focus-scope.md

## Notes

本任务本身不改动 `ui_visible_context` 的实现代码、不新增字段；所有实际的字段新增与前端状态补充都应该作为本任务产出的下游 `gap-*` 任务去做（由本任务的文档描述范围，后续另行用 quay-file-task 立案，不在本任务内创建）。selected text 这个维度尤其要在范围文档里明确讨论"读取用户正在选中的文本"是否需要比 `cloudcli:read` 更高的授权粒度（参考本仓库已有的 `cloudcli:navigate` 这种为单个高敏感动作新开 scope 的先例）。