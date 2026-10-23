---
id: gap-session-lastactivity-from-file-mtime
title: 会话列表「最近活动」取自 transcript 文件 mtime 而非内容里最后一条带 timestamp 的记录：真实空闲 46.5h 的会话在
  UI 上显示为约 1 小时前
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

会话列表每行显示的「最近活动」是 transcript **文件的 mtime**，不是 transcript **内容里最后一条带 timestamp 的记录**。于是任何文件系统层面的触碰（外部进程重写/恢复该文件、CLI 自身 flush 状态记录）都会把一个空闲会话显示成刚刚活跃——显示的数值忠实反映了 mtime，是 mtime 不诚实。

**立案时的实测证据（session e6065ac3）：**

- transcript 最后一条带 timestamp 的记录：`2026-09-20T07:32:16.501Z`
- 该文件 mtime：`2026-09-22 13:45:36.042845706 +0800`
- 库中 `sessions.updated_at`：`2026-09-22T05:45:36.043Z`——与 mtime 毫秒级完全相同
- 即真实空闲 46.5 小时，UI 显示约 1 小时前
- 该会话确为空闲：拥有它的 CLI 进程（pid 2830976）仍活着但 `~/.claude/sessions/2830976.json` 记 `status: "idle"`、`updatedAt` = 09-20 15:16:51；从未出现过 `claude --resume e6065ac3` 进程
- 同项目 661 个 transcript 中另有 11 个的 mtime 恰为「最后消息 + 约 1 小时」，是同一机制的较轻形态

**代码路径（全部取文件系统时间，无一处读消息时间）：**

`server/modules/providers/list/claude/claude-session-synchronizer.provider.ts:80,114` 调 `readFileTimestamps(filePath)`（`server/shared/utils.ts:1016`，`updatedAt: fileStat.mtime.toISOString()`）→ `sessionsDb.createSession(..., timestamps.updatedAt, ...)` → `sessions.updated_at` → `server/modules/projects/services/projects-with-sessions-fetch.service.ts:153`（`lastActivity`）→ `src/modules/sidebar/SidebarSessionItem.tsx:61` 与 `src/modules/sidebar/SidebarContent.tsx:251` 的 `formatCompactAge`。

**修复方向：** 在 `server/shared/utils.ts` 增加一个「按内容取最后活动时间」的助手：只读打开，读有界尾部窗口，丢弃末尾半行，反向走到最后一条能解析且带字符串 `timestamp` 的 JSON 记录；找不到返回 null。claude 同步器改用它，取不到时**回落到 mtime**（刚创建、尚无任何记录的 transcript 必须仍有时间）。codex / cursor 同步器共用 `readFileTimestamps`，本次**不改其语义**，因此只在 claude 路径接线。

**性能约束（实测，必须守住）：** 内容读取只能发生在「该文件变了 / 是新文件」的路径上，绝不能进 `findFilesRecursivelyCreatedAfter` 的目录遍历——那次遍历每次 `/api/projects` 都要跑（`projects-with-sessions-fetch.service.ts:231` → `synchronizeSessions()`）。本机语料遍历实测 1213 个 `.jsonl`（`-maxdepth 2` 口径 1181 个、826.6 MB）。实测：遍历本身 5 ms；最大 transcript（9.7 MB）尾扫 64 KB 窗口 0.30 ms、256 KB 窗口 1.15 ms。放错层是 0.3 ms × 1213 ≈ 0.36 s 每次列表请求（冷缓存还要碰 827 MB），放对层是每事件约 1 ms。

**历史行：** 已索引的行不会自动纠正——boot 扫描按 `birthtime > lastScanAt` 过滤，watcher 只在文件变化时触发。AC-3 / DoD(d) 要求把已存在的行也修正过来。

## AC

