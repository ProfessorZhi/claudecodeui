---
id: gap-ac269-external-client-record
title: AC-269 外部客户端绑定记录齐全：scripts/mcp-smoke.mjs 增
  --check-external-record（九节逐节点名缺节 + 公网基址含 ccp_/cca_ 令牌红）+
  docs/proposals/cloudcli-mcp-external-client.md
  九节读数（客户端与版本、公网基址不含令牌、回调主机、DCR、resource、refresh、工具调用超时、overview
  返回、MCP_DCR=allowlist 重绑）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac268-oauth-e2e-flow
  - gap-ac256-mcp-nested-smoke-record
goal_ac: AC-269
---
## Proposal

AC-269（GOAL-021 退出条件 8 前半；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §516「阶段 5｜经 cloudflared 上公网｜人工门」与 §524「人工门：外部客户端完成绑定并调用 `overview`，记录回调主机、是否用 DCR、是否发送 `resource`、实测工具调用超时」）要求把外部客户端绑定的读数落成**逐节可校**的记录：

(a) 新记录文件 `docs/proposals/cloudcli-mcp-external-client.md`，**九节**，每节两行——以 `读数：` 开头的原始读数行与以 `结论：` 开头的结论行，两行均非空。九节标题逐字为：

1. `客户端与版本`（Gemini Web 与 Android、Claude.ai 连接器或其他；写清实际所用客户端与版本）；
2. `公网基址`（经 cloudflared 暴露的 https 基址，**不含任何令牌**，不得出现 `ccp_`/`cca_`）；
3. `回调主机`（用于填 `MCP_ALLOWED_REDIRECT_HOSTS` 的主机名/来源）；
4. `是否使用 DCR`；
5. `是否发送 resource`；
6. `是否使用 refresh token`；
7. `工具调用超时`（实测值，决定 `waitSeconds` 上限；SPEC 当前保守猜 25 秒）；
8. `overview 返回`（该客户端上 `overview` 工具的实际返回原文）；
9. `allowlist 重绑`（`MCP_DCR` 收紧为 `allowlist` 之后重新绑定仍成功的读数）。

(b) `scripts/mcp-smoke.mjs` 增 `--check-external-record <file>` 模式：按整行相等逐节比对上述九个标题，缺任一节即退出非 0 并在 stderr 逐字点名 `缺节：<标题>`；任一节缺 `读数：`/`结论：` 行或其内容为空即点名该节；并在 `公网基址` 一节正文检出 `ccp_`/`cca_` 令牌串即退出非 0 并点名。九节齐全且公网基址无令牌时退出 0。`scripts/mcp-smoke.test.mjs` 覆盖「缺一节就红」「缺读数/结论行红」「读数为空红」「公网基址含令牌红」「九节齐全 exit 0」五件机械检查。

现状（红态基线）：`scripts/mcp-smoke.mjs`、`scripts/mcp-smoke.test.mjs` 与 `docs/proposals/cloudcli-mcp-external-client.md` 都不存在；AC-269 的存在性闸以退出码 1 逐字输出 `缺判据文件：scripts/mcp-smoke.mjs`。本任务只证明**读数齐全**（结构面），「绑定并调用真的成功」由下一条人工关卡 AC-270 由人 yale 确认。

<!-- dedup-ref -->
机制去重已核对：`grep -rl "^goal_ac: AC-269" tasks/` 为空，`grep -rln "check-external-record\|cloudcli-mcp-external-client" tasks/` 为空，本仓库无任何任务带 AC-269 或触碰同一机制。相关但不同的任务：`gap-ac256-mcp-nested-smoke-record` 新建 `scripts/mcp-smoke.mjs` 与 `scripts/mcp-smoke.test.mjs`（本任务只在其上加 `--check-external-record` 分支，不动 `--check-record` 八节）；`gap-ac268-oauth-e2e-flow` 及更早的 OAuth 栈任务让端点可用。开工次序以 frontmatter 的关系字段为准，正文不重复声明。

要交付：

1. **`scripts/mcp-smoke.mjs`（增分支，不动既有 `--check-record`）**：新增 `--check-external-record <file>`；九节标题按整行相等比对（中文没有词边界，不用 `\b`），沿用 `resident-smoke.mjs` 的 `extractSection` 写法；`公网基址` 一节正文出现 `ccp_` 或 `cca_` 即判红并点名；参数缺失或文件不存在时退出非 0 并给出用法。
2. **`scripts/mcp-smoke.test.mjs`（增护栏单测）**：覆盖上文五件机械检查；spawn CLI 断言 stderr 时读 `spawnSync().stderr`（内存 `node-test-stderr-does-not-reach-the-caller`）。
3. **`docs/proposals/cloudcli-mcp-external-client.md`（新）**：九节，每节 `读数：`/`结论：` 非空，读数来自真实外部客户端绑定（见 AC7）。
4. **取假形态两条**（先提交实现再变异）：(i) 删任一节 ⇒ 红并点名；(ii) 公网基址写成含 `ccp_`/`cca_` 令牌的 URL ⇒ 红并点名。

