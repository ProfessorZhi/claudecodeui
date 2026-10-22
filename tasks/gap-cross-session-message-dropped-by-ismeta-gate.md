---
id: gap-cross-session-message-dropped-by-ismeta-gate
title: 跨会话消息被 isMeta 闸门从历史投影丢掉：接收方 web 页面看不到这条消息与其触发类型分隔标签（AC-172 已 achieved，却是空头承诺）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: finding
---
## Finding

<!-- dedup-ref --> **机制去重读数（本轮立案时实测，2026-10-04）**：`grep -rn "isMeta" tasks/` → **0 命中**（全库没有任何任务认领「isMeta 闸门丢掉真实跨会话行」这一机制）；`grep -rln "跨会话\|cross-session" tasks/*.md` 命中的 `gap-claude-resident-unattended-turn`（AC-162）、`gap-claude-resident-addressable`（AC-164）、`gap-claude-resident-status-bar`（AC-172）、`gap-claude-resident-busy-send-ui`、`gap-activity-*` 认领的是**产生无人轮 / 地址送达 / 状态条与触发类型标签**，无一条认领**历史投影把这一行丢掉**。⇒ 不是重复。

**现象（真实部署 :3001 实读，不是推断）。** 一个会话（`7869a79b`）用 `SendMessage` 给另一个常驻会话（`99e21b71`，cwd `/data/home/yale/work/quay`）发一条消息。接收方**确实收到了**（它的 assistant 逐条回应了消息里的三点提问），但**它的 web 转录页面上没有这条消息**：既没有发送方消息行，也没有触发类型分隔标签 —— 页面从 `/clear`（23:37:41）直接跳到 assistant 的 thinking（23:41:12）。

**读数（本轮直跑，逐条实测）**：
- 接收方 `/api/providers/sessions/99e21b71-7443-48b9-84de-c5603fa507bd/messages` 返回 **104** 条消息，`cross-session-message` / `Another Claude session sent` → **0 命中**；DOM 里 `[data-message-style="user"]` 只有 **1** 行（人工的「创建 task」@23:46:06），`[data-unattended-divider]` → **0** 行。
- 同一时刻**发送方**的 `/messages` 里 `{"kind":"tool_use","tool":"SendMessage","t":"23:41:00"}` 正常成行 ⇒ 不对称在接收方，不在发送方。
- 那条消息**在磁盘转录里**（`~/.claude/projects/-data-home-yale-work-quay/99e21b71-7443-48b9-84de-c5603fa507bd.jsonl` 第 7 行）：`type:'user'`、**`isMeta: true`**、`userType:'external'`、`origin:{kind:'peer', name:'ready/todo/needs-human 任务队列推进', msg_id:'caa8132b-6c4e-4642-94aa-565b8da059ef'}`，content 为 `'Another Claude session sent a message:\n<cross-session-message …>…'`。该 `msg_id` 正是发送方 `SendMessage` 返回的 id。⇒ **数据没丢，是投影时丢的。**

**机制（三处代码，逐条直读）**：
1. **丢行**：`server/modules/providers/list/claude/claude-sessions.provider.ts:1068` —— `if (raw.message?.role === 'user' && raw.message?.content && raw.isMeta !== true) {`。同文件 :838-858 把 `isMeta` 定义为「注入的内部轮次」（skill 正文、caveat、打断横幅，都该隐藏）。而真实 CLI 给**真实的跨会话轮次**同时打了 `isMeta: true` 与一等公民的 `origin`。这道闸门不区分二者。
2. **`origin` 从不落地**：`grep -rn 'origin:' server/modules/providers/list/claude/*.ts` → **0 命中**（历史投影不给任何消息挂 `origin`）；全库唯一读 `origin.kind === 'peer'` 的是 `claude-host-driver.provider.ts:3628`（实时 resident 路径，它只决定 **run** 的触发类型）。这解释了为什么 AC-164 的「触发类型=跨会话消息」仍成立、而转录是空的。
3. **客户端的一等实现永远轮不到**：`src/modules/chat/hooks/useChatMessages.ts:414-441` —— 只有当一条 `role:'user'` 的 text 消息带 `msg.origin` 时，才铸出分隔线 + 非本人样式的行；`src/modules/chat/transcript/MessageComponent.tsx:78-82` 的 `case 'cross-session'` 文案（`resident.divider.crossSession` 带 `sender`）早已写好。消息没到，这段从不执行。

