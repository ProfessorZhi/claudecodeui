---
id: gap-ac242-mcp-loopback-guard-before-auth
title: AC-242 MCP_OAUTH_ENABLED 未开启时 /mcp 只接受本机直连：socket
  非回环地址与任一转发头（X-Forwarded-For / Forwarded / CF-Connecting-IP / X-Real-IP）存在即
  403，且守卫在认证之前；判据 server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac240-mcp-stateless-transport-mount-order
  - gap-ac241-mcp-token-auth-shares-service
goal_ac: AC-242
---
## Proposal

AC-242（GOAL-020 退出条件 4；SPEC `docs/proposals/mcp-gateway-SPEC.md` v3.1 §415、§416、§495、§522；goal 的「已知限制」条目）要求 `MCP_OAUTH_ENABLED` 未开启时 `/mcp` 只接受本机直连：以 **socket 远端地址**判断（`127.0.0.1`、`::1`、`::ffff:127.0.0.1` 放行；docker 网桥 `172.17.0.1`、`192.168.1.5`、`10.0.0.2`、远端地址缺失一律 403），并且**不信任任何转发头**——即使 socket 是回环，只要出现 `X-Forwarded-For`、`Forwarded`、`CF-Connecting-IP`、`X-Real-IP` 任一头也 403（本机反代或 tailscale serve 经回环转进来时 socket 仍是回环，只有转发头能区分）；`MCP_OAUTH_ENABLED` 开启时守卫关闭（非回环请求能走到认证并得到 401 而不是 403）；被守卫拒绝的请求不触发令牌校验（校验间谍计数为 0）。判据文件 `server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts` 当前不存在，AC-242 的存在性闸以退出码 1 逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts`。

现状（红态基线）：`server/modules/mcp-gateway/` 目录不存在（由 AC-240 创建）；`grep -rn "MCP_OAUTH_ENABLED\|remoteAddress\|trust proxy\|TRUST_PROXY\|X-Forwarded-For" server/ --include=*.ts` 为空——`MCP_OAUTH_ENABLED` 在整个 `server/` 无读取点，没有任何回环/转发头判定，`/mcp` 尚无本机限制。SPEC §416 把「回环守卫以 socket 远端地址判断」收紧为「再加转发头存在即拒」，已回填 SPEC（goal 已知限制）。

要交付：

1. **回环守卫（新文件 `server/modules/mcp-gateway/mcp-gateway.loopback.ts`；遵守 `$backend-module-standards`）**：
   - `readMcpOauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean`——`MCP_OAUTH_ENABLED` 的**唯一读取点**（fail-closed）。只有去空白、转小写后落在 `1/true/yes/on` 才为真（守卫关闭）；未设、`false` 系、无法识别的值一律为假（守卫生效）。**不做 module-level cache**——判据要在同一进程里读两种开关态（形制照 `server/modules/debug-agent/debug-agent.gate.ts` 的 `ENABLED_VALUES`/`DISABLED_VALUES`，但每次调用现场求值）。
   - `isLoopbackRemoteAddress(address: string | undefined): boolean`——仅 `127.0.0.1`、`::1`、`::ffff:127.0.0.1` 三个字面量为真；`undefined`/空串/其余一律为假。（不扩大到整个 `127.0.0.0/8`——判据只要求这三个字面量，多认一个地址就是多一条暴露面。）
   - `createMcpLoopbackGuard(env: NodeJS.ProcessEnv = process.env): express.RequestHandler`——**每个请求**先调 `readMcpOauthEnabled(env)`：
     - 为真（OAuth 已开）⇒ 直接 `next()`（守卫关闭，非回环也放行到认证）。
     - 为假（守卫生效）⇒ 依次判定：
       1. 取 `req.socket?.remoteAddress`（**绝不读 `req.ip`**——`req.ip` 受 `app.set('trust proxy', …)` 影响，转发头能把它伪造成回环值，正是本守卫要防的）；
       2. `!isLoopbackRemoteAddress(address)`（含地址缺失）⇒ 403；
       3. 四个转发头任一**存在**（`req.headers['x-forwarded-for']`、`req.headers['forwarded']`、`req.headers['cf-connecting-ip']`、`req.headers['x-real-ip']` 任一 `!== undefined`，**不看值**，空串也算出现）⇒ 403；
       4. 否则 `next()`。
     - 403 用 JSON 响应体（`res.status(403).json({ error: 'MCP is only reachable from the local machine while OAuth is disabled', code: 'MCP_LOOPBACK_ONLY' })`）；判据只断言状态码 403 与「未触发校验」，不断言文案。
2. **接线：守卫在认证之前（`server/modules/mcp-gateway/mcp-gateway.transport.ts`）**：`mountMcpGateway` 的中间件顺序为「body 解析 → **回环守卫**（`createMcpLoopbackGuard()`）→ `deps.authorize`（AC-240 的认证缝，AC-241 在此接真实令牌校验）→ 传输处理器」。守卫在传输入口内部创建、顺序写死在这一处，因此本任务通常不改 `server/index.ts`（AC-240/AC-241 已在此装配；守卫由传输内部挂载，无需在装配点组合）。若 AC-240 实际落地的缝形状使这不可能（例如守卫必须由装配点传入），先用 `task_write` 把 `server/index.ts` 加进本任务 `## Touches` 再改（`quay-touches-must-match-actual-write-sites`）。
3. **barrel（`server/modules/mcp-gateway/index.ts`）**：导出 `readMcpOauthEnabled`、`isLoopbackRemoteAddress`、`createMcpLoopbackGuard`（消费者：`mcp-gateway.transport.ts` 与判据），并各自在定义处写消费方注释；不导出无消费者符号。
4. **判据文件 `server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts`（红先行；真实 express 4 应用 + 真实 HTTP `node:http`，不用 `fetch`——`listen(0)` 会抽到 undici 拒绝的固定端口，见 AC-240 同款说明）**：在同一 app 上按 AC-240/AC-241 的装配形状 `mountMcpGateway(app, { authorize, ... })` 装配，`authorize` 是计数间谍（每次被调用 `count++` 后按需要 `next()` 或 `res.status(401).json(...)`）。远端地址的造法：(0) 一条**真实回环 HTTP** 读数（服务听 `127.0.0.1`，socket 真为 `127.0.0.1`），证明默认 `req.socket.remoteAddress` 路径；(a) 其余地址与「缺失」用挂在 `mountMcpGateway` **之前**的小中间件把 `req.socket` 用 `Object.defineProperty(req, 'socket', { value: { remoteAddress: <伪造地址> }, configurable: true })` 遮蔽（own property 覆盖原型 getter），使守卫读到伪造地址——这是本机不依赖 docker/LAN 网卡就造出 `172.17.0.1` 等地址的可行办法。读数各自独立成断言并逐字写出原始状态码/计数：
   - (a) `127.0.0.1`、`::1`、`::ffff:127.0.0.1` ⇒ **非 403**（放行到 `authorize`；写下实际状态码）；`172.17.0.1`、`192.168.1.5`、`10.0.0.2`、地址缺失（`remoteAddress: undefined`）⇒ 403。七条逐字列出。正例对照：三个回环地址必须非 403（防「一律 403」也通过）。
   - (b) socket 为回环（`127.0.0.1`）时，分别带 `X-Forwarded-For`、`Forwarded`、`CF-Connecting-IP`、`X-Real-IP` 各发一次 ⇒ 全 403；同一请求**不带头** ⇒ 非 403（正例对照）。五条逐字列出。
   - (c) `MCP_OAUTH_ENABLED=true` 时守卫关闭：用非回环伪造地址（如 `172.17.0.1`）且不带转发头发一次 ⇒ **401 而不是 403**（`authorize` 间谍此时返回 401）；再带 `X-Forwarded-For` 发一次 ⇒ 也 401 而不是 403。写下两条状态码。正例对照：`MCP_OAUTH_ENABLED` 未设时同一非回环请求 ⇒ 403（与 (a) 同源）。
   - (d) 守卫在认证之前：对**非回环**地址、以及**回环 + 转发头**两种被拒请求，断言 403 **且 `authorize` 间谍计数为 0**（写下每次前后计数）；正例对照：一个放行的回环请求（不带转发头）⇒ 计数 ≥1（防「间谍从不被调用」也通过）。为了让 (iii) 变异敏感，被拒请求须携带 `Authorization: Bearer <任意>`，使「守卫在认证之后」时间谍一定被走到。
   - (e) 源码级正负对照：`grep -nE "req\.ip" server/modules/mcp-gateway/mcp-gateway.loopback.ts` 为空（退出码 1）且 `grep -nE "socket\?\.remoteAddress|\.socket\.remoteAddress" server/modules/mcp-gateway/mcp-gateway.loopback.ts` 非空（逐字列出命中行），证明判据用 socket 而非 trust-proxy 后的 `req.ip`；正例对照（模式并非永不匹配）：把 `const probe = 'const a = req.ip;';` 写入临时文件并用同一 `grep -E "req\.ip"` 命中（退出码 0）。
