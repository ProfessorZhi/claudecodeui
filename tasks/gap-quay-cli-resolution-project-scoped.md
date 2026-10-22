---
id: gap-quay-cli-resolution-project-scoped
title: 修复 CloudCLI 服务端定位 quay CLI 不稳：改为按目标项目 projectRoot 解析 .quay/plugin/bin/quay
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

**现状（已核实，非推测）**：`server/modules/quay/quay-process.ts` 的 `createQuayProcessRunner(command = 'quay', leadingArgs = [])` 把 `quay` 当字面量交给 `execFile`，完全依赖子进程启动时继承的 `PATH` 去找这个二进制——没有任何按目标项目 `projectRoot` 的解析步骤。`cwd` 参数（调用处传入的目标项目路径）只决定子进程的工作目录，不参与二进制本身的查找。这意味着：CloudCLI 自身进程的 `PATH` 一旦没有把某个目标项目用的 quay 版本摆在前面（例如该项目用 `/quay:init` 固化了一个与 CloudCLI 服务进程 `PATH` 不一致的版本，或 CloudCLI 以 systemd/pm2 等方式启动、`PATH` 被精简），对该项目发起的每一次 quay 调用都会用错版本或直接 `ENOENT`——“定位不稳”的根因是 PATH 查找这件事本身没有项目维度。

**确认设计**：

1. 对当前目标项目的 `projectRoot`，稳定入口点是 `<projectRoot>/.quay/plugin/bin/quay`。
2. `quay-process.ts` 必须停止对裸 `PATH` 发起 `execFile('quay', ...)`；改为相对目标项目 `projectRoot` 解析上述入口点路径，再对该绝对路径发起 `execFile`。
3. 解析必须是**项目范围**的——不得固定到 claudecodeui 自身的安装路径，也不得以服务级全局环境变量 `QUAY_BIN` 作为主路径。
4. 迁移期内，若稳定入口点缺失，允许短期回退到 `PATH` 上的 `quay`，但该回退路径必须显式发出警告（不得静默）；裸 `PATH` 回退本身要在本次改动里留一条清晰的后续移除 TODO（不另开任务）。
5. UI/服务端错误上报要把以下几种情形区分开，不能再只给一句笼统的“quay did not answer”：
   - 稳定入口点缺失（应提示用户运行 `/quay:init`）
   - 入口点存在但不可执行
   - 进程超时
   - 非零退出码/stderr 输出
6. 测试至少覆盖两个不同的 `projectRoot`，各自带独立的伪造 `.quay/plugin/bin/quay` fixture，证明 CloudCLI 对每个 root 都调用了该 root 自己的 CLI，且两者之间没有串用/泄漏。
7. 背景说明（不在本任务构建范围，仅记录）：v0.15.0 起，既有项目经 `/quay:init` 建立/刷新 `.quay/plugin`，该命令同时迁移该项目 `.quay/config.yml` 里此前冻结的版本路径；claudecodeui 自身绝不手改另一个项目的 `.quay` 目录。
8. 明确范围外：现有 Tests/Fan-in 直接读 `.quay` carrier 文件（`.quay/full-suite-state.json`、`.quay/verification-round.jsonl`、`.quay/worker-outcome.jsonl`，见 `server/modules/quay/quay.service.ts`）的逻辑可以原样保留，不要求改写成经过 CLI。

**已核实的现有调用结构**：`createQuayProcessRunner` 的生产组装点在 `server/modules/quay/quay.module.ts`（composition root），当前以零参数调用（即 `command='quay'`、`leadingArgs=[]`）；判据文件 `server/modules/quay/tests/quay-process.test.ts` 已存在，驱动的是桩发射器而非真实 CLI，这是本任务要扩展覆盖的既有判据文件（非新建）。

## AC

