---
id: gap-voice-identifier-repair-unwired
title: 把标识符修复接进语音转写路径：候选取自项目文件树，AC-115 由红转绿
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状：`repairIdentifiers`（`src/shared/identifierRepair.ts:239`）在生产代码里**零 import** —— 只有它自己的单测与 `experiments/voice-identifiers/` 用到。语音链路里唯一被接进去的是**度量**：`useVoiceInput.ts:219` 的 `console.debug('[voice] identifier fidelity', …)`，设计上只打印、不改写。所以 GOAL-005「范围」里那句「确定性修复落地客户端」并未落地：说错的名字不会被还原，composer 里就是识别器原文。

判据侧证据（2026-09-21 实测）：仅把 e2e 夹具从「拼写正确」改成修复前形态，AC-115 即在 `e2e/voice-identifier-repair.spec.ts:267` 红，composer 实际持有识别器原文 `please open voice.rouse.ts and fix the proxy` —— 链路里没有任何东西在改写。夹具已按此改好（播报形态 `voice.rouse.ts`，工作区真实文件 `voice.routes.ts`，取自语料里的实测形态 zh-d02）；该错拼形态**出货模块当前已能还原**，所以本任务不是在建一个修不了的例子。

方案：
1. **候选源**：新增 `src/shared/projectIdentifiers.ts`，经既有 `GET /api/file-tree/projects/:projectId/files`（`src/shared/api.ts:279`，`respectGitignore: true`）取回项目文件清单，按两种形态摊平（basename + 裸符号名，与训练语料一致），按 projectId 记忆化：一次会话只发一次请求；请求失败或清单为空则返回空数组，绝不因此打断转写。新 `src/shared/*.ts` 被前端模块引用会触发 oxlint 的 boundaries/no-unknown，须同时把它登记进 `.oxlintrc.json`。
2. **接线点**：`useVoiceInput.ts` 的 `raw → text` 边界（约 211–219 行），在 `onTranscript` 之前调用 `repairIdentifiers(text, candidates)`。候选为空时保持既有行为不变（模块自身对空候选 early-return）。
3. **候选由上层传入**：`useVoiceInput` 不去认项目 —— 项目 id 由 `ChatInterface` / `ChatComposer` 一侧提供（与 `draftScope` 同源），候选经参数进入 hook，保持 hook 的单测可驱动性。
4. **遥测**：把现有的 `console.debug('[voice] identifier fidelity', …)` 改成报 before/after 两个读数，使 AC-114 的指标成为修复自己的遥测，而不是一个旁观的读数。

<!-- dedup-ref -->
相关：`gap-identifier-repair-harness-measures-a-copy`（收敛该模块的两份实现，与本任务各自独立）；`gap-voice-clip-single-slot-playback` 是同一 composer 的录音槽，不改转写文本。

## AC

