---
id: gap-voice-settings-server-storage
title: Voice 设置存服务端（按用户），浏览器不再以 localStorage 持久化 API key
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

现状：Voice 设置（`baseUrl/apiKey/sttModel/ttsModel/ttsVoice/ttsFormat`）只存在浏览器 localStorage 键 `voiceConfig`（`src/shared/voiceConfig.ts`、`src/modules/settings/hooks/useVoiceConfig.ts`）。后果：(1) API key 明文落在浏览器存储里；(2) 按 origin 隔离，换端口/换设备即丢 —— 2026-09-21 从 5173 换到 3001 时用户的 Groq 配置即因此消失，且 `useVoiceAvailable.ts:42` 依赖本地 `baseUrl` 判断语音是否可用，配置一丢麦克风入口也随之失效；(3) 与已上服务端的用户偏好（`user_preferences`）、草稿（`session_drafts`）不一致。

⚠️ 必须先澄清的事实（此前一度被误判）：Base URL **不是**死字段。`src/shared/api.ts` 的 `transcribeVoice`/`synthesizeVoice`（约 590-637 行）在配置了 `baseUrl` 时**由浏览器直连**该地址（`{baseUrl}/audio/transcriptions`、`/audio/speech`，带 `Authorization: Bearer <apiKey>`），完全绕过服务端 `/api/voice` 代理；未配置时才走代理并用 `x-voice-*` 头覆盖模型与 key。`voice.module.ts` 的注释明说这是有意设计：用户自填的后端由浏览器直连，因此永远不会成为服务端 SSRF 的输入。用户的 Groq（`https://api.groq.com/openai/v1`）正是走直连，且可用。

设计取舍（本任务的裁定，用户已确认；动它须在此改写）：**保持直连语义，只把配置的存放位置搬到服务端。** 不改成“服务端代理转发到用户填的地址”，因为那会把用户可控 URL 变成服务端的出站请求，必须另做 SSRF 校验（禁内网/环回等），是另一项独立的安全工作。代价如实登记：直连要求浏览器**运行时**持有 key，所以 key 仍会下发到浏览器**内存**；本任务消除的是“key 持久化在浏览器存储里”与“换 origin 即丢”，不是“key 不出服务端”。

**key 明文存放，不加密**（用户已裁定）。理由：直连模式下服务端必须能把 key 原样交还给浏览器（`GET /api/voice/config`），所以服务端持有解密能力、加密只是把同一个密钥放在同一台机器上，防不住任何实际威胁，反而多出一套密钥管理。真正的静态保护是 `auth.db` 文件本身的权限：`server/modules/database/connection.ts` 已把库文件及 WAL/SHM 收紧到 0600，本任务依赖并锁住这一点，不另造加密层。若日后改成“key 不出服务端”的代理形态，加密才有意义，届时另立任务。

