---
id: gap-voice-client-asr-wasm-adapter
title: 客户端本地识别适配器：把浏览器内 WASM SenseVoice 作为 locality 'local-client' 的 ASR
  适配器接进同一个缝，模型一次下载、校验后持久缓存，慢或不可用时回退服务端（D2 §5.10）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：`tasks/` 里 `grep -il 'runsAt\|local-client\|onnxruntime-web'` 只命中探针任务 `gap-voice-client-asr-feasibility-probe`（已 done，只测量、不改产品）与服务端适配器 `gap-voice-sensevoice-server-adapter`（已 done，locality 为 local-server）；没有任何任务落「浏览器内识别 + 同一适配器缝」。本任务是探针之后的产品实现，来源是 `docs/proposals/voice-correction-feedback-loop.md` §5.10（D2）与 `docs/experiments/2026-10-06-voice-client-asr-probe.md` §0.1 的 7 条接口约束。

### 现场（读数来自探针文档，不重测）

- 桌面 Linux 无头 Chromium 单线程 p90 实时因子 0.1375；真机 PC（Windows Chrome）稳定段约 0.30、手机（Android Chrome）稳定段约 0.45，但两台真机在熄屏 / 后台等干扰下出现连续数条片段慢 4–9 倍，按原样 p90 为 1.347 / 3.94，**超过 1.0**。所以回退服务端不能只看平均速度，要按单条片段的实际耗时判断。
- 置信度 ≥ 0.85 的 token 在客户端与服务端的一致率为 0.9706（桌面、PC、手机三处逐位相同）；文本逐字一致只有 46/60，**适配器不得对文本做「必须与服务端逐字一致」的断言或重试**。
- 模型 239 233 841 B（sha256 `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`），经 Cache API 二次打开 1.244 s（桌面）。**慢网下首次下载实测 8–10 分钟**（上行约 0.4 MB/s），手机会话创建要约 80 s。
- 探针的缓存实现有一个缺口：它先 `cache.put` 再校验哈希，下载被截断或被污染时缓存里会留下坏文件。产品实现必须**先校验、后写缓存**。

### 本任务做什么

把探针里已被逐帧核对过的前端（fbank、LFR、CMVN、CTC 贪心、tokens 解码）与 onnxruntime-web 会话搬进产品，做成一个注册在 `shared/asr/asrRegistry.ts` 里的适配器，`locality: 'local-client'`（该取值在 `AsrCapabilities.locality` 里已存在）、`tokens: {confidence: true, timestamps: true}`、`meta.buildId` 取探针的构建标识格式，输出与服务端同形的 `{text, tokens[{tok, p, t}]}`。识别在 Web Worker 里跑，不阻塞主线程。

**模型下载与缓存是本任务的硬要求**：浏览器必须缓存模型等大文件，**重复打开页面不得重新下载**。
1. 首次下载流式进行，进度（已下载 / 总字节 / 速度 / 剩余时间）对用户可见；
2. 下载完整并通过 sha256 校验之后才写入 Cache API，校验失败不写缓存、不提示成功；
3. 之后每次打开先读缓存并重新校验哈希，命中则**零网络请求**；缓存条目损坏或哈希不符则丢弃并重新下载；
4. 请求 `navigator.storage.persist()`，缓存被系统驱逐后能自动恢复（重新下载）而不是报错；
5. 配额不足或 Cache API 不可用时降级为「本次会话内存里可用、下次重新下载」，并向用户说明，不得静默失败；
6. 模型不进应用包，也不入库。

### 边界（不做）

- 不改服务端适配器与既有三个远端适配器的行为与线上字节；
- 不做多线程 / COOP-COEP 部署（探针 §9 的结论是先单线程，隔离是可选部署开关，真机可用性未知）；
- 不做 diarization、不做 voice-kit 抽包（那是 `docs/proposals/voice-kit-SPEC.md` 的范围）；
- 不改设置页的整体结构，只为客户端路径增加最少的开关与状态展示（是否启用、模型状态、清除缓存）。

## Plan

