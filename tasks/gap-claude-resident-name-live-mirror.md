---
id: gap-claude-resident-name-live-mirror
title: resident 会话的 peer 注册名按已定稿的 ai-title 做活体镜像：经 rename_session
  控制帧改注册名，不重启、不臆造、只镜像一次
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

CloudCLI 起的 resident（`entrypoint=sdk-ts`）会话，peer 注册名长期停在 `nameSource=derived`：
`quay-bb`、`quay-ec`、`archguard-85`、`tailscale-64`。`ListAgents`/`SendMessage` 看到的地址因此不可读，
而它们的转录里**明明有一个很好的 `ai-title`**。本任务让注册名按那个标题做**活体镜像**。

### 已实测的根因（两臂对照）

同一提示词，唯一差别是首轮之前有没有先改名：

| 臂 | 首轮后注册名 | 转录里的标题 |
|---|---|---|
| B 对照（不改名） | `armb-8a` / **derived** | `ai-title="数据库事务隔离级别"` ×2 |
| A 预改名 | `ZZZ Pre Pin` / user | `custom-title` ×3，**零 `ai-title`** |

B 臂说明：普通 `sdk-ts` 会话**生成了 ai-title 却从不把它写进注册名**，永远停在 `derived`；只有
`kind=bg` 才会落 `auto`（`system specs query`、`list visible claude code sessions` 都是 bg+auto）。
**这不是 CloudCLI 的 bug，是 CLI 自己没走完的一步。**

A 臂说明本任务的硬不变量，见下。

### 已实测的通道

`rename_session` 控制帧写进**活进程的 stdin** 即可改注册名，当场生效，无需重启、无需模型轮次：

```
{"type":"control_request","request_id":"<in-flight 唯一>",
 "request":{"subtype":"rename_session","title":"<t>","source":"host","session_id":"<sid>"}}
```

实测 `derived` → `user`，`nameSince` 前移，回帧 `control_response: success`，进程退出后
`~/.claude/sessions/<pid>.json` 随之消失。CLI 侧对此请求的约束：`title` 必须非空字符串；`source`
只接受 `host`/`remote`（分别落库 `user`/`remote`，`auto` 是 CLI 内部车道，控制面拿不到）；
`session_id` 必须等于该进程自己的会话 id 或省略。

CloudCLI **已有这条管道**，不是要新开：`ClaudeResidentProcess.writeRaw`（契约
`claude-host-driver.provider.ts:294`，实现 `:1553`，已有一个调用者在 `:2451` 发
`cancel_async_message`）。SDK 的 `Query` 不暴露此动词；包导出的
`renameSession(sessionId, title)` 是**写 JSONL 文件**的那个，不是这个。

### 时机：为什么是「同一个值连续读到两次」

实测本机全部转录：194 个会话带 `ai-title`，**值真正变过的只有 1 个**，且发生在**第 2 轮**；此后
70～148 轮一路同值（条目被反复追加——148 轮的会话写了 49 次——但值不变，约每 3 轮一次）。首次
出现最早第 1 轮、最晚第 3 轮。

所以「同一个 ai-title 连续读到两次」同时满足三件事：它是**最早**的可镜像时刻；它把「已定稿」从
猜测变成**测量**；它顺带覆盖网关标题生成不稳（某轮整轮不生成是常事）。

### 硬不变量

1. **只在 ai-title 已经存在于转录之后发帧。** A 臂证明：首轮之前先改名，CLI 干脆**不再生成
   ai-title**（转录里 custom-title ×3、零 ai-title）。提前发帧不是「抢先占位」，是**掐掉 Claude Code
   自己的标题**——正是本项目此前那条 `--name` 被撤掉的同一个理由，必须禁止。
2. **只镜像，不臆造。** 发出去的字符串必须**逐字**等于转录里的 ai-title。不得使用阶梯的任何回退档
   （`firstPrompt` / `summary` / `sessionId` 前缀 / 占位名）。
3. **只发一次。** 采纳成功后不再重发，即便 CLI 继续追加同值。

### 已知副作用（实测，接受并夹住）

会话**有转录**时，该控制请求除改注册名外还会往转录追加 `custom-title`（值 == 镜像值）——这是 CLI
侧 `r1()` 的行为，控制面无法只改注册名。因为值与 ai-title 逐字相同、且 ai-title 实测不再变，**可见
行为无差异**；而且正是这一条让注册名粘住。AC 把这个副作用**夹住**而非消除：追加的 `custom-title`
（若有）其值必须逐字等于镜像值，出现任何其它值即失败。

### 关系

<!-- dedup-ref --> 本节只是机制边界登记，**不是前置条件，没有任何依赖**：`gap-session-rename-writeback`（done）
是**反方向**——App 改名写回转录（用 SDK 的文件版 `renameSession`）；`gap-session-name-source-ai-title`（done）
改的是 **App 的 `sessions.db`**；`gap-claude-title-ladder-mirror`（done）是**读**侧的阶梯；
`gap-claude-peer-name-follows-ai-title`（done）只管**启动时**那一次交接。本任务动的是第四个地方：
**活进程的 peer 注册名 `~/.claude/sessions/<pid>.json`**，即 `ListAgents`/`SendMessage` 看到的地址。
四者互不覆盖，谁也不等谁。

