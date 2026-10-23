---
id: gap-static-assets-compression
title: 生产形态静态资源与 SPA 入口开启 gzip 压缩（仅限 dist 静态资源，不动 API 与 WebSocket）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状：生产形态下 `server/index.ts` 用 `express.static` 提供 `dist/`（约 203-227 行），**响应不带任何 `content-encoding`**。`package.json` 依赖里没有 `compression`，`node_modules/compression` 不存在，仓库里也没有别处做压缩。后果：主 JS `dist/assets/index-*.js` 约 3,059,430 字节原样传输，构建输出显示它 gzip 后约 886 KB。

证据（2026-09-21 实测，经 zrok 隧道、浏览器冷加载）：新生产形态冷加载约 **23 秒**（22.4 / 23.0 秒，n=2），11 个请求、约 4.6 MB；同一隧道的带宽上限约 0.2–0.5 MB/s（旧 dev 会话 `af690528…` 测得 0.2–0.5，本次下载 3 MB JS 测得 0.125–0.38），所以冷加载时间 ≈ 字节数 ÷ 隧道带宽，压缩传输量是缩短冷加载最直接的杠杆。回访已是约 1.7 秒（哈希资源 `immutable` 长期缓存），不在本任务范围。

方案：
1. **依赖**：把 `compression` 加进 `package.json` 的 `dependencies`（不是 devDependencies —— `scripts/release/build-server-bundle.js` 打包时只装生产依赖），同步 `package-lock.json`。选与 Express 4 兼容的版本；若所选版本支持 brotli（`br`）就一并启用，不支持则只做 gzip，**以实际行为为准，不预设**。
2. **挂载位置是关键，也是本任务最主要的风险点**：`app.use(compression())` 必须放在**所有 `/api/*` 路由注册之后、`express.static(public)` 之前**（即 `server/index.ts` 里 `app.use('/api/voice', …)` 之后、`app.use(express.static(… 'public'))` 之前），这样只有落到静态资源与 SPA 入口（`app.get('*')` 返回的 `index.html`）的请求会被压缩。放在更前面会把 SSE、语音 TTS 音频流、文件下载等流式/已压缩响应一并卷入 —— 它们对缓冲和压缩敏感，本任务**明确不碰**。WebSocket 升级不经过 Express 中间件，不受影响，但仍要在 DoD 里实测确认。
3. **可测性**：`server/index.ts` 是启动入口，不便在单测里直接拉起。按 `.agents/skills/backend-module-standards/SKILL.md` 的模块规范，把静态资源挂载抽成一个小模块 `server/modules/static-assets/`（`static-assets.module.ts` 导出一个 `createStaticAssetsMiddleware(distDir, publicDir)` 之类的工厂，`index.ts` 为 barrel），`server/index.ts` 只调用它。抽取时**保持现有的缓存头行为逐字不变**：HTML → `no-cache, no-store, must-revalidate` 加 `Pragma`/`Expires`；`js/css/woff/woff2/ttf/eot/svg/png/jpg/jpeg/gif/ico` → `public, max-age=31536000, immutable`。若实施者选了不同的文件名，须先改本任务 Touches。
4. **压缩范围**：只压文本类（默认的 `compression` 过滤已按 `Content-Type` 判断）；保留默认的 1 KB 阈值；已压缩的 PNG/JPG/WOFF2 不重复压缩。`Vary: Accept-Encoding` 必须存在（否则缓存层可能把压缩体发给不支持的客户端）。
5. **不做**：预压缩产物（`vite-plugin-compression` 加 `express-static-gzip`）不在本任务内 —— 它省 CPU 但增加构建复杂度，等运行时压缩证明不够用再评估；dev server 的压缩不在范围内（dev 形态不受本任务影响）。

## AC

