# CloudCLI MCP 网关嵌套冒烟记录（AC-256）

本文件由 `scripts/mcp-smoke.mjs` 写入：八节各含**原始**读数与一行结论。读数来自一次真跑——真服务
实例（临时 `DATABASE_PATH`、`HOST=127.0.0.1`、端口 `listen(0)` 探得且 ≠ 3001）+ 一个真 PAT +
终端里的 Claude Code（`claude mcp add --transport http`）+ 临时项目。
`node scripts/mcp-smoke.mjs --check-record <本文件>` 逐节检查 `读数：`/`结论：` 是否齐全、读数是
否为空、以及「起独立实例」一节记录的端口不是 3001。

**人证行（AC-257）只能由人 yale 写入，执行者不得代写。** 执行者只写 `读数：` 与 `结论：` 行。

## 环境与版本

读数：claude --version = 2.1.289 (Claude Code)；@modelcontextprotocol/sdk 1.29.0；node v24.21.0；模型 id = v4.1flash；:3001 起点读数 listener-pid=537272 systemd-main-pid=537272。（版本与残留读数在末节汇总。）
结论：本节放版本与端口基线；八段读数在下面各节。

## 起独立实例

读数：port=5683；proc-environ[1171171] DATABASE_PATH=/tmp/ac256-run4/auth.db | HOST=127.0.0.1 | MCP_ENABLED=1；DATABASE_PATH 落在临时根 /tmp/ac256-run4 下；HOST=127.0.0.1；端口由 listen(0) 探得且不等于 3001（受保护端口）；进程以 detached:true 起、收尾按负 pid 杀整组（leaderPid=1171171）；PAT=ccp_b04e…（userId=2）；应用 JWT 由 mint-token 对**同一个临时库**签出。
结论：真服务进程在 127.0.0.1:5683 上应答，库在临时根下、MCP_ENABLED=1 已生效；全程不碰 3001。

## Claude Code 握手与工具列表

读数：claude mcp add 逐字命令：claude mcp add --transport http cloudcli http://127.0.0.1:5683/mcp --header "Authorization: Bearer ccp_b04e55c613b048e9382f3548fbe4192f4285528320d47e891ebcb04acafcab1e" --scope project；退出码 0；写出 /tmp/ac256-run4/project/.mcp.json；tools/list 共 17 件，逐字：approval_answer, approvals_list, overview, projects_list, quay_snapshot, run_get, session_background, session_cancel_queued, session_close, session_create, session_get, session_interrupt, session_read, session_reconfigure, session_send, session_start, sessions_list；MCP SERVER_INFO name=claudecodeui-mcp-gateway；入站面 http://127.0.0.1:5683/mcp（PAT ccp_b04e…，Bearer）。
结论：终端 Claude Code 已把 cloudcli 条目写进临时项目的 .mcp.json；MCP 客户端握手成功并读到 17 件工具（含 session_send / run_get / session_interrupt）。

## 列出会话

读数：临时项目 /tmp/ac256-run4/project；sessionId=a88bafcd-f69d-4850-9e28-2b014a685b17 lifecycle_mode=resident；常驻宿主 pid=1175777（由 WS run entry 起）；session_reconfigure isError=false 返回逐字 {"ok":true,"session":"a88bafcd-f69d-4850-9e28-2b014a685b17","stored":{"permissionMode":"bypassPermissions"},"applied":"next-turn","liveSupported":true,"message":"该 provider 的在线重配置未生效（没有可用的实时宿主），改动将在下一轮生效。"}；清场 session_interrupt isError=false 返回逐字 {"aborted":true}、run 离开运行中列表=true；正控制：非 MCP run（WS chat.send 发起）runId=a7064737-65f2-42f3-82ae-e0d45565ac41 由 chat_subscribed 应答带出（逐字 {"kind":"chat_subscribed","sessionId":"a88bafcd-f69d-4850-9e28-2b014a685b17","isProcessing":true,"lastSeq":0,"pendingPermissions":[],"bootId":"133d1c15-f247-454a-b964-4d61683b9d50","rev":0,"heartbeatIntervalMs":5000,"unreachableAfterMs":15000,"phase":"idle","toolName":null,"timestamp":"2026-10-05T16:59:49.951Z","runId":"a7064737-65f2-42f3-82ae-e0d45565ac41"}）；同一 MCP run_get 读到 source="user"（≠ mcp，字段有分辨力）；run_get 原始返回逐字 {"runId":"a7064737-65f2-42f3-82ae-e0d45565ac41","sessionId":"a88bafcd-f69d-4850-9e28-2b014a685b17","source":"user","status":"running","phase":"idle","toolName":null,"activityNote":null,"startedAt":{"relative":"刚刚","iso":"2026-10-05T16:59:49.886Z"},"completedAt":null,"elapsedMs":1123,"bootId":"133d1c15-f247-454a-b964-4d61683b9d50","outcome":"timeout","lastAssistantMessage":null,"note":null,"explanation":null}；终端 Claude Code 的 sessions_list 调用逐字结果（截断 600）：{"sessions":[{"id":"a88bafcd-f69d-4850-9e28-2b014a685b17","title":"Untitled Session","provider":"claude","projectId":"57060983-11a9-4e5e-bdc3-9ef53b7de25f","lifecycleMode":"resident","hostState":"idle","running":false,"lastActivity":{"relative":"刚刚","iso":"2026-10-05T16:59:50.000Z"}}],"total":1}
结论：终端 Claude Code 用自然语言被驱动着调了 sessions_list，返回里逐字含临时会话 id=a88bafcd-f69d-4850-9e28-2b014a685b17。正控制成立：同一个 run_get 对 WS 发起的 run 读到 source="user"（≠ mcp），来源字段有分辨力。

