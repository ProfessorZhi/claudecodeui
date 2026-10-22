---
id: gap-ac172-criterion-i18n-key-table-retired-counts
title: AC-172 判据的 test 3 i18n 键表仍要求已退役的 resident.statusBar.counts.* 五键：65bebd99
  把状态条的死租约计数退役、计数挪到常驻胶囊，却没回灌 e2e/resident-status-bar.spec.ts ⇒ 12 locale × 5 =
  60 条 missing，npx playwright test e2e/resident-status-bar.spec.ts 在 test 3 处红（2
  passed / 1 failed / 1 did not run）；把 required 键表对齐当前出货面（胶囊 resident.badge.* +
  resident.backgroundTasks.count），删退役的 counts 家族
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-172
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测）：`grep -rl '^goal_ac: *AC-172' tasks/*.md` → **3** 份，全部 **status: done**（`gap-claude-resident-status-bar`、`gap-resident-status-bar-criterion-bounded-boot-guard`、`gap-ac172-criterion-anchor-retired-by-dock-consolidation`）——按规则 done 不是重复，是「上一次的修法没兜住」的证据。在飞任务（todo/ready/needs-human）里**无一**认领 AC-172；`grep -rln 'resident-status-bar.spec' tasks/*.md` 命中的 13 份全为 done。机制侧最接近的邻居 `gap-ac172-criterion-anchor-retired-by-dock-consolidation`（done，同一 AC、同一 spec）修的是**读数锚**（`[data-resident-status-bar]` → 合并后的坞 / 侧栏标记），并**故意保留**了 test 3 的 i18n 键存在断言；本条修的是**该断言本身**在更晚一次产品退役后变陈旧——机制同源、缺陷面不同、无在飞认领者。⇒ 本条不是重复。

**判据物**：`criterion:` 逐字 `npx playwright test e2e/resident-status-bar.spec.ts`。门限不变：driver-anchor 下 goal gate 的硬 60s；`playwright.config.ts:317` 的 `SINGLE_SPEC_CEILING_MS = 55_000`（spec `:1165` 的 `elapsed < 55_000` 亦钉此数）。spec `:663` 是 `test.describe.configure({ mode: 'serial' })`。

**红态基线（本轮立案前直接重跑判据本身，读它的失败输出，不读台账 `reason` 的 stderr 尾巴）**：
`cd /data/home/yale/work/claudecodeui && npx playwright test e2e/resident-status-bar.spec.ts` → **EXIT=1**，wall ≈ 32700ms，`2 passed / 1 failed / 1 did not run`。失败逐字：

```
[3/4] e2e/resident-status-bar.spec.ts:1129:3 › resident status bar › every shipped locale carries the keys the bar, the mark and the dividers read
locales.checked=12 keys.perLocale=25 missing=60
  > 1154 | expect(missing, `every locale must carry these keys; missing: ${missing.join(', ')}`).toEqual([]);
```

`missing` = `resident.statusBar.counts.{turn,background-task,monitor,cron,resident-policy}` × 12 个 locale = **60** 条。serial 模式下 test 3 红即跳过 test 4（`:1165` 的时长断言）。tests 1（`:777` popover 地址 / 复制 / 关闭常驻进程）与 2（`:903` 四态行走 + 停止只中止一轮）**通过** ⇒ 被判据承载的产品保证仍在，红的只是 test 3 的**键表**。

**机制。** `65bebd99`（`feat(chat): show this session's background tasks in the transcript`，2026-10-03）自称「retire the status bar's dead lease counts; task count on the resident pill」，从全部 12 个 locale 的 `chat.json` 删掉了 `resident.statusBar.counts.*` 五键，改在常驻胶囊上出计数（`resident.backgroundTasks.count`，`src/modules/chat/transcript/ResidentSessionBadge.tsx:224` 读取）。但 `git show --stat 65bebd99` **未触及** `e2e/resident-status-bar.spec.ts`，而该文件 test 3（`:1134`）仍把 `['turn','background-task','monitor','cron','resident-policy'].map(k => 'resident.statusBar.counts.' + k)` 列为 required。实测死键：`grep -rn 'statusBar.counts' src/ --include=*.ts --include=*.tsx | grep -v /tests/` → **0** 个消费者（仅 `src/shared/utils.ts:236` 的注释提到「the resident pill counts」，非键读取）——键确已死。

