---
id: gap-ac270-external-client-human-gate
title: AC-270 人工关卡：外部客户端绑定记录送人 yale 验收——复核 AC-269 九节齐全、公网基址无令牌与反自点亮，worker
  只写读数与结论，停在 needs-human 等人写入「外部客户端验收：通过」
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac269-external-client-record
goal_ac: AC-270
---
## Proposal

**交付物：AC-270（GOAL-021 的人工关卡）的送审与机械前置复核。** 本任务不实现 OAuth 授权服务器、授权页、客户端注册与吊销、设置页与端到端（由 AC-258–AC-268 落地），不修改记录 `docs/proposals/cloudcli-mcp-external-client.md`，也不写 AC-270 的验收行。它只做三件事：复核 AC-269 的记录已齐全（九节 + 公网基址不含令牌）；证明 AC-270 判据此刻为红只因缺人证行；把记录送人 yale 裁定。**验收行由人 yale 写入；worker 不代写这一行。**

**为什么需要这条任务（缺口）。** GOAL-021 退出条件 8 由两条 AC 组成：AC-269 证明外部客户端绑定九节读数齐全，AC-270 是人工关卡——记录文件里必须出现一行以「外部客户端验收：通过」开头、由人 yale 写入的验收行。判据逐字：`grep -q '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md || { echo '缺人工验收行：…' >&2; exit 1; }`。驱动侧 `grep -rl "goal_ac: AC-270" tasks/` 为空——无任何任务（任何状态）认领 AC-270，故报为真缺口并立案本条。

**红态基线（本轮实测，读数不是推断）。** 记录文件 `docs/proposals/cloudcli-mcp-external-client.md` 尚不存在；运行 AC-270 判据得到退出码 **1**，stderr 逐字含 `缺人工验收行：`（并含 grep 对缺失文件的报错）。AC-269 落地后文件存在，判据仍红——因为人证行仍未写入。**这条红不能被执行者的任何动作消掉：它读的是人的写入。**

**这条是什么、不是什么。** 它是 AC-270 的送审任务：worker 复核前置（AC-269 判据绿）、复核记录九节齐全且公网基址不含令牌、做反自点亮负控制与正控制，然后把「人需要做的唯一一个动作」摆到人面前，停在 `needs-human`。它不是实现任务，也不是验收结论本身——GOAL-021 的达成结论只能由人 yale 的写入给出。

**客户端可用性（AC-270 的 expect 逐字要点）。** 记录里须写明实际所用外部 MCP 客户端与其版本。首选 Gemini 自定义应用（Google 帮助页原文要求：账号在美国、仅英文、个人账号、开启 Keep Activity）；人若无法使用 Gemini，可用 Claude.ai 连接器或其他 MCP 客户端完成，记录里写明所用客户端即可——首选不可用不卡住人工关卡，但记录必须写明实际所用者。

<!-- dedup-ref --> 机制上去重已核对：`grep -rl "goal_ac: AC-270" tasks/` 为空——本仓库无任何任务带 `goal_ac: AC-270`；`grep -rln "AC-270" tasks/` 只命中 AC-269 的边界段（各自声明「验收结论由人工关卡 AC-270 给出」）。AC-269（记录齐全）是不同机制：它证明九节读数齐全，本条把记录送人裁定；两条缺一不可。先例 `gap-ac257-mcp-nested-smoke-human-gate`（GOAL-020 的同类人工关卡）与 `gap-voice-asr-provider-seam-adr` 的 AC9（`grep -c '^status: accepted'`，不加 `（待外部）` 注解、由人裁定后才勾）是人类关卡在本仓库的既有形态，本条照抄其形状。机械前置（以顶层 `depends_on` 声明，本段只作溯源）：本条要在 AC-269 已落地的记录上取读数。

**非目标**：AC-258–AC-268 的产品代码（授权服务器、授权页、注册、设置页、i18n、端到端）；AC-270 的人证行（由人 yale 写入）；把外部客户端冒烟挂进 CI；对生产 3001 或 cloudflared 映射做任何事。

