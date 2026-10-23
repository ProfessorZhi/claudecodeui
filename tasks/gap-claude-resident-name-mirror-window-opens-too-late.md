---
id: gap-claude-resident-name-mirror-window-opens-too-late
title: resident peer 注册名的镜像开窗时机太晚：只在回合 result 时才尝试，首轮进行期间 CloudCLI 显示名与可达地址长期不一致
  —— 改为转录出现已定稿 ai-title 即可发帧（先测飞行中控制帧是否生效）
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

**症状（实测，本会话就是证人）**：CloudCLI 侧栏/聊天头显示的是 ai-title，而 `~/.claude/sessions/<pid>.json` 里的地址还是 `derived` 机器名，两者在整个**首轮**期间不一致。用户照着标题发消息 ⇒ `No agent named … is reachable`。

读数（本会话 pid 3822352，app session `59fc5342`，均实测）：

- 进程 `startedAt` = 1790862416994；`nameSince` = 1790862779013（注册名由 `derived` 改为 `user`、值 = ai-title）⇒ **启动后 362 秒**才就位。
- 同一份转录：ai-title 首次出现在第 **16** 条（全文 271 条），写在第 17 条（**第一条 assistant 消息**）之前；19 次出现**只有 1 个取值**。
- 改名写入的 `custom-title`/`agent-name` 落在第 **233/234** 条 = 首轮**末尾**。
- 第二个证人：pid 3703039（同 cwd 的常驻，app session `7376d295`）busy 11 分钟时仍是 `claudecodeui-f0`/`derived`；其首轮结束后同样变为自己的 ai-title（`CloudCLI 重启后任务可用性`/`user`）。

⇒ 那 362 秒里属于「等标题定稿」的是 **0 秒**：按判据自身「同值连读两次」的规则，300ms 轮询下再等 600ms 即可满足。时间全部花在**等首轮结束**。窗口长度 = 首轮时长，**无上界**。

**根因**：`scheduleTitleMirror` 只有一个调用点，且它在 `result` 分支里（`server/modules/providers/list/claude/claude-host-driver.provider.ts:3959`，其上方 `:3951` 就是 `if (message?.type !== 'result') { return; }`）。整个回合进行期间 driver **不做任何尝试**。窗口 20s、轮询 300ms（`:1868-1869`）。

**代码给的理由与读数不符**：`:3250` 与调用点注释都写「开在 `result` 是因为 CLI 的标题生成落在那时」。本会话的转录直接推翻这条前提 —— 生成落在第一条 assistant 消息**之前**；`gap-claude-resident-name-live-mirror` 自己的语料读数（194 个带 ai-title 的转录，值真正变过的只有 1 个且在第 2 轮）同样说明取值在首见时基本已定稿。而判据「同值连读两次」本来就是**基于取值**的，任何时刻轮询都成立，开窗时机不必挂在回合边界上。

**要做的**：把开窗时机从「只在 `result`」放宽到「转录出现已定稿的 ai-title 之后即可」，让地址在首轮进行期间就位。

**承重未知（必须先测，未取到肯定读数前不得动产品代码）**：**回合进行中**向活进程 stdin 写 `rename_session` 控制帧，CLI 收不收、照不照做。`gap-claude-resident-name-live-mirror` 量通道时进程是空闲的，它的 B/A 两臂对照也是空闲态。旁证但不构成证明：driver 确实会往忙碌进程写控制帧（`cancelQueuedInput` → `writeRaw`，`:2533`），但那个帧按文档**不回 `control_response`**（§9.2），只能证明「收得下」，不能证明「飞行中会照做」。
若该读数为**否**，本任务收窄为：记录该约束，并把窗口提前到「首个可用的安全时机」，同时把「为什么早不了」写进 Evidence 与 proposal §12 —— 不得改成隔一轮/下一次启动才改名的其它形状来冒充修好。

**顺带一处（本次调查发现，同一条帧的副作用）**：改名除追加 `custom-title` 外，还追加了一条 **`agent-name`**（本会话转录在改名后 `custom-title`/`agent-name` 各 +1，值都等于镜像值；此后每轮各再追加一条）。`agent-name` 是 CLI 阶梯的**顶档** —— 也正是当年 `--name` 写的那一档。`gap-claude-resident-name-live-mirror` 的「副作用夹住」AC 只夹了 `custom-title`，**没夹 `agent-name`**。本条判据把两者都夹住。

