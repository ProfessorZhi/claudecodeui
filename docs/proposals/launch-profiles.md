# Launch Profile（启动配置档）Proposal

> **⚠️ 2026-09-20：本文档描述的“独立 launch profile 实体”方案已被 ADR-002 部分取代。**
> 配置改为挂在 Model library 的模型条目上（选模型即选端点），Settings → Agents → 各 provider 下新增 Models 分类。
> 被取代的部分：独立的 `launch_profiles` 实体与 REST、Settings 的 Profiles tab、composer 的 profile 下拉、
> 缺省 profile、会话级 profile 锁定，以及“密钥不入库”（现允许存于 config_json，但只写、读接口不回传、auth.db 0600）。
> 仍然有效的部分：env 键名白名单与两路校验、wire 协议只传模型不传 env、上下文窗口取代全局 CONTEXT_WINDOW、
> toolsSettings 不纳入配置、编译层 `resolveLaunchSpec` 的设计。
> 权威记录：`adr/ADR-002-*.md` 与 `goals/GOAL-001-*.md`；下文保留为历史设计依据，未逐段改写。
>
> **⚠️ 2026-09-21：独立实体已拆除完毕。** `launch_profiles` 表与列、`/api/launch-profiles` 路由、
> Settings 的 Profiles tab、composer 的 profile 下拉、旧编译入口 `resolveLaunchSpec` 均已从仓库删除；
> 唯一保留的等价性验收面是 AC-001 的黄金基准，它已移植到新入口
> （`server/modules/providers/tests/passthrough-parity.test.ts`：未选带配置的模型时 spawn 环境与本变更前逐字一致）。
> 本文以下内容仅作历史设计依据。


状态：Proposal / 待评审

## 摘要

为 CloudCLI UI 增加 **Launch Profile** 机制：一份具名的、可在 Web UI 中管理的
Claude Code 启动配置，封装服务端点、认证方式、模型别名、会话默认参数与环境变量。
用户在新建会话时选择 profile，后端据此编译出 spawn 前注入的环境与参数，
使同一个 CloudCLI 实例可以同时对接 Anthropic 官方服务、LLM Gateway、
Amazon Bedrock、Google Vertex 等多种部署形态。

本方案的核心判断是：**一个 profile 本质上就是「一组环境变量 + 少量类型化覆盖项」**，
因此不引入 launcher 包装脚本概念，而是在既有的四个注入点上接一层解析。

## 背景与现状

### 用户的实际启动方式

典型的本地多供应商用法是一个 wrapper 脚本加一串环境变量：

```bash
CLAUDE_CODE_MAX_CONTEXT_TOKENS=917000 \
CLAUDE_CODE_AUTO_COMPACT_WINDOW=917000 \
CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80 \
CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 \
CLAUDE_CODE_DISABLE_MOUSE=1 \
claude-fjdac --permission-mode bypassPermissions --prompt-suggestions false
```

