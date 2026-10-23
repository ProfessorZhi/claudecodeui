#!/usr/bin/env node
/**
 * 假化控制 / 判词分支用例：`scripts/vitest-heap-limit-check.sh`。
 *
 * 背景（task gap-vitest-worker-heap-limit）：2026-09-25 有个失控用例在 14 秒里长到 12G，宿主
 * 把整个 tmux scope（含 :3001 服务）一起 OOM 掉了。修法是在 vitest.config.ts 里给每个 worker
 * 钉一个 V8 堆上限 —— cgroup 那一层（scripts/with-memory-cap.sh，24G）只挂在两个入口上，
 * 而那次事故走的是【直接 npx vitest run】，它绕过了那一层。
 *
 * 这个文件证的是【判据本身】：脚本给出的每一条判词都得能从读数上站住，而且没有一个分支是
 * 「写了但永远不可能被观测到」。所以每个分支各一条用例（AC4）：
 *   T1 受限：直接 npx vitest run 下失控夹具秒级死在堆上、整树 RSS 峰值不越过 1.5×上限、
 *      墙钟 ≤ 30s；正对照（约上限 30%）照常绿 —— 判据不是靠「一律红」成立的。
 *   T2 未受限：QUAY_VITEST_HEAP_MB=off ⇒ 配置上限没到达 worker，夹具越过 3×上限由
 *      脚本自己的看门狗杀掉，判据红且点名未受限（AC3 的证伪形态）。
 *   T3 良性误杀：上限收到 64MB ⇒ 正常用例也被打死，判词点的是误杀而不是「受限」（两条
 *      判词在同一个观测面上必须分得开）。
 *   T4 夹具残留：清理被跳过（分支唯一可达的路径）⇒ 判词被残留【覆盖】成 FAIL。
 *   T5 信号路径：跑到一半收 SIGTERM ⇒ 夹具仍然被清掉，且不留孤儿 vitest。
 *   T6 收尾：整轮跑完仓里没有任何夹具残留（AC4 明文用 git status --porcelain 断言）。
 *
 * ⛔ 独立读数，不是复述判词：每个用例都自己采样【脚本那棵树】的 RSS 峰值（/proc 后代遍历），
 * 于是「RSS 峰值 ≤ 1.5×上限」「越过了 3×上限」这两条由测试自己量，脚本自己打印的数字只用来
 * 交叉比对 —— 否则脚本一旦永远打印 PASS，这个文件也会跟着绿（判据自己不会说谎，但会瞎）。
 * 夹具那条 vitest 自己的退出码与堆耗尽文本在脚本内部，测试这一侧看不到（scratch 目录已被
 * 清掉），那两条读的是脚本的读数，测试只断言它把它们带进了判词。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Off unless RUN_OOM_CAP_TESTS=1: every case runs a deliberately runaway vitest fixture with no cgroup
// cap underneath it (the check exists to prove the V8 heap limit alone stops it), so a limit that
// fails to hold grows the fixture until the host OOM-kills whatever shares its scope — the 2026-09-25
// incident this check was written for. It must not run by default.
if (process.env.RUN_OOM_CAP_TESTS !== '1') {
  console.error('[vitest-heap-limit-check] disabled: set RUN_OOM_CAP_TESTS=1 to run (runaway fixture, no cgroup cap)');
  process.exit(0);
}

const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const CRITERION = path.join(SCRIPT_DIR, 'vitest-heap-limit-check.sh');
const FIXTURE_PREFIX = '.vitest-heap-check.';
// 夹具目录名形如 .vitest-heap-check.<pid>.<rand>；这个正则用来在 /proc 里认出孤儿进程 ——
// ⛔ 它必须【只】匹配夹具目录名：本测试自己的文件名（vitest-heap-limit-check.test.mjs）与
// 判据脚本的文件名都不许命中，否则孤儿检查会永远误报自己。
const FIXTURE_DIR_RE = /\.vitest-heap-check\.\d+\.\d+/;
// 「夹具的 vitest 正在跑/还活着」的行文特征：命令行里既有夹具目录，又点名了夹具的测试文件。
// ⛔ 只看目录名不够 —— 生成夹具那一步（sed/cat）的命令行里也有目录名，那会在开工前就命中。
/** @param {string} cmdline */
const fixtureRunning = (cmdline) => FIXTURE_DIR_RE.test(cmdline) && /(benign|runaway)\.test\.ts/.test(cmdline);

const REAL_BASH = execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();

// ── 独立读数：脚本那棵树的整树 RSS 峰值 ──────────────────────────────────────
/** /proc/<pid> 的后代（含自己）的 VmRSS 之和，KB。读不到的部分按 0 计。
 * @param {number} rootPid
 * @returns {number}
 */
