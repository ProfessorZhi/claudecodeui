#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/server-phase-concurrency-check.sh — 服务端阶段并发上限的判据
# （tasks/gap-server-phase-concurrency-clamp.md；人（yale）2026-09-21 裁定立案）
#
# 要断言的那一件事：**调用方给多大，服务端阶段的并发都不会过订阅；而调用方调低必须原样
# 生效。** 四条判据里 ①②④ 是**确定性**的（不依赖机器负载）：三次探针全部走
# `QUAY_TEST_DRY=1`，读的就是 `scripts/test.sh` 自己打印的那一行 `concurrency=<n>` ——
# 那是**实际生效值**，不是从源码里猜出来的默认值。③ 是**读数判据**：上限值必须能在下面
# 的 SLOPE_TABLE（本机实测）里找到，且取在实测 0 失败的那一档上。
#
#   ① --test-concurrency=<极大值> / <fan-in 同形值> ⇒ 打印值 = 上限（夹取发生）
#   ② --test-concurrency=4 / =2 / =1 与不给 flag（默认 4）⇒ 打印值原样（夹取不发生）
#   ③ 上限有**实测依据**：上限必须是 SLOPE_TABLE 里的一档且该档实测 0 失败；表里还必须
#      同时存在一档**已实测的失败档**（余量倍数据此算出）。
#      ⛔ 没有坡度表支撑的上限值 = 凭感觉写的阈值，本判据直接判红（fail-closed）。
#   ④ 输出行格式未变：默认档与 `--test-concurrency=4` 都必须**逐字**打印
#      `dry run: args consumed (concurrency=<n>, files=<m>)`（既有契约，
#      server/shared/tests/quay-test-script.test.ts 也在断言它）。
#
# 为什么判据是 standalone 脚本而不是 *.test.ts：本仓套件只收集 `server/**` 与 `src/**`
# 下的测试文件，放在 scripts/ 下的检查器不会被套件递归调用 —— 否则它会在套件里再跑套件，
# 自己把自己拖红（与 scripts/suite-concurrency-check.sh 同因）。本任务 ## Touches 不含
# `*.test.*`，属 scripts/suite-scope-check.sh 的 (b) 类：`--for-task` 会掏空成 thin 假绿，
# 故自测入口就是本检查器（该守卫的判词里逐字写明了这一点）。
#
# 红先行：本文件与 scripts/test.sh 的夹取**同时**交付，但判据的真值不随交付改变 ——
# 夹取若不在，① 立刻红并把实测到的越界值打在判词里（完成记录里贴了红、绿两次读数）。
#
# 退出码：0 判据成立；1 判据不成立；2 用法/环境错误。
# ⛔ 判词一律**同一行**带出成因与实测读数（本仓 AC 硬校验），不得用裸 grep -q 链。
# ─────────────────────────────────────────────────────────────────────────────
set -u

# ── SLOPE_TABLE：并发坡度表（AC3 的原始数据，也是上限的唯一依据）─────────────
#
# 实测条件：本机 128 核；每档跑**只有服务端阶段**的一次套件调用 —— 位置参数把 101 个
# `server/**/*.test.ts` 全部点名，于是 scripts/test.sh 走位置参数分支，不跑
# typecheck / lint / client，留下的墙钟就是服务端阶段本身。复算命令：
#
#   mapfile -t SF < <(find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort)
#   bash scripts/test.sh --test-concurrency=<N> "${SF[@]}"        # 安静档
#   # 负载档：同上，另起 <B> 个 `bash -c 'while :; do :; done'` 竞争 CPU
#
# 六列（TAB 分隔）：N  load1(起跑时)  墙钟ms  失败文件数  失败文件（无则 `-`）  来源
# ⛔ 任何一列都不许留空（read 把连续 TAB 当单个分隔符，空列会串位）；「无」写成 `-`。
#
# ⚠️ 表里同时有「N=128 干净」与「N=128 失败」两种行 —— 这不是笔误，是本任务最重要的一条
# 观测：**越界的后果取决于整机的压力，不只取决于 N**。所以末行（fan-in 真身）不是本 agent
# 发起的，而是本仓 `.quay/fan-in-suite-gap-model-env-kind-explanations~wk-prod-anchor~
# 1789921327335-cb8e49.log` 里那一次**真实** fan-in 轮的读数：同一台机器、同样的请求值
# 128，那一轮中位文件耗时 46,758ms 并判红了一个文件；而本 agent 当天在同样的 N=128 下
# 把起跑 load1 一路推到 129、把 lane 数推到 512，都没能再造出那条地板（见下表与完成记录
# 的负结果小节）。原因不神秘：那一轮的地板还有一半乘数来自**当时尚未收敛的 client vitest
# 池**（`e0ed4913` 之后才自适应收敛），而**服务端阶段的并发开关正是本任务手里的这个**。
#
# 读数与逐档判词见 tasks/gap-server-phase-concurrency-clamp.md 完成记录的「并发坡度表」
# 小节；下表是它的机器可读副本，判据③ 直接读它，不读散文（散文会漂，表不会）。
SLOPE_TABLE="$(cat <<'TABLE'
4	11	30044	0	-	本轮实测 2026-09-21 安静
16	13	14201	0	-	本轮实测 安静
32	15	13435	0	-	本轮实测 安静
64	14	13734	0	-	本轮实测 安静
100	14	14397	0	-	本轮实测 安静
128	22	18544	0	-	本轮实测 安静
128	66	23239	0	-	本轮实测 +64 竞争进程
128	93	15928	0	-	本轮实测 +64 竞争进程（二跑）
128	129	24312	0	-	本轮实测 +256 竞争进程
128	87-135	-	1	server/modules/launch-profiles/tests/gateway-end-to-end.test.ts	fan-in 真身 2026-09-20T16:23Z（本仓 log；中位文件耗时 46758ms）ⓘ 该文件已于 2026-09-21 随旧实体拆除删除，本行是不可复算的历史读数，判据③ 只读第一列
TABLE
)"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 2