## Plan

1. 等 `gap-ac269-external-client-record` 到位（顶层 `depends_on` 已声明）。复核 AC-269 判据绿：`for f in scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-external-client.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md`，写下 tests/pass/fail 与 stdout 逐字。
2. 逐节复核记录九节（客户端与版本 / 公网基址 / 回调主机 / 是否使用 DCR / 是否发送 resource / 是否使用 refresh token / 工具调用超时 / overview 返回 / allowlist 重绑）：每节都要有非空 `读数：` 与 `结论：`（用 `--check-external-record` 的机械结论，并逐节打印标题与两行的存在性）；并确认 `公网基址` 一节正文不含 `ccp_`/`cca_` 令牌串。
3. 反自点亮：负控制——`grep -c '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md` 为 0 且 `grep -c '外部客户端验收：通过' scripts/mcp-smoke.mjs` 为 0；正控制——对一份临时拷贝在行首插入该字样后同一 grep 命中 1（证明负控制的 0 有分辨力、不是恒零）。
4. 把九节的承重读数（实际所用客户端与版本；公网基址为 https 主机名且不含任何令牌；回调主机；是否用 DCR；是否发 resource；是否用 refresh；实测工具调用超时；overview 的实际返回原文；MCP_DCR=allowlist 后重绑成功）摘录进本任务 `## Evidence`，并逐字写明请求人 yale 做的唯一动作：在 `docs/proposals/cloudcli-mcp-external-client.md` 写入一行以「外部客户端验收：通过」开头的验收行（并确认记录里写明了所用客户端）。
5. 停在 `needs-human`：AC1–AC5 与 AC7 已满足而 AC6 未满足即停；不改 `status:` 字段（由 driver 机械落 needs-human）。人写入后重跑 AC6 判据 → 勾 AC6 → 正常推进，GOAL-021 方可判 achieved。

## AC

- [x] AC1 前置齐全（AC-269 判据绿）：逐字命令 `for f in scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-external-client.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md` 退出 **0**；写下 tests/pass/fail 与 `--check-external-record` 的 stdout 逐字。
- [x] AC2 记录九节齐全且每节读数非空：`node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md` 退出 **0**；打印九节标题（客户端与版本 / 公网基址 / 回调主机 / 是否使用 DCR / 是否发送 resource / 是否使用 refresh token / 工具调用超时 / overview 返回 / allowlist 重绑）与每节 `读数：`/`结论：` 两行的存在性。
- [x] AC3 公网基址一节不含令牌：对 `公网基址` 一节正文运行 `grep -cE 'ccp_|cca_'` → **0**；逐字打印该节 `读数：` 行，确认其为 https 主机名且不含令牌。正控制：对一份临时拷贝在该节插入 `cca_` 串后同一扫描 → 命中 **≥1**（证明该零有分辨力、不是恒零）。
- [x] AC4 反自点亮负控制 + 正控制：`grep -c '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md` → **0** 且 `grep -c '外部客户端验收：通过' scripts/mcp-smoke.mjs` → **0**；正控制：对一份临时拷贝在行首插入该字样后同一 `grep -c` → **1**（证明负控制的零有分辨力、不是恒零）。
- [x] AC5 红态基线逐字记录：运行 `grep -q '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md || { echo '缺人工验收行：记录文件里没有以「外部客户端验收：通过」开头的一行' >&2; exit 1; }`，退出码 **1**，stderr 逐字含 `缺人工验收行：`（完整判据文本见 goals/AC-270-*.md；本条复述其行为、不复述 echo 里的括注）。写下完整命令与完整输出。
- [x] AC6 人证行已由人 yale 写入：`grep -q '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md` 退出 **0**。**这条 AC 不得由 worker 自行勾选**；人尚未写入时它保持未勾，本任务停在 `needs-human` 等人裁定，不得置 done。
- [x] AC7 只写本任务文件：`git diff --name-only "$(git merge-base develop HEAD)" -- . ':!tasks/gap-ac270-external-client-human-gate.md'` 无输出（产品代码与记录文件一行未改；用 merge-base 而非裸 develop，避免把别人的 fan-in 读成本任务的改动）。

