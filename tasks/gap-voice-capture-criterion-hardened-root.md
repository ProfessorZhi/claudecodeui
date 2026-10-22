---
id: gap-voice-capture-criterion-hardened-root
title: 判据自造判据世界：AC-148 的 scripts/voice-capture-process-check.mjs 在部署方 .env 钉住
  VOICE_CAPTURE 的检出里仍产出「未设置」那一半读数（旁证同步容忍 .git 是目录）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-148
---
## Proposal

<!-- dedup-ref --> 同机制去重结论（本段只作溯源，不声明任何依赖边）：立案时 `grep -rn '^goal_ac: *AC-148' tasks/*.md` 只命中 `gap-voice-capture-real-process`（`status: done`）—— 按 `standing-violated` 的规矩，它**不是**重复而是「早先那次出货没有守住」的证据，故本条另立新任务；同族认领 AC-143..AC-147 的四份（`gap-voice-capture-mode-gate-off-fail-closed`=AC-143、`-text-payload`=AC-144、`-audio-file`=AC-145、`-secrets-three-modes`=AC-146、`-isolation`=AC-147）Touches 都不含本条要动的两个 `scripts/` 文件；在飞（todo/ready/needs-human）任务里没有任何一份带 `goal_ac: AC-148`。本条与 `gap-voice-capture-real-process` 机制不同：那份负责**把判据写出来**，本条负责**让判据在被裁定的那个检出里能测**。

**现状（本次立案实测，可复验）**

| 读什么 | 读数 |
|---|---|
| 部署方的 `.env` | `cat .env` → `VOICE_CAPTURE=audio`（mtime 2026-09-30 10:15；`git check-ignore -v .env` → `.gitignore:19:.env`，它不是仓库文件） |
| 这不是事故，是长期合法部署状态 | `ls -la ~/.cloudcli/voice-capture/` → `audio-1.bin`（90800 字节，mtime 2026-09-30 10:18）；`grep -c 'voice.capture' server.log` → 24 —— 人 yale 2026-09-30 把 audio 档打开真机在用 |
| AC-148 的判据在本检出 | `node scripts/voice-capture-process-check.mjs` → 退出 **2**：`EMPTY_READING — /data/home/yale/work/claudecodeui/.env sets VOICE_CAPTURE, so the unset half of this criterion cannot be produced …` |
| 台账 | `.quay/gate-events.jsonl` 里 AC-148：`2026-09-29T23:22:56` / `2026-09-30T00:23:32` / `2026-09-30T01:23:54` 三次 `pass (exit 0)`；`2026-09-30T02:25:07`（goal-sweep）与 `02:25:42`（goal-cli）两次 `fail (exit 2)` —— 变的不是出货代码，是判据从那时起看不见 |
| **反事实：出货实现是对的** | 把本仓硬链接成一份不含 `.env` 的副本（`cp -al`，实测 1.516 s），`node scripts/voice-capture-process-check.mjs --root <副本>` → **退出 0**：`startup.text.count=1`、`startup.text.line=voice.capture mode=text`、`capture.lines=1`、`upstream.exact=true`、`text.exact=true`、`double.requests=1`、`double.path=/audio/transcriptions`、`double.bytes=319`、`http.status=200`、`http.text.exact=true`、`unset.captureLines=0`、`unset.startup.line=voice.capture mode=off`、`unset.startupTextLines=0`、`unset.httpStatus=200`、`unset.text.exact=true`、`unset.double.requests=1`、`service-source-imports=0`、`real-upstream-calls=0`、`check.failures=0`、`elapsed-ms=4263` |
| 旁证在本检出也红 | `node --test scripts/voice-capture-process-check.false-forms.test.mjs` → 退出 1：`buildCopy` 里 `rmSync(copyRoot/.git, {force:true})` 抛 `ERR_FS_EISDIR`（主检出的 `.git` 是**目录**，而该文件是按 worktree 里 `.git` 是**指针文件**写的），副本泄漏 ⇒ 两个用例都没跑成，末尾「a throwaway copy survived the run」再红一次 |
| 副本不能放 tmpdir | 实测 `cp -al <repo>/. /tmp/…` → `Invalid cross-device link`（`/tmp` 在 `/dev/vda2`，本仓在 `/dev/vdb`）；`TMPDIR=/data/scratch/yale` 与 `/data` 同盘，本项目判据自己的 `run-dir` 就落在那里 |

