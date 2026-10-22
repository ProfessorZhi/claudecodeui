---
id: gap-claude-title-ladder-mirror
title: 会话标题读取器镜像 CLI 的 wze 阶梯（四类条目各取最后一条、补 agent-name 档、derived 改
  firstPrompt），并把转录侧名与显式覆盖拆成两列
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

实测背景（2026-09-23；语料为 `~/.claude/projects` 下的 1254 条真实 transcript，CLI 侧读数取自 `node_modules/@anthropic-ai/claude-agent-sdk` 与已安装的 Claude Code 可执行文件）：

Claude Code 自己的会话列表标题阶梯是 `wze()`：

```
agentName || customTitle || aiTitle || summary || firstPrompt || sessionId.slice(0,8)
```

本仓库的读取器 `server/modules/providers/list/claude/claude-session-synchronizer.provider.ts` 建立在两条被 CLI 反驳的前提上：

1. 注释称「`ai-title` 每个文件只写一次、从不修订」。CLI 的 `planReAppendSessionMetadata` **每一轮**都把 `last-prompt, custom-title, ai-title, …` 按这个顺序重写一遍（这正是语料里一条 transcript 会有几十条同名条目的原因）。实测 `~/.claude/projects/-data-home-yale-work-quay-fleet/f55089be-5998-4773-b642-5353bb4cdb2a.jsonl`：第 20 行是 `PWA 会话输入框底部固定可见高度`，第 26 行起改成 `pwa 可见高度优化`。CLI 用 `findLast` 取后者，本仓库 `extractSessionTitle` 在首个 `ai-title` 处即 `return`，取到前者。
2. 注释称「Claude 把改名的 `custom-title` 紧写在对应 `ai-title` 之前」。这只在重写块内成立：`/rename` 走 `saveCustomTitle`，**单独在文件末尾追加一条 `custom-title`**，不带 `ai-title`。于是「先生成标题、之后再 `/rename`」这一情形本仓库永远学不到；`processSessionFile` 对 `name_source` 已是 `ai` 的行不再重读文件，第二重锁也把它挡死。

今天在全机语料上的可观测分歧是 4 条（共 1254 条）：1 条来自前提 1（`ai-title` 被改写），3 条来自阶梯缺 `firstPrompt` 语义（本仓库用最后一条 `last-prompt`，CLI 用第一句；18 条无标题的 transcript 里 11 条有 `last-prompt`）。`agent-name` 出现在 **1172/1254** 条里，其中与 `custom-title` 同值的 1145 条、只有 `agent-name` 的 27 条——**今天零可观测差异，但阶梯缺一层**。`summary` 实测不是 transcript 的条目类型（0/1254），它是会话元数据字段、从 transcript 不可达，本任务明确记为「不适用」而不是「待实现」。

方案：

1. **各取最后一条**：`agent-name` / `custom-title` / `ai-title` / `last-prompt` 都按 CLI 的 `findLast` 语义取值，不再「首个 `ai-title` 即停」。
2. **补 `agent` 档**：阶梯变成 `agent > manual(custom-title) > ai > derived`。`SessionNameSource` 增加 `agent`，`nameSourceRankSql`（`server/modules/database/repositories/sessions.db.ts`）增加第 4 档，`schema.ts` 与 `migrations.ts` 同步（幂等：重复运行不得改写已升级的行）。
3. **derived 档改用 firstPrompt 语义**：取该会话第一条人类可读的 user 文本（剔除 `<command-name>` / `<command-message>` 一类尖括号元数据），不再取最后一条 `last-prompt`。
4. **两端有界的读取**：不能整文件读（现有 AC 把读取量当判据）。做法是从文件尾向前读一个小窗口（标题每轮重写，最后一条通常贴身 EOF），窗口内没找到再回到文件头读一个小窗口（标题的**第一个**实例总是在早期）。两端都必须有独立上界，且都不得退化成整读。
5. **转录侧名与显式覆盖拆成两列**：`sessions` 增加 `transcript_name` + `transcript_name_source`（取值即 CLI 的四档），**每次同步无条件重写**；`custom_name` 从此只表示「用户在 App 里显式改的名」，显示名 = `custom_name ?? transcript_name`。这一条是必须的：`agentName` 在阶梯最前，而 App 的改名只能追加 `custom-title`，只留一列的话用户改的名会在下一次同步被静默回滚。迁移保守：`name_source='manual'` 的既有行保留为显式覆盖，其余把 `custom_name` 搬进 `transcript_name` 并按 `ai`/`derived` 映射来源。
6. `server/modules/providers/services/session-ai-title.service.ts` 同源同错（同样停在首个 `ai-title`），一并改为取最后一条。它读的是 **ai-title 原文**（`/cost` 弹窗要始终显示 Claude 生成的原文，即使已被改名），与显示名是两件事，**不要**与主读取器合并成一个函数。

