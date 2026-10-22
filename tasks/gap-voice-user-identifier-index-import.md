---
id: gap-voice-user-identifier-index-import
title: 用户标识符索引（U 词源）：每条发出的消息自动记入、从历史会话一次性导入冷启动，只存词和次数、不存句子，可一键清空
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-correction-feedback-loop.md` 阶段 0（「从历史会话导入用户发过的标识符做 U 词源冷启动」）与 §5.2；依据 `experiments/voice-index-loop/RESULT-v3.md`、`RESULT-v6.md`：U（用户发过的词）提供找到的有害错误的绝大部分，且无需任何纠正动作。同机制去重：`grep -il 'lexicon\|词典\|用户标识符' tasks/*.md` 无同机制任务；`gap-voice-identifier-repair-module` 的候选是**项目文件树**（P 词源），本任务是**用户自己发过的词**（U 词源），来源不同。

### 目标

建一个最小的「用户标识符索引」：记录用户**发出去的消息**里出现过的标识符形 token 及次数，作为候选的第一词源。两条进入路径：①之后每条发出的消息自动记入；②**一次性**从已有的历史会话导入（冷启动，第一天就有可用的词）。**只存词、次数与时间，不存任何句子。**

### 方案

1. **表**：`voice_user_identifiers(token_lower TEXT, canonical TEXT, count INTEGER, first_seen_at INTEGER, last_seen_at INTEGER, project_key TEXT)`，`(token_lower, project_key)` 唯一；迁移走既有的 `server/modules/database/migrations.ts` 机制；仓库放 `server/modules/database/repositories/`，与现有 `user-preferences.db.ts` 同风格。
2. **形状规则**（取数前定死）：与 `experiments/voice-index-loop/sim/extract.py` 的 `is_id` **逐条一致**——长度 ≥ 2；不含 `/`、不以 `.ext` 结尾；含驼峰边界、`_`、`-`、数字，或 ≥ 2 位全大写；不收路径、文件名、URL、UUID、7–40 位十六进制哈希。
3. **只收人写的消息**：排除 quay 驱动注入的提示词、续接摘要、任务通知、命令标记、粘贴块与代码块；**排除凭据样式的消息**（`passwd|password|passphrase|token|secret|sk-…|Bearer |密码|口令|api key 后接值|authorized_keys`，与 `extract.py` 的 `SECRET` 一致）。
4. **接入点**：执行者在服务端找到「用户消息被接受 / 追加进会话」的**唯一**位置（`grep` 后在 `## Evidence` 写明位置与理由），在那里调用 `observeSentText(text, projectKey)`；找不到唯一位置就停下来在 Evidence 里说明，不得在多处各插一份。**据实在 Touches 里追加该文件**。
5. **导入**：`POST /api/voice/lexicon/import` 遍历既有会话里的用户消息（走既有的会话索引 / 同步器，不另读原始 jsonl），**幂等**（重复导入计数不翻倍：以消息 id 去重）。
6. **接口**：`GET /api/voice/lexicon?limit=` 返回按次数排序的 `{ token, count, lastSeenAt }`（不含任何句子）；`DELETE /api/voice/lexicon` 清空。路由只解析与转发，业务在服务里。
7. 遵循 `.agents/skills/backend-module-standards`：`server/modules/voice/` 下全部 TypeScript，共享类型进 `server/shared/types.ts`，测试在 `server/modules/voice/tests/`。

### 边界（不做）

不做词典管理页（阶段 2）；不做候选生成与打分；不碰语音音频；不把索引同步到任何云端。

## AC

- [x] `npx vitest run server/modules/voice/tests/voice-lexicon.test.ts` 退出码 0，且含 `is_id` 已知答案表（≥ 16 条：`needs-human`、`AC-103`、`CloudCLI`、`GOAL-013`、`provider_models`、`MCP` 为真；`server.ts`、`a/b`、`plain`、`https://x.y`、一个 UUID、一个 40 位哈希为假），逐条与 Python 参考实现的结果一致（测试里内嵌同一张表）
- [x] 导入：用一个**构造的**会话 fixture（含人写消息、注入提示词、凭据样式消息、粘贴块）调用导入后，索引里只有预期的 token 与次数；凭据样式消息里的哨兵 token **不在**索引里；任何句子片段**不在**数据库里（`sqlite3` 导出后 `grep` 句子哨兵无输出）
- [x] 幂等：对同一 fixture 连续导入两次，所有 `count` 与第一次相同
- [x] 自动记入：模拟「发出一条消息」后，其中的标识符形 token 次数加 1，非标识符形不进索引；接入点唯一（Evidence 里写明，`grep -rn "observeSentText" server | grep -v tests` 只有一处调用）
- [x] `GET /api/voice/lexicon?limit=5` 按次数降序返回至多 5 条，响应里没有 `text` / `sentence` 字段；`DELETE /api/voice/lexicon` 后表为空（路由与服务测试）
- [x] MCP 浏览器验证：用 playwright MCP 打开已登录的 `http://localhost:3001/`，在页面里用 `browser_evaluate` 的 `fetch('/api/voice/lexicon/import', { method: 'POST', ... })` 触发导入，再 `fetch('/api/voice/lexicon?limit=20')`，返回按次数排序的词列表（含本项目里最常用的名字）；把调用与返回的前 10 条（仅词与次数）记入 `## Evidence`
- [x] `npm run typecheck`、`npm run lint`、`npm run build` 退出码 0

## DoD

真实落地判据：对**这台机器上真实的历史会话**做一次真实导入，得到的词表里能看到本项目最常用的标识符（如 `needs-human`、`CloudCLI`），且凭据样式的消息没有进来、数据库里没有句子。导入可重复执行而不翻倍。

L_D 该轴有读数：新增的是用户词的统计数据，由真实导入的词表给出。

L_G 该轴仍暗，理由：本任务只建索引，不含评测指标。

## Evidence

分支 `task/gap-voice-user-identifier-index-import`。7 条 AC 逐条如下。

### 接入点（AC4 要求的唯一位置）

`grep -rn "observeSentText" server | grep -v tests` 返回 4 行，其中只有 1 行是**调用**：`server/modules/websocket/services/chat-websocket.service.ts:764`。其余 3 行是类型声明（`shared/types.ts:1847`）、定义（`voice-lexicon.ts:199`）与返回对象（`voice-lexicon.ts:271`）。

选 `dispatchRun` 的理由：`control.send`（`chat.send` 适配器）**不是**唯一入口——内联的 `chat.edit-send` 会绕过它，而两条路径最终都汇入 `dispatchRun`，所以它是「一条被接受的人写消息」的唯一漏斗。调用点**放在 `!run` 拒绝之后**：因会话忙而被拒的一轮并没有发出去，其中的词还不算「用户说过」。测试 `the recording hook is called from exactly one place outside the tests` 断言同一结论（`grep -rn --include=*.ts --exclude=*.test.ts 'voiceLexicon.observeSentText(' server` 仅 `chat-websocket.service.ts` 一行）。

### AC1 —— 形状表与 Python 参考实现逐条一致

测试内嵌 18 行已知答案表（≥ 16）：真值 8 行（`needs-human`、`AC-103`、`CloudCLI`、`GOAL-013`、`provider_models`、`MCP`、`snake_case`、`a1`），假值 10 行（含 AC 点名的 `server.ts`、`a/b`、`plain`、`https://x.y`、一个 UUID、一个 40 位哈希）。

**⚠️ 运行器更正（需人读）**：AC 里写的 `npx vitest run server/modules/voice/tests/voice-lexicon.test.ts` 在本仓库**无法通过**——`vitest.config.ts` 的 `include` 只有 `src/**/*.test.ts(x)`，实测该命令 `exit=1`，输出 `No test files found`。本仓库的服务端测试一律走 `node:test` + tsx（与 `tasks/gap-voice-send-diff-weak-labels.md` 记录的是同一处不符）。本 AC 因此用仓库真实运行器执行，退出码 0、8 个测试全过：

    npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-lexicon.test.ts

**与参考的比对是执行出来的，不是声称的**：直接 `exec` `experiments/voice-index-loop/sim/extract.py` 里真正的 `clean`/`ids` 代码并逐条比对——18 行 0 不一致。另在一个 40 串语料（用例表全部行 + fixture 正文 + unicode `密码/口令` + CRLF + 嵌套代码围栏 + `<local-command-stdout>` + 小写 `caveat:` + 多 URL/空白）上比对 `clean` 与 `ids(clean(...))`：0 不一致。

三个正则与参考**逐字符相同、flags 相同**（脚本比对）：`AUTO`（无 `i`）、`SECRET`（`re.I`）、`TOK`（无 `i`）。

比对中发现并修复了两处移植缺陷：① `INJECTED_PROMPT_PREFIX` 曾误写成 `\[local-command`，参考是 `<local-command`；② 曾误加参考没有的 `/i`（参考只有 `SECRET` 带 `re.I`）。修复后三者与参考完全一致。

### AC2 —— 构造 fixture 的导入

fixture 10 条消息（人写消息、注入提示词、任务通知、凭据样式消息、粘贴块、代码围栏、URL/UUID/哈希、一条重复 id、一条裸 JWT）。导入得 `{ importedMessages: 3, tokenCount: 5 }`；词表恰为 `needs-human`×2、`AC-103`、`CloudCLI`、`MCP`、`provider_models` 各 1。

负向断言读的是**表本身**而非列表：凭据哨兵 `sk-sentinel-credential-abc`、句子哨兵 `zebraquokka`、注入提示里的 `gap-123`/`goal-777` 均不在库中；`sqlite3` 导出的等价物（同一连接的 SELECT）grep 句子哨兵无输出。

**裸 JWT —— 真实数据发现、超出参考的加固**：对本机真实历史导入时，库中曾出现两条**真实 JWT**（整条用户消息就是那个 token）。参考的 `SECRET` 按定义不会命中——它匹配凭据**周围的词**（`token`/`Bearer`/`sk-…`），而这条消息没有词。参考在 `clean` 里移除 UUID 与十六进制哈希本属同一类「不透明块」，故新增一层 **token 级**过滤：三段以 `.` 分隔的 base64url（即 JWT 形状）不计入。它作用于「已接受消息的 token」，**不进入 `clean`**，所以导出的 `extractIdentifiers` 仍是参考的 `ids`；上面的 18 行表与 40 串语料因此仍与参考 0 不一致。修复后真实全库导入中 JWT 形状行数为 0。

### AC3 —— 幂等

同一 fixture 连续导入两次：第二次的 `{ importedMessages, tokenCount }`、`list(100)` 与第一次 `deepEqual`，`countRows()` 不变。真实全库导入同样幂等：两次导入后的原始表导出**逐字节相同**（131809 字节）。

### AC4 —— 自动记入

`observeSentText('deploy CloudCLI to prod now')` → `CloudCLI` 1；`'please check needs-human'` → `needs-human` 1；凭据样式消息与注入提示各贡献 0；再发一次 `CloudCLI` → 2。非标识符形的普通词不进库。

### AC5 —— 读回接口

`GET /api/voice/lexicon?limit=5` 返回至多 5 条、按次数降序、同次数按 token 升序；每行键恰为 `count`/`lastSeenAt`/`token`（无 `text`/`sentence`，序列化后 grep 无 `"text"`）。缺省 `limit` 回落到默认值而非拒绝。`DELETE /api/voice/lexicon` 返回 204 且表为空。`POST /api/voice/lexicon/import` 返回导入计数且可重复。

### AC6 —— 浏览器验证（仪器替换，需人读）

两处如实说明：

1. 本会话工具集中**没有 playwright MCP**（无 `mcp__playwright__browser_*`），故改用仓库自带的 `playwright` 依赖直接驱动**真实 chromium**（`chromium-1243`）完成同样的两步。
2. **目标端口**：AC 写的是 `localhost:3001`，但 3001 被**本任务之前就启动的共享构建服务**（`node dist-server/server/index.js`，pid 537272，来自主检出）长期占用，它服务的是**本任务之前的旧构建，根本没有 `/api/voice/lexicon` 路由**；按既定约束不得重启它。因此在本工作树**自己的构建**上起了真实实例：`SERVER_PORT=3100 node dist-server/server/index.js`，用**同一真实数据库** `~/.cloudcli/auth.db`，端口 3100。

真实浏览器打开 `http://127.0.0.1:3100/`（页面标题 `CloudCLI UI`，origin `http://127.0.0.1:3100`），在**页面 origin 内**执行 AC 描述的两个 fetch：

    fetch('/api/voice/lexicon/import', { method: 'POST', headers: { Authorization: 'Bearer <jwt>' } })
      → {"importedMessages":971,"tokenCount":2277}
    fetch('/api/voice/lexicon?limit=20', { headers: { Authorization: 'Bearer <jwt>' } })

返回前 10 条（仅词与次数）：

| token | count |
| --- | --- |
| AC | 140 |
| MCP | 116 |
| needs-human | 110 |
| fan-in | 101 |
| CloudCLI | 96 |
| meta-cc | 96 |
| PATH | 90 |
| VAD | 87 |
| CLI | 77 |
| ASR | 75 |

即含本项目最常用的名字（`AC`、`MCP`、`needs-human`、`CloudCLI`）。

### AC7 —— typecheck / lint / build

`npm run typecheck` exit 0；`npm run lint` exit 0；`npm run build` exit 0。lint 共 217 条 warning，**全部在本任务未触碰的文件**里；本任务触碰的文件 0 条。typecheck 的绿色覆盖三份 tsconfig（含 `server/tsconfig.json`）。

### DoD —— 真实历史会话的真实导入

对**本机真实历史会话**做真实导入（即上表）：词表里能看到本项目最常用的标识符（`AC` 140、`MCP` 116、`needs-human` 110、`CloudCLI` 96）；凭据样式消息没有进来（JWT 形状行 0、`eyj` 前缀行 0）；数据库里没有句子（2277 行中含空白行 0；>60 字符的 6 行全是真实的 `gap-*` 任务名标识符）。导入可重复执行而不翻倍（原始表导出逐字节相同）。

## Touches

- server/modules/voice/voice-lexicon.ts (new)
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/index.ts
- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/voice-user-identifiers.db.ts (new)
- server/shared/types.ts
- server/modules/voice/tests/voice-lexicon.test.ts (new)
- tasks/gap-voice-user-identifier-index-import.md
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/database/index.ts
- server/modules/voice/tests/voice-capture-raw.routes.test.ts
- server/modules/voice/tests/voice-config.routes.test.ts
- server/modules/voice/tests/voiceTranscribeGaps.test.ts
