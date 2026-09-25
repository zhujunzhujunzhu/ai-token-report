# dsh-token-report

DSH（DeepSeek Harness）的 **token 用量统计 CLI**：直接读本机的会话日志，
算清楚每一分用量花在哪个厂商、哪个模型、哪个项目、哪个会话上。

- 📊 终端报表：按 provider / model / 项目 / 会话 / 天 / 小时分组，支持 JSON 与 CSV
- 🖥️ 本地页面：`dsh-token-report web` 一条命令打开，**只监听 127.0.0.1、不出网**
- 📤 增量上报：`dsh-token-report report` 定时把新增用量投递到部门服务端
- ⚡ 毫秒级热查询：本地 SQLite 增量库（日志的派生物，坏了自动回退直扫）
- 🔌 **Node 与 Bun 都能跑**：同一份产物，Node ≥22.15 走 `node:sqlite`，Bun 走 `bun:sqlite`

## 安装

```bash
# 任意包管理器之一
npm i -g dsh-token-report
bun add -g dsh-token-report
pnpm add -g dsh-token-report
```

也可以用 `npx` / `bunx` 免安装运行：

```bash
npx dsh-token-report --period today
bunx dsh-token-report --period today
```

安装后会得到两个等价的命令：`dsh-token-report` 与更短的 `dsh-token`。

## 快速开始

```bash
dsh-token-report --period today              # 今天的用量
dsh-token-report --period week --series day  # 本周 + 每日趋势
dsh-token-report --list-providers            # 先看看有哪些厂商/模型
dsh-token-report web                         # 打开本地页面
```

输出示例：

```
DSH token 统计  |  今天（2026-09-25 ~ 现在）  |  数据源 本地库 .../usage.sqlite（3,476 条记录）

=== 按厂商 / 模型 (provider/model) ===
分组                                总量  未缓存输入     输出      缓存读  命中率  调用数  会话数
────────────────────────────────  ──────  ──────────  ───────  ──────────  ──────  ──────  ──────
deepseek-official/deepseek-flash  47.78M     599,960  327,893  46,852,352   98.7%     392       5
```

## 口径：`cacheRead` 不是 `input` 的一部分

这是整个工具最重要的一个约定，也是最容易读错的地方：

```
计费总量 = input + output + cacheRead + cacheWrite
```

- `input` 是**未命中缓存**的那部分，**不含** `cacheRead`
- `reasoning` **不在**总量里 —— 它是 `output` 的子集
- 缓存命中率 = `cacheRead / (cacheRead + input)`

为什么强调这点：实测 `cacheRead` 占总用量的 **94.3%**。
只报 `input + output` 会漏掉 94% 的真实用量；把 `cacheRead` 加回 `input`
则会虚增约 20 倍。两种读法都会得出一个「看起来很正常」的错误数字。

## 数据从哪来

读 `$DSH_HOME`（默认 `~/.dsh`）下的会话日志：

```
$DSH_HOME/sessions/**/session*.jsonl.zstd
```

只取 `assistant/message` 事件里的 `data.usage` —— 那是 provider 真实上报的
计费级数据。**不采集对话内容**，只取 token 数值与模型名。

```bash
dsh-token-report --dsh-home /path/to/.dsh --period today
```

## 常用选项

| 选项 | 说明 |
|---|---|
| `--period <p>` | `today` `yesterday` `week` `lastweek` `month` `lastmonth` `year` `last7d` `last30d` …（也接受中文：`今天` `本周` `上月`） |
| `--by <dim>` | `provider` `model` `provider-model` `project` `session` `day` `hour`（逗号分隔可多选） |
| `--series <g>` | 时间序列粒度：`day` 或 `hour` |
| `--provider` / `--model` | 子串过滤，逗号分隔 |
| `--since` / `--until` / `--last` | 自定义时间窗；`--last 7d` 是**滚动** 168 小时，与 `--period last7d`（7 个自然日）不同 |
| `--format <f>` | `table`（默认）/ `json` / `csv` |
| `--out <file>` | 写入文件而不是 stdout |
| `--cross` | 追加 provider × model 交叉表 |
| `--no-db` | 强制直扫日志、不走本地库（用于与库结果对照） |
| `--reset-db` | 删掉本地库；下次运行自动全量重建（日志仍在，不丢数据） |

完整列表见 `dsh-token-report --help`。

## 本地页面

```bash
dsh-token-report web --port 8899 --no-open
```

- **只监听 `127.0.0.1`**，同内网的其他人访问不到
- 数据来自本机日志，**不上报、断网可用**
- 首次启动会全量建库（约 15 秒，取决于日志总量），之后每次请求约 50 ms
- 页面上的数字与 `dsh-token-report --period X` 完全一致（同一数据源、同一套口径）

## 增量上报（可选）

把新增用量定时投递到部门服务端。幂等键是 `event_id = ${sessionId}:${seq}`，
服务端去重，所以重复投递无害。

```bash
dsh-token-report report --dry-run                 # 先看这一轮会发什么
dsh-token-report report --endpoint https://portal.example.com/api/v1/token-usage --token <TOKEN>
```

退出码：`0` 成功（含 dry-run、本轮无新增）/ `2` 参数错误 / `3` 投递失败
（pending 会保留，下一轮重试）。

## 与本地库的关系

`$DSH_HOME/token-report/usage.sqlite` 是**日志的派生物，不是真值**：
它只是把「每次查询都重新解压 19 MB 日志」的 CPU 开销省掉。
库损坏、磁盘满、权限不足时**自动回退直扫日志**并在输出里说明原因 ——
不会因为库坏了就让你看不到数。

要重建就删掉它：`dsh-token-report --reset-db`。

## 环境要求

| 运行时 | 最低版本 | SQLite 驱动 |
|---|---|---|
| Node | **22.15.0**（`node:sqlite` 需 ≥22.5，`node:zlib` 的 zstd 需 ≥22.15） | `node:sqlite` |
| Bun | 1.1.0 | `bun:sqlite` |

> Node 22.x 的 `node:sqlite` 仍是实验特性，但工具已在启动时静默其
> `ExperimentalWarning`，正常使用看不到这行告警。

`web` 与 `report` 子命令都可用；`web` 在 Node 下由内置的 `node:http` 服务托管，
不依赖 Bun。

## License

MIT