- [x] AC-1 尾部扫描助手的行为：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/transcript-last-activity.test.ts` 退出码 0，覆盖 (a) 尾部是无 timestamp 的记录（`last-prompt` / `cost-state`）时跳过并取到更早的带 timestamp 记录；(b) 最后一行是半截 JSON 时不抛异常且取到上一条；(c) 全文件无 timestamp 记录时返回 null；(d) 返回值等于记录里的时间戳字符串本身。

- [x] AC-2 反假对照（同一 fixture 会话目录，两半读数都打印）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` 退出码 0，且输出含 `touch: before=… after=…` 与 `append: before=… after=…` 两行——(a) 只把 transcript 的 mtime 推到当前、内容一字不改后重新同步，`sessions.updated_at` 不变；(b) 追加一条带新 timestamp 的记录后重新同步，`sessions.updated_at` 前进到该 timestamp。把实现换回 mtime 版本时 (a) 半段必须变红——这正是该判据能区分两种实现的证明。

- [x] AC-3 真实语料读数（必须带正对照）：一段脚本对 `~/.claude/projects` 下每个 transcript 比较「库中 `updated_at`」与「内容里最后一条带 timestamp 的记录」（跳过 transcript 已不存在的行），打印 `rows=<n> controls=<m> mismatched=<k>`；要求 `controls >= 1` 且 `mismatched == 0`。正对照必须包含 mtime 明显晚于内容时间的真实样本（立案样本 e6065ac3：mtime 比最后消息晚 46.2 h，若该行已被清理则换用同类样本并写明）。`controls == 0` 时必须判失败——否则一个什么都不做的实现也能拿到 `mismatched == 0`。

- [x] AC-4 内容读取没有进目录遍历（无需注入缝的机械判据）：一个测试在 fixture 目录建好若干 transcript 并跑一次 `synchronize()` 建立游标；随后把这些 transcript `chmod 000`（保留 birthtime 与目录可执行位），再跑一次热扫描，要求不抛异常且处理文件数为 0。若实现把内容读取放进了遍历，第二次扫描会以 EACCES 失败——这正是要钉住的失败。命令：`npx tsx --tsconfig server/tsconfig.json --test <承载该断言的测试文件>` 退出码 0。

- [x] AC-5 门禁：`npm run lint` 退出码 0；`npm run typecheck` 退出码 0（两者在立案时均为绿）。

## DoD

(a) **判据真绿 + 抗假已证**：AC-1..AC-5 全部退出码 0；且 AC-2 的 (a) 半段在「实现换回 mtime」的变体下确实变红——把该变体的红输出与正常绿输出一并登记。只报绿不报对照不算完成。

(b) **真实对象被真的操作过**：不只有 fixture——在 canonical checkout 上对真实语料跑 AC-3，`controls >= 1` 且 `mismatched == 0`；并给出至少一条真实行修复前后的 `lastActivity` 读数（修复前 = 文件 mtime，修复后 = 内容时间）。

(c) **列表没有变慢**：给出 `/api/projects` 热路径 wall time 读数（修复前后各一次，同机同时刻同语料），并证明增量落在噪声内；AC-4 是这条的机械面。

(d) **历史行被纠正**：说明并验证已被索引的旧行如何被重新推导（不能只对「文件下次变化」生效），给出至少一条旧行的前后读数。

(e) **边界如实登记**：codex / cursor 同步器语义本次未改；若实现过程中不得不改到它们，须在完成记录里写明原因与影响面，而不是悄悄扩大改动面。

(f) **落地面**：新测试文件按仓内既有约定用 `@/shared/...` 别名走叶文件导入（参见 `server/shared/tests/slice-tail-page.test.ts` 的 `@/shared/utils.js`），以免撞上 boundaries 类 lint。

环境噪声须如实登记：本机是共享机器，fleet 常驻并发。与本机制无关的红（加载类／端口类）须写明红因并给出单独跑为绿的对照读数；不得当作本任务已完成或未完成的证据，也不得靠加重试换绿。

L_D 本任务有真实读数：`~/.claude/projects` 全语料中「库中 `updated_at` 晚于内容最后 timestamp」的行数，修复前 > 0、修复后 = 0（即 AC-3 的 `mismatched`）。读数为 0 而 `controls` 为 0 时不构成读数。
L_G 该轴仍暗，理由：本任务不新增 goal 判据，只让会话列表「最近活动」的语义与其声称的含义一致。

