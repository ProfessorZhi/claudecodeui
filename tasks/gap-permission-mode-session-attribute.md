---
id: gap-permission-mode-session-attribute
title: 权限模式作为服务端会话属性：随消息发送落库，客户端不再持久化
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状：权限模式（`default/auto/acceptEdits/bypassPermissions/plan`）只存在浏览器 localStorage —— 键 `permissionMode-<sessionId>` 与 `permissionMode-last-<provider>`（`src/modules/chat/hooks/useChatProviderState.ts` 约 410-450 行）。服务端只在每条消息里收到 `permissionMode` 并交给 SDK（`claude-runtime.provider.js:221`），不记录它。后果：同一会话换一台设备/浏览器打开，模式回落成默认值，且同一会话在两处的“当前模式”没有共同的权威来源。

裁定（用户已定）：**权限模式是会话的属性；客户端不持久化；只有消息实际发送到服务端后，服务端才保存它。** 不新增“切换即保存”的端点（不做 `active-permission-mode`），这一点与 model/effort 不同 —— 后者有切换即写的端点，权限模式没有。

先例：`sessions` 表已有 `model`、`effort` 两列，发送时由 `chat-websocket.service.ts`（约 253-260 行）经 `providerModelsService.setSessionModel/setSessionEffort` 写入，会话打开时经 `GET /api/providers/:provider/sessions/:sessionId/active-model` 读回。权限模式照此办理，不发明第二套机制。

方案：
1. **schema**：`sessions` 表加 `permission_mode TEXT` 列（NULL = 从未随发送记录过）。新库改 `SESSIONS_TABLE_SCHEMA_SQL`，既有库加一条 `addColumnToTableIfNotExists` 迁移（参照 `effort` 列的迁移，`migrations.ts` 约 454-463 行）。
2. **写入点**：`chat-websocket.service.ts` 处理发送时，若 `clientOptions.permissionMode` 是该 provider 的合法模式（对照 `provider-capabilities.service.ts` 的 `permissionModes`），写入该会话。非法值忽略，不报错、不写。仓储层新增 `setSessionPermissionMode`（`sessions.db.ts`）。
3. ⚠️ **首发竞态**：全新聊天第一次发送时会话行可能尚未建立（`setSessionEffort` 在 `readRecordedSessionSelection` 为空时直接返回 null，见 `provider-models.service.ts` 约 373 行）。权限模式必须覆盖“首条消息就带模式”的情形，不能像 effort 那样在会话行尚不存在时静默丢掉 —— 要么在会话行建立后补写，要么并入建行的 INSERT。以测试证明，不以推断代替。
4. **读取**：会话加载时把已记录的 `permissionMode` 随会话选择一并返回（扩展现有 `active-model` 响应，新增 `permissionMode` 字段，未记录则为 null），前端据此显示，不再读 localStorage。
5. **前端**：`useChatProviderState.ts` 删除 `permissionMode-<sessionId>` 与 `permissionMode-last-<provider>` 两个键的读写。已有会话：用服务端返回值，为 null 时用 provider 默认模式。全新聊天（尚无会话）：选择只留在内存，随第一条消息发出，不写任何存储。切换模式本身不发请求。
6. **分叉**：`sessions.service.ts` 约 303 行分叉会话时复制 `model/effort`，权限模式同样复制。
7. **旧键清理**：前端启动时不迁移旧值（旧值只在本机、且是被裁掉的客户端状态），但要清掉遗留键 `permissionMode-*`，避免残留数据误导排查。

范围外：`permissionMode-last-<provider>` 所承担的“新会话默认模式”这一偏好不在本任务内迁移；本任务下新聊天一律以 provider 默认模式起步，若要保留该偏好，另立任务走 `user_preferences`。这一取舍必须在 DoD 里如实登记。

<!-- dedup-ref -->
相关但不同机制：`gap-launch-profiles-permission-mode-and-suggestions`（状态 superseded）讨论的是由 launch profile 驱动模式，与“会话属性落库”不是同一机制，仅作追溯。

## AC

