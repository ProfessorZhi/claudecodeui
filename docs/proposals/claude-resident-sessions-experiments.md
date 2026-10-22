# Claude 常驻会话阶段 0 实验记录（E1–E9）

由 `scripts/resident-experiment.mjs` 生成：`E1`…`E9` 每节含**原始**读数（pid、时间戳、消息类型
序列、RSS 样本、`/proc/<pid>/environ` 核对）与一行结论；`node scripts/resident-experiment.mjs
--check-record <本文件>` 逐节检查 `读数：`/`结论：` 是否齐全，缺哪节就点名哪节。

取数时间：2026-09-25。`claude --version`：2.1.282 (Claude Code)。驱动方式照 AC-025
（`server/modules/providers/tests/model-gateway-end-to-end.test.ts`）：真实 `claude` 二进制 +
本地 mock Anthropic 兼容端点，`tool_use` 由 mock 给出、工具在本地 CLI 里真实执行；**E2 的交互式
那一半**在 tmux 里跑交互式 CLI；**E7 用真实模型**（proposal 明文要求，走本机 `ANTHROPIC_BASE_URL`
指向的网关，模型 `v4.1flash`）。每个实验一个一次性临时实例，`DATABASE_PATH` 显式指向临时库并逐进程
读 `/proc/<pid>/environ` 核对。收尾另有一节「环境核对」：逐 pid 的 `/proc` 存活表、`:3001`
常驻服务未被本实验重启的证据、临时实例的 `DATABASE_PATH` 逐进程见证。

**人证已到**：`E2/E3 基准确认：` 那一行由人 yale 于 2026-09-26 指示写入，见下方记录体开头。E2/E3
的基准因此确认沿用 CLI 行为（两条形态实测一致）。E9 一节已于 2026-09-26 取数写入（`claude` 2.1.283，
见文末 E9 节），proposal 里原先待 E9 定稿的文字已按读数改完。本任务剩下未完成的是 DoD 的 ≥24 小时
浸泡（E7 只跑到 0.10 小时，不在本任务一次 dispatch 的预算内）。

## 结论速览

| 编号 | 问题 | 结论 |
|---|---|---|
| E1 | 常驻输入下 CronCreate 是否按时触发 | **是**。330s 内触发 5 次（要求 ≥3），每次是一次独立的无人轮（多一条 `result`）。 |
| E2 | busy 时推入用户消息（两种形态） | stream-json 与交互式 CLI 都**另起一轮**，不丢、不拒。 |
| E3 | 无人轮进行中推入用户消息 | **另起一轮**（注入后出现 2 条 `result`）。 |
| E4 | `interrupt()` 后进程与 cron 是否仍存活 | **仍存活**。同一 pid 继续跑，cron 从 1 次涨到 2 次。 |
| E5 | 服务进程被 kill 后常驻进程是否因 EOF 退出 | **不退出**（>120s）。清扫逻辑是必需的。 |
| E6 | `extraArgs.name` 是否生效 | **生效**，中文与空格被原样接受；判定通道是**本地转录**（`agent-name`），不是 API 请求体。 |
| E7 | 长驻内存增长（≥24 小时浸泡） | **窗口未达标**：真实模型下实际 0.10 小时（峰值树 RSS 262MB，$1.08），**不足以**定 §11 的上限数值。 |
| E8 | `bypassPermissions` 下 `AskUserQuestion` 走不走 `canUseTool` | **走**（被调用 1 次），可在回调里拦截。 |
| E9 | 控制协议清单（轮次边界 / priority 与撤回 / 后台工作事件 / cron 无人轮 / 人工入口 / flag settings / 交互式忙时） | `session_state_changed` 两条驱动都**没有**；三档都排队、撤回**没有**控制响应但 `cancelled` 事件可信；`Monitor` **不在**工具表；cron 无人轮无 `origin`、无 `scheduled_task_fire`，靠 Stop hook 清单；`elicitation` 读到实体请求、`side_question` 方向相反且无响应、`request_user_dialog` 是缺口；flag settings **没读到**（走最保守分支）；交互式忙时落后一轮。 |

取数过程中发现两条写驱动必须知道的通道细节（不是结论，是**方法**）：

1. 一轮开始时会发两条 `/v1/messages` 请求：一条 ~2KB 的预检、一条 ~77KB（完整 system prompt +
   skills 前导）的真 agent 轮。按序号、或按"请求里有没有用户文本"去认这一轮都会认错——把
   `tool_use` 发给预检那条时回复会被丢弃。要按**请求体体量**挑真轮（>10KB）。
2. 每轮以**正好一条** `result` 结束（`subtype: success/error`）。数轮次就数 `result`；不要用
   "最新一条消息里有没有某个标记"来数——cron 推入的那一轮里，标记同时出现在历史（`tool_use`
   的入参）和最新消息里，会数错。

# Claude 常驻会话阶段 0 实验记录（E1–E9）

本文件由 `scripts/resident-experiment.mjs` 写入：每节含**原始**读数（pid、时间戳、消息类型序列、
RSS 样本）与一行结论。`node scripts/resident-experiment.mjs --check-record <本文件>` 逐节检查
`读数：`/`结论：` 是否齐全（E1–E9 九节）。

E2/E3 基准确认：沿用 CLI 行为（两条形态实测一致——busy 时推入的第二条消息另起一轮、不并入当前轮、未丢失；无人轮进行中推入同样另起一轮）
（本行由人 yale 于 2026-09-26 指示写入并生效；依据是本文件 E2、E3 两节的实测读数。两条形态结论一致，故不存在「在两种形态之间取舍」的裁定项，确认即沿用。）