**为什么「上一次的修法没兜住」必须如实读成「量具随产品再走一步」，而不是「去修一个本来就对的产品」。** `gap-ac172-criterion-anchor-retired-by-dock-consolidation`（done）把读数锚回灌到合并后的坞、并按 AC-188 删掉了租约计数的**读数**，但其 AC5 明确要求**保留** `resident.statusBar.counts.*` 的 i18n 键（理由逐字：「test 3 断言其存在且 12 个 locale 都有，删键会红」）。当时的判断对：只要没有产品提交删除这些键，这个断言就是有效的完整性守卫。使断言变陈旧的是**更晚的一次合法退役**（`65bebd99`）——它删掉了这些键却没有回灌本 spec，与 `ad1bb63a` 漏掉本 spec 是同一族机制（产品重构越过了按旧契约寻址的判据）。另一次更晚的 `f27f9a84`（进程事实从坞的箭头挪到 header 胶囊）**已**把本 spec 的读数锚改到胶囊（`BAR = '[data-resident-badge]'`、`PANEL = '[data-resident-panel]'`），故本轮不再动读数锚。因此本轮**不是**恢复产品、**也不是**恢复死键（没人读），而是把 test 3 的 required 键表对齐到当前出货面。

**修法（最小充分，不发明新机制）。** 只改 `e2e/resident-status-bar.spec.ts` 的 test 3 与 AC-172 记录 body：

1. **从 required 删除已退役的 counts 家族**：删掉 `...['turn','background-task','monitor','cron','resident-policy'].map((key) => ({ file: 'chat.json' as const, path: \`resident.statusBar.counts.${key}\` }))` 那一项（spec `:1134`）。
2. **把 required 补到当前出货面**（test 3 标题即「the keys the bar, the mark and the dividers read」；现在的「bar」是常驻胶囊 `[data-resident-badge]`）：加入 `chat.json` 的 `resident.badge.label`、`resident.badge.aria`、`resident.badge.state.{running,stopped,exited,unknown}`、`resident.backgroundTasks.count`。这些是胶囊与后台任务条在 `src/` 里真实读取的键（`ResidentSessionBadge.tsx:177/178/188/224`、`BackgroundTaskStrip.tsx:176/191/195/198/210`）。
3. **保留幸存项**（逐键确认存在后原样）：`resident.statusBar.{unstarted,idle,busy,exited,start,restart,close,copyAddress,copied,address,activeCount}`、`resident.divider.{cron,crossSession,backgroundTask,unknown}`、`resident.stopResident`、`sidebar.resident.mark.{unstarted,idle,busy,exited}`。
   ⛔ 不要为凑「键表不动」而把 counts 键加回 locale——那会留下无人读的死键，且 AC-188（GOAL-014）本就要求状态条不再有自己的租约计数。
4. **AC-172 记录 body 追加日期化修订记录**（`## 修订记录（2026-10-03）`）：逐字点名 `65bebd99`（退役 `resident.statusBar.counts.*`、计数挪到胶囊）与 `f27f9a84`（进程事实从坞的箭头挪到 header 胶囊 `[data-resident-badge]`、面板 `[data-resident-panel]` 由胶囊展开）；写明判据的读数锚现为胶囊、test 3 的键表随之收窄。**不编辑 frontmatter**（`criterion` / `status: achieved` / `goal: GOAL-013` 逐字不动；直编 frontmatter 的 `: ` / 折叠标量风险会整店变空）。

## AC

