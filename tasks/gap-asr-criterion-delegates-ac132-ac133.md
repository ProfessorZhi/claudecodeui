---
id: gap-asr-criterion-delegates-ac132-ac133
title: AC-132 / AC-133 判据脚本名缺失：补两个薄委托 spawner（asr-capability-check.mjs /
  asr-mime-allowlist-check.mjs）
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

<!-- dedup-ref --> 同机制去重结论：全仓无任务创建 `scripts/asr-capability-check.mjs` 或 `scripts/asr-mime-allowlist-check.mjs`（`grep -l` tasks/*.md 零命中）。相邻任务 `gap-asr-second-adapter-inline-only`（goal_ac AC-132，done）与 `gap-asr-mime-whitelist-and-size-layering`（goal_ac AC-133，done）已落地真实探针，只是文件名与判据登记名不同；同形的先例是 `gap-asr-health-effective-config-fail-closed` 为 AC-134 落的 1057 字节委托 `scripts/asr-config-resolution-check.mjs`。

**缺陷。** goal 记录 AC-132 的 `criterion: node scripts/asr-capability-check.mjs`、AC-133 的 `criterion: node scripts/asr-mime-allowlist-check.mjs` 指向两个不存在的文件，所以两条判据永远无法被求值，一直停在 `active`。实际读数在 `scripts/asr-second-adapter-check.mjs`（文件头自称 AC-132：超预算零上游调用 / 预算计整个请求 / 未声明字段不上线）与 `scripts/asr-mime-size-gaps-check.mjs`（文件头自称 AC-133：白名单外 415 `UNSUPPORTED_MIME` 零上游调用、带参数 MIME 受支持、直连与代理两面同码）。2026-09-23 在 author 分支实测两者 exit 0，墙钟 1.19s / 0.79s，远低于判据闸 60s 硬顶。

**做法（照 AC-134 先例，不改判据、不改名）。** 新增两个薄委托：各自 `spawnSync(process.execPath, [<目标探针>, ...process.argv.slice(2)], { stdio: 'inherit' })` 后 `process.exit(result.status ?? 1)`；文件头说明它是哪条判据的入口、真实读数在哪个文件。不选「改判据」：goal-cli 会回滚 `goals/` 手改，且判据是先立的契约。不选「给探针改名」：两个 done 任务的 AC/证据/Touches 钉着现名，改名会被 anti-drift 改名检测判红。

## AC

- [x] AC1 `node scripts/asr-capability-check.mjs` 退出码 0，且其 stdout 与 `node scripts/asr-second-adapter-check.mjs` 的 stdout 逐字节相同（`diff <(node scripts/asr-capability-check.mjs) <(node scripts/asr-second-adapter-check.mjs)` 退出 0）。
- [x] AC2 `node scripts/asr-mime-allowlist-check.mjs` 退出码 0，且 `diff <(node scripts/asr-mime-allowlist-check.mjs) <(node scripts/asr-mime-size-gaps-check.mjs)` 退出 0。
- [x] AC3 转发可红（正向对照，防止委托恒返 0）：`node --test scripts/asr-criterion-delegates.test.mjs` 退出 0，其中对两个委托各有独立用例——把委托复制到临时目录、旁边放一个以 `process.exit(7)` 结尾并回显 argv 的假目标探针，断言委托退出码为 7、且 `--root /x --landing` 原样到达假探针；以及目标探针缺失时委托退出码非 0。
- [x] AC4 委托不含读数逻辑：`wc -c scripts/asr-capability-check.mjs scripts/asr-mime-allowlist-check.mjs` 各 < 2048 字节，且 `grep -c "spawnSync" <每个文件>` 为 1。
- [x] AC5 已落地探针未被改动：`git diff --quiet develop -- scripts/asr-second-adapter-check.mjs scripts/asr-mime-size-gaps-check.mjs goals/` 退出 0。

## DoD

真实落地 = 判据通过它自己的机制被求值并翻转，而不是文件存在：合入 develop 后，由 goal-driver 实际执行 AC-132 与 AC-133 的 `criterion` 命令，读 `goals/AC-132-*.md` 与 `goals/AC-133-*.md` 的 `status` 为 `achieved` 且 `statusLog` 末条 `actor: goal-driver`、`reason` 为 criterion pass。只有委托文件与测试绿而两条 goal 记录仍是 `active` 的，不算完成；若判据跑了但红，要读 goal gate 记录的原始输出定位，不要改判据迁就。

L_D 该轴仍暗，理由：本任务只补判据入口的文件名委托，不新增领域数据能力，也不产出新的领域读数。
L_G 该轴仍暗，理由：GOAL-008 的目标层判据由其余 AC 承担；本任务只让 AC-132/AC-133 可被求值，不改变任何被测行为。

## Touches

- scripts/asr-capability-check.mjs (new)
- scripts/asr-mime-allowlist-check.mjs (new)
- scripts/asr-criterion-delegates.test.mjs (new)
- tasks/gap-asr-criterion-delegates-ac132-ac133.md