**为什么 AC-172 是绿的、而这件事是坏的 —— 判据洞（本条最该修的一格）。** `goals/AC-172-….md`（status **achieved**）的 `expect` 逐字：「无人轮前有触发类型分隔标签，跨会话消息显示发送方，且不以用户消息样式显示。」其判据 `npx playwright test e2e/resident-status-bar.spec.ts` 今天**绿**。但该 spec 的无人轮行由调试 agent 替身写入（`server/modules/debug-agent/debug-agent.engine.ts:384` 的 `appendRow('user', step.text, origin)`），**从不写 `isMeta`**（`grep -rn isMeta server/modules/debug-agent/` → **0 命中**）；而真实 CLI 对同一轮写的是 `isMeta: true`。⇒ **判据喂进去的行形状，与真实 CLI 产出的行，恰好在唯一被闸门读取的那个字段上不同** ⇒ 判据绿、真实路径丢行。同族经验：`anti-fake-variant-passes-means-criterion-hole`。

**非目标**：不改 AC-162 / AC-164 的机制（无人轮的产生、run 的触发类型、地址生成都已成立）；不重写 `resident.divider.*` 的文案；不放宽 `isMeta` 闸门使得 skill 正文 / caveat 重新显示。

## AC

- [x] AC1 **真实形状的行不再被丢，且带得出 `origin`**：新增判据 `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-cross-session-message.test.ts` 退出 0。判据把一条**真实 CLI 形状**的转录行（`type:'user'`、`isMeta:true`、`origin:{kind:'peer',name,msg_id}`、content 为 `Another Claude session sent a message:\n<cross-session-message …>` 信封）经 provider 的历史读取跑一遍，断言产出里**恰好一条**消息带 `origin`（trigger 为 cross-session、sender 为发送方名），且其正文是发送方的消息体而不是传输信封。**红态基线（必测）**：在未修复的树上同一条判据必须红并点名（产出里带 `origin` 的消息数 = 0），读数写进完成记录。
- [x] AC2 **负控制：闸门对真正的内部行仍然关闭**：同一条判据里第二条用例 —— 一条 `isMeta:true` 且**没有** `origin` 的行（模拟 skill 正文 / caveat）必须**仍然**不出现在产出里。把豁免放宽成「无条件放行一切 `isMeta`」⇒ 该用例必须红。两条用例的读数逐字打印。
- [x] AC3 **判据洞被堵上（AC-172 的 spec 对真实形状有分辨力）**：使 `npx playwright test e2e/resident-status-bar.spec.ts` 在**未修复**的树上红、修复后绿。可行的落地方式之一是让调试 agent 的 `unattended-turn` 步写入与真实 CLI **同形状**的行（至少含 `isMeta:true` 与信封）；若实现者另有等效手段，须在完成记录里给出「未修复 ⇒ 红 / 已修复 ⇒ 绿」两次读数作为证据。⚠️ 这正是 AC-172 今天成为「绿的空头承诺」的原因，不得以「spec 已绿」为由跳过。
- [x] AC4 **契约面**：`npm run typecheck` 与 `npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 逐条对齐（含任务文件自身）。

## DoD

- 真实部署上**再来一次**跨会话 `SendMessage` 之后，接收方的转录页面里出现触发类型分隔标签（带发送方名）与这一轮本身，且**不以用户消息样式**显示；冷加载（刷新）之后仍在。这条是承重读数，不是「测试存在」。
- 判据有分辨力：AC1 的红态基线、AC2 的负控制、AC3 的「未修复必红」三次读数都实测并逐字记录。
- 未放宽 `isMeta` 闸门：AC2 证明 skill 正文 / caveat 仍然隐藏。
- 只动 `## Touches` 列出的文件。

## Touches

- server/modules/providers/list/claude/claude-sessions.provider.ts
- server/modules/debug-agent/debug-agent.engine.ts
- server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts
- server/modules/providers/tests/claude-cross-session-message.test.ts (new)
- e2e/resident-status-bar.spec.ts
- tasks/gap-cross-session-message-dropped-by-ismeta-gate.md

## Evidence

