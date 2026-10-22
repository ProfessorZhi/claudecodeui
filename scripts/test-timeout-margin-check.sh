#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/test-timeout-margin-check.sh — 「冷编译不得挤进用例预算」的确定性判据
# （tasks/gap-resetmodules-cold-compile-timeout.md 建立；tasks/gap-margin-check-family-blind-spot.md 把射程
#  从「机制代理」改成本判据自己断言的不变量）
#
# 判据形态：**余量**，不是红绿。
#   对射程内每个 client 测试文件取最慢**用例**耗时 T_max，与该文件适用的 testTimeout 预算 B 比较：
#       T_max ≤ B / K
#   余量读数是**确定性**的（不依赖机器是否繁忙）—— 这正是它相对 suite-concurrency-check.sh
#   （只在负载下才红、15 次里红 1–2 次）的价值所在。
#
# ⛔ 射程（scope）必须是判据自己断言的**不变量**，不得是观测到的**机制代理**。
#   本判据断言的不变量是「**每一个** client 测试文件的 T_max ≤ B/K」。改宽之前它派生的「族」是
#   `resetModules` ∧ 用例内动态 `import(` —— 那是**机制的必要条件集合**，不是这段断言的主语。
#   2026-09-21T06:22Z AC-103 条件①判红时，本判据在同一棵树上**绿着**：越界的
#   src/modules/sidebar/tests/sessionFilterEditor.test.tsx 有「用例体内 await import()」而**没有**
#   `resetModules`，恰好落在那个代理条件的射程外。`resetModules` 只决定冷编译要不要**每个**用例
#   重付；真正让**第一个**到达该 import 的用例付整张模块图冷编译的，是有没有「用例体内动态 import」。
#   ⇒ 射程改为**全树 client 测试文件**（`src/**/*.test.ts(x)`，与 vitest.config.ts 的 include 同集），
#     被检查文件数 13 → 73；机制族派生**保留但只作诊断**（打印哪些文件属于它），不再参与射程。
#
# B 的来源：**从 vitest.config.ts 里显式声明的 testTimeout 读**，并且把「这个 B 是哪来的」原样打进
#   判词（`B=5000ms(来源：vitest.config.ts 显式 testTimeout)`）。这样「把 B 抬上去」就不再是一条
#   静默的逃逸路径：抬 B 会出现在判词里。
#
# 为什么 config 里没声明时**不** fail-closed，而是用一个**标注过的**默认值继续判：
#   本判据的职责是在**改之前**就把红观测出来（AC1 要求「当前树上非零退出，且同一行打印最差文件的
#   T_max / B / 比值 / 1/K」）。而改之前这棵树恰恰就是「config 里没有 testTimeout」的状态 —— 那时
#   fail-closed 会让脚本连一行余量读数都给不出，判据就退化成「配置没写」这一件事，而不是它要量的
#   那件事。所以：缺声明 ⇒ 用 vitest 官方默认并**在判词里标注来源**（不是隐式假定）；只有「config
#   不可读」或「声明了多个不同的值」这种语义不明的状态才 fail-closed。
DEFAULT_TEST_TIMEOUT_MS=5000   # vitest 未声明 testTimeout 时的官方默认（v1 起至今）
#
# 取数方式：**一次**全量 client 套件（`npx vitest run --reporter=json`）收全量逐用例耗时。
#   ⛔ 逐文件串行 spawn 73 次不在 gate 预算内（AC3：墙钟 ≤ 60s；实测一次性收集 ≈30s）。一次收集还有个
#     更强的好处：射程里**每个**文件都必须在同一份报告里有对应条目，否则 fail-closed —— 射程与读数
#     不可能各说各话。
#
# K 的取值（K_DEFAULT）：由实测的 T_max 分布钉死，见 K_DEFAULT 处注释。
#
# 退出码：0 余量达标；1 余量不足 / 读数不可得（fail-closed）；2 用法错误。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# 上限倍数 K：要求 T_max ≤ B / K。
# 实测分布（B = 5000ms）——
#   修 gap-resetmodules-cold-compile-timeout 之前，付冷编译的 3 个文件 T_max = 2717–2955ms
#   （比值 0.543–0.603），其余文件 ≤ 155ms（比值 ≤ 0.031）；
#   修好那 3 个之后，全树（73 个 client 文件，2026-09-21 改宽射程时实测）剩下的上簇是
#   src/modules/sidebar/tests/sessionFilterEditor.test.tsx 的 1920ms（比值 0.384），
#   下簇 ≤ 276ms（比值 ≤ 0.055）。
#   取 K=4 ⇒ 阈值 1250ms：仍落在两簇之间的空档里（修好后上簇 1920ms 的 65%… 见下），
# 修好该文件后全树下簇 ≤ 276ms、最差比值 0.055 —— 对阈值留 4.5× 判别余量。
# 与姊妹脚本 scripts/suite-concurrency-check.sh 的 K_RATIO=4 同值（同一条纪律：分布数据出来之前不设阈值）。
K_DEFAULT="${TFMC_K:-4}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