- [x] AC1 `createQuayProcessRunner`（或其替代实现）不再对裸 `PATH` 发起 `execFile('quay', ...)`：对给定 `projectRoot`，解析并优先使用 `<projectRoot>/.quay/plugin/bin/quay` 这个绝对路径发起 `execFile`；`server/modules/quay/tests/quay-process.test.ts` 新增用例断言 `execFile` 实际收到的命令路径等于该绝对路径拼接结果，而不是字面量 `'quay'`。
- [x] AC2 解析逻辑是项目范围的：不出现任何固定指向 claudecodeui 自身安装路径的硬编码分支；不以 `process.env.QUAY_BIN` 作为解析该入口点的主路径（允许在回退分支之外完全不读这个变量，或仅作为显式标注的次要覆盖，但不得是“先看 `QUAY_BIN`、找不到才看 projectRoot”的主路径顺序）。判据：阅读实现 + 单测断言传入两个不同 `projectRoot` 时解析出的路径分别落在各自目录下。
- [x] AC3 稳定入口点缺失时，允许短期回退到 `PATH` 上的 `quay`，但该次调用必须产生一条显式警告（日志或等价可观测信号，判据里可断言调用了注入的 warn 回调/logger）；实现文件内对该回退分支留一条可 grep 到的 TODO 注释，说明“裸 PATH 回退需在迁移期后移除”。判据：`quay-process.test.ts` 新增用例，fixture 不提供 `.quay/plugin/bin/quay`，断言命中回退分支且警告回调被调用恰好一次。
- [x] AC4 错误上报区分四种情形而非合并成一句通用错误：稳定入口点缺失（且该路径提示用户运行 `/quay:init`）、入口点存在但不可执行（例如权限位缺失）、进程超时、非零退出码/stderr 输出。判据：新增/扩展测试对四种 fixture 分别断言返回的错误结构里带有可区分的分类字段/消息，且“入口点缺失”一类的消息文本包含 `/quay:init`。
- [x] AC5 两个不同 `projectRoot`、各自独立的伪造 `.quay/plugin/bin/quay` fixture 的集成级用例：对 root A 发起调用时只执行 A 的 fixture 二进制，对 root B 发起调用时只执行 B 的 fixture 二进制；断言两次调用互不串用（例如各 fixture 回写自己唯一的标记到各自的输出，交叉校验 A 的调用输出中不包含 B 的标记，反之亦然）。
- [x] AC6 `npm run typecheck` 退出码 0；`server/modules/quay/tests/quay-process.test.ts`（及因改动涉及的 `server/modules/quay/tests/quay.service.test.ts`、`server/modules/quay/tests/quay.module.test.ts`——以实际存在的文件为准）全部退出码 0，既有用例不因本次改动回归。

## DoD

- `server/modules/quay/quay-process.ts` 的二进制解析真的按 `projectRoot` 算出 `<projectRoot>/.quay/plugin/bin/quay` 这个绝对路径并以此发起子进程，而不是继续依赖 `execFile` 自身对 `PATH` 的隐式查找；composition root（`server/modules/quay/quay.module.ts`）把目标项目的 `projectRoot` 真的传递到这条解析路径上，不是只在测试桩里传。
- 迁移期裸 `PATH` 回退分支真实存在、真实发出警告、真实带有可 grep 到的移除 TODO；不是“文档里说了但代码里没有”。
- UI/服务端对四类失败（入口点缺失/不可执行/超时/非零退出）的区分真实反映在返回给前端的错误结构里，不是测试断言通过但实际仍合并成一条字符串。
- 两个不同 `projectRoot` 各自独立 fixture 的判据真实证明了“无跨项目串用”，不是用同一个 fixture 跑两次伪装成两个项目。
- 遵守 `$backend-module-standards`：解析逻辑/错误分类类型按一次用/多次用放置规则归位到模块内文件或 `server/shared/types.ts`；导出符号带消费方注释；路由层（若涉及）保持 thin，不下沉业务逻辑。

## Touches

- server/modules/quay/quay-process.ts
- server/modules/quay/quay.module.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/tests/quay-process.test.ts
- tasks/gap-quay-cli-resolution-project-scoped.md (self-touch)
