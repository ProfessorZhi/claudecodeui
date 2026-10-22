#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/suite-scope-check.sh — 活跃任务的「自测作用域」机械守卫
# （goals/AC-103 的派生任务 gap-worker-selfcheck-scoped）
#
# WHY THIS EXISTS. 本项目并发套件的乘法来自一条【约定】，不是某个开关：派发并发来自
# 插件的 `kinds.worker.cap: 5`，而**每一个任务 worker 的自测 AC 都写着 `bash scripts/test.sh`
# （全量）**。于是 cap 的真实含义变成「最多 5 个全量套件同时抢一台机器」——前者管派发，
# 后者才是成本，两者互不知情。全量套件本该是 **fan-in 的合并闸**（它在合并前对被测树跑
# 一次）；worker 自己只需要证明**它改的那部分**没坏，即 `bash scripts/test.sh --for-task
# <task-id> --allow-thin`（scoped 路径刻意跳过全量静态闸，见 runner-static-gate 的注释）。
#
# 两条规则并列，⛔ 不是一条。第二条正是本守卫**不得**无条件要求改成 `--for-task` 的原因：
#
#  (a) 任务的 `## Touches` 含 `*.test.*` 文件 ⇒ scoped 在该任务上语义成立 ⇒ 它 `## AC` 里的
#      自测命令必须带 `--for-task <自身 id>`。
#  (b) 任务的 `## Touches` **不含** `*.test.*`（例如交付物是 `scripts/*.sh` 检查器）⇒
#      `--for-task` 会从 Touches 里抽到 0 个文件、走 scripts/test.sh 的 thin 分支
#      （`no scoped test files for <id> (thin)`，exit 0）——**那是一个取不了假的绿，比全量更糟**
#      （quay init 契约文档对同形有逐字告警：「a green that cannot go red is not a measurement」）。
#      这类任务同样**不得**以全量套件充当自测，改法是**直接跑它自己交付的检查器（`scripts/*.sh`）**。
#      ⛔ 把 (b) 判成「应该改用 --for-task」会亲手制造那个假绿，故两类判词在形态上必须可区分。
#
# 什么算「全量套件自测」（检测规则，刻意窄且可复核）：
#   `## AC` 段里的一个**行内代码 span**（`` `…` ``），它以**命令词**开头
#   （`bash` / `sh` / `node` / `npx` / `./`）且其命令路径是 `scripts/test.sh`。
#   这样的 span 若**不带** `--for-task`，就是一次全量套件调用。
#   裸路径提及（span 本身以路径开头，例如某个 AC 在复述本规则时引用了文件名）**不是命令**，
#   不参与判定 —— 本规则与 AC 的措辞同形：「全量 `bash scripts/test.sh`（未带 --for-task）」
#   说的就是命令形态。
#   `done` / `superseded` 的历史任务原样保留（不改历史账），不参与扫描。
#
# WIRING SELF-CHECK（为什么守卫要检查自己被接入）：守卫若没人跑，等于不存在。所以它顺带
#   证明自己出现在 `scripts/test.sh` 的**前置**（第一条 stage / 文件收集之前）——删掉那行调用，
#   本守卫即以非零退出并给出 wiring 判词。
#
# 退出码：0 = 合规；1 = 有违规（含 wiring）；2 = 用法/环境错误（tasks 目录或 test.sh 读不到）。
# ⛔ 判词一律**同一行**带出成因与任务 id（本仓 AC 硬校验：criterion 的失败退出必须同行输出原因），
#   不得用裸 `grep -q` 链。
# ─────────────────────────────────────────────────────────────────────────────
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

TASKS_DIR="$ROOT_DIR/tasks"
TEST_SH="$ROOT_DIR/scripts/test.sh"

