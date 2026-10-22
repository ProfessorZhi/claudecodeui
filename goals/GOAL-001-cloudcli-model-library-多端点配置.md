---
id: GOAL-001
title: CloudCLI Model library 多端点配置
status: achieved
kind: goal
origin: ADR-002（取代 ADR-001）；docs/proposals/launch-profiles.md 仅作历史设计依据
activatedAt: 2026-09-20T03:23:55.627Z
statusLog:
  - at: 2026-09-20T03:23:55.627Z
    from: draft
    to: active
    actor: yale
    reason: 七条 AC 已立并全部实测为红（红先行），目标进入 active
  - at: 2026-09-20T06:04:57.610Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
  - at: 2026-09-20T06:35:09.467Z
    from: achieved
    to: active
    actor: yale
    reason: 范围复核：首次 achieved 时七条 AC 未覆盖 REST 路由、真实 profile 的 spec 产出与全部前端，补
      AC-008/009/010（均实测为红）后退回 active
  - at: 2026-09-20T06:54:19.444Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
  - at: 2026-09-20T07:43:42.792Z
    from: achieved
    to: active
    actor: yale
    reason: playwright 实机验证发现写入路径白名单缺失、i18n key 外泄、Profiles 编辑器仅
      name+model、会话创建入口无选择；补 AC-011/AC-012（均实测为红）后退回 active
  - at: 2026-09-20T13:43:24.453Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
让单个 CloudCLI 实例能同时对接 Anthropic 官方服务与第三方供应商（LLM Gateway / Bedrock / Vertex）。方式是：在 Model library 的自定义模型条目上挂一张环境变量表，选模型即选端点；不存在独立的 launch profile 实体（ADR-002 取代 ADR-001）。范围内：模型条目的配置存储与编译（SDK 路径）、Settings → Agents → 各 provider 下的 Models 一等分类、按模型的上下文窗口，以及【能复现用户历史上的 claude code 启动方式】，并且【一个没读过代码的人能在界面里用对它】。

非目标：Claude Code 账号级切换（OAuth 多账号）、codex/cursor/opencode 的环境语义、toolsSettings 纳入配置。

第一版明确延期（ADR-002）：终端路径接入、会话级锁定、端点共享、自定义模型的 effort 元数据、测试连接、类型化表单字段。延期不等于删除：对应的 AC-006、AC-007、AC-015、AC-016 已置为 superseded 并写明原因，重启时须重新立判据。

## 参照启动方式（本目标的验收基准）

用户历史上的主力启动方式是 claude-fjdac wrapper 加会话参数：ANTHROPIC_BASE_URL 指向本地网关、token 来自宿主、三个 DEFAULT_*_MODEL 钉为 v4.1flash、--model deepseek-v4-pro-anthropic、CLAUDE_CODE_MAX_CONTEXT_TOKENS / AUTO_COMPACT_WINDOW 917000、CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 80、DISABLE_ALTERNATE_SCREEN / DISABLE_MOUSE、--permission-mode bypassPermissions、--prompt-suggestions false。除后两项外全部是环境变量，因此“模型条目 + env 表”足以表达；--permission-mode 继续由 composer 的权限菜单承担，--prompt-suggestions 第一版不覆盖。目标达成的含义是：这一整套能只经 Model library 表达，并且聊天路径真的生效，而不是只存得进库。

## 退出条件

全部退出条件都以“模型条目”为对象（无 profile 概念）：
- AC-001 升级零变化的黄金基准：未选带配置的模型时，spawn 环境与本变更前逐字一致。（既有判据，唯一保留；拆除旧实体时已移植到新入口。）
- AC-022 secret 只写、auth.db 权限 0600。
- AC-023 模型配置写入路径：四种行类型、白名单、重复 id 409、内置模型不可挂配置。
- AC-024 模型条目编译为真实 spawn 环境：value/secret/envref/unset 行，unset 在最终环境对象上真的生效；编译路径对每行重新校验白名单；以 fjdac 为参照 fixture。
- AC-025 网关请求带着模型条目里的凭据真实落地；宿主 ANTHROPIC_API_KEY 不出现；客户端伪造的 options.env 被忽略。
- AC-026 Settings → Agents → Models 是可用的一等页面：掩码、envref 实时状态与说明、warning 可见、LLM 网关模板、保存不丢字段。
- AC-027 真实浏览器端到端：建模型 → 刷新后 secret 仍为“已设置” → 在现有选择器选中 → 发送 → mock 收到请求。
- AC-028 上下文窗口的单一事实来源是模型条目的 CLAUDE_CODE_MAX_CONTEXT_TOKENS 行：同一个值既导出给 CLI，也决定用量 total。

## 历史沿革（下面列的不是现行判据，是已结清的历史）

本目标由「独立的 launch profile 实体」改题为「Model library 多端点配置」（ADR-002 取代 ADR-001），旧记录因此长期混着两代判据。以下两段是历史，读者不必把它们当作现行约束。

**旧判据的去向（2026-09-20 起）**——对象是旧 profile 实体，或属延期范围，不再是退出条件：
- 被取代：AC-002→025，AC-003→022，AC-004→024/025，AC-005→028，AC-008→023，AC-009→024，AC-010→026，AC-011→023，AC-012→027，AC-013→024，AC-014→028，AC-017→024，AC-018/019/020/021→026。
- 延期、无替代：AC-006（终端 resume 复用启动参数）、AC-007（会话级锁定）、AC-015（终端路径接入）、AC-016（类型化 permissionMode/promptSuggestions）。这四条是「这里欠一次重新决策」的欠条，不是可抹掉的历史噪声，故其 superseded 记录按要求原样保留：AC-007 尤其如此——跨供应商 resume 可能出错的风险已登记但未实测。
- AC-002 至 AC-021 共 28 条旧 AC 中，18 条 superseded，其余被上表取代；活的判据只有上面的「退出条件」八条。