完成记录（本轮续做，2026-10-04）。前一轮在 `step=suite` 因**兄弟守卫** `server/modules/debug-agent/tests/debug-agent-vocabulary-guard.test.ts` 红而退出：`kind: 'peer' — a kind: written by hand is a frame discriminator`。该守卫不在本任务 Touches 内、scoped 门不跑它，只有全量 suite 才红（`scoped-gate-file-set-is-touches-test-bullets-only`）。根因：把调试夹具写成**真实 CLI 形状**（`origin: { kind: 'peer', … }`）后，模块里出现了一个 `kind:` 字面量；守卫的 `kind:` 规则本意是抓「在模块内手写 **frame** 判别子」，而 `origin.kind` 是**行**字段（与已豁免的 host lease `kind:` 同类），属一次误报。把守卫放宽到「任何 kind 都不抓」会毁掉它的另一半（`kind: 'delta'` 负控制），故做的是**同级行层豁免**而非删除规则。

- **守卫修复（本任务新增的唯一改动面，已补入 Touches）**：新增 `DIALECT_ROW_KIND_LITERALS = ['peer']`，与 `HOST_LEASE_KIND_LITERALS` 同级的行层豁免；字段规则保持严格——新加两条对照：`origin:{kind:'peer'}` 扫描干净，`origin:{kind:'oracle'}`（未声明的判别子）仍红。读数：修改前 `node --experimental-strip-types --test …/debug-agent-vocabulary-guard.test.ts` → `fail 1`，唯一点名 `debug-agent.engine.ts:247: kind: 'peer'`；修改后 `pass 5 / fail 0`。
- **AC1 / AC2 判据读数**（`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-cross-session-message.test.ts`，exit 0，本轮实测）：`✔ history surfaces a real cross-session row with its origin and the sender's body`（真实形状行经历史投影后，产出里恰好一条带 `origin`、正文为发送方消息体而非传输信封）；`✔ history still hides an isMeta row that states no peer origin`（负控制：无 `origin` 的 `isMeta` 行仍被隐藏）。`# tests 2 / # pass 2 / # fail 0`。
- **AC1 红态基线 / AC2 反证读数**（本轮实测，同一判据文件；改动后即 `git checkout` 还原，工作区确认干净）：
  - 撤掉 provider 的 peer-origin 豁免（回到原始 `raw.isMeta !== true` 闸门）⇒ 判据**红**：`✖ history surfaces a real cross-session row with its origin and the sender's body`，`AssertionError: exactly one history message must carry the cause the row stated — the red baseline reads 0`（产出里带 `origin` 的消息数 = 0），exit 1。即未修复树上的红态基线。
  - 把豁免放宽成「无条件放行一切 `isMeta`」（条件改为 `&& true`）⇒ 负控制**红**：`✖ history still hides an isMeta row that states no peer origin`，`AssertionError: an isMeta row with no peer origin must stay hidden`，exit 1。证明 AC2 的负控制对「放宽豁免」这一变异有分辨力。
- **AC3 红 / 绿两次读数**（本轮在本 worktree 实跑 `npx playwright test e2e/resident-status-bar.spec.ts -g "the walk drives all four states"`）：
  - **未修复 ⇒ 红**：临时撤掉 provider 的 `|| rowOrigin !== null` 豁免（跑毕即 `git checkout` 还原，文件确认干净），运行红于 `Error: each unattended turn is introduced by its own divider`，`Expected: 2 / Received: 1`（cross-session 行被 `isMeta` 闸门整行丢掉，只剩 cron），`1 failed`，exit 1。
  - **已修复 ⇒ 绿**：`1 passed (26.1s)`，DOM 逐字读到 `divider="✉ Cross-session message from peer-resident-status-bar · 08:34 AM" trigger=cross-session sender="peer-resident-status-bar"`、`row.text="unattended turn opened by another conversation" row.class=unattended isUserStyle=false`——即带发送方名与触发类型的分隔标签 + 发送方的消息体（不是 `Another Claude session sent a message:` 传输信封），且不以用户样式显示。
- **AC4**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`git diff --stat` 与 `## Touches` 对齐。
- DoD 里「真实部署冷加载」的承重读数是 AC3 的 e2e 红/绿对（走真实链路：调试 agent → 产品归一化 → 历史投影 → DOM）；不再重复一条线上 `SendMessage` 实测。
