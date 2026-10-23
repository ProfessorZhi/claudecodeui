---
id: gap-suite-runner-keeps-per-file-logs-on-red
title: suite runner 在红时把 per-file 日志留盘：$TMP 里每个子进程的完整输出现在随 suite_cleanup 的 rm
  -rf 一起销毁，只剩 first_error 的 300 字符 ⇒ 12 个「died without reporting」的进程事后无法复查
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Finding

**现场。** `.quay/fan-in-suite-gap-session-hosts-default-wrap-four-providers~wk-prod-anchor~1790385420930-889531.log`（2026-09-25 09:17:32 → 09:19:39 本地）：

- `# tests 238 / # pass 224 / # fail 14`，其中 **12 条**逐字是
  `not ok - <file>: no result file was written for this file — its process died without reporting`
  （`database/*` 四条、`debug-agent/*` 两条、`notifications/`、`projects/*` 三条、`claude-auth`）。
- 这 12 条 `__PERFILE__` 全是 `duration_ms=1`，且 `end_ms` 聚在**同一瞬**（`1790385567347` 起，彼此差 <30ms）——是收尾时批量补记的「没结果的」，不是启动即死。
- 同轮另有 `debug-agent-gate.test.ts`（真断言）、`opencode-runtime.provider.test.js`（`see log`），以及一条 `voice-error-classification…` 的读数行。

**为什么查不下去。** `scripts/test.sh` 把每个子进程的输出写进 `$TMP/<file>.log`，失败时 `first_error()` 只截 **300 字符**一行拼进 TAP（`:404` 附近），而退出路径 `suite_cleanup()` 做 `rm -rf "$TMP"`（`:381`）。`$TMP="$(mktemp -d)"`（`:131`）里还有每个文件的完整 stdout/stderr、以及 12 个消失进程自己的错误信息 —— **全部随退出销毁**。事后能读到的只有那句「died without reporting」，没有任何办法知道它们是 OOM、是被谁杀了、还是自己挂住。

**已排除的与未排除的（本轮实测，如实登记）。**

- 该轮窗口（09:17:32–09:19:39）内**没有** `app.slice` OOM：`journalctl --user` 的 `app.slice: A process of this unit has been killed by the OOM killer.` 与 `run-*.scope: Failed with result 'oom-kill'` 都落在 **09:26:39 之后**。所以「这 12 个是 OOM 杀的」**不成立**——这是我先前差点写下的结论，按窗口逐秒核对后否掉了。
- 磁盘不是原因：`/` 71%（余 14G）、`/tmp` 6.7G/22286 项，未满。
- 运行有 `test.sh: --test-concurrency=127 exceeds the server-phase ceiling 16 -> clamped to 16`（`:2`）——调用方要 127，被夹到 16；本身不是错误，但说明该轮的并发来源不是默认值。
- `# cancelled 0`，且没有 `not ok - suite-watchdog:` —— 不是自带看门狗结束的、也不是 abort 路径。

**修法（把复查所需的证据留在盘上）。** 红的时候把 `$TMP` 里的 per-file 日志留下来：按 run 收进 `.quay/suite-logs/<run-id>/`（或 `--keep-logs <dir>` 指定），并在 TAP 里打印一行**该目录的路径**。要求：

1. **只在红时留**（或显式开关）——绿的时候继续 `rm -rf`，不让 `/tmp` 与仓内无界增长；
2. **有界**：单文件日志与总量都截断（例如单文件最多 256KB、整轮最多 64MB），截断时写明截断了多少；
3. **abort/看门狗路径也要留**（那正是最需要证据的路径），且清理逻辑（`kill_tree`）不得因此失效；
4. 路径写进 TAP 的 `not ok` 附近，使 `.quay/fan-in-suite-*.log` 里能直接读到。

⛔ 不改判词的判定逻辑（`classify`/`first_error` 的语义不动），只增加「留下证据」。

<!-- dedup-ref -->
**边界。** 与 `gap-voice-capture-off-ac6-red-not-attributable`（已 done）是同类但不同层：那条把**判据自己的断言**改成会点名；本条让 **runner** 不再销毁子进程输出。两条互补，不重复。与 `gap-ac103-worktree-state-drag-and-unbudgeted-confirm`（superseded）无关。

## AC