可追溯：`gap-session-name-source-ai-title` 引入了单列 `name_source` 与本读取器的早停，`gap-session-telemetry-show-ai-title` 引入了同样受影响的 `/cost` 读取器；两者均已 done，本任务修的是它们共同的读取前提。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-title-mirror.test.ts` 退出码 0：用**从 CLI 行为推导的真实形状**夹具（含 `mode` / `permission-mode` / user 行等真实条目，不是最简 JSON）断言阶梯矩阵，每条独立可反红——(a) 同一会话两条不同 `ai-title`（模拟 CLI 修订）取**后**一条；(b) `custom-title` 追加在 `ai-title` **之后**（模拟 `/rename`）取 `custom-title`、来源 `manual`；(c) 行已是 `ai` 来源后追加一条 `custom-title` 并再次同步，名字变为改名后的值（旧的「已 ai 不重读」短路必须消失）；(d) `agent-name` 与 `custom-title` 并存时取 `agent-name`、来源 `agent`（夹具里两者取**不同**字符串，否则同值看不出取了哪个）；(e) 只有 `agent-name`、无任何 `custom-title`/`ai-title` 时取 `agent-name`；(f) 无任何标题条目时 derived 档取**第一句**而非最后一条 `last-prompt`（夹具里第一句与两条 `last-prompt` 三者互不相同）。
- [x] 同一命令下的读取量上界用例：夹具 A「标题条目只在文件尾部、其前有约 24MB 内容」与夹具 B「同一条标题**只有**文件头部那一个实例、其后有约 24MB 内容」都必须满足硬字节上界、**都不得整文件读取**，两个读数（`/proc/self/io` 的 `rchar` 增量）都要打印出来。规模沿用既有夹具量级，不要构造更大的文件。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/sessions-name-source.integration.test.ts` 退出码 0：迁移用例对没有 `transcript_name` 列的旧库连跑两次迁移，第一次按 `name_source` 分流（`manual` 行保留为显式覆盖、其余搬进 `transcript_name`）、第二次无操作；两次之间把一行改成 `agent`，第二次后它仍是 `agent`。并断言 `agent` 档在优先级矩阵里高于 `manual`。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/session-ai-title.test.ts` 退出码 0：`/cost` 的取值在「`ai-title` 有两条不同值」时返回**后**一条；既有全部用例不回归。
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-title-corpus.test.ts` 退出码 0：语料仪器对一份**冻结的真实形状语料**（在测试内按真实条目形状生成，含尖括号元数据行与几十条重复标题条目）逐条比较「读取器会取的名字」与「`wze` 阶梯会取的名字」，分歧数必须为 0；语料里必须**包含**至少一条 `custom-title` 与 `ai-title` 共存的 transcript、一条 `ai-title` 被修订的 transcript、一条只有 `agent-name` 的 transcript。**正控**：把读取器换回「首个 `ai-title` 即停」后同一命令必须非 0，且红的必须来自前两类夹具（第三类保持绿）。
- [x] `npm run typecheck` 与 `npm run lint` 退出码均为 0。

## DoD

真实落地判据：不是仅有单测。要求在**真实临时 `HOME`**（放从真实 CLI 输出形状抄下来的 transcript）上跑真实同步器与真实数据库，读数三处并写进 Evidence：(1) 该会话行的 `transcript_name` 与 `transcript_name_source`；(2) 对同一份 transcript 独立跑一遍 `wze` 阶梯得到的名字；(3) 两者相等。再用一条「用户已在 App 显式改名」的会话证明 `custom_name` 覆盖生效、且**再次同步不会把它回滚**——这一条是本任务第 5 条改动的落地读数，缺它不算完成。

另需一次**真实语料读数**：在本机 `~/.claude/projects` 上跑一次语料仪器，记录分歧条数。修改前实测 4 条，修改后必须为 0 条。诚实标注：该读数依赖本机语料、会随新会话变化，是回归哨兵而非判据；且本机 1238 条有标题的 transcript 里没有一条同时含 `custom-title` 与 `ai-title`，所以「改名声在标题之后」这一分支只能由 AC 的夹具覆盖，语料仪器补不上。

L_D 读数：真实语料上「读取器取名 ≠ wze 阶梯取名」的条数 修改前 = 4，修改后 = 0（分母为 1254 条 transcript）。这是独立的数据读数，不是测试通过与否。

## Evidence

DoD 端到端读数（真实临时 `HOME`，transcript 按真实条目形状写入；真实同步器 `synchronize()` 的发现扫描 + 真实数据库；对同一份 transcript 独立跑一遍 `wze` 阶梯）：

