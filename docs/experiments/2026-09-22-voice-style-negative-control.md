# 风格化的双向负对照：标识符逐字保留 ×「确实发生了」

状态：已测 / 安全半为正面读数（4/4 逐字保留），「确实发生了」半为**否定**（2/4 声明与实际改写不一致）
日期：2026-09-22
工装：`experiments/voice-style-negative-control/run.mjs`（**在仓库内**，见「六、复现」的理由）
相关：`adr/ADR-004-语音识别-provider-缝-环境中立的适配器契约与能力声明.md`（决策 5 / 决策 8 / 裁定 2，后续任务 8）、`docs/proposals/voice-asr-provider-seam.md`（「输出信封与风格化（D3）」一节）

---

## 一、起因

ADR-004 决策 5 把输出信封从 `{text}` 扩为 `{text, style, transformations}`，因为 provider 优先返回**书面化**文本。这带来一个本仓库必须直面的后果：**现有判据会失明或失义** —— 出货的 `src/shared/identifierFidelity.ts` 量的是**逐字存活**（大小写与点号敏感），而一份书面化文本本来就不逐字等于口语原话。

按人 yale 2026-09-22 的裁定 2，决策 5 的语义等价轴被拆成两半：**质量半人读**（进实验记录），**安全半机检**。本记录做的就是安全半，以及它的两个方向。

要量的是两件事，且两件都必须**能红**：

| 半 | 读数 | 点名的失效形态 |
|---|---|---|
| `happened` | `transformations` 非空，且声明与实际改写**一致** | 惰性实现：风格化根本没发生，却全绿 ⇒ 「没有测量任何东西」 |
| `verbatim` | 句子里每个标识符逐字出现在风格化后的文本里 | 决策 5 点名的形态：`voice.service.ts` 被顺手写成 `voice service ts` |

**本次要回答的问题**：在真实 `style: written` 服务下，安全半（标识符逐字保留）读数是什么？以及，这条负对照真的能红吗（还是只是一个恒绿的装饰）？

## 二、方法

**语料（S0）**：4 条固定句子（n=4，标识符 12 个），每条都含文件路径与代码片段，中英混排。语料固定写在 runner 里，改语料等于改记录。

| id | 句子 |
|---|---|
| `zh-file-and-hook` | 把 voice.service.ts 里的 timeout 从三十秒改成六十秒，然后看一下 useVoiceInput 这个 hook，再更新 voice.routes.ts。 |
| `en-file-and-hook` | Change the timeout in voice.service.ts to sixty seconds, then look at the useVoiceInput hook and update voice.routes.ts. |
| `zh-code-fragment` | 在 server/modules/voice/voice.service.ts 里，const timeout = 30000 太短了，改成 60000，另外 --voice-trim 这个开关保持默认。 |
| `zh-path-and-symbol` | GET /api/voice/health 现在只看服务端环境变量，客户端的 MIME_CANDIDATES 与 encodeWavBlob 也应该反映出来。 |

语料前提由 runner **机检**：每条句子必须被出货模块认出 ≥1 个标识符，否则「逐字保留」那一半会**空过**（`total=0` ⇒ `rate=null`，一个把整句删空的实现在没有标识符的句子上会读成绿）。

**口径（README 协议第 3、6 条）**：标识符存活**只**用出货模块 `src/shared/identifierFidelity.ts`（逐字敏感口径），runner 直接 `import` 它，工装里**没有第二份算法**。

**检查器（安全半）**：

```
rewritten   = 返回文本与原句不同（trim 后逐字比较）
consistent  = (transformations 非空) === rewritten
              —— 声明了就必须真的改了（否则是谎报）；没声明就不许改
              （否则是**未声明**的改写，而下游正是按 transformations 选轴）
happened    = text 是字符串 && style === 'written' && 词表合法
              && transformations 非空 && rewritten && consistent
verbatim    = total > 0 && rate === 1        （total>0 是显式要求，见上）
```

**四条控制**（每条句子各跑一遍，配对）：

| 控制 | 性质 | 实现 | 预测 |
|---|---|---|---|
| `good` | 正面 | 手写的合格风格化文本（离线） | 两半都**绿** |
| `lazy` | 负 | 原样返回 + `transformations: []` | `happened` 红 |
| `mangle` | 负 | 按出货模块认出的标识符逐个改写（`voice.service.ts` → `voice service ts`） | `verbatim` 红 |
| `lie` | 负 | 原样返回 + `transformations: ["written-style","punctuate"]` | `happened` 红（走**一致性**那一支） |

`good` 是**必须有**的一条：一个恒绿的判据没有测量任何东西，但一个**恒红**的判据同样没有 —— 没有正面控制，一个"永远返回红"的检查器能通过全部负对照。

`lie` 是本轮加的第三条负对照，理由是：`consistent` 这一支若无任何控制去打，就是一条不会被执行的死代码。事后看它是本轮最有价值的一条（见「三、结果」）。

**真实服务**：Groq 的 OpenAI 兼容端点 `/chat/completions`，模型 `openai/gpt-oss-120b`，`temperature: 0`，`response_format: json_object`。系统提示词要求它书面化、**逐字保留**标识符与文件路径、并按信封形状返回 JSON。凭据从仓库外的工装 `.env`（mode 600）读，永不打印。**串行**执行，一条一条发（README 协议第 7 条）。

