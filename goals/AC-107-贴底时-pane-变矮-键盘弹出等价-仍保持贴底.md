---
id: AC-107
title: 贴底时 pane 变矮（键盘弹出等价）仍保持贴底
status: achieved
kind: criterion
goal: GOAL-004
criterion: npx playwright test e2e/transcript-follow.spec.ts -g "AC-107"
expect: 真实浏览器、移动视口 390×844，贴底（gap=0，手势到达）后把视口高度改为 420（等价 iOS 键盘弹出令 shell
  收缩；不产生任何 scroll 事件），改变后的第一个采样点 gap ≤ 1px。对照：离开底部后做同样的收缩 → 零次程序写入 scrollTop。gap
  = scrollHeight − scrollTop − clientHeight，采样点必须在布局与 ResizeObserver
  回调之后（例如页面内一个后注册的 ResizeObserver，或 rAF 内再 setTimeout 0）；在 rAF 内直接读 scrollHeight
  读到的是 pin 之前的状态，不得当作绘制态。取假形态：只观察内容列、不观察 pane
  自身尺寸时本条必须红。当前必红：e2e/transcript-follow.spec.ts 不存在（playwright 报 No tests
  found）。现状实测 gap 424、1.5s 内零写入。
origin: 2026-09-21 实测（真实实例 :3001、真实 bundle，1440×900 与 390×844）：transcript
  的自动跟随只在 chatMessages.length 变化时触发（useChatSessionState.ts 的 follow
  effect），流式文本就地增长、markdown 重渲染、pane 变矮都不跟随；docs 里「流式期间浏览器把 pane 钉在底部」被实测证伪。
activatedAt: 2026-09-21T07:18:39.740Z
statusLog:
  - at: 2026-09-21T09:33:29.443Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
