---
id: gap-scripts-static-gates-and-mint-token
title: 把 scripts/ 纳入静态门禁（typecheck 进 CI + lint + test runner 接线），并新增
  scripts/mint-token.mjs 一次性主体观察凭证工具及其不变量测试
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

`scripts/` 有 13 个文件(3 个 `.js` + 3 个 `.mjs` + 7 个 `.sh`,合计 176KB,其中 7 个 bash 占 156KB / 89%),而**三道常规门禁没有一道覆盖它**。实测(2026-09-22,canonical checkout `/data/home/yale/work/claudecodeui`):

- 根 `tsconfig.json` 的 `include` 只有 `["src","shared","vite.config.js"]` —— `npm run typecheck` 不碰 scripts/。
- `npm run lint` = `oxlint src/ server/` —— 不含 scripts/。
- `npm test` = `tsx --test "server/**/*.test.ts" "server/**/*.test.js"`,而 `vitest.config.ts` 的 `include` = `['src/**/*.test.ts','src/**/*.test.tsx']` —— 两边都不含 scripts/。
- 扫全部 7 个 workflow:CI 跑 `npm run typecheck`(4 个 workflow)与 `node scripts/release/build-server-bundle.js`(3 个),**没有任何 workflow 跑 test 或 lint**。所以三道门里只有 typecheck 进 CI —— 它是唯一有强制力的一道,最值得先把 scripts/ 接进去。

三个实测读数(都在本 checkout 上跑过,临时 tsconfig 已删):

lint:`npx oxlint scripts/` 退出码 1,**恰好 1 个 error** —— `scripts/release/prepare-desktop-app.js:49:16 eslint(no-unused-vars): Function 'copyIfExists' is declared but never used.`

typecheck(`allowJs + checkJs`,四档实测):

| include | strict | 错误数 |
|---|---|---|
| `scripts/**/*.mjs` | false | 0 |
| `scripts/**/*.mjs` | true | 6 |
| `scripts/**/*.js` + `.mjs` | false | 2 |
| `scripts/**/*.js` + `.mjs` | true | 26 |

26 那档的分布:`release/build-server-bundle.js` 12、`release/prepare-desktop-app.js` 6、`quay-attribution-probe.mjs` 6、`fix-node-pty.js` 2、`promote-dist-server.mjs` 0。本任务取 `**/*.mjs` + strict 这一档(6 处),因为新工具就是 `.mjs`,这样它从落地第一天起就在全严格之下。

runner:`scripts/quay-attribution-probe.test.mjs` **从写出来就没执行过** —— 全库搜索唯一引用它的是它自己。本任务把它接上,否则新工具的不变量测试会重复同一个错误。

一个影响选型的细节:`tsx` 是 devDependency(^4.21.0),而 `better-sqlite3` / `jsonwebtoken` 是 dependencies。所以新工具必须写成 `.mjs` 用裸 `node` 跑 —— 写成 `.ts` 会让它在 `npm install -g`(生产安装,无 devDeps)的实例上根本起不来。`scripts/release/*.js` 与 `promote-dist-server.mjs` 已经是这个约定。

### 新工具的形状:一次性主体,而不是给操作者本人签短 token

`scripts/mint-token.mjs` 是给 AI agent 用的短期观察凭证签发/撤销工具,不接入服务进程、不被 `server/` 或 `src/` 任何文件引用。

它签发 JWT,但主体不是操作者本人,而是每次新建的一次性 `users` 行(`username = observer-<ts>-<rand>`)。依据是一条既有不变量:`repositories/users.ts` 的 `getUserById` 过滤 `is_active = 1`,而 `authenticateToken` 对每个请求都调它。因此:

- 撤销 = `DELETE` 那一行,立即生效、不需要重启、不碰 `jwt_secret`、不登出操作者。
- 它扛得住自动续期。实测(2026-09-22,在 auth.db 的副本上、独立端口、独立实例):一张 30 分钟 token 经 `POST /api/auth/refresh` 变成 168 小时且 `userId` 不变;`DELETE` 主体后**原 token 与那张 168 小时 token 都是 401**。检查在主体上,不在 token 上 —— 这是整套设计能成立的原因,否则 `auth.middleware.ts` 的半衰期续期会让任何短 TTL 形同虚设。

工具必须自己守住(没有服务端代码兜底)的不变量,逐条要测:

1. 永远新建主体,绝不给已存在的 user id 签发 —— 撤销能成立的前提,唯一不能破的约束
2. TTL 上限硬编码(30 分钟)
3. token 永不写 stdout,只写 600 权限文件
4. 若服务端 env / `.env` 里能找到 `JWT_SECRET` 就拒绝运行(否则会用错密钥签)
5. `revoke` 之后必须验证:行已删**且**该 token 现在 401,否则报失败而非成功
6. 没有任何 `server/` 或 `src/` 文件引用它(判据见 AC)

### 明确不做

