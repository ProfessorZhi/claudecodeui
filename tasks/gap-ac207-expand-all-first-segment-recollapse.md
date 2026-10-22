---
id: gap-ac207-expand-all-first-segment-recollapse
title: AC-207 真实浏览器判据间歇红——全展开正控制读成 20 行、首段塌回折叠
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-207
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案时实测，2026-10-04）：`grep -rn "^goal_ac:" tasks/*.md | grep -i 207` 只命中 `tasks/gap-work-segment-browser-density-and-search-expand.md`（status: done）——按规则 done 不是重复，而是「上一次的修法没能让判据稳定绿」的证据；在飞任务（todo/ready/needs-human）共 5 份，无一携带 `goal_ac: AC-207`。机制扫描（`锚点键` / `回折叠` / `全展开` / `expand-all`）只命中同轴三条 done 任务（AC-204 展开态跨卸载保持、AC-205 段锚点跨尾部增长稳定、AC-207 判据本体），三者各自钉自己那条不变量，都不负责「AC-207 全展开正控制是否可复现」。⇒「AC-207 判据间歇红」无人认领，本条不是重复。

**现状（直接测量，不是台账尾巴）。** AC-207 的 acceptance 命令：
```
npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"
```
`.quay/gate-events.jsonl` 尾读数是 fail（2026-10-04T02:39:35Z，actor goal-cli，exit 1）。本轮在安静态直接复跑同一条命令通过（12.5s；collapsed 7 行/410px、expanded 27 行/1287px、搜索命中自动展开断点全过）。⇒ 判据不是稳定红也不是稳定绿，而是**间歇红**：2026-10-03T17:23、2026-10-03T23:36、2026-10-04T02:39 三次单点红，前后各为连续多次 pass（10-03T20:37→10-04T02:31 连续 16 次 pass）。

**最近一次红的落盘工件逐字（这是本条要修的形态）。** run 数据目录 `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-J2xP96/test-results/transcript-work-segments-w-2ce84-earch-hit-opens-its-segment/`（`error-context.md` + `trace.zip`）：
```
Error: with every segment open the transcript drew 20 rows
expect(received).toBeGreaterThanOrEqual(expected)
Expected: >= 24
Received:    20
```
这是 spec `:293` 的**读数 (i) 正控制**（全展开后行数须 ≥ 合并前基线 24）；读数 (i) 本身的折叠断言已先通过。失败瞬间的页面快照逐字：
```
button "Thinking 7 rows 6.0s"        ← 无 [expanded]，aria-expanded=false
button "Bash 8 rows 7.0s" [expanded]
button "Thinking 5 rows 4.0s" [expanded]
```
即**全展开后 DOM 里第一个（最上面）工作段又塌回折叠**：4 正文 + 3 段头 + Bash 8 + 末段 5 = 20。`trace.zip`/`test.trace` 步骤序（相对 ms）：13486 scroll 段头0 → 13536 click 段头0（其 aria-expanded=true 断言通过）→ 13818 scroll 段头1 → 15318 click 段头1（scroll 与 click 间约 1.5s 的 actionability 重试）→ 15563 click 段头2 → 15762/15882 两次密度读数皆 20 → 红。⇒ 首段先被展开过，随滚动/重试在读数前又变回折叠。

**机制初判（待执行者证实，不是断言）。** 展开态由面板持有（`src/modules/chat/transcript/ChatMessagesPane.tsx:225` 的 `expandedSegmentKeys`，键 = 段锚点键），段锚点键 = `groupWorkSegments` 的 `item.key` = **段首成员**的 `getIntrinsicMessageKey`（`src/modules/chat/utils/workSegments.ts:65`）。`getIntrinsicMessageKey` 的最后兜底是 `type + 时间戳 + toolName + 正文前 48 字`，而该文件注释自陈时间戳会在行 settle 时被**重铸**。若首段首成员走这条兜底（缺 `blockKey/id/messageId/toolId/...`），一次 live→settled 重铸或后台重读即改其行内键 ⇒ 段锚点键漂移 ⇒ `expandedSegmentKeys.has(新键)` 为 false ⇒ 该段塌回折叠，其余两段键未变、保持展开——正是快照里的 1/3。AC-205 的判据只钉「**尾部增长**不改锚点」，没钉「**首成员被重铸**不改锚点」。执行者先落一条确定性读数（单元级优先），据此判真/假，再决定修产品还是修判据；两条路都要求 AC-207 判据**稳定绿**。