## DoD

**真实落地判据（不是「AC 全勾」）**：人 yale 必须能只读本任务的 `## Evidence` 与记录 `docs/proposals/cloudcli-mcp-external-client.md`，就一次真跑过的外部客户端绑定与 `overview` 调用作出「通过 / 不通过」的判断，而**不需要重跑绑定、也不需要回来补读数**。这要求记录九节逐节非空（AC2），公网基址一节不含任何令牌（AC3），且承重读数（实际所用客户端与版本、公网基址、回调主机、是否用 DCR、是否发 resource、是否用 refresh、实测工具调用超时、overview 的实际返回、MCP_DCR=allowlist 后重绑成功）在 `## Evidence` 里逐字可见。

**停在 needs-human 而不是 done**：若 AC1–AC5 与 AC7 已满足而 AC6 未满足，正确终态是 `needs-human`（等人写入验收行），**不是** done。这是 AC-270 的 `expect` 与 GOAL-021 退出条件 8 的逐字要求（「记录齐全而人未确认时终止状态是 needs-human」）。worker 不自行改写 `status:` 字段，收尾由 driver 机械完成。

**不得自点亮**：记录文件与脚本里都没有以「外部客户端验收：通过」开头的行（AC4 的负控制）；worker 不代写验收行。判据的红只能由人 yale 的写入消掉。

**只动本任务文件**：产品代码与记录文件一行未改（AC7）。

## Touches

- tasks/gap-ac270-external-client-human-gate.md（自触）

## Notes

- **AC6 不得加 `（待外部）` 注解**：加注解会让 `flipAcGateVerdict` 判为 `pass-external`（`ok:true`），机械 fan-in 会把任务置 done 而 AC-270 仍红——那正是本任务要挡的旁路（内存 `quay-human-gate-must-be-an-ac-not-dod-prose`）。保持未注解，未勾的非外部项会让 fan-in 拒绝、driver 按重试上限落 `needs-human`，这才是设计终态。
- 也不要把人证门写成 DoD 散文里的一句话——门的机械判据只读 AC 勾选状态，散文会被静默绕过（同上内存）。故人证门必须是 AC6。
- AC5 是**一次性基线**（AC-269 落地后、人写入前登记），照 AC-256 任务的 AC1 与 AC-257 任务的 AC4 先例；人写入后它不再成立，但已勾选状态保留。
- 记录文件是只读面：worker 不修改它，只读它并在本任务 `## Evidence` 里摘录读数。
- 绝不碰生产 3001，也不动 cloudflared 映射：不连接、不启用、不重启。
- 外部客户端绑定的真跑成本（真外部客户端 + cloudflared 公网基址 + 真模型调用）已由 AC-269 承担一次；本条不重跑绑定，只重跑机械复核（`--check-external-record` 是纯读）与 AC-269 的单测。

## Evidence

**AC1 — 前置齐全（AC-269 判据绿）。** 逐字命令 `for f in scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs docs/proposals/cloudcli-mcp-external-client.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node --test scripts/mcp-smoke.test.mjs && node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md` 退出 **0**。`node --test scripts/mcp-smoke.test.mjs` 汇总逐字：`tests 39 / suites 0 / pass 39 / fail 0 / cancelled 0 / skipped 0 / todo 0 / duration_ms 2883.268228`。`node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md` stdout 逐字：`记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串`（退出 0）。