K_RATIO="$K_DEFAULT"
LIST_ONLY=0
EXTRA_FILES=()
# 一次性收集的墙钟上限：只用来把「挂死」变成结构性事实（GNU timeout 退出 124）而不是静默超时。
COLLECT_TIMEOUT_SECS="${TFMC_COLLECT_TIMEOUT:-300}"

usage() {
  cat <<'USAGE'
usage: bash scripts/test-timeout-margin-check.sh [options]

  无参运行 = 判据形态：一次性跑全量 client 套件收全量逐用例耗时，断言**每一个**
  src/**/*.test.ts(x) 的 T_max ≤ B / K（射程 = 不变量本身，不是机制族）。

  --k <ratio>        上限倍数 K（默认 4；**越大越严**：阈值是 B/K）
  --list             只打印射程内的文件清单（机制族成员带 [family] 标记）后退出（不跑任何套件）
  --file <path>      **收窄**射程到给定 vitest 过滤器（诊断用；可重复）。给定时判词会标明
                     scope=restricted —— 全树形态（无 --file）才是判据形态。
  -h, --help         本帮助

环境变量：TFMC_K（= --k）、TFMC_COLLECT_TIMEOUT（一次性收集的墙钟上限秒，默认 300）
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --k)            K_RATIO="${2:-}"; shift 2 ;;
    --k=*)          K_RATIO="${1#*=}"; shift ;;
    --list)         LIST_ONLY=1; shift ;;
    --file)         EXTRA_FILES+=("${2:-}"); shift 2 ;;
    --file=*)       EXTRA_FILES+=("${1#*=}"); shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "test-timeout-margin-check: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$K_RATIO" in ''|*[!0-9.]*) echo "test-timeout-margin-check: --k must be a number, got '$K_RATIO'" >&2; exit 2 ;; esac
# 0/负数 K 会让阈值失真（1/K 无意义或反向），显式拒掉。
if ! awk -v k="$K_RATIO" 'BEGIN { exit !(k > 0) }'; then
  echo "test-timeout-margin-check: --k must be > 0, got '$K_RATIO'" >&2; exit 2
fi
case "$COLLECT_TIMEOUT_SECS" in ''|*[!0-9]*|0) COLLECT_TIMEOUT_SECS=300 ;; esac

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1 && timeout --version 2>&1 | grep -qi gnu; then
  TIMEOUT_BIN="$(command -v timeout)"
fi

# ── 预算 B：只认 vitest.config.ts 里**显式声明**的 testTimeout ───────────────
# 行首（允许缩进）就是 `testTimeout:` 才算；注释里的提及（`// testTimeout: …`）匹配不上。
# -> stdout: "<B>\t<来源说明>"；config 不可读 / 声明了多个不同的值 ⇒ 返回非零（语义不明）。
read_budget() {
  local cfg="$ROOT_DIR/vitest.config.ts" vals n
  [ -f "$cfg" ] || return 1
  vals="$(grep -E '^[[:space:]]*testTimeout[[:space:]]*:' "$cfg" 2>/dev/null \
    | sed -E 's/.*testTimeout[[:space:]]*:[[:space:]]*([0-9]+).*/\1/' \
    | grep -E '^[0-9]+$' | sort -u)"
  n="$(printf '%s\n' "$vals" | grep -c . || true)"
  case "$n" in
    # 末尾必须带换行：`read` 在 EOF 且缺定界符时返回非零，会把已经读到的值当成失败丢掉。
    1) printf '%s\t%s\n' "$vals" "vitest.config.ts 显式 testTimeout" ;;
    0) printf '%s\t%s\n' "$DEFAULT_TEST_TIMEOUT_MS" "vitest 默认值（vitest.config.ts 未声明 testTimeout）" ;;
    *) return 1 ;;   # 多个不同的声明值：哪个是预算，脚本无从判断
  esac
}