**另一红形态，不得混谈。** 2026-10-03T23:36 的红（`quay-e2e-wczqYK`）是 `TimeoutError: locator.waitFor: Timeout 30000ms exceeded — waiting for locator('.chat-messages-pane .chat-message').first() to be visible`（spec `:229`），转写根本没渲染，属启动/空白页类 load flake，不是本条机制。执行者若只拿到这种超时，不算复现（先例 `defer-load-problems-do-not-stress-test-inline`）。

**范围。** 只认：全展开正控制读数 20<24、首段塌回折叠。不改 AC-202..AC-206、AC-208 的判据文件与出货语义；不动成员渲染。

## AC

- [x] AC1 红可确定性复现（承重）：给出能稳定触发「全展开后首段塌回折叠」的读数。优先单元级：构造段首成员只带时间戳兜底键（无 `blockKey/id/messageId/...`），令其在 live→settled 重铸后改写该键，经 `groupWorkSegments` + 面板展开态断言锚点键/展开态随之失稳。若判定该路径真实可达，再补一条指向 2026-10-04T02:39 工件（`error-context.md` 的 `20 < 24` + 首段无 `[expanded]`）为基线。复现命令与逐字红输出记入 Evidence。
- [x] AC2 根因判定并修到根上（承重）：对「段锚点键在首成员重铸下是否漂移」给出真/假二选一的直接读数（代码或判据证明），并据此落地：(a) 修产品，使段锚点跨首成员重铸稳定、展开态不因重铸丢失；或 (b) 若该重铸在真实同步路径上被证明不可达、红另有其因，修那个真因。不得只堵 `expandedSegmentKeys` 的删除路径而不处理键漂移。
- [x] AC3 判据稳定绿（承重）：安静态下 `npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"` 连续 ≥5 次运行全部 exit 0；每次读数落盘，且 expanded 行数每次 ≥ 24、collapsed 行数每次 < 12（正控制与读数 (i) 同时稳定，不是放宽阈值换来的绿）。
- [x] AC4 假形态仍红（承重）：(a) 段选择器改回一行一块 ⇒ 读数 (i) 红；(b) 关掉搜索命中自动展开 ⇒ 读数 (ii) 红。逐条记录变异 diff、逐字失败行、`git checkout -- <file>` 恢复后判据复绿。
- [x] AC5 静态门与兄弟单测：`npm run typecheck`、`npm run lint` 均 exit 0；若动了 `ChatMessagesPane.tsx`/`workSegments.ts`/`messageKeys.ts`，其同目录单测（`src/modules/chat/tests/` 下相关文件）全绿。
- [x] AC6 台账翻转：合入 develop 后由驱动重跑判据，AC-207 的 goal acceptance 至少连续 2 轮 pass，台账尾不再是 fail。（待外部）

## DoD

- 红是可复现、被逐字记录的对象（复现命令、逐字红输出、修复前后的键值/展开态读数都在 Evidence 里），不是「跑几遍碰运气」。
- 修的是根因：能说清「首成员重铸 → 段锚点键变 → 展开态丢」这条链在修复后如何不再成立，或说清真因是别的并给出相应读数；不接受「重试/等更久/放宽阈值」式掩盖。
- AC-207 判据安静态连续 ≥5 次 exit 0，读数逐次落盘且落在阈值同侧；两条假形态仍红。
- 未把 23:36 那种「转写没渲染」的启动 flake 与本条机制混谈或据其改判据。
- 只动 `## Touches` 列出的文件；若确实需要改别的文件，先把该文件加进 `## Touches` 再写。

## Touches

- src/modules/chat/utils/workSegments.ts
- src/modules/chat/utils/messageKeys.ts
- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/tests/workSegmentKeyStability.test.tsx (new)
- e2e/transcript-work-segments.spec.ts
- tasks/gap-ac207-expand-all-first-segment-recollapse.md