function treeRssKb(rootPid) {
  let total = 0;
  const seen = new Set();
  let queue = [rootPid];
  while (queue.length > 0) {
    /** @type {number[]} */
    const next = [];
    for (const pid of queue) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        const status = readFileSync(`/proc/${pid}/status`, 'utf8');
        const rss = /^VmRSS:\s+(\d+)/m.exec(status);
        if (rss) total += Number(rss[1]);
      } catch {
        // 进程刚退出：这一份就当 0
      }
      try {
        const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
        for (const child of children.trim().split(/\s+/)) {
          if (child !== '') next.push(Number(child));
        }
      } catch {
        // 同上
      }
    }
    queue = next;
  }
  return total;
}

/**
 * 跑一次判据，并在旁边独立采样它那棵树的 RSS 峰值。
 * @param {Record<string, string>} env 额外环境变量
 * @param {string[]} args
 * @param {{ killAfterMs?: number, killWhenFixturesRunning?: boolean }} [opts]
 * @returns {Promise<{status: number|null, signal: string|null, stdout: string, stderr: string, peakMb: number, wallMs: number, signalled: boolean}>}
 */
function runCheck(env, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(REAL_BASH, [CRITERION, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let peakKb = 0;
    let killed = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (/** @type {string} */ chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (/** @type {string} */ chunk) => {
      stderr += chunk;
    });
    const sampler = setInterval(() => {
      if (child.pid === undefined) return;
      const kb = treeRssKb(child.pid);
      if (kb > peakKb) peakKb = kb;
    }, 50);
    if (opts.killWhenFixturesRunning === true) {
      // 等到「夹具已经开跑」再发信号：判据必须是被打断在半路，而不是还没开工。
      const poker = setInterval(() => {
        if (killed || child.pid === undefined) return;
        // 「夹具真的在跑」= ①夹具目录已建；②那棵树已经吃进 600MB（说明 vitest 连同 jsdom
        // 夹具已经起来，不是还在生成夹具）；③树里确有夹具那条 vitest。⛔ 只看②会撞上
        // 「刚 spawn 出来还没跑」的那一瞬：那样打断的只是启动，收不到「跑着的夹具被一起收掉」
        // 这条读数。三条一起看，信号才落在【跑着的时候】。
        if (
          leftoverDirs().length > 0 &&
          treeRssKb(child.pid) > 600 * 1024 &&
          descendantCmdlineIncludes(child.pid, fixtureRunning)
        ) {
          killed = true;
          clearInterval(poker);
          child.kill('SIGTERM');
        }
      }, 50);
      child.on('exit', () => clearInterval(poker));
    }
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('判据没有在 120s 内收场（看门狗）'));
    }, 120000);
    child.on('exit', (code, signal) => {
      clearInterval(sampler);
      clearTimeout(guard);
      resolve({
        status: code,
        signal,
        stdout,
        stderr,
        peakMb: Math.round(peakKb / 1024),
        wallMs: Date.now() - started,
        signalled: killed,
      });
    });
  });
}

/** 脚本那棵树里有没有进程的命令行命中 pattern（用来认「夹具正在跑」/「留下孤儿」）。
 * @param {number} rootPid
 * @param {(cmdline: string) => boolean} matches
 * @returns {boolean}
 */
function descendantCmdlineIncludes(rootPid, matches) {
  let found = false;
  const seen = new Set();
  let queue = [rootPid];
  while (queue.length > 0 && !found) {
    /** @type {number[]} */
    const next = [];
    for (const pid of queue) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
        if (matches(cmdline)) found = true;
      } catch {
        // 进程没了
      }
      try {
        const children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
        for (const child of children.trim().split(/\s+/)) {
          if (child !== '') next.push(Number(child));
        }
      } catch {
        // 同上
      }
    }
    queue = next;
  }
  return found;
}

/** 仓根下现存的夹具目录名。
 * @returns {string[]}
 */
function leftoverDirs() {
  return readdirSync(REPO_ROOT).filter((name) => name.startsWith(FIXTURE_PREFIX));
}

/** AC4 明文的那条断言，外加一条同义的盘上检查。
 * @param {string} what
 * @returns {void}
 */
function assertNoFixtureLeftovers(what) {
  const dirs = leftoverDirs();
  assert.deepEqual(dirs, [], `${what}：仓根下不该留下夹具目录，实际 ${JSON.stringify(dirs)}`);
  const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const offending = porcelain.split('\n').filter((line) => line.includes(FIXTURE_PREFIX));
  assert.deepEqual(offending, [], `${what}：git status --porcelain 里不该有夹具文件，实际 ${JSON.stringify(offending)}`);
}

/** 判词是单行 stdout；取第一行匹配 pattern 的那条。
 * @param {string} stdout
 * @param {RegExp} pattern
 * @returns {string}
 */
