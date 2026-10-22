---
id: AC-127
title: fixture 根来自门控变量而非 os.homedir()，且正面断言真实 home 未被写入
status: achieved
kind: criterion
goal: GOAL-007
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/modules/debug-agent/tests/debug-agent-fixture-isolation.test.ts
expect: (1) **根来自门控变量**——fixture 根的取法只读门控变量（如 `DEBUG_AGENT_HOME`），**不读
  `os.homedir()`**。这是承重的：claude 会话同步的 home 是 `path.join(os.homedir(),
  '.claude')` 这样的**类字段**，读的是进程的 `HOME`；调试 Agent 若复用它，fixture 就会落到真实 home
  里。断言方式：把进程 `HOME` 指向一个 decoy 目录、门控根指向另一个目录，产物必须只出现在后者。(2) **真实 home 未被写入**——不是
  只断言 fixture 根被清理了，还要**正面断言**真实 home 在这次运行中没有新增（不存在性断言或修改时间断言）。(3) **teardown
  后整目录删除**。(4) **清理顺序尊重 `pruneOrphanedSessions` 的目录存在性边界**——该函数只在
  **所在目录仍然存在**时才删除索引行，所以"先删 fixture 根再断言索引被清理"是**错的顺序**：正确顺序是先让索引 收敛、再删根。取假形态：把
  fixture 指向真实 home。该变体必须红——它是 `session-synchronizer.service.ts`
  注释里那次真实故障的重演（一次指向真实 `~/.claude` 的测试运行留下的 transcript，因为观察者只对 `add`/`change`
  反应而不对 `unlink` 反应，在侧栏留下了一个永久条目，点开是空的 "Untitled" 会话）。命令必须逐字含文件路径，不得用
  glob。当前必红：该测试文件不存在。
origin: ADR-003 的「fixture HOME 隔离与清理」一节与后续任务 8。现场验证时用 decoy HOME 实测过一次：产物只出现在
  门控根下，decoy 的 `.claude/projects` 为空。
activatedAt: 2026-09-22T14:45:00.000Z
statusLog:
  - at: 2026-09-22T14:45:00.000Z
    from: draft
    to: active
    actor: yale
    reason: 随 GOAL-007 立；红先行。
  - at: 2026-09-22T16:20:12.917Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