其中 `claude-fjdac` 是一个 wrapper，它只做两件事：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:26510/"
export ANTHROPIC_AUTH_TOKEN=...
export ANTHROPIC_DEFAULT_HAIKU_MODEL="v4.1flash"
export ANTHROPIC_DEFAULT_SONNET_MODEL="v4.1flash"
export ANTHROPIC_DEFAULT_OPUS_MODEL="v4.1flash"
exec claude "$@"
```

即 **export 一组环境变量，然后 exec claude**。这正是官方 LLM Gateway 部署形态的做法，
也是本方案不需要保留 launcher 概念的原因。

### CloudCLI 当前的两条启动路径

**路径 A — 聊天界面（Agent SDK）**
`server/modules/providers/list/claude/claude-runtime.provider.js:219` 的
`mapCliOptionsToSDK()`：

- `:225` `sdkOptions.env = { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS }`
  —— 整体继承 CloudCLI 服务进程的环境，无法按会话区分。
- `:231` 通过 `CLAUDE_CLI_PATH` 解析可执行文件（`server/shared/claude-cli-path.ts:139`），
  全局唯一。
- `:274` `sdkOptions.model` 取自 `options.model`，候选来自固定目录
  `CLAUDE_PREDEFINED_MODELS`（`claude-models.provider.ts:25`）与
  `provider_models` 自定义表的并集（`provider-models.service.ts:88-91`）。
- `:250-251` 勾选 `skipPermissions` 时强制 `permissionMode = 'bypassPermissions'`。
- `:287` `settingSources = ['project', 'user', 'local']`，硬编码。

**路径 B — 内置终端 Shell**
`server/modules/websocket/services/shell-websocket.service.ts:172` 的
`buildShellCommand()`：

- `:221-228` 命令硬编码为 `claude`，勾选 bypass 时追加 `--dangerously-skip-permissions`；
  恢复会话时拼成 `claude --resume "<id>" ... || claude ...`。
- 唯一自定义入口是 `initialCommand`，且 **恢复会话分支会忽略它** ——
  这是现存缺陷：`--resume` 时用户的启动参数全部丢失。
- `:402-415` pty 环境为 `{...process.env, TERM, COLORTERM, FORCE_COLOR}`。

### 现状的具体缺口

1. 无法在一个实例内同时使用多个服务端点或供应商。
2. 上下文窗口写死：`claude-runtime.provider.js:434` 与 `:528`
   以及 `provider-token-usage.service.ts:248` 都读 `process.env.CONTEXT_WINDOW`，
   缺省 160000。一个 917k 窗口的会话，用量百分比恒为错误值。
3. Shell 路径 `--resume` 丢失启动参数。
4. Settings 的 Agents 页只有「账号」与「权限」两类
   （`src/modules/settings/tabs/agents-settings/sections/content/`），
   没有任何环境、端点、CLI 路径的配置位。

## 官方能力约束

以下依据 Claude Code 官方文档（2026-09 查证）：

### 有原生 profile 机制吗？没有

Claude Code **没有** 原生的具名 profile。`claude --help`（v2.1.278）无 `--profile` 参数。
官方仓库存在多个功能请求且均未实现：

- <https://github.com/anthropics/claude-code/issues/20549>
- <https://github.com/anthropics/claude-code/issues/27359>
- <https://github.com/anthropics/claude-code/issues/41048>
- <https://github.com/anthropics/claude-code/issues/7075>

社区方案（`claude-code-profiles`、`claude-profile-switch`）一律基于
`CLAUDE_CONFIG_DIR` 切换整个配置目录。

**结论：CloudCLI 需要自行实现 profile，但可以完全构建在官方原语之上。**

### 可用的官方原语

- **`--settings <file-or-json>`**：会话级，优先级高于 user / project / local
  三层文件，低于 managed settings；只影响当前会话，不写文件。
- **settings 的 `env` 键**：`Record<string, string>`，启动时注入会话环境。
- **`permissions.defaultMode`**：等价于 `--permission-mode`。
- **`CLAUDE_CONFIG_DIR`**：重定向 `~/.claude`，可隔离账号、会话历史与插件。
- **设置优先级**：managed > 命令行 `--settings` > project local > project > user。

参考：<https://code.claude.com/docs/en/settings>

### 官方认可的第三方部署形态

- **LLM Gateway**：`ANTHROPIC_BASE_URL`（以及
  `ANTHROPIC_BEDROCK_BASE_URL` / `ANTHROPIC_VERTEX_BASE_URL` /
  `ANTHROPIC_FOUNDRY_BASE_URL`）。
- **Amazon Bedrock / Google Cloud Agent Platform (Vertex) / Microsoft Foundry**。
- 官方明确建议第三方部署 **钉住模型别名**：
  `ANTHROPIC_DEFAULT_FABLE_MODEL`、`ANTHROPIC_DEFAULT_OPUS_MODEL`、
  `ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`，
  否则别名会落到内置默认值，可能滞后或未在账号中启用。

参考：<https://code.claude.com/docs/en/third-party-integrations>

### 已确认的环境变量

官方文档收录：`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、
`ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL`、
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`。

**未在官方 env-vars 页查到**：`CLAUDE_CODE_MAX_CONTEXT_TOKENS`、
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`、
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`、`CLAUDE_CODE_DISABLE_MOUSE`。
这些变量实际可用，但属于未公开接口，本方案按「尽力而为」对待：
它们通过 profile 的自定义 env 白名单传递，不作为类型化一等字段承诺其行为。

### Agent SDK 的选项面

`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 已完整覆盖本方案所需：

| 选项 | 行号 | 用途 |
|---|---|---|
| `env?: Record<string, string \| undefined>` | 1406 | 环境注入 |
| `extraArgs?: Record<string, string \| null>` | 1423 | 追加 CLI 参数 |
| `settings?: string \| Settings` | 1803 | **可直接传对象，无需落盘、不进 argv** |
| `settingSources?: SettingSource[]` | 1838 | 控制加载哪几层设置文件 |
| `pathToClaudeCodeExecutable?: string` | 1659 | 自定义可执行文件 |
| `fallbackModel?: string` | — | 主模型不可用时的回退 |

`settings` 接受对象这一点很关键：它让密钥完全不必进入命令行参数或临时文件。

## 目标与非目标

### 目标

1. 在一个 CloudCLI 实例内支持多个具名启动配置，覆盖 Anthropic 官方服务与第三方供应商。
2. 让 Web UI 的会话与终端会话都能使用这些配置，行为一致。
3. 新建会话时可选择 profile，并有明确的缺省解析链。
4. 密钥不落库、不进命令行参数。
5. 修正上下文窗口显示，使其随 profile 变化。
6. 修复 Shell 路径 `--resume` 丢失启动参数的现存缺陷。
7. 升级后零配置即可保持现有行为不变。

### 非目标

- 不实现 Claude Code 账号级切换（OAuth 多账号），该能力依赖 `CLAUDE_CONFIG_DIR`
  的完整隔离，单列后续任务。
