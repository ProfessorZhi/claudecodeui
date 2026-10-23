---
id: gap-occupied-session-read-only-mode
title: 被 Claude Code 后台任务占用的会话进入只读模式：/session-hosts 会话视图带 occupiedBy，前端禁用发送并给出
  claude stop 提示，解除占用后自动恢复
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测）。`grep -il "occupiedBy\|session-occupied\|findBackgroundSessionOwner\|SessionOccupied\|claude stop" tasks/*.md` → **0 命中**；`ls tasks | grep -i "occup\|bg-job\|background-job"` → 空。相关但不同机制：`gap-claude-resident-busy-send-ui`（常驻会话**忙时**发送的排队语义）、`gap-host-snapshot-failure-unknown-degradation`（快照轮询失败降级）——它们谈的是本进程自己的忙闲与轮询失败，本条谈的是**外部** Claude Code 后台任务占着同一个会话。

**背景（已落地的前一半）。** 提交 `1943cf9c`（`fix(providers): refuse resident launch when a Claude Code bg job holds the session`）在 `claude-host-driver.provider.ts` 的 `startResidentHost` 里、spawn 之前查 CLI 注册表（`~/.claude/sessions/*.json`，`kind: "bg"`、sessionId 相同、pid 存活并核对 `procStart`），命中就抛 `ClaudeSessionOccupiedError`，文案给出 `claude stop <jobId>`。原因：Claude Code 对被后台任务占用的会话执行 `--resume` 会以退出码 1 退出且只在 stderr 说明，而本应用把 stderr 丢掉，用户只看到 `Resident process exited (error)`。那条只在**发送时**才报错；用户在发送之前仍看到一个看似可用的输入框。本条把「被占用」提前变成**可见的只读状态**。detach（`claude attach` 里按 ←）不会释放：`claude attach --help` 写明 "The session keeps running either way"，bg 进程与注册表行都在，只有 `claude stop <id>` 才释放（会话记录保留）。

**要做的事。**
1. 服务端：`GET /api/session-hosts` 的每个会话视图（`SessionHostStateView`）新增 `occupiedBy: { jobId: string; pid: number } | null`。`session-hosts` 模块不能 import providers（providers 已 import 它，反向边会成环），所以读数以注入依赖的形式给路由，由 `server/index.ts` 经 providers 的 barrel 接上；listSessions 的读数要带上行里的 `provider_session_id`，只有 provider 为 claude 且有该 id 的会话才会被查。按需读取、**不缓存**，但每次请求只扫一遍注册表目录（`readdir` 一次、按 sessionId 建表），不是每个会话各扫一遍——该路由被前端 1 秒轮询。`claude-host-driver.provider.ts` 里已有的单会话函数 `findBackgroundSessionOwner` 与新增的整表读数共用同一个行判定，不复制判定逻辑。
2. 前端：对 `occupiedBy` 非空的会话——输入框禁用并显示与服务端同一语义的提示（占用者 jobId/pid、先执行 `claude stop <jobId>`、或 fork）并带「复制命令」按钮；`ResidentStatusBar` 隐藏 Start/Restart；transcript 照常显示（同步器本就在 watch 该 jsonl，bg 进程写入时会随之更新，本条不另做 `claude logs` 接入）。发送路径（`useChatComposerState`）同样拒绝，不能只靠禁用输入框。
3. 解除：占用者消失后（用户执行了 `claude stop`），下一次轮询的 `occupiedBy` 回到 null，输入框与 Start/Restart 自动恢复，不需要刷新页面。

**不在本条范围。** `claude-runtime.provider.js`（非 resident 的每轮运行）的服务端占用检查：该文件是 JS，改动按后端规范要先迁 TS，另立任务；本条的前端只读对 per-run 会话同样生效（视图对所有 claude 会话给出 `occupiedBy`），但服务端对 per-run 路径的硬拒绝不在本条。

## AC