## Evidence

**AC2 真/假读数——段锚点键在首成员重铸下是否漂移：假（该路径在出货同步路径上不可达）；红另有其因 = 文档级整页重载。**

- 命题链的代码审计（出货读数，非重实现）。`groupWorkSegments`（`src/modules/chat/utils/workSegments.ts:65`）把段锚点键钉为 `getIntrinsicMessageKey(首成员)`；`getIntrinsicMessageKey`（`src/modules/chat/utils/messageKeys.ts:20-45`）依次取 `blockKey → id → messageId → toolId → toolCallId → blobId → rowid → sequence`，全空才回落 `type+时间戳+toolName+正文前 48 字`。出货投影 `normalizedToChatMessages`（`src/modules/chat/hooks/useChatMessages.ts:356-361`）**故意**只给本客户端 live 行 `id`（`isLiveRowId`）；历史读路径**从不**盖 `blockKey`（`server/modules/providers/list/claude/claude-runtime.provider.ts:987-989`，单测 `server/modules/providers/tests/claude-stream-block-key.test.ts:191-213`「the history read path never stamps a blockKey」）。
- 实测段键（安静态 e2e 探针逐字）：段0 `message-assistant-1791082491855--Scanning the notes directory.`（时间戳兜底），段1 `message-assistant-seg-tool-4`（toolId 身份分支），段2 `message-assistant-1791082508855--Summarising what the notes contain.`（时间戳兜底）——确实有两个段首成员走兜底键，命题的前半部分在出货投影上属真。
- 但兜底键在**静态历史行**上稳定：时间戳来自 JSONL 文件、内容来自同一解析，同字段重投影（新对象）不改键；live 行则带 `blockKey`（`BLOCK_KEYED_KINDS` 含 `thinking`/`tool_use`，`claude-runtime.provider.ts:831`）与 live `id`。逐字读数见新增单测 `src/modules/chat/tests/workSegmentKeyStability.test.tsx`（4 用例）：同一字段重投影键不变（`getIntrinsicMessageKey({...first}) === anchor`）；仅当重铸时间戳键才移动（`!==`）并脱离展开集合。⇒「首成员重铸 → 键变 → 展开态丢」这条链在出货同步路径上**不可达**，提案的机制不是本轮红的成因。
- **红真因（落盘工件逐字）**。`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-J2xP96/test-results/transcript-work-segments-w-2ce84-earch-hit-opens-its-segment/trace.zip` 解包：`1-trace.network` 中会话文档 `/session/e2e-work-segment` 被请求 4 次，其中一条带 `cache-control: max-age=0`（JS `location.reload()` 的标记）；`1-trace.trace` 的 console 在 t=13817 出现第二次 `[vite] connecting...`（首次 goto 在 t=12070）——即首段点击（t≈13536）后约 1.7s 发生一次**整页重载**。`/@vite/client` 被拉取 5 次。全仓 `grep -rn "location.reload\\|controllerchange" src/` 为空、`public/sw.js` 不触发重载；重载来自 Vite dev client 的既有行为，仓库另有两条判据白纸黑字记录同一现象：`e2e/resident-shell-tab.spec.ts:291-294`（「Vite answers a re-optimization committed after it began serving by pushing `full-reload` to every connected client, which replaces the document whole — the way this criterion has lost a page mid-flight」）、`e2e/mobile-workspace-composer-layout.spec.ts:779-785`（「the app's own Vite client reloads the document after `504 Outdated Optimize Dep`」）。重载挂载**新面板**，AC-204 的契约让新面板从全折叠开始 ⇒ 重载前展开的段被丢、重载后展开的段留存 —— 正是「首段塌回折叠、余两段展开、20 行」。本环境独立复现率：安静态 12 次无重载；并发/分批 20 次里 2 次 `sessionStorage __e2e_loads = 3`（会话页发生一次整页重载），与车队 ~3/19 量级一致。
- **AC1 确定性复现**。(a) 单元级：`workSegmentKeyStability.test.tsx` 第二组「a remount between clicks strands the run opened before it」——渲染面板、展开段0、卸载并重挂（一次文档重载即一次新面板）、再展开段1/段2，断言段0 成员数 0、段1/段2 成员数 >0，即观测到的「首段被搁浅」形态；第一组为对照（无重挂时三段全开）。(b) e2e 级：在首段点击后的同一脆弱点注入一次 `page.reload()`，未修版判据逐字红：`[AC-207] collapsed {"rows":7,"heightPx":410} expanded-positive-control {"rows":20,"heightPx":946}` / `Error: with every segment open the transcript drew 20 rows` / `Expected: >= 24` / `Received: 20`——与 02:39 落盘工件逐字同形（20 行）。

