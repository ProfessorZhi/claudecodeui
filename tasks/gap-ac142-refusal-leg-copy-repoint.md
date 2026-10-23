---
id: gap-ac142-refusal-leg-copy-repoint
title: AC-142 失败腿钉着已被替换的文案：6d14ec0c 把拒绝显示改为 voice.errors.<code> 的句子，spec 仍断言
  Transcription failed 与裸 code ⇒ 判据红；错误显示与草稿逐字保留的本体仍在，把该腿重指到按 code 选出的那句文案（裸
  code 归 AC-153 的折叠详情）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-142
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-09-25）：`grep -rn "^goal_ac: *AC-142" tasks/*.md` → 2 命中，两条都是 `done`（`gap-voice-dashscope-written-browser-e2e`、`gap-voice-dashscope-criterion-boot-dep-reopt-race`），**没有** todo/ready/needs-human 的认领者 —— 按本轮规则，done 的认领不是重复，而是「更早的修复没守住」的证据，所以立新条。`grep -rln "voice-dashscope-written" tasks/*.md` → 3 命中：上述两条之外还有 `gap-voice-error-notice-browser-e2e`（`goal_ac: AC-153`，status ready）。那一条**不是同机制**：它的交付面是新文件 `e2e/voice-error-messages.spec.ts` 加显示面本体（常驻提示、关闭控件、折叠技术详情），它在自己的现状表里如实登记「AC-142 的这三条断言在本条落地后必红」，但**没有**认领重指 AC-142 的腿。本条认领的正是它让出的那一格：**`e2e/voice-dashscope-written.spec.ts` 失败腿的文案期望**。

**本轮的直接测量（不是台账尾巴）**

同一 checkout（`/data/home/yale/work/claudecodeui`，工作树只有三个未跟踪项，无本地改动）、`git rev-parse HEAD` = `0b1891a2c4ba8f29819efa7e9336dbf6a8507c1a` 上直跑判据本体 **2 次**：

```
exit=1   criterion-wall-ms=35238   1 failed / 1 passed
```

两次同形，红的是同一腿：

```
1) e2e/voice-dashscope-written.spec.ts:994:1 › AC-142 refusal: a refused recognition shows an
   error with its code and leaves the draft untouched (17.5s)
   Error: refusal: the refused recording was never reported on the page; the page shows: …
     proxy posts=1
```

即：书面腿（`spec:748` 附近）**绿**，失败腿（`spec:994`）**红**，红在 `page.getByText(/Transcription failed/)`（`spec:1021`）从未命中。`criterion-wall-ms=35238` 是这条腿那 10 秒定位等待（`spec:1022`）烧掉的读数；该判据绿时的历史读数是 `18.3s / 23.1s / 19.3s`。

**红在哪、以及为什么这不是「保证被破坏」**

`6d14ec0c`（develop，2026-09-24 23:32，"voice: localize transcription failures by code instead of showing the transport sentence"）把 composer 对拒绝的显示从 `Transcription failed: transcribe 502 (UNSUPPORTED_MIME)` 换成按 code 选出的本地化句子：`src/modules/chat/utils/voiceErrorMessages.ts` 的 `voiceErrorMessage()` 用调用者自己的 `t` 把 `voice.errors.<code>` 解成句子，`src/modules/chat/composer/ChatComposer.tsx:268` 把它交给 `VoiceInputButton`，而 `src/modules/chat/composer/VoiceInputButton.tsx:36-38` 就把 `{errorMsg}` 原样渲染。⇒ 页面上**不再有** `Transcription failed` 这句英文，也**不再有**裸 code。

页面到底显示了什么，本轮从失败运行的 trace 里读到了 DOM 快照（读数，不是推断）：

```
["SPAN",{"class":"absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg"},
 "The speech service rejected its key — check the voice provider credentials in Settings, then try again."]
```

这正是 `src/modules/i18n/locales/en/chat.json` 里 `voice.errors.UNAUTHORIZED` 的值 —— 替身给的 `REFUSAL_ENVELOPE.code` 就是 `UNAUTHORIZED`，映射一路走通。