- [x] 依赖登记为生产依赖：`node -e "const p=require('./package.json');process.exit(p.dependencies&&p.dependencies.compression?0:1)"` 退出码 0，且 `npm ls compression` 退出码 0。
- [x] 压缩行为：新增 `server/modules/static-assets/tests/static-assets.test.ts`，`npx tsx --tsconfig server/tsconfig.json --test server/modules/static-assets/tests/static-assets.test.ts` 退出码 0，覆盖（在临时目录里造一个 dist，含 ≥200 KB 的 JS、一个 HTML、一个 PNG）：带 `Accept-Encoding: gzip` 请求 JS → 响应 `content-encoding` 为 `gzip`、解压后与原文件字节一致、**传输字节数明显小于原文件**；不带 `Accept-Encoding` → 无 `content-encoding` 且体与原文件一致；响应带 `Vary: Accept-Encoding`；PNG 不被重复压缩。（原句写「`content-length` 明显小于原文件」——`compression` 压缩时会 `removeHeader('Content-Length')` 改用 chunked，该头不存在，故按实际收到的字节数断言；修订理由见「本任务对 AC 的修订」一节。）
- [x] 缓存头逐字不变：同一测试文件断言，压缩开启后 JS 的 `Cache-Control` 仍为 `public, max-age=31536000, immutable`，HTML 仍为 `no-cache, no-store, must-revalidate` 且带 `Pragma: no-cache`、`Expires: 0`；且**取假验证**——把缓存头设置删掉后这些用例必须判红。
- [x] SPA 入口也被压缩：同一测试文件断言，对不存在的路径（如 `/some/route`）带 `Accept-Encoding: gzip` 请求，返回的 `index.html` 有 `content-encoding: gzip` 且解压后等于 `dist/index.html`。
- [x] 挂载位置正确（不卷入 API）：`awk '/app\.use\(.\/api\//{a=NR} /createStaticAssetsMiddleware|compression\(/{c=NR} END{exit !(a&&c&&c>a)}' server/index.ts` 退出码 0，即压缩/静态挂载的行号大于最后一个 `/api` 路由挂载的行号。
- [x] 门：`npm run typecheck`、`npm run lint`、`npm run build:server` 退出码 0；`bash scripts/test.sh --for-task gap-static-assets-compression` 退出码 0（scoped 自测；全量套件是 fan-in 的合并闸，不是 worker 自测）。

## DoD

真实落地判据：要用**真实运行的生产形态实例**证明，不以单测代替。(a) 对运行中的服务执行 `curl -sI -H 'Accept-Encoding: gzip' http://localhost:3001/assets/index-*.js`（取 `dist/index.html` 里引用的实际文件名），响应含 `content-encoding: gzip`，且实际传输的字节数（`curl --compressed -w '%{size_download}'`）约在 900 KB 量级而不是 3,059,430；(b) 经 zrok 隧道用浏览器做一次**冷加载**（全新 context，带 `skip_zrok_interstitial: 1` 头，与 2026-09-21 的基线同法），记录耗时并与基线 **约 23 秒**对比 —— 期望明显缩短，但**不预设具体数字**，实测多少写多少；若没有明显改善，如实登记，并说明是隧道带宽之外还有别的瓶颈；(c) 真实确认没有被误伤：在同一实例上完成一次真实的聊天往返（WebSocket 正常）、语音 `/api/voice/health` 返回 200、至少一个 `/api/*` 响应**不带** `content-encoding`（证明 API 没被卷入）。三条都留操作记录。

如实登记的取舍：运行时压缩每次请求消耗少量 CPU（`compression` 不缓存压缩结果）；本机上对 3 MB JS 的单次 gzip 开销须在 DoD 记录里给出实测（例如同一文件连续请求 20 次的耗时），若显著（例如单次 >200 ms）再评估预压缩，不在本任务内预先实现。样本量：基线冷加载 n=2，压缩后的复测也应至少 n=2。

实施前须加载并遵循 `.agents/skills/backend-module-standards/SKILL.md`（本任务只改 `server/`）。

L_D 该轴仍暗，理由：本任务是传输层优化，不新增领域能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上；本任务的验证读数是 DoD 里的字节数与冷加载耗时。

## 实测记录（2026-09-21，worker 落地）

### 环境
- 实例：`node dist-server/server/index.js`，`HOST=0.0.0.0 SERVER_PORT=3001`，worktree `/data/home/yale/work/claudecodeui-worktrees/gap-static-assets-compression`（启动日志 `Installed at:` 指向该 worktree）。
- 隧道：zrok 既有 share `z9xabda1q01z.shares.zrok.io` → `http://localhost:3001`（与本任务立项时的基线同一 share）。
- 被测产物：`dist/assets/index-BATA8nUY.js`，3,061,516 字节 —— 与基线指向的是**同一份 bundle（文件名 hash 一致）**，所以 A/B 只差传输编码。

### (a) 传输字节
- `curl -s -D- -o /dev/null -H 'Accept-Encoding: gzip' http://localhost:3001/assets/index-BATA8nUY.js` → `Content-Encoding: gzip`、`Vary: Accept-Encoding`、`Cache-Control: public, max-age=31536000, immutable`、`Transfer-Encoding: chunked`。
- 传输字节：gzip 886,459；brotli 843,037；不给编码 3,061,516 → gzip 约为原文件的 **29%**。
- **对 DoD (a) 命令形态的修订**：`curl -sI`（HEAD）拿不到 `content-encoding`，因为 `compression` 对 HEAD 请求显式跳过编码（`node_modules/compression/index.js:205`，`nocompress('HEAD request')`：HEAD 没有响应体可压），而 `Vary` 在更早一行（:188）已设置，所以 HEAD 只看到 `Vary`。故改用 GET 记录（`-D-` 打印响应头 + `-o /dev/null` 丢弃体），这是真实的字节传输路径。