## Touches

- server/shared/utils.ts
- server/modules/database/repositories/sessions.db.ts
- server/modules/providers/list/claude/claude-session-synchronizer.provider.ts
- server/shared/tests/transcript-last-activity.test.ts (new)
- server/modules/providers/tests/claude-sessions.test.ts
- tasks/gap-session-lastactivity-from-file-mtime.md

## Completion

**判据（commits e7534bcc，merge develop 后重跑于 500ee9f9；第二轮修复于 c4c843dd）**

| AC | 命令 | 结果 |
| --- | --- | --- |
| AC-1 | `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/transcript-last-activity.test.ts` | 退出码 0（8 tests / 0 fail） |
| AC-2 | `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-sessions.test.ts` | 退出码 0（26 tests / 26 pass / 0 fail），含 `touch: before=2026-01-05T00:00:00.000Z after=2026-01-05T00:00:00.000Z` 与 `append: before=2026-01-05T00:00:00.000Z after=2026-01-06T12:00:00.000Z` |
| AC-4 | 同上（三个游标断言与 atime 探针同文件） | 退出码 0 |
| AC-5 | `npm run lint` / `npm run typecheck` | 均退出码 0（lint 余留 warning 全在 `src/` 既有文件，本次改动面 0 条） |
| AC-3 | `ac3.mts probe <db>` 见下 | `rows=1183 controls=32 mismatched=0`，退出码 0 |

**AC-2 (a) 半段的抗假对照（DoD(a)）** —— 三个变体均以「临时改实现 → 跑 → `git checkout --` 还原」取得，还原后工作树即已提交状态：

1. `resolveLastActivity` 换回 mtime（AC-2/AC-4 承载文件）：红。因首个控制断言先失败，为使 (a) 半段本身被判定，单独把该前置断言降级为打印后再跑一次，得 `indexed: updated_at=2026-09-22T07:03:53.661Z`、`touch: before=2026-01-05T00:00:00.000Z after=2026-09-22T07:03:53.793Z`、`AssertionError: a touch that changes no content must not move last activity`——(a) 半段确实变红。
2. 窗口首行判定恒为「半截」(`startsMidLine` → `return true`)：红，`✖ reads a complete record that starts exactly at the window boundary`，`AssertionError: Expected values to be strictly equal`（512 KiB 上限处返回 null，调用方回落 mtime）。
3. 把内容读取放进遍历（`synchronize()` 内对全量 transcript 无条件读一遍）：红，`AssertionError: open-a.jsonl was opened by a scan that should have skipped it`——AC-4 的 atime 断言正是钉住这一层的判据。

**AC-3 真实语料（DoD(b)）** —— 对**真实语料 + 真实行**（`~/.claude/projects` 1218 个 transcript / 896.6 MB，现库 1183 条 claude 行）跑，用库文件的一份拷贝（**未改动 `/data/home/yale/.cloudcli/auth.db` 本体**；拷贝与本体同内容，读数不受影响）：

- 修复前：`rows=1183 controls=32 mismatched=88`（L_D 的「修复前 > 0」）
- 重新推导一次后：`rows=1183 controls=32 mismatched=0`，退出码 0
- 正对照 32 条，含立案样本 `e6065ac3`：内容 `2026-09-20T07:32:16.501Z`、mtime `2026-09-22T06:45:36.045Z`（滞后 47.2 h）；同批最大滞后 117.8 h（`7a5d362c`）。`controls == 0` 会判失败。
- 单条真实行前后读数（DoD(b)/DoD(d)）：`e6065ac3` 修复前 `updated_at = 2026-09-22T06:45:36.045Z`（= 文件 mtime），修复后 `= 2026-09-20T07:32:16.501Z`（= 内容最后 timestamp）。