usage() {
  cat <<'USAGE'
usage: bash scripts/suite-scope-check.sh [options]

  --tasks-dir <dir>   扫描的任务目录（默认 <repo>/tasks）
  --test-sh <path>    「守卫已接入前置」的接线判据所读的套件入口（默认 <repo>/scripts/test.sh）
  -h, --help          本帮助
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tasks-dir) TASKS_DIR="${2:-}"; shift 2 ;;
    --tasks-dir=*) TASKS_DIR="${1#*=}"; shift ;;
    --test-sh) TEST_SH="${2:-}"; shift 2 ;;
    --test-sh=*) TEST_SH="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "suite-scope-check: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -d "$TASKS_DIR" ] || {
  printf 'suite-scope-check: cannot evaluate — tasks dir not found: %s (env error, not a verdict)\n' "$TASKS_DIR" >&2
  exit 2
}
[ -f "$TEST_SH" ] || {
  printf 'suite-scope-check: cannot evaluate the wiring — test.sh not found: %s (env error, not a verdict)\n' "$TEST_SH" >&2
  exit 2
}

# ── 违规检测（两类的判词形态必须可区分）──────────────────────────────────────
VIOLATIONS=()
N_TOTAL=0
N_SKIPPED=0
N_ACTIVE=0
N_SCOPED=0          # 活跃且 Touches 含测试文件（(a) 类适用面）
N_NO_TESTS=0        # 活跃且 Touches 不含测试文件（(b) 类适用面）

# status 取自 frontmatter 的 `status:` 行（任务文件的第一处）。
task_status() { # task_status <file>
  awk '/^status:/{ sub(/^status:[[:space:]]*/, ""); sub(/[[:space:]]+$/, ""); print; exit }' "$1"
}

# `## Touches` 段里的 `*.test.*` 条目数（与 scripts/test.sh 的 --for-task 抽取同形）。
task_test_touch_count() { # task_test_touch_count <file>
  awk '/^## Touches/{t=1;next} /^## /{t=0} t && /^- /{sub(/^- +/,"");gsub(/`/,"");print $1}' "$1" \
    | grep -cE '\.test\.[jt]sx?$' || true
}

task_first_test_touch() { # task_first_test_touch <file>
  awk '/^## Touches/{t=1;next} /^## /{t=0} t && /^- /{sub(/^- +/,"");gsub(/`/,"");print $1}' "$1" \
    | grep -E '\.test\.[jt]sx?$' | head -1 || true
}

# span_is_full_suite_selftest <span> → 0 = 是全量套件自测；1 = 不是（含 scoped 调用与裸路径提及）
span_is_full_suite_selftest() {
  local span="$1" path="" rest="" lead=""
  # 去掉 span 两端空白
  span="${span#"${span%%[![:space:]]*}"}"
  span="${span%"${span##*[![:space:]]}"}"
  # 只认命令形态：命令词 + 空格
  case "$span" in
    "bash "*) lead="bash" ;;
    "sh "*)   lead="sh" ;;
    "node "*) lead="node" ;;
    "npx "*)  lead="npx" ;;
    "./"*)    lead="./" ;;
    *) return 1 ;;
  esac
  if [ "$lead" = "./" ]; then rest="${span#./}"; else rest="${span#"$lead" }"; fi
  # `bash   scripts/test.sh`（多空格）与 `bash "scripts/test.sh"` 都归一
  rest="${rest#"${rest%%[![:space:]]*}"}"
  rest="${rest#\"}"
  rest="${rest#./}"
  case "$rest" in
    "scripts/test.sh"|"scripts/test.sh "*|"scripts/test.sh\""*) ;;
    *) return 1 ;;
  esac
  # scoped 调用（带 --for-task）不是全量自测
  case "$span" in *--for-task*) return 1 ;; esac
  return 0
}

