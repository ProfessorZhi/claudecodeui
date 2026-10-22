#!/usr/bin/env bash
# vitest-heap-limit-check.sh — 判据：vitest worker 的 V8 堆上限（vitest.config.ts 的
# poolOptions.forks.execArgv）对【直接 npx vitest run】也生效：失控用例在秒级以堆耗尽失败，
# 而占用约 30% 上限的正常用例照样绿。
#
# 为什么需要它：cgroup 那一层（scripts/with-memory-cap.sh，默认 24G）只挂在 npm run test:client
# 与 scripts/test.sh 的 client 阶段；2026-09-25 那次事故正是【直接 npx vitest run】绕过了它
#（见 docs/operations/process-isolation-and-memory-caps.md）。配置层的上限对任何入口都生效，
# 这个脚本就是「它真的生效」的判据，而不是「配置里多了一行」。
#
# ⛔ 本脚本【绝不】用 with-memory-cap.sh，也【绝不】设 QUAY_MEMORY_MAX：它要证的正是
#    「不靠 cgroup 的那一层也拦得住」。两条通道叠在一起跑就什么都证不了，所以继承来的
#    QUAY_MEMORY_MAX 会在子进程环境里显式解除（否则读数未必是配置层的功劳）。
#    上限只管 JS 堆：Buffer/external/原生内存它看不见，那一路仍然只有 cgroup 兜着 ——
#    所以 with-memory-cap.sh 一个字都不许动（见 docs/operations/process-isolation-and-memory-caps.md）。
#
# 判词（stdout，单行，带全部读数与成因）：
#   vitest-heap-limit-check: PASS — 受限：…
#   vitest-heap-limit-check: FAIL — 未受限：…      （--falsify 的预期收场）
#   vitest-heap-limit-check: FAIL — 良性误杀：…    （上限把正常用例杀了）
#   vitest-heap-limit-check: FAIL — 夹具残留：…    （脚本自己的清理失败，覆盖上面一切）
# 退出码：PASS=0；FAIL=1；用法/自检错误=2。
#
# 夹具都是【临时】的，落在仓根下的 .vitest-heap-check.<pid>.<rand>/ 里，由 trap 清除
#（EXIT/INT/TERM/HUP 四条路径都清）。为什么是仓根而不是 src/ 或 /tmp：
#   · 不在 src/ 下 ⇒ 主套件（include: src/**）任何时刻都收不到它们，不会给别人染红；
#   · 在仓内 ⇒ 仓的 node_modules 可达，vitest/config 与 vitest.setup.ts 都能解析（/tmp 里不行）。
# 夹具要靠 vitest 的配置层生效，而仓的 include 只认 src/**；于是脚本在 scratch 目录里放一份
# 【派生配置】：它 import 仓的 vitest.config.ts（不是抄一份常量）再补上自己的 include。
# 上限因此只有一个来源 —— 改了仓里的配置，判据跟着变；把上限删掉，判据立刻红。
#
# 环境变量：
#   QUAY_VITEST_HEAP_MB   被观测的 vitest 上限（语义见 vitest.config.ts）。非 --falsify 时它就是
#                         判据的参照上限。--falsify 下它同时是【参照上限】（缺省 = 配置默认值），
#                         脚本随后把子进程的该变量强制成 off —— 「同一个上限，只是关掉」是两个
#                         分开的量，于是分支用例可以用一个小的参照上限廉价地跑。
#   QUAY_HEAP_CHECK_SKIP_CLEANUP=1  只给「夹具残留」判词分支留一条可达路径（见文末），不是生产开关。
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

CONFIG="$ROOT_DIR/vitest.config.ts"
FALSIFY=0
for arg in "$@"; do
  case "$arg" in
    --falsify) FALSIFY=1 ;;
    *) echo "usage: vitest-heap-limit-check.sh [--falsify]" >&2; exit 2 ;;
  esac
done

