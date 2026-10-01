-- 汇总表可行性复核（只读）：行数完全由「每人每天用到几个 (供应商,模型) 组合」决定
SELECT 'C1_combos_per_member_day' AS section, c_per_member_day, COUNT(*) AS days_,
       ROUND(100*COUNT(*)/(SELECT COUNT(*) FROM (SELECT member_id, DATE(FROM_UNIXTIME(ts/1000)) AS d
                                                  FROM usage_event GROUP BY member_id, d) AS y),1) AS pct
  FROM (SELECT member_id, DATE(FROM_UNIXTIME(ts/1000)) AS d,
               COUNT(DISTINCT provider, model) AS c_per_member_day
          FROM usage_event GROUP BY member_id, d) AS t
 GROUP BY c_per_member_day ORDER BY c_per_member_day;

SELECT 'C2_average' AS section, ROUND(AVG(c),2) AS avg_combos, MAX(c) AS max_combos,
       COUNT(*) AS member_days
  FROM (SELECT member_id, DATE(FROM_UNIXTIME(ts/1000)) AS d,
               COUNT(DISTINCT provider, model) AS c
          FROM usage_event GROUP BY member_id, d) AS x;

SELECT 'C3_t1_rows_now' AS section, COUNT(*) AS t1_rows_now
  FROM (SELECT DATE(FROM_UNIXTIME(ts/1000)) AS d, member_id, provider, model
          FROM usage_event GROUP BY d, member_id, provider, model) AS t1;

SELECT 'C4_extrapolate_300' AS section,
       ROUND((SELECT AVG(c) FROM (SELECT member_id, DATE(FROM_UNIXTIME(ts/1000)) AS d,
                                         COUNT(DISTINCT provider, model) AS c
                                    FROM usage_event GROUP BY member_id, d) AS x) * 300 * 365) AS t1_rows_at_300_members_year,
       ROUND((SELECT AVG(c) FROM (SELECT member_id, DATE(FROM_UNIXTIME(ts/1000)) AS d,
                                         COUNT(DISTINCT provider, model) AS c
                                    FROM usage_event GROUP BY member_id, d) AS x) * 300 * 30 * 24) AS t2_rows_upper_if_hourly_spread;

SELECT 'C5_provider_model_pairs' AS section, COUNT(DISTINCT provider, model) AS pairs_
  FROM usage_event;

SELECT 'C6_top_pairs' AS section, provider, model, COUNT(*) AS events
  FROM usage_event GROUP BY provider, model ORDER BY events DESC LIMIT 10;

SELECT 'C7_session_shape' AS section, ROUND(AVG(events),1) AS avg_events_per_session,
       ROUND(AVG(sessions_per_member_day),2) AS avg_sessions_per_member_day
  FROM (SELECT session_id, COUNT(*) AS events FROM usage_event GROUP BY session_id) AS s,
       (SELECT member_id, DATE(FROM_UNIXTIME(ts/1000)) AS d, COUNT(DISTINCT session_id) AS sessions_per_member_day
          FROM usage_event GROUP BY member_id, d) AS m;

SELECT 'C8_weekday_shape' AS section, DAYOFWEEK(FROM_UNIXTIME(ts/1000)) AS dow, COUNT(*) AS events
  FROM usage_event GROUP BY dow ORDER BY dow;