shopt -s nullglob
for f in "$TASKS_DIR"/*.md; do
  N_TOTAL=$((N_TOTAL + 1))
  st="$(task_status "$f")"
  case "$st" in
    done|superseded) N_SKIPPED=$((N_SKIPPED + 1)); continue ;;
  esac
  N_ACTIVE=$((N_ACTIVE + 1))
  id="$(basename "$f" .md)"
  ntests="$(task_test_touch_count "$f")"
  case "$ntests" in ''|*[!0-9]*) ntests=0 ;; esac
  if [ "$ntests" -gt 0 ]; then N_SCOPED=$((N_SCOPED + 1)); else N_NO_TESTS=$((N_NO_TESTS + 1)); fi

  # `## AC` 段里逐行抽行内代码 span（反引号之间的偶数段；⛔ 只抽 AC 段，不抽正文）
  while IFS= read -r span; do
    [ -n "$span" ] || continue
    span_is_full_suite_selftest "$span" || continue
    if [ "$ntests" -gt 0 ]; then
      VIOLATIONS+=("VIOLATION(a) task=$id — its ## AC self-tests with the FULL suite (span: \`$span\`) while ## Touches lists $ntests *.test.* file(s) (first: $(task_first_test_touch "$f")), so a scoped self-test IS well-defined here: change it to \`bash scripts/test.sh --for-task $id\` — the full suite is fan-in's merge gate, not a worker's self-test")
    else
      VIOLATIONS+=("VIOLATION(b) task=$id — its ## AC self-tests with the FULL suite (span: \`$span\`) while ## Touches lists NO *.test.* file, so \`--for-task $id\` would resolve to 0 files and take scripts/test.sh's thin path (\"no scoped test files for $id (thin)\", exit 0) — a green that cannot go red is not a measurement; self-test by running this task's own delivered checker (scripts/*.sh) instead")
    fi
  done < <(awk '
    /^## AC[[:space:]]*$/ || /^## Acceptance Criteria[[:space:]]*$/ { inac = 1; next }
    /^## / { inac = 0 }
    inac {
      n = split($0, parts, "`")
      for (i = 2; i <= n; i += 2) if (parts[i] != "") print parts[i]
    }' "$f")
done
shopt -u nullglob

# ── wiring self-check：本守卫必须被套件入口的前置调用 ────────────────────────
# 前置 = 第一条 stage（run_stage …）或第一次文件收集（SERVER_FILES=/CLIENT_FILES=）之前。
# 只认非注释行里的调用（注释里提到文件名不算接线）。
WIRING_VERDICT=""
guard_line="$(awk '/^[[:space:]]*#/ { next } /suite-scope-check\.sh/ { print NR; exit }' "$TEST_SH")"
stage_line="$(awk '/^[[:space:]]*(run_stage|SERVER_FILES=|CLIENT_FILES=)/ { print NR; exit }' "$TEST_SH")"
if [ -z "$guard_line" ]; then
  WIRING_VERDICT="VIOLATION(wiring) — $TEST_SH never calls scripts/suite-scope-check.sh on a non-comment line: the guard is dead code, and \"nobody runs it\" is exactly the failure it exists to prevent"
elif [ -n "$stage_line" ] && [ "$guard_line" -ge "$stage_line" ]; then
  WIRING_VERDICT="VIOLATION(wiring) — $TEST_SH calls scripts/suite-scope-check.sh at line $guard_line, but the first stage/file collection is at line $stage_line: the guard must run in the PRELUDE, before any test work starts"
fi

echo "suite-scope-check: scan tasks=$N_TOTAL skipped(done/superseded)=$N_SKIPPED active=$N_ACTIVE with-tests=$N_SCOPED no-tests=$N_NO_TESTS tasks_dir=$TASKS_DIR"

if [ -n "$WIRING_VERDICT" ]; then
  printf 'suite-scope-check: %s\n' "$WIRING_VERDICT"
fi

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  for v in "${VIOLATIONS[@]}"; do
    printf 'suite-scope-check: %s\n' "$v"
  done
fi

if [ -n "$WIRING_VERDICT" ] || [ ${#VIOLATIONS[@]} -gt 0 ]; then
  ids="$(printf '%s\n' "${VIOLATIONS[@]+"${VIOLATIONS[@]}"}" | sed -n 's/^VIOLATION(\([a-b]\))[[:space:]]\+task=\([^ ]*\).*/\2(\1)/p' | paste -sd, -)"
  printf 'suite-scope-check: FAIL — %s violation(s)%s; the full suite belongs to fan-in'"'"'s merge gate — a worker only has to prove the part it changed\n' \
    "$(( ${#VIOLATIONS[@]} + $([ -n "$WIRING_VERDICT" ] && echo 1 || echo 0) ))" \
    "${ids:+ (${ids})}"
  exit 1
fi

printf 'suite-scope-check: PASS — %s active task(s) scanned: every active task whose ## Touches lists *.test.* carries --for-task in its ## AC self-test, and no active task without *.test.* touches uses the full suite as its self-test; this guard is wired into %s'"'"'s prelude (line %s < stage line %s)\n' \
  "$N_ACTIVE" "$TEST_SH" "${guard_line:-?}" "${stage_line:-n/a}"
exit 0