## AC

- [x] AC1 红态基线逐字记录：改动前运行 AC-269 判据命令 `for f in scripts/mcp-smoke.mjs docs/proposals/cloudcli-mcp-external-client.md; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md`，存在性闸退出码 **1**，逐字输出 `缺判据文件：docs/proposals/cloudcli-mcp-external-client.md`。注：AC 原文预测点名 `scripts/mcp-smoke.mjs`，但该文件已由 `gap-ac256` 落进 develop，故本分支存活侧缺的是记录文件本身；存在性闸仍红并逐字点名缺失的判据文件（意图 = 先红后绿不变，仅预测的文件名过时）。
- [x] AC2 判据绿：同一命令退出 **0**；stdout 逐字 `记录合格：docs/proposals/cloudcli-mcp-external-client.md 九节齐全、每节 读数：/结论： 非空、公网基址不含令牌串`，stderr 为空。`node --test scripts/mcp-smoke.test.mjs` 退出 **0**，读数 `tests 39 / pass 39 / fail 0`。
- [x] AC3 九节齐全：记录文件恰有九个标题 `客户端与版本`、`公网基址`、`回调主机`、`是否使用 DCR`、`是否发送 resource`、`是否使用 refresh token`、`工具调用超时`、`overview 返回`、`allowlist 重绑`，每节都有非空 `读数：` 与 `结论：` 两行（记录文件第 12–55 行）。
- [x] AC4 单测覆盖五件机械检查：`node --test scripts/mcp-smoke.test.mjs` 退出 **0**（39/39）。逐条测试名：(a) 缺整条节点名 = `外部记录（a）：缺一节就红，并逐字点名缺的是哪节`、`外部记录（a 纯函数）：checkExternalRecordText 对只有一节的记录点名其余八节全缺`、`外部记录（a 纯函数）：checkExternalRecordFile 对不存在的文件把九节点名全缺`；(b) 缺 `读数：`/`结论：` 行点名 = `外部记录（b-1）：缺 \`结论：\` 行的节点名该节缺哪行，不报整节`、`外部记录（b-2）：缺 \`读数：\` 行的节点名该节缺哪行`；(c) 读数为空点红 = `外部记录（c-1）：\`读数：\` 冒号后为空时点红并点名该节`、`外部记录（c-2）：\`结论：\` 冒号后只有空白也算空`；(d) 公网基址含令牌红 = `外部记录（d-1）：公网基址含 \`ccp_\` 令牌必红并点名该节`、`外部记录（d-2）：公网基址含 \`cca_\` 令牌必红并点名该节`；(e) 九节齐全 exit 0 = `外部记录（e）：九节齐全 exit 0`（另含 `外部记录（e 纯函数）：九节齐全判绿`、`外部记录：文件不存在时 exit 1 并把九节点名全缺`、`外部记录：\`--check-external-record\` 缺文件参数时给用法并 exit 1`）。
- [x] AC5 取假形态 (i) 缺一节必红并点名：删掉 `overview 返回` 一节后 `--check-external-record` 退出 **1**，stderr 逐字 `缺节：overview 返回 —— 缺整个小节`；变异 diff 为删去该节 `## overview 返回` 小节（读数+结论共 5 行）；恢复命令 `cp /tmp/ac269-run/record.bak docs/proposals/cloudcli-mcp-external-client.md`（等价于 `git checkout -- <file>` 后重填），恢复后重跑 `EXIT=0`。
- [x] AC6 取假形态 (ii) 公网基址含令牌必红：把 `公网基址` 一节读数改成含 `cca_7f9c…` 令牌的 URL（`…trycloudflare.com/?access=cca_…`）后 `--check-external-record` 退出 **1**，stderr 逐字 `缺节：公网基址 —— 正文含令牌串（ccp_/cca_）——公网基址只应是 https 主机名，不得带任何令牌`；恢复命令同 AC5，恢复后 `EXIT=0`，且该节 token 扫描为空。
- [x] AC7 九节读数是真绑定的原始读数：外部客户端 = 终端 Claude Code `2.1.289`（@modelcontextprotocol/sdk 1.29.0，node v24.21.0），经临时 cloudflared quick tunnel 公网基址 `https://sheriff-kitchen-lenders-accessing.trycloudflare.com` 走 OAuth 2.1 + PKCE S256 绑定（DCR `created_via="dcr"`、发 `resource=https://<基址>/mcp`、拿 `ccr_` refresh token），并调用了 `overview` 与 `run_get`；九节读数逐条原始、非模板。
- [x] AC8 不点亮 AC-270：`grep -c '^外部客户端验收：通过' docs/proposals/cloudcli-mcp-external-client.md` → **0**；`grep -c '外部客户端验收：通过' scripts/mcp-smoke.mjs` → **0**。
- [x] AC9 契约面与边界：`npx oxlint scripts/mcp-smoke.mjs scripts/mcp-smoke.test.mjs` 退出 **0**；`git diff --stat develop...HEAD` = `docs/proposals/cloudcli-mcp-external-client.md | 55 +`（ASCII `(new)`）、`scripts/mcp-smoke.mjs | 132 +`、`scripts/mcp-smoke.test.mjs | 149 +`，与 `## Touches` 逐条对齐；`git status --porcelain -- server src` 为空 ⇒ 产品代码（`server/`、`src/`）一行未改。

