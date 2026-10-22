---
id: gap-launch-profiles-relocate-shared-compile-layer
title: 把 model library 与旧 profile 共用的编译层搬出 launch-profiles 模块（行为零变化）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on: []
---
## Proposal

背景：ADR-002 取代 ADR-001 后，「独立 launch profile 实体」的拆除前置条件（AC-027 由红转绿）已满足。但 `server/modules/launch-profiles/` 目录里混着两代代码：新机制（model library 的编译层）与旧机制（profile）。整目录删除会打断在跑的 model library，因此必须先搬家。

现状事实（已实测）：
- `server/modules/launch-profiles/model-launch-spec.service.ts:2` 从同目录 `launch-spec.service.js` 导入 `isAllowedLaunchEnvKey`、`resolveContextWindow`；`:3` 从 `launch-profiles.service.js` 导入类型 `LaunchSpecGuards`。
- `isAllowedLaunchEnvKey` 另有消费者 `server/modules/providers/services/provider-models.service.ts:2,129`（模型配置写入路径校验）。
- `resolveContextWindow` 另有消费者 `server/modules/providers/services/provider-token-usage.service.ts:9,263`，以及 `server/modules/providers/list/claude/claude-runtime.provider.js:39,442,538`。
- 上述 4 个消费者全部位于 providers 模块内 —— 这是选点依据。

实现期实测更正（本段落地时发现，供第 2 段与后续读者）：上面第 4 条不成立 —— 除那 4 个消费者外，`server/modules/launch-profiles/launch-profiles.service.ts:3` 也同时消费这两个符号（旧机制自身也共用这层编译逻辑），故「搬迁后其全部消费者都在 providers 模块内、不需要新增跨模块导出」这条推论不成立：搬迁后该文件必须经某种跨模块路径取这两个值（合法路径是 providers 桶文件）。而 providers 桶的闭包经 `claude-runtime.provider.js` 反过来可达 launch-profiles 桶（`resolveLaunchSpec`），再由该桶可达 `launch-profiles.module.ts:5`，其模块体在求值时读 `launchProfilesService`；一旦 `launch-profiles.service.ts` 进入 providers 桶的依赖期，这个环就会在尚未求值的绑定上死锁（`ReferenceError: Cannot access 'launchProfilesService' before initialization`）。实测形态：16 个服务器的测试文件同时变红。故本段在该文件里保留**一行**过渡性深导入（providers 服务叶子文件），并在该行标注一条 `eslint-disable-next-line boundaries/dependencies`；该行与 providers→launch-profiles 那条边同属第 2 段拆除范围。除这一行外，跨模块导入仍一律走桶文件。

方案（最小切片，行为零变化）：
1. `launch-spec.service.ts` 整体（`resolveContextWindow`、`isAllowedLaunchEnvKey`、`ALLOWED_ENV_PREFIXES`、`ALLOWED_ENV_KEYS`、`DENIED_ENV_KEYS`、`DEFAULT_CONTEXT_WINDOW`）迁到 `server/modules/providers/services/launch-spec.service.ts`。搬迁后其全部消费者都在 providers 模块内，属模块内服务文件，**不需要**新增跨模块导出（避免无消费者地扩大 providers 桶文件）。
2. `model-launch-spec.service.ts` 与其 4 个测试（`model-launch-spec.test.ts`、`model-spawn-env.test.ts`、`model-context-window.test.ts`、`model-gateway-end-to-end.test.ts`）迁到 `server/modules/providers/services/` 与 `server/modules/providers/tests/`；`resolveModelLaunchSpec`、`resolveModelContextWindowRow` 经 `server/modules/providers/index.ts` 导出。
3. `LaunchSpecGuards` 类型（当前定义在 `launch-profiles.service.ts:16`）随 `model-launch-spec.service.ts` 落到新位置，经 providers 桶文件以 `export type` 导出。旧文件 `launch-profiles.service.ts` 与迁移中的 `model-launch-spec.service.ts` 改为 `import type` 自 providers 桶文件取 —— 这是**过渡性跨模块导入**，随第 2 段拆除消失，须在代码注释里标注为过渡。
4. 更新全部消费者的导入路径；`server/modules/launch-profiles/index.ts` 桶文件相应删掉已迁走的导出（`resolveModelLaunchSpec`、`resolveModelContextWindowRow`、`isAllowedLaunchEnvKey`、`resolveContextWindow`）。
5. **不得删除任何未被搬迁的文件**；本段结束时旧 profile 功能仍须完整可用。

约束（`.agents/skills/backend-module-standards`）：跨模块导入只走 `index.ts` 桶；`server/shared/types.ts` 只允许 `import type`；本段不新建模块；`claude-runtime.provider.js` 是既有 JS 文件，其 TS 化**明确不在本任务范围内**（标准允许保留任务范围，不做无关的全仓迁移）。

<!-- dedup-ref -->与第 2 段（拆除）是不同机制：本段只搬家、不改行为、不删未搬迁文件；第 2 段才做删除。两段顺序不可交换 —— 新机制在编译期依赖旧模块，先删则断。

取假形态：迁移后若某消费者仍指向旧路径，`npm run typecheck` 必红；若搬家过程中改变了白名单或上下文窗口回退顺序，`model-*` 四个测试必红。

## AC

