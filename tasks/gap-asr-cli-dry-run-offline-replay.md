---
id: gap-asr-cli-dry-run-offline-replay
title: 命令行 --dry-run 零网络且打印脱敏请求、--offline 回放录制响应与录制一致；"真跑"按决策 8 不判据化（AC-131）
status: superseded
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-asr-wire-single-implementation-boundary-probe
goal_ac: AC-131
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`task_list` 全文检索 `dry-run` 无命中第二条；`tasks/` 内没有第二条在落「命令行 `--dry-run` 零网络 / `--offline` 回放」的任务。相邻但机制不同的是 `gap-asr-wire-single-implementation-boundary-probe`（AC-129）——它只把线协议收敛成一份实现并新增第三个消费者入口，并在自己的边界里明确把 `--dry-run` / `--offline` 语义**让给本任务**；以及 `gap-asr-extraction-parity-baseline`（AC-130），它录的是两跳逐字节基线。本任务是 ADR-004「后续任务 3」的立案。

**现场。** 今天不存在任何一个「既是出货实现、又能在命令行里直接调用」的对象，因此换一个识别服务无法在命令行上被验证（ADR-004 第三节的读数）。探针任务落地后，前端、服务端、命令行三处消费者经同一条路径解析到同一份线协议实现；本任务给该入口补上两条**离线**通路，使验证能在 CI 里零网络跑到。

**本任务做什么。** `--dry-run` 用一个**被禁止联网的 fetch 替身**驱动出货的请求构造，断言「发生调用即红」，并打印脱敏后的出站请求（不含密钥与音频字节）；`--offline` 回放一份录制响应，产出与录制一致的文本；CLI 以 `npx tsx` 启动（ADR-004 决策 2 约束 2：裸 node 对 `.js` 说明符报 `ERR_MODULE_NOT_FOUND`，命令本身即断言启动方式）。落点沿用 ADR-004 决策 2/3 的候选，探针任务已给出 `--landing` 读数。

**不判据化（按 ADR-004 决策 8）。** 「真跑在真实音频上取回非空文本」是联网 + 带凭据的操作，归入实验记录，**不进判据集**。本任务的 `## AC` 不含任何真跑读数；`## AC` 里显式列一条「不判据化」说明，避免后来者把它补成判据。

**边界（不做）。** 不做能力声明与第二个 provider（那是 AC-132/133/134/135 的词）；不录两跳逐字节基线（AC-130）；不改线协议实现本身（AC-129）；不改两条路径的线上字节；不把命令行提升为 `cloudcli` 子命令。

## Plan

- **S0 落 `--dry-run`。** 新增一个注入点，把 fetch 替身设为「一旦被调用即抛」；断言整个 `--dry-run` 路径零网络，并打印脱敏后的 URL / 方法 / 头 / 体（密钥与音频字节一律以占位符出现，替换处数断言 `=== 1`）。
- **S1 落 `--offline`。** 读一份录制响应 fixture，回放产出文本，断言产出与录制一致；fixture 里不含密钥、不含音频字节。
- **S2 落探针与其测试。** `scripts/asr-cli-dry-run-check.mjs` 驱动上面两条通路；三条取假形态各成一条独立可红用例，写在 `scripts/asr-cli-dry-run-check.test.mjs` 内；每条先证未变异为绿、再证变异为红（防「恒红」被读成绿）。
- **S3 读数。** 逐条跑 AC，把 stdout 落进 Evidence。

## AC

- [ ] AC1 `--dry-run` **零网络**：用一个被禁止联网的 fetch 替身断言——发生调用即红。取假变体：`--dry-run` 实际发出了请求（替身记录到一次调用）⇒ 必须红。
- [ ] AC2 `--dry-run` 打印的请求**脱敏**：不含密钥、不含音频字节。取假变体：脱敏只脱了密钥没脱音频 ⇒ 必须红。
- [ ] AC3 `--offline` 回放录制响应，产出与录制一致的文本。取假变体：`--offline` 其实走了网络 ⇒ 必须红。
- [ ] AC4 CLI 以 `npx tsx` 启动（命令本身即断言）：`npx tsx experiments/voice-asr-cli/transcribe.ts` 无参数时打印用法并**非零**退出（断言退出码与用法行文本）。
- [ ] AC5 三条取假形态各为 `scripts/asr-cli-dry-run-check.test.mjs` 内一条独立可红用例；`node --test scripts/asr-cli-dry-run-check.test.mjs` 退出码 0，且该文件经 `scripts/list-script-tests.mjs` 被列出。
- [ ] AC6 空读数不是绿：把替身的调用记录清空、或把 `--offline` 的 fixture 删掉 ⇒ 探针必须非零退出（空 glob 不许退出 0）。
- [ ] AC7 静态门：`npm run typecheck` 退出码 0；`npm run lint` 退出码 0。
- [ ] AC8 **不判据化（ADR-004 决策 8）**：「真跑在真实音频上取回非空文本」联网且需凭据，不进判据集，本任务不以任何命令断言它。