budget_line="$(read_budget)"
BUDGET="$(printf '%s' "$budget_line" | cut -f1)"
budget_src="$(printf '%s' "$budget_line" | cut -f2)"
if [ "$LIST_ONLY" != "1" ] && [ -z "$BUDGET" ]; then
  printf 'test-timeout-margin-check: FAIL — vitest.config.ts 里的 testTimeout 语义不明（不可读，或声明了多个不同的值）⇒ B 不可得 ⇒ 判据不可判（fail-closed）\n'
  exit 1
fi

# hookTimeout 只**报告**，不参与判定：它是 beforeAll 预热那笔冷编译所在的预算（见
# vitest.config.ts 的注释）。把它打出来是为了让「预热那笔账」可见 —— 本判据量的是**用例**
# 余量（确定性），而 file_ms 与 hookTimeout 的关系是负载敏感的，不能拿来做阈值。
read_hook_timeout() {
  local cfg="$ROOT_DIR/vitest.config.ts" v
  [ -f "$cfg" ] || return 0
  v="$(grep -E '^[[:space:]]*hookTimeout[[:space:]]*:' "$cfg" 2>/dev/null \
    | sed -E 's/.*hookTimeout[[:space:]]*:[[:space:]]*([0-9]+).*/\1/' \
    | grep -E '^[0-9]+$' | sort -u | head -1)"
  printf '%s' "${v:-未声明}"
}
HOOK_TIMEOUT="$(read_hook_timeout)"

# ── 射程 = 不变量：**每一个** client 测试文件 ────────────────────────────────
# 与 vitest.config.ts 的 `include: ['src/**/*.test.ts', 'src/**/*.test.tsx']` 同集（`**` 可匹配零段
# 目录，故与下面的 find 等价）。判据断言的是「每个文件 T_max ≤ B/K」，射程就必须是「每个文件」。
SCOPE=()
while IFS= read -r f; do
  [ -f "$f" ] || continue
  SCOPE+=("$f")
done < <(find src \( -name '*.test.ts' -o -name '*.test.tsx' \) ! -path '*/node_modules/*' 2>/dev/null | sort)

# ── 机制族（**仅诊断**，不参与射程）：resetModules 与用例内动态 import 同时出现 ──
# 这是 gap-resetmodules-cold-compile-timeout 观测到的那个机制形态。它对当时修掉的 3 个文件是对的，
# 但它是一个**代理条件**：同机制的「有动态 import、无 resetModules」形态落在它之外。故它现在只被
# 打印、不决定判据看谁。
is_family() {
  local f="$1"
  [ -f "$f" ] || return 1
  grep -qE 'vi\.[[:space:]]*resetModules|resetModules\(' "$f" || return 1
  grep -qE '(await[[:space:]]+)?import[[:space:]]*\(' "$f" || return 1
  return 0
}
FAMILY=()
for f in "${SCOPE[@]+"${SCOPE[@]}"}"; do
  is_family "$f" && FAMILY+=("$f")
done

