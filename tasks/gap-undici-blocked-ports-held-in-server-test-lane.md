---
id: gap-undici-blocked-ports-held-in-server-test-lane
title: server 测试通道占住 undici 拦截的 18 个端口，消除 listen(0) 路由测试的 bad port 随机红
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**现象。** server 测试里有 40 个文件、57 处 `app.listen(0, '127.0.0.1')` 之后再用全局 `fetch` 打回自己。内置 undici 对 18 个端口直接拒绝，错误是 `TypeError: fetch failed`、`cause: Error: bad port`，发生在打开 socket 之前：`1719 1720 1723 2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6697 10080`。本机 `/proc/sys/net/ipv4/ip_local_port_range` 是 `1024 65535`，内核给 `listen(0)` 分配端口时可能正好落在这 18 个里，于是该文件随机红，单独重跑就绿。

**实测（2026-10-05）。** 同一个任务在两次 fan-in 里先后红在 `server/modules/commands/tests/commands.test.ts`（`commands.test.ts:73`）和 `server/modules/websocket/tests/activity-protocol.test.ts`（`activity-protocol.test.ts:226`），都是 `bad port`，都和任务 delta 路径不相交，单独各跑 3 次都是 exit 0。红的文件每轮不同，是这类抽签的特征。连续两次判成「归因不出失败文件」让 driver 把一个已经做完的任务停成 needs-human，所以这不只是偶发噪声，而是在消耗派发轮次。

**机制不是某个测试的缺陷，所以不逐文件修。** 40 个测试文件都在各自任务的 Touches 之外，逐个改会触发 anti-drift 硬失败，也要在 57 处各自加重试。修在**一处**：让 server 测试通道里的进程占住这 18 个端口，内核就不会再把它们分给 `listen(0)`。做法：新增一个 `--import` 预加载模块，启动时对 `127.0.0.1`（必要时再对 `::1` 与 `0.0.0.0`，由实现按「内核实际如何避让」实测决定）逐个 `listen` 这 18 个端口，调用 `server.unref()` 使其不阻止进程退出，遇到 `EADDRINUSE` 等错误一律吞掉（端口已被别的进程占着，同样达到目的）。把预加载接到 server 通道的两处 `tsx` 调用上：`package.json` 的 `test:server`，以及 `scripts/test.sh` 里按文件跑 server 测试的两处 `npx tsx --tsconfig server/tsconfig.json --test "$f"`。

**生命周期要实测，不要假设。** `node --test` 的子进程是否继承父进程的 `--import`，决定占端口的是 runner 父进程（整轮持有，最好）还是每个子进程各自占一份（子进程之间互相 EADDRINUSE，也能覆盖）。两种都可以，但要实测并把读数写进验收记录。

**边界。** 不改任何 `server/**/*.test.*` 文件；不改产品代码；不改 undici 或 Node；不降低 `--test-concurrency` 上限；预加载失败（例如全部端口已被占）不得让测试通道起不来。

## Touches

- scripts/undici-blocked-ports-preload.mjs (new)
- scripts/undici-blocked-ports-preload.test.mjs (new)
- scripts/test.sh
- package.json
- tasks/gap-undici-blocked-ports-held-in-server-test-lane.md

## AC

- [x] `node --test scripts/undici-blocked-ports-preload.test.mjs` 退出码 0：测试起一个带 `--import ./scripts/undici-blocked-ports-preload.mjs` 的常驻子进程，父进程随后对 18 个端口逐个尝试 `listen`，逐个报 `EADDRINUSE`；父进程启动前已被别的进程占着的端口从判据中剔除并在输出里列出，且被验证的端口至少 12 个
- [x] 同一测试的负控制：不带预加载的同样子进程，父进程对同一批端口能成功绑定（得到至少 12 个成功），证明上一条的 `EADDRINUSE` 来自预加载而不是端口本来就被占
- [x] 同一测试：事先占住 `6000`，再带预加载启动一个空进程，该进程退出码 0（不因 `EADDRINUSE` 抛错）；且一个什么都不做的带预加载进程在 5 秒内自行退出（`unref` 生效，不挂住）
- [x] 接线：`grep -n -- '--import' package.json scripts/test.sh` 显示 `test:server` 与 `scripts/test.sh` 的两处 server 测试调用都带 `undici-blocked-ports-preload.mjs`，其余通道（client、scripts、e2e）不带
- [x] 真实通道读数：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/commands/tests/commands.test.ts server/modules/websocket/tests/activity-protocol.test.ts` 退出码 0；并在该命令运行期间用 `ss -ltn` 读到这 18 个端口中被验证的那些处于 LISTEN 且归属测试进程树
- [x] 零测试文件改动：`git diff --name-only develop...HEAD | grep -E '^server/.*\.test\.'` 无输出（退出码 1）
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0

## DoD

真实落地，不是「脚本存在」：合入 develop 后，在 develop 上跑一次完整的 `npm run test:server`（或 `bash scripts/test.sh` 的 server 阶段），运行期间用 `ss -ltn` 实测 18 个被拦截端口中的可验证者处于 LISTEN，整轮 server 阶段无 `bad port` 字样（对 suite 日志 grep `bad port` 得 exit 1）。把「`node --test` 子进程是否继承 `--import`、占端口的是父进程还是各子进程」的实测结论写进验收记录。此改动只消除这一类随机红，不声称消除其他 fan-in 红因；若实测发现内核对 `0.0.0.0`/`::` 的避让规则使仅绑 `127.0.0.1` 不够，应按实测扩大绑定范围，而不是放宽判据。