5. **取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）**：
   (i) 信任 `X-Forwarded-For` 的回环值（读到该头等于 `127.0.0.1` 就放行）⇒ (b) 必须红；
   (ii) 只判远端地址、不看转发头（删掉四个头的存在性判定）⇒ (b) 必须红；
   (iii) 守卫放在认证之后（把守卫中间件移到 `deps.authorize` 之后）⇒ (d) 必须红。
   每条记录变异前后 `git diff`、判据逐字失败行、恢复命令，恢复后重跑判据确认回绿。

<!-- dedup-ref -->

边界（dedup）：机制上去重已核对——`grep -rl "goal_ac: AC-242" tasks/` 为空，本仓库无任何任务带 `goal_ac: AC-242`；`grep -rlE "回环|loopback|转发头|Forwarded|CF-Connecting-IP|X-Forwarded-For|MCP_OAUTH_ENABLED|remoteAddress" tasks/` 只命中 AC-240/AC-241 的边界段（它们各自声明「不做回环（AC-242）」）。AC-239（依赖声明）、AC-240（传输与认证缝）、AC-241（令牌认证）是不同机制；本任务在其之上加本机限制，不重写传输、不做令牌认证（AC-241）、scope（AC-243）、审计（AC-244）、工具（AC-245+）、设置页、冒烟。机械前置（以 `depends_on` 字段声明，不靠散文判定）：AC-240 未落地则无 `mountMcpGateway` 与认证缝，AC-241 未落地则无真实令牌校验可接线。

