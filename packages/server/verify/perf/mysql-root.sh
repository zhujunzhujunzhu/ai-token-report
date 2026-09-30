#!/bin/sh
# 在本地开发 MySQL 容器里以 root 跑一段 SQL（从 stdin 读）。
# 容器是共享的，本脚本**只做只读探测与 general_log 开关**，不碰任何业务数据。
exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -N "$@"