- [x] 迁移对新库与既有库都成立：`npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/sessions.db.integration.test.ts` 退出码 0，且其中含用例：既有库（无 `permission_mode` 列）升级后 `PRAGMA table_info(sessions)` 含该列且原有行数不变；新库直接含该列。
- [x] 发送时落库：新增 `server/modules/websocket/tests/chat-permission-mode.test.ts`，`npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/chat-permission-mode.test.ts` 退出码 0，覆盖：合法模式被写入；非法模式（不在该 provider 的 `permissionModes` 内）不写入；未带 `permissionMode` 的消息不改动已记录的值。
- [x] 首发竞态被证明而非推断：同一测试文件含“全新会话首条消息即带模式，会话行先于消息建立，读回值等于所发模式”的用例，且取假验证——把写入点注释掉后该用例必须判红。（修订说明：原措辞为“会话行随后建立”。实施中查明该前提在协议上不成立——会话行与其 id 由同一次 `createAppSession` 产生，客户端只能从该调用的应答里拿到 id，因此消息必然晚于会话行；同文件用例“首发竞态的前提不成立：会话行先于客户端可知的 id 存在”把这一点钉死，原设想的“行尚不存在时补写/并入 INSERT”两法因此都不需要，其机器也因此不写。被守护的不变式未改：首条消息即带模式、读回值等于所发模式、且注释掉写入点后该用例判红——已实测 `actual: null, expected: 'bypassPermissions'`，恢复后 6/6 绿。）
- [x] 读回与分叉：`active-model` 响应含 `permissionMode`（已记录返回值，未记录返回 null）；分叉会话继承源会话的模式。以 `server/modules/providers/tests/` 下的新增/既有用例覆盖，`npx tsx --tsconfig server/tsconfig.json --test <该文件>` 退出码 0。
- [x] 客户端不再持久化：`grep -rn "permissionMode-" src/ --include=*.ts --include=*.tsx | grep -v "/tests/" | grep -v "removeItem"` 无输出（只允许清理遗留键的 `removeItem`）。
- [x] 客户端行为：新增 `src/modules/chat/tests/sessionPermissionMode.test.tsx`，`npx vitest run src/modules/chat/tests/sessionPermissionMode.test.tsx` 退出码 0，覆盖：已有会话显示服务端返回值；服务端为 null 时回落 provider 默认；切换模式不触发任何写请求、不触碰 localStorage；全新聊天的选择只在内存并随首条消息发出。
- [x] 门：`npm run typecheck`、`npm run lint` 退出码 0；`bash scripts/test.sh --for-task gap-permission-mode-session-attribute` 退出码 0（scoped 自测；全量套件是 fan-in 的合并闸，不是 worker 自测）。

## DoD

真实落地判据：不是“列加了、测试绿了”就算完成。要求用一个**真实运行的服务端与真实浏览器状态**证明：(a) 在设备/浏览器 A 对某会话选择非默认模式并**发送一条消息**，随后清空 A 的 localStorage、或换到另一个浏览器 profile 打开同一会话，模式显示为 A 所发送的值；(b) 只切换模式而**不发送**，另一处打开同一会话仍看到发送前的值（“未发送不落库”的裁定被真实对象证实）；(c) 全新聊天首条消息带非默认模式，会话建立后重开读回同值。三条都以运行中的实例操作留证，不以单元测试代替。

如实登记的取舍：`permissionMode-last-<provider>` 的“新会话默认模式”偏好被丢弃（见 Proposal 范围外）；`bypassPermissions` 随会话继承到其他设备，本任务不加拦截，仅要求前端在该模式生效时保持既有的显著提示。若后两点需要改，另立任务。

实施前须加载并遵循 `.agents/skills/backend-module-standards/SKILL.md` 与 `.agents/skills/frontend-module-standards/SKILL.md`（分别用于 `server/` 与 `src/` 的改动）。

### 实施记录（三条判据的留证）

真实服务端以 `SERVER_PORT=47600 HOST=127.0.0.1 DATABASE_PATH=<tmp>/auth.db HOME=<tmp> npx tsx --tsconfig server/tsconfig.json server/index.ts` 启动（provider 凭据已从环境中剥离，故 SDK 立刻以 `Not logged in · Please run /login` 失败，不会产生任何真实模型调用；写入点在该 run 之前，不受影响），随后用真实 HTTP 与真实 WebSocket 驱动同一份协议：

- (a)/(c) 首个会话由 `POST /api/providers/sessions` 建行，读回 `permissionMode=null`；`chat.send` 首条消息带 `options.permissionMode=bypassPermissions` 后，A 读回 `bypassPermissions`。
- (a) 另一个**无任何本地状态**的新客户端读同一会话得同值 —— 该值只可能来自服务端，即“清空 A 的 localStorage / 换浏览器 profile”所要求的那件事。
- (b) `POST .../active-permission-mode` 返回 404：切换模式在协议上没有可发的写请求；切换之后服务端仍是发送时的值。另：一条不带 `permissionMode` 的消息之后值同样不变。
- (c) 全新会话首条消息带 `plan`，读回 `plan`。
- 全部检查 PASS。

诚实登记的偏差：浏览器侧那一半（真实客户端 hook + 真实 localStorage，清空后重载仍显示服务端值）在 jsdom 中执行，未使用真实 Chromium；服务端、WebSocket 与 SQLite 均为真实运行的实例。上列 (b) 的“不发送”以“协议上没有该写端点 + 值不变”证明，而非以浏览器点击证明。

## Touches

- server/modules/database/schema.ts
- server/modules/database/migrations.ts
- server/modules/database/repositories/sessions.db.ts
- server/modules/database/tests/sessions.db.integration.test.ts
- server/modules/websocket/services/chat-websocket.service.ts
- server/modules/websocket/tests/chat-permission-mode.test.ts (new)
- server/modules/providers/services/provider-models.service.ts
- server/modules/providers/services/sessions.service.ts
- server/modules/providers/provider.routes.ts
- server/modules/providers/tests/provider-models.service.test.ts
- server/modules/providers/tests/provider-token-usage.service.test.ts
- server/modules/providers/tests/provider.routes.test.ts
- server/modules/providers/tests/session-fork.test.ts
- server/shared/types.ts
- src/modules/chat/hooks/useChatProviderState.ts
- src/modules/chat/tests/sessionPermissionMode.test.tsx (new)
- tasks/gap-permission-mode-session-attribute.md
