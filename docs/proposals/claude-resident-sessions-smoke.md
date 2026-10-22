# Claude 常驻会话 API 面真模型冒烟记录（AC-170）

本文件由 `scripts/resident-smoke.mjs` 写入：六节各含**原始**读数（宿主快照、pid、`result` 计数、
`seq`、关闭原因、重启后的新 pid）与一行结论。`node scripts/resident-smoke.mjs --check-record <本文件>`
逐节检查 `读数：`/`结论：` 是否齐全。

**「冒烟验收：通过」那一行只能由人 yale 写入，执行者不得代写。** 执行者只写 `读数：` 与 `结论：` 行。

冒烟验收：通过（人 yale，2026-09-27，六段读数与版本/用量/残留读数已逐段核对，认可）

## 环境与版本

读数：claude --version = 2.1.283 (Claude Code)；SDK = @anthropic-ai/claude-agent-sdk 0.3.165；费用/用量：真模型轮次 = 3 轮 + 1 无人轮，全程 18s，本次转录里 assistant 行 16 条（转录 1 份）；转录 message.usage 汇总 input_tokens=39048 output_tokens=892 cache_read_input_tokens=247808；WS 上 token_budget 帧 16 条，末条逐字 {"used":18456,"total":160000,"inputTokens":18456,"outputTokens":0,"cacheReadTokens":17664,"cacheCreationTokens":0,"cacheTokens":17664,"breakdown":{"input":18456,"output":0}}；GET /api/providers/sessions/<id>/token-usage 应答 404 {"success":false,"error":{"code":"SESSION_FILE_NOT_FOUND","message":"Session file for \"86f50a70-ad29-4a3f-8e65-42d30e05b8a1\" was not found."}}；USD 一栏：本机网关只回 token 用量、不回金额（上面几个来源里没有任何 USD 字段），故逐字写「未上报」，不折算。残留与生产面（收尾后读数）：临时根 /data/home/yale/tmp/resident-smoke-live-1790510665 上 pgrep-命中=0 environ-命中=0 scope-命中=0；:3001 终点读数 listener-pid=4065026 systemd-main-pid=4065001（与首行起点读数同值即未被动过）。
结论：版本与用量来自本机 CLI/SDK 与本次运行的 provider 转录；USD 未上报是网关的实测面，不是漏读。残留读数取自**收尾之后**——收尾之前取的话命中的永远是那几个还开着的服务进程。


## 创建常驻会话

读数：sessionId=86f50a70-ad29-4a3f-8e65-42d30e05b8a1 lifecycle_mode=resident host.state=idle host.mode=resident pid=2597138 running=true reason=null 第一轮 terminal.kind=complete seq=13；proc-environ[2596428] DATABASE_PATH=/data/home/yale/tmp/resident-smoke-live-1790510665/auth.db | HOST=127.0.0.1；port=20739（≠ 3001）；额外读数 (POST /start 在已有活宿主时=200 pid=2597138)
结论：宿主快照逐字 lifecycle_mode=resident、running=true，常驻宿主已带 pid=2597138 出现（进程由第一轮的 run entry 起——/start 起不了常驻进程，见本节读数里的额外读数）。


## 连续三轮

读数：pid=2597138 results=3；三轮终止帧 seq=[13, 13, 13]；三轮读回的 pid=[2597138, 2597138, 2597138]（集合大小 1）；每轮终止帧 kind=[complete, complete, complete]；proc-environ[2596428] DATABASE_PATH=/data/home/yale/tmp/resident-smoke-live-1790510665/auth.db | HOST=127.0.0.1；port=20739（≠ 3001）
结论：同一个 pid=2597138 连做三轮，终止帧恰好 3 条——三轮没有各起一个进程。


## 无人轮

读数：终止帧 seq=52 触发类型=background-task 晚到听众：挂上时 isProcessing=true run.lastSeq=3（这 3 条是订阅时回放给它的）→ 一路收到 52 帧，seq=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, …]（逐轮重开，首帧 seq=1）；早先那条常驻 chat 听众本轮收到 0 帧（应为 0：无人轮的 writer 以 `connection: null` 起，听众集初始为空，它只进回放缓冲）；source=unattended（推导：本段没有发出任何 chat.send，这一轮是常驻进程自己开出来的——它的 writer 没有起手 socket，这正是 unattended/scheduled 与 user 轮的结构差别；触发类型 background-task 读自 /desktop-notifications 的 run.background_completed 帧；ChatRun.source 只在进程内、从不上线，故此处为推导而非线上字段）
结论：无人轮真的发生：一条**不是它起手**的听众在它跑着时挂上，先后拿到回放的 3 帧与直播，直到终止帧 seq=52；触发类型=background-task，本轮共 52 帧。


## 关闭

读数：pid=2597138 /proc/2597138 消失 closeReason=user host.state=closed
结论：关闭原因逐字 user，且进程 2597138 确实退出（/proc 消失）。


## 重启后已关闭

读数：server-old-pid=2596678 server-new-pid=2601664 running=false reason="No resident host is running for this session; the last server stop or restart dropped it." 正控制 per-run sessionId=35354cdd-2f2a-4348-ba94-305f14dcc18d reason=null lifecycle_mode=resident
结论：换了另一个服务进程（2596678 → 2601664）后读回「未运行」且原因非空，同一读里 per-run 会话的 reason 为 null（该字段不是恒真）。


## 再次发送重新拉起

读数：old-pid=2597138 new-pid=2602171 host.state=idle
结论：再次发送后拉起了新 pid=2602171（≠ 第一段的 2597138），不是复用死进程。