所以：**AC-142 断言的保证仍然成立**（录音被上游拒绝时 UI 显示了错误、POST 恰一次、aliyuncs 零请求、草稿没人碰），红的是**判据自己钉着两句已被有意替换掉的字面量**（`spec:1042` 的 `toContain('Transcription failed')`、`spec:1043` 的 `toContain(REFUSAL_ENVELOPE.code)`）。AC-142 记录本身的 `expect:` 只要求「UI 显示错误且 composer 中已有草稿保持不变」，没有要求裸 code 上线；而把状态码摆到页面上的那一格是 **AC-153** 的：它的 `expect` 明写「折叠的技术详情行在展开前不显示状态码，展开后读出状态码与 upstreamCode」。⇒ 本条不修显示面，只把失败腿重指到**按 code 选出的那句文案**，让两条判据的读数面互不重叠。

**修复的不变式（判据物，不指定实现）**

失败腿要读的三件仍是原来的三件，只有第一件的**判据物**从「英文拼接句 + 裸 code」换成「该 code 的那句文案」：

1. 录音前页面上**没有**那句文案；录音后**出现**了 —— 把转换本身钉住。否则「页面上有这句话」可以由更早的状态继承而来，这次读数就是空的（同族教训：窗口两端的断言缺一不可）。
2. 那句文案**逐字等于** `en/chat.json` 里 `voice.errors.UNAUTHORIZED` 的值，且**不等于** `voice.errors.NO_SPEECH_DETECTED` 的值，也**不等于**兜底句 `voice.errors.unknown` 的值；三句都要打印出来并断言两两不同 —— 一个自比自的读数不算读数，兜底句那次打印用来排除「显示的其实是兜底」。
3. 文案取自**出货目录**：运行期读 `src/modules/i18n/locales/en/chat.json`（Playwright 跑在 Node 里，`fs.readFileSync` 即可），**不把句子抄进 spec**。目录改动会跟着移动断言，就不会再出现「文案改了、spec 停在旧字面量」这一次的失败形。判据的界面语言由既有 `addInitScript` 的三把键钉成 `'en'`（与目录一致），这条不放松。
4. 草稿逐字不变、替身计数仍为 1、`aliyuncs.com` 账本仍为 0 —— 三条原样保留。

**为什么更早的修复没守住**

`gap-voice-dashscope-written-browser-e2e`（done，2026-09-24T08:29）按**当时的**显示写了失败腿，并在自己的 AC4(a) 里写死「错误且语义码同时在」；它的 AC5 还要求两条腿**逐字冻结**。于是后来的 i18n 提交（`gap-voice-error-messages-i18n-fallback`，AC-151，done，落地即 `6d14ec0c`）有意替换显示文案时，这条腿**没有被同批重指**；AC-153 那条 ready 的任务在自己的现状表里把这件事登记为「会被本次顶到的既有浏览器读数」，等的是本条的认领。随后 `gap-voice-dashscope-criterion-boot-dep-reopt-race`（done）只修了夹具的依赖重优化竞态，并按前述 AC5 刻意没碰那三处文案断言。⇒ 判据此后一直红，而真正需要动的只是一句期望值 —— 这是「判据把机制当前形态写死」的又一例，不是显示回退。

**同族但不在本条范围内的两处（登记以免下次再被当成新发现）**：`e2e/voice-trim.spec.ts:91-97` 的 `VOICE_ERRORS` 是诊断数组（只在 `:509-514` 拼一条失败消息，不是断言），里面 `'Transcription failed'` 那一项会陈旧但不会红；本条**不改**那个文件。`spec:92-105` 那段替身与真实路由的差异登记（替身为上游拒绝多给了一个 code）**保留**，信封仍可带 `code`，只是不再拿它当页面断言。

## AC