# ── 参照上限：唯一来源是仓里的配置 ───────────────────────────────────────────
# 从 vitest.config.ts 里【解析】默认值，而不是在这里抄一个 4352：抄一份就有两个真相，
# 配置改了脚本不会红（判据自己漂移）。解析不到就 fail-closed，别拿瞎猜的值继续跑。
DEFAULT_MB="$(sed -nE 's/^const DEFAULT_WORKER_HEAP_MB = ([0-9]+);.*$/\1/p' "$CONFIG" | head -1)"
case "$DEFAULT_MB" in
  ''|*[!0-9]*) echo "vitest-heap-limit-check: FAIL — 无法从 $CONFIG 解析 DEFAULT_WORKER_HEAP_MB（配置改名或改了写法？）" >&2; exit 2 ;;
esac

OVERRIDE_MB=""
case "${QUAY_VITEST_HEAP_MB:-}" in
  ''|off|0) : ;;
  *[!0-9]*) OVERRIDE_MB="$DEFAULT_MB" ;;
  *) OVERRIDE_MB="$QUAY_VITEST_HEAP_MB" ;;
esac
REF_MB="${OVERRIDE_MB:-$DEFAULT_MB}"

# 子进程看到的 QUAY_VITEST_HEAP_MB：受限跑 = 参照上限；--falsify = off（那就是被证伪的输入）。
if [ "$FALSIFY" = "1" ]; then CHILD_HEAP=off; else CHILD_HEAP="$REF_MB"; fi

# V8 的 heap_size_limit 比 --max-old-space-size 多出几个非 old-space。这里【实测】这个差额，
# 而不是写死一个 V8 内部常数（写死会让判据随 node 版本漂）：「上限是否真的到达 worker」比对的是
# worker 自己报出来的 heap_size_limit。
SLACK_MB="$(node --max-old-space-size=1000 -e 'process.stdout.write(String(Math.round(require("node:v8").getHeapStatistics().heap_size_limit/1048576) - 1000))' 2>/dev/null)"
case "$SLACK_MB" in
  ''|*[!0-9]*) echo "vitest-heap-limit-check: FAIL — 无法实测 V8 的 heap_size_limit 差额（node 不可用？）" >&2; exit 2 ;;
esac
EXPECT_LIMIT_MB=$((REF_MB + SLACK_MB))

RSS_BUDGET_MB=$(( REF_MB * 3 / 2 ))     # AC1(c)：整棵树的 RSS 峰值 ≤ 1.5 × 上限
WALL_BUDGET_MS=30000                     # AC1(d)：总墙钟 ≤ 30s
WATCHDOG_MB=$(( REF_MB * 3 ))            # --falsify：无上限的夹具越过 3× 上限即由本脚本杀掉
# 无上限的对照要能真的「无上限」：本机 node 自带的默认堆上限（4288MB）会替配置上限兜底，
# 那它就成了夹具真正的死因，判据也就没了观测面。所以对照跑把【node 自己的默认】抬开，
# 让「没有配置上限」这个前提成立 —— 抬的不是我们的上限（我们的上限是 off）。
UNBOUNDED_NODE_MB=$(( REF_MB * 4 ))

SCRATCH="$ROOT_DIR/.vitest-heap-check.$$.$RANDOM"
OUT_DIR="$SCRATCH/.out"
mkdir -p "$OUT_DIR" || exit 2
LOG_BENIGN="$OUT_DIR/benign.log"
LOG_RUNAWAY="$OUT_DIR/runaway.log"
RSS_BENIGN="$OUT_DIR/benign.rss"
RSS_RUNAWAY="$OUT_DIR/runaway.rss"
FIX_BENIGN="$OUT_DIR/benign.json"
FIX_RUNAWAY="$OUT_DIR/runaway.json"