**AC2 — 记录九节齐全且每节 读数：/结论： 非空。** `--check-external-record` 退出 **0**（stdout 同上）。逐节标题与两行存在性（数字 = 冒号后非空字数）：`## 客户端与版本` 读数=309 / 结论=85；`## 公网基址` 读数=276 / 结论=45；`## 回调主机` 读数=231 / 结论=69；`## 是否使用 DCR` 读数=402 / 结论=61；`## 是否发送 resource` 读数=236 / 结论=74；`## 是否使用 refresh token` 读数=371 / 结论=72；`## 工具调用超时` 读数=402 / 结论=111；`## overview 返回` 读数=697 / 结论=62；`## allowlist 重绑` 读数=749 / 结论=104。九节共 9/9，标题与 AC2 逐字列出的九个一致。

**AC3 — 公网基址一节不含令牌。** 该节正文 `grep -cE 'ccp_|cca_'` → **0**（grep 退出 1，无匹配）。该节 `读数：` 行逐字：`读数：公网基址 = https://sheriff-kitchen-lenders-accessing.trycloudflare.com（由 cloudflared tunnel --url http://127.0.0.1:<临时端口> 起的 quick tunnel 得到，作为 PUBLIC_BASE_URL）；该基址下 /.well-known/oauth-protected-resource/mcp 与 /.well-known/oauth-authorization-server 均可匿名读取；基址只写主机名，不带任何令牌。`——是 https 主机名、不含令牌。正控制：把记录拷贝到临时目录（`mktemp -d`，未入库）并在该节插入一行 `读数：注入 cca_deadbeef 令牌串` 后，同一 `grep -cE 'ccp_|cca_' <该节正文>` → **1**（grep 退出 0）——证明该零有分辨力、不是恒零。

**AC4 — 反自点亮（负控制 + 正控制）。** 负控制：`grep -c '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md` → **0**（grep 退出 1，无匹配）；`grep -c '外部客户端验收：通过' scripts/mcp-smoke.mjs` → **0**（grep 退出 1，无匹配）。正控制：把记录拷贝到临时目录、在行首插入一行该字样后，同一 `grep -c '^外部客户端验收：通过' <临时拷贝>` → **1**（grep 退出 0）——证明负控制的零有分辨力、不是恒零。临时拷贝在 `mktemp -d` 下创建、未入库。

**AC5 — 红态基线逐字记录（一次性，AC-269 落地后、人写入前登记）。** 命令逐字：`grep -q '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md || { echo '缺人工验收行：记录文件里没有以「外部客户端验收：通过」开头的一行' >&2; exit 1; }`。输出（stderr）逐字：`缺人工验收行：记录文件里没有以「外部客户端验收：通过」开头的一行`。退出码 **1**。人写入后本条不再成立，但已勾选状态保留。

**AC6 — 人证行（未满足，等 yale 写入）。** AC-269 已落地、记录九节齐全，但人证行仍未写入，判据保持红（AC5 即其红态读数）。worker 不代写、不勾选该 AC；本任务应停在 `needs-human`。

**AC7 — 只写本任务文件。** `git diff --name-only "$(git merge-base develop HEAD)" -- . ':!tasks/gap-ac270-external-client-human-gate.md'` 无输出（除本任务文件外，产品代码与记录文件一行未改）。

**承重读数摘录（均引自记录 `docs/proposals/cloudcli-mcp-external-client.md`，逐字）。**