- [x] AC1 判据翻绿：`npx playwright test e2e/resident-status-bar.spec.ts` 退出 **0**，4 个用例全过（stdout `4 passed`），且 `elapsed=NNNNms` < 55_000。验证：`echo $?` + `4 passed` + `elapsed=` 三行逐字登记（红态基线见 Proposal：EXIT=1 / `2 passed` `1 failed` `1 did not run` / `:1154` missing=60）。
- [x] AC2 required 键表不再含已退役键：`grep -n 'resident.statusBar.counts' e2e/resident-status-bar.spec.ts` 输出为**空**（注释行亦不得出现）。验证：该命令逐字输出为空。
- [x] AC3 required 键表覆盖当前出货面：`grep -n 'resident.badge\|resident.backgroundTasks.count' e2e/resident-status-bar.spec.ts` 命中 test 3 的 required 列表（≥ 2 行）。验证：`grep -n` 输出逐字。
- [x] AC4 键表承重（负控制）：把 `en/chat.json` 里一个仍在 required 的键（如 `resident.badge.label`）临时删掉 ⇒ test 3 退出**非 0**、`missing` 里出现该键；还原后 `missing=0`。两次的 `echo $?` 与失败逐字一并登记。验证：绿 run 的 `missing=0` 行 + 负控制读数。
- [x] AC5 两条承重假形态仍然红：(i) 把侧栏标记 / 胶囊的状态源改成**本地镜像**（场景切换状态后不再跟随 `GET /api/session-hosts`）⇒ 判据退出**非 0**，红落在四态那条读数（`toHaveAttribute('data-resident-state', …)`）上；(ii) 把无人轮渲染成用户消息样式 ⇒ 判据退出**非 0**，红落在无人轮那条断言（`a turn nobody typed must not wear the user's own bubble style`）上。两条都登记变异 diff、失败断言逐字、退出码；恢复后判据回 0。验证：两次变异跑与两次还原跑的 `echo $?`。
- [x] AC6 幸存读数未删弱：spec 里「停止只中止一轮、进程仍在」（`stopping a turn must not replace the process`）、地址复制（`data-resident-copy`）、关闭常驻进程（`data-resident-close`）、无人轮分隔标签 / 发送方 / 非用户样式这些断言**逐字保留**（只允许锚替换，不允许删除或放宽）。验证：四条 `grep -c` 均 ≥ 1，逐字登记。
- [x] AC7 边界：`git diff develop -- package.json playwright.config.ts` 为空；spec diff 不新增 `test.skip` / `retries`；`npx playwright test e2e/resident-status-bar.spec.ts --list` 仍列出 **4** 个用例；`npm run typecheck` 退出 0。
- [x] AC8 记录如实：`goals/AC-172-*.md` 的 body 新增日期化修订记录，逐字点名 `65bebd99` 与 `f27f9a84`；`bash /data/home/yale/.claude/plugins/cache/quay/quay/0.10.0/bin/quay goal show AC-172 --root /data/home/yale/work/claudecodeui` 的 `criterion` 逐字不变、`status: achieved`、`goal: GOAL-013`。验证：三条命令逐字输出。

## DoD

真落地标准：driver 的下一轮 goal-gate 重跑 `npx playwright test e2e/resident-status-bar.spec.ts` 翻绿并把 pass 写进 `.quay/gate-events.jsonl`（AC-172 的台账尾部不再是 CURRENTLY FALSE）。AC1 的 `4 passed` 与 `elapsed=` 写进完成记录；AC4 的键表负控制、AC5 两条假形态的变异 diff / 失败逐字 / 退出码与还原读数一并登记。完成记录必须如实写明：**不是**产品修复——AC-172 的产品保证（侧栏四态标记与 `GET /api/session-hosts` 逐态比对、胶囊面板的地址 / pid / 复制 / 起停关闭、停止只中止一轮、无人轮分隔标签 / 发送方 / 非用户样式）本轮实测仍成立（tests 1 / 2 通过）；失效的是 test 3 的**键表**：`65bebd99` 合法退役了 `resident.statusBar.counts.*` 并把计数挪到胶囊，却没有回灌本 spec。⛔ 不许把 counts 键加回 locale 凑绿，不许改判据命令 / skip / retries / 删幸存断言换绿。

L_D：该轴仍暗，理由：本任务只把一条 AC 判据的 i18n 键表跟着一次产品退役收尾，不产出新的领域判据，无可读的两轴读数。

## Touches

- e2e/resident-status-bar.spec.ts
- goals/AC-172-真实浏览器里常驻会话的状态标记-状态条与关闭按钮反映宿主状态-无人轮带触发类型标签.md
- tasks/gap-ac172-criterion-i18n-key-table-retired-counts.md