- 不把 `toolsSettings`（允许/禁止工具）纳入 profile，该配置继续由权限页按 provider 管理。
- 不在本期实现 codex / cursor / opencode 的 profile，仅预留数据模型与能力位。
- 不做 profile 的导入导出、团队共享或版本管理。
- 不迁移 `claude-runtime.provider.js` 全文到 TypeScript（见「实施代价」）。

## 已确认的设计决策

| 议题 | 决策 |
|---|---|
| 作用域 | **全局**。本地部署的 CloudCLI 绑定 host user，profile 与 `provider_models` 一样是实例级资源 |
| 密钥策略 | **只支持环境变量名引用与 `apiKeyHelper`**，密钥值永不入库 |
| 原始 env 逃生口 | **实现键名白名单** |
| 会话中途切换 profile | **禁止**。profile 在会话创建时锁定，变更需新建会话或 fork |
| `toolsSettings` | **不进 profile**，维持现有按 provider 的全局配置 |
| `contextWindow` | **per-profile 取代全局 `CONTEXT_WINDOW`，缺省回退** |

## 推荐架构

### 可复用的既有结构

本方案不新增独立子系统，而是在四个既有注入点上接一层解析：

| 既有设施 | 位置 | 复用方式 |
|---|---|---|
| `sessions.model` / `effort` 按会话持久化 | `server/modules/database/schema.ts:124` | 新增一列 `launch_profile_id`，同一套语义 |
| `provider_models` 自定义模型表 | `schema.ts:179` | 第三方模型 id 已有存放处，profile 只需引用 |
| `sdkOptions.env` / `settings` | `claude-runtime.provider.js:225` | SDK 路径注入点 |
| pty `env` | `shell-websocket.service.ts:402-415` | Shell 路径注入点 |
| `ProviderCapabilities` | `provider-capabilities.service.ts:11-37` | 新增 `supportsLaunchProfiles`，避免组件按 provider 分支 |
| `user_preferences` | `schema.ts:200`、`src/shared/userSettings.ts` | 记录「上次使用的 profile」 |

### 数据模型

profile 拆成两张表。拆分的唯一目的是：读接口可以返回完整配置而永不触及密钥引用以外的内容。

```sql
CREATE TABLE IF NOT EXISTS launch_profiles (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('claude','cursor','codex','opencode')),
    name TEXT NOT NULL,
    description TEXT,
    deployment TEXT NOT NULL DEFAULT 'anthropic',
        -- 'anthropic' | 'gateway' | 'bedrock' | 'vertex' | 'foundry'
    is_default INTEGER NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, name)
);

ALTER TABLE sessions ADD COLUMN launch_profile_id TEXT;
```

没有 `launch_profile_secrets` 表 —— 按决策，密钥不入库。

`launch_profiles` 不带 `user_id`：与 `provider_models`、`app_config` 一致，
本地部署的实例即单一 host user 的资源。`sessions` 表本身也没有 `user_id`，
因此 `sessions.launch_profile_id` 的外键语义是自洽的。

### `config_json` 的形状

```ts
/**
 * 一个启动配置档的非密钥部分。存储为 launch_profiles.config_json。
 * 所有字段可选，缺省即「不覆盖」，由 CloudCLI 服务进程的环境决定。
 */
type LaunchProfileConfig = {
  // —— 服务端点 ——
  baseUrl?: string;                 // ANTHROPIC_BASE_URL
  authMode: 'inherit' | 'envVar' | 'helper' | 'cloud';
  authEnvVarName?: string;          // authMode='envVar'：只存变量名，值由宿主环境提供
  authEnvVarTarget?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  apiKeyHelper?: string;            // authMode='helper'：可执行文件路径

  // —— 模型 ——
  defaultModel?: string;            // 会话创建时预选
  fallbackModel?: string;
  modelAliases?: {                  // 官方建议的第三方部署钉模型
    fable?: string; opus?: string; sonnet?: string; haiku?: string;
  };
  exposedModels?: string[];         // 模型选择器显示的子集；留空或省略 = 显示全部
  supportsEffort?: boolean;         // 第三方模型通常不支持 reasoning effort

  // —— 会话默认 ——
  permissionMode?: string;
  contextWindow?: number;           // 取代全局 CONTEXT_WINDOW
  autoCompactWindow?: number;
  autoCompactPct?: number;
  promptSuggestions?: boolean;
  bare?: boolean;

  // —— 高级 ——
  settingSources?: ('user' | 'project' | 'local')[];
  configDir?: string;               // CLAUDE_CONFIG_DIR，类型化字段，见「路径字段的校验」
  cliPath?: string;                 // 每 profile 覆盖 CLAUDE_CLI_PATH
  env?: Record<string, string>;     // 逃生口，受白名单约束
  settings?: Record<string, unknown>; // 原生 Claude Code settings 对象透传
};
```

`deployment` 字段直接对应官方部署形态。示例中的 fjdac 网关即：

