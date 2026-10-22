---
id: AC-256
title: 嵌套冒烟的记录齐全：独立实例上用终端 Claude Code 驱动真实会话，每一节都有原始读数与结论
status: achieved
kind: criterion
goal: GOAL-020
criterion: for f in scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs
  docs/proposals/cloudcli-mcp-smoke.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2;
  exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node
  scripts/mcp-smoke.mjs --check-record docs/proposals/cloudcli-mcp-smoke.md
expect: 做法照 AC-170 与 scripts/resident-smoke.mjs：脚本起一个真服务进程（临时
  DATABASE_PATH、HOST=127.0.0.1、端口不是 3001，杀整个进程组），真实 Claude CLI 与一个临时项目，由终端里的
  Claude Code 通过 `claude mcp add --transport http` 加上 PAT
  后用自然语言驱动。记录文件必须逐节齐全，每节有「读数：」与「结论：」两行且读数非空：环境与版本；起独立实例（端口、DATABASE_PATH 临时、不等于
  3001）；Claude Code 握手与工具列表；列出会话；发消息（run 出现在运行中列表、来源为 mcp）；查进度（run_get）；中止（常驻
  pid 不变）；收尾残留（进程、目录、scope 均为 0，生产 3001 的监听 pid 与起点读数相同）。`--check-record`
  逐节检查并点名缺哪节；脚本本身有单测覆盖「缺一节就红」。本判据只证明读数齐全，验收结论由下一条人工关卡给出。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）：(i) 删掉记录里任一节 ⇒ `--check-record` 必须红并点名该节；(ii) 把端口记成 3001 ⇒
  必须红；(iii) 把某节读数留空 ⇒ 必须红。（红先行）当前必红：判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: docs/proposals/mcp-gateway-SPEC.md（v3.1）。人 yale 2026-10-05 指令：创建并激活
  GOAL-020 至 GOAL-022 及其 AC。
activatedAt: 2026-10-05T02:17:26.296Z
statusLog:
  - at: 2026-10-05T02:17:26.296Z
    from: draft
    to: active
    actor: goal-driver
    reason: "triage: activate"
  - at: 2026-10-05T22:07:48.229Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-05T02:17:26.295Z
---