## AC

- [x] AC1 判据红态基线逐字记录：改动前运行 AC-242 命令，存在性闸退出码 1 并逐字输出 `缺判据文件：server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts`（写下完整命令与完整输出）。
- [x] AC2 判据绿：`for f in server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts; do [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig server/tsconfig.json --test server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts` 退出 0；写下 `# tests` / `# pass` / `# fail` 读数。
- [x] AC3 (a) socket 地址判定：`127.0.0.1`、`::1`、`::ffff:127.0.0.1` 非 403；`172.17.0.1`、`192.168.1.5`、`10.0.0.2`、地址缺失 ⇒ 403；含一条真实回环 HTTP 读数；七条状态码逐字列出。
- [x] AC4 (b) 转发头存在即拒：socket 为回环时 `X-Forwarded-For`、`Forwarded`、`CF-Connecting-IP`、`X-Real-IP` 各 ⇒ 403，不带头 ⇒ 非 403；五条状态码逐字列出。
- [x] AC5 (c) `MCP_OAUTH_ENABLED=true` 时守卫关闭：非回环（或带转发头）请求 ⇒ 401 而不是 403；未设时同请求 ⇒ 403；逐字写两条状态码。
- [x] AC6 (d) 守卫在认证之前：被拒请求（非回环 / 回环+转发头）⇒ 403 且 `authorize` 间谍计数为 0；放行的回环请求 ⇒ 计数 ≥1；逐字写计数。
- [x] AC7 (e) 源码级对照：`grep -nE "req\.ip" server/modules/mcp-gateway/mcp-gateway.loopback.ts` 为空、`grep -nE "socket\?\.remoteAddress" ...` 非空，且含 `req.ip` 的合成字符串用同一模式命中（正例对照）；逐字写两组读数。
- [x] AC8 取假形态三条必须红（先提交实现再变异，逐条记录变异 diff、逐字失败行、恢复命令）：(i) 信任 XFF 回环值 ⇒ AC4 红；(ii) 只看地址不看头 ⇒ AC4 红；(iii) 守卫在认证后 ⇒ AC6 红。每条恢复命令 + 恢复后重跑绿。
- [x] AC9 不回归与仓库门：`npm run typecheck` 退出 0、`npm run lint` 无 `: error `（写下计数）；生产非测试代码中 `MCP_OAUTH_ENABLED` 只在 `mcp-gateway.loopback.ts` 一处被读取（`grep -rn "MCP_OAUTH_ENABLED" server/ --include=*.ts | grep -v /tests/` 计数=1；正例对照：放宽到含 tests 命中 ≥2，证明扫描器有效）；跨模块只经 barrel。
- [x] AC10 `git diff --stat develop...HEAD` 与 `## Touches` 逐条对齐（新增文件用 ASCII ` (new)` 标注）；列出实际改动文件清单。