```
$ npx tsx --tsconfig server/tsconfig.json /tmp/gap-title-probe/dod.mjs
indexed=3 bytes_read=831624
[11111111] transcript_name="Repo Index Work" transcript_name_source="manual" display="Repo Index Work" ladder="Repo Index Work" equal=true
[22222222] transcript_name="Release Notes Agent" transcript_name_source="agent" display="Release Notes Agent" ladder="Release Notes Agent" equal=true
[33333333] transcript_name="what does this function do?" transcript_name_source="derived" display="what does this function do?" ladder="what does this function do?" equal=true
divergences=0
[app rename] display="Renamed In The App" name_source="manual" transcript_name="Repo Index Work" transcript_name_source="manual"
```

三条会话各落在阶梯的一档上：`11111111` 的 `ai-title` 在文件中被改写过、随后 CLI 侧 `/rename` 追加了一条 `custom-title`（取后者，来源 `manual`）；`22222222` 只有 `agent-name`；`33333333` 无任何标题条目，取第一句 `what does this function do?`，而文件末尾那条 `last-prompt` 是 `the last thing I typed`（旧读取器会取它）。第 (3) 读数为 `equal=true` / `divergences=0`。

App 改名落地读数：`updateSessionCustomName` 之后整轮重新同步，显示名仍是 `Renamed In The App`（`name_source=manual`），底下的 `transcript_name` 仍是 `Repo Index Work` —— 用户改名没有被回滚。

真实语料读数（本机 `~/.claude/projects`，`/tmp/gap-title-probe/instrument2.mjs`）：

```
classes: {"A-title":1264,"B-firstPrompt":14,"C-nothing":4}
total transcripts: 1282
old-reader vs new-ladder divergences: 11
  其中「旧读取器也给出了名字」的语义分歧 = 4：
    1d179b43 / 1916b5ae / 2749789d  (B-firstPrompt：旧=最后一条 last-prompt，新=第一句)
    f55089be                        (A-title：旧=PWA 会话输入框底部固定可见高度，新=pwa 可见高度优化)
stored rows compared: 1279
stored vs ladder divergences — A(title)=0 B(firstPrompt)=0 C(nothing)=3
```

L_D 读数：真实语料上「读取器取名 ≠ wze 阶梯取名」的条数 —— 修改前 4、修改后 0（分母 1279 条已入库 transcript / 语料 1282 条）。余下 3 条 C 类分歧是**有意的**：transcript 里既无标题条目也无可用第一句时，App 存占位名而 CLI 会显示 `sessionId.slice(0,8)`；读取器里对此有注释，它前后都在，不计入 4→0。

诚实标注：该读数依赖本机语料、会随新会话变化，是回归哨兵而非判据（写本任务时语料 1254 条，现为 1282 条，类计数随之变动，但语义分歧仍是同一批 4 条会话）。且本机有标题的 transcript 里没有一条同时含 `custom-title` 与 `ai-title`，「改名声在标题之后」只能由 AC 夹具覆盖，语料仪器补不上。

AC #2 读取量读数（`rchar` 增量，两个夹具都在 4MB 硬上界内、都不整读 ~24MB）：

```
[reading] fixture A, title entries at the tail of ~24MB: bytes_read=721275
[reading] fixture B, the only instance of the title at the head of ~24MB: bytes_read=1245622
```

AC #5 正控：把生产读取器改回「首个 `ai-title` 即停」（探针，事后已还原，文件 sha256 与探针前一致）后同一命令非 0：

```
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-session-title-corpus.test.ts
✖ every corpus transcript is named what the CLI ladder would name it
    actual: [ { corpusClass: 'revised-ai-title', reader: 'Draft Title 0', ladder: 'The Final Title' },
              { corpusClass: 'custom-title-after-ai-title', reader: 'Generated Title', ladder: 'Renamed By Hand' } ]
    expected: []
✖ the corpus tells the reader apart from a reader that stops at the first ai-title
---EXIT:1---
```

红的两条正是前两类夹具（`revised-ai-title` / `custom-title-after-ai-title`），第三类 `agent-name-only` 与第四类 `single-ai-title` 保持绿。

门读数（本分支 merge develop 之后）：

```
$ bash scripts/test.sh --for-task gap-claude-title-ladder-mirror --allow-thin
# tests 7   # pass 7   # fail 0
$ npm run typecheck   # exit 0
$ npm run lint        # exit 0（仅既有 warning）
$ npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/*.test.ts
ℹ tests 286  ℹ pass 285  ℹ fail 0
```

## Touches

- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/modules/providers/services/session-ai-title.service.ts
- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/sessions.db.ts
- server/modules/database/index.ts
- server/modules/providers/tests/claude-session-title-mirror.test.ts (new)
- server/modules/providers/tests/claude-session-title-corpus.test.ts (new)
- server/modules/providers/tests/claude-session-title-source.test.ts
- server/modules/providers/tests/claude-sessions.test.ts
- server/modules/providers/tests/session-ai-title.test.ts
- server/modules/database/tests/sessions-name-source.integration.test.ts
- server/modules/websocket/tests/session-upsert-broadcast.test.ts
- tasks/gap-claude-title-ladder-mirror.md