```jsonc
{
  "deployment": "gateway",
  "baseUrl": "http://127.0.0.1:26510/",
  "authMode": "envVar",
  "authEnvVarName": "FJDAC_API_KEY",
  "authEnvVarTarget": "ANTHROPIC_AUTH_TOKEN",
  "modelAliases": { "haiku": "v4.1flash", "sonnet": "v4.1flash", "opus": "v4.1flash" },
  "defaultModel": "deepseek-v4-pro-anthropic",
  "supportsEffort": false,
  "contextWindow": 917000,
  "autoCompactWindow": 917000,
  "autoCompactPct": 80,
  "permissionMode": "bypassPermissions",
  "promptSuggestions": false
}
```

### 编译层：唯一的真相来源

新建 `server/modules/launch-profiles/`，核心是一个把 profile 编译成注入规格的服务：

```ts
/**
 * 一个 profile 编译后的启动规格。两条启动路径的唯一共享契约。
 * 由 resolveLaunchSpec() 产出，调用方不得再自行拼装 env 或 argv。
 */
type ResolvedLaunchSpec = {
  env: Record<string, string>;
  settings?: Record<string, unknown>;  // 交给 SDK 的 settings 对象
  model?: string;
  fallbackModel?: string;
  permissionMode?: string;
  settingSources?: ('user' | 'project' | 'local')[];
  cliPath?: string;
  argv: string[];                      // 仅 Shell 路径使用
  contextWindow: number;               // 供 token 用量计算
  warnings: string[];                  // 如引用的环境变量名在宿主环境不存在
};

resolveLaunchSpec(profileId: string | null, provider: LLMProvider): Promise<ResolvedLaunchSpec>
```

两个消费者：

**SDK 路径** —— `claude-runtime.provider.js:225` 附近：

```js
const spec = await resolveLaunchSpec(options.launchProfileId, 'claude');
sdkOptions.env = { ...process.env, ...spec.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: ... };
if (spec.settings) sdkOptions.settings = spec.settings;
if (spec.settingSources) sdkOptions.settingSources = spec.settingSources;
if (spec.fallbackModel) sdkOptions.fallbackModel = spec.fallbackModel;
const claudeExecutablePath = resolveClaudeCodeExecutablePath(spec.cliPath ?? process.env.CLAUDE_CLI_PATH);
```

**Shell 路径** —— `shell-websocket.service.ts`：
`buildShellCommand()` 追加 `spec.argv`，pty 的 `env` 并入 `spec.env`。
**`--resume` 分支必须同样带上**，这即是对现存缺陷的修复。

### 优先级链

```
managed settings
  > 本回合用户显式选择（composer 的模型 / 权限菜单）
  > profile
  > CloudCLI 服务进程继承的环境
  > 内置默认
```

即：profile 覆盖进程环境，但不覆盖用户刚刚手动点选的那一次；
模型选择器的**候选列表**由 profile 的 `exposedModels` 过滤。

### 上下文窗口的修正

`spec.contextWindow` 取代以下三处的 `process.env.CONTEXT_WINDOW`：

- `claude-runtime.provider.js:434`
- `claude-runtime.provider.js:528`
- `provider-token-usage.service.ts:248`

解析顺序：`profile.contextWindow` → `process.env.CONTEXT_WINDOW` → `160000`。

前端无需改动：经查证 `src/` 下不存在 `contextWindow` 或 `VITE_CONTEXT_WINDOW`
的消费点，用量百分比完全由后端 `total` 字段驱动。

因此 `.env.example` 的处置是：

- **`CONTEXT_WINDOW` 保留**，作为 passthrough profile 与未设 `contextWindow`
  的 profile 的回退值。
- **`VITE_CONTEXT_WINDOW` 本期直接移除**，不做废弃标注。它已无任何消费点，
  是一个调了不生效的死配置；保留一个不起作用的配置项比删除它更有害，
  而「标注废弃」只适用于仍在生效的东西。

## 安全设计

### 1. 密钥不入库

`authMode` 只提供两条不落库的路径：

- **`envVar`**：profile 存变量名（如 `FJDAC_API_KEY`），编译时从 CloudCLI
  服务进程环境读取其值，写入 `authEnvVarTarget` 指定的目标变量。
  这与现有 wrapper 从 key 文件 source 的做法等价。
- **`helper`**：写入 settings 的 `apiKeyHelper`，由 Claude Code 自行调用。

若引用的变量在宿主环境不存在，编译产出 `warnings`，UI 明确提示，
**不静默回退到继承环境** —— 否则会出现「以为在用网关、实际打到官方端点」的静默错误。

### 2. 密钥绝不进 argv

两条路径都只经环境变量注入。特别禁止 `--settings '<inline json>'` 携带凭据，
因为它会出现在 `ps` 输出中。SDK 的 `settings` 接受对象（`sdk.d.ts:1803`），
Shell 路径经 pty env，两者都不需要临时文件。

若未来确有落盘需求，必须 0600 权限且在进程退出时删除。

### 3. 客户端只传 profile id