# --file 收窄：把射程换成给定的 vitest 过滤器（诊断形态）。全树形态才是判据形态。
RESTRICTED=0
if [ ${#EXTRA_FILES[@]} -gt 0 ]; then
  RESTRICTED=1
  SCOPE=("${EXTRA_FILES[@]}")
fi

if [ ${#SCOPE[@]} -eq 0 ]; then
  printf 'test-timeout-margin-check: FAIL — 射程为空（判据没看任何东西；fail-closed）\n'
  exit 1
fi

if [ "$LIST_ONLY" = "1" ]; then
  for f in "${SCOPE[@]}"; do
    if is_family "$f"; then echo "$f	[family]"; else echo "$f	[invariant-scope]"; fi
  done
  echo "# scope=${#SCOPE[@]} files ｜ mechanism family(diagnostic only)=${#FAMILY[@]} files"
  exit 0
fi

LOG_DIR="${TFMC_LOG_DIR:-$ROOT_DIR/.quay/test-timeout-margin-check}"
RUN_DIR="$LOG_DIR/$(date +%Y%m%dT%H%M%S)-$$"
mkdir -p "$RUN_DIR" || { echo "test-timeout-margin-check: FAIL — cannot create log dir $RUN_DIR" >&2; exit 1; }

threshold="$(awk -v k="$K_RATIO" 'BEGIN { printf "%.3f", 1 / k }')"

scope_desc="ALL client test files（不变量射程）"
scope_label="全树"
if [ "$RESTRICTED" = "1" ]; then
  scope_desc="restricted（--file 收窄；非判据形态）"
  scope_label="收窄射程"
fi

scopelist="$RUN_DIR/scope.txt"
printf '%s\n' "${SCOPE[@]}" >"$scopelist"

echo "test-timeout-margin-check: root=$ROOT_DIR"
echo "test-timeout-margin-check: scope=${#SCOPE[@]} files（$scope_desc）｜ 机制族(仅诊断)=${#FAMILY[@]} files ｜ B=${BUDGET}ms（来源：${budget_src}）｜ K=$K_RATIO ⇒ 阈值 1/K=$threshold ｜ 一次性收集 ｜ logs=$RUN_DIR"
echo "test-timeout-margin-check: hookTimeout=${HOOK_TIMEOUT}ms（仅报告：预热那笔冷编译的预算；本判据只判用例余量）"
echo "test-timeout-margin-check: host cores=$(nproc 2>/dev/null || echo '?') load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo '?')"

# ── 一次性收集：全量 client 套件一份 JSON（含每个用例的 duration）────────────────
json="$RUN_DIR/vitest-client.json"
log="$RUN_DIR/vitest-client.out"
collect_start=$(date +%s%N)
rc=0
if [ -n "$TIMEOUT_BIN" ]; then
  "$TIMEOUT_BIN" --signal=TERM --kill-after=10 "$COLLECT_TIMEOUT_SECS" \
    npx vitest run --reporter=json --outputFile="$json" ${EXTRA_FILES[@]+"${EXTRA_FILES[@]}"} >"$log" 2>&1 || rc=$?
else
  npx vitest run --reporter=json --outputFile="$json" ${EXTRA_FILES[@]+"${EXTRA_FILES[@]}"} >"$log" 2>&1 || rc=$?
fi
collect_ms=$(( ( $(date +%s%N) - collect_start ) / 1000000 ))

# 套件自身红不算本判据的红（那是别的判据的射程）；但**读数不可得**算 —— 见下。
echo "test-timeout-margin-check: collect rc=$rc wall=${collect_ms}ms（npx vitest run --reporter=json，一次收全量逐用例耗时）"

# 逐文件行：<abs-or-rel path>\t<T_max>\t<最慢用例标题>\t<failed>\t<n>\t<file_ms>
# ⛔ 必须 IFS=$'\t' 读：node 那侧是制表符分隔，而用例名里带空格 —— 用默认 IFS 会把标题切成好几段、
# 把后面的字段整体错位（错位出来的 nfailed 是文字，判据会静默失灵）。
rows_tsv=""
rows_tsv="$(node -e '
  const fs = require("fs");
  let r;
  try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(1); }
  const out = [];
  for (const t of r.testResults || []) {
    let max = 0, title = "(none)", failed = 0, n = 0;
    for (const a of t.assertionResults || []) {
      n += 1;
      if (a.status === "failed") failed += 1;
      if ((a.duration || 0) > max) { max = a.duration; title = a.title; }
    }
    out.push([String(t.name || ""), Math.round(max), String(title).replace(/\s+/g, " ").slice(0, 58), failed, n, Math.round((t.endTime || 0) - (t.startTime || 0))].join("\t"));
  }
  process.stdout.write(out.join("\n"));
' "$json" 2>/dev/null)" || rows_tsv=""

if [ -z "$rows_tsv" ]; then
  printf 'test-timeout-margin-check: FAIL — 一次性收集的 JSON 报告不可读/为空（rc=%s，日志 %s）⇒ 全树余量不可判（fail-closed）\n' "$rc" "$log"
  exit 1
fi

# 报告里出现的文件：用「路径后缀相等」匹配，因为 reporter 给的是绝对路径而射程是相对路径。
reported="$RUN_DIR/reported.txt"
printf '%s\n' "$rows_tsv" | cut -f1 | sort -u >"$reported"

# worst_* 记「比值最大的那个文件」——红蓝两条分支都用它出判词。
worst_file=""; worst_tmax=""; worst_ratio=""; worst_note=""
worst_src=""
n_ok=0; n_bad=0; bad_rows=""
missing=""

while IFS= read -r f; do
  [ -f "$f" ] || continue
  abs="$ROOT_DIR/$f"
  row="$(printf '%s\n' "$rows_tsv" | awk -F'\t' -v a="$abs" -v r="$f" '$1 == a || $1 == r { print; exit }')"
  if [ -z "$row" ]; then
    # 射程里有、报告里没有 ⇒ 「量不到」比「量到超标」更坏，判词必须指向它而不是某个有数字的文件。
    n_bad=$(( n_bad + 1 ))
    missing="$missing $f"
    bad_rows="$bad_rows
test-timeout-margin-check: file=$f status=UNREADABLE T_max=n/a（该文件在一次性收集的报告里没有条目 ⇒ 射程与读数不一致，无从判余量；日志 $log）"
    worst_file="$f"; worst_tmax="n/a"; worst_ratio="n/a"; worst_note="UNREADABLE(no report entry)"; worst_src=""
    continue
  fi
  tmax="$(printf '%s' "$row" | cut -f2)"
  title="$(printf '%s' "$row" | cut -f3)"
  nfailed="$(printf '%s' "$row" | cut -f4)"
  ntests="$(printf '%s' "$row" | cut -f5)"
  fl_ms="$(printf '%s' "$row" | cut -f6)"

  ratio="$(awk -v t="$tmax" -v b="$BUDGET" 'BEGIN { printf "%.3f", t / b }')"
  over=0
  awk -v t="$tmax" -v b="$BUDGET" -v k="$K_RATIO" 'BEGIN { exit !(t > b / k) }' && over=1

  fam=""
  is_family "$f" && fam=" family"

  status="ok"
  [ "$over" = "1" ] && status="OVER-BUDGET"
  [ "$nfailed" != "0" ] && status="$status,failed=$nfailed"

  echo "test-timeout-margin-check: file=$f T_max=${tmax}ms($title) B=${BUDGET}ms 比值=$ratio 1/K=$threshold tests=$ntests file_ms=$fl_ms status=$status$fam"
  echo "$f	$tmax	$ratio	$title	$ntests	$status" >>"$RUN_DIR/rows.tsv"

  # worst 判定：数字大的赢，但 UNREADABLE（比值 n/a）永远不被数字覆盖。
  if [ -z "$worst_file" ]; then
    worst_file="$f"; worst_tmax="$tmax"; worst_ratio="$ratio"; worst_note="$title"
  elif [ "$worst_ratio" = "n/a" ]; then
    : # 已经指向一个「量不到」的文件，不覆盖
  elif awk -v a="$ratio" -v b="$worst_ratio" 'BEGIN { exit !(a > b) }'; then
    worst_file="$f"; worst_tmax="$tmax"; worst_ratio="$ratio"; worst_note="$title"
  fi

  if [ "$over" = "1" ] || [ "$nfailed" != "0" ]; then
    n_bad=$(( n_bad + 1 ))
    bad_rows="$bad_rows
test-timeout-margin-check: file=$f status=$status T_max=${tmax}ms($title) B=${BUDGET}ms 比值=$ratio 阈值 1/K=$threshold → 冷编译还留在用例预算里（日志 $log）"
  else
    n_ok=$(( n_ok + 1 ))
  fi
done <"$scopelist"

# 判词：所有分支都**同一行**带出「最差文件 / T_max / B（含来源）/ 比值 / 阈值 1/K」。
verdict_readout="worst=${worst_file:-n/a} T_max=${worst_tmax:-n/a}ms B=${BUDGET:-n/a}ms(来源：${budget_src:-n/a}) 比值=${worst_ratio:-n/a} 阈值 1/K=$threshold (K=$K_RATIO)"
[ -n "$worst_note" ] && verdict_readout="$verdict_readout 最慢用例='$worst_note'"
verdict_readout="$verdict_readout ｜ 射程 ${#SCOPE[@]} 个文件（$scope_desc）｜ 达标 ${n_ok} / 不足或不可得 ${n_bad}"

printf '%s' "$bad_rows"
if [ "$n_bad" -gt 0 ]; then
  printf 'test-timeout-margin-check: FAIL — %s：%s/%s 个 client 文件余量不足或读数不可得（要求每个文件 T_max ≤ B/K）｜ %s\n' \
    "$scope_label" "$n_bad" "${#SCOPE[@]}" "$verdict_readout"
  exit 1
fi

printf 'test-timeout-margin-check: PASS — %s %s 个 client 文件全部 T_max ≤ B/K（最差比值 %s），冷编译不在任何用例的 testTimeout 预算内 ｜ %s\n' \
  "$scope_label" "$n_ok" "$worst_ratio" "$verdict_readout"
exit 0
