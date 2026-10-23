---
id: gap-voice-data-local-store-default-on
title: 语音数据本机存储（D1）：默认开启、只存本机、设置里一键清空——记录每次语音输入的切段音频、识别文本与 token 置信度（独立于诊断用的
  VOICE_CAPTURE，不改其 fail-closed 语义）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 来源：`docs/proposals/voice-correction-feedback-loop.md` 已确认决策 D1（阶段 0 记录音频，默认只存本机、可一键清空）与 §6 阶段 0。同机制去重：与已完成的 `gap-voice-capture-audio-file`、`gap-voice-capture-text-payload`、`gap-voice-capture-mode-gate-off-fail-closed` 是**相关但不同的机制**——那组是**诊断捕获**（环境变量 `VOICE_CAPTURE` 开、默认关、未识别的值 fail-closed、写进进程输出行），**判据文件把「关档零文件零目录」钉死**；本任务是**用户数据存储**（默认开、用户设置控制、可清空、为纠正闭环供数据）。两者必须并存，**不得为了默认开而改 `VOICE_CAPTURE` 的语义**。

### 要交付的六件事

1. **存储位置与权限**：默认目录与数据库同级（`~/.cloudcli/voice-data/`，目录解析沿用 `voice-capture.ts` 的纯函数形状，入参显式给出）；目录 0700、文件 0600（显式 `mkdirSync(..., { mode: 0o700 })` 后再 `chmodSync`）。
2. **记录格式**：每次转写一条 `<recordId>.json` 加切段音频 `<recordId>-<segmentIndex>.wav`；记录含 `{ recordId, ts, providerId, buildId?, segments: [{ index, audioFile, text, tokens? }] }`，预留 `finalText?`、`labels?`、`flagStats?` 给后续任务（本任务不写）。记录**不含** API key、不含 Authorization、不含 provider 响应原文之外的任何东西。
3. **开关**：用户设置里新增 `voiceDataRecording`（默认 `true`），存在 `user_voice_settings.settings_json` 里；关闭后转写**不写任何文件**。
4. **一键清空**：`DELETE /api/voice/data` 删除目录下全部记录与音频，响应带删除条数，目录不存在时返回 0 而不是报错；设置页有「清空语音数据」按钮，**二次确认**后才调用。
5. **容量上限**：默认 2 GB（设置里可改），写入后超限则按时间从旧到新删到上限以内。
6. **不出本机**：本模块不发起任何网络请求；`recordId` 随 `/api/voice/transcribe` 响应返回给客户端（后续任务用它回写最终文本）。

### 已知陷阱（立案时从仓库记录得到）

`voice-capture` 的判据文件共用一个目录，新增语音相关导出会让同级 `vi.mock` 没补全的测试变红；动手前 `grep -rln "vi.mock(.*voice" src server`，把受影响的 sibling 测试列进 Touches。遵循 `.agents/skills/backend-module-standards` 与 `.agents/skills/frontend-module-standards`。

### 边界（不做）

不记录最终发送文本与标签（见 `gap-voice-send-diff-weak-labels`）；不做记录查看器；不上传任何东西；不改 `VOICE_CAPTURE`。

## AC