- [x] AC1 红时证据留盘：制造一次确定的失败（临时把某个薄测试文件改坏，或用一个必然非零的假文件），跑 `bash scripts/test.sh --for-task <某任务> --allow-thin`（或等价入口）→ 退出非 0，且运行后**存在** per-file 日志目录；`ls` 该目录应含那个失败文件的完整 stdout/stderr。给出一段原文（含失败签名）与目录路径。
- [x] AC2 路径进 TAP：同一轮的 stdout 里有一行点名该目录（路径可直接 `ls`）。把该行原文与 `.quay/fan-in-suite-*.log` 里可见的位置一并登记。
- [x] AC3 有界：构造一个输出超大的子进程（例如打印 >1MB），确认留存文件被截断到声明上限，且截断事实写进文件（或 TAP）。同时登记整轮留存总量不超过声明的总上限。
- [x] AC4 绿时不增长：一次全绿的运行（可用 scoped/thin 入口）结束后，留存目录**没有**新增（或保持空），`$TMP` 仍被清掉；`/tmp` 的占用与运行前同量级（给出前后 `du -sh /tmp`）。
- [x] AC5 中止路径也留：用 SIGTERM/INT 打断一次运行，确认留存目录里仍有该轮已产生的 per-file 日志，且 `kill_tree` 生效（无残留子进程，`pgrep` 读数给出）。
- [x] AC6 判定面未变：`git diff develop -- scripts/test.sh` 里 `classify()`/`first_error()` 相关的行没有语义改动（引号原文对照）；`npm run lint` 退出 0；`bash -n scripts/test.sh` 退出 0。

## DoD

真实落地判据是一次**可复查的红**：本任务之后，任何一次 suite 红都必须能在盘上找到那个失败文件（或那个消失进程）自己的输出，而不是只剩一句「died without reporting」。完成记录要写：AC1 那次人为失败的留存原文（至少 20 行）、AC2 的 TAP 行原文、AC3/AC4 的有界与非增长读数（含 `du -sh /tmp` 前后）、AC5 的中止读数，以及一条诚实边界——**本任务不解释那 12 个进程为什么消失**，它只保证下一次能读到原因；真因要等有了这份证据再另立任务。

## Touches

- scripts/test.sh
- tasks/gap-suite-runner-keeps-per-file-logs-on-red.md

## 完成记录

（worker `task/gap-suite-runner-keeps-per-file-logs-on-red`，实现 commit `45884caa`。以下读数都在该 commit 的树上重测；只有 AC2 的「在 fan-in 日志里的落位」读的是既有日志。）

**AC1 红时证据留盘。** 人为失败 `server/.keep-logs-ac/ac1-fail.test.ts`（`assert.equal(1,2)`，外加一行只存在于该子进程 stdout 的标记），`bash scripts/test.sh server/.keep-logs-ac/ac1-fail.test.ts` → **rc=1**。留存目录
`<wt>/.quay/suite-logs/20260926T101642-1354145/`，其中 `server__.keep-logs-ac__ac1-fail.test.ts.out`（**31 行**）原文：

```
AC1-EVIDENCE-MARKER: 0197d3 <-- this line only ever existed in this child process
✖ AC1 deliberate failing assertion (1.440647ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 133.287967

✖ failing tests:

test at server/.keep-logs-ac/ac1-fail.test.ts:1:165
✖ AC1 deliberate failing assertion (1.440647ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  1 !== 2

      at TestContext.<anonymous> (/data/home/yale/work/claudecodeui-worktrees/gap-suite-runner-keeps-per-file-logs-on-red/server/.keep-logs-ac/ac1-fail.test.ts:7:10)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 1,
    expected: 2,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

同轮还留了 `.res`（20 B）与 `watchdog-trace.txt`（48 B）；`MANIFEST.txt` 逐文件记了 kept/produced 字节（`…out 1020 1020`）。

**AC2 路径进 TAP。** 同一轮 stdout 第 7 行逐字（<abs> = 上面那个绝对路径）：

```
# suite-logs: /data/home/yale/work/claudecodeui-worktrees/gap-suite-runner-keeps-per-file-logs-on-red/.quay/suite-logs/20260926T101642-1354145 | kept 3 of 3 child artifact(s), 1505 bytes on disk (truncation sidecars and the ledger included) of the 67108864-byte whole-run cap; truncated 0, omitted 0 | reason: red: 1 failed, 0 unclassified
```

位置：紧跟在 `not ok - server/.keep-logs-ac/ac1-fail.test.ts:   AssertionError …`（第 6 行）之后、`# tests 1`（第 8 行）之前。**在 `.quay/fan-in-suite-*.log` 里可见的位置**：该日志是 suite 的 stdout/stderr 逐字留存（首行 `[full-suite-runner] SUITE-RUN-START …`，第 3 行即 `suite-scope-check: scan …`），既有日志 `.quay/fan-in-suite-gap-session-hosts-default-wrap-four-providers~wk-prod-anchor~1790385420930-889531.log` 的 `not ok -` 批占 269–282 行、`# tests 238` 在 283 行；本行由 `scripts/test.sh:810` 的 `not ok` 批循环之后、`:815` 的 `suite_keep_logs "red: …"` 打出，在那份日志里就落在 282 与 283 之间（即其后所有行的行号各 +1）。

