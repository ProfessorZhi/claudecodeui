---
id: AC-180
title: 用 Enter 键发送与点发送按钮等价：开关打开即代表意图，按下 Enter 落成常驻
status: achieved
kind: criterion
goal: GOAL-013
criterion: npx playwright test e2e/resident-enter-send.spec.ts
expect: 新建会话时打开常驻开关。(a) 开关打开后按 Enter 发送，服务端读回该会话 lifecycle_mode 为
  resident，且宿主列表里出现该会话的 resident 宿主。(b) 正控制：开关关闭时按 Enter 照常发送，会话为
  per-run。开关位置是这次发送唯一的意图来源——开启即代表意图，不存在任何中间确认状态。取假形态：Enter
  键路径绕过记录常驻意图的提交入口（直接调底层 handleSubmit）⇒ (a) 必须红。
origin: 人 yale 2026-09-29 指令「继续。并创建必要的 AC 和 task」。来源：同日真浏览器验证，开关开着按 Enter
  发送，会话在库里是 per-run；未开启时按 Enter 消息照样发出。原因是
  src/modules/chat/hooks/useChatComposerState.ts 的 Enter 处理直接调 handleSubmit，绕过
  ChatComposer.tsx 里记录常驻意图的 handleComposerSubmit，而后者注释声称两个入口都经过它。AC-171
  只测发送按钮，所以一直读绿。人 yale 2026-09-29 另裁定：知情闸门随
  gap-resident-toggle-relocate-drop-consent-gate（6814265d）退休后，本 AC
  收窄到它真正的不变量——Enter 与发送按钮是同一个提交入口、开关位置是唯一意图来源；判据同步改写为「开关开 ⇒ resident 且真宿主持有；开关关
  ⇒ per-run 正控制」，不再引用已退休的中间确认控件。
activatedAt: 2026-09-29T03:28:20.131Z
statusLog:
  - at: 2026-09-29T08:33:03.011Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