function verdictLine(stdout, pattern) {
  const line = stdout.split('\n').find((candidate) => pattern.test(candidate));
  assert.ok(line, `判词里应有匹配 ${pattern} 的一行，实际 stdout=\n${stdout}`);
  return line;
}

/** 从判词里抠一个 `标签=<数字>MB` 读数。
 * @param {string} line
 * @param {string} label
 * @returns {number}
 */
function readingMb(line, label) {
  const match = new RegExp(`${label}=(\\d+)MB`).exec(line);
  assert.ok(match, `判词里应有 ${label}=<数字>MB 读数，实际：${line}`);
  return Number(match[1]);
}

// 每次跑完（无论成败）都看一眼残留：夹具在仓根，漏一个就会污染别人的 git status。
test('T1 受限：判据绿，且 RSS 峰值/墙钟由测试自己量出来', async () => {
  const run = await runCheck({}, []);
  assert.equal(run.status, 0, `判据应退出 0，实际 ${run.status}\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  const line = verdictLine(run.stdout, /vitest-heap-limit-check: PASS — 受限：/);
  const limitMb = readingMb(line, '上限');
  assert.equal(limitMb, 4352, `判词里的上限应是被钉的那个默认值，实际 ${line}`);
  const scriptPeakMb = readingMb(line, 'RSS 峰值');
  // 独立读数：脚本那棵树的峰值由测试自己采样，并与脚本自报的数交叉比对。
  assert.ok(
    run.peakMb <= limitMb * 1.5,
    `测试量到的整树 RSS 峰值 ${run.peakMb}MB 应 ≤ 1.5×${limitMb}MB；判词=${line}`,
  );
  assert.ok(
    run.peakMb >= limitMb,
    `测试量到的峰值 ${run.peakMb}MB 应至少达到上限 ${limitMb}MB（否则失控夹具根本没跑到上限，判据是空转的）`,
  );
  assert.ok(
    Math.abs(run.peakMb - scriptPeakMb) <= 512,
    `测试的峰值 ${run.peakMb}MB 与判词自报的 ${scriptPeakMb}MB 不该差出 512MB（两次量的该是同一棵树）`,
  );
  // AC1(d)：总墙钟 ≤ 30s —— 测试自己计时，脚本自报的墙钟也一并读出来比对。
  assert.ok(run.wallMs <= 30000, `整次判据的墙钟 ${run.wallMs}ms 应 ≤ 30000ms`);
  const scriptWallMs = Number(/墙钟=(\d+)ms/.exec(line)?.[1] ?? Number.NaN);
  assert.ok(scriptWallMs <= 30000, `判词自报的墙钟应为 ≤30000ms 的读数，实际 ${line}`);
  // 夹具自己的退场证据（脚本内部观测）必须被带进判词：退出码非 0 + 堆耗尽/worker 异常。
  assert.match(line, /退出码=1\b/, `判词应记下失控夹具的退出码 1：${line}`);
  assert.match(line, /堆耗尽证据=1/, `判词应记下堆耗尽证据：${line}`);
  // 正对照：约上限 30% 的良性夹具退出码 0，判词写出它读到的堆用量与上限。
  assert.match(line, /正对照（目标约上限 30%）退出码=0/, `判词应记下正对照绿：${line}`);
  assert.match(line, /worker 观测 4544MB=配置 4352MB\+192MB/, `判词应记下上限真的到达 worker：${line}`);
  assertNoFixtureLeftovers('T1 之后');
});

test('T2 未受限：判据红，且测试自己量到夹具越过了 3×参照上限', async () => {
  const run = await runCheck({ QUAY_VITEST_HEAP_MB: '1024' }, ['--falsify']);
  assert.equal(run.status, 1, `证伪模式应退出 1（红），实际 ${run.status}\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  const line = verdictLine(run.stdout, /vitest-heap-limit-check: FAIL — 未受限：/);
  assert.match(line, /没有到达 worker/, `判词应点名上限没到达 worker：${line}`);
  assert.match(line, /看门狗/, `判词应点名是脚本自己的看门狗收的场：${line}`);
  assert.match(line, /越过 3×1024=3072MB/, `判词应记下 3× 的越界读数：${line}`);
  // 独立读数：峰值必须真的越过 3×reference —— 判据的「未受限」不能只靠配置语言。
  assert.ok(
    run.peakMb >= 3072,
    `测试量到的整树 RSS 峰值 ${run.peakMb}MB 应越过 3×1024=3072MB，否则夹具没真的失控；判词=${line}`,
  );
  // 证伪形态必须与「受限」形态分得开：不许同时打印 PASS。
  assert.doesNotMatch(run.stdout, /PASS — 受限/, `证伪模式不该同时给出 PASS 判词：${run.stdout}`);
  assertNoFixtureLeftovers('T2 之后');
});

test('T3 良性误杀：上限太紧时判词点的是误杀，而不是受限', async () => {
  const run = await runCheck({ QUAY_VITEST_HEAP_MB: '64' }, []);
  assert.equal(run.status, 1, `良性误杀应退出 1，实际 ${run.status}\nstdout=${run.stdout}`);
  const line = verdictLine(run.stdout, /vitest-heap-limit-check: FAIL — 良性误杀：/);
  assert.match(line, /64MB 上限/, `判词应点名被观测的上限：${line}`);
  assert.doesNotMatch(run.stdout, /PASS/, `误杀这一支不该出现 PASS：${run.stdout}`);
  assertNoFixtureLeftovers('T3 之后');
});

test('T4 夹具残留：清理被跳过时判词被残留覆盖成 FAIL', async (t) => {
  // QUAY_HEAP_CHECK_SKIP_CLEANUP 是这条分支【唯一】可达的路径（判据文件里写着）；用它的时候
  // 测试自己负责把残留删掉 —— 否则这一条会污染后面所有用例的 git status 断言。
  t.after(() => {
    for (const name of leftoverDirs()) rmSync(path.join(REPO_ROOT, name), { recursive: true, force: true });
  });
  const run = await runCheck({ QUAY_VITEST_HEAP_MB: '64', QUAY_HEAP_CHECK_SKIP_CLEANUP: '1' }, []);
  assert.equal(run.status, 1, `残留应退出 1，实际 ${run.status}\nstdout=${run.stdout}`);
  const line = verdictLine(run.stdout, /vitest-heap-limit-check: FAIL — 夹具残留：/);
  assert.match(line, /夹具必须删/, `判词应说清为什么残留不算数：${line}`);
  // 分支是【真的】可达：盘上确实留下了夹具目录（不只是打印了一行）。
  const dirs = leftoverDirs();
  assert.equal(dirs.length, 1, `跳过清理后应留下恰好一个夹具目录，实际 ${JSON.stringify(dirs)}`);
  // 覆盖语义：先下的判词（这一轮是良性误杀）在前，残留那条在后并接管退出码。
  assert.match(run.stdout, /FAIL — 良性误杀：/, `被覆盖的判词也该在输出里：${run.stdout}`);
  const lines = run.stdout.split('\n').filter((candidate) => candidate.startsWith('vitest-heap-limit-check:'));
  assert.equal(lines.length, 2, `这一轮应有两条判词（被覆盖的那条 + 残留），实际 ${JSON.stringify(lines)}`);
  assert.match(lines[1] ?? '', /夹具残留/, `残留那条必须排在最后（它接管退出码）：${JSON.stringify(lines)}`);
});

// 信号路径：等它真的把夹具跑起来了再打，别打断在开工之前。
test('T5 信号路径：跑到一半收 SIGTERM，夹具照样清掉，不留孤儿 vitest', async () => {
  const run = await runCheck({ QUAY_VITEST_HEAP_MB: '1024' }, [], { killWhenFixturesRunning: true });
  // ⛔ 断言信号【真的送到了】：否则脚本可能自己跑完（exit 1），这一条就成了空转。
  // 143 是判据 trap 里的退出码（TERM），不是被打死的信号退出（那时 status 为 null、signal 非空）。
  assert.equal(run.signalled, true, `测试必须在夹具跑起来【之后】发信号，实际 never fired\nstdout=${run.stdout}`);
  assert.equal(run.status, 143, `判据应被 trap 以 143 收场，实际 status=${run.status} signal=${run.signal}\nstdout=${run.stdout}`);
  assert.equal(run.signal, null, `判据自己处理了 SIGTERM（trap），不该是被信号打死：${run.signal}`);
  assertNoFixtureLeftovers('T5 之后');
  // 孤儿：被杀的应该是【整组】，夹具的 vitest 不许在判据退出后还活着分配内存。
  let orphans = orphanFixtureProcesses();
  for (let attempt = 0; attempt < 60 && orphans.length > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    orphans = orphanFixtureProcesses();
  }
  assert.deepEqual(orphans, [], `信号路径不该留下夹具的 vitest 进程：${JSON.stringify(orphans)}`);
});

test('T6 收尾：整轮跑完，git status --porcelain 里没有夹具文件（AC4 明文）', () => {
  assertNoFixtureLeftovers('全部用例之后');
});

/** 还活着的、命令行里带着夹具目录名的进程（排除测试自己）。
 * @returns {string[]}
 */
function orphanFixtureProcesses() {
  /** @type {string[]} */
  const found = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8').replaceAll('\0', ' ');
      if (fixtureRunning(cmdline)) found.push(`${entry}: ${cmdline.slice(0, 200)}`);
    } catch {
      // 进程没了或没权限
    }
  }
  return found;
}
