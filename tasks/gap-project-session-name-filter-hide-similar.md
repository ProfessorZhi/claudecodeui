---
id: gap-project-session-name-filter-hide-similar
title: 项目级会话名过滤（第二步）：会话行菜单「隐藏同类」，把会话名归一化转义后预填为一条规则并请人确认
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-project-session-name-filter-sidebar-ui
---
## Proposal

<!-- dedup-ref -->本任务是项目级会话名过滤的第二步快捷操作，规则编辑面板与保存接口由 gap-project-session-name-filter-sidebar-ui 与 gap-project-session-name-filter-backend 提供，本任务只在其上增加一个入口，不新增接口。

方案（已与人讨论确认：放在第二步，不进第一步）：
1. 新增纯函数 `deriveSimilarNamePattern(name)`：把会话名转义为合法正则，并把其中的数字串、十六进制哈希（8 位及以上）、日期时间片段替换为通配（如 `\d+`、`[0-9a-f]{8,}`），使同一类会话能被一条规则覆盖；对纯人类标题（无数字/哈希可归一的普通句子）返回锚定的完整转义名，避免误伤。结果必须能通过后端的正则校验（可编译、长度 ≤200）。
2. 会话行菜单（`SessionOptions.tsx`）新增「隐藏同类」：点击后打开已有规则编辑面板，把推导出的正则追加为新的一行并聚焦，由人确认后再保存；不直接写库、不自动保存。
3. 追加时若该行已存在于规则里则不重复追加并提示已存在。
4. 遵循 `.agents/skills/frontend-module-standards/SKILL.md`，文案补进现有 i18n 语言文件。

## AC

- [x] `npx vitest run src/modules/sidebar/tests/deriveSimilarNamePattern.test.ts` 退出码 0：`claudecodeui-task-worker`、含数字后缀的名字、含 8 位以上哈希的名字各自推导出的正则能命中原名与同类名，且不命中明显无关的名字；所有推导结果 `new RegExp(x)` 不抛错且长度 ≤200；普通中文句子标题推导出锚定的完整转义名。
- [x] `npx vitest run src/modules/sidebar/tests/sessionOptionsHideSimilar.test.tsx` 退出码 0：点「隐藏同类」后规则面板打开且文本框新增一行推导出的正则、不触发保存请求；规则已含同一行时不重复追加。
- [x] `npm run test:client` 与 `npm run typecheck` 退出码 0（既有前端测试不回归）。

## DoD

真实落地判据：不是仅有纯函数与测试存在。要求在真实运行的 cloudcli 里，对 claudecodeui 项目中一个真实的 `claudecodeui-task-worker` 会话点「隐藏同类」，面板出现推导规则，预览显示命中该类全部会话（约 17 个）且不含真人会话，人确认保存后列表随之收敛；操作记录写入完成记录。取假变体：把推导结果换成未转义的原名时，含正则元字符名字的测试必须变红。

## Touches

- src/modules/sidebar/utils/deriveSimilarNamePattern.ts (new)
- src/modules/sidebar/SessionOptions.tsx
- src/modules/sidebar/SessionFilterEditor.tsx
- src/modules/sidebar/SidebarSessionItem.tsx
- src/modules/sidebar/SidebarProjectSessions.tsx
- src/modules/sidebar/SidebarProjectItem.tsx
- src/modules/sidebar/Sidebar.tsx
- src/modules/sidebar/SidebarModals.tsx
- src/shared/types.ts
- src/modules/i18n/locales/en/sidebar.json
- src/modules/i18n/locales/zh-CN/sidebar.json
- src/modules/sidebar/tests/deriveSimilarNamePattern.test.ts (new)
- src/modules/sidebar/tests/sessionOptionsHideSimilar.test.tsx (new)
- tasks/gap-project-session-name-filter-hide-similar.md
