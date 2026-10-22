---
id: gap-debug-agent-typed-turn-writes-no-user-row
title: 调试 agent：用户打字发出的回合不落 user 行，实时所见与 REST 重取分叉（AC-124 判据面漏掉该路径）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**缺陷（实测）。** 经调试 agent 的会话，用户在输入框里打字发出的回合，**永远不会写进 transcript**。transcript 里只有种子那一行 user，以及每条打字回合对应的 assistant 行。

实测读数（隔离实例，场景 `steps` 只有 `{at:0,op:'row'}` + `turn-end` + `wait`）：
- 打字 3 轮后，transcript 共 5 行：`custom-title` + 种子 `user` + **3 条 `assistant`**，**0 条**对应打字的 `user` 行。三条 assistant 的时间戳分别为 03:09:22 / 03:10:03 / 03:10:25，与三次点发送的时刻逐一对上。
- 同一时刻 `GET /api/providers/sessions/:id/messages` 返回 4 行：种子 user + 3 条 assistant。同样**没有**打字的 user 行。
- 浏览器里实时是 5 行（含我打的 3 句）；**刷新页面后只剩 2 行** —— 我打的三句话全部消失。

**机制（代码归属）。** 写 `user` 行的地方只有两处，都不是打字路径：
1. 种子行 —— `server/modules/debug-agent/debug-agent.runtime.ts:368`（`armDebugAgentScenario` 里 `role: 'user'`，文本取自 `scenario.seed.userText`）。
2. `unattended-turn` 这个场景 op —— `server/modules/debug-agent/debug-agent.host-driver.ts`（约 256 行起的宿主回合入口），文本取自场景文档的 `text` 字段。

客户端打字发出的回合没有任何 writer：它走的是 provider runtime → 宿主 → run registry，随后按场景时钟走 `row` 步产出 assistant 行，而**输入框里那段文字自始至终没有被写下来**。

**为什么既有判据没抓住。** `goals/AC-124-*.md`（已 achieved）声称「实时所见与 REST 重取逐 id 一致」，正是这一类的守卫；但它的判据命令只驱动 `server/modules/debug-agent/tests/debug-agent-frames.test.ts`，而那里面走的是 `POST /api/debug-agent/clock`（场景时钟）路径。**打字路径不在它的判据面内**，所以它一直绿。

**这为什么是缺陷而不是「设计如此」。** `debug-agent.runtime.ts:54` 的注释写着「Omitted (not `undefined`-valued) for a typed turn, so a row written by a person and a row written by the host layer differ on disk rather than only in the reader's interpretation」—— 即设计上预期**人打的行在磁盘上是存在的**，且与宿主开的回合行靠 `origin` 字段区分。今天这个预期没有实现。

**影响。** 任何用调试 agent 当 provider 替身的 e2e，只要涉及「发一条消息然后回读历史」，都会拿到一个缺了用户输入的历史；刷新即丢。

**修复（实现归属）。** 打字路径与时钟路径在 runtime 入口上形状完全相同（同一入口、同一批 option 键、同一个 session），只有发送方知道自己是哪一种，所以由发送方声明：`server/shared/types.ts` 新增 `CHAT_TURN_OPTION = 'chatTurn'`，`chat-websocket.service.ts` 的 `dispatchRun` 在它构造的 options bag 上打这个标（`chat.send`、`chat.edit-send` 与定时消息的 detached turn 都走这里）。调试 agent 的 runtime 读到该标时，先把 prompt 写成一条**无 `origin`** 的 `user` 行（`appendTypedTurnRow`，写在 walk 之前，因此落在 engine 读到的 `before` 形状里，不改变 `expect.rows.delta`），再转发它归一化出的帧。无标即「不是聊天回合」，内部驱动（控制面的 `/clock` 走 `driveScenario`）照旧不写任何行——这正是 AC-124 的 `/clock` 面依赖的方向。

## AC

- [x] 新增判据文件 `server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts`，且**对当前实现必红**：装载一个场景、经打字路径（而非 `/clock`）发出一个含可识别文本的回合，断言 transcript 中新增一条 `role: 'user'` 且文本等于该输入的行。命令：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts`；命令必须逐字含该文件路径，**不得用 glob**（glob 无命中时 `node --test` 退出 0，会在文件不存在时假绿）。失败时输出实际 transcript 的行类型序列。
- [x] 同一判据断言 REST 一面：`GET /api/providers/sessions/:id/messages` 返回的行 id 集合，必须覆盖该打字回合的 user 行。打印两个集合的差。
- [x] 取假变体必须红：**frames-only**（只发帧、不写 transcript）必须让上两条同时失败。在完成记录里登记实际跑出的红。
- [x] 不回归：`npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-frames.test.ts` 仍绿（AC-124 的 `/clock` 路径不许被这次改动弄红）。
- [x] 修复后，一个真实打字回合在**刷新页面后仍然可见**：以实机读数（浏览器刷新前后行数与文本）登记在完成记录里。

## DoD

真实落地：一次**经真实链路**的打字回合，其用户文本既在 fixture 根下的 JSONL 里、也在 REST 重取里，且刷新浏览器后仍在页面上。承重性由三件事正面证明：
(a) 判据文件在没有修复时是红的（先红后绿，红要先于修复被观察到）；
(b) frames-only 取假变体确实让判据红；
(c) AC-124 既有的 `/clock` 判据仍绿 —— 即这次改动没有用「把时钟路径也弄坏」的方式换取绿。

## Touches

- server/shared/types.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/debug-agent/debug-agent.provider.ts
- server/modules/debug-agent/debug-agent.runtime.ts
- server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts (new)
- tasks/gap-debug-agent-typed-turn-writes-no-user-row.md

## 完成记录

**判据怎么驱动打字路径。** 判据的第一条 arm 不在 runtime 入口手搭 options bag，而是开一个假 socket 走 `handleChatConnection` 发真 `chat.send`——options bag、run registry 与 dispatch 全是产品的，判据不复述。这样 `CHAT_TURN_OPTION` 这一环也被判据覆盖：传输少打了标，判据就红，而手搭 bag 的写法会在传输漏打标时仍然绿。

**AC1 先红（未修复的构建上实测）。** 把实现 stash 掉、只留判据文件跑，判据文件仍能加载并按断言红：

```
✖ a typed turn writes its prompt into the transcript, and the REST read returns it
  AssertionError: 用户打字不落行: the transcript holds 0 row(s) whose text is the sent prompt;
  the arm's row-type sequence was ["custom-title","user","assistant","assistant"];
  rows were "custom-title:\nuser:please summarise the release notes\nassistant:...\nassistant:..."
  0 !== 1
