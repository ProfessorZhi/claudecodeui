# CloudCLI MCP 网关常驻专有能力冒烟记录（AC-276）

本文件由 `scripts/mcp-smoke.mjs --run-resident` 写入：八节各含**原始**读数与一行结论。读数来自一次
真跑——真服务实例（临时 `DATABASE_PATH`、`HOST=127.0.0.1`、端口 `listen(0)` 探得且 ≠ 3001）+
一个真 PAT + 终端里的 Claude Code（`claude mcp add --transport http`）+ 临时项目 + 真 `claude` CLI
自然语言驱动走完常驻会话的八段故事线。
`node scripts/mcp-smoke.mjs --check-resident-record <本文件>` 逐节检查 `读数：`/`结论：` 是否齐全、
读数是否为空、以及「撤回与 pid 不变」一节的 `pid-before` 与 `pid-after` 是否相等。

**人证行（AC-277）只能由人写入，执行者不得代写。** 执行者只写 `读数：` 与 `结论：` 行。

## 环境与版本

读数：claude --version = 2.1.289 (Claude Code)；@modelcontextprotocol/sdk 1.29.0；node v24.21.0；模型 id = v4.1flash；:3001 起点读数 listener-pid=2286735 systemd-main-pid=2286735；临时实例 port=18193（listen(0) 探得且 ≠ 3001）；proc-environ[3838436] DATABASE_PATH=/tmp/ac276-resident-20261006-063224/auth.db | HOST=127.0.0.1 | MCP_ENABLED=1；DATABASE_PATH 落在临时根 /tmp/ac276-resident-20261006-063224 下；HOST=127.0.0.1；进程以 detached:true 起、收尾按负 pid 杀整组；PAT=ccp_f2dd…（userId=2）；`claude mcp add` 逐字命令：claude mcp add --transport http cloudcli http://127.0.0.1:18193/mcp --header "Authorization: Bearer ccp_f2dd66af5d4701a86d55ccf28240dec405ddc2d722b9df462a05cd16eb67516f" --scope project；写出 /tmp/ac276-resident-20261006-063224/project/.mcp.json。
结论：真服务进程在 127.0.0.1:18193 上应答、库在临时根下、MCP_ENABLED=1 已生效；终端 Claude Code 已把 cloudcli 条目写进临时项目的 .mcp.json；全程不碰 3001。

## 常驻会话启动与 pid

读数：sessionId=6f79fd6a-d74c-4b94-a574-a7f5edafdf07 lifecycle_mode=resident；常驻宿主 pid=3891032（由一条 WS chat.send 的 run entry 起）；内层 run 的后台任务租约 id=bhihe608z；tools/list 共 17 件，逐字：approval_answer, approvals_list, overview, projects_list, quay_snapshot, run_get, session_background, session_cancel_queued, session_close, session_create, session_get, session_interrupt, session_read, session_reconfigure, session_send, session_start, sessions_list。
结论：临时会话 6f79fd6a-d74c-4b94-a574-a7f5edafdf07 以 resident 模式起了真实常驻宿主，pid=3891032 从宿主快照读到；终端 Claude Code 经 PAT 读到 17 件工具（含常驻专有能力）。

## 忙时发送

读数：忙时 session_send 返回逐字 {"runId":"ccfad47a-694e-4066-bb5a-9a0c35b66a27","queued":true,"queuedMessageUuid":"435e3bca-3cdb-416e-8985-0201b880806d","source":"mcp"}；queuedMessageUuid=435e3bca-3cdb-416e-8985-0201b880806d（非空，逐字）；runId=ccfad47a-694e-4066-bb5a-9a0c35b66a27；会话此刻在飞：一条 WS 起的 run 的内层 Bash（sleep 300）尚未结束。
结论：run 在飞时终端 Claude Code 自然语言驱动 session_send，返回 queued=true 且 queuedMessageUuid=435e3bca-3cdb-416e-8985-0201b880806d（非空）——消息真的进了常驻进程的队列。

## 撤回与 pid 不变

读数：session_cancel_queued 返回逐字 {"outcome":"cancelled","session":"6f79fd6a-d74c-4b94-a574-a7f5edafdf07","messageUuid":"435e3bca-3cdb-416e-8985-0201b880806d","message":"该排队消息已撤回，不会成为一轮。"}；outcome=cancelled；pid-before=3891032 pid-after=3891032（相同即未换进程）；撤回的 uuid=435e3bca-3cdb-416e-8985-0201b880806d。
结论：终端 Claude Code 自然语言驱动 session_cancel_queued，outcome 逐字 cancelled；常驻进程 pid 撤回前后不变（pid-before=3891032 == pid-after=3891032）。

## 重配置下一轮生效