**历史行如何被纠正（DoD(d)）** —— 已索引的行不会被扫描或 watcher 碰到（游标按 `birthtime > lastScanAt` 过滤、watcher 只在变化时触发），因此新增一次性推导：`ClaudeSessionSynchronizer.synchronize()` 开头调用 `backfillLastActivity()`，从**库**里取 `jsonl_path` 非空的 claude 行（不是走 `~/.claude/projects`——遍历正是每次列表请求都要付的那一笔）逐行读内容并 `updateSessionUpdatedAt`，完成后在 `app_config` 记 `claude_last_activity_backfill_v1`。验证：一次调用即修正 1183 行（日志 `Re-derived last activity from transcript content for 1183 Claude session row(s).`）；fixture 测试另证该 pass 是**一次性**的——同一条旧行被重新置为陈旧后，第二次 `synchronize()` 不再改写它。transcript 已删除、或内容里没有任何 timestamp 的行保持原样（`pruneOrphanedSessions` 才是删除方）。

**热路径（DoD(c)）** —— 量的是 `/api/projects` 每次都会调到的 `synchronize()` 入口本身（真实语料，同机同时刻），不是 HTTP 往返，故读数不含套接字/序列化噪声：

| 读数 | 值 |
| --- | --- |
| `findFilesRecursivelyCreatedAfter` 遍历（游标为空，最坏） | median 4.4–5.2 ms |
| `synchronize()` 稳态（backfill 标记已置）修复**后** | 16.92 / 13.62 / 17.22 ms |
| `synchronize()` 稳态修复**前**（临时去掉 backfill 调用） | 15.36 / 16.50 / 14.25 ms |
| 单请求新增的工作量 | 6.1 µs（一次 `app_config` 索引读） |
| 反事实：遍历 + 每个 transcript 读一次内容 | 183–205 ms |
| 一次性推导（1183 行） | 23–24 ms，只发生一次 |

两侧区间（13.6–17.2 与 14.3–16.5）重叠，且各自 run-to-run 散布（约 3.6 ms）大于两侧中位数之差（约 1.5 ms）——增量落在噪声内。稳态 `synchronize()` 的绝对值里约 15 ms 是 `buildLookupMap(~/.claude/history.jsonl)`，修复前后都在。若把内容读取放错层，同一语料要付 183–205 ms（约 10 倍于整个 `synchronize()`），即 AC-4/变体 3 钉住的那一层。

**边界（DoD(e)）** —— codex / cursor 同步器语义未改（仍用 `readFileTimestamps`），改动只在 claude 路径接线；`readTranscriptLastActivity` 落在 `server/shared/utils.ts` 的既有 SESSION SYNCHRONIZER FILESYSTEM HELPERS 组内。**改动面确实比 Proposal 设想的大一处**：历史行推导需要「按 provider 列行」与「只改 `updated_at`」两个新查询，落在 `server/modules/database/repositories/sessions.db.ts`（`getSessionsWithTranscriptPath`、`updateSessionUpdatedAt`），已列入 Touches。选择放在同步器内、用 `app_config` 标记而不是沿用启动迁移，是为了不扩宽 `IProviderSessionSynchronizer` 接口与 synchronizer service。

**环境噪声如实登记**

- AC-3 首次读数曾出现 2–3 条「库值落后内容约 20 s」的行，且两次运行之间条数会变（2 → 3）：那是**正在被追加的活跃会话**（含本会话 `8938bc94`），库读数与随后的内容读之间天然存在竞态，不是陈旧读数。脚本因此增加「静止判定」：以推导 pass 结束时刻为界，`mtime` 晚于该时刻的行报为 `live=` 并从比较中排除。上述 `mismatched=0` 是该口径下的读数（当时 `live=0`）。
- AC-3 脚本对 `updated_at` 的解析最初把已是 ISO 的值再补一个 `Z`，导致不可解析而被计为 mismatch（1183）。修正为「已带时区则原样解析，否则按 SQLite `CURRENT_TIMESTAMP` 视作 UTC」后才得到上表读数。
- 本机 `~/.claude/projects` 语料在本次工作期间由 1213 个 / 826.6 MB 增长到 1218 个 / 896.6 MB（fleet 并发在跑），上述所有读数均出自同一时刻的同一份语料快照。
- AC-4 的字面 `chmod 000` 探针本身不足以区分实现：遍历里的 `try/catch` 会吞掉 EACCES，且游标本来就排除这些文件，于是「什么都不做」也拿到 `processed === 0`。因此该 AC 由三条断言共同承载——字面 chmod 探针、atime 探针（每个被排除的 transcript 的 atime 保持在被设为的旧值，并带正对照证明探针确实看得见读取）、以及变体 3 的红。这一点如实登记，不把单条 chmod 断言当成充分证明。
- 本次未跑 fan-in 全量 suite（按调度约定由 driver 接管）。