ℹ pass 1  fail 2
```

**AC3 假变体实测红（帧发出去了、磁盘上没有）。** 变体由「把出货的 `debug-agent.provider.ts` 拷一份、只改一处 runtime import 指向一个 wrapper」得到；wrapper `export *` 真 runtime，只把 `appendTypedTurnRow` 换成「只 build 不 append」。把上两条的出货断言直接施加到这个变体上跑：

```
AC1 施加于变体:  [RED-REGISTRATION] AC1 applied to the mutant: the transcript holds 0 row(s)
                whose text is the sent prompt; row-type sequence was ["custom-title","user","assistant"]
                0 !== 1
AC2 施加于变体:  [RED-REGISTRATION] AC2 applied to the mutant: the prompt's frames are not in the REST read
                ["dd30baa8-1ad7-44c7-a080-e84e2544e314_text_0"]
                + [ 'dd30baa8-...' ]  - []
```

即：帧带着 prompt 的 message id 出去了（客户端会画出来），REST 重取里没有对应物——正是本缺陷的分叉，在一个 run 上量到。判据文件常态下用「缺席」形式断言这两件事，并在同一条用例里用「prompt 必须仍在线上」当正控制，防止变体退化成「什么都没干」。

**AC4 不回归实测。** `npx tsx --tsconfig server/tsconfig.json --test server/modules/debug-agent/tests/debug-agent-frames.test.ts` → `pass 2 / fail 0`。同一改动下 `server/modules/debug-agent/tests/*.test.ts` 全目录 `34 pass / 0 fail`，`server/modules/websocket/tests/*.test.ts` `50 pass / 0 fail`，`npm run typecheck` 与 `npm run lint` 均 exit 0。

**AC5 实机浏览器读数（真服务 + 真 Chromium，一次性 spec，读数后已删除）。** 场景：种子一行 user + 一条 assistant `row`；在输入框打字并回车；读渲染行 → 刷新 → 再读渲染行。

未修复的构建：

```
rendered BEFORE typing (1): ["seeded user turn ..."]
rendered LIVE after send (3): ["seeded user turn ...", "TYPED-BROWSER-MARKER: does this survive a reload", "Claude the assistant answered the browser turn"]
file LIVE (3): ["custom-title:", "user:seeded user turn ...", "assistant:the assistant answered the browser turn"]
rendered AFTER RELOAD (2): ["seeded user turn ...", "Claude the assistant answered the browser turn"]
typed-text present  before=false  live=true  afterReload=false
```

修复后（同一 spec、同一场景）：

```
rendered LIVE after send (3): ["seeded user turn ...", "TYPED-BROWSER-MARKER: does this survive a reload", "Claude the assistant answered the browser turn"]
file LIVE (4): ["custom-title:", "user:seeded user turn ...", "user:TYPED-BROWSER-MARKER: does this survive a reload", "assistant:the assistant answered the browser turn"]
rendered AFTER RELOAD (3): ["seeded user turn ...", "TYPED-BROWSER-MARKER: does this survive a reload", "Claude the assistant answered the browser turn"]
typed-text present  before=false  live=true  afterReload=true
```

即任务里报告的现象（实时含打字句、刷新即丢）复现，修复后刷新留存。注意实时行数修复前后都是 3：转发这条 user 帧没有让客户端画第二遍（前端按 id 归并），所以「补上帧」不引入重复气泡。

**AC2 的一个如实说明：** REST 那条腿在判据里驱动的是 `sessionsService.fetchHistory`——即路由处理器调用的那一个方法——而不是真的发 HTTP。这是 AC-124 已 achieved 的判据文件在同一处境下采用、并在文件里写明理由的先例（该模块够不到 providers 的路由，跨过去就违反后端模块边界）。真正的 HTTP 面由 AC5 的浏览器读数覆盖：刷新时前端正是经 `GET /api/providers/sessions/:id/messages` 重取历史的。