这条读数按 ADR-004 决策 8 **不进判据集**：它联网、需凭据、依赖具体服务。它是**读数**，不是闸。

**缓存**：`experiments/voice-style-negative-control/out/style-cache.json`（`out/` 已被 `.gitignore` 忽略，不入库），按 `模型|句子 id` 存原始信封。分析可 `--replay` 从缓存重算，不重花请求。

## 三、结果

### 3.1 离线控制（机检，无网络）

```
offline controls n=4 identifiers=12 :: lazy(happened)=red 4/4 mangle(verbatim)=red 4/4 lie(happened)=red 4/4 good(both)=green 4/4
```

三条负对照各自在 4/4 句子上按预测方向动了，正面控制在 4/4 上两半全绿。**这两个方向都成立**，是 AC1/AC2 的读数。

### 3.2 反假探针：这两半真的能红吗

上面那张表是"当前实现下控制动了"，还不等于"控制**能**动"。所以另做了 5 个反假变体：每个只破坏 runner 的**一处**，断言 runner 自己的控制断言随后**必须失败**（退出码非 0 且原因命中）。任一探针保持绿 ⇒ 对应的控制什么也没测。

| 探针 | 破坏点 | 结果 | 失败原因（首行） |
|---|---|---|---|
| P1 | `happened` 恒真 | **红（符合要求）** | `CONTROL FAILED: lazy/zh-file-and-hook: predicted happened=red, got green` |
| P2 | `verbatim` 恒真 | **红（符合要求）** | `CONTROL FAILED: mangle/zh-file-and-hook: predicted verbatim=red, got green` |
| P3 | `happened` 恒假 | **红（符合要求）** | `CONTROL FAILED: good/zh-file-and-hook: positive control expected happened=green, got red` |
| P4 | `mangle` 一个标识符也不改 | **红（符合要求）** | `CONTROL FAILED: mangle/…: the fake did not rewrite the sentence at all — the control would pass vacuously` |
| P5 | 语料换成一条无标识符的句子 | **红（符合要求）** | `FAIL: corpus precondition failed: plain carry no identifier, so the verbatim half would pass vacuously` |

P1/P2 是「两半可红」的直接证据；P3 证明**恒红**的检查器会被正面控制抓住；P4/P5 证明两条**空过**路径（假实现没动手、判据没东西可看）各自有闸。

### 3.3 真实服务读数（联网 + 凭据）

```
live service=openai/gpt-oss-120b n=4/4 happened=2/4 verbatim=4/4 identifiers=12/12
```

| 句子 | `happened` | `verbatim` | declarations | rewritten | consistent | 标识符 |
|---|---|---|---|---|---|---|
| `zh-file-and-hook` | **red** | GREEN | 2 | false | false | 3/3 |
| `en-file-and-hook` | **red** | GREEN | 3 | false | false | 3/3 |
| `zh-code-fragment` | GREEN | GREEN | 3 | true | true | 3/3 |
| `zh-path-and-symbol` | GREEN | GREEN | 2 | true | true | 3/3 |

**安全半是正面读数**：12/12 标识符逐字保留，`missing=[]`，四条全绿。决策 5 点名的失效形态（`voice.service.ts` → `voice service ts`）**没有发生**。

**「确实发生了」半是否定的，且否定的原因值得单列**：两条句子**逐字原样返回**，而信封却声明了 `transformations: ["punctuate","written-style"]`（另一条还多一个 `de-disfluency`）。也就是说，真实服务在 2/4 上重演了 `lie` 假实现的行为 —— **声明了它没有做的改写**。例：

```
[en-file-and-hook]
  in : Change the timeout in voice.service.ts to sixty seconds, then look at the useVoiceInput hook and update voice.routes.ts.
  out: Change the timeout in voice.service.ts to sixty seconds, then look at the useVoiceInput hook and update voice.routes.ts.
  transformations=["punctuate","de-disfluency","written-style"]
```

这条读数**与安全半无关**：它不说明标识符有风险，而说明 `transformations` 这个字段在真实服务上**不可信**。而决策 5 给这个字段列了三个机器用途（UI 的"被改写了吗"、指标选轴、以及"还要不要跑客户端 `repairIdentifiers`"的判据），三者都要求它**如实**。真实读数说：它不。

两条真的发生改写的句子，改写本身是合格的（`zh-code-fragment` 把 `太短了，改成` 改成 `太短了，改为`、分号与逗号调整；`zh-path-and-symbol` 把空格改成冒号），且标识符一个没动。

## 四、结论