## E1 常驻输入下 CronCreate 是否按时触发
取数时间：2026-09-25T09:40:04.170Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
pid（运行中采样）：43674
DATABASE_PATH 核对（/proc/43674/environ）：/tmp/resident-db-DhMX/auth.db —— 与 --database-path 一致
跑时长：330s
标记：cron-tick-1790328873837
mock /v1/messages 请求总数：8
CronCreate 工具结果：isError=false text="Scheduled recurring job 91a3233d (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
result 条数：6（第 1 条是创建轮）⇒ cron 触发 5 次（要求 ≥3）
各轮结束时刻：2026-09-25T09:34:34.226Z | 2026-09-25T09:35:17.178Z | 2026-09-25T09:36:17.251Z | 2026-09-25T09:37:17.388Z | 2026-09-25T09:38:17.554Z | 2026-09-25T09:39:17.707Z
请求[0] 2026-09-25T09:34:34.186Z 回复=text bytes=1894 tools=Y lastUser=[{"type":"text","text":"<session>\n请创建一个每分钟触发的周期任务\n</sessio
请求[1] 2026-09-25T09:34:34.195Z 回复=tool_use:CronCreate bytes=77121 tools=Y lastUser="The following skills are available for use with the Skill t
请求[2] 2026-09-25T09:34:34.214Z 回复=text bytes=77558 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[3] 2026-09-25T09:35:17.175Z 回复=text bytes=77654 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[4] 2026-09-25T09:36:17.248Z 回复=text bytes=77734 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[5] 2026-09-25T09:37:17.383Z 回复=text bytes=77814 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[6] 2026-09-25T09:38:17.551Z 回复=text bytes=77894 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
请求[7] 2026-09-25T09:39:17.702Z 回复=text bytes=77974 tools=Y lastUser=[{"tool_use_id":"toolu_cron_e1","type":"tool_result","conten
消息类型序列：system/init → assistant → user → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → error
助手里的 tool_use：CronCreate
canUseTool 被调用：（无）
助手消息原文：{"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"tool_use","id":"toolu_cron_e1","name":"CronCreate","input":{"cron":"* * * * *","prompt":"cron-tick-1790328873837","recurring":true}}],"s ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa ¶ {"type":"assistant","message":{"id":"msg_mock","type":"message","role":"assistant","model":"mock-model","content":[{"type":"text","text":"ack"}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1},"context_management":null},"pa
result 原文：{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":47,"duration_api_ms":45,"ttft_ms":22,"time_to_request_ms":15,"num_turns":2,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117"," ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":8,"duration_api_ms":50,"ttft_ms":7,"time_to_request_ms":3,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","tot ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":7,"duration_api_ms":55,"ttft_ms":6,"time_to_request_ms":3,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","tot ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":13,"duration_api_ms":63,"ttft_ms":11,"time_to_request_ms":5,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","t ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":9,"duration_api_ms":69,"ttft_ms":8,"time_to_request_ms":4,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","tot ¶ {"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":12,"duration_api_ms":77,"ttft_ms":10,"time_to_request_ms":4,"num_turns":1,"result":"ack","stop_reason":"end_turn","session_id":"6c50efe8-1659-4079-a53e-b639b688c117","t
--- CLI stderr（尾部） ---
观察窗：330s（cron 为 * * * * *，期望 ≥5 次）
```
结论：周期任务连续触发 5 次（要求 ≥3），每次都以一次独立的无人轮（多一条 result）出现在流里；常驻输入下 CronCreate 按时触发。

## E2 busy 时推入用户消息（stream-json 与交互式 CLI 两种形态）
取数时间：2026-09-25T09:44:29.025Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
pid（运行中采样）：493584
DATABASE_PATH 核对（/proc/493584/environ）：/tmp/resident-db-1c9I/auth.db —— 与 --database-path 一致
第一轮延迟：20000ms（发给体量 >10KB 的真 agent 轮）
推入第二条的时刻：2026-09-25T09:43:48.742Z（第一条已发出请求）
mock 请求：2026-09-25T09:43:48.704Z bytes=77115 回复=delay20000 | 2026-09-25T09:43:48.753Z bytes=1893 回复=text | 2026-09-25T09:44:08.738Z bytes=77257 回复=text
result 条数：2（1 = 并入当前轮；2 = 另起一轮）
result 时刻：2026-09-25T09:44:08.722Z | 2026-09-25T09:44:08.746Z
消息类型序列：system/init → assistant → result/success → system/init → assistant → result/success → error
```
结论：stream-json 形态：busy 时推入的第二条消息**另起一轮**（出现 2 个 result），未丢失。





### 交互式 CLI 形态

取数时间：2026-09-25T09:47:52.779Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
tmux session：resident-e2-623914
交互式 CLI 的环境：env -i 起干净环境（不含本会话的 CLAUDE_CODE_* 身份变量），仅传 PATH/HOME/LANG/USER/SHELL/TMPDIR/XDG_RUNTIME_DIR + ANTHROPIC_BASE_URL/AUTH_TOKEN + CLAUDE_CONFIG_DIR + DATABASE_PATH
启动后会话仍存在：是
首启向导：主题选择：Enter → 安全说明：Enter → bypass 权限警告：Down+Enter（默认高亮是 No, exit） → 向导已走完（无已知对话框）
DATABASE_PATH 核对（/proc/623973/environ）：/tmp/resident-db-OAJZ/auth.db —— 与 --database-path一致
启动后 pane 尾部：▝▜██████▀  Opus 5.5 (1M context) · API Usage Billing /  ▝▝   ▝▝   /tmp/resident-e2tmux-hhJVLs / ────────────────────────────────────────────────────────────────────────────────────────────────── / ❯  / ──────────────────────────────────────────────────────────────────────────────────────────────────
推入第二条的时刻：2026-09-25T09:47:12.747Z（第一条的真 agent 轮已到达）
mock /v1/messages 请求数：3（其中真 agent 轮 2）
请求[0] 2026-09-25T09:47:12.701Z bytes=82668 回复=delay20000 lastUser=[{"type":"text","text":"# Environment\nYou have been invoked in the following environment: \n - Primary working director
请求[1] 2026-09-25T09:47:32.879Z bytes=4019 回复=text lastUser=[{"type":"text","text":"<session>\n第二条：我在你回答时插一句话\n</session>\n\nWrite the title in the predominant language of the sess
请求[2] 2026-09-25T09:47:32.881Z bytes=82865 回复=text lastUser=[{"type":"text","text":"<total_tokens>15000000 tokens left</total_tokens>","cache_control":{"type":"ephemeral"}}]
真 agent 轮数：2（1 = 第二条并入当前轮；2 = 另起一轮）
信任对话框出现过：否
实验结束时仍卡在对话框上：否
--- pane 原文（尾部） ---

──────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents



































```
结论：交互式 CLI 形态：busy 时输入的第二条消息**另起一轮**（真 agent 轮数 2），未丢失。

## E3 无人轮进行中推入用户消息 / busy 时跨会话消息到达
取数时间：2026-09-25T09:46:46.479Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
pid（运行中采样）：561407
DATABASE_PATH 核对（/proc/561407/environ）：/tmp/resident-db-tePL/auth.db —— 与 --database-path 一致
标记：unattended-1790329525689
CronCreate 工具结果：isError=false text="Scheduled recurring job 78f10f63 (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
cron 触发的无人轮请求：2026-09-25T09:46:14.218Z（该轮被 __DELAY__16000 挂住）
注入时刻：2026-09-25T09:46:14.253Z（注入时无人轮仍在进行：是；注入前的 result 条数 1）
请求[0] 2026-09-25T09:45:26.261Z user bytes=1894 回复=text lastUser=[{"type":"text","text":"<session>\n请创建一个每分钟触发的周期任务\n</sessio
请求[1] 2026-09-25T09:45:26.283Z user bytes=77121 回复=tool_use:CronCreate lastUser="The following skills are available for use with the Skill t
请求[2] 2026-09-25T09:45:26.332Z tool-result bytes=77559 回复=delay16000 lastUser=[{"tool_use_id":"toolu_cron_e3","type":"tool_result","conten
请求[3] 2026-09-25T09:46:14.218Z tool-result bytes=77668 回复=delay16000 lastUser=[{"tool_use_id":"toolu_cron_e3","type":"tool_result","conten
请求[4] 2026-09-25T09:46:14.259Z user bytes=1889 回复=text lastUser=[{"type":"text","text":"<session>\n无人轮进行中我插一句\n</session>"}]
请求[5] 2026-09-25T09:46:30.239Z tool-result bytes=77729 回复=delay16000 lastUser=[{"tool_use_id":"toolu_cron_e3","type":"tool_result","conten
result 总条数：3
注入之后的 result：2 条 —— 2026-09-25T09:46:30.229Z | 2026-09-25T09:46:46.246Z
消息类型序列：system/init → assistant → user → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → error
```
结论：无人轮（cron 触发）进行中推入用户消息：**没有被拒绝，另起了一轮**（注入后出现 2 条 result：无人轮结束 2026-09-25T09:46:30.229Z、注入轮结束 2026-09-25T09:46:46.246Z）。

## E4 interrupt() 后进程与 cron 是否仍存活
取数时间：2026-09-25T09:37:23.957Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
interrupt 时刻：2026-09-25T09:35:51.878Z
DATABASE_PATH 核对（/proc/43673/environ）：/tmp/resident-db-xJGP/auth.db —— 与 --database-path 一致
interrupt 前 pid：43673
interrupt 后 pid：43673
进程仍存活：是
CronCreate 工具结果：isError=false text="Scheduled recurring job fb572570 (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
cron 触发次数：interrupt 前 1 → 之后 2
消息类型序列：system/init → assistant → user → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success → system/init → assistant → result/success
```
结论：interrupt() 只停了当前一轮：同一 pid（43673）仍在，cron 从 1 次继续涨到 2 次。

## E5 服务进程被 kill 后常驻进程是否因 EOF 退出
取数时间：2026-09-25T09:41:34.396Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
子进程（扮演服务进程）pid：296439
常驻 claude pid：296499
DATABASE_PATH 核对（/proc/296499/environ）：/tmp/resident-db-t5CH/auth.db —— 与 --database-path 一致
kill 前常驻存活：是
kill 时刻：2026-09-25T09:39:34.252Z
常驻退出用时：>120s（未退出）
残留清扫：已由本实验清扫（SIGKILL），无残留
```
结论：服务进程被 kill 后常驻进程 120 秒内**没有**退出——清扫逻辑是必需的。

## E6 extraArgs.name 是否生效、是否接受中文与空格
取数时间：2026-09-25T09:36:03.997Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
extraArgs.name（ASCII）：resident-e6-103193
--name 是合法旗标：-n, --name <name>                     Set a display name for this session
本地转录里找到的 agent-name：resident-e6-103193
本地转录里找到的 custom-title：resident-e6-103193
转录文件：/tmp/resident-e6-XkAu4Y/claude-config/projects/-tmp-resident-e6-XkAu4Y/8b8ea704-c102-4771-a5b9-681356ea7249.jsonl
mock 收到的请求体里出现该名：否（peer 名不进 API，这条不能用来判定生效与否）
system/init 原文：{"type":"system","subtype":"init","cwd":"/tmp/resident-e6-XkAu4Y","session_id":"8b8ea704-c102-4771-a5b9-681356ea7249","tools":["Task","AskUserQuestion","Bash","CronCreate","CronDelete","CronList","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","NotebookEdit","Read","ScheduleWakeup","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","WebFetch","WebSearch","Workflow","Write"],"mcp_servers":[],"model":"v4.1flash[1m]","permissionMode":"bypassPermissions","slash_commands":["deep-research","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator","clear","compact","context","heapdump","init","reload-skills","review","security-review","usage","insights","goal","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.165","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator"],"plugins":[],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"f02d824d-6800-437c-b53e-7cebbe448a29","memory_paths":{"auto":"/tmp/resident-e6-XkAu4Y/claude-config/projects/-tmp-resident-e6-XkAu4Y/memory/"},"fast_mode_state":"off"}
extraArgs.name（中文 + 空格）：实验会话 中文 空格
本地转录里找到的 agent-name：实验会话 中文 空格
本地转录里找到的 custom-title：实验会话 中文 空格
转录文件：/tmp/resident-e6b-xZT4mH/claude-config/projects/-tmp-resident-e6b-xZT4mH/9543d779-147a-4c9c-81bd-cf8061c0c1df.jsonl
system/init 原文：{"type":"system","subtype":"init","cwd":"/tmp/resident-e6b-xZT4mH","session_id":"9543d779-147a-4c9c-81bd-cf8061c0c1df","tools":["Task","AskUserQuestion","Bash","CronCreate","CronDelete","CronList","Edit","EnterPlanMode","EnterWorktree","ExitPlanMode","ExitWorktree","NotebookEdit","Read","ScheduleWakeup","Skill","TaskCreate","TaskGet","TaskList","TaskOutput","TaskStop","TaskUpdate","WebFetch","WebSearch","Workflow","Write"],"mcp_servers":[],"model":"v4.1flash[1m]","permissionMode":"bypassPermissions","slash_commands":["deep-research","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator","clear","compact","context","heapdump","init","reload-skills","review","security-review","usage","insights","goal","team-onboarding"],"apiKeySource":"none","claude_code_version":"2.1.165","output_style":"default","agents":["claude","Explore","general-purpose","Plan","statusline-setup"],"skills":["deep-research","update-config","verify","debug","code-review","simplify","batch","fewer-permission-prompts","loop","claude-api","run","run-skill-generator"],"plugins":[],"analytics_disabled":false,"product_feedback_disabled":false,"uuid":"1dd3a676-513f-4f82-bcdd-33919a6d0721","memory_paths":{"auto":"/tmp/resident-e6b-xZT4mH/claude-config/projects/-tmp-resident-e6b-xZT4mH/memory/"},"fast_mode_state":"off"}
```
结论：extraArgs.name 生效：本地转录里 `agent-name` 与设定值逐字一致（ASCII="resident-e6-103193"，中文+空格="实验会话 中文 空格"），中文与空格**被原样接受**。该名不进 API 请求体（mock 端看不到），判定必须读转录。

**补记（2026-09-27，AC-164 判据的实测读数）**：`agent-name` 行的原文形态逐字如下，它除了名字还带 `sessionId`，因此判据可以核对这行确实属于本次进程（而不是同目录下别的会话留下的）：

```
{"type":"agent-name","agentName":"ac164-addressable-alpha-d275e2","sessionId":"0baaf7be-67b1-4bcc-9453-75bd9c2b2d2a"}
{"type":"agent-name","agentName":"ac164-addressable-beta-d275e2","sessionId":"c318f5c4-6145-4f6c-9df9-521c00917d7f"}
```

名字按 `标题 slug + "-" + 会话 ID 前 6 位` 生成（proposal §12），落在 `<CLAUDE_CONFIG_DIR>/projects/<bucket>/<session>.jsonl` 里；bucket 名是 CLI 对 cwd 的编码，判据不重算它、而是扫 `projects/*/` 下按 session 名匹配的文件。

## E7 长驻内存增长（≥24 小时浸泡）
取数时间：2026-09-25T09:49:49.426Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
端点：真实模型（沿用 ANTHROPIC_BASE_URL=http://127.0.0.1:26510/，模型 v4.1flash）
浸泡起点：2026-09-25T09:43:48.024Z
浸泡目标：0.1 小时；本机实际观察窗：0.10 小时 —— ⛔未达 ≥24h，本次读数不能用来定 §11 的上限
采样间隔：0.5 分钟，样本数：12
费用（SDK result.total_cost_usd 求和）：$1.0836
token：input=29080 output=11964 cache_read=300928 cache_write=0
浸泡期间 cron 触发的无人轮数：1
残留清扫：已由本实验清扫，无残留
起点 RSS：self=253888KB tree=253888KB
峰值 RSS：2026-09-25T09:44:48.188Z self=262532KB tree=262532KB
终点 RSS：2026-09-25T09:49:49.059Z self=233144KB tree=233144KB
2026-09-25T09:44:18.102Z +0.01h pid=493481 self=253888KB tree=253888KB
2026-09-25T09:44:48.188Z +0.02h pid=493481 self=262532KB tree=262532KB
2026-09-25T09:45:18.256Z +0.03h pid=493481 self=231236KB tree=231236KB
2026-09-25T09:45:48.345Z +0.03h pid=493481 self=231260KB tree=231260KB
2026-09-25T09:46:18.438Z +0.04h pid=493481 self=231224KB tree=231224KB
2026-09-25T09:46:48.509Z +0.05h pid=493481 self=231240KB tree=231240KB
2026-09-25T09:47:18.601Z +0.06h pid=493481 self=231872KB tree=231872KB
2026-09-25T09:47:48.708Z +0.07h pid=493481 self=231536KB tree=231536KB
2026-09-25T09:48:18.793Z +0.08h pid=493481 self=231552KB tree=231552KB
2026-09-25T09:48:48.886Z +0.08h pid=493481 self=232616KB tree=232616KB
2026-09-25T09:49:18.971Z +0.09h pid=493481 self=254124KB tree=254124KB
2026-09-25T09:49:49.059Z +0.10h pid=493481 self=233144KB tree=233144KB
样本原文：/tmp/resident-e7-MHsdWS/rss-samples.json
```
结论：浸泡 0.10 小时，离 ≥24h 还差 23.90 小时：峰值树 RSS 262532KB 只够说明"没有分钟级的暴涨"，**不足以**定 §11 的上限数值——§11 的数值仍待一次真正的 24 小时浸泡。

## E8 bypassPermissions 下 AskUserQuestion 走不走 canUseTool
取数时间：2026-09-25T08:58:34.632Z
claude --version：2.1.282 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）

读数：
```
permissionMode：bypassPermissions
canUseTool 被调用次数：1
拦截到的工具名：AskUserQuestion
消息类型序列：system/init → assistant → user → assistant → result/success
```
结论：bypassPermissions 下 AskUserQuestion **仍然**走 canUseTool（被调用 1 次，工具名 AskUserQuestion），可以在回调里拦截。

## 环境核对（全部实验跑完之后取的静止读数）

### 1. 每个一次性实例都显式指了临时 DATABASE_PATH（逐进程读 /proc/<pid>/environ 核对）

```
记录行 15:DATABASE_PATH 核对（/proc/43674/environ）：/tmp/resident-db-DhMX/auth.db —— 与 --database-path 一致
记录行 48:DATABASE_PATH 核对（/proc/493584/environ）：/tmp/resident-db-1c9I/auth.db —— 与 --database-path 一致
记录行 74:DATABASE_PATH 核对（/proc/623973/environ）：/tmp/resident-db-OAJZ/auth.db —— 与 --database-path一致
记录行 136:DATABASE_PATH 核对（/proc/561407/environ）：/tmp/resident-db-tePL/auth.db —— 与 --database-path 一致
记录行 161:DATABASE_PATH 核对（/proc/43673/environ）：/tmp/resident-db-xJGP/auth.db —— 与 --database-path 一致
记录行 180:DATABASE_PATH 核对（/proc/296499/environ）：/tmp/resident-db-t5CH/auth.db —— 与 --database-path 一致
```

见证方式：在实例**还活着**时读 `/proc/<pid>/environ`，比对 `DATABASE_PATH=` 与本次
`--database-path` 的取值；上面每一行都是当时进程自身的环境，不是脚本的自述。

### 2. :3001 常驻服务：本实验从未重启它

```
脚本里 systemctl 调用次数：0
端口保护：61:export const PROTECTED_PORT = 3001;
拒绝逻辑：108:    throw new GuardRefusal(`拒绝运行：端口 ${PROTECTED_PORT} 是本机常驻服务，实验一律避开`);
--- journalctl --user -u claudecodeui-server.service（本日窗口）---
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: Stopping claudecodeui-server.service - /data/home/yale/.nvm/versions/node/v24.21.0/bin/npm run server...
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: Stopped claudecodeui-server.service - /data/home/yale/.nvm/versions/node/v24.21.0/bin/npm run server.
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Consumed 20.641s CPU time, 1.0G memory peak, 0B memory swap peak.
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: claudecodeui-server.service: Failed to open /run/user/1004/systemd/transient/claudecodeui-server.service: No such file or directory
Sep 25 17:31:02 VM-16-5-ubuntu systemd[319121]: Started claudecodeui-server.service - /data/home/yale/.nvm/versions/node/v24.21.0/bin/npm run server.
```

17:31:02 那次 Stopping→Stopped→Started 是**环境侧**发生的（另一路会话/部署），不是本实验：
本实验的进程树里没有任何 `systemctl` 调用（上面计数为 0），且脚本把 3001 列为受保护端口、
任何拿 3001 起实例的调用都会被 `GuardRefusal` 拒绝。会话本身是 :3001 的子进程，重启它会杀掉
托管本次会话的服务——这也是「一律避开 3001、绝不重启」这条约束的由来。

### 3. 进程与 systemd scope 清扫

记录里出现过的每一个实例 pid，此刻逐个查 `/proc/<pid>`（活着才在，清扫干净则不在）：

```
pid 43674 → 已退出
pid 493584 → 已退出
pid 623973 → 已退出
pid 561407 → 已退出
pid 43673 → 已退出
pid 296499 → 已退出
pid 493481 → 已退出
pid 623914 → 已退出
（共 8 个 pid，仍在的 0 个）
--- pgrep：本实验的脚本/mock/tmux 常驻进程（已排除调用方自身）---
（无）
--- tmux 会话 ---
（无 resident-* 会话）
--- systemctl --user list-units（全机含 claude/resident 字样的 unit，含与本实验无关的）---
  ● oomprobe-2421772.scope                                                                              loaded    failed   failed    /data/home/yale/.nvm/versions/node/v24.21.0/bin/npx vitest run --reporter=json --outputFile=/data/scratch/yale/claude-1004/-data-home-yale-work-claudecodeui/8e45901a-04fe-4505-b574-338e574e729d/scratchpad/v.json src/__oomprobe__/oom.test.ts
    quay-drivers-claudecodeui-1790309708.scope                                                          loaded    active   running   /usr/bin/env QUAY_MEMORY_SLICE=quay-fleet.slice node /data/home/yale/.claude/plugins/cache/quay/quay/0.11.0/scripts/dist/start-drivers.js --root /data/home/yale/work/claudecodeui
    claudecodeui-server.service                                                                         loaded    active   running   /data/home/yale/.nvm/versions/node/v24.21.0/bin/npm run server
```

说明：上面这一批 unit 是**全机**范围，不全是本实验的——`claudecodeui-server.service` 是本机
常驻服务（本实验只读不动它），`quay-drivers-*.scope` 是 quay 驱动自己的，名字里带 `claude`
只是因为路径或服务名的巧合。本实验起的东西是**自己进程树的子进程**，收尾在脚本的 `finally` 里
做，所以真正的证据是上面那张 `/proc/<pid>` 逐 pid 表，不是 `list-units`。

E5 的读数说明为什么这节必须存在：服务进程被 kill 后常驻 `claude` 120 秒内不会自己退出；
同一个进程还在跑 cron，所以每次实验结束都要**主动清扫**（脚本在 `finally` 里 SIGKILL 自己的
后代并就地把清扫结果写进记录）。

## E9 控制协议清单：宿主自己写 stream-json / control_request 帧能拿到什么
取数时间：2026-09-26T00:44:20.121Z
claude --version：2.1.283 (Claude Code)
systemd scope：是（INVOCATION_ID 存在）
@anthropic-ai/claude-agent-sdk 版本：0.3.165
驱动方式：宿主自己写 `--print --input-format stream-json --output-format stream-json` 的 stdin 帧（`user` / `control_request`），逐行读 stdout 原文；SDK `query()` 那条路在 9.1 里作对照。
SDK 面（`sdk.d.ts` 的 `Query` 接口）：只有 interrupt / setPermissionMode / setModel / setMaxThinkingTokens / applyFlagSettings / stopTask / streamInput / rewindFiles / … 这些方法；`side_question`、`cancel_async_message`、`get_settings`、`elicitation` **不在接口上**（`SDKControlRequestInner` 里都列了，只有写帧才够得着）。
另注：`SDKControlSideQuestionRequest` 在 `SDKControlRequestInner` 的联合里被引用，但 `sdk.d.ts` 里**找不到它的声明**（全包只有 1 处出现）——所以它的字段名只能按实跑结果确定（本实验用的 `{subtype, question, history}` 能拿到 `{"success":{"response":…,"synthetic":false}}`）。

读数：

**9.0 环境核对（临时库见证 / 无残留进程与 scope）**

```
claude --version：2.1.283 (Claude Code)；systemd scope（脚本自身）：是
DATABASE_PATH 核对（/proc/23556/environ）：/tmp/resident-e9-r1/auth.db —— 与 --database-path 一致
子进程环境：ANTHROPIC_BASE_URL=http://127.0.0.1:29901 CLAUDE_CONFIG_DIR=/tmp/resident-e9z-NNOobU/claude-config ANTHROPIC_API_KEY=（未设置）
收尾后 descendantClaudePids(脚本进程)：（空，无残留）
tmux ls：docker-8: 1 windows (created Mon Sep 21 10:32:51 2026) (group docker) | quay-1: 5 windows (created Wed Sep 16 10:41:00 2026) (group quay) (attached) | test-sess: 1 windows (created Fri Sep 25 11:25:52 2026)
systemctl --user list-units --type=scope 里含 claude/cloudcli/resident 的行：● oomprobe-2421772.scope                                loaded failed failed  /data/home/yale/.nvm/versions/node/v24.21.0/bin/npx vitest run --reporter=json --outputFile=/data/scratch/yale/claude-1004/-data-home-yale-work-claudecodeui/8e45901a-04fe-4505-b574-338e574e729d/scratchpad/v.json src/__oomprobe__/oom.test.ts |   quay-drivers-claudecodeui-1790309708.scope            loaded active running /usr/bin/env QUAY_MEMORY_SLICE=quay-fleet.slice node /data/home/yale/.claude/plugins/cache/quay/quay/0.11.0/scripts/dist/start-drivers.js --root /data/home/yale/work/claudecodeui
```

**9.1 轮次边界：`session_state_changed` 相对 `result` 的时序**

```
raw 驱动（--print --input-format stream-json）：共 7 条事件；session_state_changed 0 条；result 1 条；system/init 1 条
事件序列：command_lifecycle → command_lifecycle → system/init → user → assistant → result/success → command_lifecycle
result 时刻：2026-09-26T00:39:35.799Z
system/init 时刻：2026-09-26T00:39:35.714Z
SDK 驱动（startResident → query()）：共 4 条消息；session_state_changed 0 条；result 1 条
SDK 事件序列：system/init → assistant → result/success → error
```

**9.2 priority 三档、忙时队列与 `cancel_async_message`**

```
三档的推入时刻与 uuid（uuid 由宿主分配；CLI 的 `command_uuid` 与它同值）：
  priority=later uuid=cd0f5b98-e9e5-47dd-8c1d-2119c102dcc8
  priority=next uuid=c972d202-a571-4cce-b310-6e3e836841b5
  priority=now uuid=3c5e443c-ca1c-4813-8b0d-dd4700393783
command_lifecycle 事件序列（queued / started / cancelled / completed 各自对应哪条消息）：
  00:39:55.331 command_lifecycle state=queued command_uuid=2bf94cb6
  00:39:55.334 command_lifecycle state=started command_uuid=2bf94cb6
  00:39:57.643 command_lifecycle state=queued command_uuid=cd0f5b98
  00:39:58.843 command_lifecycle state=queued command_uuid=c972d202
  00:40:00.044 command_lifecycle state=queued command_uuid=3c5e443c
  00:40:02.245 command_lifecycle state=cancelled command_uuid=c972d202
  00:40:07.476 command_lifecycle state=cancelled command_uuid=2bf94cb6
  00:40:07.477 command_lifecycle state=started command_uuid=3c5e443c
  00:40:07.512 command_lifecycle state=completed command_uuid=3c5e443c
  00:40:07.513 command_lifecycle state=started command_uuid=cd0f5b98
  00:40:07.530 command_lifecycle state=completed command_uuid=cd0f5b98
推入的用户消息回放（看 CLI 有没有把 priority 回显出来）：
  00:39:55.400 user origin=（无） priority=（无） isSynthetic=（无） uuid=2bf94cb6 text="E9-BUSY-BASH 请执行"
  00:40:07.470 user origin=（无） priority=（无） isSynthetic=（无） uuid=5d25beb7 text=""
  00:40:07.492 user origin=（无） priority=（无） isSynthetic=（无） uuid=3c5e443c text="E9-P-NOW 忙时推入"
  00:40:07.526 user origin=（无） priority=（无） isSynthetic=（无） uuid=cd0f5b98 text="E9-P-LATER 忙时推入"
cancel_async_message 的 control_response 原文：
  取消 priority=next（仍在队列里）：（无响应）
  取消 priority=now（已被处理完）：（无响应）
  取消 priority=（任意）（uuid 不存在）：（无响应）
result 条数：3
各标记首次出现在哪一次 /v1/messages 请求里（轮次归属）：
  E9-BUSY-BASH：第 2 次真 agent 轮请求
  E9-P-LATER：第 6 次真 agent 轮请求
  E9-P-NEXT：（没有出现在任何真 agent 轮请求里）
  E9-P-NOW：第 5 次真 agent 轮请求
真 agent 轮请求数（bytes>10KB）：3
```

**9.3 `task_started` / `task_notification` / `background_tasks_changed` 覆盖哪些后台工作**

```
常驻 stream-json 下 CLI 暴露的工具表（system/init.tools，共 21 个）：Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, WebFetch, WebSearch, Workflow, Write
Monitor 在工具表里：**不在**；ScheduleWakeup：在
task_* / background_tasks_changed 事件（原始行）：
  00:40:22.670 {"type":"system","subtype":"task_started","task_id":"b2k6xdn8u","tool_use_id":"toolu_e9_fg","description":"sleep 5; echo fg-done","is_backgrounded":false,"task_type":"local_bash","uuid":"60adf10f-6bc1-4799-8672-bd8d0d8a2ff7","session_id":"0ad55807-b62b-476d-a321-a13ed744e7dc"}
  00:40:24.673 {"type":"system","subtype":"task_notification","task_id":"b2k6xdn8u","tool_use_id":"toolu_e9_fg","status":"completed","output_file":"","summary":"sleep 5; echo fg-done","uuid":"40e4d246-c26d-460d-8d3f-27f3bf20b698","session_id":"0ad55807-b62b-476d-a321-a13ed744e7dc"}
  00:40:28.397 {"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"ae397d1bd2225d146","task_type":"local_agent","description":"E9 子代理"}],"uuid":"d2e8bc0f-10c7-4554-be5d-e24ad7a70b0e","session_id":"0ad55807-b62b-476d-a321-a13ed744e7dc"}
  00:40:28.398 {"type":"system","subtype":"task_started","task_id":"ae397d1bd2225d146","tool_use_id":"toolu_e9_agent","description":"E9 子代理","subagent_type":"general-purpose","is_backgrounded":true,"spawn_depth":1,"task_type":"local_agent","prompt":"一句话回答：收到","uuid":"99244cbf-2955-4579-9887-f53c9eba416d","session_
  00:40:28.431 {"type":"system","subtype":"background_tasks_changed","tasks":[],"uuid":"6eca09cc-90f4-4b5d-aa70-1441dea4f443","session_id":"0ad55807-b62b-476d-a321-a13ed744e7dc"}
  00:40:28.431 {"type":"system","subtype":"task_notification","task_id":"ae397d1bd2225d146","tool_use_id":"toolu_e9_agent","status":"completed","output_file":"/tmp/claude-1004/-tmp-resident-e9c-Vc69a8/0ad55807-b62b-476d-a321-a13ed744e7dc/tasks/ae397d1bd2225d146.output","summary":"e9-filler","usage":{"total_tokens"
  00:40:46.406 {"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1xilwjjq","task_type":"local_bash","description":"sleep 30; echo bg-done"}],"uuid":"03e917cf-9c4e-404f-abdd-bd448ea8e432","session_id":"0ad55807-b62b-476d-a321-a13ed744e7dc"}
  00:40:46.406 {"type":"system","subtype":"task_started","task_id":"b1xilwjjq","tool_use_id":"toolu_e9_bg","description":"sleep 30; echo bg-done","is_backgrounded":true,"task_type":"local_bash","uuid":"9aa7bbd7-ba44-4a57-aaa5-6c05da79e478","session_id":"0ad55807-b62b-476d-a321-a13ed744e7dc"}
事件序列：command_lifecycle → command_lifecycle → system/init → user → assistant → system/task_started → system/task_notification → user → assistant → result/success → command_lifecycle → command_lifecycle → command_lifecycle → system/init → user → assistant → system/background_tasks_changed → system/task_started → user → assistant → system/background_tasks_changed → system/task_updated → system/task_notification → assistant → result/success → command_lifecycle → system/init → assistant → result/success → command_lifecycle → command_lifecycle → system/init → user → assistant → system/background_tasks_changed → system/task_started → user → assistant → result/success → command_lifecycle
```

**9.4/9.5 cron 无人轮的事件形态、`origin`、`scheduled_task_fire` 与 Stop hook 的 `session_crons` / `background_tasks`**

```
CronCreate 工具结果：isError=false text="Scheduled recurring job 7d58f90e (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."
事件序列：command_lifecycle → command_lifecycle → system/init → user → assistant → user → assistant → result/success → command_lifecycle → command_lifecycle → command_lifecycle → system/init → user → assistant → system/background_tasks_changed → system/task_started → user → assistant → result/success → command_lifecycle
所有 command_lifecycle：
  00:40:59.692 command_lifecycle state=queued command_uuid=fd6abd29
  00:40:59.695 command_lifecycle state=started command_uuid=fd6abd29
  00:40:59.846 command_lifecycle state=completed command_uuid=fd6abd29
  00:41:07.478 command_lifecycle state=queued command_uuid=d7ee7ee0
  00:41:07.479 command_lifecycle state=started command_uuid=d7ee7ee0
  00:41:07.564 command_lifecycle state=completed command_uuid=d7ee7ee0
未被宿主推入过的 command_uuid（即自主轮，cron 发火就是这种）共 0 条：（无）
全部 user 事件原文（这是唯一能看到 origin 的地方）：
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"E9-CRON-CREATE 请创建一个每分钟的周期任务"}]},"session_id":"b827aab6-2114-4fe2-b1af-991a6c2285e1","parent_tool_use_id":null,"uuid":"fd6abd29-69c0-44db-ace6-9b1f05443580","timestamp":"2026-09-26T00:40:59.720Z","isReplay":true}
  {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_e9_cron","type":"tool_result","content":"Scheduled recurring job 7d58f90e (Every minute). Session-only (not written to disk, dies when Claude exits). Auto-expires after 7 days. Use CronDelete to cancel sooner."}]},"parent_tool_use_id":null,"session_id":"b827aab6-2114-4fe2-b1af-991a6c2285e1","uuid":"5b13a4f2-1d51-4a48-9ec5-25540b5a1100","timestamp":"2026-09-26T00:40:59.770Z","tool_use_result":{"id":"7d58f90e","humanSchedule":"Every minute","recurring":true,"durable":false}}
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"E9-BG-HOLD 请挂一个后台任务"}]},"session_id":"b827aab6-2114-4fe2-b1af-991a6c2285e1","parent_tool_use_id":null,"uuid":"d7ee7ee0-e8e4-4b2c-b26d-c8d574d4d5c4","timestamp":"2026-09-26T00:41:07.483Z","isReplay":true}
  {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_e9_hold","type":"tool_result","content":"Command running in background with ID: b1dwq9kee. Output is being written to: /tmp/claude-1004/-tmp-resident-e9d-1bKRr2/b827aab6-2114-4fe2-b1af-991a6c2285e1/tasks/b1dwq9kee.output. You will be notified when it completes. To check interim output, use Read on that file path.","is_error":false}]},"parent_tool_use_id":null,"session_id":"b827aab6-2114-4fe2-b1af-991a6c2285e1","uuid":"83bfe670-5526-481a-87c1-1757012fd068","timestamp":"2026-09-26T00:41:07.539Z","tool_use_result":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false,"backgroundTaskId":"b1dwq9kee"}}
出现过的 system subtype：init, background_tasks_changed, task_started
SDK 类型表里没有的 subtype（本实验实际读到）：（无）
是否出现 scheduled_task_fire：**没有出现**
Stop hook 调用 2 次，逐次原文：
  [2026-09-26T08:40:59+08:00] session_crons=[{"id":"7d58f90e","schedule":"* * * * *","recurring":true,"prompt":"E9-TICK-MARKER"}] background_tasks=[] stop_hook_active=false
  [2026-09-26T08:41:07+08:00] session_crons=[{"id":"7d58f90e","schedule":"* * * * *","recurring":true,"prompt":"E9-TICK-MARKER"}] background_tasks=[{"id":"b1dwq9kee","type":"shell","status":"running","description":"sleep 300; echo hold-done","command":"sleep 300; echo hold-done"}] stop_hook_active=false
Stop hook 输入的全部键（最后一次）：session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, stop_hook_active, last_assistant_message, background_tasks, session_crons
CLI stderr（尾部）：[claude-code:unrecognized_model] {"model":"v4.1flash","query_source":"generate_session_title"}
```

**9.6 除 `canUseTool` 外的「需要人回应」入口：`side_question` / MCP elicitation / `request_user_dialog`**

```
CLI 发出的控制请求（JSON 原文，这是"CLI 问宿主"的方向）：
  {"type":"control_request","request_id":"97bacb9a-7e8f-4515-87f7-8126bfc05422","request":{"subtype":"elicitation","mcp_server_name":"e9eliciting","message":"E9 请人回答","mode":"form","requested_schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}}
side_question 的响应原文：（无响应）
side_question 期间的 control_request_progress 事件：{"type":"system","subtype":"control_request_progress","request_id":"9dcd2b33-2683-43ac-ad5a-0c6f738cc0eb","status":"started","uuid":"20be6910-a892-4360-b696-c74bde70f48b","session_id":"19886bf4-f939-40ca-ac10-3776df68e580"}
elicitation 请求条数：1；原文：{"type":"control_request","request_id":"97bacb9a-7e8f-4515-87f7-8126bfc05422","request":{"subtype":"elicitation","mcp_server_name":"e9eliciting","message":"E9 请人回答","mode":"form","requested_schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}}}
工具表里有 mcp__e9eliciting__ask_host：有
主轮里助手调用的工具名：mcp__e9eliciting__ask_host
出现过的 subtype：system/init, result/success, system/control_request_progress
CLI stderr（尾部）：[claude-code:unrecognized_model] {"model":"v4.1flash","query_source":"generate_session_title"}
```

**9.7 flag settings 能否压过用户 settings（Remote Control / isolatePeerMachines）**

```
【user settings 开着 remoteControlAtStartup（不加 --settings）】
  临时配置目录的 settings.json：{"remoteControlAtStartup":true,"isolatePeerMachines":false}
  --settings 取值：（未加）
  mock 端点收到的全部路径：/api/hello, /v1/messages?beta=true
  CLI 发出的控制请求 subtype：（无）
  get_settings 响应：（无响应——这个 subtype 不接受/不返回）
  stderr 里含 remote/ccr/bridge 的行（0 条）：（无）
【同一目录 + --settings 压成 false/true】
  临时配置目录的 settings.json：{"remoteControlAtStartup":true,"isolatePeerMachines":false}
  --settings 取值：{"remoteControlAtStartup":false,"isolatePeerMachines":true}
  mock 端点收到的全部路径：/api/hello, /v1/messages?beta=true
  CLI 发出的控制请求 subtype：（无）
  get_settings 响应：（无响应——这个 subtype 不接受/不返回）
  stderr 里含 remote/ccr/bridge 的行（0 条）：（无）
```

**9.8 交互式 CLI 忙时输入落进哪一轮（与 9.2 的三档对表）**

```
tmux 会话：resident-e9-23527；向导步骤：主题：Enter → 安全说明：Enter → bypass 警告：Down+Enter
DATABASE_PATH 核对（/proc/<pane_pid>/environ）：/tmp/resident-e9-r1/auth.db —— 与 --database-path一致
真 agent 轮请求数：2；各轮请求体里出现过的标记：
  [0] 2026-09-26T00:43:52.336Z E9-INTERACTIVE-SLOW
  [1] 2026-09-26T00:44:04.446Z E9-INTERACTIVE-SLOW+E9-INTERACTIVE-SECOND
第二条消息首次出现的轮次序号：1
第一条（慢）消息首次出现的轮次序号：0
⇒ 两条消息在**不同轮**里
pane 尾部原文：
  
  
  
  
  
  
  
  
  
  
  
  
  
  
```

**9.9 缺口补取：后台 Bash 完成后 CLI 是否自行开一轮（AC-162 的第一步）**

取数时间：2026-09-27T07:18Z 起
claude --version：2.1.283（探针 `system/init` 里逐字 `claude_code_version:"2.1.165"`）；@anthropic-ai/claude-agent-sdk 0.3.165
驱动方式：两条路各跑一次同一个剧本 —— 宿主推**一条**用户消息让模型以后台方式起 Bash 盯一个测试控制的文件（`while [ ! -f <file> ]; do sleep 0.1; done`），首轮 `result` 之后**不再推任何东西**，500ms 后宿主创建该文件。① raw 路：`claude --print --input-format stream-json --output-format stream-json --verbose`，宿主自己写 stdin 帧（帧上带自己分配的 `uuid`），逐行读 stdout 原文；② SDK 路：`query()` + 永不结束的 prompt iterable（与本仓常驻驱动的形态一致），`options.hooks.Stop` 另外挂一个回调。两路的 mock 端点都只回答 `/v1/messages`。

读数（raw 路，`[ev]` 行逐字；时间相对首帧）：

```
[host] pushed user frame uuid=3ede4498-6f78-4915-90c5-d78b56bfc11a at 300ms
[ev] 304ms command_lifecycle command_uuid=3ede4498-... inPushedSet=true
[ev] 306ms command_lifecycle command_uuid=3ede4498-... inPushedSet=true
[ev] 333ms system/init uuid=c85457cf-... inPushedSet=false            ← 宿主推的那一轮
[ev] 415ms system/task_started uuid=f3021563-... task_id=bn062v6el task_type=local_bash
[ev] 457ms result uuid=1b5b48f7-...                                    ← 第 1 轮结束（此后不再推入）
[ev] 458ms command_lifecycle command_uuid=3ede4498-... inPushedSet=true
[host] first result at 458ms; creating trigger in 500ms; NO further input pushed.
[host] trigger created at 958ms
[ev] 1036ms system/task_updated        uuid=91706cc5-... task_id=bn062v6el
[ev] 1036ms system/task_notification   uuid=6481b8d2-... task_id=bn062v6el status=completed
[ev] 1066ms system/init                uuid=70aa2591-... inPushedSet=false   ← CLI 自己开的轮
[ev] 1078ms result                     uuid=61f63674-... inPushedSet=false   ← 无 command_lifecycle 伴随
```

读数（SDK 路，同为 `[ev]` 逐字，另附 Stop hook 每次输入的键）：

```
[ev] 299ms system/init        uuid=25971db1-... (宿主推的第 1 轮)
[ev] 308ms assistant          uuid=f30e809d-... (tool_use:Bash(run_in_background))
[ev] 356ms system/task_started uuid=682bfbc7-... task_id=b7gl0o1l0 task_type=local_bash
[ev] 372ms result             uuid=7955e636-...
[probe] first result at 372ms; creating trigger in 500ms; NO further input pushed.
[probe] trigger created at 873ms
[ev] 977ms system/task_updated     uuid=eb2763ae-... task_id=b7gl0o1l0 patch.status=completed
[ev] 978ms system/task_notification uuid=9496ae19-... task_id=b7gl0o1l0 status=completed
[ev] 980ms system/init             uuid=696a6a25-... inPushedSet=false   ← CLI 自己开的轮
[ev] 985ms assistant               uuid=17f505b4-... text="ack 4"
[ev] 986ms result                  uuid=a77a0813-... origin={"kind":"task-notification"}
Stop hook（options.hooks.Stop）调用 2 次，输入的全部键：
  ["session_id","transcript_path","cwd","permission_mode","hook_event_name","stop_hook_active",
   "last_assistant_message","background_tasks","session_crons"]   ← 无 prompt_id、无 effort
  #1（第 1 轮末，429ms）background_tasks=[{"id":"bbk6km02l","type":"shell","status":"running",
      "description":"watch for trigger file","command":"while [ ! -f … ]; do sleep 0.1; done; echo …"}]
      session_crons=[]
  #2（无人轮末，1070ms）background_tasks=[]  session_crons=[]
```

读数（`command_lifecycle` / `command_uuid` 的两条路对照）：

```
raw 路：command_lifecycle 共 3 条，全部 command_uuid=3ede4498-...（= 宿主推入帧的 uuid）⇒ 未被推入过的共 0 条
        CLI 自己开的轮：0 条 command_lifecycle
SDK 路：command_lifecycle 0 条（`grep -rn "command_lifecycle" node_modules/@anthropic-ai/claude-agent-sdk/` 亦 0 命中
        —— 该 subtype 不经 SDK 的 query() 出来）
两路的 user 事件里带 origin 的只有无人轮 result 那一条（origin.kind="task-notification"），即 origin 只在 result 上出现
工具表（system/init.tools，25 个）：Task, AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit,
  EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, NotebookEdit, Read, ScheduleWakeup, Skill,
  TaskCreate, TaskGet, TaskList, TaskOutput, TaskStop, TaskUpdate, WebFetch, WebSearch, Workflow, Write
  ⇒ Monitor **不在**表里（与 9.3 一致；本 build 比 9.3 那次多了 AskUserQuestion/EnterPlanMode/ExitPlanMode 与
  TaskGet/TaskList/TaskOutput/TaskUpdate，少 DesignSync/ListAgents/ReportFindings/SendMessage）
```

**结论（一行）**：后台 Bash 跑完且宿主**不推任何东西**时，CLI **会自己开一轮** —— 三件套是 `system/task_updated` → `system/task_notification`(`status=completed`) → **`system/init`** → `assistant` → `result`（SDK 路 977/978/980/985/986ms，raw 路 1036/1036/1066/–/1078ms），因此 AC-162 的「不开轮 ⇒ 停并交人」分支**不触发**，任务继续；但该轮**没有**任何 `command_lifecycle`（raw 路给了 0 条，SDK 路该 subtype 全滤），故「无人轮识别」不能取 `command_lifecycle started` 的 uuid —— 可用的识别面是**这一轮自己的开启事件 `system/init` 的 uuid**（宿主从未推过，`inPushedSet=false`）加上「流里出现轮边界时宿主手上没有在飞轮」这个结构事实；触发类型则可对账 **Stop hook 的 `background_tasks`**（上表两次输入的原始行就是权威清单，`type=shell`/`status` 与在飞任务对得上）。这一条差异需要在 AC-162 里改措辞（`command_lifecycle started` → 无人轮的开启事件），属"由人改判据"的范畴，本条按实测读数落地并在完成记录里逐字登记。

**9.10 跨会话到达：`result.origin.kind="peer"` 的原文形态（AC-164 的触发类型读数）**

取数时间：2026-09-27（判据 `claude-resident-addressable.test.ts` 自身那次运行，三个常驻进程）
claude --version：2.1.283 (Claude Code)

```
被寻址的那个常驻进程（乙）在收到跨会话消息后自己开了一轮，该轮 result 上的 origin 原文：
{"kind":"peer","from":"uds:/run/user/1004/cc-socks/568562.sock","verifiedPeerPid":568562,"verifiedPeerProcStart":"104827810","msg_id":"065a29bd-a164-4c69-8cc2-547870e8e172","name":"ac164-addressable-alpha-5884ac","fromMode":"bypass","body":"AC164-XCROSS hello from the alpha session"}
宿主侧同一轮的读数（判据打印）：run.source=unattended run.trigger=cross-session-message runsBefore=0 runsAfter=1
发送方（甲）这次 SendMessage 的工具结果（mock 端脚本化发出的 tool_use 的执行结果，节选）：
  “AC164 cross-session probe” → ac164-addressable-beta-5884ac (another Claude session on this machine; queued there …)
```

**结论**：跨会话到达在真实二进制上**有可分辨的标记**，因此 AC-164 的触发类型不需要交人改判据。

- 标记是 `result.origin.kind === "peer"`，且**只在这个无人轮自己的 `result` 上**出现：进程自己的任务表（Stop hook 的 `background_tasks` / `session_crons`）里什么也没有——对端发来的一条消息不构成"进程自己持有的工作"，这正是 `cross-session-message` 必须与 `background-task`/`session-cron`/`non-user` 分列的理由，也是 driver 只能在这一轮的**末尾**读触发类型的原因（`claude-host-driver.provider.ts` 的 `finishUnattendedTurn`）。
- `origin` **不重复收件人自己的地址**；`origin.name` 是**发件人**注册的那个地址（上例 `ac164-addressable-alpha-5884ac` 即甲的快照 `peerName`）。这是从乙一侧对甲地址的独立复读；判据不依赖它（甲的地址在快照与甲自己的转录里各读到一次），但它说明这条通道对账得起。
- `origin.body` 是消息正文；`from` 是发件进程的 unix socket 路径、`verifiedPeerPid` / `verifiedPeerProcStart` 是 CLI 对发件进程的核对结果、`fromMode` 是发件会话的权限模式。判据只钉 `kind`，其余字段只做登记——它们不是 AC-164 的承载面。

结论：环境核对：raw 驱动那条腿的实例写的是临时库（/proc/<pid>/environ 已核对）；收尾后本进程的 claude 后代剩 0 个、tmux 里没有本实验的会话、systemd user scope 里没有本实验的单元（读数为空即"无残留"）。 轮次边界：raw 驱动下 session_state_changed **一条都没有**，SDK query() 那条路 同样一条都没有；可用的轮次把手是「每轮一条 system/init + 轮末一条 result」这一对，command_lifecycle 的 queued/started/completed 另外给出每条消息被排进了哪一轮。 忙时推入：priority 三档（later/next/now）都被 CLI 收下并排进 command_lifecycle 的 queued→started 队列（完成后各自 completed；这一条序列就是"队列"的可见形态）；cancel_async_message 的三种时机——仍在队列里→（无响应），已被处理完→（无响应），uuid 不存在→（无响应）。 后台工作的事件面：本实验读到的 subtype 是 task_started、task_notification、background_tasks_changed；工具表里 **没有** Monitor、有 ScheduleWakeup——即常驻会话里"调度"只能靠 cron（CronCreate/CronList/CronDelete 在表里）。 cron 无人轮：发火在流里表现为 CLI **自己造** command_uuid 的 command_lifecycle started（该 uuid 从未 queued——宿主没推过它，共 0 条），它**没有** origin 字段、**没有** scheduled_task_fire、也**不**在 transcript 里新造 user 帧（全部 4 条 user 事件里带 origin 的只有 0 条）；无人轮自身的取数只能靠 Stop hook——session_crons 在 2 次调用里 2 次非空，background_tasks 1 次非空，这就是 §10 要的权威清单（字段与在飞任务都能对上）。 需要人回应的入口：side_question（宿主→CLI 的控制请求，宿主问、CLI 答）**没有响应**，方向与 canUseTool（CLI 问、宿主答）相反；elicitation **读到了 1 条**（MCP 工具把问题转成控制请求交给宿主）；request_user_dialog 只出现在 SDK 的类型联合里，本实验没有触发它的入口（工具驱动的阻塞对话框要有对应的工具在场），属读数缺口。 flag settings 层：两个变体的 `get_settings` 响应里，`remoteControlAtStartup` 分别为 （没读到） 与 （没读到），`isolatePeerMachines` 分别为 （没读到） 与 （没读到）——即全是"没读到"，**不能**据此说 `--settings` 盖过了用户 settings（那是读数缺口，不是证据）；方案据此走**最保守分支**：不等这个读数，检测到 Remote Control 已开启就拒绝以 bypass 启动常驻进程，并在界面说明（见 §9）；两个变体都**没有**把 `/v1/messages` 之外的流量发给 mock 端点，说明关掉它之后不会再有第二个"控制面"连接（本机没有可用的 Remote Control 后端，开着的那个也无法在此环境里连线，故"开着会怎样"只取到设置层的读数）。 交互式 CLI 的忙时输入：第二条消息落在**后一轮**（排在当前轮之后，不并入）。这一条与 E2/E3 的 stream-json 形态**一致**（都是"另起一轮"），§8 的忙时基准因此对两种形态都成立；但它精确对应三档里的哪一档，本实验**定不了**——9.2 里 `next` 那一档在排队时被撤掉了、没读到它执行时的落点，而 9.2 又显示"后一轮"这个落点对 `now` 与 `later` 都成立，光看落在哪一轮分不开三档；要定档得补一次不取消 `next` 的读数（缺口记在 proposal §8）。