**因（一句话）。** 判据把「未设置那一半能不能产出」外包给了**部署方的 `.env`**：`dotEnvPinsCaptureMode(root)` 一命中就打 `EMPTY_READING` 并退出 2。当初的顾虑是对的（子进程里删掉 `VOICE_CAPTURE` 后 `server/load-env.ts` 会用 `.env` 的值顶上，零捕获行读数就变成在说这份环境而不是在说实现），结论是错的 —— 该做的是**让判据自己造一个不受部署方 `.env` 影响的判据世界**，而不是宣布测不了。`server/load-env.ts` 的 `APP_ROOT` 由模块自身路径推出（`getBootstrapApplicationRoot(import.meta.url)`，从 `server/` 往上找），所以判据只要从一个**删掉了 `.env` 的硬链接副本**里起子进程，子进程的世界就由判据自己定义。判据当初就给自己留了这句旁注：`Remove the line (or point --root at a checkout without it) and rerun` —— 本条把「or」那一半做成判据自己会做的事。

**交付**

1. `scripts/voice-capture-process-check.mjs`：把它判的对象从「`--root` 本身」改成「`--root` 的一次性硬化副本」。
   - 副本位置取 **`--root` 的兄弟目录**（`fs.mkdtempSync(path.join(path.dirname(root), '.voice-capture-process-check-'))`）：同文件系统是硬链接的前提（见上表实测），兄弟目录由构造保证同盘。
   - 用 `cp -al` 硬链接（与本族旁证同一机制、同一实测成本，约 1.5 s）。**推荐按顶层条目逐个硬链接并跳过 `.git` 与 `.env`**，让副本出生就没有这两样；若沿用「整树 `cp -al` 再删」，删除必须是 `rmSync(..., {force:true, recursive:true})`（`.git` 在主检出里是目录）且**只能是 unlink/删除，绝不能就地写入**：`cp -al` 让副本的 `.env` 与检出共享 inode，就地写会改到部署方的文件（旁证文件第 51–59 行把这个坑写得很清楚）。
   - 删 `load-env.ts` 会读的 `.env`（整份即可；判据只依赖自己显式设置的那些键，而 `scripts/mint-token.mjs` 本来就要求 `JWT_SECRET` 不被 `.env` 顶上）；`.git` 在 worktree 里是指向真实 git 目录的**活线**，也不该进副本。
   - **两条腿（`text` 与未设置）都从副本跑**，子进程的 `cwd` 与入口路径都指向副本；`scripts/mint-token.mjs` 可继续用原 `--root`（它只写运行自己的临时库）。
   - `dotEnvPinsCaptureMode` 从**退出分支降级为读数**：新增 `env-file-in-root=<present|absent>`、`env-file-pins-voice-capture=<b>`、`judged-root=<副本路径>`、`judged-root-env-file=absent`、`hardened-root-removed=<b>`。`EMPTY_READING` 那条早退删除；「测不了」只保留真测不了的情形（副本建不出来、`--root` 下没有 `node_modules/tsx`、服务起不来），仍然退 2 并把原因写到 stderr。
   - 副本在**每条出口**（成功 / 变异红 / could-not-measure / 抛错）都删除：把清理放进 `finally` 或逐个 `return` 前处理。
   - 别写出 `createVoiceService` / `voice.module` / `voice.service` 这三个字面量：`countOwnSourceTokens()` 用 `grep -c` 读本文件，写出来就自伤（既有的 `FORBIDDEN_SOURCE_TOKENS` 注释已说明）。
2. `scripts/voice-capture-process-check.false-forms.test.mjs`：`buildCopy` 的 `.git` 处理要容忍目录形状。它现在在本检出里必红（上表 `ERR_FS_EISDIR` + 副本泄漏），而 `npm run test:scripts` 的 glob 是 `scripts/**/*.test.mjs` 且 `scripts/list-script-tests.mjs` 把同一 pattern 逐字重复（退出 0 要求匹配非空），所以这是本检出的既有红。修法任选（`{recursive:true, force:true}`，或改成与判据相同的「跳过 `.git`/`.env` 的逐条硬链接」），但**判定按结果**：本检出里 3/3 绿、无 `ERR_FS_EISDIR`、无 `voice-capture-false-forms-<pid>-*` 残留，两条变异仍各自只红一条被指名的读数。
3. **不改任何出货源码**：两个文件都在 `scripts/` 下，`server/`、`src/`、`shared/` 零改动。**也不改部署方的 `.env`**（判据只读它、绝不写它；运行前后 sha256 相同是 AC4 的一条读数）。