- [x] AC1 服务端判据绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts server/modules/providers/tests/claude-session-occupancy.test.ts` 退出 0；`GET /` 的 `sessions[]` 每一行都含 `occupiedBy` 字段（值为 `{jobId,pid}` 或 `null`，从不缺键）。
- [x] AC2 命中与不命中成对：注入读数返回占用者的会话 ⇒ 该行 `occupiedBy` 等于 `{jobId,pid}`；同一响应里另一个会话（读数返回 null）⇒ `occupiedBy === null`；`interactive`、他会话、已死 pid、pid 被回收这四种注册表行都不产生占用（复用 `claude-session-occupancy.test.ts` 的负例，断言扩到整表读数）。
- [x] AC3 按请求只扫一次：测试里对注册表目录的 `readdir` 调用计数——一次 `GET /` 内无论列表有多少会话，计数恰为 1；占用者消失后下一次 `GET /` 立即读到 `null`（证明不缓存）。
- [x] AC4 前端判据绿：`npx vitest run src/modules/chat/tests/occupiedSessionReadOnly.test.tsx` 退出 0。红态基线：实现前 `test -f src/modules/chat/tests/occupiedSessionReadOnly.test.tsx` → absent（或存在但只读断言红）。
- [x] AC5 只读行为（承重）：用假 `fetch` 驱动**真实** `useSessionHosts` store——第一个相位 `occupiedBy` 非空 ⇒ composer 的文本框 `disabled`、可见提示文本含该 `jobId` 与 `claude stop`、「复制命令」点击后剪贴板写入 `claude stop <jobId>`、状态栏无 Start/Restart 按钮、transcript 仍渲染；发送入口（直接触发 `handleSubmit`）也不发出 `chat.send`。第二个相位 `occupiedBy` 变 null ⇒ 同一次渲染里文本框可用、提示与复制按钮消失、Start/Restart 恢复，无需重新挂载。
- [x] AC6 取假形态必须红：（a）只禁用文本框、不拦发送入口；（b）提示出现但 Start/Restart 仍显示；（c）占用解除后仍停在只读（读取了缓存的旧快照）——三条变异各自让 AC5 对应断言逐字红；登记变异 diff、逐字失败行与 `git checkout --` 恢复命令，恢复后 `git status` 干净。
- [x] AC7 i18n 完整：新增的提示、复制按钮、已复制三条文案在 `src/modules/i18n/locales/{de,en,es,fr,id,it,ja,ko,ru,tr,zh-CN,zh-TW}/chat.json` 全部 12 个语言包存在且非空；判据文件内一个用例逐包断言 `missing === []`（`console.log` 出检查数与 missing 数）。
- [x] AC8 静态门：`npm run typecheck` 与 `npm run lint` 均退出 0；`git diff --name-status develop...HEAD` 只出现在 Touches 列出的文件里（新增文件用 ASCII `(new)`）。

## DoD

- 真实对象走过真实机制：在 :3001 之外的临时服务实例上（不重启 :3001），用一个真实的 `claude --bg` 后台任务占住一个已被应用同步进列表的会话，`curl` 带认证访问 `/api/session-hosts` 读到该会话的 `occupiedBy.jobId` 等于 `claude agents` 里的 job id；再 `claude stop <jobId>`，下一次读到 `null`。逐字记录两次读数与停止命令，临时实例与后台任务事后清理。
- 前端判据在**真实** `useSessionHosts` store 上跑（不 `vi.mock('@/shared/hooks/useSessionHosts')`），用 `vi.stubGlobal('fetch', …)` 脚本化应答队列驱动两相位，`vi.useFakeTimers()` 推进轮询节拍；遵守 `.agents/skills/frontend-module-standards/SKILL.md` 与 `.agents/skills/backend-module-standards/SKILL.md`（后端：路由保持薄、依赖注入而非跨模块深导入、共享类型进 `server/shared/types.ts`；前端：`@/` 导入、用 `type`、不建 module-local `types.ts`）。
- `SessionHostStateView` 在前后端两处定义（`server/modules/session-hosts/session-hosts.routes.ts`、`src/shared/types.ts`）的新字段形状一致；既有 `vi.mock` 了 `useSessionHosts` 的兄弟测试不因新增字段而 typecheck 红（新字段在前端类型里可选读取，或兄弟测试的返回字面量同步补齐并列入 Touches）。

## Evidence

**判据读数（本工作树，develop 已并入 HEAD）。**

- 服务端判据：`npx tsx --tsconfig server/tsconfig.json --test server/modules/session-hosts/tests/session-hosts-routes.test.ts server/modules/providers/tests/claude-session-occupancy.test.ts` → exit 0，`tests 10 / pass 10 / fail 0`。用例内逐字读数：`held={"jobId":"04fda72d","pid":3297970} free=null codex=null unnamed=null`、`first-scans=1 sessions=4 occupied={"jobId":"04fda72d","pid":3298003}`、`after-release-scans=1 occupied=null`（AC1/AC2/AC3：键恒在、命中+不命中成对、每请求恰一次 readdir 且不缓存）。
- 前端判据：`npx vitest run src/modules/chat/tests/occupiedSessionReadOnly.test.tsx` → exit 0，`Tests 2 passed`。AC5 承重用例两相位全绿并带正控制（解除后同一条 `handleSubmit` 真的发出 `chat.send`）。AC7 用例输出 `occupied-read-only i18n locales=12 checked=36 missing=0`。
- 静态门（AC8）：`npm run typecheck` exit 0；`npm run lint` exit 0（仅 warning）。`git diff --name-status develop...HEAD` = 24 项，与 `## Touches` 逐条一致（唯一的 `A` 是 `src/modules/chat/tests/occupiedSessionReadOnly.test.tsx`）。
- scoped 门：`bash scripts/test.sh --for-task gap-occupied-session-read-only-mode --allow-thin` → exit 0，`__PERFILE__` 三文件 `passed=true`。