- [x] `npm run typecheck` 退出码 0；旧路径引用清零：`grep -rn "launch-profiles/launch-spec.service" server/` 与 `grep -rn "launch-profiles/model-launch-spec.service" server/` 均无输出。（实测：typecheck 退出码 0；两条 grep 各 0 行。）
- [x] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/model-launch-spec.test.ts server/modules/providers/tests/model-spawn-env.test.ts server/modules/providers/tests/model-context-window.test.ts server/modules/providers/tests/model-gateway-end-to-end.test.ts` 退出码 0。（实测 16 pass / 0 fail。）
- [x] 旧 profile 功能未被破坏：`npx tsx --tsconfig server/tsconfig.json --test server/modules/launch-profiles/tests/passthrough-parity.test.ts server/modules/launch-profiles/tests/launch-spec-real-profile.test.ts server/modules/launch-profiles/tests/profile-rest-api.test.ts` 退出码 0。（实测 9 pass / 0 fail。）
- [x] 跨模块导入合规：`resolveModelLaunchSpec` 被 `server/modules/websocket/services/shell-websocket.service.ts` 经 providers 桶文件导入（不是深导入）。（实测该文件第 9 行为 `from '@/modules/providers/index.js'`。）
- [x] `bash scripts/test.sh --for-task gap-launch-profiles-relocate-shared-compile-layer` 退出码 0（scoped 自测；**全量套件是 fan-in 的合并闸，不是 worker 的自测**，故本任务不自跑全量）。实测（merge develop 后）：前置闸 `scripts/suite-scope-check.sh` PASS（4 个活跃任务全部合规），随后 scoped 文件 4/4 `passed=true`、退出码 0；scoped 路径不含 client 文件与静态闸，其实质即 AC-002 的那 4 个文件。首次尝试曾被该前置闸拦停（当时 develop 尚未带上各任务的 scoped 写法，工作树里的任务文件副本是旧的；已随 merge develop 消失），非本段引入。另 15 个曾因上述求值环变红的服务器测试文件也已转绿（70 pass / 0 fail）。
- [x] 测试文件**总数不变**（本段是纯搬家，文件数是回归信号，用 find 计数而非跑套件）：`find server src -name '*.test.ts' -o -name '*.test.tsx' | wc -l` 与搬迁前一致。（实测 173；develop 上 `git ls-tree -r develop --name-only` 同口径 173。）
- [x] `npm run lint` 退出码 0。（注意：裸 `npx oxlint` 在 pristine develop 上即退出 1，不是判据。）⚠️ 一处新增豁免：`server/modules/launch-profiles/launch-profiles.service.ts` 对**搬迁引入的那一行**过渡性跨模块导入带 `eslint-disable-next-line boundaries/dependencies`（成因见 Proposal 的实测更正；该行随第 2 段消失）。除该行外 `oxlint src/ server/` 无新增诊断。

## DoD

真实落地判据：不是「文件被移动了」就算完成。要求 (a) 新位置的 `resolveModelLaunchSpec` 可被跨模块经 providers 桶文件消费，(b) 旧 `launch-profiles/` 目录只剩旧机制文件（`launch-profiles.service.ts`、`session-profile-lock.ts`、`launch-profiles.routes.ts`、`launch-profiles.module.ts`、`index.ts`），(c) 搬迁前后测试文件总数不变、各 scoped 自测全绿。

实测：(a) `server/modules/providers/index.ts:18` 导出 `resolveModelLaunchSpec`、`resolveModelContextWindowRow`，websocket 的 shell 服务经该桶导入；(b) `ls server/modules/launch-profiles/` = `index.ts`、`launch-profiles.module.ts`、`launch-profiles.routes.ts`、`launch-profiles.service.ts`、`session-profile-lock.ts` + 未搬迁的旧机制测试目录 `tests/`（本段不删）；(c) 173 == 173，scoped 读数见 AC-002/AC-005/AC-006。

L_D 该轴仍暗，理由：本段是纯结构搬迁，不改变任何可观测行为，领域轴无新增读数。
L_G 该轴仍暗，理由：同上，行为等价性由 AC-001 黄金基准与全量套件承担。

## Touches

- server/modules/providers/services/launch-spec.service.ts (new; 自 launch-profiles 迁入)
- server/modules/providers/services/model-launch-spec.service.ts (new; 自 launch-profiles 迁入)
- server/modules/providers/tests/model-launch-spec.test.ts (new; 迁入)
- server/modules/providers/tests/model-spawn-env.test.ts (new; 迁入)
- server/modules/providers/tests/model-context-window.test.ts (new; 迁入)
- server/modules/providers/tests/model-gateway-end-to-end.test.ts (new; 迁入)
- server/modules/providers/index.ts
- server/modules/providers/services/provider-models.service.ts
- server/modules/providers/services/provider-token-usage.service.ts
- server/modules/providers/list/claude/claude-runtime.provider.js
- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/launch-profiles/index.ts
- server/modules/launch-profiles/launch-profiles.service.ts
- server/modules/launch-profiles/launch-spec.service.ts (deleted; 已迁出)
- server/modules/launch-profiles/model-launch-spec.service.ts (deleted; 已迁出)
- server/modules/launch-profiles/tests/model-launch-spec.test.ts (deleted; 已迁出)
- server/modules/launch-profiles/tests/model-spawn-env.test.ts (deleted; 已迁出)
- server/modules/launch-profiles/tests/model-context-window.test.ts (deleted; 已迁出)
- server/modules/launch-profiles/tests/model-gateway-end-to-end.test.ts (deleted; 已迁出)
- tasks/gap-launch-profiles-relocate-shared-compile-layer.md