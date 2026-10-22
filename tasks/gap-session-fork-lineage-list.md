---
id: gap-session-fork-lineage-list
title: 会话列表按血缘分组与分支标识
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on: []
goal_ac: " "
---
## Proposal

<!-- dedup-ref --> 落地 fork 血缘在会话列表中的可见性：把一个被 fork 出来的会话放回它的源会话旁，用固定宽度的分支徽标承载「这是分支」，并让 fork 的默认名继承源名（不再追加 `(fork)`）。

### 现状与缺口

`forked_from_session_id` 有列、有索引（`migrations.ts:696`），但**只被写、从不被读**：projects 接口把会话映射成 `{id, provider, summary, messageCount, lastActivity}`（`projects-with-sessions-fetch.service.ts:148`），不含血缘。UI 唯一能用的信号就是名字里的 `" (fork)"` 后缀，而侧边栏名字列只有约 145px（`md:w-72` 固定宽、无拖拽改宽），实测该后缀必然被省略号吃掉——`移动端输入框换行与回车发送 (fork)` 需要 220px，只有 141px 可用。于是一对 fork 在列表里渲染成两行**完全一样**的文字。

浏览器实测（1600×1000 窗口，真实实例）：可见 20 行中 **19 行被裁**、**5 组「渲染后无法区分」**。fork 只是其中一组；其余 4 组是别的成因（同名手写、超长提示词、AI 标题撞车），不在本任务范围。

Conversations（最近会话）列表更糟：它更宽，会把**完整的同名**显示两遍，既无徽标也不分组。

### 方案

已在 `.worktrees/fork-lineage-ux` 的沙箱里热改验证过（独立 3101/5273 + 真实库副本，未触碰线上 3001）：

1. **传输**：`projects-with-sessions-fetch.service.ts` 的 `SessionSummary` 增加 `forkedFromSessionId`；行类型补 `forked_from_session_id`（列已在 `SESSION_ROW_COLUMNS` 里，无需迁移）。`src/shared/types.ts` 的 `ProjectSession` 增加同名字段。
2. **分组**：`src/modules/sidebar/utils/groupSessionsByLineage.ts`（新）——纯函数，接已按时间排序的列表，把分支移到源行正下方。**整组按组内最新成员定位**（实测：新分支会把整组上浮到它的槽位，而不是沉到源行的旧槽位）。源不在本页（分页 20 条）或链成环时**保持原样**，绝不隐藏行。
3. **渲染**：`SidebarSessionItem.tsx` 在**截断盒之外**加一个固定 20px 的分支徽标；`__lineageDepth > 0` 的行缩进并加左侧连接线。源有 **≥2 个分支时徽标显示序号**（实测 aria-label 为 `Branch 1 of 2` / `Branch 2 of 2`，可见文本为 `1` / `2`），单分支仍显示 GitBranch 图标。
4. **命名**：`sessions.service.ts:284` 的 fork 默认名改为继承源名（`options.title?.trim() || source.custom_name?.trim() || 'Session'`），去掉 `(fork)`。名字回归「话题」，结构表达「关系」。
5. **第二个界面**：`session-conversations-search.service.ts` 的条目补 `forkedFromSessionId`，`ArchivedSessionListItem` / `RecentConversationListItem` 同步，`SidebarRecentConversations.tsx` 复用同一 util 与徽标。该列表是跨项目的全局最近列表，源常常不在页内——util 的「源不在列表」退化路径正好覆盖，徽标始终显示。
6. **i18n**：`tooltips.branchedSession` 与 `tooltips.branchedSessionOrdinal`（带 `{{index}}` / `{{count}}` 插值）需进全部 **12** 个 locale 的 `src/modules/i18n/locales/<lang>/sidebar.json`。

### 边界（不做）

- **不迁移既有 fork 的名字**：现有 3 条 fork 里有 2 条名字含 `(fork)`，保持不动。徽标与分组由 `forked_from_session_id` 驱动、与名字无关，所以它们**立刻**获得分组与徽标，无需数据迁移。
- 不修其他 4 组同名（非血缘成因：同名手写、超长提示词、AI 标题撞车）。
- 不做 `jsonl_path IS NULL` 的幽灵行清理（`getSessionsWithTranscriptPath` 只处理有路径的行）——另开任务。
- 不改侧边栏固定宽度、不加拖拽改宽。

## AC