cleanup() {
  # ⛔ 夹具必须清除，失败与信号路径都算（AC 明文）：这里只做删除，判词由 check_residue 下。
  [ "${QUAY_HEAP_CHECK_SKIP_CLEANUP:-}" = "1" ] || rm -rf "$SCRATCH"
}
# 被信号打断时，光删夹具不够：正在跑的那个 vitest 还在分配（证伪模式下是十几个 G），
# 必须连它一起收掉，否则这个脚本自己就成了内存事故。每组一个 session（见 run_case 的 setsid），
# 所以按【组】杀，一次收干净。
CURRENT_PGID=""
CURRENT_WATCHER=""
kill_current_group() {
  # 先停采样器：它下次写峰值文件时 scratch 可能已经没了（信号路径删得快），会往
  # stderr 扔一行 ENOENT —— 采样器的读数不该在收场时制造噪声。
  [ -n "$CURRENT_WATCHER" ] && { kill "$CURRENT_WATCHER" 2>/dev/null; CURRENT_WATCHER=""; }
  [ -n "$CURRENT_PGID" ] || return 0
  kill -s TERM -- "-$CURRENT_PGID" 2>/dev/null
  kill -s KILL -- "-$CURRENT_PGID" 2>/dev/null
  CURRENT_PGID=""
}
on_signal() { kill_current_group; cleanup; exit "$1"; }
trap 'cleanup' EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP

# ── 夹具与派生配置 ────────────────────────────────────────────────────────────
# 派生配置 import 仓的 vitest.config.ts —— 上限（以及它的一切）只有仓里那一个来源。
cat > "$SCRATCH/vitest.config.ts" <<'CFG'
import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../vitest.config';

// 只补 include：夹具不在 src/ 下，仓的 include 收不到它。mergeConfig 对数组是【拼接】，
// 于是仓的两条 include 原样保留，夹具那一条追加在后面 —— 仓的配置一个字都没被改写。
export default mergeConfig(base, defineConfig({ test: { include: ['__SCRATCH__/**/*.test.ts'] } }));
CFG
sed -i "s|__SCRATCH__|$(basename "$SCRATCH")|" "$SCRATCH/vitest.config.ts"