TEST_SH="$ROOT_DIR/scripts/test.sh"
PROBE_HUGE="${SPCC_PROBE_HUGE:-100000}"
PROBE_FANIN="${SPCC_PROBE_FANIN:-128}"   # fan-in 在本机实际塞入的值（128 核；实测该轮 101 个文件同时在跑）
DRY_LINE_RE='^dry run: args consumed \(concurrency=[0-9]+, files=[0-9]+\)$'

usage() {
  cat <<'USAGE'
usage: bash scripts/server-phase-concurrency-check.sh [options]

  无参即可：①②④ 走 QUAY_TEST_DRY=1 探针（秒级、确定性、不依赖机器负载），③ 读本脚本
  内置的 SLOPE_TABLE（本机实测坡度表）。

  --test-sh <path>   被测的套件入口（默认 <repo>/scripts/test.sh）
  --huge <n>         ① 的「极大值」探针（默认 100000）
  --fan-in <n>       ① 的「fan-in 同形」探针（默认 128 = 本机 nproc，也是实测那轮的并发）
  -h, --help         本帮助
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --test-sh) TEST_SH="${2:-}"; shift 2 ;;
    --test-sh=*) TEST_SH="${1#*=}"; shift ;;
    --huge) PROBE_HUGE="${2:-}"; shift 2 ;;
    --huge=*) PROBE_HUGE="${1#*=}"; shift ;;
    --fan-in) PROBE_FANIN="${2:-}"; shift 2 ;;
    --fan-in=*) PROBE_FANIN="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "server-phase-concurrency-check: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -f "$TEST_SH" ] || {
  printf 'server-phase-concurrency-check: cannot evaluate — test.sh not found: %s (env error, not a verdict)\n' "$TEST_SH" >&2
  exit 2
}

# dry_line <n|""> — 跑一次 dry-run，打印 `dry run: args consumed (...)` 那一行（原文）。
# 空串 = 不给 --test-concurrency（默认档）。⛔ 只读 stdout 的那一行：判据的读数就是
# 「实际生效值」，任何夹取都必然先体现在这里。
dry_line() {
  local out
  if [ -z "$1" ]; then
    out="$(QUAY_TEST_DRY=1 bash "$TEST_SH" 2>/dev/null)" || return 1
  else
    out="$(QUAY_TEST_DRY=1 bash "$TEST_SH" "--test-concurrency=$1" 2>/dev/null)" || return 1
  fi
  printf '%s\n' "$out" | sed -n '/^dry run: args consumed /p' | head -1
}

# dry_eff <n|""> — 同一行里的 concurrency 值；拿不到就返回非零。
dry_eff() {
  local line val
  line="$(dry_line "$1")" || return 1
  val="$(printf '%s\n' "$line" | sed -n 's/^dry run: args consumed (concurrency=\([0-9]*\), files=[0-9]*)$/\1/p')"
  [ -n "$val" ] || return 1
  printf '%s' "$val"
}