方案：
1. **存储**：新建表 `user_voice_settings`（`user_id` 主键，外键 `users(id) ON DELETE CASCADE`；六个字段各一列或一个 JSON 列，由实现者按仓库先例择一并写明理由；`apiKey` 明文）。**不要**塞进 `user_preferences`：那张表会在启动时整体下发给前端（`getPreferences` 一次返回全部键），把 key 混进去等于每次启动都广播它。新增仓储 `server/modules/database/repositories/voice-settings.db.ts`，经 `server/modules/database/index.ts` 导出。实现取其 JSON 列（与 `user_notification_preferences` 同例）：六个字段永远整份读写；共享类型按 backend-module-standards 放 `server/shared/types.ts`（`VoiceSettings`、`VoiceSettingsStore`、`VoiceSettingsService`），故该文件列入 Touches。表 DDL 由 `schema.ts` 的 `INIT_SCHEMA_SQL` 建（`initializeDatabase()` 每次启动都执行它，既有库同样升级），`migrations.ts` 无需改动。
2. **接口**（挂在已鉴权的 `/api/voice` 下，`server/index.ts` 里 `app.use('/api/voice', authenticateToken, voiceRoutes)`）：`GET /api/voice/config` 返回当前用户的六个字段（无记录返回全空默认）；`PUT /api/voice/config` 整体写入，空字符串等同清除该字段。字段做长度与类型校验；`baseUrl` 只接受 `http:`/`https:`（复用 `voice.service.ts` 里 `validateBackendBaseUrl` 的判断，但注意：此处仅存储，服务端不会向它发请求）。
3. **前端**：`voiceConfig.ts` 由“读 localStorage 的同步函数”改为“模块级内存存储，登录后从 `GET /api/voice/config` 水合”，`readVoiceConfig()` 保持同步读内存以便 `api.ts` 与 `useVoiceAvailable.ts` 无需大改；水合完成前的首次语音调用须等待水合，不得用空配置误走服务端代理。`useVoiceConfig.update()` 改为写内存并防抖 `PUT`，**不再调用 `localStorage.setItem`**。
4. **旧数据一次性导入**：水合后若服务端无记录而本地有旧键 `voiceConfig`，把它 `PUT` 上去，成功后 `localStorage.removeItem('voiceConfig')`。旧键含 key，**导入成功才删**（以响应 `ok` 为准，不只是“没有抛异常”），失败保留以便重试；服务端已有记录时以服务端为准并直接删除旧键。
5. **响应头路径**：`voiceConfigHeaders()` 与服务端 `parseVoiceOverrides`（走代理时的 `x-voice-*` 覆盖）保持不变，仍以内存中的值为来源。是否让服务端代理路径也改读用户已存配置是后续优化，不在本任务内。
6. **测试面**：`src/shared/tests/voiceConfig.test.ts` 现有的 localStorage 读写用例随实现改写；新增服务端仓储/路由用例，以及 `src/shared/tests/voiceConfigHydration.test.ts`（水合与直连路径，以 `fetch` 为缝，使 `transcribeVoice` 本身真实执行）。

<!-- dedup-ref -->
相关追溯：通知提示音（`notificationSoundEnabled` 与服务端 `channels.sound` 两份状态）已被用户裁定不在本轮处理，不属本任务。

## AC

- [x] 仓储与迁移：新增 `server/modules/database/tests/voice-settings.db.integration.test.ts`，`npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/voice-settings.db.integration.test.ts` 退出码 0，覆盖：新库含 `user_voice_settings` 表；既有库升级后出现该表且其余表行数不变；同一用户 upsert 后读回一致；删除用户级联清掉其记录；两个用户互不可见。
- [x] 接口：新增 `server/modules/voice/tests/voice-config.routes.test.ts`，`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-config.routes.test.ts` 退出码 0，覆盖：无 token 时 GET/PUT 均 401；PUT 后 GET 读回；无记录时 GET 返回全空默认；非 `http(s)` 的 `baseUrl` 与超长字段被拒（400）。
- [x] `user_preferences` 未被污染：同一测试文件含用例证明 PUT voice 配置后 `GET` 用户偏好的整体响应里不含 `apiKey` 的值（`grep`/断言均可，但必须取假：若把 key 误写进 `user_preferences` 该用例判红）。
- [x] key 明文、无加密层：`grep -nE "createCipheriv|createDecipheriv|encrypt|decrypt" server/modules/database/repositories/voice-settings.db.ts server/modules/voice/voice.routes.ts server/modules/voice/voice.service.ts server/modules/voice/voice.module.ts` 无输出（grep 退出码 1）；且 `npx tsx --tsconfig server/tsconfig.json --test server/modules/database/tests/db-file-permissions.test.ts` 退出码 0（库文件 0600 是本任务唯一依赖的静态保护，不得被本任务的改动破坏）。
- [x] 浏览器存储不再落 key：`grep -rn "localStorage.setItem" src/shared/voiceConfig.ts src/modules/settings/hooks/useVoiceConfig.ts` 无输出；`grep -rn "voiceConfig" src/ --include=*.ts --include=*.tsx | grep -v "/tests/" | grep "localStorage"` 只允许出现对旧键的 `getItem`（导入）与 `removeItem`（清理）。实测第二条输出为空：旧键在两处经常量 `VOICE_CONFIG_STORAGE_KEY` 引用，故该 grep 连允许的两行也匹配不到；实际仅有的两处 localStorage 调用即 `getItem`/`removeItem`，约束更强而非更弱。
- [x] 客户端行为：改写后的 `src/shared/tests/voiceConfig.test.ts` 与新增 `src/shared/tests/voiceConfigHydration.test.ts`，`npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts` 退出码 0，覆盖：水合后 `readVoiceConfig()` 返回服务端值；水合完成前的语音调用等待水合而非走代理；旧键存在且服务端为空时被导入并删除；导入失败时旧键保留；服务端已有记录时旧键被删且不覆盖服务端；配置了 `baseUrl` 时 `transcribeVoice` 仍直连该地址（不经 `/api/voice`）。
- [x] 门：`npm run typecheck`、`npm run lint` 退出码 0；`bash scripts/test.sh --for-task gap-voice-settings-server-storage` 退出码 0（scoped 自测；全量套件是 fan-in 的合并闸，不是 worker 自测）。

