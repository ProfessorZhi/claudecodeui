---
id: GOAL-004
title: 对话流在真实浏览器里跟随几何变化：贴底时始终看到最新输出，离开时不被拉回
status: achieved
kind: goal
origin: 2026-09-21 真实实例实测：transcript 的自动跟随以行数为触发信号，流式就地增长（gap 最大 252px、注入
  1608px）与 pane 变矮（424px）都不跟随；docs 中「浏览器在流式期间钉底」被证伪。与 GOAL-001/002/003 同形：jsdom
  单元测试证伪不了几何行为，只有真实浏览器里的目标级判据能抓住（人 yale 授权立此目标）。
activatedAt: 2026-09-21T07:19:38.943Z
statusLog:
  - at: 2026-09-21T14:27:11.353Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: all ACs achieved + sufficiency covered"
---
## 背景

transcript 只有一个滚动容器 div.chat-messages-pane，今天有五处代码写它的 scrollTop，靠五个 claim ref 协调；「贴底」这一意图由 isUserScrolledUp 表示，只在 scroll/wheel/touchmove 时重算。自动跟随由 useChatSessionState.ts 里的 follow effect 执行，它的触发信号是 chatMessages.length（行数）。

2026-09-21 在真实实例（:3001、真实 bundle，1440×900 与 390×844）上实测：
- 流式文本是同一行就地改写，行数不变 → 贴底时最后一行长高 1608px，零次 scrollTop 写入、零个 scroll 事件，视图不跟随；真实流式输出 gap 最大 252px，直到下一次行数变化才被拉回。
- 视口 844 → 420（等价 iOS 键盘弹出）→ gap 424px，1.5 秒内无人重新贴底。
- 浏览器的 scroll anchoring 只补偿视口上方的增长，对底部增长完全不作为；docs/architecture/05-scrolling.md 与 02-realtime-stream.md 里「流式期间浏览器把 pane 钉在底部」的说法因此是错的。
- 另据 caniuse，iOS Safari 截至 27.2 不支持 scroll anchoring（overflow-anchor），所以连「上方增长由浏览器补偿」在 iOS 真机上也不成立。
- PC 上「有时能贴底」是巧合：成块到达的更新常伴随行数变化，撞上了按行数触发的跟随。

## 范围

让「贴底」成为一个只由用户意图改变、由几何变化驱动的状态：
- 贴底时，任何原因造成的内容增长或 pane 尺寸变化（流式文本、markdown 重渲染、tool_result 内联、图片/字体、content-visibility 反跳过、键盘弹出、活动指示器 padding 切换）都在绘制前重新贴底。
- 离开底部只由用户输入决定（滚轮、触摸、导航键、拖滚动条），向上的意图立即生效，不受 50px 距底阈值约束；非用户输入引起的滚动（程序写入的回声、浏览器 clamp、scroll anchoring 调整、smooth 滚动）不改变意图。
- 翻页恢复、搜索跳转、隐藏标签页期间不自动贴底；翻页恢复结束后按恢复后的几何重判意图，而不是回到原意图。
- 上述行为在真实浏览器里有回归保护（e2e/transcript-follow.spec.ts），不再只有 jsdom 单元测试（jsdom 没有布局，stub 驱动的测试证伪不了几何行为）。
- 同步更新 05-scrolling.md、02-realtime-stream.md 中与此矛盾的描述。

## 非目标

- 不做「新回复开头停留」之类的阅读体验设计：一次跳变很大的块在贴底时直接贴到底，这是贴底的定义。
- 不依赖浏览器的 scroll anchoring 或 CSS 钉底技巧（overflow-anchor 哨兵、column-reverse）来实现贴底：iOS Safari 不支持 anchoring，column-reverse 与翻页恢复语义冲突。
- 不追查流式更新成块到达（实测一次 DOM 冻结 19 秒后一次性增长 1825px）的原因：那是 realtime 刷新链路的问题，另立任务。
- 不改动行内的滚动容器（bash 输出、文件列表、提问面板）。

## 退出条件

- AC-106 贴底时最后一行就地长高（不经 store、不改行数）后 gap ≤ 1px；离开底部时同样的增长不移动视图。
- AC-107 贴底时 pane 变矮（390×844 → 420，键盘弹出等价）后第一个采样点 gap ≤ 1px；离开底部时零写入。
- AC-108 由页内 wire double 夹具（不含任何模型/CLI/外部服务：无 mock gateway、无 SSE、无 claude 子进程、无 ANTHROPIC_* 环境变量）投递的慢速流式输出全程 gap ≤ 1px（走 realtime → store → React 就地改写的真实路径）。
- AC-109 同一夹具下，流式期间向上 30px 的滚轮手势、以及 PageUp，都立即脱离跟随且此后不被拉回；按「Scroll to bottom」后恢复贴底。
- AC-110 首屏不可滚时在顶部向上翻页，恢复后的位置不被后续增长抢回到底部。
- AC-111 视口上方的行变矮（无输入事件、由浏览器改变 scrollTop）不会让贴底状态脱离。

## 不做退出条件的范围内事

以下由实现任务的单元测试覆盖（jsdom + 可手动触发的 ResizeObserver stub，仿 lazyMessageRow.test.tsx 的 IntersectionObserver stub），不列为退出条件：
- 意图状态机的转移表。
- 搜索跳转期间零次自动贴底，跳转结束后为离开底部状态（smooth scrollIntoView 的结束时点）。
- 隐藏标签页（display:none，ResizeObserver 报 0×0）期间不改意图、不写入；重新显示时离开底部状态恢复原 scrollTop、贴底状态贴底。
- 用户发消息后贴底（取代 composer 里 +100ms 的无条件 scrollToBottom）。

## 已知不等价点与限制

- 所有判据跑在 Playwright 的 Chromium 里，不等于 iOS Safari。iOS 上离开底部时，视口上方的增长没有浏览器补偿，只靠 LazyMessageRow 卸载前量高与 contain-intrinsic-size: auto 维持阅读位置；这一漂移量应在真机或 WebKit 上实测并写入文档，但不作为退出条件。
- 键盘弹出用视口缩小来等价：真机 iOS 走 visualViewport.resize → --keyboard-height → shell 收缩，二者最终都表现为 pane 高度变化，但真机上 resize 事件是否在键盘动画结束后才派发未经实测。
- e2e 端口 47101/47173 是写死的：判据复跑与人手工跑 e2e 同时发生会撞端口、产生与本目标无关的红。
- goal gate 的 reason 字段取的是判据输出的第一行（当前是 WebServer 的 .env 缺失提示），不一定是真实失败原因；读红时看完整输出。

## 修订记录

2026-09-21：立（人 yale 授权）。来源是一次 PC + 移动视口的真实实例实测与据此的方案审查：审查结论是按几何信号驱动跟随、只保留一个写 scrollTop 的地方，并修正三处原方案缺陷（向上意图不受距底阈值约束、非输入滚动不改变意图、翻页恢复后按几何重判），另核实 iOS Safari 不支持 scroll anchoring。六条 AC 已立并逐条实测为红（红先行）：全部 exit 1，原因为 e2e/transcript-follow.spec.ts 不存在（No tests found）。