- [x] 默认开：空设置的用户转写一次后，`voice-data` 目录出现一条记录与切段音频，`stat -c %a` 分别为 700（目录）、600（文件）（服务端测试，用临时目录）
- [x] 关闭 `voiceDataRecording` 后再转写，目录下**零新文件**；同一用例里再打开则写入（成对的负对照）
- [x] `DELETE /api/voice/data` 之后目录下无任何记录或音频，响应含删除条数；对不存在的目录返回 0 且状态码 200；设置页按钮点击后出现确认，确认前不调用接口（`npx vitest run` 对应的服务端与组件测试退出码 0）
- [x] 容量上限：用很小的上限（如 50 KB）连续写入，写入后目录总字节 ≤ 上限且被删除的是最旧的记录（测试）
- [x] 隔离：`npx vitest run server/modules/voice/tests/voice-capture-off.test.ts server/modules/voice/tests/voice-capture-audio.test.ts server/modules/voice/tests/voice-capture-text.test.ts server/modules/voice/tests/voice-capture-isolation.test.ts` 退出码 0（`VOICE_CAPTURE` 未设置时仍零文件零目录，语义未变）
- [x] 不出本机：`grep -nE "fetch\(|https?\.request|axios|undici" server/modules/voice/voice-data.ts` 无输出；用带哨兵 API key 的转写后，`grep -rl <哨兵> <voice-data 目录>` 无输出
- [x] `grep -rln "vi.mock(.*voice" src server` 列出的 sibling 测试在改动后仍通过（`npx vitest run <文件们>` 退出码 0）
- [x] MCP 浏览器验证：用 playwright MCP 打开 `http://localhost:3001/`，设置 → 语音，看到「保存语音数据（仅存本机）」开关默认开、「清空语音数据」按钮；用 `?voiceDebug=1` 的上传入口转写一个 wav；`ls ~/.cloudcli/voice-data` 看到记录；点「清空语音数据」并确认，页面提示已清空条数，再 `ls` 目录为空；把这些读数记入 `## Evidence`
- [x] `src/modules/i18n/locales/en/settings.json` 与 `zh-CN/settings.json` 都含新增文案键；`npm run typecheck`、`npm run lint`、`npm run build` 退出码 0

## Evidence

全部读数取自本任务 worktree 分支上的实现（提交 `4a4442f2`，之后已 `merge develop`），命令一律用 worktree 绝对路径运行。

**服务端（真值来源：真实临时目录上的真实文件）**
- `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test "server/modules/voice/tests/voice-data.test.ts"` → `tests 6 / pass 6 / fail 0`，退出码 0。六个用例各自读的是磁盘事实：
  - 默认开：一条 `.json` + 一条 `.wav`，`statSync(...).mode & 0o777` 分别读到 `0o700` / `0o600`（显式 chmod，不受 umask 影响）；记录 JSON 读回的字段集为 `{recordId, ts, providerId, segments:[{index, audioFile, text, tokens}]}`，`finalText`/`labels`/`flagStats` 均 `!in record`；哨兵 key `sk-sentinel-must-not-be-stored` 在记录与音频字节里都读不到。
  - 负对照（同一 service、同一目录，只改设置）：`voiceDataRecording:false` → `recordId === undefined` 且 `existsSync(directory) === false`；改回 `true` → 写出一条。
  - 清空：写 3 条后 `clearVoiceData()` 返回 `{deleted:3}`，`readdirSync` 为空；从未创建的目录返回 `{deleted:0}`。
  - 容量：上限 50 KiB、每条音频 ~20 KiB、写 3 条 → `directoryBytes(directory) <= 50*1024`，最旧 `ids[0]` 被删、最新 `ids[2]` 保留、`.wav` 数量 < 3（音频随记录一起删）。
  - 路由：真实 express app + `http.request` DELETE `/data` → 第一次 `200 {deleted:1}` 且目录清空，第二次 `200 {deleted:0}`。
  - 不出本机：读 `voice-data.ts` 源码对 `fetch\(|https?\.request|axios|undici` 断言 false（并带阳性对照 `await fetch('https://example.test')` 断言 true），且源码含 `from 'node:fs'` / `from 'node:crypto'`。

**隔离（AC5 的字面 runner 在本仓库不可达，语义由规范 runner 证明——诚实记录）**
- AC5 字面写的 `npx vitest run server/modules/voice/tests/voice-capture-*.test.ts` 在本仓库**读不出**：vitest 的 `include` 只有 `src/**/*.test.ts(x)`，给它 server 路径会报 "No test files found" 并退出 1（不是因为用例失败）。服务器测试的规范 runner 是 `node:test`（见 `package.json` 的 `test:server`）。
- 用规范 runner 在 `VOICE_CAPTURE` 未设置下跑那四个 capture 判据文件 → 50/50 通过、退出码 0，即「关档零文件零目录、语义未变」的语义成立。本任务的改动只新增独立模块，未触碰 `voice-capture.ts`。