# 良性夹具：只吃上限的约 30%，必须仍然绿 —— 上限不许误杀正常用例（AC2 的正对照）。
cat > "$SCRATCH/benign.test.ts" <<'FIX'
import { writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { expect, test } from 'vitest';

// 模块级：文件跑完时它仍然可达，于是读数里【真的还留着】这一份。
const retained: number[][] = [];

test('benign fixture retains ~30% of the worker heap ceiling and passes', () => {
  const limitMb = Math.round(getHeapStatistics().heap_size_limit / 1048576);
  const targetMb = Math.floor(limitMb * 0.3);
  // 16MB 一块（2e6 个 double）：块数少、每块可预测，读数不必靠猜。
  const chunk = new Array(2_000_000).fill(1.5);
  while (retained.length * 16 < targetMb) retained.push(chunk.slice());
  const stats = getHeapStatistics();
  writeFileSync(
    process.env.QUAY_HEAP_FIXTURE_OUT ?? '/dev/null',
    JSON.stringify({
      heap_limit_mb: Math.round(stats.heap_size_limit / 1048576),
      used_heap_mb: Math.round(stats.used_heap_size / 1048576),
      target_mb: targetMb,
      retained_mb: retained.length * 16,
    }),
  );
  expect(retained.length).toBeGreaterThan(0);
});
FIX

# 失控夹具：不断保留对象，无上限。自己先报出 worker 观测到的 heap_size_limit ——
# 「配置的上限是否真的到达 worker」只有 worker 自己说得清，比任何间接读数都直接。
cat > "$SCRATCH/runaway.test.ts" <<'FIX'
import { writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { test } from 'vitest';

test('runaway fixture retains objects without bound', () => {
  writeFileSync(
    process.env.QUAY_HEAP_FIXTURE_OUT ?? '/dev/null',
    JSON.stringify({ heap_limit_mb: Math.round(getHeapStatistics().heap_size_limit / 1048576) }),
  );
  const held: unknown[] = [];
  for (;;) held.push(new Array(250_000).fill(7));
});
FIX

# ── /proc 采样的整树 RSS 峰值 + 看门狗 ───────────────────────────────────────
# AC1(c) 要的是【整个进程树】的 RSS 峰值：npx → vitest 主进程 → forked worker 都在树里，
# 只量 worker 会漏掉 vitest 自己那几百兆，读数就不可比。所以每次采样遍历一次后代。
tree_rss_kb() {
  local queue="$1" next p r tot=0 seen=""
  while [ -n "$queue" ]; do
    next=""
    for p in $queue; do
      case " $seen " in *" $p "*) continue ;; esac
      seen="$seen $p"
      r="$(awk '/^VmRSS:/{print $2}' "/proc/$p/status" 2>/dev/null)"
      if [ -n "$r" ]; then tot=$((tot + r)); fi
      next="$next $(cat "/proc/$p/task/$p/children" 2>/dev/null)"
    done
    queue="$next"
  done
  printf '%s' "$tot"
}

kill_tree() {
  local c
  for c in $(cat "/proc/$1/task/$1/children" 2>/dev/null); do
    kill_tree "$c"
    kill -s KILL "$c" 2>/dev/null
  done
}

# watch <pid> <outfile> <budget_mb|->：每 50ms 记一次整树 RSS 峰值；
# 给了 budget 且越过它 ⇒ 杀掉整棵树，并把 budget_killed=1 写进 outfile。
watch() {
  local pid="$1" out="$2" budget="$3" peak=0 tot
  while kill -0 "$pid" 2>/dev/null; do
    tot="$(tree_rss_kb "$pid")"
    if [ -n "$tot" ] && [ "$tot" -gt "$peak" ]; then peak="$tot"; fi
    if [ "$budget" != "-" ] && [ "$peak" -gt $(( budget * 1024 )) ]; then
      { printf 'peak_kb=%s budget_killed=1\n' "$peak"; } > "$out" 2>/dev/null
      kill_tree "$pid"
      kill -s KILL "$pid" 2>/dev/null
      return 0
    fi
    sleep 0.05
  done
  { printf 'peak_kb=%s budget_killed=0\n' "$peak"; } > "$out" 2>/dev/null
}

# 一次 vitest 调用。⛔ 直接 npx vitest run：不经 with-memory-cap.sh（AC 明文）。
# VITEST_ENV 里的两个 -u 显式解除 cgroup 夹取与外部上限：实验的前提就是这两层不在场。
VITEST_ENV=(-u QUAY_MEMORY_MAX -u QUAY_VITEST_HEAP_MB)
# setsid：给每次调用一个自己的 session/进程组，好让信号路径一次收掉整组（缺 setsid 就直接跑）。
SETSID=()
command -v setsid >/dev/null 2>&1 && SETSID=(setsid)
declare -a VITEST_CMD=()
make_cmd() {
  VITEST_CMD=(npx vitest run --config "$SCRATCH/vitest.config.ts" --logHeapUsage --reporter=basic "$1")
}

VITEST_RC=0
VITEST_WALL_MS=0
# run_case <fixture-out> <log> <rss-out> <budget_mb|-> <env...> -- <program...>
# 前 4 个之后、`--` 之前的都是 env 的参数/赋值（`-u NAME` 解除变量、`K=V` 赋值）。
run_case() {
  local fixture_out="$1" log="$2" rss_out="$3" budget="$4"; shift 4
  local -a envs=()
  local seen_assign=0
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    # coreutils 的 env 在第一个 K=V 之后就不再解析选项：把 -u 之类放到赋值后面，
    # env 会把那个 -u 当成【程序名】而以 127 收场 —— 那是脚本自己的用法错误，
    # 不是判据的成分，所以这里当场 fail-closed，别让它伪装成一条判词。
    case "$1" in
      -*) [ "$seen_assign" = "0" ] || { echo "vitest-heap-limit-check: FAIL — 用法错误：env 的选项（$1）排在赋值之后，env 会把它当成程序名（见 coreutils env）" >&2; exit 2; } ;;
      *=*) seen_assign=1 ;;
    esac
    envs+=("$1"); shift
  done
  [ "${1:-}" = "--" ] && shift
  local start end pid watcher
  start=$(date +%s%N)
  # 注意：这里不能写 `env … -- prog`。coreutils 的 env 在遇到第一个赋值（K=V）后就停止解析选项，
  # 后面的 `--` 会被当成【程序名】而 127。赋值之后直接给程序名即可。
  "${SETSID[@]}" env "${envs[@]}" "QUAY_HEAP_FIXTURE_OUT=$fixture_out" "$@" >"$log" 2>&1 &
  pid=$!
  CURRENT_PGID="$pid"
  watch "$pid" "$rss_out" "$budget" &
  watcher=$!
  CURRENT_WATCHER="$watcher"
  # 看门狗把整棵树 kill 掉时 bash 会往自己的 stderr 打一行 "Killed"（作业状态报告）：
  # 那条噪声会混进调用方的输出里，而判词在 stdout —— 这里把 wait 那一段的 stderr 收掉。
  { wait "$pid"; VITEST_RC=$?; } 2>/dev/null
  wait "$watcher" 2>/dev/null
  # 收掉指针：下一次调用之前若来信号，别拿一个已经没了的 pid/pgid 去杀（pid 复用）。
  CURRENT_PGID=""
  CURRENT_WATCHER=""
  end=$(date +%s%N)
  VITEST_WALL_MS=$(( (end - start) / 1000000 ))
}

