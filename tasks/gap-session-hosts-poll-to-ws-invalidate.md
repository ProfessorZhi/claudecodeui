---
id: gap-session-hosts-poll-to-ws-invalidate
title: session-hosts 每秒轮询改为 WS 失效通知（hosts.changed {rev}）+ 慢速兜底轮询
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**症状（实测）**：Chrome DevTools 里 `GET /api/session-hosts` 约每秒一次（`src/shared/hooks/useSessionHosts.ts` 的 `REFRESH_INTERVAL_MS = 1000`，仅标签页隐藏时暂停）。该 store 已是全页单例，一个轮询器；每次请求在服务端还会扫描一次 CLI registry 目录（`session-hosts.routes.ts` 的 `readSessionOccupancy`）。忙/闲判定早已改由服务端推送的 activity 帧决定（见 gap-activity-single-dock-global-consistency），这个轮询如今只负责：列出常驻闲置进程、pid/地址/closeReason、`occupiedBy`——变化都很慢，1s 一次是浪费。

**机制**：服务端 host 状态变化集中在 `session-host-manager.service.ts` 少数几处同步赋值（`busy`/`lingering`/`idle`/`closed`/`starting`、bindSession/unbindSession），目前没有可订阅的变更事件，所以前端只能轮询。已有可复用的全局广播通道：`server/modules/websocket/services/session-upsert-broadcast.service.ts` 经 `connectedClients` 向所有 `/ws` 连接推 `session_upserted`；前端 `WebSocketContext` 提供 `subscribe(listener)` 与重连时的 `websocket_reconnected` 信号。

**方案（B+C）**：服务端只推「失效通知」，不推数据——REST `GET /api/session-hosts` 及其 `toHostView` 投影原样保留，不出现两份实现。
1. `sessionHostManager` 增加 `onChange(listener)`，在 host/binding 状态变化处 `rev++` 并通知；
2. WS 层经 `connectedClients` 向所有连接广播 `{kind:'hosts_changed', rev}`；**会话的创建/改名/改模式**（`sessions[]` 变化）也触发同一帧，让新建/改名不用等兜底轮询；
3. 前端 `useSessionHosts` 的 store 收到帧后按 `rev` 去重、约 250ms 合并，触发一次 `refreshSessionHosts()`；WS 连上（含重连，`websocket_reconnected`）时立即拉一次，补断线期间的变化；
4. **`occupiedBy` 不事件化**（它来自外部 CLI 进程的 registry，变化是分钟级，不引入 `fs.watch`）：由兜底轮询覆盖，间隔 30s；
5. 兜底：WS 连着时轮询降到 30s；WS 断开时回退到 2s，保持现有的新鲜度；标签页隐藏仍暂停。

## Plan

1. 服务端 `session-host-manager.service.ts`：加 `onChange` + `rev`，在全部状态赋值点与 bind/unbind/closeHost 处触发；在已有的 `session-host-lifecycle.test.ts` 里加 manager 级测试（每类转换恰好一次通知、订阅可取消）。
2. 服务端广播：在 websocket 模块新增 hosts 变更广播服务（沿用 `connectedClients`/`WS_OPEN_STATE`，经 barrel 导出）；`server/index.ts`（composition root）把 `sessionHostManager.onChange` 接到该广播；会话创建/改名/改模式路径（`sessions.service.ts` 等已调用 `broadcastSessionUpserted*` 之处）同样触发。模块边界按 backend-module-standards：session-hosts 不得直接 import websocket 内部文件，一律经 composition root 注入。
3. 前端 `useSessionHosts.ts`：保持模块级单例 store，把 WS 帧桥接进来（由挂在 `WebSocketProvider` 之下的一个小订阅点调用 store 的 `invalidate(rev)`）；实现 rev 去重 + 250ms 合并、连接状态感知的兜底间隔（30s/2s）、连上即拉。按 frontend-module-standards 放置。
4. 改写两个把 1000ms 间隔写死的测试（`hostSnapshotFailure.test.ts`、`occupiedSessionReadOnly.test.tsx`）为「帧驱动 + 兜底」模型；e2e `activity-dock-*.spec.ts` 里「面板不得取自 session-hosts 轮询」的断言保持成立，需复跑确认。
5. **不要新增 `server/**/*.test.ts` 文件**：该套件对 server 测试文件总数有固定计数，每新增一个文件都会让 fleet 红灯（driver 报 UNATTRIBUTABLE 并停止重派）。服务端广播的测试并入已有的 `server/modules/websocket/tests/activity-protocol.test.ts`，manager 测试并入 `session-host-lifecycle.test.ts`。若确实要新增，须先找到并同步上调该计数点，并把它列入 Touches。

## AC

- [x] `session-hosts` 在 WS 已连接且无状态变化时，30 秒窗口内对 `GET /api/session-hosts` 的请求数 ≤ 2（真浏览器 e2e，对网络请求计数；对照基线：改前同窗口约 30 次）。
- [x] 触发一次 host 状态变化（开始/结束一个 turn，或启动/关闭常驻进程）后，页面上 `ResidentMark`/`ResidentStatusBar` 在 1s 内反映新状态，且这期间没有依赖兜底轮询（把兜底间隔在测试里调到极大值仍通过）。
- [x] 新建会话/改名后，侧栏 `sessions[]` 驱动的读数（常驻标记所属行）在 1s 内更新，不等兜底轮询。
- [x] WS 断开时轮询回退到 ≤ 2s 间隔；WS 重连（`websocket_reconnected`）后立即拉取一次且状态收敛（单元测试用 fake timers 断言间隔与立即拉取）。
- [x] 服务端 manager 的 `onChange` 对每类状态转换恰好通知一次、可取消订阅；`hosts_changed` 帧只发给 `readyState === OPEN` 的连接（`node --experimental-strip-types --test` 单文件，exit 0）。
- [x] `GET /api/session-hosts` 的响应形状与 `toHostView` 投影不变（`server/modules/session-hosts/tests/session-hosts-routes.test.ts` 原样通过，不改断言）。
- [x] 改写后的 `hostSnapshotFailure.test.ts` 与 `occupiedSessionReadOnly.test.tsx` 通过，且这两个文件里不再有对 1000ms 轮询间隔的写死假设；`npm run typecheck` 与 oxlint（含 boundaries 规则）exit 0。

## DoD

真浏览器中打开真服务（不是 mock）：在空闲页面上用 DevTools / Playwright 网络计数证明 `/api/session-hosts` 请求频率从约 1 次/秒降到约 1 次/30 秒；随后在真实会话上开始并结束一个 turn、启动并关闭一个常驻进程、新建并改名一个会话，逐一证明状态读数在 1s 内更新；再断开并恢复 WS，证明回退轮询与重连即拉取。只有单元测试通过而没有真浏览器计数不算完成。

## Touches

- server/modules/session-hosts/session-host-manager.service.ts
- server/modules/session-hosts/tests/session-host-lifecycle.test.ts
- server/modules/websocket/services/hosts-changed-broadcast.service.ts
- server/modules/websocket/index.ts
- server/modules/websocket/tests/activity-protocol.test.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/tests/session-rename-route.test.ts
- server/index.ts
- server/shared/types.ts
- src/shared/hooks/useSessionHosts.ts
- src/shared/context/WebSocketContext.tsx
- src/shared/types.ts
- src/modules/chat/tests/hostSnapshotFailure.test.ts
- src/modules/chat/tests/occupiedSessionReadOnly.test.tsx
- e2e/session-hosts-poll-rate.spec.ts
- tasks/gap-session-hosts-poll-to-ws-invalidate.md