**边界（不做）**：不改 `server/`、`src/`、`shared/`、`experiments/`、`docs/experiments/` 下任何文件；不改 AC-143..AC-147 的任何判据文件与其语义；不改 `VOICE_CAPTURE` 的三档语义、默认值与启动行文字（那是 AC-143..AC-145 的读数）；不改 `server/load-env.ts`（不动出货的环境装载契约）；不驱动浏览器；不读 `server.log`；不联网（上游仍是 `127.0.0.1` 上的替身）；不删、不改、不动 `.env`。

## AC

- [x] AC1 判据在部署方 `.env` 钉住 `VOICE_CAPTURE` 的**本检出**里退出 0：`cat .env` 读出 `VOICE_CAPTURE=audio`；`node scripts/voice-capture-process-check.mjs` 退出 0；输出含 `env-file-in-root=present`、`env-file-pins-voice-capture=true`、`judged-root=<一个与 --root 不同的路径>`、`judged-root-env-file=absent`、`hardened-root-removed=true`、`check.failures=0`，且 `elapsed-ms` < 45000（判据门 60 秒硬上限不可调）。
- [x] AC2 读数集与硬化前逐条同形：同一次运行输出 `startup.text.count=1`、`startup.text.line=voice.capture mode=text`、`capture.lines=1`、`upstream.exact=true`、`text.exact=true`、`double.requests=1`、`double.path=/audio/transcriptions`、`http.status=200`、`http.text.exact=true`、`unset.captureLines=0`、`unset.startup.line=voice.capture mode=off`、`unset.startupTextLines=0`、`unset.httpStatus=200`、`unset.text.exact=true`、`unset.double.requests=1`、`service-source-imports=0`、`real-upstream-calls=0`。
- [x] AC3 判据不再依赖部署方 `.env`（两臂相等）：同一棵树上跑两臂 —— (i) 本检出（`.env` 钉着 audio，`--root` 省略）；(ii) 一个不含 `.env` 的硬链接副本（`--root <副本>`）。两臂都退出 0，且把两次 stdout 里的**路径类与时间类**读出（`root=`、`run-dir=`、`child-home=`、`child-db=`、`judged-root=`、`env-file-*`、`real-db-*`、`elapsed-ms`）整行剔除后，其余行**逐字相同**。可证伪：把「副本不带 `.env`」那一处改回不删（或让判据直接判 `--root` 本身），第 (i) 臂立刻回退出 2 `EMPTY_READING`，这条读数不再成立。
- [x] AC4 副本在每条出口都被删，且判据不动本次检出：跑完三种情形之后 —— 成功那次、旁证里发生变异的那次、以及 `--root` 指向一个没有 `node_modules/tsx` 的空目录而退 2 的那次 —— 相应 `--root` 的父目录里都没有 `.voice-capture-process-check-*` 残留（退 2 那次的 stderr 要指名原因）；成功那次还打印 `hardened-root-removed=true`；`git -C <root> status --porcelain --untracked-files=no` 运行前后逐字相同；`.env` 的 sha256 运行前后相同（把该 sha256 打印出来）。
- [x] AC5 旁证在本检出（`.git` 是目录）里退出 0 且仍指名叫红哪条读数：`node --test scripts/voice-capture-process-check.false-forms.test.mjs` 退出 0（3/3）；输出含 `mutation=assembly-not-wired baseExit=0 mutantRed=true whichReading=capture.lines` 与 `mutation=startup-line-missing baseExit=0 mutantRed=true whichReading=startup.text.count`；全程不出现 `ERR_FS_EISDIR`；`os.tmpdir()` 下无 `voice-capture-false-forms-<pid>-*` 残留。可证伪：把该文件的 `.git` 删除改回 `{force:true}`（不带 `recursive`），在本检出立刻回 `ERR_FS_EISDIR` 且用例红 —— 这正是现在实测到的形状。
- [x] AC6 判据自身的不变量没变：`grep -c 'createVoiceService\|voice\.module\|voice\.service' scripts/voice-capture-process-check.mjs` = 0；`service-source-imports=0`；`hosts=` 列出的每个目标都以 `127.0.0.1:` 开头；`real-upstream-calls=0`。
- [x] AC7 出货源码零改动：`git diff --stat develop HEAD -- server/ src/ shared/` 为空（把该输出原样打印，空即通过）；`git diff --name-only develop HEAD -- scripts/` 恰好列出 `scripts/voice-capture-process-check.mjs` 与 `scripts/voice-capture-process-check.false-forms.test.mjs` 两个文件。
- [x] AC8 仓库门不回归：`npm run lint`、`npm run typecheck` 各退出 0（逐条打印退出码，不是空过）；`npm run test:scripts` 退出码与 `tests/pass/fail` 相对 develop 不新增红 —— 打印两次运行的计数与失败文件清单；该 lane 若在 develop 上已有红，逐条证明红落在本条未触碰的文件上。