1. **安全半可以做成机检，而且它现在是绿的。** 决策 5 的负对照（含文件路径与代码片段的句子逐字保留）在真实服务上 4/4 绿、12/12 标识符存活。这是本轮唯一的**正面**结论，也是裁定 2 要求的那一半。
2. **两个方向都能红，且这不是自证 —— 有 5 个反假变体作证。** P1/P2 证明两半各自可红，P3 证明恒红会被正面控制抓住。一个"恒绿的装饰"与一个"恒红的装饰"都过不了这套。
3. **`transformations` 的一致性不是假想问题。** 本轮为此加的 `lie` 假实现（声明改写、原样返回）在真实服务上被原样重演：2/4。这条应当被登记进 D3 的实现约束，而不是只留在记录里。
4. **标识符存活与"确实发生了"是两条独立的轴，不可互推。** `mangle` 在 `happened=GREEN` 的同时 `verbatim=red`；真实服务在 `verbatim=GREEN` 的同时 `happened=red`。本轮四条控制里，没有任何一条能只靠一轴被识别出来。

## 五、未解释 / 未验证

**1. `transformations` 的漂移是提示词缺陷还是服务属性？机制未确定。**
本轮的系统提示词只列出**允许的取值**，没有写"若你一个字符都没改，就必须返回空数组"。模型于是填了"这次风格化**意味着**做哪些事"，而不是"我**做了**哪些事"。这是提示词的一处明显缺口，但**本轮没有做对照**：没有跑"加上空数组子句"的第二条臂。因此现在的读数只能界定成**当前这条提示词下**的漂移率，不能读成"该服务不可信"。
代价说明：这条只能靠再跑一次 `--live` 得到（联网、4 次请求），本记录不把它当作结论。

**2. 安全半只看得见"标识符形状"的东西。**
出货口径的 6 条模式只认文件带点路径、camelCase、PascalCase、snake_case、`--flag`、绝对路径。本轮语料里**它没看见**的有：

- `const timeout = 30000`（整段代码片段，含字面量 `30000` / `60000`）：字面量一旦被风格化改写（`thirty seconds` / `60`），这一轴**失明**；
- `MIME_CANDIDATES`：全大写加下划线，出货模式不认（snake_case 那条要求小写开头），所以它没有进入本轮的 12 个标识符；
- 反向的一条：`GET` 被计成了一个标识符（PascalCase 那条能吃下全大写短词），使总数略微偏大。

**方向性**：这三个偏差里前两个让安全半**偏松**、第三个让它**偏严**，不会把它推向"恒绿"。但这半边**不能说成"代码片段逐字保留"**，只能说成"标识符形状的跨度逐字保留"。要覆盖字面量与全大写常量，需要新口径，本轮没做。

**3. 语料是 4 条、单次运行、单一服务、单一模型。**
n=4，配对表里每格只有 4 个读数。它界定的是**效应方向与机制是否存在**，不是真实语料上的比例。`temperature: 0` 也不保证跨运行逐字一致，所以本记录的数字**不跨运行比较**（README 协议第 1 条）。

**4. 真实服务不是 ADR-004 所指的那个 provider。**
ADR-004 的 `style: written` 是 **provider 属性**（一个识别服务自己返回书面化文本；后续任务 5 的多模态适配器才是它）。本轮用的是一个**聊天模型**在同一个信封契约下做**风格化那一半**，输入是**文本**不是音频 —— 本记录的语料本来就是文本（S0 是"固定下来的句子"）。因此本读数界定的是"信封契约 + 标识符安全半"这条链，**不是**"某个 ASR provider 的 style 能力"。同时要说清一处不可回避的性质：**提示词里写明了"逐字保留标识符"**，所以绿的这一半读的是"该服务在被如此要求时守约"，不是"它自发地不会吃掉标识符"。

**5. 未做的事（边界）。** 不改任何出货代码；不把质量读数做成 CI 判据（决策 8）；不做裁剪 × 能力接线（后续任务 9）；不做配对质量实验记录（后续任务 10）；不做"改动提示词后再测一次"。

## 六、复现

工装**在仓库内**这件事与 `docs/experiments/README.md`「工装在仓库外」的惯例不同，理由有两条，都记在这里以免被当成漂移：一是本任务的 `## Touches` 指定了该路径；二是 README 协议第 3 条要求被测实现必须是**出货模块**，而仓库外的工装无法 `import src/shared/identifierFidelity.ts`（该决定针对的是**音频语料不入库**，本任务没有音频语料，缓存也落在被 git 忽略的 `out/`）。

```bash
# 离线负对照 + 正面控制（无网络，确定性）
node experiments/voice-style-negative-control/run.mjs

# 真实服务读数（联网 + 凭据，串行 4 次请求，写缓存）
node experiments/voice-style-negative-control/run.mjs --live

# 只读缓存重算（无网络，不重花请求）
node experiments/voice-style-negative-control/run.mjs --replay
```

凭据解析顺序：`VOICE_STYLE_API_KEY` / `VOICE_STYLE_BASE_URL` / `VOICE_STYLE_MODEL` 环境变量，其次 `VOICE_STYLE_ENV_FILE`（或 `--env-file <path>`）指向的文件，默认落到 `/data/home/yale/work/tc-verify/.env` 的 `GROQ_*`。**凭据永不打印。**

反假变体（本轮 3.2 那张表）：每个变体是本文件的**一份拷件**只改一处，跑起来断言控制**必须失败**；探针脚本属一次性工装，不随本记录入库（它测的是记录里的 runner 自身，不是出货行为）。