- ⛔ 不改 `server/` 与 `src/` 任何文件(工具刻意不接入服务进程)。
- ⛔ 不引入 shellcheck:本机未安装,而 scripts/ 那 156KB 是 bash —— 这一块本任务**明确不覆盖**,如实登记而非假装覆盖。
- ⛔ 不为让门禁变绿而放宽规则:不降 strict、不加 `@ts-nocheck`、不加 `oxlint-disable`、不删断言。
- ⛔ AC 不得使用裸 `bash scripts/test.sh`(它会触发该脚本前奏的 tree-wide 扫描,连带其他任务一起判红)。

<!-- dedup-ref -->同区域不同机制,仅作溯源:`gap-e2e-hardcoded-ports-collide`(done)与 `gap-e2e-onboarding-anchor-seeded-transcripts`(done)动的是 e2e 夹具;本任务动的是 scripts/ 的门禁覆盖与一个新的操作者侧工具,与它们没有共享的写入面。

## AC

- [x] 新增 `scripts/tsconfig.json`(`allowJs + checkJs + strict`,`include: ["**/*.mjs"]`),且 `npm run typecheck` 退出码 0。 实测:`npm run typecheck` 退出码 0(11.5s)。该命令现为三环(根 / server/ / scripts/),`scripts/tsconfig.json` 是新增的第三环。
- [x] 抗假变体真跑:`scripts/quay-attribution-probe.mjs` 里注入一个类型错误 → `npm run typecheck` 必须退出码非 0 且错误指向该文件该行;还原后再次退出码 0,`git diff` 只剩本任务改动。 实测:追加 `pluginRegex(42);` 后退出码 2,报 `scripts/quay-attribution-probe.mjs(113,13): error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'`;`git checkout --` 还原后退出码 0 且 `git status` 干净。读数为 scratch 的 ac2-mutated.log / ac2-after.log。
- [x] `npm run lint` 覆盖面含 scripts/(命令为 `oxlint src/ server/ scripts/`)退出码 0;抗假变体:在 scripts/ 下任一 `.mjs` 加一个未使用变量 → 退出码非 0 且指名该文件,还原后为 0。 实测:`npm run lint` 退出码 0(15s);注入 `const unusedByDesign = 1;` 后退出码 1,报 `scripts/mint-token.mjs:493:7: error eslint(no-unused-vars)`;还原后为 0。
- [x] `scripts/release/prepare-desktop-app.js:49` 的死函数已移除,`npx oxlint scripts/` 退出码 0。 实测:死函数 `copyIfExists` 已删;`npx oxlint scripts/` 退出码 0,零诊断输出。
- [x] runner 真正接上:`npm run test:scripts`(=`node --test "scripts/**/*.test.mjs"`)退出码 0,且输出里**同时**出现 `scripts/mint-token.test.mjs` 与 `scripts/quay-attribution-probe.test.mjs` —— 后者的出现即证明接线生效(它此前无任何 runner 执行),而非只改了声明。 实现注记:该 npm script 现为 `node scripts/list-script-tests.mjs && node --test "scripts/**/*.test.mjs"` —— runner 仍是本 AC 那条命令,前置一步只把「将被执行的文件集」打印出来。依据是两个实测事实:`node --test` 只在文件**失败**时才打印文件名,且 glob 匹配为空时退出码是 **0** —— 于是「glob 静默失效」与「全绿」在输出上不可区分。前置步在匹配为空时抛错(实测:同一个空 glob 下裸 runner 退出 0、加了前置步退出 1),所以它既提供本 AC 的读数,也是那个 glob 的失效保护。实测:`npm run test:scripts` 退出码 0,13 tests / 13 pass / 0 fail(658ms),输出同时含两个文件名。
- [x] `npm test` 仍退出码 0,且其输出包含 `scripts/*.test.mjs` 的用例,证明 `test` 确实链上 `test:scripts` 而不是新增了一个没人调用的脚本。实测并登记该命令 wall time;若 ≥50s,在正文注明它不得作为 goal criterion(60s 硬顶)。 实测:退出码 0,wall time **15.78s**(当轮 load 17~22),输出先 `ℹ tests 604`(server 段)后 `ℹ tests 13`(scripts 段,含具名用例)。15.78s < 50s,故本命令**可以**作为 goal criterion(60s 硬顶内),无需附禁用注记。
- [x] `node --test scripts/mint-token.test.mjs` 退出码 0,且 6 条不变量各有一条具名用例(拒绝为已存在 user id 签发 / TTL 上限 / token 不落 stdout / `JWT_SECRET` 存在时拒跑 / revoke 后验证 401 / 无 server·src 引用)。 实测:退出码 0,9 tests / 9 pass。六条不变量各一条具名用例,用例名均以 `invariant:` 开头。
- [x] 抗假变体:去掉"永远新建主体"这条不变量(改成允许传入已有 user id)→ "拒绝为已存在 user id 签发"那条用例必须变红;还原后全绿。 实测:删掉 `mint-token.mjs` 中 `assertFreshSubject(options.requestedUserId ?? null);` 一行后,具名用例 `invariant: a fresh subject is created for every mint — minting for an existing user id is refused` 变红(AssertionError: Missing expected exception;expected /refusing to mint for user id/),8 pass / 1 fail / 退出码 1;还原后 9/9 全绿、git 干净。
- [x] 真实落地取证(真跑,输出留在本任务自己的 scratch 目录):对一份 `auth.db` 副本 + 独立端口实例 —— mint 出的 token 打 `/api/auth/user` 得 200;经 `/api/auth/refresh` 换得 168 小时且 `userId` 不变;`revoke` 后两张 token 都得 401。 实测(逐字读数见 scratch/ac9-transcript.txt,驱动脚本 ac9-real-landing.sh):用 better-sqlite3 的 backup API 从只读句柄取 `~/.cloudcli/auth.db` 的一致副本;独立端口 3401、HOST=127.0.0.1、独立进程组实例。mint 得 token(user id 2)→ `GET /api/auth/user` **200**;→ `POST /api/auth/refresh` **200**,TTL **168h** 且 userId 不变(2 → 2);`revoke` 退出码 0 并自证「行已删 且 该 token 现在 401」;随后**原 token 与那张 168h token** 打 `/api/auth/user` 与 `/api/auth/refresh` **四条读数全部 401**;副本中 observer-* 行归 0。live 库全程只读(事后核对:observer-* 行 0、用户仍只有 id=1 `yale`),实例已按进程组回收、端口已释放。
- [x] `grep -rn "mint-token" server/ src/` 无输出(工具不接入服务进程)。 实测:退出码 1(无匹配)、零输出。
- [x] `git diff develop --name-only` 的全部改动都落在 Touches 内;`scripts/test.sh` 一行未改。 实测:merge develop 后 `git diff develop --name-only` 为 9 个文件,全部落在 Touches 内。其中三条为本轮补登,Touches 原文只列了 7 条:`.gitignore`(其否定规则正是让该 fixture 能被 commit 的原因)、`scripts/__fixtures__/fan-in-suite-lint-failure.log`(AC-5 要求 probe 测试真的可跑,而它一直因 `.gitignore` 的 `*.log` 从未被提交)、`scripts/list-script-tests.mjs`(AC-5 的读数机制)。`git diff develop --name-only -- scripts/test.sh` 为空:一行未改。