**第二轮：fan-in 全量 suite 红 → 修复（commit `c4c843dd`）**

上一轮 fan-in 的 suite 在 `server/modules/providers/tests/claude-session-title-source.test.ts` 变红，报 `AssertionError [ERR_ASSERTION]: an ai-title already in the row must not be re-read (read 1507651 bytes of a ~8MB file)`。该文件是 develop 既有判据、**不在本任务 Touches 内**，故未作任何改动，修复落在实现侧。

**红因（本任务引入的真实开销，非加载噪声）**：该判据用 `/proc/self/io` 的 `rchar` 把「已持有 ai-title 的行再同步一次」的开销钉在 1 MiB 以内；本实现为取最后活动时间多读了一段尾部窗口。原实现每次加宽都**重读整个窗口**，于是「只在 1 MiB 天花板处才有答案」的文件要付 64 KiB + 256 KiB + 1 MiB，落到 1.5 MB。`__PERFILE_KIND__` 报 `kind=assert`，两次读数逐次确定（1507643 / 1507651），排除加载类红。

**修复**（两处，均在 `server/shared/utils.ts` 内）：(1) 加宽只读窗口**尚未持有的那一段**（新增 `readFileRange` + `Buffer.concat`），天花板处的总 I/O 等于天花板本身，而不是各窗口之和；(2) 天花板由 1 MiB 降到 512 KiB。

**512 KiB 的依据（本轮重测，同机，1189 个 transcript）**：64 KiB 答出 1144 个，256 KiB 再答 37 个，512 KiB 答出最后 6 个；剩下 2 个是约 700 字节、**完全不含 timestamp 记录**的文件。**没有任何 transcript 需要超过 512 KiB**，所以降低天花板不损失任何真实读数。

**复测读数**

| 读数 | 值 |
| --- | --- |
| `claude-session-title-source.test.ts`「title 已知的第二遍」（判据 < 1048576） | 655683（余量 37%） |
| 同文件「24 MB 文件的 ai-title」（判据 < 4 MiB） | 786867（修复前 1638875） |
| AC-3 不变式复验（实现读数 vs **全文件** ground truth，1189 个 transcript） | `rows=1189 controls=1187 mismatched=0 nullWithTruth=0` |
| AC-1 | 8 tests / 0 fail，退出码 0 |
| AC-2 / AC-4 承载文件 | 26 tests / 0 fail，退出码 0，含 `touch: before=… after=…` 与 `append: before=… after=…` |
| providers + shared 模块全量 | 341 pass / 0 fail / 1 skipped，退出码 0 |
| 域内 scoped 门 `scripts/test.sh --for-task … --allow-thin` | 退出码 0 |

其中 `nullWithTruth=0` 是这一轮的关键读数：没有任何「内容里确有 timestamp」的 transcript 落到 mtime 回落——即降低天花板没有把任何真实行推回本任务要修的错误读数。该复验比原 AC-3 更强：原判据比的是「库中 `updated_at` vs 内容」，本轮直接比「实现返回值 vs 全文件 ground truth」，不含库快照与静止口径的影响。

AC-2 的反假对照（变体 1：实现换回 mtime）语义未变、仍成立；变体 2 描述中的天花板数字已由 1 MiB 更正为 512 KiB（承载其红的判据是本任务新增的 `transcript-last-activity.test.ts`，常量与注释已同步更新）。

本次仍未自行跑 fan-in 全量 suite（按调度约定由 driver 接管）。