# ── 坡度表读数（判据③ 的唯一依据）────────────────────────────────────────────
slope_rows=0
slope_unsafe_n=""      # 第一档实测失败的 N
slope_unsafe_row=""
slope_ceiling_row=""
table_has()   { printf '%s\n' "$SLOPE_TABLE" | awk -F'\t' -v n="$1" '$1 == n { f = 1 } END { exit !f }'; }
table_field() { printf '%s\n' "$SLOPE_TABLE" | awk -F'\t' -v n="$1" -v c="$2" '$1 == n { print $c; exit }'; }

while IFS=$'\t' read -r n load wall fails files prov; do
  [ -n "${n:-}" ] || continue
  slope_rows=$((slope_rows + 1))
  case "${fails:-}" in ''|*[!0-9]*) fails=0 ;; esac
  if [ -z "$slope_unsafe_n" ] && [ "$fails" -gt 0 ]; then
    slope_unsafe_n="$n"; slope_unsafe_row="N=$n load1=${load} wall=${wall}ms fails=$fails [$files] 来源=${prov}"
  fi
done < <(printf '%s\n' "$SLOPE_TABLE")

echo "server-phase-concurrency-check: test_sh=$TEST_SH 坡度表档数=$slope_rows"
echo "server-phase-concurrency-check: 坡度表(实测) $(printf '%s' "$SLOPE_TABLE" | paste -sd';' - | sed 's/; */ | /g')"

# ── 探针 ─────────────────────────────────────────────────────────────────────
FAILS=()

huge_eff="$(dry_eff "$PROBE_HUGE")" || huge_eff=""
fanin_eff="$(dry_eff "$PROBE_FANIN")" || fanin_eff=""
four_eff="$(dry_eff 4)" || four_eff=""
two_eff="$(dry_eff 2)" || two_eff=""
one_eff="$(dry_eff 1)" || one_eff=""
default_eff="$(dry_eff "")" || default_eff=""

CEILING="$huge_eff"
case "$CEILING" in ''|*[!0-9]*|0) CEILING="";; esac

readout="极大($PROBE_HUGE)→${huge_eff:-?} fan-in同形($PROBE_FANIN)→${fanin_eff:-?} 4→${four_eff:-?} 2→${two_eff:-?} 1→${one_eff:-?} 默认→${default_eff:-?}"

# 上限**之上**的实测档，按结局计数。诚实读数的一半在这一行：同一个 N 既可能有干净的档、
# 也可能有失败的档（见 SLOPE_TABLE 顶部注释），所以「余量」是按**请求值的差**算的，
# 不是按「N 这么大就一定红」算的 —— 判词把这个不对称原样带出来，不粉饰。
above_clean=0; above_unsafe=0
while IFS=$'\t' read -r n _load _wall fails _files _prov; do
  [ -n "${n:-}" ] || continue
  case "${fails:-}" in ''|*[!0-9]*) fails=0 ;; esac
  if [ -n "$CEILING" ] && [ "$n" -gt "$CEILING" ] 2>/dev/null; then
    if [ "$fails" -gt 0 ]; then above_unsafe=$((above_unsafe + 1)); else above_clean=$((above_clean + 1)); fi
  fi
done < <(printf '%s\n' "$SLOPE_TABLE")

# ── ① 夹取发生：极大值 / fan-in 同形值都必须落在上限上 ────────────────────────
if [ -z "$CEILING" ]; then
  FAILS+=("① 探针不可判：--test-concurrency=$PROBE_HUGE 的 dry-run 没有打印可解析的 concurrency=<n>（读到 '$huge_eff'），上限无从取得（fail-closed）")
elif [ "$huge_eff" = "$PROBE_HUGE" ]; then
  FAILS+=("① 未夹取：请求 --test-concurrency=$PROBE_HUGE，实测生效值仍是 $huge_eff（= 请求值）——调用方给多大就并发多大")
fi
if [ -n "$CEILING" ] && [ "$fanin_eff" != "$CEILING" ]; then
  FAILS+=("① 未夹取(fan-in 同形)：请求 --test-concurrency=$PROBE_FANIN（本机 fan-in 实际塞入值，实测那轮 101 个服务端文件同时在跑），实测生效值 = ${fanin_eff:-?}，应被夹到上限 $CEILING")
fi