### (b) 冷加载（同一 share，同法：playwright chromium、全新 context、`skip_zrok_interstitial: 1`）
- 本会话基线复测（压缩前，n=2）：**11,078 / 9,014 ms**，传输 4,384 KB。
- 压缩后（n=3）：**2,555 / 2,978 / 3,031 ms**，传输 1,228 KB。
- 相对同会话基线缩短约 3.0–4.3×；相对立项基线（22.4 / 23.0 s）缩短约 7–9×。
- 说明：立项基线 23 s 与本会话基线 9–11 s 的差来自隧道带宽本身随时间波动（同为 4,384 KB：23 s ≈ 0.19 MB/s，11 s ≈ 0.40 MB/s），所以 A/B 只在同一会话内自洽；两组数字都记录在案，不做跨会话相除。
- 三个 run 的 `decodedBodySize` = 4,396 KB 而 `transferSize` = 1,228 KB，即浏览器收到的是压缩体并透明解压。

### (c) 未误伤
- **聊天往返**：`POST /api/providers/sessions`（provider `claude`）建新会话 → `ws://127.0.0.1:3001/ws?token=…` 发 `chat.send`，收到 `kind=complete`、`exitCode=0`、`success:true`；provider 会话 `ec87140f-89e4-4983-a2e1-041351115494` 的 transcript 里落的是 `USER: Reply with exactly: pong` / `ASSISTANT: pong`。
- **隧道 WebSocket**：`wss://z9xabda1q01z.shares.zrok.io/ws?token=…` 升级返回 **101**，`chat.subscribe` 收到 `chat_subscribed`（`lastSeq: 4`）—— WebSocket 升级不经 Express 中间件，证实未被卷入。
- **语音**：`GET /api/voice/health` → **200**、`Content-Length: 20`、**无** `content-encoding`（经隧道同样是 200 / 20 字节 / 无 `content-encoding`）。
- **其余真实 API 载荷同样不被压缩**：`/api/projects`（21,603 字节）、`/api/auth/status`（44 字节）、`/api/git/status` —— 都没有 `content-encoding`，也**没有** `Vary`，说明这些请求根本没进压缩中间件。
- 一个**不改变结论的既有行为**（记录以避免误读）：`GET /api/settings`、`/api/user`、`/api/notifications`（裸路径，各自 router 内没有对应 GET 路由）会落到 SPA 兜底返回 `index.html`，因此带 `content-encoding`（1,029 字节 gzip → 2,564 字节）。改动前这三个请求同样是返回 `index.html`（只是不压缩），路由行为未变；变的是这段 HTML 现在被压缩，正是本任务要的效果。
- SPA 入口经隧道：`/some/route` → 200、`content-encoding: gzip`、1,029 → 2,564 字节，且 `cache-control: no-cache, no-store, must-revalidate` + `pragma: no-cache` + `expires: 0` 逐字保持。

### CPU 取舍（单次 3 MB JS）
- 纯 zlib：gzip 约 **52–54 ms/次**；brotli quality 4（`compression` 的默认档）约 **31–39 ms/次**。
- 端到端本机请求均值：gzip 57.7 ms（20 次，min 55.8 / max 62.6）对不压缩 3.5 ms（20 次）⇒ 压缩成本约 54 ms/次；brotli 43.7 ms（20 次）。
- 均远低于 DoD 的 200 ms 阈值，故**不**在本任务内引入预压缩产物。
- brotli 实测优于 gzip（体更小 843 KB vs 886 KB，且更快），`compression@1.8.2` 在客户端提供 `br` 时默认优先 `br`（`hasBrotliSupport` → `PREFERRED_ENCODING = ['br','gzip']`），无需额外开关；`Accept-Encoding: gzip` 时仍返回 gzip。

### 本任务对 AC 的修订
- **AC2** 原句要求「`content-length` 明显小于原文件」。`compression` 压缩时执行 `res.removeHeader('Content-Length')` 并改用 chunked（`node_modules/compression/index.js:247`），所以压缩响应**没有** `content-length` 头，原句无法按字面成立。已把它收窄到它要守的不变量——「传输字节数明显小于原文件」——断言落在实际收到的字节数上；测试里同时断言压缩响应的 `content-length` 为 `undefined`，把这个机制本身也钉住，避免以后有人误以为它还在。DoD (a) 的读数即该不变量的端到端证据。
- **DoD (a)** 的命令由 `curl -sI`（HEAD）改为等价的 GET（理由见上）。

## Touches

- package.json
- package-lock.json
- server/index.ts
- server/modules/static-assets/static-assets.module.ts (new)
- server/modules/static-assets/index.ts (new)
- server/modules/static-assets/tests/static-assets.test.ts (new)
- tasks/gap-static-assets-compression.md