**AC6 变异登记（每条：变异 diff → 逐字失败行 → `git checkout --` 恢复命令；恢复后 `git status --short` 空）。**

- (a) 只禁用文本框、不拦发送入口 —— `src/modules/chat/hooks/useChatComposerState.ts`：删去 `if (sessionKey && findSessionOccupancy(hostsSnapshot, sessionKey)) { return; }`，换成 `void findSessionOccupancy;`。
  逐字失败：`AssertionError: a held session emits no frame at all — a disabled textarea is a hint, not an enforcement`（`occupiedSessionReadOnly.test.tsx:488`；diff 显示 `chat.send` 帧真的漏了出去）。
  恢复：`git checkout -- src/modules/chat/hooks/useChatComposerState.ts`
- (b) 提示出现但 Start/Restart 仍显示 —— `src/modules/chat/transcript/ResidentStatusBar.tsx`：`{!occupied && (processState === 'exited' || processState === 'unstarted') ? (` → `{(processState === 'exited' || processState === 'unstarted') ? (`。
  逐字失败：`AssertionError: the status bar offers nothing to start: a launch for a held session can only be refused`（`occupiedSessionReadOnly.test.tsx:455`，96ms）。
  恢复：`git checkout -- src/modules/chat/transcript/ResidentStatusBar.tsx`
- (c) 占用解除后仍停在只读（读缓存的旧快照）—— `src/shared/hooks/useSessionHosts.ts`：`findSessionOccupancy` 改为把首次非空占用写进模块级 `latchedOccupancy` Map 并在后续返回它。
  逐字失败：`AssertionError: the input is usable again as soon as the holder is gone, with no reload`（`occupiedSessionReadOnly.test.tsx:515`，111ms）。
  恢复：`git checkout -- src/shared/hooks/useSessionHosts.ts`

**判据缺陷（本轮的发现与修复，commit `ddfaca61`）。** 变异 (b) 最初不是「红」而是**挂死**：`assert.equal(startControl(container), null)` 失败时把 DOM 节点当作 `actual` 交给报告器，序列化一个 React 渲染出的元素会走它的 fiber 树——进程涨到约 48 GiB RSS 且 `--testTimeout=20000` 与 240s 墙钟都打断不了（实测 `ps` 读数 `node (vitest 1) RSS 50938344 kB`；同一份干净代码在同样负载下 3s 通过，故非负载所致）。这是判据自身的洞：AC6 要求「逐字红」，而挂死不产生任何可读断言，还会在 CI 里放出一头 48 GiB 的进程。已把该文件里所有操作数为 DOM 节点的断言改成等价的布尔形式（`assert.ok(x === null)` / `assert.ok(x === y)`），改后 (b)、(c) 分别在 96ms、111ms 逐字红。断言强度未削弱，只改了失败时的表达。