## DoD

- 判据命令 `node scripts/mcp-smoke.mjs --check-external-record docs/proposals/cloudcli-mcp-external-client.md` 退出 0，且九节各有非空 `读数：` 与 `结论：`。
- 九节读数是真的：客户端与版本、经 cloudflared 的公网基址（不含令牌）、回调主机、是否用 DCR、是否发 `resource`、是否用 refresh、实测工具调用超时、`overview` 的实际返回、`MCP_DCR=allowlist` 后重绑成功的读数，逐条来自一次真实外部客户端绑定；若是执行者可驱动的客户端（如终端 Claude Code 经临时 cloudflared 公网基址），记录里写明所用者；若只能由人提供而本轮缺失，正确终态是 `needs-human` 并逐节点名缺哪节，绝不编造。
- 两条取假形态都先红后恢复：缺一节 ⇒ 点名该节；公网基址含 `ccp_`/`cca_` 令牌 ⇒ 红并点名；变异 diff、逐字失败行、恢复命令齐全，恢复后回绿。
- `--check-external-record` 是机械检查：整行相等比对九个标题、两行非空、扫描公网基址令牌；单测覆盖五件检查（含「缺一节就红」）。
- AC-270 的人证行没被点亮：记录与脚本里都没有以 `外部客户端验收：通过` 开头的行；本任务只证明读数齐全，GOAL-021 的验收结论由人 yale 在 AC-270 给出。
- 遵守 AGENTS.md：只动 `## Touches` 列出的文件；产品代码一行不改；不引入新依赖。

## Touches

- scripts/mcp-smoke.mjs（增 `--check-external-record`；由 `gap-ac256` 新建）
- scripts/mcp-smoke.test.mjs（增该模式护栏单测；由 `gap-ac256` 新建）
- docs/proposals/cloudcli-mcp-external-client.md (new)（九节读数记录；人证行由人 yale 在 AC-270 写）
- tasks/gap-ac269-external-client-record.md（自触）

## Notes

- `--check-external-record` 的节标题按整行相等比对（中文没有词边界，不用 `\b`），沿用 `resident-smoke.mjs` 的 `extractSection` 写法；九节标题无前缀互撞。
- 令牌扫描只针对 `公网基址` 一节正文：出现 `ccp_`（PAT 前缀）或 `cca_`（OAuth access 前缀）即红——记录里只应有 https 主机名，不带任何令牌（`cca_`/`ccr_` 令牌属 OAuth，`ccp_` 属 PAT）。
- `node --test` 的 stderr 不回传给调用方（内存 `node-test-stderr-does-not-reach-the-caller`）：单测里 spawn 子进程跑 CLI 并断言 stderr 时读 `spawnSync().stderr` 字段。
- 本任务扩展 `gap-ac256-mcp-nested-smoke-record` 新建的 `scripts/mcp-smoke.mjs`/`scripts/mcp-smoke.test.mjs`；扩展时不动 `--check-record` 既有行为与 AC-256 的八节。
- 新增/改动 `scripts/*.mjs` 会让 `scripts/tsconfig.json`（`allowJs + checkJs`）多报类型错——这是 develop 侧既有红（`resident-smoke.mjs` 63 个），本条不修它，也不把 `npm run typecheck` 退出 0 写进 AC；只要求新文件的 `oxlint` 绿。
- 外部客户端与 cloudflared 公网基址：SPEC §516「经 cloudflared 上公网｜公网｜人工门」；本任务只证明读数齐全，绑定真的成功由人 yale 在 AC-270 确认；记录里只写公网基址，绝不写令牌。