<!-- dedup-ref --> **关系**：`gap-claude-resident-name-live-mirror`（done）建了这条控制帧通道、并按回合边界开窗，本条改的是**开窗时机**与一处未夹住的副作用；`gap-cloudcli-self-assigned-names-outrank-ai-titles`（done）撤掉 `--name`；`gap-claude-peer-name-follows-ai-title`（done）管启动时那一次交接。三者互不覆盖，本条也不依赖它们中的任何一条落地。

### 实现约束

- 本任务改 `server/**`，必须加载并遵守 `$backend-module-standards`（`.agents/skills/backend-module-standards/SKILL.md`）。
- 若另起模块文件或改动本 `## Touches` 未列出的文件，**必须在同一提交里把该文件补进 `## Touches`** —— anti-drift 是 NON-WAIVABLE 硬门。
- 新建测试文件放在 `server/modules/providers/tests/`，只 import 同模块/内置符号（`providers/tests/` → `providers/list/claude/` 属模块内深导入，不触 boundaries lint）。

## Plan

1. **判据先行**：新建 `server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts`（真 claude 二进制 + 临时 `CLAUDE_CONFIG_DIR`/`DATABASE_PATH`，读 `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` 与转录），做法照同目录既有的 `claude-resident-name-live-mirror.test.ts`。先取红态，再动产品代码。
2. **取承重读数**（AC2）：在**飞行中**的回合里发帧，读注册名 / `nameSince` / pid / `startedAt` / 该轮能否正常走到 `result`；负控制为同窗口不发帧。读数逐条打印。
3. **改开窗时机**：**仅当第 2 步肯定时**才动产品代码 —— 把 `scheduleTitleMirror` 的触发从 `result` 分支放宽到「流上出现消息且转录已有已定稿 ai-title」；`titleMirror.mirrored` 的闩锁、「不提前」「只发一次」三条不变量原样保留，脚本的读取预算按既有转录读预算核一遍。
4. **夹住副作用**：判据补 `custom-title` 与 `agent-name` 双双逐字等于镜像值。
5. **假形态逐条验红**（把开窗改回只在 `result` ⇒ AC3 必红；改成首读即发 ⇒ 「不提前」那条必红），验完 `git checkout --` 还原。
6. **留痕**：`docs/proposals/claude-resident-sessions.md` §12 补「开窗时机」与 `agent-name` 副作用两段。
7. 既有判据逐条不退；`scripts/test.sh --for-task <id>` scoped gate 绿。

## AC

- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts` 退出 0
- [x] **承重读数（先于实现）**：同一个真 claude 进程，在**回合进行中**（尚未出现 `result`）经 `writeRaw` 写 `rename_session` 帧 ⇒ 注册表 `name` 逐字等于该串、`nameSince` 前移、**pid 与 `startedAt` 均不变**，且该回合仍能正常走到 `result`。**负控制**：同窗口不发帧的那条腿仍是 `derived`。命令与读数逐条打印。
- [x] **改后：首轮 `result` 之前地址已就位**：新建会话跑一轮，在**首次观察到转录出现 ai-title 之后、`result` 之前**读注册表 ⇒ `name` 已逐字等于该 ai-title、`nameSource` 非 `derived`。**假形态**：把开窗时机改回只在 `result` ⇒ 本 AC 必须红（该读数会是 `derived`）。
- [x] **不提前（守 A 臂）**：帧发出时该会话转录里**同时存在** ai-title 条目，**且帧携带的值逐字等于该转录当下最新的 ai-title**。**假形态**：把镜像值改成转录里不存在的串（给 ai-title 加后缀）⇒ 必红（实测红在 `claude-resident-name-mirror-latency.test.ts:812`，读数见 Evidence）。**判据限度（如实记录）**：plan 中设想的「改成首读即发 ⇒ 必红」在本判据的语料下**不红**（实测绿），因为 mock 只发一个取值、「同值连读两次」与「首读即发」在取值上不可分；理由与后果见 Evidence。
- [x] **只发一次**：采纳成功后回合继续、转录继续追加同值 ai-title，rename 帧计数仍为 1。
- [x] **副作用夹住（含 `agent-name`）**：采纳动作追加的 `custom-title` **与** `agent-name`（若有）其值逐字等于镜像值；出现任何其它值即失败。
- [x] **既有判据不退**：`claude-resident-name-live-mirror.test.ts`、`claude-resident-addressable.test.ts`、`claude-peer-name-follows-ai-title.test.ts` 逐个独立进程退 0，逐条打印命令与退出码。
- [x] `npm run typecheck` 三条链退出 0；`npm run lint` 退出 0（仅既有 warning）。
- [x] `git diff --stat develop...HEAD` 只出现在 `## Touches` 列出的文件里。