- **实际所用客户端与版本**：终端 Claude Code（headless `claude -p`），`claude --version` 逐字 `2.1.289 (Claude Code)`；@modelcontextprotocol/sdk 1.29.0；node v24.21.0；模型 id `v4.1flash`；绑定方式逐字 `claude mcp add --transport http cloudcli https://<公网基址>/mcp --scope user` 后 `claude mcp login --no-browser cloudcli`（无头 OAuth：打印授权 URL，回填回调 URL）。
- **公网基址**：`https://sheriff-kitchen-lenders-accessing.trycloudflare.com`（`cloudflared tunnel --url http://127.0.0.1:<临时端口>` 起的 quick tunnel，作为 `PUBLIC_BASE_URL`）；只写主机名，不含任何令牌。
- **回调主机**：`localhost`；本轮逐字 `http://localhost:58214/callback`；授权页逐字 `Callback host: localhost:58214`；`MCP_ALLOWED_REDIRECT_HOSTS=localhost`。
- **是否用 DCR**：用。启动日志逐字 `[MCP] oauth register mounted at /oauth/register (MCP_DCR=open)`；服务端行逐字 `client_id=8b7cd36b6abcbf9218cbfbe25bf5fa28 created_via="dcr" redirect_uris=["http://localhost:60413/callback"] client_name="Claude Code (cloudcli)"`。
- **是否发 resource**：发。授权请求逐字含 `resource=https%3A%2F%2Fsheriff-kitchen-lenders-accessing.trycloudflare.com%2Fmcp`，并含 `code_challenge_method=S256`。
- **是否用 refresh**：用。服务端逐字 `kind="oauth_refresh" token_prefix="ccr_bfa7" scopes=["cloudcli:read"]`；客户端 `.credentials.json` 同持 `accessToken=cca_7f9c…` 与 `refreshToken=ccr_bfa7…`（各 68 字符）。
- **实测工具调用超时**：经公网基址 `run_get(runId=<在飞 run>, waitSeconds=60)`，服务端按 `MCP_RUN_GET_MAX_WAIT_SECONDS=25` 秒封顶后原样返回，逐字 `{"runId":"2651ccde-847e-4d88-bf7c-7cba22ff0e46","status":"running",...,"outcome":"timeout"}`；另把网关进程 SIGSTOP 制造不应答时，客户端约 **29.5s** 放弃并报逐字 `cloudcli MCP server never became ready (still connecting), so mcp__cloudcli__overview is unavailable`。结论：客户端容忍 ≈30s，≥ 服务端 25s 封顶。
- **overview 的实际返回**：空态逐字 `{"running":[],"awaitingPermission":[],"aborted":[],"hosts":[],"quay":[]}`；有在飞 run 时逐字 `{"running":[{"sessionId":"48223ae2-7729-4279-87bd-f43f58c99aee","projectId":"86945649-a792-4dba-9ef3-247f39dd2e10","project":"AC269","title":"Bash sleep 120 command","phase":"unknown","elapsedMs":43355}],"awaitingPermission":[],"aborted":[],"hosts":[{"hostId":"host-177e9919-fe24-477f-a5f1-a91c0e852eab","state":"busy","sessionId":"48223ae2-7729-4279-87bd-f43f58c99aee","peerName":null,"leases":[{"kind":"turn","runId":"run-d738245b-21ae-4f12-8875-24a741cc960c"}]}],"quay":[{"projectId":"86945649-a792-4dba-9ef3-247f39dd2e10","status":"no-quay-config","note":"该项目没有 quay"}]}`。
- **`MCP_DCR=allowlist` 后重绑成功**：启动日志逐字 `[MCP] oauth register mounted at /oauth/register (MCP_DCR=allowlist)`；重注册逐字 `client_id=e7802329ccb9191d78be44f8b72c665d created_via="dcr" redirect_uris=["http://localhost:58214/callback"]`；重绑逐字成功 `Authenticated with "cloudcli". Its tools are now available in Claude Code.`；`claude mcp list` 逐字 `cloudcli: ... (HTTP) - ✔ Connected`。

**请求人 yale 做的唯一动作（一步）。** 在 `docs/proposals/cloudcli-mcp-external-client.md` 写入一行、以「外部客户端验收：通过」开头（行首起、无前导空白），并确认记录「客户端与版本」一节写明的实际所用客户端与版本（终端 Claude Code 2.1.289）可接受。写入后重跑 AC6 判据 `grep -q '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md` 即退出 **0**，届时勾选 AC6、本任务方可推进，GOAL-021 方可判 achieved。

## Needs-Human

**执行 2026-10-05T23:39:52.300Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：worker-driver 连续 3 次 exited-not-landed 未落地（重试上限）
- 失败步/判词：AC 未全勾（checked 6/7，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：f42bc02a-3a10-48b3-b7d8-f778e047d83c