# 夹具自报的 JSON 读数：读不出就输出空串（判词里写作「无读数」）。
json_num() {
  node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]))}catch{process.stdout.write("")}' "$1" "$2"
}
peak_mb() { grep -oE 'peak_kb=[0-9]+' "$1" | grep -oE '[0-9]+' | awk '{printf "%d", $1/1024}'; }
budget_killed() { grep -qE 'budget_killed=1' "$1" && printf '1' || printf '0'; }

# ── 夹具残留（脚本自己的清理） ────────────────────────────────────────────────
# 夹具还在的话，任何判词都不能算数：下一次运行会被上一次的残留污染，git status 里多出来的
# 东西还会被当成别人的未跟踪文件。所以它【覆盖】一切判词，每条退出路径都要过它。
# 这里显式清一次再断言（trap 里那次要等进程真正退出才跑，而断言必须在那之前看见结果）；
# QUAY_HEAP_CHECK_SKIP_CLEANUP=1 让显式清理与 trap 一起跳过，这条判词才可达 —— 测试用它，
# 生产不要用（没有它这条分支永远观测不到，一个「永不触发」的分支比没有还坏）。
check_residue() {
  cleanup
  if [ -e "$SCRATCH" ]; then
    printf 'vitest-heap-limit-check: FAIL — 夹具残留：%s 在脚本结束后仍然存在（显式清理与 trap 都没清掉它，QUAY_HEAP_CHECK_SKIP_CLEANUP=%s）；夹具必须删，失败路径与信号路径都要删\n' \
      "$SCRATCH" "${QUAY_HEAP_CHECK_SKIP_CLEANUP:-unset}"
    exit 1
  fi
}
verdict_fail() { printf 'vitest-heap-limit-check: FAIL — %s\n' "$1"; check_residue; exit 1; }

# ── 正对照：良性夹具（AC2） ──────────────────────────────────────────────────
# 正对照【总是】在参照上限下跑（--falsify 也一样）：它要证的是「同样的夹具、同样的上限，
# 正常用例不会被打死」，于是判据的观测面不是空的；证伪模式只改【失控】那一次的输入。
make_cmd "$SCRATCH/benign.test.ts"
run_case "$FIX_BENIGN" "$LOG_BENIGN" "$RSS_BENIGN" - \
  "${VITEST_ENV[@]}" "QUAY_VITEST_HEAP_MB=$REF_MB" -- "${VITEST_CMD[@]}"
BENIGN_LIMIT="$(json_num "$FIX_BENIGN" heap_limit_mb)"
BENIGN_USED="$(json_num "$FIX_BENIGN" used_heap_mb)"
BENIGN_RETAINED="$(json_num "$FIX_BENIGN" retained_mb)"
BENIGN_LOGGED="$(grep -oE '[0-9]+ MB heap used' "$LOG_BENIGN" | tail -1 | grep -oE '^[0-9]+')"
[ -n "$BENIGN_LOGGED" ] || BENIGN_LOGGED="无"