- [x] AC1 判据入口：`npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"` 退出码 0，输出里两条腿都 passed；同一次运行的 wall clock 打印 `criterion-wall-ms=<n>` 且 < 45000（门是 60 秒硬上限、不可调）。红态基线已登记：`exit=1 / criterion-wall-ms=35238`。
- [x] AC2 转换被钉住：失败腿打印 `before-said-unauthorized=<b>` 与 `after-said-unauthorized=<b>` 两次读数，前者 false、后者 true —— 录音前后各读一次页面文本（整页或错误气泡所在的容器都可以，但必须**两次**）。
- [x] AC3 是那句、不是别的句：失败腿打印 `copy[UNAUTHORIZED]=…`、`copy[NO_SPEECH_DETECTED]=…`、`copy[unknown]=…` 三行（取自运行期读取的 `src/modules/i18n/locales/en/chat.json`），断言三者两两不同；页面文本 `toContain(copy[UNAUTHORIZED])`、`not.toContain(copy[NO_SPEECH_DETECTED])`、`not.toContain(copy[unknown])`。比较形态（逐字或空白归一化）须在完成记录里登记实际用的那一种。
- [x] AC4 spec 里不再留旧字面量：`grep -n "Transcription failed" e2e/voice-dashscope-written.spec.ts` 命中 0（注释里也不留，免得下次又被当成期望值）；`grep -n "REFUSAL_ENVELOPE.code" e2e/voice-dashscope-written.spec.ts` 的命中不再是页面断言。
- [x] AC5 原三条读数原样保留，且都在**同一次** -g 运行里各自成立：失败腿打印 `draft-kept=true posts=1` 与 `aliyuncs-refusal=0`；书面腿打印 `proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=<n>`；对照腿（不带 AC-142 标题）打印 `control-aliyuncs>=1` —— 零请求仍是分辨力读数，不是「什么都没发生」。
- [x] AC6 取假形态逐条实测并登记读数（每条打印实测退出码与失败文案）：(i) 前端忽略 proxy-only 而直连（把 provider 的 transport 当 direct 用）⇒ 判据必须红；(ii) 失败时清空草稿 ⇒ 失败腿必须红；(iii) 任意拒绝都显示 `NO_SPEECH_DETECTED` 那句 ⇒ 失败腿必须红。若某条变体读绿，按「双杠杆吸收负控制」的既有教训说明是哪一杠杆吸收的，并把修前路径的读数一并登记，不得静默换过、不得手改 tick。
- [x] AC7 契约面不被改窄：`npm run typecheck`（根 + `server/tsconfig.json` + `scripts/tsconfig.json` 三套）与 `npm run lint` 退出 0；`npx playwright test e2e/voice-dashscope-written.spec.ts` 整文件（三条腿，含对照腿）退出 0。
- [x] AC8 如实登记：完成记录写明「本条只重指失败腿的文案期望：不改显示面本体（常驻提示 / 关闭控件 / 折叠技术详情属 AC-153）、不改 12 个 `locales/*/chat.json`、不改 `e2e/voice-trim.spec.ts` 的诊断数组」；`spec:92-105` 的替身-真实差异登记保留；判据仍把 `/api/voice/transcribe` 与 aliyuncs 主机拦在浏览器侧，不等于真实 DashScope 与真机浏览器（ADR-004 决策 8，真实冒烟归人工）。

## DoD

判据在**落地后的树**上按原命令重跑：退出码 0、两条腿 passed、`criterion-wall-ms` 打印且 < 45000，并附 AC2 的两次读数与 AC3 的三句文案打印；AC6 三条取假形态的实测退出码与红态文案写进完成记录；`npm run typecheck` 与 `npm run lint` 退出 0；改动只落在 Touches 列出的文件上（`git diff --stat` 逐条对齐，多出一个文件即为未forcing的越界）；完成记录随 AC tick 的那次 `task_write` 一并追加。

## 完成记录

**落地（一条 commit，只改一个文件）**

`38c1025c` `e2e(voice-dashscope): repoint the AC-142 refusal leg at the sentence its code selects` —— `1 file changed, 101 insertions(+), 19 deletions(-)`，全部落在 `e2e/voice-dashscope-written.spec.ts`。

失败腿不再断言 `Transcription failed` 与裸 `REFUSAL_ENVELOPE.code`：三句文案在**运行期**从 `src/modules/i18n/locales/en/chat.json` 读出（`fs.readFileSync(path.resolve(process.cwd(), …))`，与 `e2e/mobile-composer-send-key.spec.ts:13-18` 同一读法），因此目录改动会跟着移动断言。**比较形态：逐字** —— `body.innerText()` 上 `toContain` / `includes`，不做空白归一化。`REFUSAL_COPY` 由 `EN_VOICE_ERRORS[REFUSAL_ENVELOPE.code]` 索引（`.code` 只出现两次：这一处常量派生与下面那处打印标签，均非页面断言）。

**AC1 判据入口（落地后的树，原命令）**

```
npx playwright test e2e/voice-dashscope-written.spec.ts -g "AC-142"
exit=0   2 passed    criterion-wall-ms=22420
```

