---
id: AC-223
title: 搜索跳转复用并取代「全量拉取再放宽窗口」：搜索跳转走与轨道点击同一条 id 寻址窗口读，不再整段拉取
status: superseded
kind: criterion
goal: GOAL-017
criterion: for f in e2e/transcript-jump-to-turn.spec.ts; do [ -f "$f" ] || {
  echo "缺判据文件：$f" >&2; exit 1; }; done; npx playwright test
  e2e/transcript-jump-to-turn.spec.ts -g "AC-223"
expect: 真实浏览器，与 AC-213 v2 同一夹具与共用种子。读三条：(a) **不再整段拉取** —— 搜索跳转一条消息之后，网络层不出现形如
  `/messages` 且不带 `around` 的整段读（`limit=null` / offset 0 形态 0 次），取页只以
  `?around=<id>` 的窗口读发生；(b) **目标落位** —— 被跳转的那条消息整行落在视口内（与 AC-213
  同一条「整行可见」读数）；(c) **同一条路径** —— 该次跳转与轨道点击走同一个 id 寻址入口（同一个 `jumpToMessage` / 同一种
  `?around=` 窗口读），不存在第二份「拉全量 → 按 timestamp 放宽窗口 →
  scrollIntoView」的实现。取假形态（先提交实现再变异，逐条记录变异 diff、逐字失败行与恢复命令）：(i) 把搜索跳转改回整段拉取再放宽窗口
  ⇒ (a) 的取页读数必须红；(ii) 用 timestamp 而非消息 id 定位 ⇒ (b)
  在「同毫秒两条轮次」的对照上必须红。当前必红：该用例不存在（实测 `grep -c "AC-223"
  e2e/transcript-jump-to-turn.spec.ts` → 0，`-g "AC-223"` 报 No tests found）。
origin: 人 yale 2026-10-04 裁定（对 gap-goal-017-exit-clause-nonregression-ac 的
  Resolution (ii) 欠账②）：另立一条 AC 承载 GOAL-017 范围第 4
  条的「跳转路径复用并取代搜索跳转里『全量拉取再放宽窗口』的做法」。原拟编号 AC-217 未用（已被视觉形态 AC 占用）、AC-219
  亦已被占用，故取下一个空闲编号 AC-223。实证：e2e/transcript-jump-to-turn.spec.ts 里 grep -c
  "AC-223" → 0（用例不存在，本条当前为红，符合红先行惯例）；useChatSessionState.ts:1752 已有共用的
  jumpToMessage 与「不存在第二份 load around/widen/commit/scroll」的注释，但没有任何判据断言搜索跳转确实走了它。
activatedAt: 2026-10-04T07:49:13.209Z
statusLog:
  - at: 2026-10-04T08:57:46.316Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-10-04T14:07:29.659Z
    from: achieved
    to: superseded
    actor: yale-session
    reason: 人 yale 2026-10-04 裁定取消 GOAL-017：滚动条恢复原生，刻度条与自绘滚动条移除、改为用户输入目录抽屉（bd393444）
---
