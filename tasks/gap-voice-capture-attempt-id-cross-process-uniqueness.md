---
id: gap-voice-capture-attempt-id-cross-process-uniqueness
title: 语音捕获 attempt id 跨进程唯一（实例盐+序号）且写文件独占创建、重名让位：重启不得覆盖既有录音
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

<!-- dedup-ref --> 同机制去重（本段只作溯源）：在库无同机制任务 —— `grep -rln 'newAttemptId' tasks/*.md` 零命中。同族 `gap-voice-capture-audio-file`（done，`goal_ac: AC-145`）管的是「写文件、权限、字节与 sha256、不清理」，未规定 attempt id 的作用域；本条是它没有覆盖的另一个机制（身份的作用域），不是它的重述。

**机制（一句话）**：attempt id 由进程内计数器铸造——`server/modules/voice/voice-capture.ts` 的 `let sequence = 0; newAttemptId() → `${mode}-${sequence}``（约 `:664-671`）；文件名是该 id 的函数（`captureFileName`，`:431`），落点不独占（`writeFileSync(target, audio.bytes, { mode: CAPTURE_FILE_MODE })`，`:483`）。于是 **id 的唯一性只在进程内成立，而文件按跨进程的寿命保存**，重启即同名覆盖。

**实测证据（2026-10-02，本机 :3001 服务，可复验）**：`server.log:157530` 那条 09-30 记录的 `path=~/.cloudcli/voice-capture/audio-1.bin`、`sha256=bcb270943c52aaec…`；同一路径下现在的字节 `sha256=5a4ea8ad5612b01f…`（10-02 18:46 那次，行在 `server.log:302576`）。一条审计记录指向了别人的录音：**可检测（sha256 对不上）但不可恢复**。

**与既定裁定的关系**：`docs/proposals/voice-capture-server-side.md:65` 写的就是 `captureId=<uuid>`，落地换成了进程内计数；该提案非目标「不做保留期、不做总量上限、不做自动清理」的前提正是命名唯一。本条把这一半补回，不改任何已裁定的策略。

**做法**

1. **id 跨进程唯一**：`<mode>-<实例盐 base36>-<进程内序号 base36>`（如 `audio-m9k3x2-1`）。实例盐由**组装根**解析一次（与既有 `VOICE_CAPTURE`/`VOICE_CAPTURE_DIR`/`VOICE_TIMEOUT_MS` 同一处）后作为参数注入，模块内不读 `process`；纯函数 `resolveInstanceSalt(pid, startedAtMs)` 与既有 `resolveVoiceCaptureDir` 同址同形（同模块导出、由根与判据共用，故不进 `server/shared/`）。
2. **写入永不销毁既有文件**：`writeFileSync(..., { flag: 'wx', mode })` 独占创建；`EEXIST` 时改名让位（`-2`、`-3`…）并返回真实落点，**不抛错**——抛错会让 `recordAttempt` 整行丢失（比丢音频更糟，且与 AC-147 冲突）。行内 `path` 仍取 sink 返回值，与转写行的 join 不破。
3. **未动的**：id 铸造先于写行、行与 `voice.transcribe` 行 id 相等、`captureFileName` 的路径安全替换、目录 0700 文件 0600、`off`/`text` 零文件零目录、清理策略（不清理）。

**取假形态（本条必须打红的现状）**：现有实现下 AC1 必须为红。特别注意「同一个进程里起两个 port 实例」这种写法在**现有**实现下也是绿的（序号 1、2 → 两个不同 id、两个文件、sha256 均对）——那是个判据洞，故 AC1 必须跨**真实进程**。

**非目标**：不做保留期/容量上限/自动清理（提案已裁定）；不改 `server.log` 的权限、轮转与重启覆盖行为——「索引寿命」记为运维项（启动命令用 `>>`），本条不写代码；不改路由与客户端，`captureId` 不进任何对外接口。

**已知代价**：`server/modules/voice/tests/voice-capture-audio.false-forms.test.ts:148` 把出货的写调用逐字钉成锚点（`const WRITE = '      writeFileSync(target, audio.bytes, { mode: CAPTURE_FILE_MODE });'`），改写调用必须同步重锚——本仓库既有陷阱，重锚后锚点须仍唯一。

## AC

- [x] AC1 跨进程唯一（真形态）：起两个真实子进程（tsx，各跑一次），各自经组装路径铸一个 attempt id 并打印；断言两个 id 不同，且各自可作为文件名互不覆盖。取假形态：现有实现下两者皆为 `audio-1` → 必红。打印 `p1-id=<…> p2-id=<…>`。
- [x] AC2 永不覆盖：在目标目录预置一个与本次内容不同的同名哨兵文件，写入后断言哨兵字节不变、新文件为另一名字、行内 `path` 指向新文件、且新文件 sha256 与行内一致。打印 `sentinel-intact=<b> new-path=<p>`。
- [x] AC3 不回归：`off`/`text` 档零文件零目录（AC-143）、目录 0700 文件 0600 且文件字节与上传逐字节相同（AC-145）、行与 `voice.transcribe` 行 `captureId` 相等（AC-144）三条既有判据仍绿。
- [x] AC4 失败不回传：音频目录不可写时转写仍 `ok`、返回文本不变、只多一行不含内容的 `voice.capture failed`，且不留半截文件（AC-147 不回退）。

## DoD

真实落地：`VOICE_CAPTURE=audio` 下启动真实服务进程，发一次真实 HTTP 转写，**重启该进程**后再发一次；`~/.cloudcli/voice-capture/`（或 `VOICE_CAPTURE_DIR`）下出现两个文件、两行 `path` 互异，且用 sha256 复核两个文件各自仍等于其行内 sha256——重启没有覆盖第一次的字节。仅单测注入端口通过不算落地（判据文件是必要不充分）。

## Touches

- server/modules/voice/voice-capture.ts
- server/modules/voice/voice.module.ts
- server/modules/voice/tests/voice-capture-audio.test.ts
- server/modules/voice/tests/voice-capture-audio.false-forms.test.ts
- tasks/gap-voice-capture-attempt-id-cross-process-uniqueness.md