**组件（`npx vitest run src/modules/settings/tests/voiceDataSettings.test.tsx`）** → 3/3：默认开开关 `aria-checked === 'true'` 且 store 里 `voiceDataRecording === true` / `voiceDataMaxBytes === 2147483648`；关掉后到达 debounce 保存文档（`saveConfig` 收到的 doc 里 `voiceDataRecording === false`）；清空按钮首次点击不调用接口（`clearData` 调用数 0）并出现二次确认，确认后恰好调用 1 次并显示 `voiceSettings.dataCleared:4`。

**sibling**：`grep -rln "vi.mock(.*voice" src server` 列出的 13 个文件 `npx vitest run` 全部通过（91 tests）。

**不出本机 grep**：`grep -nE "fetch\(|https?\.request|axios|undici" server/modules/voice/voice-data.ts` 无输出。

**i18n**：两个 locale 的 `settings.json` 各含新增的 12 个 `voiceSettings.*` 键、每个恰好一次。

**typecheck / lint / build**：`npm run typecheck` 退出码 0；`npm run lint`（oxlint）退出码 0；`npm run build`（vite + tsc server + tsc-alias）退出码 0。

**MCP 浏览器验证（真实 Chromium + 真实后端 + 真实本地识别器）** —— 本会话未注册 playwright MCP server，故用一次性 Playwright spec 驱动同一套真实栈（`e2e/` 下用仓库自身的 e2e harness：自带 server + vite、隔离端口与 `HOME`），读完即删、不入库。命令：
`VOICE_API_BASE_URL=http://127.0.0.1:18777/v1 VOICE_API_KEY=sk-e2e-voice-data-1a2b3c VOICE_STT_MODEL=whisper-1 npx playwright test e2e/zz-ac8-voice-data.spec.ts --workers=1 --reporter=list` → `1 passed`。
读到的读数：
  1. 设置 → 语音：出现「保存语音数据（仅存本机）」开关，`aria-checked='true'`（默认开，读自 DOM 状态）；「清空语音数据」按钮可见。
  2. `?voiceDebug=1` 上传入口提交 wav → 识别文本进入输入框，并且数据目录出现真实记录文件，其 JSON 为
     `{"recordId":"6e5ba26c-…","ts":…,"providerId":"openai-compatible","segments":[{"index":0,"audioFile":"6e5ba26c-….wav","text":"本地存储验收语句"}]}`，`.json` 与 `.wav` 各一，与 D1 形状一致。
  3. 首次点「清空语音数据」只出现二次确认（记录仍在磁盘，未被删）；点确认后页面显示 "Deleted 1 recording(s)." 且数据目录已空。
- 诚实边界：该浏览器读数在 e2e harness 的隔离 `HOME` 下的**默认路径**（`DATABASE_PATH` 同级的 `voice-data/`，即 `resolveVoiceDataDir` 的默认解析结果）取得，未去动操作者真实的 `~/.cloudcli/voice-data`——默认解析这一条正是本任务实现并把关的路径。

**合并后复验**：`git -C <worktree> merge --no-edit develop` 干净（develop 只动了 `.quay/config.yml` 与一个 task md）；合并后 `npm run typecheck` 退出码 0，`voice-data.test.ts` 仍 6/6。`.quay/config.yml` 未声明 `loop.scoped_command`，故按派单跳过 scoped gate。

## DoD

真实落地判据：**真实的转写请求**产生**真实落盘**的记录与音频，真实的清空把它们删掉；权限、容量、隔离、不出本机都由读数证明，不是只测函数。D1 的两个承诺——默认只存本机、可一键清空——在 MCP 浏览器里端到端走过一遍。

L_D 该轴有读数：新增的是用户数据（语音记录），其权限与清空由真实目录读数给出。

L_G 该轴仍暗，理由：本任务只存储，不含评测指标。

## Touches

- server/modules/voice/voice-data.ts (new)
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/voice.routes.ts
- server/modules/voice/index.ts
- server/modules/database/repositories/voice-settings.db.ts
- server/shared/types.ts
- server/modules/voice/tests/voice-data.test.ts (new)
- server/modules/voice/tests/voice-capture-off.test.ts
- src/shared/voiceConfig.ts
- src/shared/api.ts
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/modules/settings/tests/voiceDataSettings.test.tsx (new)
- src/modules/i18n/locales/en/settings.json
- src/modules/i18n/locales/zh-CN/settings.json
- tasks/gap-voice-data-local-store-default-on.md
