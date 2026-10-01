#!/bin/bash
# 运行时 A/B 的**编排器**：交替起 node22 / bun 两个实例，各跑一轮 `bench.mjs`，
# 最后起两个实例做一次 `parity.mjs` 逐位对账。
#
# 用法（在目标机上，root，先跑过 `fixture.sh setup`）：
#   bash run.sh                       # 完整矩阵：node bun node bun
#   bash run.sh node:1 bun:1          # 只跑指定轮次
#   bash run.sh --parity              # 只做逐位对账
#
# 三个刻意的设计（都是踩出来的）：
#  1. ★ **交替轮次**：node→bun→node→bun。只跑一轮的话，
#     「第一轮 MySQL 页缓存还冷」会被误读成运行时的差异。
#  2. 🚨 **起服务前断言端口空闲、起完断言监听者就是本次的 pid**：
#     `--port` 被占时服务端会**静默 +1**，于是就绪检测打到上一个残留实例上，
#     数字立刻失去意义，而输出看起来一切正常（实测踩过，bun 的“启动耗时”报成 0.068 秒）。
#  3. ★ **server 钉在 CPU 0、客户端钉在 CPU 1**：两核机器上不钉的话，
#     服务端与压测客户端会互相抢核，且抢法随轮次变化。
set -u

FIXTURE=/root/.atr/ab-fixture.env
[ -r "$FIXTURE" ] || { echo "找不到 $FIXTURE，先跑 fixture.sh setup" >&2; exit 3; }
. "$FIXTURE"

HERE=${ATR_AB_DIR:-/data/ai-token-report/packages/server/runtime-ab}
# ⚠️ 不要用 `$(dirname "$0")` 推目录：本脚本常常是经
#    `ssh-exec.mjs < run.sh`（远端 `bash -s`）喂进去的，那时 `$0` 是 `bash`，
#    `dirname` 会得到 `.`，于是 `$HERE/fixture.sh` 变成 `/root/fixture.sh`
#    → `No such file or directory`（实测踩过，整个矩阵空跑一遍）。
[ -f "$HERE/bench.mjs" ] || { echo "在 $HERE 找不到 bench.mjs；用 ATR_AB_DIR 指定目录" >&2; exit 3; }

