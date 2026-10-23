---
id: gap-voice-identifier-guard-pins-pre-trim-container
title: 重述 AC-115 判据的上传体护栏：它写死的 webm 容器已被出货的裁剪链改成 WAV
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-115
---
## Proposal

AC-115 的判据 `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 当前红，但红的不是它的实质断言，而是 spec 自己加的一条「上传体是浏览器 `MediaRecorder` 编码的 webm」护栏（`e2e/voice-identifier-repair.spec.ts:294`）。2026-09-22 本轮实测：

- 命令退出码 1，红在 294 行 `expect(upload.body.includes(Buffer.from('audio/webm'))).toBe(true)`。
- 其**前**的实质断言全部通过：前提自查（228/229：`UTTERANCE` 含错拼形态、不含真名）、composer 逐字持有项目真实文件名（270 `toHaveValue(expected)`）、含真名（274）、不含点号被摊成空格的形态（277）、不含识别器原文（281）、请求确为 app 自己发出且带种子凭据（284–292）。用例墙钟 2.9s。

**成因（时间线已用 git 钉死，非推测）**：`3e490e6a`（2026-09-21 22:03）把修复接进 `useVoiceInput` 的 `raw → text` 边界，并在同一提交写下本 spec —— 当时上传体就是浏览器自己编码的 webm，该护栏为真。`f37f075f`（2026-09-21 23:39，晚约 1.5 小时）把 decode→trim→encode 接进上传路径，且**裁剪是出货默认（on）**（`src/shared/voiceDebug.ts` 的 `isVoiceTrimEnabled()`：未设置即为 on），于是上传体变成仓库自己重编码的 WAV。本 spec 自 22:03 起再未被任何提交改过，该护栏从 23:39 起恒假。

**同仓独立证据**：`e2e/voice-trim.spec.ts`（AC-119，当前绿）量的是同一条链，断言未裁剪上传体以 EBML 魔数 `1a45dfa3` 开头、裁剪后上传体以 `RIFF` 开头且时长严格小于 fixture —— 即「默认配置下上传体是仓库重编码的 WAV」这件事，本仓已有一条绿判据量过。

**所以这不是产品缺陷**：AC-115 的实质保证（真实浏览器 + 真实 UI，经语音按钮，composer 最终持有项目真实文件名且不再持有错拼形态）**现在为真**。红的是判据里一条把机制（webm 容器）当成不变量写死的护栏 —— 它度量的是护栏写下时的链路，而那条链路被本目标自己的后续工作（GOAL-006 的裁剪链）合法地改掉了。判据护栏与它量的链路各自演化，无人对齐，这就是它的真实缺口。

### 方案

1. 把 `e2e/voice-identifier-repair.spec.ts:291-294` 那段护栏重述为它真正要守的不变量：**上传的字节是 app 自己从假麦克风注入的那段音频产出的真实音频，而不是测试自己拼出来的载荷**。在出货链路（裁剪默认 on）上，该不变量的可失败读数是：multipart 的音频部件是仓库自己编码的 WAV（`RIFF` / `WAVE` 魔数），且其时长由 fixture 派生 —— 严格短于 fixture，裁掉的正是停顿。
2. fixture 时长**由 spec 已经读的那个 fixture 现算**（`fs.readFileSync(process.env.QUAY_E2E_VOICE_AUDIO!)`，本 spec 第 237 行已经这么做），⛔ 不得把时长写成字面量。WAV 头解析可照抄 `e2e/voice-trim.spec.ts` 里的 `wavDurationSec`。
3. 断言链其余部分逐条保留：前提自查、composer 逐字相等、不含错拼形态、不含摊平形态、请求归属与凭据。⛔ 不得为了变绿把断言改弱 —— 不允许把护栏换成「body 非空」这类恒真写法，也不允许用 `?voiceTrim=off` 把判据挪到非出货配置上：判据量的必须是默认安装的真实路径。
4. 把「两条护栏各自仍可失败」实测出来并留在任务记录里（探针为临时物，⛔ 提交前还原）：(a) 把 `repairIdentifiers(text, candidates)` 从链路拿掉 → composer 断言（270 / 281）必须红；(b) 把新护栏期望的容器读法改错 → 护栏本身必须红。
5. 在任务记录里写下本轮与落地后的实测读数（上传体容器魔数、fixture 时长、上传体时长），使下次链路变更时能一眼看出该护栏量的是什么。

### 边界（不做）

不改语音链路的生产代码；不改 `playwright.config.ts` 的 fixture 播种；不把 `?voiceTrim` 开关引入本 spec；不改写 `goals/AC-115-*.md` 的记录（该记录 `expect` 尾注「当前必红：修复尚未接进 useVoiceInput 的转写路径」是 2026-09-21 的快照、确已失真，但 `expect` 正文不涉及容器口径，故判据口径无需修正，本任务只在自身记录里留下更正）。

<!-- dedup-ref -->
相关且均已 done，故不构成重复：`gap-voice-identifier-browser-e2e`（写了本 spec）、`gap-voice-identifier-repair-unwired`（把修复接进 `useVoiceInput`）、`gap-voice-trim-browser-e2e`（落地的裁剪链正是本次护栏失真的成因）。本任务是这三者留下的缝合处：判据的护栏与它量的链路各自演化，无人对齐。

## AC

- [x] `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 退出码 0
- [x] 重述后的护栏本身可失败：把断言期望的容器读法改成不可能的值后，同一命令在该护栏处红（临时探针，提交前还原）
- [x] 判据的实质半边仍可失败：把 `repairIdentifiers` 从 `useVoiceInput.ts` 的 `raw → text` 边界拿掉后，同一命令在 composer 断言处红（临时探针，提交前还原）
- [x] fixture 时长在 spec 中由 fixture 现算而非字面量：`grep -c "QUAY_E2E_VOICE_AUDIO" e2e/voice-identifier-repair.spec.ts` 输出 ≥ 2
- [x] 实质断言未被删弱：`grep -cE "toHaveValue\(expected\)|toContain\(identifier\)|not\.toContain\(SPOKEN\)" e2e/voice-identifier-repair.spec.ts` 输出 ≥ 3
- [x] `npm run lint` 退出码 0
- [x] `npm run typecheck` 退出码 0