现状 `chat-websocket.service.ts:271-284` 的 `dispatchRun` 把 `clientOptions`
整体 spread 进 `runtimeOptions`。若 profile 的 env 由前端传递，
任何能连上 WebSocket 的客户端都能注入 `PATH`、`NODE_OPTIONS`、`LD_PRELOAD`
从而在服务器上执行任意代码。

因此 wire 协议只承载 `launchProfileId`，服务端负责解析成 spec。
`resolveSendTarget`（`:170-200`）已经遵循「会话属性一律从 DB 读、不信客户端」的模式，
profile 沿用同一原则。

### 4. 环境变量键名白名单

`config.env` 的键必须通过白名单校验，且在 **写入路径**（新建 / 更新 profile）与
**编译路径**（`resolveLaunchSpec`）上各校验一次 —— 前者给出可读报错，
后者是最后防线，保证历史遗留数据或绕过接口写入的记录同样无法生效：

**允许的前缀**：`ANTHROPIC_`、`CLAUDE_CODE_`、`CLAUDE_AUTOCOMPACT_`

**允许的精确键**：`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、
`ENABLE_TOOL_SEARCH`、`DISABLE_TELEMETRY`

**显式拒绝（即使匹配前缀）**：`PATH`、`NODE_OPTIONS`、`NODE_PATH`、
`LD_PRELOAD`、`LD_LIBRARY_PATH`、`DYLD_*`、`BASH_ENV`、`ENV`、`SHELL`、
`IFS`、`PYTHONPATH`、`CLAUDE_CLI_PATH`、`CLAUDE_CONFIG_DIR`

最后两个被拒绝是因为它们已有类型化字段（`cliPath` / `configDir`），
走字段可以施加路径校验；从裸 env 传入则绕过校验。

白名单与校验函数属于 launch-profiles 模块私有，定义在
`launch-spec.service.ts` 中并由同模块的 service 复用。
按后端标准「保持 route 轻薄」，route 不自行校验，
而是调用 service 的写入方法由其抛出校验错误。
仓库当前没有 `server/shared/constants.ts`，本方案不为此新建该文件。
需配套针对每一条拒绝规则的单元测试。

### 5. 白名单的边界必须诚实说明

即便有白名单，`cliPath` 与 `configDir` 仍然指向任意路径，
能配置 profile 的人本质上仍能影响被启动的进程。
本方案不宣称 profile 是一道权限边界 —— 它的定位是
「绑定 host user 的本地部署中的配置便利」。
若 CloudCLI 将来面向多租户开放，profile 的写权限必须单独收归管理员。

### 6. 路径字段的校验

`configDir` 与 `cliPath` 是白名单之外仅有的两个可指向任意路径的字段。
校验规则**不限制基目录** —— 限制在某个基目录下会挡掉
「指向已有的 `~/.claude-work`」这类合理用法，
而它提供的安全增益接近于零（能配置 profile 的人本就能设 `cliPath`）。

`configDir` 的规则：

1. 必须是绝对路径。
2. 目标存在时必须是目录且可写；不存在时其父目录必须存在且可写。
3. **禁止指向任一 git 工作区内部。**

第 3 条不是理论风险：Claude Code 会把会话历史与凭据写进该目录，
落在仓库里就可能被误提交。校验实现为向上查找 `.git`，
命中则拒绝并给出明确报错。

`cliPath` 沿用既有的 `resolveClaudeCodeExecutablePath`
（`server/shared/claude-cli-path.ts:139`）解析逻辑，额外要求解析结果存在且可执行。

## Settings 页交互

### 位置

在 Agents tab 的分类导航（`AgentCategoryTabsSection.tsx`）中新增第三项：

```
账号  |  Profiles  |  权限
```

由 `AgentCategoryContentSection.tsx` 按 category 分发到新增的 `ProfilesContent.tsx`。
仅当该 provider 的 `supportsLaunchProfiles` 为真时显示该分类。

### 布局：主从结构

**左栏 —— profile 列表**

- 按当前 provider 过滤，`sort_order` 排序，可拖拽
- 默认项带「默认」徽标
- 每行显示名称与 deployment 徽章（官方 / 网关 / Bedrock / Vertex / Foundry）
- 底部：「新建」与「从模板新建」，模板预置
  `Anthropic 官方`、`LLM Gateway`、`Amazon Bedrock`、`Google Vertex`

**右栏 —— 编辑器，五段式**

1. **基本**：名称、说明、设为默认
2. **服务端点**：deployment 单选（联动显示后续字段）→ `baseUrl` →
   认证方式（继承环境 / 环境变量名 / apiKeyHelper / 云凭据）。
   选「环境变量名」时填写变量名与目标变量，并**实时显示该变量在服务端是否存在**
3. **模型**：默认模型（下拉合并 `CLAUDE_PREDEFINED_MODELS` 与 `provider_models`
   自定义项，支持就地新建）、四个别名钉选、fallback、暴露子集、是否支持 effort
4. **会话默认**：权限模式、上下文窗口、auto-compact 窗口与百分比、
   prompt suggestions、bare
5. **高级**：settingSources 多选、`CLAUDE_CONFIG_DIR`、CLI 路径、
   自定义环境变量 KV 表（违反白名单时行内报错）、原始 settings JSON

**底部动作**

- **测试连接**（主按钮，**不产生计费**）：服务端以该 profile 的 env 执行
  `claude --version` 验证可执行文件、对 `baseUrl` 做一次 HTTP 可达性探测、
  检查 `authEnvVarName` 引用的变量在宿主环境是否存在，
  并复用 `claude-auth.provider.ts:88-105` 判定最终生效的认证方式。
  回报认证方式、端点可达性与 `warnings`
- **深度测试**（次级按钮，文案明确标注「会产生一次真实 API 调用」）：
  发起一次最小的 `-p` 调用，验证模型 id 真实可用。
  这是主按钮唯一覆盖不到的失败形态 —— 第三方网关上
  `unrecognized_model` 是高频错误，没有这个能力会让调试非常困难；
  但为这一个场景默认计费并不划算，因此拆成两段
- **复制为新 profile**
- **删除**（被会话引用时提示影响范围，采用置空而非级联删除）

**生效预览面板**

可展开，显示编译后的最终 `env` 与 `argv`，密钥值掩码。
这是排查「为什么这个会话用了那个模型 / 那个端点」的唯一有效手段，建议不要省略。

### i18n

需要在 8 个语言的 `src/modules/i18n/locales/*/settings.json` 中补充 `profiles.*` 键。

## 会话创建入口

### 三处入口，职责不同

**1. 空状态的 provider / 模型选择器** ——
`src/modules/chat/transcript/ProviderSelectionEmptyState.tsx:148-158`

这是真正的「选哪个 agent」入口，现为 provider × model 两层。
改为 provider 选定后先出一行 profile chip，再列出该 profile 允许的模型。
默认 profile 预选中。这是本方案主要的用户可见变化。

**2. Composer 的模型菜单** —— `src/modules/chat/composer/ChatComposer.tsx:481-496`
的 `ComposerModelMenu`

顶部新增 profile 段。因为切换 profile 会改变模型候选集，
两者必须在同一菜单内，否则交互割裂。
**会话已开始后该段置灰**，并提示「profile 已锁定，新建会话或 fork 可更换」。

**3. 侧栏新建会话** —— `src/modules/sidebar/SidebarProjectSessions.tsx:96,108`
→ `useProjectsState.ts:1047-1060` 的 `handleNewSession`

不放选择器，走默认解析链即可。
可选增强：做成 split button，下拉直接按指定 profile 新建。

### 缺省解析链

```
sessions.launch_profile_id                      （会话已锁定）
  → user_preferences.lastLaunchProfile[provider] （上次使用，跟随用户跨设备）
  → launch_profiles.is_default (该 provider)      （实例默认）
  → 内置 passthrough profile                      （继承环境）
```

**内置 passthrough profile** 不入库、不可删、不可编辑，
语义等同于今日行为（纯 `{...process.env}`，无任何覆盖）。
它保证升级后现有安装行为零变化，也不强迫任何人先配 profile 才能使用。
在 UI 中显示为「继承服务器环境」并标注为内置。

**不提供「固化为真实记录」。** 把当前服务器环境另存为具名 profile
需要读出环境中的 token 值并写入某处，与「密钥不入库」的决策直接冲突。
「照着填一个新 profile」的需求由预置模板（gateway / Bedrock / Vertex）覆盖，
这也让 passthrough 的语义保持单一：它就是「不覆盖任何东西」。

### 持久化位置

沿用既有约定：

- **会话级**：写 `sessions.launch_profile_id`。写入点与 model / effort 相同，
  即 `chat-websocket.service.ts:245-250`。
- **上次使用**：写 `user_preferences`，新增键 `lastLaunchProfile`，
  形如 `Record<LLMProvider, string>`，仿 `selectedProvider`
  （`src/shared/selectedProvider.ts`）。

需要注意现状是不一致的：model / effort 同时存在于 localStorage 与 `sessions` 行，
permissionMode 仅在 localStorage。**profile 必须落服务端**，
因为 resume 与 Shell 路径都在后端解析，localStorage 对它们不可见。

### 锁定语义的实现

`dispatchRun` 在会话首次 send 时写入 `launch_profile_id`；
其后若客户端传来的 `launchProfileId` 与已存值不符，
服务端以 **已存值为准** 并在响应中回带 `profileLocked: true`，
前端据此纠正 UI。不报错、不中断会话。

fork 会话（`supportsSessionForking`）时复制源会话的 `launch_profile_id`，
但允许在 fork 对话框中更换。

## Wire 协议变更

```diff
  // src/modules/chat/hooks/useChatComposerState.ts:621-648 buildSendOptions
  {
    model, effort, permissionMode, toolsSettings, skipPermissions, sessionSummary,
+   launchProfileId?: string,
  }
```

```diff
  // POST /api/providers/sessions  (provider.routes.ts:728-738)
  { provider, projectPath, initialMessage,
+   launchProfileId?: string }
```

新增 REST 端点（`server/modules/launch-profiles/launch-profiles.routes.ts`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/launch-profiles` | 列表，可按 `?provider=` 过滤，含内置 passthrough |
| POST | `/api/launch-profiles` | 新建 |
| PATCH | `/api/launch-profiles/:id` | 更新 |
| DELETE | `/api/launch-profiles/:id` | 删除 |
| POST | `/api/launch-profiles/:id/default` | 设为该 provider 默认 |
| POST | `/api/launch-profiles/:id/test` | 测试连接（不计费） |
| POST | `/api/launch-profiles/:id/test-deep` | 深度测试（一次真实 API 调用） |
| GET | `/api/launch-profiles/:id/preview` | 生效预览，密钥掩码 |

能力位（`provider-capabilities.service.ts:11-37`）新增：

```ts
/** Whether launch profiles can parameterize this provider's runtime. */
supportsLaunchProfiles: boolean;
```

claude 初期为 `true`，其余三者为 `false`。
该文件的既有注释明确要求新增 provider 能力声明于此，而非在 React 组件中按 id 分支。

## 变更范围

### 后端（遵循 `.agents/skills/backend-module-standards`）

新增：

```
server/modules/launch-profiles/
├── index.ts                      # barrel，仅导出 resolveLaunchSpec 与 service 契约
├── launch-profiles.routes.ts     # 仅解析入参、调 service、格式化响应
├── launch-profiles.service.ts    # CRUD、默认项、测试连接
├── launch-spec.service.ts        # 编译层：profile → ResolvedLaunchSpec
└── tests/
    ├── launch-spec.service.test.ts
    ├── launch-profiles.service.test.ts
    └── launch-profiles.routes.test.ts
