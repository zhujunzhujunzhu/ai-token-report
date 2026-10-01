-- 线上看板取数 SQL 的只读基准（与 core/db/query.ts 的构建器同形，30 天窗口）
SELECT 'A_totals' AS probe, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(cache_read_tokens) AS cache_read
  FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000;
SELECT 'B_sessions_distinct' AS probe, COUNT(DISTINCT session_id) AS c
  FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000;
SELECT 'C_member_groups' AS probe, COUNT(*) AS groups_, SUM(calls) AS calls
  FROM (SELECT member_id, COUNT(*) AS calls
          FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000
         GROUP BY member_id, session_id) AS t;
SELECT 'D_series_rows' AS probe, COUNT(*) AS raw_rows
  FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000;
SELECT 'E_legacy_selfcheck' AS probe, COUNT(*) AS distinct_pairs
  FROM (SELECT DISTINCT member_id, user_id FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000) AS t;
SELECT 'F_records_count' AS probe, COUNT(*) AS total
  FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000;
SELECT 'G_provider_groups' AS probe, COUNT(*) AS groups_
  FROM (SELECT provider FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000 GROUP BY provider) AS t;
SELECT 'H_window_share' AS probe, COUNT(*) AS rows_30d,
       ROUND(100*COUNT(*)/(SELECT COUNT(*) FROM usage_event),1) AS pct_of_table
  FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000;
SELECT 'I_hour_of_day' AS probe, HOUR(FROM_UNIXTIME(ts/1000)) AS hour_of_day, COUNT(*) AS calls,
       SUM(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) AS tokens
  FROM usage_event WHERE ts >= (UNIX_TIMESTAMP()-30*86400)*1000
 GROUP BY hour_of_day ORDER BY hour_of_day;