## DoD

真实落地判据：不是「改一个字面量让它变绿」，而是护栏被重述为它真正守的不变量（上传的字节确实派生自注入的假麦克风音频），并且**两条护栏各自仍可失败**都被本命令实测出来。承重性由取假形态证明：拿掉 `repairIdentifiers` → composer 断言红；把新护栏的期望容器读错 → 护栏红；两者都必须是命令的红，不是推理。判据量的必须是默认安装的出货路径（裁剪默认 on）。

落地后必须留在记录里的读数：`npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 的退出码与墙钟（整条命令须留在 goal 判据门 60s 硬上限内）、上传体音频部件的容器魔数、fixture 时长与上传体时长。⛔ 不许把「测试通过」当落地证据而不给读数。

L_D 该轴仍暗，理由：本任务只重述一条浏览器判据的护栏读法，不新增领域数据能力，无可读的数据轴读数。

L_G 该轴仍暗，理由：同上；本任务的读数是容器魔数与时长派生关系，不是生成质量轴读数。

## 实测读数（2026-09-22 落地）

命令：`npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"`

- 落地前：退出码 1，红在 `e2e/voice-identifier-repair.spec.ts:294` 的 `expect(upload.body.includes(Buffer.from('audio/webm'))).toBe(true)`，`Received: false`。
- 落地后：退出码 0，playwright 自报 `1 passed (12.5s)`（含 `npx` 启动的整条命令墙钟 ~13.1s，在 goal 判据门 60s 硬上限内）；spec 内用例自身墙钟 2.9s。
- 上传体音频部件的容器魔数：`RIFF` / `WAVE`，该部件 275564 字节；同一次运行里 fixture 282092 字节（48kHz 单声道 16-bit）。
- fixture 时长：**2.938s**，由 spec 现算（`fs.readFileSync(process.env.QUAY_E2E_VOICE_AUDIO)` 的 `fmt `/`data` 读出），非字面量。
- 上传体时长：**2.870s**，同一读法，从 multipart 里 `name="file"` 那个部件读出。
- 两条边界的余量：距上界（fixture 2.938s）0.068s；距下界（fixture/2 = 1.469s）1.401s。**上界是紧的那一侧**：裁剪会补 lead-in 0.15s / lead-out 0.2s，而本 spec 的采集窗（`waitForTimeout(2500)`）短于 fixture，两者相抵后上传体只落在 fixture 略下方。护栏注释已写明这一点；下次改采集窗或裁剪参数时应先读这两个数，而不是先改断言。
- 确定性：三次连跑的读数字节级相同（部件均 275564 字节），即该护栏在能跑到时是确定的 —— 那 0.068s 是常数，不是抖动。
- 合并 develop（merge `2bba6d84`）后重跑同一命令：仍退出码 0，读数不变。

### 可失败性实测（临时探针，提交前已还原）

- 护栏本身：(a) 把断言期望的容器读法改成 `PROBE-IMPOSSIBLE` → 同一命令退出码 1，红在该护栏（当时 spec:358），`Expected: "PROBE-IMPOSSIBLE" Received: "RIFF"`。以备份文件还原。
- 判据实质半边：(b) 把 `useVoiceInput.ts` 里 `raw → text` 边界上的 `repaired = repairIdentifiers(text, candidates)` 换成 `repaired = text` → 同一命令退出码 1，红在 composer 断言（当时 spec:324），`Expected: "please open voice.routes.ts and fix the proxy" Received: "please open voice.rouse.ts and fix the proxy"`。以 `git checkout --` 还原。

### 其余 AC 读数

- `grep -c "QUAY_E2E_VOICE_AUDIO" e2e/voice-identifier-repair.spec.ts` → **2**（launch args + `fs.readFileSync`），即 2 ≥ 2。
- `grep -cE "toHaveValue\(expected\)|toContain\(identifier\)|not\.toContain\(SPOKEN\)" e2e/voice-identifier-repair.spec.ts` → **3**，即 3 ≥ 3：实质断言逐条保留，未删弱。
- `npm run lint` → 退出码 0；`npm run typecheck` → 退出码 0。
- 测量噪声（如实记录）：本轮约 12 次有效运行中有 1 次在 `beforeAll` 就红 —— 该次日志里根本没有护栏那行读数，即它没跑到该护栏，属本仓既有的 fresh-DB / 项目加载 flake 类，与本护栏无关。

## Touches

- e2e/voice-identifier-repair.spec.ts
- tasks/gap-voice-identifier-guard-pins-pre-trim-container.md