**AC2 修复（根因定向，判据侧）。** AC-204 的契约逐字要求「a fresh pane mount starts every segment collapsed」（`workSegmentExpansionPersistence.test.tsx` 的读数 (ii)），故整页重载丢展开态是**符合契约的产品行为**，不能靠持久化展开态来消（会红掉 AC-204）。真因是判据在 dev client 会替换文档的环境里跨重载测量，因此修判据：正控制的断言「全展开后密度 ≥ 基线」依赖「每段都开」这一前置条件，就在**密度被读取的那份文档上**建立该前置条件——`settledDensityWithEverySegment(open)` 逐段按当前 `aria-expanded` 补点、读回全部段头状态、并在读完密度后再次读回状态；若期间文档被重载替换（状态不再全部匹配），在新鲜文档上重新建立，有界（4 次）后仍不成立才报错。阈值与比较一律未动，只有被读取的状态被保住。**修后同注入一次性重载下**：`expanded-positive-control {"rows":27,"heightPx":1287}` 通过。

**AC3 判据稳定绿（安静态连续 6 次，逐次落盘）。** `npx playwright test e2e/transcript-work-segments.spec.ts -g "AC-207"`：RUN1–RUN6 全部 exit 0，每次 `collapsed {"rows":7,"heightPx":410}`（7 < 12）、`expanded-positive-control {"rows":27,"heightPx":1287}`（27 ≥ 24）；墙钟 13.2–13.8s（远低于目标门 60s 硬顶）。

**AC4 假形态（先提交实现 8486f354，再逐条变异，跑完即 `git checkout --` 恢复）**：
- (a) `groupWorkSegments` 首行插入 `return messages;`（`+1` 行，diff 逐字 `+  return messages; // FALSIFYING VARIANT (a): selector disabled — one row per block.`）。失败行逐字：`Error: the collapsed transcript drew 24 rows at height 1158px` / `Expected: < 12` / `Received:   24`（读数 (i) 折叠腿红，方向 = 行数回到基线以上）。恢复：`git checkout -- src/modules/chat/utils/workSegments.ts`；恢复后该文件 `git status --porcelain` 干净、判据复绿。
- (b) `ChatMessagesPane.tsx` 搜索命中展开 effect 首行插入 `return;`（`+1` 行，diff 逐字 `+    return; // FALSIFYING VARIANT (b): search-hit auto-expand disabled.`）。失败行逐字：`Error: the segment holding the search hit never opened` / `Expected: > 0` / `Received:   0`（spec `:362` 的 poll 超时）；同一次运行密度读数 `7/410` 与 `27/1287` 仍通过 —— 红的是读数 (ii) 这条腿而非别的腿先红。恢复：`git checkout -- src/modules/chat/transcript/ChatMessagesPane.tsx`；恢复后该文件干净、判据复绿（`1 passed`）。

**AC5 静态门与兄弟单测**：`npm run typecheck` exit 0（tsconfig + server + scripts 三段全过）；`npm run lint` exit 0（仅仓库既有 warning，无新增）。`npx vitest run src/modules/chat/tests/`：83 文件 / 527 用例全绿，含新增 `workSegmentKeyStability.test.tsx`（4/4）。

**写面核对**：`git diff --stat`（merge-base..HEAD）只含 `e2e/transcript-work-segments.spec.ts`（改）与 `src/modules/chat/tests/workSegmentKeyStability.test.tsx`（新，ASCII `(new)`），与 `## Touches` 对齐；未改任何产品源码（`workSegments.ts`/`messageKeys.ts`/`ChatMessagesPane.tsx` 的变异已 `git checkout --` 复原）。