## DoD

真实落地判据：要用**真实运行的实例与真实浏览器**证明，不以单测代替。(a) 在 Settings 里填入一套真实可用的配置（例如 Groq 的 `https://api.groq.com/openai/v1` 加 key），语音识别成功；(b) 清空该浏览器的 localStorage（或换一个 origin/浏览器 profile 登录同一账号），配置自动出现且语音识别仍成功 —— 这正是本任务要修复的“换 origin 即丢”；(c) 在该浏览器的 localStorage 里**查不到** `voiceConfig` 键、也查不到 key 的值；(d) 重启服务端后配置仍在。四条都留操作记录。

如实登记的取舍：(1) key 仍会在运行时下发到浏览器内存（直连的必要条件）；(2) key 在 `auth.db` 中**明文**存放，不加密 —— 用户已裁定，理由见 Proposal：直连下服务端必须能交还明文，加密无实际防护价值；静态保护靠库文件 0600（`connection.ts`），由 AC 锁住；(3) 本任务不引入服务端代理转发，因此也不引入 SSRF 面；若日后要做到“key 不出服务端”，须另立任务并附 SSRF 校验，那时再评估加密。

实施前须加载并遵循 `.agents/skills/backend-module-standards/SKILL.md` 与 `.agents/skills/frontend-module-standards/SKILL.md`（分别用于 `server/` 与 `src/` 的改动）。

L_D 该轴仍暗，理由：本任务把既有的客户端配置搬到服务端，不新增领域能力，也没有可读出的领域读数。
L_G 该轴仍暗，理由：同上；本任务的验证读数是 DoD 里的四条真实操作。

## Touches

- server/modules/database/schema.ts
- server/modules/database/index.ts
- server/modules/database/repositories/voice-settings.db.ts (new)
- server/modules/database/tests/voice-settings.db.integration.test.ts (new)
- server/modules/voice/voice.routes.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/voice.service.ts
- server/modules/voice/tests/voice-config.routes.test.ts (new)
- server/shared/types.ts
- src/shared/voiceConfig.ts
- src/shared/api.ts
- src/modules/settings/hooks/useVoiceConfig.ts
- src/modules/settings/tabs/VoiceSettingsTab.tsx
- src/modules/chat/hooks/useVoiceAvailable.ts
- src/shared/tests/voiceConfig.test.ts
- src/shared/tests/voiceConfigHydration.test.ts (new)
- tasks/gap-voice-settings-server-storage.md