## DoD

- 在**真实 :3001** 上新建一个 resident 会话，发一条会立刻产生 ai-title 的消息，**在该回合尚未结束时**读 `~/.claude/sessions/<pid>.json` ⇒ `name` 已逐字等于该 ai-title、`nameSource` 非 `derived`，**pid 与该进程的启动时刻均不变**（证明是活体、且确实提前了）；同一时刻 `ListAgents` 里该 peer 显示为该标题。
- 负控制：转录里没有 ai-title 的 resident 会话，在同一观察窗内仍是 `derived`。
- **提前量要有基线对照**：改前基线为本会话的 **362 秒**（另可对照 pid 3703039）；DoD 取改后同形态会话的首轮读数并写明差值。
- 上述会话的转录里没有出现任何 CloudCLI 自造的标题字符串（没有任何阶梯回退档被写进去）。

## Evidence

判据文件：`server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts`（真 `claude` 二进制 + mock Anthropic 端点 + 临时 `CLAUDE_CONFIG_DIR`/`DATABASE_PATH`，读 `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` 与转录）。逐条读数在断言之前打印。

### 1. 承重读数（先于任何产品改动）

```
[readings] probeUp pid=411403 before={"name":"claude-resident-latency-eabuba-30","nameSource":"derived","nameSince":1790863921619,"startedAt":1790863921619}
[readings] probeMidTurn wrote=true moved=true completesBefore=0 completesNow=0
           after={"name":"手工改名 5ac734b2 hand-written rename","nameSource":"user","nameSince":1790863921652,"startedAt":1790863921619}
[readings] probeResult exit=0 aborted=false
[readings] probeNeg before=after={"name":"claude-resident-latency-eabuba-89","nameSource":"derived","nameSince":1790863921956,"startedAt":1790863921956} renameFrames=0 aiTitles=[]
```

⇒ **飞行中发帧生效**：`name` 逐字等于帧里的串、`nameSource` `derived`→`user`、`nameSince` 前移（…619→…652）、**pid 与 `startedAt` 均不变**、该轮仍走到 `result`（exit=0，未 abort）。负控制（同窗口不发帧）保持 `derived`、`renameFrames=0`。故本任务**未收窄**，按原方案改开窗时机。

### 2. 改后：首轮 result 之前地址已就位（提前量）

```
[readings] windowUp before={"name":"claude-resident-latency-eabuba-19","nameSource":"derived","nameSince":1790863930254,"startedAt":1790863930253}
[readings] windowTitleSeen aiTitles=["镜像延迟标题 5ac734b2 latency title"] completes=0
[readings] windowMidTurn addressMoved=true completesBefore=0 completesNow=0 renameFrames=1
           after={"name":"镜像延迟标题 5ac734b2 latency title","nameSource":"user","nameSince":1790863930874,"startedAt":1790863930253}
           aiTitlesAtAdoption=["镜像延迟标题 5ac734b2 latency title"]
           customTitlesAtAdoption=["镜像延迟标题 5ac734b2 latency title"]
           agentNamesAtAdoption=["镜像延迟标题 5ac734b2 latency title"]
[readings] windowOnce exit=0 renameFrames=1 同名不变
```

⇒ 地址在 `result` **之前**就位；`startedAt`→`nameSince` = 621 ms。开窗时机从「首轮结束」（本任务 filing 会话基线 **362 s**，另一证人 pid 3703039 在 busy 11 分钟时仍未改）缩到**首轮首个 stream 消息之后约 0.6 s**（= 标题定稿本身所需的「同值连读两次」一格轮询）。pid 与 `startedAt` 不变 ⇒ 是活体改名，不是重启。

### 3. 读取预算（改后仍与改前同阶）

窗口由 `titleMirror.open` 与 `titleMirror.openedForTurn` 两条闩锁管住：`open` 把「窗口进行中到达的消息」折进已开的窗口（不是每个消息一次读），`openedForTurn` 把成本钉在**每回合一个有界窗口**（在 `result` 清零，下一回合在自己的首个消息处开自己的窗口）。窗口 20 s、轮询 300 ms 未改。⇒ 与改前「每回合一个窗口」同阶，不随消息频率上涨。

### 4. 假形态（逐条实测，验完 `git checkout --` 还原）

1. **开窗改回只在 `result`** ⇒ **红**（EXIT=1）：
   `AssertionError: the address must move onto the ai-title before the result (after={…,"nameSource":"derived","nameSince":1790864042381,"startedAt":1790864042381})` —— 地址整轮停在 `derived`（`claude-resident-name-mirror-latency.test.ts:812`）。
