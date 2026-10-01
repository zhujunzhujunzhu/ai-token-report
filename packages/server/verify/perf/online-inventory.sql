-- 线上 ai_token_report 只读盘点（全部是 SELECT，不含任何写操作）
SELECT '01_meta' AS section, schema_version AS a, NULL AS b, NULL AS c, NULL AS d FROM portal_meta WHERE id = 1;
SELECT '02_migrations' AS section, version AS a, status AS b,
       FROM_UNIXTIME(started_at_ms/1000) AS c, FROM_UNIXTIME(completed_at_ms/1000) AS d
  FROM portal_schema_migrations ORDER BY version;
SELECT '03_size_total' AS section, ROUND(SUM(data_length)/1024/1024,1) AS data_mb,
       ROUND(SUM(index_length)/1024/1024,1) AS index_mb,
       ROUND(SUM(data_length+index_length)/1024/1024,1) AS total_mb, ROUND(SUM(data_free)/1024/1024,1) AS free_mb
  FROM information_schema.tables WHERE table_schema = 'ai_token_report';
SELECT '04_size_by_table' AS section, table_name AS a, table_rows AS b,
       ROUND(data_length/1024/1024,2) AS c, ROUND(index_length/1024/1024,2) AS d
  FROM information_schema.tables WHERE table_schema = 'ai_token_report'
 ORDER BY (data_length+index_length) DESC LIMIT 12;
SELECT '05_events' AS section, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions,
       COUNT(DISTINCT member_id) AS members, COUNT(DISTINCT provider) AS providers
  FROM usage_event;
SELECT '06_span' AS section, FROM_UNIXTIME(MIN(ts)/1000) AS first_event,
       FROM_UNIXTIME(MAX(ts)/1000) AS last_event, ROUND((MAX(ts)-MIN(ts))/86400000,1) AS span_days,
       COUNT(DISTINCT model) AS models
  FROM usage_event;
SELECT '07_by_month' AS section, DATE_FORMAT(FROM_UNIXTIME(ts/1000), '%Y-%m') AS month, COUNT(*) AS events,
       COUNT(DISTINCT member_id) AS members, COUNT(DISTINCT session_id) AS sessions,
       ROUND(SUM(inp+outp+cr+cw)/1024/1024/1024,2) AS tokens_gb
  FROM (SELECT ts, member_id, session_id, input_tokens AS inp, output_tokens AS outp,
               cache_read_tokens AS cr, cache_write_tokens AS cw FROM usage_event) AS t
 GROUP BY month ORDER BY month;
SELECT '08_by_day' AS section, DATE(FROM_UNIXTIME(received_at_ms/1000)) AS day, COUNT(*) AS events,
       COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT member_id) AS members
  FROM usage_event WHERE received_at_ms IS NOT NULL
 GROUP BY day ORDER BY day DESC LIMIT 14;
SELECT '09_indexes' AS section, index_name AS a,
       GROUP_CONCAT(column_name ORDER BY seq_in_index) AS b,
       MAX(non_unique) AS c, MAX(sub_part) AS d
  FROM information_schema.statistics
 WHERE table_schema = 'ai_token_report' AND table_name = 'usage_event'
 GROUP BY index_name ORDER BY index_name;
SELECT '10_identity' AS section,
       (SELECT COUNT(*) FROM members) AS a, (SELECT COUNT(*) FROM report_tokens) AS b,
       (SELECT COUNT(*) FROM member_groups) AS c, (SELECT COUNT(*) FROM member_group_assignments) AS d;
SELECT '11_pricing' AS section, (SELECT COUNT(*) FROM provider_alias) AS a,
       (SELECT COUNT(*) FROM model_price) AS b, (SELECT COUNT(*) FROM login_accounts) AS c,
       (SELECT COUNT(*) FROM admin_audit_log) AS d;
