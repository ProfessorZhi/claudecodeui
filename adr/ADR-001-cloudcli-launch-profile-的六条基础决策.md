---
id: ADR-001
title: CloudCLI Launch Profile 的六条基础决策
status: superseded
superseded-by:
  - ADR-002
---
## 背景

CloudCLI 通过 Agent SDK 与内置终端两条路径启动 Claude Code，两条路径都整体继承
CloudCLI 服务进程的环境（`claude-runtime.provider.js:225`、
`shell-websocket.service.ts:402-415`），因此一个实例只能对接一个服务端点。

用户实际的多供应商用法是 wrapper 脚本加一串环境变量：`export ANTHROPIC_BASE_URL`
等，然后 `exec claude`。Claude Code 本身没有原生 profile 机制
（anthropics/claude-code#20549、#27359、#41048、#7075 均为未实现的功能请求），
但提供了 `--settings`、settings 的 `env` 键、`CLAUDE_CONFIG_DIR` 等足够的原语。

完整设计见 `docs/proposals/launch-profiles.md`。本 ADR 只记录其中六条
需要长期稳定、且被 GOAL 与任务反复引用的决策。

## 决策

### 1. profile 是实例级（全局）资源，不按用户隔离

`launch_profiles` 不带 `user_id`，与 `provider_models`、`app_config` 一致。

理由：本地部署的 CloudCLI 绑定单一 host user；且 `sessions` 表本身没有
`user_id`，`sessions.launch_profile_id` 只有在 profile 同为全局时外键语义才自洽。

代价：面向多租户开放时，profile 的写权限必须单独收归管理员。

### 2. 密钥永不入库

`authMode` 只提供 `inherit` / `envVar` / `helper` / `cloud` 四种，其中
`envVar` 只存环境变量名，值在编译时从宿主环境读取；`helper` 写入
`apiKeyHelper` 交由 Claude Code 自行调用。不存在密钥表。

被引用的变量在宿主环境缺失时产出 warning 并拒绝启动，**不静默回退到继承环境**，
否则会出现「以为在用网关、实际打到官方端点」的静默错误。

理由：现有 `user_credentials.credential_value` 是明文存储；与其延续该标准，
不如让密钥根本不进入 CloudCLI 的数据面。同盘密钥做信封加密是混淆而非防护。

### 3. 原始 env 逃生口实行键名白名单

允许前缀 `ANTHROPIC_`、`CLAUDE_CODE_`、`CLAUDE_AUTOCOMPACT_`；
允许精确键 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`ENABLE_TOOL_SEARCH`、
`DISABLE_TELEMETRY`；显式拒绝 `PATH`、`NODE_OPTIONS`、`NODE_PATH`、
`LD_PRELOAD`、`LD_LIBRARY_PATH`、`DYLD_*`、`BASH_ENV`、`ENV`、`SHELL`、
`IFS`、`PYTHONPATH`、`CLAUDE_CLI_PATH`、`CLAUDE_CONFIG_DIR`。

在写入路径与编译路径各校验一次。后两个键被拒是因为它们已有类型化字段
（`cliPath` / `configDir`），走字段才能施加路径校验。

配套决策：wire 协议只承载 `launchProfileId`，env 一律由服务端解析。
否则任何能连 WebSocket 的客户端都能注入 `LD_PRELOAD` 在服务器上执行代码。

白名单不使 profile 成为权限边界：`cliPath` 与 `configDir` 仍指向任意路径。

### 4. profile 在会话创建时锁定

会话首次 send 时写入 `sessions.launch_profile_id`；其后客户端传入不同值时，
服务端以已存值为准并回带 `profileLocked: true`，不报错、不中断。
变更只能通过新建会话或 fork。

理由：中途更换 baseUrl 或供应商会使 resume 与 token 计费同时失真。

### 5. `toolsSettings` 不纳入 profile

允许/禁止工具继续由权限页按 provider 全局管理
（`PROVIDER_PERMISSION_PREFERENCE_KEYS`，`src/shared/constants.ts:215-220`）。

理由：与权限页职责重叠，纳入后需要额外定义两者的优先级，收益不足以抵消复杂度。

### 6. `contextWindow` 按 profile 解析并取代全局配置

解析顺序 `profile.contextWindow` → `process.env.CONTEXT_WINDOW` → `160000`，
替换 `claude-runtime.provider.js:434`、`:528` 与
`provider-token-usage.service.ts:248` 三处硬读。

`VITE_CONTEXT_WINDOW` 经查证在 `src/` 下无任何消费点，随本决策移除。

理由：窗口写死导致大窗口会话的用量百分比恒为错误值。

## 影响

- 新增 `server/modules/launch-profiles/` 模块与 `launch_profiles` 表，
  `sessions` 增加 `launch_profile_id` 列。
- 引入内置 passthrough profile（不入库、不可删），使未配置 profile 的实例
  行为与本决策前逐字一致。
- 顺带修复内置终端 `--resume` 丢失启动参数的现存缺陷
  （`shell-websocket.service.ts:221-228`）。
- 不覆盖 Claude Code 账号级切换（OAuth 多账号），该能力需要
  `CLAUDE_CONFIG_DIR` 的完整隔离，单列后续任务。