## 发消息

读数：session_send 返回逐字 {"runId":"ce4eff52-fafc-4918-a93e-9ba850e95272","queued":false,"queuedMessageUuid":null,"source":"mcp"}；GET /api/providers/sessions/running 命中该会话逐字 {"sessionId":"a88bafcd-f69d-4850-9e28-2b014a685b17","provider":"claude","startedAt":1791219597366,"lastSeq":8}（该路由本身不带 source 字段，来源按 MCP 面读：session_send.source="mcp"）；正控制：非 MCP run（WS chat.send 发起）runId=a7064737-65f2-42f3-82ae-e0d45565ac41 由 chat_subscribed 应答带出（逐字 {"kind":"chat_subscribed","sessionId":"a88bafcd-f69d-4850-9e28-2b014a685b17","isProcessing":true,"lastSeq":0,"pendingPermissions":[],"bootId":"133d1c15-f247-454a-b964-4d61683b9d50","rev":0,"heartbeatIntervalMs":5000,"unreachableAfterMs":15000,"phase":"idle","toolName":null,"timestamp":"2026-10-05T16:59:49.951Z","runId":"a7064737-65f2-42f3-82ae-e0d45565ac41"}）；同一 MCP run_get 读到 source="user"（≠ mcp，字段有分辨力）；run_get 原始返回逐字 {"runId":"a7064737-65f2-42f3-82ae-e0d45565ac41","sessionId":"a88bafcd-f69d-4850-9e28-2b014a685b17","source":"user","status":"running","phase":"idle","toolName":null,"activityNote":null,"startedAt":{"relative":"刚刚","iso":"2026-10-05T16:59:49.886Z"},"completedAt":null,"elapsedMs":1123,"bootId":"133d1c15-f247-454a-b964-4d61683b9d50","outcome":"timeout","lastAssistantMessage":null,"note":null,"explanation":null}
结论：终端 Claude Code 自然语言驱动 session_send，runId=ce4eff52-fafc-4918-a93e-9ba850e95272 立刻返回且 source 逐字 mcp；同一读里该 run 出现在运行中列表；正控制成立：同一 run_get 对非 MCP run 读到 source="user"（≠ mcp）。

## 查进度

读数：run_get(runId=ce4eff52-fafc-4918-a93e-9ba850e95272, waitSeconds=1) 返回逐字 {"runId":"ce4eff52-fafc-4918-a93e-9ba850e95272","sessionId":"a88bafcd-f69d-4850-9e28-2b014a685b17","source":"mcp","status":"running","phase":"tool","toolName":"Bash","activityNote":null,"startedAt":{"relative":"刚刚","iso":"2026-10-05T16:59:57.366Z"},"completedAt":null,"elapsedMs":5633,"bootId":"133d1c15-f247-454a-b964-4d61683b9d50","outcome":"timeout","lastAssistantMessage":null,"note":null,"explanation":null}
结论：终端 Claude Code 自然语言驱动 run_get，按 runId 查到了同一个 run（source="mcp"，status="running"）。

## 中止

读数：session_interrupt 返回逐字 {"aborted":true}；中止后该会话从 GET /api/providers/sessions/running 消失=true；常驻进程 pid 中止前=1175777、中止后=1175777（相同即未换进程）；宿主 state 中止后="idle"、mode="resident"。
结论：终端 Claude Code 自然语言驱动 session_interrupt，aborted=true；常驻进程 pid 前后不变（1175777）。

## 收尾残留

读数：临时根 /tmp/ac256-run4：pgrep-命中=0、/proc environ-命中=0、systemctl --user scope-命中=0（三条都要求 0；前两条只认本次冒烟子树内的进程，argv/env 里恰好含临时根串的旁观进程不计——否则「把日志路径写进命令行的观察者」会被读成残留）；:3001 起点读数 listener-pid=537272 systemd-main-pid=537272；:3001 终点读数 listener-pid=537272 systemd-main-pid=537272（与起点逐字相同即监听 pid 与 systemd MainPID 都没被动过）；全程未连接 / 未启用 / 未重启 3001。
结论：收尾后三条残留命中均为 0，3001 的监听 pid 与 systemd MainPID 起点终点逐字相同。

## 人证行（AC-257）

嵌套冒烟验收：通过 —— 裁定人：yale，2026-10-06。裁定依据为上列八节承重读数（独立实例 port=5683 ≠ 3001；发消息 run 来源逐字 `mcp`；`run_get` 按 runId 命中；`session_interrupt` 前后常驻 pid 1175777 不变；收尾残留三条命中全 0；`:3001` 监听 pid 与 systemd MainPID 起终点逐字相同）。本行由受权会话代录，**裁定本身出自人 yale**。