- **S0 纯前端与后处理模块。** 把探针 `experiments/voice-client-asr-probe/probe.mjs` 里的 fbank / LFR+CMVN / CTC 贪心 / metadata 读取移成 `.ts` 纯函数（不引入 Node 内置、不引入 ES2021+ 库特性，保证两套编译配置都能编译）。用探针留下的对照读数做回归：片段 1 的前 6 个 token 为 `检/t=4 查/t=7 we/t=12 b/t=15 ▁server/t=18 进/t=25`，fbank 与 `kaldi_native_fbank` 的 `max|Δ|` 为 0。
- **S1 模型下载与缓存模块。** 独立于识别逻辑：`fetch` 流式读 + 进度回调 + sha256 校验 + Cache API 读写 + `storage.persist()` + 损坏恢复 + 降级路径。所有环境依赖（`fetch`、`caches`、`crypto.subtle`、`navigator.storage`）注入，测试用假实现覆盖「零请求」「截断不入缓存」「损坏重下」「配额失败降级」。
- **S2 Worker 与适配器。** Worker 承载 onnxruntime-web 会话并暴露 `{init, run}`；适配器实现 `AsrAdapter`，未就绪时和 `sensevoice-local` 一样用稳定错误码回答（例如 `ENGINE_UNAVAILABLE`），不抛异常、不静默换识别器；两个入口守卫（容器类型、请求预算）先于引擎执行。构建标识与模型哈希写进每条识别记录。
- **S3 路由与回退。** `useVoiceInput` 在客户端路径可用时用它识别，否则走服务端；`voiceConfig` 增加客户端路径的启用开关，`useVoiceAvailable` 反映客户端路径的就绪状态；回退触发有两条：引擎不可用，或单条片段实际实时因子超过阈值（按片段，不按平均）。回退要有可观察的事件，不得静默。
- **S4 真机验证。** 手机与桌面各跑一次完整流程，读首次下载进度、二次打开零下载、熄屏后恢复，记录进文档。

## AC

- [x] S0：新增的纯前端模块单测通过，且对探针留下的 token 回归读数（片段 1 前 6 个 token 与 `t`）逐项相同；命令 `npx vitest run src/shared/tests/voiceClientFrontend.test.ts` 退出码 0。
- [x] S1：缓存模块单测通过并至少覆盖五种情形：命中缓存时 `fetch` 调用次数为 0；下载被截断或哈希不符时 `cache.put` 调用次数为 0；缓存条目哈希不符时丢弃并重新下载；`caches` 不可用或 `put` 抛配额错误时识别仍可用且产生一条用户可见的降级提示；下载进度回调的已下载字节单调不减。命令 `npx vitest run src/modules/chat/utils/tests/voiceModelCache.test.ts` 退出码 0。
- [x] S2：适配器按 `shared/asr/asrRegistry.ts` 登记 `locality: 'local-client'`，并通过现有适配器不变式测试 `npx vitest run src/shared/asr/tests/asrContractInvariants.test.ts`（退出码 0）；该测试不得为它新增豁免；未就绪时返回稳定错误码而不是抛异常。
- [x] S2：适配器源文件不 import 任何 Node 内置模块，`npm run typecheck` 在根配置与 `server/tsconfig.json` 两套配置下都通过。
- [x] S3：路由单测证明两条回退触发都生效（引擎不可用；单条片段实时因子超阈值但其余片段正常），且回退时发出一条可观察事件；命令 `npx vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts` 退出码 0。
- [x] 全部新增 `src/` 代码满足 `frontend-module-standards`（`@/` 导入、type 而非 interface、barrel、单文件测试），`npx oxlint` 对新增与改动的文件退出码 0。
- [ ] 真机：在手机上首次下载时进度条可见，关闭并重新打开页面后 `fetch` 模型的请求数为 0，且识别结果的高置信 token 与服务端一致率不低于 95%，读数只能由人 yale 在真机上取得并写进 `docs/experiments/2026-10-06-voice-client-asr-probe.md` 的 §10，执行者不得代写（待外部）

## DoD

真实落地的标准：在**真实浏览器**里（不是 jsdom，也不是 node 里的 wasm）对一段真实语音，走完「首次下载 → 校验 → 缓存 → 关闭页面 → 重新打开 → 零网络请求加载模型 → 识别 → 与服务端同形的 `{text, tokens[{tok,p,t}]}` 上屏」整条路径，并把这条路径上的请求计数与识别记录（含 `buildId` 与模型哈希）作为证据留存；另有一次人为让客户端引擎不可用或变慢，观察到回退服务端的事件。只有单测、没有真浏览器上的重新打开零下载读数，不算完成。

## Touches

- shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider.ts (new)
- shared/asr/asrRegistry.ts
- src/shared/voiceClientFrontend.ts (new)
- src/shared/voiceConfig.ts
- src/modules/chat/utils/voiceModelCache.ts (new)
- src/modules/chat/audio/voiceClientAsrWorker.ts (new)
- src/modules/chat/hooks/useVoiceInput.ts
- src/modules/chat/hooks/useVoiceAvailable.ts
- src/shared/tests/voiceClientFrontend.test.ts (new)
- src/modules/chat/utils/tests/voiceModelCache.test.ts (new)
- src/modules/chat/tests/voiceClientAsrRouting.test.ts (new)
- src/modules/chat/tests/voiceCaptureTestHarness.ts
- src/shared/asr/tests/asrContractInvariants.test.ts
- scripts/asr-dashscope-omni-check.test.mjs
- scripts/asr-second-adapter-check.test.mjs
- scripts/asr-pause-cues-source-check.test.mjs
- docs/experiments/2026-10-06-voice-client-asr-probe.md
- tasks/gap-voice-client-asr-wasm-adapter.md