**AC3 有界。** 单文件上限：默认 262144 B；打印 >2 MB 的子进程 → 留存文件 `stat -c %s` = **262144**，旁证 `<name>.out.truncated`：
`[suite-logs] TRUNCATED: kept the first 262144 of 2098103 bytes — 1835959 bytes were dropped (per-file cap 262144 B)`。
整轮上限：`QUAY_SUITE_LOG_TOTAL_BYTES=400000` 跑两个大输出的失败文件 → 打印
`kept 3 of 5 child artifact(s), 335513 bytes on disk (truncation sidecars and the ledger included) of the 400000-byte whole-run cap; truncated 2, omitted 2`，与盘上 `find <dir> -type f -printf '%s\n'` 求和 **335513**（6 个文件）一致且 ≤ 400000。上限按构造成立：拷贝前先从总量里扣掉 `LEDGER_RESERVE`，`kept + ledger ≤ cap` 恒真；截断/省略同时写进 sidecar、MANIFEST 与那一行 TAP。

**AC4 绿时不增长。** 一次全绿（`server/.keep-logs-ac/ac4-green.test.ts`，`# pass 1 / # fail 0`）→ **rc=0**，stdout **没有** `# suite-logs:` 行（`grep -c` = 0），`.quay/suite-logs/` 目录数 **17 → 17**（无新增），`du -sh /tmp` 前后均 **6.8G**，`$TMP` 仍被 `rm -rf` 清掉。（显式开关 `QUAY_SUITE_KEEP_LOGS=1` / `--keep-logs [dir]` 才会在绿时也留。）

**AC5 中止路径也留。** 对一次运行发 SIGTERM → **rc=3**，stdout 第 3 行 `not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above`，第 4 行即该轮 `# suite-logs: … | reason: aborted: the run did not finish on its own`；留存目录里 `server__.keep-logs-ac__ac5-slow.test.ts.out`（566 B）含中断前写下的 `AC5-PARTIAL-MARKER 7a31c` 与 `✖ server/.keep-logs-ac/ac5-slow.test.ts (5796.626047ms)`。`kill_tree` 生效：信号前递归收下 10 个后代 pid，abort 后逐个读 `/proc` → `still alive after the abort: []`。看门狗那条（`QUAY_SUITE_MAX_RUNTIME_MS=4000`）同样留了 `watchdog-verdict.txt`（`suite-watchdog: ABORT guard=max-runtime reason=timeout threshold_ms=4000 elapsed_ms=4022 silent_ms=2008`）与部分输出。EXIT trap 兜底：一次因 `unbound variable` 提前死亡的运行（rc=1）也被留存，`reason: unexpected non-zero exit (rc=1)`。

**AC6 判定面未变。** `git diff develop...HEAD` = **217 insertions / 1 deletion**；唯一的删除行是参数分派那一行（把 `--run-id` 拆成独立 case 记录其值、并新增 `--keep-logs`），与判定无关。`first_error()`（5 行，md5 `f4a5865c…`）与 `# __BEGIN_CLASSIFY__`…`# __END_CLASSIFY__` 区间（54 行，md5 `9e8365d5…`）在 develop 与 HEAD 上逐字节相同（行号 408..412 / 414..467 → 616..620 / 622..675，纯位移）。`bash -n scripts/test.sh` rc=0；`npm run lint` rc=0（仅既有 warning）。

**诚实边界。** 本任务**不解释** 2026-09-25 那 12 个进程为什么消失（现场窗口内没有 OOM，已按秒核对）。它只保证下一次红时那个失败文件（或那个消失进程）自己的输出在盘上、路径在 TAP 里可读；真因要等有了这份证据再另立任务。
