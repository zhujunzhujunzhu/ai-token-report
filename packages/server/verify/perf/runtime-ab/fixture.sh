#!/bin/bash
# 运行时 A/B 的**隔离夹具**：在目标机上克隆一份上报库，并造一把已知明文的管理凭证。
#
# 用法（在目标机上，root）：
#   bash fixture.sh setup      # 建克隆库 + 夹具凭证 + 隔离 MySQL 用户
#   bash fixture.sh reset      # 只清掉压测写入的事件（保证读阶段看到的是基线数据）
#   bash fixture.sh dispose    # 全删：克隆库、隔离用户、凭证文件、基准进程、临时目录
#
# 🚨 为什么必须克隆而不是直接压生产库
#   1. 生产库是全员数据的**唯一副本**，压测要写事件、要有可控凭证，任何一项都不该落在它上面；
#   2. 但「换成合成数据」又会让结论失真（维度基数、会话分布、时间跨度全都不同）。
#      所以：**结构 + 数据整份克隆**，只在克隆库上动手。
#
# ⚠️ 隔离用户的口令**故意用 32 字符**：线上 `atr_user` 就是 32 字符，
#   而 Bun 在非 TLS 连接下对 >19 字符的 caching_sha2_password 会认证失败
#   （oven-sh/bun#26195）。夹具必须能复现线上的这个边界，否则测出来的
#   「Bun 能跑」是个假结论。
set -u

ACTION="${1:-}"
BENCH="${ATR_AB_SCHEMA:-atr_http_v5_bench}"
SOURCE="${ATR_AB_SOURCE:-ai_token_report}"
FIXTURE=/root/.atr/ab-fixture.env
SECRET='atr-ab-bench-token-2026-10-01'
BENCH_USER=atr_ab_long
BENCH_PASSWORD='ablongpassword1234567890abcdefgh'
CRED=/root/.atr/mysql8-credentials.txt
MYSQL_BIN=/usr/local/mysql8/bin/mysql
DUMP_BIN=/usr/local/mysql8/bin/mysqldump

# 🚨 安全闸门：库名必须以受控前缀开头，否则拒绝任何写操作。
#    `DROP DATABASE` 写错一个名字就是全员历史用量永久消失。
case "$BENCH" in
  atr_http_v5_*) : ;;
  *) echo "拒绝执行：隔离库名 '$BENCH' 不以 atr_http_v5_ 开头" >&2; exit 2 ;;
esac
case "$SOURCE" in
  *bench*|*test*) echo "拒绝执行：源库名 '$SOURCE' 看起来不是生产库" >&2; exit 2 ;;
esac

[ -r "$CRED" ] || { echo "读不到 $CRED" >&2; exit 3; }
ROOTPW=$(grep -A5 '^\[root\]' "$CRED" | grep '^password=' | cut -d= -f2-)
[ -n "$ROOTPW" ] || { echo "凭证文件里没有 [root] password" >&2; exit 3; }

CNF=$(mktemp); chmod 600 "$CNF"
printf '[client]\nuser=root\npassword=%s\nhost=127.0.0.1\nport=3308\n' "$ROOTPW" > "$CNF"
SQL="$MYSQL_BIN --defaults-extra-file=$CNF -N --batch"
trap 'rm -f "$CNF"' EXIT

kill_bench_processes() {
  # ⚠️ 按 PID 杀，**不要**用 `pkill -f`：远端脚本的整段文本会出现在 shell 的命令行里，
  #    `pkill -f` 会匹配到自己并把自己杀掉（实测：输出戛然而止、退出码 1）。
  for PID in $(ps -eo pid,cmd | grep -E 'runtime-ab/main[.]mjs' | grep -v grep | awk '{print $1}'); do
    kill "$PID" 2>/dev/null
  done
  sleep 2
  for PID in $(ps -eo pid,cmd | grep -E 'runtime-ab/main[.]mjs' | grep -v grep | awk '{print $1}'); do
    kill -9 "$PID" 2>/dev/null
  done
  sleep 1
}