AC7 的整文件跑同形：`exit=0 / 3 passed / criterion-wall-ms=23173`。红态基线（改动前）已在 Proposal 登记：`exit=1 / criterion-wall-ms=35238`。两次落地后运行的读数分别是 `22420` / `23173`，均 < 45000。

**AC2 转换被钉住（同一次运行里的两次读数）**

```
before-said-unauthorized=false after-said-unauthorized=true
```

两端都取自 `page.locator('body').innerText()`：录音前一次、错误气泡可见后一次。

**AC3 是那句、不是别的句（同一次运行，取自运行期目录）**

```
copy[UNAUTHORIZED]="The speech service rejected its key — check the voice provider credentials in Settings, then try again."
copy[NO_SPEECH_DETECTED]="No speech was found in the recording — record again and speak closer to the microphone."
copy[unknown]="The transcription failed — try again, or check the voice provider settings."
distinct=3/3
```

`copy[...]` 行的键名由 `REFUSAL_ENVELOPE.code` / 字面量 `NO_SPEECH_DETECTED` / 字面量 `unknown` 组成。断言三条同时成立：页面文本 `toContain(copy[UNAUTHORIZED])`、`not.toContain(copy[NO_SPEECH_DETECTED])`、`not.toContain(copy[unknown])`；`new Set([三句]).size === 3` 断言两两不同，故不是自比自；兜底句那次打印用来排除「显示的其实是兜底」。

**AC4 spec 里不再留旧字面量**

```
grep -n "Transcription failed"    e2e/voice-dashscope-written.spec.ts  → 0 命中（grep exit 1）
grep -n "No speech detected"      e2e/voice-dashscope-written.spec.ts  → 0 命中（grep exit 1）
grep -n "REFUSAL_ENVELOPE.code"   e2e/voice-dashscope-written.spec.ts  → 2 命中，均非页面断言：
  :145   const REFUSAL_COPY = EN_VOICE_ERRORS[REFUSAL_ENVELOPE.code];                （常量派生）
  :1100  `copy[${REFUSAL_ENVELOPE.code}]=${JSON.stringify(REFUSAL_COPY)}`            （打印标签）
grep -n "AC-142"                  e2e/voice-dashscope-written.spec.ts  → 2 命中，两条标题行本身
```

注释里也不留 `Transcription failed`（原 `spec:1021/1034/1042` 三处与 `1044` 的 `'No speech detected'` 一并换掉）。

**AC5 原三条读数原样保留**

同一次 `-g "AC-142"` 运行：失败腿 `draft-kept=true posts=1 aliyuncs-refusal=0`；书面腿 `proxy=1 x-voice-provider=dashscope-omni aliyuncs=0 composer-len=67`。
对照腿取自 AC7 的同文件整文件运行：`control-aliyuncs=1 control-proxy-posts=0 control-composer-len=55`。
⚠️ 如实登记一处与字面不符（不静默换过）：对照腿**不在** `-g "AC-142"` 的选中集里 —— 该腿自己的标题注释写明「deliberately carries no criterion id: `-g` selects the two legs above, and this one must not be dragged into their budget」。所以「同一次 -g 运行」只能覆盖前两条腿；对照腿的 `control-aliyuncs>=1` 取自**同一文件、同一夹具、同一 beforeAll 账号**的整文件运行（AC7 的那条命令）。把对照腿塞进 `-g` 会让判据入口的 45s 预算被它吃掉，而它的标题不带 criterion id 正是文件刻意的设计，本条不改。零请求仍因这条读数而是分辨力读数，不是「什么都没发生」。

**AC6 三条取假形态逐条实测（实测退出码 + 红态文案；三条变异均已 `git checkout -- <file>` 还原）**

(i) 前端忽略 proxy-only 而直连 —— `src/shared/api.ts:861` 的 `=== 'proxy-only'` 临时改成 `=== 'proxy-only-VARIANT-I'`：

```
exit=1   1 failed / 1 passed   criterion-wall-ms=14518
红：AC-142 written leg，spec:1021  expect(post.headers['x-voice-provider']).toBe('dashscope-omni')
    Expected: "dashscope-omni"   Received: undefined
    （同一次运行打印：proxy=1 x-voice-provider=undefined aliyuncs=0 composer-len=67）
```