### 实现约束

- 本任务改 `server/**`，必须加载并遵守 `$backend-module-standards`（`.agents/skills/backend-module-standards/SKILL.md`）。
- 实现若另起模块文件或改动本 `## Touches` 未列出的文件，**必须在同一提交里把该文件补进 `## Touches`**
  ——anti-drift 是 NON-WAIVABLE 硬门，漏一个文件整批失败。
- 新建测试文件放在 `server/modules/providers/tests/`，只 import 同模块/内置符号即可
  （`providers/tests/` → `providers/list/claude/` 属模块内深导入，既有判据同此，不触 boundaries lint）。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-name-live-mirror.test.ts` 退出 0
- [x] **正向**：真 claude 二进制 + 临时 `CLAUDE_CONFIG_DIR`，跑满一轮让转录落下 `ai-title`；**同一个值连续读到两次之后**，`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` 的 `name` 逐字等于该 ai-title，`nameSince` 前移，且 **pid 在整个过程中不变**（证明是活体，不是重启）。
- [x] **不臆造（负控制）**：转录里没有 `ai-title` 的会话，在同样的观察窗内注册名保持 `derived`，且**发出的 rename 帧计数 == 0**。
- [x] **不提前（守 A 臂）**：采纳成功时，该会话转录里**同时存在** `ai-title` 条目（证明帧是在标题已生成之后才发的）。**假形态**：把「连续两次」改成「首读即发」⇒ 本 AC 必须红。
- [x] **只发一次（幂等）**：采纳成功后转录继续追加同值 ai-title，rename 帧计数仍为 1。
- [x] **副作用夹住**：采纳动作追加的 `custom-title` 条目（若有）其值逐字等于镜像值；出现任何其它值即失败。
- [x] **既有判据不退**：`claude-resident-addressable.test.ts` 与 `claude-peer-name-follows-ai-title.test.ts` 同绿（scoped gate 退出 0）。
- [x] `git diff --stat develop...HEAD` 只出现在 `## Touches` 列出的文件里。

## DoD

- 在**真实 :3001** 上，取一个**当前存活**、`nameSource=derived` 且转录里已有 ai-title 的 resident 会话，
  经机制后 `~/.claude/sessions/<pid>.json` 的 `name` 变为该 ai-title、`nameSince` 前移，而
  **pid 与该进程的启动时刻均不变**（证明是活体镜像，不是重启），且 `ListAgents` 里该 peer 的名字可读。
- 同窗负控制：一个转录里没有 ai-title 的 resident 会话，跑同样长的时间窗后仍是 `derived`。
- 上述会话的转录里没有出现任何 CloudCLI 自造的标题字符串（即没有任何阶梯回退档被写进去）。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/services/session-ai-title.service.ts
- server/modules/providers/tests/claude-resident-name-live-mirror.test.ts (new)（判据：真 claude 二进制 + 临时 CLAUDE_CONFIG_DIR，读 sessions/<pid>.json 与转录）
- server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts （修改：改读启动时的注册快照；镜像上线后该会话首轮即被改名，末次快照不再停在 derived）
- server/modules/providers/tests/claude-resident-addressable.test.ts （AC7 的既有判据，本体未改动，纳入 scoped gate 覆盖）
- tasks/gap-claude-resident-name-live-mirror.md

## Evidence

- 通道实测（2026-10-01，本机真 claude 二进制）：`derived` → `user`，`nameSince` 1790845639483 → 1790845639739，
  回帧 `{"subtype":"success"}`；进程退出后注册文件消失。
- B 臂：`[init] armb-8a/derived` → `[post-turn] armb-8a/derived`；转录 `ai-title="数据库事务隔离级别"` ×2。
- A 臂：`[renamed] ZZZ Pre Pin/user` → `[post-turn] ZZZ Pre Pin/user`；转录 `custom-title="ZZZ Pre Pin"` ×3，零 `ai-title`。
- 语料：194 个带 ai-title 的转录中，值变过的 = 1（第 2 轮，`f55089be`）；`3973c352` 148 轮 49 条同值。
- 活体注册表抽样：`quay-bb`/`quay-ec`/`archguard-85`/`tailscale-64` 均 `derived`；
  `system specs query`/`list visible claude code sessions`/`oom-kill journal noise reduction` 均 `bg`+`auto`。

## 完成记录

- 判据实测（2026-10-01，真 claude 二进制 + 临时 `CLAUDE_CONFIG_DIR`）：
  - 正向：`renameFrames=1`，注册名 `derived` → `user` 且逐字等于 ai-title，`nameSince 1790846998107 → 1790846998513`，
    pid `2982334` 全程不变，转录 `ai-title` ×2 同值、`custom-title` 逐字等于镜像值。
  - 幂等：第二轮后 `renameFramesBefore=1 → renameFramesAfter=1`，注册名与 `nameSince` 不变。
  - 负控制：8s 窗内 `renameFrames=0`、转录 `ai-title=[]`，注册名保持 `derived`，pid 不变。
- 既有判据：`claude-resident-addressable.test.ts`（1 passed / 0 failed）与
  `claude-peer-name-follows-ai-title.test.ts`（1 passed / 0 failed）单独跑均绿，并已并入 `## Touches` 以便 scoped gate 覆盖。