## DoD

真实落地判据,不是"文件存在":

(a) scripts/ 的类型检查**被 CI 拦得住** —— 由"注入类型错误 → 本机 `npm run typecheck` 变红"这条抗假变体正面证明,而不是靠一个 tsconfig 文件躺在那里;

(b) 那个从没跑过的 `scripts/quay-attribution-probe.test.mjs` **真的被执行**并出现在 runner 输出里,证明 runner 接通而非只改了 `package.json`;

(c) 新工具的撤销是**真的** —— 不是"代码里调了 DELETE",而是在真实实例上 mint → refresh(拿到 168 小时)→ revoke → 两张 token 都 401,即撤销扛得住自动续期;

(d) 工具与运行中的服务**没有接点** —— grep 判据为空。

环境噪声须如实登记:本机 128 核但负载常驻 7~11。若 `npm test` 或其子步骤出现与被测机制无关的红(如既有的 hook-timeout 类抖动),须写明红因并给出"单独跑为绿"的对照读数,不得当作本任务已完成的证据,也不得靠删断言或加重试换绿。

判据对应读数:(a) → AC-2 的注入变体(退出码 2 且错误指向 `文件(行,列)`)与 AC-3 的注入变体;(b) → AC-5 的 13 tests 输出里确实出现 `scripts/quay-attribution-probe.test.mjs`,且 AC-8 的变体正面证明该文件里的用例会随实现变红 —— 即它被执行,而不是被 runner 忽略;(c) → AC-9 的四条 401 读数;(d) → AC-10 的空 grep。

环境噪声如实登记:本轮 `npm test` 退出码 0,未出现与被测机制无关的红,因此不涉及「单独跑为绿」的对照。另登记(不影响任何判据):测量期间本机还有另一个任务的 e2e 实例在跑(`DATABASE_PATH=/data/scratch/yale/quay-e2e-*/auth.db`,端口 18901),与本任务不共享端口与数据库;AC-9 用的是本任务自选的空闲端口。

L_D 该轴仍暗,理由:本段只把 scripts/ 纳入既有静态门禁,并新增一个操作者侧的取证工具,不新增产品领域能力。
L_G 该轴仍暗,理由:同上;判定面由本任务自己的 AC 承担,不新增 goal 判据。

## Touches

- package.json
- scripts/tsconfig.json (new)
- scripts/mint-token.mjs (new)
- scripts/mint-token.test.mjs (new)
- scripts/quay-attribution-probe.mjs
- scripts/release/prepare-desktop-app.js
- tasks/gap-scripts-static-gates-and-mint-token.md
- .gitignore
- scripts/list-script-tests.mjs (new)
- scripts/__fixtures__/fan-in-suite-lint-failure.log (new)