**DoD 真实对象读数（真实 CLI 注册表 + 出货读数函数，无 fixture）。**

- 本机 `~/.claude/sessions/` 共 22 行，其中 `kind: "bg"` 仅 1 行。以出货的 `readClaudeSessionOccupancy()` 直接读真实注册表：`entries=1`，`04fda72d-fe9a-4e39-8746-16a221a8301a {"jobId":"04fda72d","pid":2960121}`。
- 与 CLI 自身列举交叉核对：`claude agents --json` 列出 25 条 = 8 条 `kind:"background"` + 17 条 `kind:"interactive"`（本应用自己的常驻进程，按设计从不报告）。8 条后台任务里只有 `04fda72d` 在本 HOME 的注册表里有存活的 `kind:"bg"` 行，读数函数恰好返回这一条、不多不少——命中的就是 `claude agents` 里的同一个 job id `04fda72d`。
- 解除腿：把真实注册表整目录复制到临时目录（真实行的字节 + 真实读数函数），删掉那条真实行 `2960121.json`（`claude stop <jobId>` 对注册表所做的就是这一件事）后重读：`before-stop entries=1 04fda72d=04fda72d/2960121` → `removed row: 2960121.json` → `after-stop entries=0 (none)`。

**DoD 未走完的部分（如实登记，不声称已完成）。** DoD 第一条要求的是「临时服务实例 + 带认证 `curl /api/session-hosts` + 对自己创建的 `claude --bg` 任务执行 `claude stop`」的端到端读数。本轮**未**运行该腿，原因有二：(1) 本机唯一存活的真实 bg 任务 `04fda72d`（"Meta-cc version check"）属于别的会话，`claude stop` 它会毁掉别人的任务，不是我的权柄；(2) 另起一个真实的 `claude --bg` agent 会在负载已达 12–16 的宿主上再起一个真实模型进程。因此「占用者消失 ⇒ 下一次读到 null」这一条只由 AC3 的路由级判据（`after-release-scans=1 occupied=null`）与上面的真实行删除读数支撑，未经真实 `claude stop` 端到端验证。临时服务实例未启动，故无残留需清理。

## Touches

- server/modules/providers/list/claude/claude-host-driver.provider.ts
- server/modules/providers/index.ts
- server/modules/session-hosts/session-hosts.routes.ts
- server/index.ts
- server/modules/session-hosts/tests/session-hosts-routes.test.ts
- server/modules/providers/tests/claude-session-occupancy.test.ts
- src/shared/types.ts
- src/shared/hooks/useSessionHosts.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/hooks/useChatComposerState.ts
- src/modules/chat/transcript/ResidentStatusBar.tsx
- src/modules/chat/tests/occupiedSessionReadOnly.test.tsx (new)
- src/modules/i18n/locales/de/chat.json
- src/modules/i18n/locales/en/chat.json
- src/modules/i18n/locales/es/chat.json
- src/modules/i18n/locales/fr/chat.json
- src/modules/i18n/locales/id/chat.json
- src/modules/i18n/locales/it/chat.json
- src/modules/i18n/locales/ja/chat.json
- src/modules/i18n/locales/ko/chat.json
- src/modules/i18n/locales/ru/chat.json
- src/modules/i18n/locales/tr/chat.json
- src/modules/i18n/locales/zh-CN/chat.json
- src/modules/i18n/locales/zh-TW/chat.json
- tasks/gap-occupied-session-read-only-mode.md

## Needs-Human

**执行 2026-10-01T18:05:03.513Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：suite 红但归因不出任何失败测试文件（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (the suite log names nothing a worker could fix); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：275ccf22-2fbd-4289-a0dd-c786fe615435
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-occupied-session-read-only-mode~wk-prod-anchor~1790877855224-b4716f.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-occupied-session-read-only-mode-wk-prod-anchor.log