case "$ACTION" in
  setup)
    HASH=$(printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1)
    echo "=== 角色目录 ==="
    $SQL -e "SELECT role_id, code, name, is_builtin FROM $SOURCE.roles"

    echo
    echo "=== 建隔离克隆库 $BENCH（源：$SOURCE）==="
    $SQL -e "DROP DATABASE IF EXISTS \`$BENCH\`; CREATE DATABASE \`$BENCH\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;"
    # --single-transaction：不锁生产表；--no-tablespaces：不需要 PROCESS 权限
    $DUMP_BIN --defaults-extra-file="$CNF" --single-transaction --no-tablespaces \
      --set-gtid-purged=OFF --skip-lock-tables --routines --triggers --events \
      "$SOURCE" 2>/tmp/atr-ab-dump.err | $SQL "$BENCH" 2>/tmp/atr-ab-import.err || {
        echo "导入失败："; cat /tmp/atr-ab-dump.err /tmp/atr-ab-import.err; exit 1; }

    echo "--- 行数核对 ---"
    $SQL -e "
      SELECT 'events',   COUNT(*) FROM \`$BENCH\`.usage_event
      UNION ALL SELECT 'members', COUNT(*) FROM \`$BENCH\`.members
      UNION ALL SELECT 'tokens',  COUNT(*) FROM \`$BENCH\`.report_tokens
      UNION ALL SELECT 'permissions', COUNT(*) FROM \`$BENCH\`.permissions
      UNION ALL SELECT 'schema_ver', schema_version FROM \`$BENCH\`.portal_meta WHERE id=1;"

    echo "=== 插入夹具凭证（挂在 admin 角色的人身上，授予全部权限码）==="
    # ⚠️ 不要用 CONCAT(...) 回显 member_id：utf8mb4 字面量与 ascii_bin 列混用会
    #    报 `Illegal mix of collations`（实测），直接 SELECT 列本身即可。
    $SQL "$BENCH" -e "
      SET @admin_member := (
        SELECT m.member_id FROM members m
          JOIN member_roles mr ON mr.member_id = m.member_id
          JOIN roles r ON r.role_id = mr.role_id
         WHERE r.code = 'admin' AND m.status = 'active'
         ORDER BY m.created_at_ms LIMIT 1);
      SET @tid := UUID();
      INSERT INTO report_tokens (token_id, member_id, token_hash, token_prefix, label, status, version, created_at_ms, expires_at_ms, revoked_at_ms)
        SELECT @tid, @admin_member, '$HASH', LEFT('$HASH', 12), 'A/B 基准夹具', 'active', 1, UNIX_TIMESTAMP()*1000, NULL, NULL
        WHERE NOT EXISTS (SELECT 1 FROM report_tokens WHERE token_hash='$HASH');
      INSERT INTO report_token_scopes (token_id, permission_id)
        SELECT t.token_id, p.permission_id FROM report_tokens t CROSS JOIN permissions p
         WHERE t.token_hash='$HASH'
           AND NOT EXISTS (SELECT 1 FROM report_token_scopes s WHERE s.token_id=t.token_id AND s.permission_id=p.permission_id);"
    $SQL "$BENCH" -e "
      SELECT t.token_id, t.member_id, t.status, t.token_prefix,
             (SELECT COUNT(*) FROM report_token_scopes s WHERE s.token_id=t.token_id) AS scopes
        FROM report_tokens t WHERE t.token_hash='$HASH';"

    echo "=== 建隔离 MySQL 用户并只授克隆库 ==="
    $SQL -e "
      DROP USER IF EXISTS '$BENCH_USER'@'127.0.0.1';
      CREATE USER '$BENCH_USER'@'127.0.0.1' IDENTIFIED WITH caching_sha2_password BY '$BENCH_PASSWORD';
      GRANT ALL PRIVILEGES ON \`$BENCH\`.* TO '$BENCH_USER'@'127.0.0.1';
      FLUSH PRIVILEGES;"
    $SQL -e "SHOW GRANTS FOR '$BENCH_USER'@'127.0.0.1';"

    umask 077
    printf 'BENCH_SCHEMA=%s\nBENCH_SECRET=%s\nBENCH_USER=%s\nBENCH_PASSWORD=%s\n' \
      "$BENCH" "$SECRET" "$BENCH_USER" "$BENCH_PASSWORD" > "$FIXTURE"
    chmod 600 "$FIXTURE"
    echo "夹具已写入 $FIXTURE"
    ;;

  reset)
    [ -r "$FIXTURE" ] || { echo "找不到 $FIXTURE，先跑 setup" >&2; exit 3; }
    . "$FIXTURE"
    $SQL "$BENCH_SCHEMA" -e "DELETE FROM usage_event WHERE session_id LIKE 'abbench-%' OR session_id LIKE 'abparity-%';"
    $SQL "$BENCH_SCHEMA" -e "SELECT COUNT(*) AS baseline_events FROM usage_event;"
    ;;

  dispose)
    echo "=== 停掉基准进程 ==="
    kill_bench_processes
    echo "=== 删除克隆库与隔离用户 ==="
    $SQL -e "DROP DATABASE IF EXISTS \`$BENCH\`;"
    $SQL -e "DROP USER IF EXISTS '$BENCH_USER'@'127.0.0.1'; FLUSH PRIVILEGES;"
    echo "=== 删除夹具文件与临时目录 ==="
    rm -f "$FIXTURE" /tmp/atr-ab-dump.err /tmp/atr-ab-import.err
    rm -rf /tmp/atr-ab-* /tmp/atr-ab-results
    echo "=== 复核生产库未受影响 ==="
    $SQL -e "
      SELECT 'events', COUNT(*) FROM $SOURCE.usage_event
      UNION ALL SELECT 'members', COUNT(*) FROM $SOURCE.members
      UNION ALL SELECT 'tokens', COUNT(*) FROM $SOURCE.report_tokens
      UNION ALL SELECT 'schema_version', schema_version FROM $SOURCE.portal_meta WHERE id=1;"
    $SQL -e "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'atr%';"
    ps -eo pid,cmd | grep -E 'runtime-ab/main[.]mjs' | grep -v grep || echo "(无残留进程)"
    ;;

  *)
    echo "用法：bash fixture.sh {setup|reset|dispose}" >&2
    exit 2 ;;
esac