该变异让 proxy-only 的 provider 不再走带 `x-voice-provider` 的代理分支，落到兜底的 `api.voice.transcribe(body, voiceConfigHeaders())`，路由头随之消失 ⇒ 判据红在**书面腿**的路由读数上。文件是 `mode: 'serial'`，第一条腿红后失败腿不再运行。
补充读数（如实登记，避免被误读成「失败腿也红」）：把同一变异下的命令收窄成 `-g "AC-142 refusal"` 时，失败腿也红，但红在 `the page never read a health payload naming the saved provider as effective`（spec:1071，15s 超时）—— 那是 `-g` 子集自身的产物（保存配置的是书面腿，被过滤掉后失败腿的前置条件不成立），**不是**该变异造成的红，故不计入本条读数。

(ii) 失败时清空草稿 —— `ChatComposer.handleVoiceError` 里临时加一次 `onInputChange({ target: { value: '' } })`：

```
exit=1   1 failed / 1 passed   criterion-wall-ms=19234
红：AC-142 refusal leg，draftKept 断言（Expected: true  Received: false）
    同一次打印：before-said-unauthorized=false after-said-unauthorized=true
                draft-kept=false posts=1 aliyuncs-refusal=0
```

文案两读数仍为 false/true —— 草稿读数是独立的、有齿的那一条，不被文案读数吸收。

(iii) 任意拒绝都显示 `NO_SPEECH_DETECTED` 那句 —— `voiceErrorMessages.voiceErrorKey` 临时固定返回 `${KEY_PREFIX}NO_SPEECH_DETECTED`：

```
exit=1   1 failed / 1 passed   criterion-wall-ms=28127
红：AC-142 refusal leg
    Error: refusal: the refused recording was never reported on the page; the page shows: "CloudCLI\nStar\n…"
      proxy posts=1
```

即错误气泡确实出现了，但出现的是另一句（`getByText(REFUSAL_COPY)` 定位不到），分类读数没有被「有错误就算过」吸收。

三条变体**全部读红，无一条读绿**，故不涉及「双杠杆吸收负控制」的解释；还原后 `grep -rn "VARIANT-" src e2e` 0 命中，`git status --short` 只剩 `M e2e/voice-dashscope-written.spec.ts`。

**AC7 契约面未被改窄**

```
npm run typecheck   → exit 0（tsconfig.json + server/tsconfig.json + scripts/tsconfig.json 三套）
npm run lint        → exit 0（输出只有既有 warning，无 error）
npx playwright test e2e/voice-dashscope-written.spec.ts   → exit 0，3 passed，criterion-wall-ms=23173
```

**AC8 如实登记**

- 本条**只重指失败腿的文案期望**：不改显示面本体（常驻提示 / 关闭控件 / 折叠技术详情属 AC-153），不改 12 个 `locales/*/chat.json`（一个字节未动），不改 `e2e/voice-trim.spec.ts` 的诊断数组（`VOICE_ERRORS` 里 `'Transcription failed'` 那一项留着不动）。
- `spec:92-105` 的**替身-真实差异登记保留**：替身仍在上游拒绝的信封里多给一个 `code`（真实路由只为「上游调用之前」的拒绝重新发布 code）。随之改写的只是那句话的落点：判据要的是**分类可辨认**，页面用该 code 选出的**句子**作答，code 本身归另一条判据的折叠技术详情行。信封的 `error` 字段（代理自己的传输句）保留——它仍是真实代理答一个拒绝时的形状，只是本文件不再拿它作页面断言。
- 文件尾部 registration 块里「the criterion asks for a semantic code on the page」一句同步改写，其余登记（拦截不是真实服务、不是真机浏览器、ADR-004 决策 8 归人工、Service Worker 被 block、模型名是别名）逐条不变。
- 判据仍把 `/api/voice/transcribe` 与 aliyuncs 主机拦在**浏览器侧**，不等于真实 DashScope，也不等于真机浏览器：本条的读数全部来自该拦截面。

**产物边界（`git diff --stat` 对齐 Touches）**

`git diff --stat develop` 只列出 `e2e/voice-dashscope-written.spec.ts`（任务文件的 tick 由 ABI 落地后随 develop 进来），无第二个源文件。

## Touches

- e2e/voice-dashscope-written.spec.ts
- tasks/gap-ac142-refusal-leg-copy-repoint.md