## DoD

真实落地判据：不是「多了两个 flag」，而是 **`--dry-run` 与 `--offline` 两条通路真的离线可跑、且判据自己能红**。承重性由三条正面读数证明：

(a) `--dry-run` 的零网络由「调用即红」的替身机械证明（AC1），而不是靠「跑了没报错」推断；
(b) 脱敏是双向的 —— 只脱密钥不脱音频这一半必须红（AC2 及其取假变体）；
(c) `--offline` 的产出与录制一致，且「其实走了网络」的形态可红（AC3）。

**本任务不证明**联网真跑可用，也不证明换个服务就准 —— 那两条按 ADR-004 决策 8 归实验记录。此外，若 `experiments/**` 不在任何 tsconfig include、也不在 `npm run lint` 的路径列表里，探针必须**断言两条读数真的被打印出来**（空读数、非零退出、文件缺失都判红），不许静默绿。

L_D 该轴仍暗，理由：本任务只给命令行补两条离线通路，不新增领域数据能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上 —— 目标层判据（换识别服务不改路由与 UI）由 GOAL-008 的其余判据承担，本任务只承担「命令行两条通路离线可跑且可红」这一条。

## Touches

- experiments/voice-asr-cli/transcribe.ts
- experiments/voice-asr-cli/dryRun.ts (new)
- experiments/voice-asr-cli/offlineReplay.ts (new)
- experiments/voice-asr-cli/__fixtures__/recorded-response.json (new)
- scripts/asr-cli-dry-run-check.mjs (new)
- scripts/asr-cli-dry-run-check.test.mjs (new)
- tasks/gap-asr-cli-dry-run-offline-replay.md

## 撤回

2026-09-22 撤回：与 `gap-asr-cli-offline-verification` 重复（同绑 AC-131）。两个 gap-filer 并发立案，机制去重未生效（本任务 23:15:50 立案，晚于后者 23:15:34，双方在各自立案前都查过「无任务声明 AC-131」）。保留后者，理由有二：

1. **判据命令必须与 AC 记录同名。** AC-131 记录里的 `criterion:` 是 `node scripts/asr-cli-offline-check.mjs`；后者落的正是这个名字（`scripts/asr-cli-offline-check.mjs`），本任务落的 `scripts/asr-cli-dry-run-check.mjs` 与记录不符 —— 即便本任务落地，driver 对 AC-131 的独立核验仍会因「判据命令不存在」而红，AC-131 的缺口不会被真正关上。同族先例一致：AC-129 记录写 `scripts/asr-single-implementation-check.mjs`、AC-130 记录写 `scripts/asr-extraction-parity-check.mjs`，两条任务都按记录取名。
2. **「以 tsx 启动」要由启动方式判，不能复述 AC-129 的读数。** AC-131 的 expect 写的是「断言 CLI 以 tsx 启动（**从启动方式判定**）」；本任务的 AC4 复述的是 AC-129 任务 AC10 的同一条读数（无参数打印用法并非零退出），判的是用法与退出码，不是启动方式。后者用「`npx tsx` 臂 / 裸 `node` 臂」两条启动读数判它（裸 node 对 `.js` 说明符报 `ERR_MODULE_NOT_FOUND`，已实测），并带一条取假臂：把说明符由 `.js` 改成 `.ts` 让裸 node 也能跑 ⇒ 必须红。

本任务的两条可取之处已被后者吸收，不随之丢失：`dryRun.ts` / `offlineReplay.ts` 的模块切分（入口只做参数解析）与「真跑不判据化（ADR-004 决策 8）」的显式登记。本任务未产出任何代码与 worktree，撤回无残留。