## DoD

真实落地判据：不是「判据多了几行」，而是**部署方把 `VOICE_CAPTURE` 钉在 `.env` 里的检出**里，`node scripts/voice-capture-process-check.mjs` 仍然从**真实服务进程的 stdout** 与**一次真实 HTTP** 取到完整读数集（启动行 + 一行 `voice.capture` + 未设置时零捕获行），并且同一份判据在不含 `.env` 的检出里产出**除路径/环境/时间读数外逐字相同**的一组读数 —— 两臂相等由输出证明，不由段落声明。承重性由三件读数证明：

(a) **「钉着 `.env` 也能测」是读数而不是自述**：`env-file-in-root=present` 与 `env-file-pins-voice-capture=true` 与 `check.failures=0` 同时出现在同一次运行里；把「副本不带 `.env`」去掉，这条立刻回 exit 2（AC3 的可证伪臂）。

(b) **判据世界是判据自己造的，且它没动部署方的文件**：`judged-root-env-file=absent`（副本里没有 `.env`）与 `.env` 的 sha256 前后相同同时成立。

(c) **硬化没有把判据变宽**：两条取假形态变异仍旧各自只红一条被指名的读数、且互不遮挡（AC5）—— 「能跑了」不是靠放宽读数换来的。

**必须如实登记**：本条修的**不是出货实现**。2026-09-30 的反事实（同一棵树、去掉 `.env`、`--root` 指副本）实测退出 0、读数全成立，所以 `gap-voice-capture-real-process` 的出货没有失效；失效的是**判据对部署方 `.env` 的环境耦合**（同 [[goal-criterion-runs-under-driver-anchor-env]] / [[scoped-gate-verdict-can-depend-on-ambient-anthropic-model-env]] 一类：门按锚点的 environ 与检出跑判据，任何把裁决建在环境上的读数都会在别人手上翻面）。硬链接副本与 `--root` 共享 inode、字节相同，但**不是**编译产物 `dist-server/server/index.js`；上游仍是本地替身，不是真实 DashScope；不驱动浏览器；读的是子进程 stdout 而不是 `server.log`。

**已知不等价点**：`cp -al` 需要同文件系统，副本因此放在 `--root` 的兄弟目录（该目录不可写时判据退 2 并在 stderr 说明，而不是假红）；副本带 `node_modules`（与 `.git`，若沿用整树拷贝）的硬链接，inode 数会瞬时增加，实测整树拷贝 1.516 s；判据现在每次运行都要多付这一次拷贝；`--root` 若本身已是一份副本（旁证就是这样用的），判据会在其上再套一层副本（成本翻倍但仍在本条预算内）。

L_D 该轴仍暗，理由：本条读数全是布尔、计数、逐字比对与一个墙钟预算，没有可比的数值量；拷贝耗时的 1.5 s 是环境量而不是本条的命题。

L_G 读数：本检出（`.env` 钉 audio）与不含 `.env` 的副本两臂，`check.failures` 都 = 0 且逐条读数逐字相同；`env-file-in-root` 两臂分别 = present / absent。

## Touches

- scripts/voice-capture-process-check.mjs
- scripts/voice-capture-process-check.false-forms.test.mjs
- tasks/gap-voice-capture-criterion-hardened-root.md