benign_why=""
[ "$VITEST_RC" = "0" ] || benign_why="退出码=$VITEST_RC（应为 0）"
[ "$BENIGN_LIMIT" = "$EXPECT_LIMIT_MB" ] || benign_why="$benign_why worker 观测堆上限=${BENIGN_LIMIT:-无读数}MB≠${EXPECT_LIMIT_MB}MB（= 配置上限 ${REF_MB}MB + ${SLACK_MB}MB）"
if [ -n "$BENIGN_USED" ]; then
  [ "$BENIGN_USED" -ge $(( REF_MB * 20 / 100 )) ] || benign_why="$benign_why 堆用量 ${BENIGN_USED}MB 太小，证明不了它真的占了约 30%"
  [ "$BENIGN_USED" -le $(( REF_MB * 60 / 100 )) ] || benign_why="$benign_why 堆用量 ${BENIGN_USED}MB 贴上上限了"
else
  benign_why="$benign_why 夹具没报出堆用量（它没跑完？）"
fi
if [ -n "$benign_why" ]; then
  verdict_fail "良性误杀：良性夹具（目标约上限 30%）在 ${REF_MB}MB 上限下没有正常收场 ——${benign_why}；实测 退出码=${VITEST_RC} 堆用量=${BENIGN_USED:-无读数}MB（--logHeapUsage 读到 ${BENIGN_LOGGED}MB）保留=${BENIGN_RETAINED:-无读数}MB worker 观测上限=${BENIGN_LIMIT:-无读数}MB 墙钟=${VITEST_WALL_MS}ms。上限太紧 ⇒ 正常用例会被它误杀"
fi

# ── 失控夹具（AC1 / AC3） ────────────────────────────────────────────────────
make_cmd "$SCRATCH/runaway.test.ts"
if [ "$FALSIFY" = "1" ]; then
  # 「关掉配置上限」这个输入：QUAY_VITEST_HEAP_MB=off 交给子进程，同时把 node 自带的默认值
  # 抬开，让「无上限」这个前提真的成立（见 UNBOUNDED_NODE_MB 处的说明）。
  run_case "$FIX_RUNAWAY" "$LOG_RUNAWAY" "$RSS_RUNAWAY" "$WATCHDOG_MB" \
    -u NODE_OPTIONS "${VITEST_ENV[@]}" "QUAY_VITEST_HEAP_MB=$CHILD_HEAP" \
    "NODE_OPTIONS=--max-old-space-size=$UNBOUNDED_NODE_MB" -- "${VITEST_CMD[@]}"
else
  run_case "$FIX_RUNAWAY" "$LOG_RUNAWAY" "$RSS_RUNAWAY" - \
    "${VITEST_ENV[@]}" "QUAY_VITEST_HEAP_MB=$CHILD_HEAP" -- "${VITEST_CMD[@]}"
fi
RSS_MB="$(peak_mb "$RSS_RUNAWAY")"
BUDGET_KILLED="$(budget_killed "$RSS_RUNAWAY")"
RUNAWAY_LIMIT="$(json_num "$FIX_RUNAWAY" heap_limit_mb)"
HEAP_EVIDENCE=0
grep -qE 'JavaScript heap out of memory|Reached heap limit|Ineffective mark-compacts near heap limit' "$LOG_RUNAWAY" && HEAP_EVIDENCE=1
WORKER_EVIDENCE=0
grep -qE 'ERR_IPC_CHANNEL_CLOSED|Channel closed|[Ww]orker.*(exited|terminated)' "$LOG_RUNAWAY" && WORKER_EVIDENCE=1

