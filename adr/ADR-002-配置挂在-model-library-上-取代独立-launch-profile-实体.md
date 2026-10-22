---
id: ADR-002
title: 配置挂在 Model library 上，取代独立 launch profile 实体
status: accepted
supersedes:
  - ADR-001
---
## 背景

ADR-001 引入了独立的 launch profile 实体，并把它作为会话级、用户可见的概念。
实机使用（2026-09-20）暴露出该形状的根本问题：

- 同一个"模型"概念有两个入口：profile 的 `defaultModel` 与 composer 的模型菜单，
  聊天路径只消费 profile 的 env，`defaultModel` 不生效。
- 缺省 profile、"原生 claude 要不要建 profile"、composer 里两个并排的 "Default"，
  都是由"profile 与模型是两个独立选择"直接派生的可用性问题。
- 模型 id 与端点别名天然耦合（`ANTHROPIC_DEFAULT_*_MODEL` 必须与 `--model` 的后缀一致，
  否则 `unrecognized_model`），拆成两个控件反而把一致性交给用户维护。

用户历史启动命令除 `--permission-mode` 与 `--prompt-suggestions` 外全部是环境变量，
因此"每个模型携带一张环境变量表"足以表达，不需要类型化字段作为第一版前提。

## 决策

### 1. 取代 ADR-001 决策 1：配置挂在 Model library 的模型条目上，不再有独立 profile 实体

`provider_models` 增加 `config_json`（NULL 表示无覆盖）。发送时按 `(provider, model_id)`
查记录并编译。内置模型只读、无配置，因此天然等于"继承服务器环境"；
缺省模型沿用现有机制，不另设缺省 profile。Model library 从聊天弹窗提升为
Settings → Agents → 各 provider 下的一等分类 `models`。

### 2. 取代 ADR-001 决策 2：密钥允许存于 config_json，可用性优先

理由：把 token 放进数据库虽增加静态暴露面，但"读环境变量名"的方案要求用户先理解
进程环境、重启服务，实机中已证明这是最大的使用障碍（用户把存放 key 文件路径的变量
`FJDAC_API_KEY_FILE` 当成了 key 本身，界面无任何提示）。

约束（作为该决策的组成部分，不可省略）：
1. secret 行的值**只写**：任何读接口（模型列表、单个模型、错误响应）都不得回传值，
   只回 `isSet`。
2. 更新语义为"缺省则保留"：secret 行不带 value 提交表示保持原值。
3. `auth.db` 在打开时收紧为 0600（实机测得当前为 0644）。
4. 仍保留 `envref` 行类型（只存变量名，值在编译时读服务进程环境，不落库）。

### 3. 环境变量行有四种显式类型：value / secret / envref / unset

`unset` 从继承环境中移除指定键，是显式行类型，**不采用**"网关类 profile 默认清除
继承的 ANTHROPIC_API_KEY"的启发式：显式行可预期、可见、可审计，且不依赖对"什么是
网关"的猜测。防止发往第三方网关的请求携带宿主环境里可能属于 Anthropic 的 key，
由 "LLM 网关" 模板预置一条 `unset ANTHROPIC_API_KEY` 来保证，而不是隐式规则。
spec 必须能表达"移除某键"，并在 SDK 路径与终端路径的最终 spawn 环境中都真的生效。

### 4. 第一版包含 "LLM 网关" 模板

模板是纯前端常量：预填 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`（secret）、
三个 `ANTHROPIC_DEFAULT_*_MODEL`、`unset ANTHROPIC_API_KEY`。它是唯一让不熟悉
环境变量名的用户不必翻文档的东西。

### 5. 接受 `UNIQUE(provider, model_id)` 的限制

同一 model id 无法在两个端点并存（两个网关都暴露 `v4.1flash` 时不能同时配置）。
第一版接受，作为已知限制记录；将来若需要，须把会话对模型的引用从 model id 字符串
改为记录 id。

### 6. 保留 ADR-001 的其余决策

- env 键名白名单，写入路径与编译路径各校验一次；wire 协议不携带 env，只携带模型。
- `toolsSettings` 不纳入配置，继续由权限页按 provider 管理。
- 上下文窗口由模型条目解析并取代全局 `CONTEXT_WINDOW`（同一回退顺序）。
- 白名单不使配置成为权限边界。

## 明确不做（第一版）

端点共享、自定义模型的 effort 元数据、测试连接、终端路径接入、会话级 profile 锁定、
非 claude provider 的环境语义、类型化表单字段（baseUrl 等）。

## 已知风险（如实登记，未实测）

- 不做锁定意味着会话中途换模型即换端点。SDK 路径每轮重新 `query()` 拉起进程，
  技术上可行；但历史消息里的 thinking 块带签名，跨供应商 resume 可能出错。
  这是猜测，未验证，遇到再处理。
- 终端路径本期不接入，因此终端会话仍继承服务进程环境。

## 影响

- 现有 `launch_profiles` 表、`/api/launch-profiles` 路由、Settings 的 Profiles tab、
  composer 的 profile 下拉，在新机制经真实链路验证之后拆除，不提前拆。
  **✅ 2026-09-21 已拆除**（AC-027 经真实浏览器转绿之后）：表与 `launch_profile_id` 列、路由、
  Profiles tab、composer 下拉、会话级 profile 锁定与 `profile_locked` 帧、旧编译入口
  `resolveLaunchSpec` 均已删除，旧测试随对应 AC superseded 一并移除。
  唯一例外是 AC-001 的升级零变化黄金基准 —— 它被**移植**而非删除，现由新入口
  `resolveModelLaunchSpec` 驱动（`server/modules/providers/tests/passthrough-parity.test.ts`）。
- 编译层（白名单、上下文变量导出、`config.env` 并入）复用；旧入口 `resolveLaunchSpec` 已随拆除消失。
- 用户现有的 FJD profile 迁移为一个模型条目，空的 Claude profile 删除。