## DoD

- 守卫真的按 socket 远端地址判定放行/拒绝：回环三个字面量被放行、非回环与地址缺失 403，且不回退到 `req.ip`（`trust proxy` 下的伪造值不得放行）——不是「判据文件存在」就算数。
- 转发头真的「出现即拒」：socket 明明是回环，带四个头任一也 403；不带则放行——两向都由真实 HTTP + 真实 express 读回，夹具不是 mock。
- `MCP_OAUTH_ENABLED` 开启时守卫真的关闭（非回环走到认证得 401 而非 403），未开启时真的生效（403）；两种开关态在同一进程内被读到（无缓存）。
- 守卫真的在认证之前：被拒请求的令牌校验间谍计数为 0，放行请求 ≥1——这是真实中间件顺序的读数。
- 三条取假形态都先红后恢复，变异 diff、逐字失败行、恢复命令齐全；恢复后重跑回绿。
- 遵守 `$backend-module-standards`（TS、跨模块只经 barrel、导出带消费方注释、不导出无消费者符号）与 AGENTS.md；不引入新依赖（只用 express 类型与 node 内置）；不越界实现 AC-243–AC-257。

## Touches

- server/modules/mcp-gateway/mcp-gateway.loopback.ts (new)
- server/modules/mcp-gateway/mcp-gateway.transport.ts
- server/modules/mcp-gateway/index.ts
- server/modules/mcp-gateway/tests/mcp-loopback-guard.test.ts (new)（判据）
- tasks/gap-ac242-mcp-loopback-guard-before-auth.md

## Notes

- 判据的 HTTP 调用用 `node:http` 不用 `fetch`：`listen(0)` 在本机会抽到 undici 拒绝的端口（见 `server/modules/debug-agent/tests/debug-agent-control-plane.test.ts` 与 AC-240 的同款说明）。
- 造远端地址的办法：`req.socket` 是 `IncomingMessage.prototype` 上的 getter，用 `Object.defineProperty(req, 'socket', { value: { remoteAddress }, configurable: true })` 定义 own property 覆盖它，使守卫读到伪造地址；真实回环读数不做伪造，走真 socket。这是本机不依赖 docker/LAN 网卡造出 `172.17.0.1` 等地址的可行办法。
- `MCP_OAUTH_ENABLED` 是本守卫唯一的开关依据（只判它是否开启，不叠加 `PUBLIC_BASE_URL` https 条件——后者是挂载 OAuth 路由的条件，见 SPEC §415）。`MCP_ENABLED` 是传输是否挂载的开关（AC-240），与本守卫正交。
- `isLoopbackRemoteAddress` 只认三个字面量，不扩大到 `127.0.0.0/8`：判据只要求这三个；多认地址就是多一条暴露面。
- `readMcpOauthEnabled` 不缓存：AC-240 的 gate 教训是缓存会挡住「同一进程读两种开关态」的判据。
- 后续任务边界：AC-243 词汇表 scope、AC-244 审计、AC-245+ 工具、AC-254/255 设置页、AC-256/257 冒烟；本任务只落地本机限制守卫与接线。