# ── ② 调低原样生效（夹取只在上限之上发生）────────────────────────────────────
for pair in "4:$four_eff" "2:$two_eff" "1:$one_eff"; do
  want="${pair%%:*}"; got="${pair#*:}"
  [ "$got" = "$want" ] || FAILS+=("② 调低被篡改：请求 --test-concurrency=$want，实测生效值 = ${got:-?}，应原样为 $want")
done
[ "$default_eff" = "4" ] || FAILS+=("② 默认档被篡改：不给 --test-concurrency 时实测生效值 = ${default_eff:-?}，应原样为 4")

# ── ③ 上限有实测依据（没有坡度表就不许有上限）────────────────────────────────
if [ -n "$CEILING" ]; then
  if ! table_has "$CEILING"; then
    FAILS+=("③ 上限 $CEILING 不在实测坡度表里（表中档位: $(printf '%s' "$SLOPE_TABLE" | awk -F'\t' '{printf "%s ", $1}')）——没有实测读数支撑的阈值不许上线")
  else
    cf="$(table_field "$CEILING" 4)"
    case "${cf:-}" in ''|*[!0-9]*) cf=1 ;; esac
    [ "$cf" -eq 0 ] || FAILS+=("③ 上限 $CEILING 那一档实测就有 $cf 个失败文件：上限取在实测失败档上")
    if [ -z "$slope_unsafe_n" ]; then
      FAILS+=("③ 坡度表里没有「已实测的失败档」，余量倍数无从算出：上限 $CEILING 与它之间的余量不能靠猜")
    elif [ "$slope_unsafe_n" -le "$CEILING" ]; then
      FAILS+=("③ 实测失败档 N=$slope_unsafe_n ≤ 上限 $CEILING：上限取在越界区里")
    fi
  fi
  [ "$slope_rows" -ge 4 ] || FAILS+=("③ 坡度表只有 $slope_rows 档（< 4），不足以支撑上限取值")
fi

# ── ④ 输出行格式未变（逐字）──────────────────────────────────────────────────
default_line="$(dry_line "")" || default_line=""
four_line="$(dry_line 4)" || four_line=""
printf '%s\n' "$default_line" | grep -Eq "$DRY_LINE_RE" \
  || FAILS+=("④ 默认档输出行格式变了：读到 '$default_line'，应逐字匹配 dry run: args consumed (concurrency=<n>, files=<m>)")
printf '%s\n' "$four_line" | grep -Eq "$DRY_LINE_RE" \
  || FAILS+=("④ --test-concurrency=4 输出行格式变了：读到 '$four_line'，应逐字匹配 dry run: args consumed (concurrency=<n>, files=<m>)")

# ── 判词（全部读数集中在同一行）──────────────────────────────────────────────
margin="n/a"; wall_ratio="n/a"
if [ -n "$CEILING" ] && [ -n "$slope_unsafe_n" ]; then
  margin="$(awk -v u="$slope_unsafe_n" -v c="$CEILING" 'BEGIN { printf "%.2f", u / c }')"
fi
base_wall="$(table_field 4 3)"; ceil_wall="$(table_field "${CEILING:-x}" 3)"
if [ -n "$base_wall" ] && [ -n "$ceil_wall" ] && [ "$base_wall" -gt 0 ] 2>/dev/null; then
  wall_ratio="$(awk -v a="$ceil_wall" -v b="$base_wall" 'BEGIN { printf "%.2f", a / b }')"
fi

verdict_readout="探针 $readout ｜ 上限=$CEILING 上限档墙钟=${ceil_wall:-?}ms 基线(N=4)墙钟=${base_wall:-?}ms 墙钟比=${wall_ratio} ｜ 上限之上实测档=干净${above_clean}/失败${above_unsafe} 首个实测失败档=${slope_unsafe_row:-none} 余量倍数(失败档N/上限)=$margin"

if [ ${#FAILS[@]} -gt 0 ]; then
  for m in "${FAILS[@]}"; do
    printf 'server-phase-concurrency-check: FAIL — %s ｜ %s\n' "$m" "$verdict_readout"
  done
  printf 'server-phase-concurrency-check: FAIL — %s 条不成立：服务端阶段的并发没有被夹在上限内（或该上限没有实测依据）\n' "${#FAILS[@]}"
  exit 1
fi

printf 'server-phase-concurrency-check: PASS — ① 极大值与 fan-in 同形值都被夹到上限 ② 调低(4/2/1)与默认(4)原样生效 ③ 上限取在实测 0 失败档、与首个实测失败档留有 %s× 余量 ④ dry-run 行格式逐字未变 ｜ %s\n' \
  "$margin" "$verdict_readout"
exit 0
