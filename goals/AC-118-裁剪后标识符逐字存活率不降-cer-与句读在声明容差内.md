---
id: AC-118
title: 裁剪后标识符逐字存活率不降，CER 与句读在声明容差内
status: achieved
kind: criterion
goal: GOAL-006
criterion: node experiments/voice-trim/run-quality.mjs
expect: 在入库 fixture 转写对（真实识别器产出，与音频 fixture 一起提交，判据本身不联网）上配对比较 baseline 与
  trimmed，断言：(1) 标识符逐字存活率 trimmed ≥ baseline（硬，允许相等）；(2) ΔCER ≤ +1.5%；(3) 句读标记数
  ≥ 0.9 × baseline；(4) 同一 runner 打印 savedRatio 且断言 savedRatio > 0 ——
  「省了时长」与「质量不降」必须同时成立，否则恒等实现能靠质量那一半拿分。参考实测（全表 cap，zh o65+o45 16 clips）：标识符
  16.7%→16.7%（中性）、CER 0.1389→0.1499（+1.101%，最差 +9.68%，6/16 变差）、句读 2.06→1.00；en
  32 clips：标识符 77.8%→77.8%、ΔCER +0.140%。阈值按此设定，句读的 0.9 折价就是全表 cap 的已知代价（人 yale
  2026-09-21 接受）。取假形态：恒等实现使 (4) 红；把 cap 表换成会吃掉语音的激进参数使 (1) 红；改用 CER 作为标识符口径则 (1)
  恒绿 —— 本条必须能抓住「指标全绿但 agent
  改错文件」这一类失效，故判据只能取逐字口径。当前必红：experiments/voice-trim/run-quality.mjs 不存在。
origin: 2026-09-21 实测：cap 阶段 CER 是升的而标识符中性，所以本条不能写成「CER 不升」，否则一开始就是红的；容差与句读下限即由此而来。
activatedAt: 2026-09-21T15:17:59.983Z
statusLog:
  - at: 2026-09-21T15:59:32.989Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
---
