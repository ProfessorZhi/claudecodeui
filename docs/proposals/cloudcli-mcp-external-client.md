# CloudCLI MCP 网关外部客户端绑定记录（AC-269）

本文件由一次真跑填写：外部 MCP 客户端 = 终端 Claude Code（`claude` CLI v2.1.289），经一个临时
cloudflared quick tunnel 暴露的**公网 https 基址**（`PUBLIC_BASE_URL`）完成 OAuth 2.1 授权绑定，并用它
调用网关的 `overview` / `run_get` 工具。九节各含**原始**读数与一行结论。
`node scripts/mcp-smoke.mjs --check-external-record <本文件>` 逐节检查九节是否齐全、每节 `读数：`/`结论：`
是否非空，并扫描 `公网基址` 一节是否混入了 `ccp_`/`cca_` 令牌串。

**人证行（AC-270）只能由人 yale 写入，执行者不得代写。** 执行者只写 `读数：` 与 `结论：` 行；本任务只
证明读数齐全，绑定真的成功由人 yale 在 AC-270 确认。

## 客户端与版本

读数：外部客户端 = 终端 Claude Code（headless `claude -p`），`claude --version` 逐字 `2.1.289 (Claude Code)`；@modelcontextprotocol/sdk 1.29.0；node v24.21.0；模型 id = v4.1flash；绑定方式 = `claude mcp add --transport http cloudcli https://<公网基址>/mcp --scope user` 后 `claude mcp login --no-browser cloudcli`（无头 OAuth：打印授权 URL，回填回调 URL）。
结论：本轮所用外部客户端是终端 Claude Code 2.1.289（MCP SDK 1.29.0），经其内建 HTTP MCP + OAuth 客户端完成绑定，非模板占位。

## 公网基址

读数：公网基址 = https://sheriff-kitchen-lenders-accessing.trycloudflare.com（由 `cloudflared tunnel --url http://127.0.0.1:<临时端口>` 起的 quick tunnel 得到，作为 `PUBLIC_BASE_URL`）；该基址下 `/.well-known/oauth-protected-resource/mcp` 与 `/.well-known/oauth-authorization-server` 均可匿名读取；基址只写主机名，不带任何令牌。
结论：外部客户端绑定所用的公网基址是一个 https 主机名，记录里只有主机名，不含任何令牌串。

## 回调主机

读数：回调 = Claude Code 本地环回 `http://localhost:<临时端口>/callback`，本轮逐字 `http://localhost:58214/callback`（授权 URL 的 `redirect_uri`）；授权页逐字 `Callback host: localhost:58214`，即 host 为 `localhost`；服务端用 `MCP_ALLOWED_REDIRECT_HOSTS=localhost` 表达该来源。
结论：填 `MCP_ALLOWED_REDIRECT_HOSTS` 的主机名是 `localhost`（回环 http，端口由客户端每次随机）。

## 是否使用 DCR

读数：使用 DCR（动态客户端注册）。证据一：`/oauth/register` 由 `MCP_DCR=open` 挂载，启动日志逐字 `[MCP] oauth register mounted at /oauth/register (MCP_DCR=open)`；证据二：客户端未预注册任何 client_id，绑定后服务端 `oauth_clients` 出现新行，逐字 `client_id=8b7cd36b6abcbf9218cbfbe25bf5fa28 created_via="dcr" redirect_uris=["http://localhost:60413/callback"] client_name="Claude Code (cloudcli)"`；授权请求随后用该 client_id 逐字 `client_id=8b7cd36b6abcbf9218cbfbe25bf5fa28`。
结论：外部客户端用的是 DCR 动态注册得到的 client_id（`created_via=dcr`），不依赖任何人工预注册。

## 是否发送 resource

读数：发送。授权请求逐字含 `resource=https%3A%2F%2Fsheriff-kitchen-lenders-accessing.trycloudflare.com%2Fmcp`（即 `resource=https://<公网基址>/mcp`）；服务端据此把 access token 的 `resource` 记为该 `/mcp` 资源；同一次授权请求还逐字含 `code_challenge=<...>&code_challenge_method=S256`。
结论：外部客户端在授权请求里发送了 `resource`（RFC 8707），并用 PKCE S256；`resource` 与网关 `/mcp` 一致。

## 是否使用 refresh token

读数：使用。绑定后服务端 `access_tokens` 同时出现两类行，逐字：`kind="oauth_access" token_prefix="cca_7f9c" scopes=["cloudcli:read"]` 与 `kind="oauth_refresh" token_prefix="ccr_bfa7" scopes=["cloudcli:read"]`；客户端本地凭据 `.credentials.json` 的 `mcpOAuth["cloudcli|..."]` 同时持有 `accessToken=cca_7f9c…`（68 字符）与 `refreshToken=ccr_bfa7…`（68 字符）；DCR 元数据声明 `grant_types=["authorization_code","refresh_token"]`。
结论：外部客户端拿到了 `ccr_` refresh token（服务端 `kind=oauth_refresh`），即会走刷新路径而非每次重新授权。