- [x] `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` 退出码 0（即 AC-115 由红转绿）
- [x] 候选源单测：`npx vitest run src/shared/tests/projectIdentifiers.test.ts` 退出码 0，覆盖两种形态摊平、同 projectId 只发一次请求、请求失败返回空数组、空候选不改写
- [x] 真实路径零改写：`npx vitest run src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 退出码 0，含一句不含任何标识符的普通中英文经同一链路后逐字不变，且失败信息须打印实测的前后文本
- [x] 取假形态：把 `repairIdentifiers` 临时换成恒等函数（`return text`）后，AC-1 判据必须红（记录原始终端读数与 composer 实际持有值），随后还原并确认工作树干净
- [x] `npm run lint` 与 `npx tsc --noEmit -p tsconfig.json` 退出码 0

## DoD

真实落地判据：必须在**真实运行的前端**上经语音按钮走一遍，不以单测代替。须给读数：(a) 假麦克风注入后 composer 的最终文本，逐字给出「识别器返回」与「composer 持有」两侧（`please open voice.rouse.ts…` → `please open voice.routes.ts…`），并确认后者的标识符与工作区真实文件名逐字一致（大小写与点号）；(b) 按 AC-4 注入恒等函数重跑，登记红读数与 composer 实际值，随后还原；(c) 零改写的真实路径读数：一句不含标识符的普通句子经同一路径后逐字不变，并打印前后文本 —— 放宽候选匹配若换来误改，这条就是它的护栏；(d) 候选源的真实接口读数：一次会话里 `/api/file-tree/…/files` 的请求次数（应为 1）与失败时的降级行为（转写照常完成，不因候选源失败而丢字）；(e) 操作记录逐步留痕。

L_D 该轴仍暗，理由：本任务是把既有确定性模块接进既有链路，不新增领域能力。
L_G 该轴仍暗，理由：同上；本任务的读数是 composer 的 before/after 文本、请求次数与零改写读数。

**实测读数（2026-09-21，worktree `gap-voice-identifier-repair-unwired`）**

- **(a) 修复读数为真** —— `npx playwright test e2e/voice-identifier-repair.spec.ts -g "AC-115"` → 退出码 0，`1 passed (12.5s)`。识别器返回侧：`please open voice.rouse.ts and fix the proxy`；composer 持有侧：`please open voice.routes.ts and fix the proxy`。断言不止于「含有真名」：判据把 `UTTERANCE` 里的播报形态就地换成从工作区目录**读回**的文件名（`e2e/voice-identifier-repair.spec.ts:221` 用 `fs.readdirSync(WORKSPACE)` 取，而非在测试里写死），再要求 `toHaveValue(expected)` 逐字相等，并要求 composer 的值 **不含** 播报形态（`voice.rouse.ts`）也不含「点号被摊成空格」的形态。大小写与点号由 `toContain(identifier)` 逐字钉住。夹具可修复性实测：编辑距离 2，相似度 `1 − 2/15 ≈ 0.867 ≥ 0.8`，共享前缀 `voi`。
- **(b) 取假形态（AC-4）** —— 把 `repairIdentifiers` 临时替换为恒等函数后重跑 AC-1，退出码 1，原始终端读数：`Expected: "please open voice.routes.ts and fix the proxy"` / `Received: "please open voice.rouse.ts and fix the proxy"`，调用日志第 33 次重试时 composer 的实际值即 `please open voice.rouse.ts and fix the proxy`（日志 `/tmp/ac115-antifake.log`）。已 `git checkout --` 还原，随后 `git status --short` 为空、`grep "TEMP AC-4"` 退出码 1；还原后 AC-1 重跑再次退出码 0。
- **(c) 零改写的真实路径读数** —— 在真实前端上经语音按钮走一遍，识别器先后答中文与中英混合各一句（皆不含任何项目标识符）：
  - `[probe] candidate-source-failed zh: before="请把这段说明改得更清楚一点再发布" after="请把这段说明改得更清楚一点再发布"`
  - `[probe] candidate-source-failed en: before="请把这段说明改得更清楚一点再发布 please make the wording clearer before we ship it" after="…逐字相同…"`
  - `[probe] page errors=[]`
  同一读数在单测侧被固定为 `src/modules/chat/tests/voiceTranscriptRepair.test.tsx` 的第二条，失败信息按要求打印实测前后文本（`recogniser=… composer=…`）。
- **(d) 候选源的真实接口读数** —— 用 CDP `Network.requestWillBeSent` 的 `initiator.stack.callFrames` 归因，而非按 URL 计数：一次会话里 `/api/file-tree/…/files` 共 3 次，其中**恰好 1 次**由候选源发起（`…/src/shared/projectIdentifiers.ts <- …/src/modules/chat/composer/ChatComposer.tsx`），另 2 次是既有的 `src/modules/chat/hooks/useFileMentions.tsx` 消费者，与本任务无关。候选源的「一次会话一次请求」另由 `projectIdentifiers.test.ts` 的并发+后续调用断言（`getFiles.mock.calls.length === 1`）钉住。**降级**：把该端点 abort 后重跑同一路径，退出码 0，`[probe] candidate-source-failed …` 两侧逐字相同、`page errors=[]` —— 转写照常完成，不因候选源失败而丢字。
- **(e) 其他** —— `npm run test:client` 80 文件 / 548 测试全绿；`npm run lint` 退出码 0（0 条 error）；`npm run typecheck` 退出码 0；`npm run build:client` 退出码 0；作用域门 `scripts/test.sh --for-task gap-voice-identifier-repair-unwired --allow-thin` 退出码 0（`suite-scope-check: PASS`，2 个作用域内测试文件全绿）。

**已知残余（如实登记，不在本任务范围内修）**：候选集来自项目自身的文件名，在真实项目里文件 stem 可能与普通英文词同形，从而把一句恰好含有该词的普通句子改写掉。(c) 的读数是针对**当前夹具**成立的护栏，不是普适保证；是否收紧匹配属于后续任务，本任务按计划要求与训练语料形态保持一致。

## Touches

- src/shared/projectIdentifiers.ts (new)
- src/shared/tests/projectIdentifiers.test.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/composer/ChatComposer.tsx
- src/modules/chat/ChatInterface.tsx
- src/modules/chat/tests/voiceTranscriptRepair.test.tsx (new)
- .oxlintrc.json
- playwright.config.ts
- e2e/voice-identifier-repair.spec.ts
- tasks/gap-voice-identifier-repair-unwired.md