**旧实体拆除（2026-09-21，已完成）**——原先以命令式写下的「拆除契约」已执行完毕，故在此记为既成事实，不再是待执行的约束：
- 拆除范围：`launch_profiles` 表与 `sessions.launch_profile_id` 列、`/api/launch-profiles` 路由、Settings 的 Profiles tab、composer 的 profile 下拉、旧编译入口 `resolveLaunchSpec`。
- 唯一例外按本目标要求移植而非移除：AC-001 的「升级零变化黄金基准」改由新入口 `resolveModelLaunchSpec` 驱动（`server/modules/providers/tests/passthrough-parity.test.ts`）；`shell-resume-launch-spec.test.ts` 亦因属性仍活着而改注入新缝隙保留。
- 其余旧测试随实体一并移除（session-profile-lock、launch-spec-real-profile、profile-rest-api、config-env-compiled、context-window-* 等），其对应 AC 均已 superseded。
- 拆除后 AC-028 的旧入口参数（`options.profile?.contextWindow`）随之消失，上下文窗口的取值路径只剩模型条目。
- 数据库侧残留（`launch_profiles` 表、`sessions.launch_profile_id` 列）由随后的 drop 迁移清除：升级既有安装与全新安装得到的结构一致，两处 profile 结构都不再存在。

## 已知不等价点与限制（如实登记）

- 旧记录：wrapper 同时导出 ANTHROPIC_AUTH_TOKEN 与 ANTHROPIC_API_KEY，而旧 profile 只有单一目标。B 方案下 env 行可自由设置任意白名单键，此点不再是限制；但“LLM 网关”模板预置的是 unset ANTHROPIC_API_KEY。
- UNIQUE(provider, model_id)：同一 model id 无法在两个端点并存（ADR-002 决策 5）。
- 目标存储把 supersedes 建模为单值：一条新 AC 取代多条旧 AC 时，新侧只记录其中一条；完整的取代关系以旧侧 supersededBy 为准，并汇总在「历史沿革」里。

## 修订记录

2026-09-21：收拾这份记录本身（用户已裁定「要收拾」）。文件名由 `GOAL-001-cloudcli-launch-profiles.md` 改为与 `title` 一致（id 保持 GOAL-001）；把「已废弃的判据」与正文里的「拆除契约」两节收敛为一条「历史沿革」小节——拆除已完成，拆除契约从待执行的约束变成已执行的记录，继续以命令式措辞留在正文会误导下一个读者。AC-006/007/015/016 的 superseded 记录（含 AC-007 的「延期、无替代」定性）原样保留。

2026-09-20：此前的版本写「范围内 UI 项不单列退出条件」。实机验证证明这一条放过了 i18n key 外泄、编辑器仅 name+model、会话入口缺失三处缺陷，现予撤回，UI 由 AC-012 与 AC-018 单列（二者已于 2026-09-20（三）被 AC-026/AC-027 取代）。

2026-09-20（二）：用户在 Settings-Profiles 里实际使用时提出三个问题——凭据变量名“在哪儿设”、是否要为原生 claude 另建 profile、能否设缺省——playwright 与代码复核证实它们都是界面缺口，并牵出更多：保存一次即清掉 isDefault/description/sortOrder；is_default 在服务端解析中无任何消费点；网关 profile 不清除继承来的 ANTHROPIC_API_KEY；会话锁定后下拉仍可改且重开不回显。此前 18 条 AC 全部只验证“机制存在”，没有一条验证“不读代码的人能用对”，故补 AC-019/020/021。

依据（如实登记）：用户现有的 FJD profile 填的是 FJDAC_API_KEY_FILE（wrapper 里存放 key 文件路径的变量），而服务进程环境里只有 FJDAC_API_KEY，界面对此无任何提示；服务进程还继承了 ANTHROPIC_API_KEY 与 917k 上下文变量，因为它是在一个 Claude Code 会话里启动的。所谓“原生”行为继承的是服务进程环境，而不是干净环境。

2026-09-20（三）：用户提出改为基于 Model library 扩展、不再单独开发 profile，并裁定：先实现 B；密钥保留在 config_json（可用性优先）；Model library 提到 Settings 作为一等公民；unset 作为显式行类型；同 model id 不能跨端点并存，第一版接受；第一版含 LLM 网关模板；撤回旧任务。ADR-002 取代 ADR-001。旧 AC 中 12 条被取代、3 条延期，新增 AC-022 至 AC-027（其后 (四) 又取代 4 条、延期 1 条，新增 AC-028）。driver 上对应旧实体的任务 default-profile-honored、credential-usability-floor、reference-profile-ui-e2e 已置 superseded（worktree 与分支当时保留，已于 2026-09-20（四）删除）；partial-update-preserves-fields 已完成，其防线由 AC-026 重述。

2026-09-20（四）：复核 GOAL 与全部 AC 是否符合 ADR-002 的方向。原保留的六条既有 AC 中，除 AC-001 外均以旧 profile 实体或类型化字段为对象：AC-004、AC-013 改由 AC-024/025 接管（把它们独有的半边——编译路径重校验、WebSocket 伪造 env 被忽略——补进 AC-024/025 的 expect，避免覆盖丢失）；AC-005、AC-014 由新增的 AC-028 取代（B 方案没有类型化字段，上下文窗口就是一行 env）；AC-006 属终端路径，随延期置为 superseded。AC-001 判据保留，措辞由“未配置任何 profile”改为“未选带配置的模型”。GOAL 标题由“CloudCLI launch profiles”改为反映当前形状。driver 上重复任务与四个旧任务的 worktree 与分支已删除。