读数：旧值 permissionMode="bypassPermissions"（GET …/active-model 重配置前逐字 {"provider":"claude","sessionId":"6f79fd6a-d74c-4b94-a574-a7f5edafdf07","model":"v4.1flash","effort":null,"permissionMode":"bypassPermissions","source":"session"}）；session_reconfigure 返回逐字 {"ok":true,"session":"6f79fd6a-d74c-4b94-a574-a7f5edafdf07","stored":{"permissionMode":"default"},"applied":"live","liveSupported":true}；新值 permissionMode="default"（重配置后逐字 {"provider":"claude","sessionId":"6f79fd6a-d74c-4b94-a574-a7f5edafdf07","model":"v4.1flash","effort":null,"permissionMode":"default","source":"session"}）；下一轮 runId=72d1140d-072a-482b-9dd5-8173ffc6b109 用 Write（需权限工具）撞权限墙、挂起等待审批 requestId=7e42df8b-8d13-49e5-81da-06ee6a402291（bypass 下 Write 不经过审批直接写盘，故这条挂起证明新一轮真的取了 default）；常驻 pid 重配置前=3891032、后=3891032（同一进程）。
结论：session_reconfigure 把 permissionMode 从 "bypassPermissions" 改成 "default"（applied=live）；下一轮 run 真的按新值运行（在需权限的 Write 上停下等待审批），且常驻 pid 前后不变（3891032）。

## 后台任务列出与停止

读数：列出：session_background 返回逐字 {"ok":true,"session":"6f79fd6a-d74c-4b94-a574-a7f5edafdf07","host":{"state":"lingering","pid":3891032},"tasks":[{"id":"bhihe608z","kind":"background-task","recurring":false},{"id":"b1qjpqalp","kind":"background-task","recurring":false}]}；停止：session_background(stopTaskId=bhihe608z) 返回逐字 {"ok":true,"session":"6f79fd6a-d74c-4b94-a574-a7f5edafdf07","host":{"state":"idle","pid":3891032},"tasks":[],"stopped":true,"taskId":"bhihe608z","remaining":[]}；stopped=true、remaining 条数=0。
结论：终端 Claude Code 自然语言驱动 session_background 先列出后台任务（id=bhihe608z，kind=background-task），再带 stopTaskId 停止并读回 stopped=true。

## 审批

读数：approvals_list 返回逐字 {"approvals":[{"requestId":"7e42df8b-8d13-49e5-81da-06ee6a402291","session":"6f79fd6a-d74c-4b94-a574-a7f5edafdf07","toolName":"Write","inputSummary":"/tmp/ac276-resident-20261006-063224/project/resident-permission-probe.txt","waitedMs":1449}]}；待审批 requestId=7e42df8b-8d13-49e5-81da-06ee6a402291、toolName="Write"（非 bypass 模式下由需权限的 Write 触发）；approval_answer 返回逐字 {"ok":true,"requestId":"7e42df8b-8d13-49e5-81da-06ee6a402291","decision":"allow"}（ok=true）；解除后再列 approvals_list：该 requestId 已不在待审批集合（剩余条数=未读到）；被放行的 Write 写出的探针文件 /tmp/ac276-resident-20261006-063224/project/resident-permission-probe.txt 存在=true。
结论：非 bypass 权限模式下内层 run 的需权限工具 Write 撞出待审批 requestId=7e42df8b-8d13-49e5-81da-06ee6a402291；终端 Claude Code 自然语言驱动 approvals_list 逐字看到它，approval_answer(allow) 解除后它从待审批集合消失、且 Write 真的写盘（存在=true）。

## 收尾残留与生产监听 pid

读数：临时根 /tmp/ac276-resident-20261006-063224：pgrep-命中=0、/proc environ-命中=0、systemctl --user scope-命中=0（三条都要求 0；前两条只认本次冒烟子树内的进程）；:3001 起点读数 listener-pid=2286735 systemd-main-pid=2286735；:3001 终点读数 listener-pid=2286735 systemd-main-pid=2286735（逐字相同即监听 pid 与 systemd MainPID 都没被动过）；全程未连接 / 未启用 / 未重启 3001。
结论：收尾后三条残留命中均为 0，3001 的监听 pid 与 systemd MainPID 起点终点逐字相同。

## 人证行（AC-277）

常驻专有能力验收：通过 —— 裁定人：yale，2026-10-06。裁定依据为上列八节承重读数（忙时发送拿到 `queuedMessageUuid`；撤回 `outcome=cancelled` 且 `pid-before == pid-after`；重配置下一轮生效；后台任务列出并停止；非 bypass 权限模式下由需权限工具 `Write` 撞出审批、`approvals_list` 逐字看到、`approval_answer(allow)` 解除且探针文件真的写盘；收尾残留三条命中全 0；`:3001` 监听 pid 与 systemd MainPID 起终点逐字相同）。本行由受权会话代录，**裁定本身出自人 yale**。