```

- 仓储：`server/modules/database/repositories/launch-profiles.db.ts`
  （仿 `user-preferences.db.ts:22-79`）
- schema：`server/modules/database/schema.ts` 新增建表 SQL 与 `sessions` 列迁移
- 共享类型 `LaunchProfile`、`LaunchProfileConfig`、`ResolvedLaunchSpec`
  → `server/shared/types.ts`，按分组注释格式归类

修改：

- `claude-runtime.provider.js:219-290` —— 接入 spec
- `claude-runtime.provider.js:434,528` —— contextWindow 来源
- `provider-token-usage.service.ts:248` —— 同上
- `shell-websocket.service.ts:172-228,402-415` —— argv 与 env，含 resume 分支
- `chat-websocket.service.ts:208-300` —— 解析 profileId、持久化、锁定语义
- `provider-capabilities.service.ts` —— 新增能力位

### 前端（遵循 `.agents/skills/frontend-module-standards`）

新增：

```
src/modules/settings/tabs/agents-settings/sections/content/ProfilesContent.tsx
src/modules/settings/tabs/agents-settings/sections/content/profiles/
├── ProfileList.tsx
├── ProfileEditor.tsx
├── ProfileEndpointSection.tsx
├── ProfileModelSection.tsx
├── ProfileAdvancedSection.tsx
└── ProfileSpecPreview.tsx
```

- 类型 `LaunchProfile` 等 → `src/shared/types.ts`（多处消费）
- 端点 → `src/shared/api.ts`
- 选择态并入已管理 provider / model / effort / permissionMode 的
  `src/modules/chat/hooks/useChatProviderState.ts`
- 测试置于 `src/modules/settings/tests/` 与 `src/modules/chat/tests/`

修改：

- `ProviderSelectionEmptyState.tsx` —— profile chip 行
- `ChatComposer.tsx` / `ComposerModelMenu` —— profile 段与锁定态
- `AgentCategoryTabsSection.tsx` / `AgentCategoryContentSection.tsx` —— 新分类
- `useChatComposerState.ts:621-648,808-828` —— 送出 `launchProfileId`
- 8 个 `locales/*/settings.json`

### 实施代价：一处需要决定

`claude-runtime.provider.js` 是 1233 行的 JavaScript。
后端标准要求「被触碰的 JS 工具应迁移到 TypeScript」，
但整体迁移会使本改动膨胀数倍并引入不相关的回归面。

**建议**：编译逻辑全部放在新的 TS service 中，
在该 JS 文件内只改动调用点（约 10 行），全量迁移另立任务。
此为对标准的一次有意识的、有界的偏离，需在评审中确认。

## 测试与验收标准

### 单元测试

- `launch-spec.service.test.ts`
  - 各 deployment 形态编译出的 env 键值正确
  - `authMode='envVar'` 且宿主变量存在 → 写入目标变量
  - `authMode='envVar'` 且宿主变量缺失 → 产出 warning，**不静默继承**
  - `modelAliases` 映射到四个 `ANTHROPIC_DEFAULT_*_MODEL`
  - contextWindow 解析顺序：profile → env → 160000
  - profileId 为 null → passthrough，env 与今日行为逐字一致
  - `exposedModels` 为空或省略 → 返回全部模型
- 路径字段校验
  - `configDir` 为相对路径 / 父目录不存在 / 位于 git 工作区内 → 拒绝
  - `cliPath` 解析结果不存在或不可执行 → 拒绝
- env 白名单
  - `PATH`、`NODE_OPTIONS`、`LD_PRELOAD`、`BASH_ENV` 等被拒
  - `CLAUDE_CLI_PATH`、`CLAUDE_CONFIG_DIR` 从裸 env 传入时被拒
  - 合法前缀通过
  - 写入路径与编译路径各自独立拒绝
- `launch-profiles.service.test.ts`
  - 唯一默认项约束：设新默认时清除旧默认
  - 删除被会话引用的 profile → 会话置空并回退到解析链
- Shell 命令构造
  - `--resume` 分支同样携带 spec.argv 与 env（回归测试，针对现存缺陷）
- 锁定语义
  - 已锁定会话传入不同 profileId → 以已存值为准并回带 `profileLocked`

### 集成测试

- 经 WebSocket `chat.send` 携带 `launchProfileId` → SDK 收到预期的
  `env` / `settings` / `model`（以 mock SDK 断言）
- 客户端伪造 `options.env` → 后端完全忽略（安全回归测试）
- 会话 resume 后 spec 与首轮一致

### 浏览器验收

1. 新建 gateway profile，认证选环境变量名，「测试连接」通过且无 token 消耗；
   「深度测试」能识别出不存在的模型 id
2. 空状态中选择该 profile 与其自定义模型，发送一轮对话成功
3. 会话内 profile 段置灰，提示锁定
4. 用量百分比按 profile 的 contextWindow 计算，而非 160000
5. 内置终端新建会话使用该 profile；断开重连 `--resume` 后配置仍然生效
6. 删除该 profile 后，原会话回退到默认且不报错
7. 不配置任何 profile 的全新实例，行为与本变更前逐字一致

## 分阶段实施

**P0 —— 打通**
表与迁移、编译 service、SDK 路径接入、passthrough 内置默认、最小 CRUD 界面。
验收标准：通过 Web UI 使用本地网关 profile 完成一轮真实对话。

**P1 —— 入口与保真**
三处入口的 profile 选择器、会话级持久化、锁定语义、resume 保真。

**P2 —— 完善**
Shell 路径（顺带修复 resume 丢参）、测试连接、生效预览、上下文窗口修正、
模板与 i18n。

**P3 —— 其余 provider**
codex / cursor / opencode。三者环境形状各异，
`opencode-runtime.provider.js:40-46` 已在自行合成 `OPENCODE_PERMISSION`，
需要各自的 config 形状，不应强行套用 Claude 的字段集。

## 评审中已决议的细节

以下六项在评审中提出并已定案，记录决策与理由：

1. **passthrough profile 不提供「固化」为真实记录。**
   固化需要读出服务端环境中的 token 并落盘，与「密钥不入库」冲突；
   该需求由预置模板覆盖。详见「缺省解析链」。

2. **`configDir` 不限制基目录，但禁止指向 git 工作区内部。**
   基目录限制会挡掉合理用法而安全增益接近于零；
   工作区限制则防止会话历史与凭据被误提交。详见「路径字段的校验」。

3. **测试连接拆成两段，主按钮不计费。**
   `--version` + 端点可达性 + 变量存在性能覆盖绝大多数配置错误；
   唯一覆盖不到的「模型 id 不存在」交给显式标注计费的「深度测试」。
   详见「Settings 页交互 / 底部动作」。

4. **`exposedModels` 留空表示显示全部。**
   空数组与「未配置」在 JSON 中难以区分，而「显示全部」是更安全的失败方向；
   「不显示任何」会让用户面对空下拉框且无从判断原因。UI 文案需写明。

5. **同名 model id 冲突本期不解决，约束前移到 UI。**
   `provider_models` 为 `UNIQUE(provider, model_id)`，不含 profile 维度。
   改表会波及 `provider-models.service.ts:88-91` 的合并逻辑与整套
   `/models` CRUD 端点，成本远超收益。
   实际缓解手段是 `exposedModels` 本就是 profile 级子集声明，
   UI 只显示本 profile 暴露的模型，用户不会同时看到两个同名项。
   数据层冲突仍然存在，作为已知限制记录在案，
   并在自定义模型命名上建议带供应商前缀。

6. **`CONTEXT_WINDOW` 保留为回退值，`VITE_CONTEXT_WINDOW` 本期移除。**
   详见「上下文窗口的修正」。

## 遗留的已知限制

- 自定义模型 id 在同一 provider 下全局唯一，跨 profile 不可重名（上文第 5 条）。
- profile 不是权限边界；`configDir` 与 `cliPath` 使得能配置 profile 的人
  仍可影响被启动的进程（见「安全设计 / 白名单的边界必须诚实说明」）。
- Claude Code 账号级切换（OAuth 多账号）不在本方案范围内，
  需要 `CLAUDE_CONFIG_DIR` 的完整隔离，单列后续任务。