- [x] `npx vitest run src/modules/sidebar` 退出码 0，且 `groupSessionsByLineage.test.ts` 覆盖：整组按最新成员定位（含反例：最新成员比邻居旧时整组下沉）、源不在列表时保持原样、成环不丢行、自引用视为无分支、二级分支 depth=2、单分支 count=1
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-fork.test.ts` 退出码 0，且断言 fork 的 `custom_name` 等于源名（不再等于 `源名 (fork)`）
- [x] `GET /api/projects` 的每条 session 带 `forkedFromSessionId`（fork 行为源 id，非 fork 行为 null）
- [x] 侧边栏中 fork 行渲染出分支徽标，且徽标在名字截断盒之外（`aria-label` 为 `Branched from another session` 或 `Branch N of M`）
- [x] 源有 ≥2 个分支时徽标显示序号（可见文本为序号数字），单分支时为 GitBranch 图标
- [x] fork 行缩进于源行且两者相邻（`left` 差 ≥ 12px）
- [x] 整组位于其最新成员的槽位：最新成员是分支时该组上浮，最新成员比邻居旧时该组下沉
- [x] Conversations 列表同样出现分支徽标
- [x] 12 个 locale 的 `sidebar.json` 均含 `tooltips.branchedSession` 与 `tooltips.branchedSessionOrdinal`
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是「徽标存在」，而是**一对同名 fork 在真实浏览器里不再需要读名字就能区分**，且分组规则在边界上不丢行。承重性由取假形态证明：

- 把 `groupSessionsByLineage` 直接 `return sessions`（不分组）⇒「fork 行缩进于源行且两者相邻」必须红；
- 把徽标移进截断盒内（改成名字后缀）⇒「徽标在截断盒之外」必须红；
- 把整组锚点改回源行 ⇒「最新成员是分支时该组上浮」必须红。
- 把 recents 映射里的 `forkedFromSessionId` 去掉 ⇒「recent sessions carry the source id for a branched conversation」必须红（该字段只会是 `undefined`，不再是源 id）；

实测读数（沙箱、真实库副本）：可见 20 行中碰撞组 **5 → 4**（消失的那组正是这对 fork）；分支行名字框 145 → 91px（缩进 21px + 徽标 28px），序号徽标 `1` / `2`。**代价必须写进结论**：分支行可见字数由约 9 字降到约 5 字，这是把身份从名字挪到结构的代价，不是缺陷。

L_D 该轴仍暗，理由：本任务只改变会话在列表中的**呈现与分组**，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是渲染可区分性与列表顺序，不是生成质量轴读数。

## Touches

- server/modules/projects/services/projects-with-sessions-fetch.service.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/services/session-conversations-search.service.ts
- server/modules/providers/tests/session-fork.test.ts
- server/modules/providers/tests/sessions.service.test.ts
- src/shared/types.ts
- src/modules/sidebar/utils/groupSessionsByLineage.ts (new)
- src/modules/sidebar/utils/sidebarProjectFormatting.ts
- src/modules/sidebar/SessionBranchBadge.tsx (new)
- src/modules/sidebar/SidebarSessionItem.tsx
- src/modules/sidebar/SidebarRecentConversations.tsx
- src/modules/sidebar/tests/groupSessionsByLineage.test.ts (new)
- src/modules/i18n/locales/de/sidebar.json
- src/modules/i18n/locales/en/sidebar.json
- src/modules/i18n/locales/es/sidebar.json
- src/modules/i18n/locales/fr/sidebar.json
- src/modules/i18n/locales/id/sidebar.json
- src/modules/i18n/locales/it/sidebar.json
- src/modules/i18n/locales/ja/sidebar.json
- src/modules/i18n/locales/ko/sidebar.json
- src/modules/i18n/locales/ru/sidebar.json
- src/modules/i18n/locales/tr/sidebar.json
- src/modules/i18n/locales/zh-CN/sidebar.json
- src/modules/i18n/locales/zh-TW/sidebar.json
- tasks/gap-session-fork-lineage-list.md

## Evidence

上一轮 fan-in 的 suite 红：`server/modules/providers/tests/sessions.service.test.ts`，
`AssertionError: Expected values to be strictly deep-equal`（scoped 门为绿）。

**真因**：本分支给 `listRecentSessions` 的载荷加了 `forkedFromSessionId`
（`sessions.service.ts` 的 `RecentSessionListItem`），而该文件的既有用例用
`assert.deepEqual`（`node:assert/strict`，即严格深比较）逐字段钉住整页载荷，期望对象里没有这个新字段。
实际多出的键就是它。这不是并发抖动：文件在 worktree 里**独立运行同样必红**（7 例 1 红）。

**为什么 scoped 门当时是绿的**：`scripts/test.sh --for-task` 只跑
Touches 里匹配 `*.test.*` 的文件；本任务当时只声明了 `session-fork.test.ts`，
于是这个受影响的既有文件根本没被 scoped 门覆盖。修法因此有两半：改用例，**并把该文件补进 Touches**——
后半是结构性的，它让同一回归下次会被 scoped 门而不是整套 suite 抓到。

**改动**：① 既有用例的期望对象补上 `forkedFromSessionId: null`（仍在严格深比较内，
所以载荷若悄悄丢字段会红而不是绿）；② 新增用例
`recent sessions carry the source id for a branched conversation`：造 source + fork 一对，
断言分支行取到源 id、源行取 null，并断言两行的 `sessionTitle` 相同（这一对的同名是刻意的，
可区分性由血缘而非名字提供）。② 取假形态可证：去掉映射里的字段，分支行读到 `undefined`，必红。

**读数**：`sessions.service.test.ts` 独立 `--test` 8 例 8 过（修前 7 例 1 红）；
`npx vitest run src/modules/sidebar` 7 文件 43 例全过、退出码 0；
`session-fork.test.ts` 7 例全过；`npm run lint` 与 `npm run typecheck` 退出码 0。