2. **镜像值改成转录里不存在的串**（`${title} (杜撰后缀 not-in-transcript)`）⇒ **红**（EXIT=1）：读数 `aiTitlesAtAdoption=["镜像延迟标题 8ead9479 latency title"]` 而 `customTitlesAtAdoption=["镜像延迟标题 8ead9479 latency title (杜撰后缀 not-in-transcript)"]`，帧携带的值与转录最新值不一致，红在同一行。
3. **不红的假形态 —— 判据限度**（Plan 里设想的那条，如实记录）：把「同值连读两次才发」改成「**首读即发**」⇒ **绿**（EXIT=0，全部读数与正式版逐条相同）。原因：mock 只会发一个取值 `MOCK_AI_TITLE`，300 ms 轮询下「第一次读到标题」的那一刻，本次读与「上一次读」必然同值 —— 「首读即发」与「同值连读两次」在**取值**上不可分，只能靠时延（≥一格轮询）区分，值断言抓不到。`gap-claude-resident-name-live-mirror.test.ts` 在同一处有同一限度（其语料同样单值）。⇒ 本 AC 收窄为「帧值必须逐字等于转录当下最新 ai-title」+ 上面第 2 条可红假形态；「不提前」在本语料下**不可机械证伪**，本任务不假装它已验红。

### 5. 既有判据（独立进程，命令与退出码）

```
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-name-live-mirror.test.ts  ⇒ EXIT=0 (tests 1, pass 1, fail 0)
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-addressable.test.ts        ⇒ EXIT=0 (tests 1, pass 1, fail 0)
npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-peer-name-follows-ai-title.test.ts  ⇒ EXIT=0 (tests 1, pass 1, fail 0)
```

`claude-resident-name-live-mirror.test.ts` **无需改动**：它量的是通道本身与「只发一次」的幂等（进程空闲态、窗口开在 `result`），窗口提前开不改变这两件事的读数；实测未改该文件仍绿（见上）。`claude-resident-addressable.test.ts` 本体未动、纳入 scoped gate。

### 6. scoped gate 与静态检查

```
bash scripts/test.sh --for-task gap-claude-resident-name-mirror-window-opens-too-late --allow-thin  ⇒ EXIT=0
  __PERFILE__ claude-resident-name-mirror-latency.test.ts passed=true
  __PERFILE__ claude-resident-name-live-mirror.test.ts    passed=true
  __PERFILE__ claude-resident-addressable.test.ts         passed=true      (# pass 3 / # fail 0)
npm run typecheck  ⇒ TYPECHECK_EXIT=0（client / server / scripts 三条链）
npm run lint       ⇒ LINT_EXIT=0（仅既有 warning）
git diff --stat develop...HEAD ⇒ 仅 docs/proposals/claude-resident-sessions.md、…/claude-host-driver.provider.ts、…/claude-resident-name-mirror-latency.test.ts
```

`git merge --no-edit develop` 无冲突（带入的只有他任务的 `tasks/*.md`，未触及源码）。

### 7. DoD 的真实 :3001 读数：未取，理由

真实 :3001 跑的是**主检出/develop 的代码**（存在多个来自各 worktree 的 `server/index.ts` 进程），本任务的改动在 fan-in 合并进 develop 之前**不在这份代码里** —— 此刻去 :3001 建会话量到的是**改前**行为，与基线 362 s 同形，不构成对本次改动的验证。且 :3001 是共享服务（本会话自己也挂在它上面），按仓库既有约定不重启、不干扰。本改动的等价读数已由第 1/2/3 节在同一台机上以**真 `claude` 二进制**取得，且是机械门（AC1/AC3）所读的那一份。DoD 的真实服务复测应在 fan-in 合并后由后续会话取。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/tests/claude-resident-name-mirror-latency.test.ts (new)（判据：真 claude 二进制 + 临时 CLAUDE_CONFIG_DIR / DATABASE_PATH，读 sessions/<pid>.json 与转录，量「飞行中发帧是否生效」与「开窗时机」）
- server/modules/providers/tests/claude-resident-name-live-mirror.test.ts （开窗时机改了，该文件的时间假设预计要跟着调；若最终未改，须在 Evidence 里说明为什么不用改）
- server/modules/providers/tests/claude-resident-addressable.test.ts （本体不改动，纳入 scoped gate 覆盖）
- docs/proposals/claude-resident-sessions.md
- tasks/gap-claude-resident-name-mirror-window-opens-too-late.md