if [ "$FALSIFY" = "1" ]; then
  # 证伪模式：【期望】判据红，红的根据是「配置的上限根本没到达 worker」—— 夹具不是被我们配的
  # 那一条收场的，所以判据在「没有配置上限」这个输入下红，正是它该有的行为。
  if [ "$RUNAWAY_LIMIT" = "$EXPECT_LIMIT_MB" ]; then
    verdict_fail "未受限的证伪没有成立：QUAY_VITEST_HEAP_MB=off 之后 worker 仍观测到 ${RUNAWAY_LIMIT}MB 堆上限（= 配置上限 ${REF_MB}MB + ${SLACK_MB}MB）——判据在这个输入下没有观测面，证不了它会在没有上限时红"
  fi
  KILL_NOTE="由本脚本的看门狗在该处杀掉"
  [ "$BUDGET_KILLED" = "1" ] || KILL_NOTE="看门狗 ${WATCHDOG_MB}MB 未触发，由别处的上限收场"
  printf 'vitest-heap-limit-check: FAIL — 未受限：QUAY_VITEST_HEAP_MB=off 时配置上限 %sMB 没有到达 worker（worker 观测堆上限=%sMB，有上限时应为 %sMB=配置+%sMB），失控夹具越过 3×%s=%sMB，%s；RSS 峰值=%sMB 墙钟=%sms 退出码=%s\n' \
    "$REF_MB" "${RUNAWAY_LIMIT:-无读数}" "$EXPECT_LIMIT_MB" "$SLACK_MB" \
    "$REF_MB" "$WATCHDOG_MB" "$KILL_NOTE" "$RSS_MB" "$VITEST_WALL_MS" "$VITEST_RC"
  exit 1
fi

fail_why=""
[ "$VITEST_RC" != "0" ] || fail_why="vitest 退出码是 0（失控夹具居然跑完了）"
[ "$HEAP_EVIDENCE" = "1" ] || [ "$WORKER_EVIDENCE" = "1" ] || fail_why="$fail_why 输出里没有堆耗尽/worker 异常退出的证据"
[ "$RUNAWAY_LIMIT" = "$EXPECT_LIMIT_MB" ] || fail_why="$fail_why worker 观测堆上限=${RUNAWAY_LIMIT:-无读数}MB≠${EXPECT_LIMIT_MB}MB（配置上限没到达 worker）"
[ "$RSS_MB" -le "$RSS_BUDGET_MB" ] || fail_why="$fail_why RSS 峰值=${RSS_MB}MB>1.5×${REF_MB}=${RSS_BUDGET_MB}MB"
[ "$VITEST_WALL_MS" -le "$WALL_BUDGET_MS" ] || fail_why="$fail_why 墙钟=${VITEST_WALL_MS}ms>${WALL_BUDGET_MS}ms"
if [ -n "$fail_why" ]; then
  verdict_fail "受限不成立：${fail_why}；实测 退出码=${VITEST_RC} 堆耗尽证据=${HEAP_EVIDENCE} worker异常证据=${WORKER_EVIDENCE} worker观测上限=${RUNAWAY_LIMIT:-无读数}MB RSS峰值=${RSS_MB}MB 墙钟=${VITEST_WALL_MS}ms 上限=${REF_MB}MB 通道=直接 npx vitest run（memcap=unset）"
fi

printf 'vitest-heap-limit-check: PASS — 受限：直接 npx vitest run（memcap=unset）下失控夹具退出码=%s、墙钟=%sms、堆耗尽证据=%s、整树 RSS 峰值=%sMB≤1.5×%sMB；正对照（目标约上限 30%%）退出码=0，读到的堆用量=%sMB（--logHeapUsage %sMB）上限=%sMB（worker 观测 %sMB=配置 %sMB+%sMB）；上限来源=vitest.config.ts\n' \
  "$VITEST_RC" "$VITEST_WALL_MS" "$HEAP_EVIDENCE" "$RSS_MB" "$RSS_BUDGET_MB" \
  "$BENIGN_USED" "$BENIGN_LOGGED" "$REF_MB" "$BENIGN_LIMIT" "$REF_MB" "$SLACK_MB"

# 判定已经下过（PASS）；再走一遍每条退出路径都要过的残留检查，然后正常收场。
check_residue