# 基准产物放在服务端包目录**之内**：`mysql2/promise` 是按「导入它的那个文件所在目录」
# 逐级向上解析的，放到 /tmp 下 Node 会解析不到它。
ABDIR="$HERE"
PORTAL=${ATR_AB_PORTAL:-/data/ai-token-report/packages/web-portal/dist}
ART="$ABDIR/main.mjs"
BENCH="$HERE/bench.mjs"
PARITY="$HERE/parity.mjs"
NODE=${ATR_AB_NODE:-/usr/local/node22/bin/node}
BUN=${ATR_AB_BUN:-/usr/local/bin/bun}
OUTDIR=${ATR_AB_OUT:-/tmp/atr-ab-results}
REPEATS=${ATR_AB_REPEATS:-25}
mkdir -p "$OUTDIR"
# 清掉上一轮的产物：混着两批 JSON 汇总出来的表会「看起来正常但数字是两次实验拼的」。
rm -f "$OUTDIR"/*.json "$OUTDIR"/*.startup.txt "$OUTDIR"/REPORT.md

HAS_TASKSET=0
command -v taskset >/dev/null 2>&1 && HAS_TASKSET=1

NODE_URL="mysql://$BENCH_USER:$BENCH_PASSWORD@127.0.0.1:3308/$BENCH_SCHEMA"
# 🚨 Bun 必须走 `?tls=true`：线上 atr_user 的口令 32 字符，Bun 1.4.2 在**非 TLS**
#    连接下对 >19 字符的 caching_sha2_password 会 1045 认证失败（oven-sh/bun#26195）。
#    TLS 只是绕过握手缺陷，与凭证强度无关 —— 不要为此缩短口令。
BUN_URL="${NODE_URL}?tls=true"

kill_leftovers() {
  for P in $(ps -eo pid,cmd | grep -E 'runtime-ab/main[.]mjs' | grep -v grep | awk '{print $1}'); do
    kill -9 "$P" 2>/dev/null
  done
  sleep 1
}

ensure_port_free() {
  local PORT="$1"
  for _ in 1 2 3 4 5; do
    ss -ltn 2>/dev/null | grep -q ":$PORT " || return 0
    echo "  端口 $PORT 仍被占用，清理残留进程"
    kill_leftovers
  done
  ss -ltn 2>/dev/null | grep -q ":$PORT " && { echo "!! 端口 $PORT 无法释放"; return 1; }
  return 0
}

start_server() {
  local RUNTIME="$1" PORT="$2" URL="$3" DIR="$4"
  local LAUNCH="$RUNTIME"
  [ "$HAS_TASKSET" = "1" ] && LAUNCH="taskset -c 0 $RUNTIME"
  ( cd "$ABDIR" && exec env ATR_MYSQL_URL="$URL" $LAUNCH "$ART" \
      --host 127.0.0.1 --port "$PORT" --data-dir "$DIR/data" --static "$PORTAL" ) \
      > "$DIR/server.log" 2>&1 &
  echo $! > "$DIR/pid"
}

run_one() {
  local NAME="$1" RUNTIME="$2" PORT="$3" URL="$4" ROUND="$5"
  # ⚠️ `TAG` 与依赖它的 `DIR` 必须**分两条** `local`：写在同一条里时，
  #    `set -u` 下 `$TAG` 的展开发生在赋值之前 → `TAG: unbound variable`（实测）。
  local TAG="${NAME}-r${ROUND}"
  local DIR="/tmp/atr-ab-$TAG"
  rm -rf "$DIR"; mkdir -p "$DIR"

  echo "════════════════════════════════════════════════════════"
  echo "  运行 $TAG  （$RUNTIME，端口 $PORT，第 $ROUND 轮）"
  echo "════════════════════════════════════════════════════════"
  bash "$HERE/fixture.sh" reset
  ensure_port_free "$PORT" || return 1

  local T0 T1 PID READY=0
  T0=$(date +%s.%N)
  start_server "$RUNTIME" "$PORT" "$URL" "$DIR"
  PID=$(cat "$DIR/pid")

  for _ in $(seq 1 200); do
    curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null && { READY=1; break; }
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  T1=$(date +%s.%N)

  if [ "$READY" != "1" ]; then
    echo "!! 启动失败，日志："; cat "$DIR/server.log"; kill -9 "$PID" 2>/dev/null; return 1
  fi
  if ! grep -qE "127\.0\.0\.1:$PORT( |\$)" "$DIR/server.log"; then
    echo "!! 端口发生漂移，日志："; cat "$DIR/server.log"; kill -9 "$PID" 2>/dev/null; return 1
  fi
  if ! ss -ltnp 2>/dev/null | grep -q ":$PORT .*pid=$PID,"; then
    echo "!! 监听 $PORT 的不是本次启动的 pid $PID："; ss -ltnp | grep ":$PORT "
    kill -9 "$PID" 2>/dev/null; return 1
  fi

  local STARTUP; STARTUP=$(echo "$T1 - $T0" | bc)
  echo "启动到就绪: ${STARTUP}s   pid=$PID"
  echo "$STARTUP" > "$OUTDIR/$TAG.startup.txt"
  sleep 2   # 让首轮 schema 闸门与连接池都就绪

  local CLIENT="$NODE"
  [ "$HAS_TASKSET" = "1" ] && CLIENT="taskset -c 1 $NODE"
  $CLIENT "$BENCH" --port "$PORT" --tag "$NAME" --pid "$PID" --static "$PORTAL" \
    --token "$BENCH_SECRET" --repeats "$REPEATS" --out "$OUTDIR/$TAG.json" 2>&1 | tee "$DIR/bench.log"
  echo "启动耗时 ${STARTUP}s" >> "$DIR/bench.log"

  kill "$PID" 2>/dev/null; sleep 1.5; kill -9 "$PID" 2>/dev/null
  tail -5 "$DIR/server.log"
  echo
}

run_parity() {
  echo "════════════════════════════════════════════════════════"
  echo "  逐位对账：node22 vs bun（同一产物、同一克隆库）"
  echo "════════════════════════════════════════════════════════"
  bash "$HERE/fixture.sh" reset
  local DN=/tmp/atr-ab-parity-node DB=/tmp/atr-ab-parity-bun
  rm -rf "$DN" "$DB"; mkdir -p "$DN" "$DB"
  ensure_port_free 18901 || return 1
  ensure_port_free 18902 || return 1
  start_server "$NODE" 18901 "$NODE_URL" "$DN"; local PN; PN=$(cat "$DN/pid")
  start_server "$BUN"  18902 "$BUN_URL"  "$DB"; local PB; PB=$(cat "$DB/pid")
  for _ in $(seq 1 200); do
    curl -s -m 2 -o /dev/null http://127.0.0.1:18901/api/health 2>/dev/null \
      && curl -s -m 2 -o /dev/null http://127.0.0.1:18902/api/health 2>/dev/null && break
    sleep 0.1
  done
  $NODE "$PARITY" --a 18901 --b 18902 --token "$BENCH_SECRET"
  local CODE=$?
  kill "$PN" "$PB" 2>/dev/null; sleep 1; kill -9 "$PN" "$PB" 2>/dev/null
  bash "$HERE/fixture.sh" reset
  return $CODE
}

PLAN=()
MODE=matrix
for a in "$@"; do
  case "$a" in
    --parity) MODE=parity ;;
    *) PLAN+=("$a") ;;
  esac
done
[ "${#PLAN[@]}" -eq 0 ] && PLAN=(node:1 bun:1 node:2 bun:2)

if [ "$MODE" = parity ]; then
  run_parity
  exit $?
fi

FAILED=0
for item in "${PLAN[@]}"; do
  name="${item%%:*}"; round="${item##*:}"
  case "$name" in
    node) run_one node "$NODE" 18901 "$NODE_URL" "$round" || FAILED=1 ;;
    bun)  run_one bun  "$BUN"  18902 "$BUN_URL"  "$round" || FAILED=1 ;;
    *) echo "未知运行时：$name"; exit 2 ;;
  esac
done

echo "=== 轮次结果都在 $OUTDIR ==="
ls -la "$OUTDIR"
echo
run_parity || FAILED=1

echo
echo "=== 报告生成（把逐轮 JSON 汇总成一张对照表）==="
$NODE "$HERE/report.mjs" --dir "$OUTDIR" || FAILED=1
exit $FAILED