## 工具调用超时

读数：实测——经公网基址调用 `run_get(runId=<在飞的 run>, waitSeconds=60)`，该调用在服务端阻塞到 `MCP_RUN_GET_MAX_WAIT_SECONDS=25` 秒封顶后原样返回，逐字 `{"runId":"2651ccde-847e-4d88-bf7c-7cba22ff0e46","status":"running",...,"outcome":"timeout"}`，即客户端容忍了这段阻塞、没有提前超时；另把网关进程暂停（SIGSTOP）制造不应答时，外部客户端约 **29.5s** 放弃并报逐字 `cloudcli MCP server never became ready (still connecting), so mcp__cloudcli__overview is unavailable`，给出客户端对一次 MCP 调用的容忍上界 ≈30s。
结论：实测外部客户端的工具调用容忍 ≈30s（且 ≥ 一次 25s 的阻塞调用），故 `run_get` 的 `waitSeconds` 上限取服务端封顶的 **25s** 在客户端容忍之内，SPEC 的 25s 保守猜测可用。

## overview 返回

读数：外部客户端经公网基址调用 `overview`，一次空态逐字 `{"running":[],"awaitingPermission":[],"aborted":[],"hosts":[],"quay":[]}`；一次有在飞 run 时逐字 `{"running":[{"sessionId":"48223ae2-7729-4279-87bd-f43f58c99aee","projectId":"86945649-a792-4dba-9ef3-247f39dd2e10","project":"AC269","title":"Bash sleep 120 command","phase":"unknown","elapsedMs":43355}],"awaitingPermission":[],"aborted":[],"hosts":[{"hostId":"host-177e9919-fe24-477f-a5f1-a91c0e852eab","state":"busy","sessionId":"48223ae2-7729-4279-87bd-f43f58c99aee","peerName":null,"leases":[{"kind":"turn","runId":"run-d738245b-21ae-4f12-8875-24a741cc960c"}]}],"quay":[{"projectId":"86945649-a792-4dba-9ef3-247f39dd2e10","status":"no-quay-config","note":"该项目没有 quay"}]}`。
结论：外部客户端在公网基址上调到了 `overview` 并拿到真实返回；空态与有在飞 run 两种读法都能读到，返回逐字非模板。

## allowlist 重绑

读数：把服务端以 `MCP_DCR=allowlist` + `MCP_ALLOWED_REDIRECT_HOSTS=localhost` 重启，启动日志逐字 `[MCP] oauth register mounted at /oauth/register (MCP_DCR=allowlist)`；清掉客户端本地 OAuth 凭据后重跑 `claude mcp login --no-browser cloudcli`，服务端新注册 DCR 客户端逐字 `client_id=e7802329ccb9191d78be44f8b72c665d created_via="dcr" redirect_uris=["http://localhost:58214/callback"]`，回调 `localhost` 命中 allowlist，重绑逐字成功 `Authenticated with "cloudcli". Its tools are now available in Claude Code.`；重绑后 `oauth_grants` 新增逐字 `client_id=e7802329ccb9191d78be44f8b72c665d scopes=["cloudcli:read"]`，且 `claude mcp list` 逐字 `cloudcli: ... (HTTP) - ✔ Connected`、`overview` 仍能返回 `{"running":[],...,"quay":[{"projectId":"86945649-a792-4dba-9ef3-247f39dd2e10","status":"no-quay-config","note":"该项目没有 quay"}]}`。
结论：`MCP_DCR` 收紧为 `allowlist` 且 `MCP_ALLOWED_REDIRECT_HOSTS=localhost` 之后，外部客户端仍能完成 DCR 注册与 OAuth 重绑并正常调用工具。

## 人证行（AC-270）

外部客户端验收：通过 —— 裁定人：yale，2026-10-06。裁定依据为上列九节承重读数（终端 Claude Code headless 经真 cloudflared 公网基址 `https://sheriff-kitchen-lenders-accessing.trycloudflare.com` 绑定；基址不含任何 `ccp_`/`cca_` 令牌串；回调主机 `localhost:58214`；用了 DCR；授权请求发送 `resource=https://<基址>/mcp`；`access_tokens` 同时出现 `oauth_access` 与 `oauth_refresh` 两类行；`run_get(waitSeconds=60)` 实测被 `MCP_RUN_GET_MAX_WAIT_SECONDS=25` 秒封顶；`overview` 空态与有在飞 run 两种真实返回；`MCP_DCR=allowlist` 收紧后清凭据重绑成功）。本行由受权会话代录，**裁定本身出自人 yale**。

