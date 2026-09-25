---
name: identity-attribution
description: Work on user identity,署名, token credentials, and usage attribution in this repo. Use when handling identity.json, credentials.json, the sign-in guide page, /api/local/identity or /api/v1/identity/verify routes, the "unsigned means no collection" rule, or the server-authoritative name boundary; not for token metric formulas or log decoding.
version: 1.0.0
---

# 身份署名与归属

## 这是唯一无法靠技术绕过的问题

DSH 原生**故意匿名**：`~/.dsh/.anonymous-user-id` 是 `crypto.randomUUID()`，
官方明示 **"Do not use it to identify a user"**。

所以「谁用了多少」必须由用户显式提供。这是全平台唯一无法靠技术绕过的问题。

## 方案：用户主动署名（已确认，非 IT 写入）

用户填 **姓名 + token**（管理员发放）+ 部门（选填）。

| | 旧设想（IT 装机写入） | **现行方案（用户主动填）** |
|---|---|---|
| 谁填 | IT / 安装脚本 | **员工本人** |
| 何时 | 装机时 | **首次打开页面 / 首次启动插件** |
| 合规 | 需另行书面告知 | **员工知情且主动**，更干净 |

## ★ 核心不变量：token 是身份凭证，姓名以服务端为准

```
用户填「张三」+ token
      ↓
本地服务 POST /api/v1/identity/verify ──► 部门服务端凭证表
      ↓  ◄── { ok, name: "张三", dept } ────┘
以【服务端返回的姓名】落盘 ← ★ 不采信用户输入
```

**若服务端直接采信客户端声明的姓名，任何人改一下本地配置就能以他人名义上报，
部门看板的数据立刻失去意义。**

由此得到的性质：
- 客户端「我填了张三」不算数，**服务端以 token 解析出的身份为准**
- 即使本地身份文件被篡改，**也无法冒用他人身份**上报
- 姓名填错时以服务端为准，不会产生重复人员

> 实证：端到端测试里故意提交「张三三」（用户打错），落盘结果是「张三」。

**改动 `verifyToken()` 时特别注意**：返回值里的 `name` 只可能来自凭证表，
绝不回显客户端提交的内容。这是身份可信边界的关键一行。

## ★ 未署名 = 不采集也不上报

已确认的行为约定，实现落在三处：

| 位置 | 行为 |
|---|---|
| 本地页面 | 仍可看本机总量（那是用户自己的数据），但不写归属、不发任何请求 |
| CLI `report` | 无署名时**跳过上报**，不静默记成 `unknown` |
| DSH 插件 | **不注册上报后端**，只提示一次「去哪里填」 |

> **为什么不按 `unknown` 兜底上报？** 因为那是**未授权的数据采集**。
> 宁可数据缺失（看板上能看到「有 N 人未署名」），也不要偷偷采集。
>
> ⚠️ `docs/插件方案.md` §9 里「以 `unknown` 上报并打 warning」是**已废弃的旧方案**，
> 不要照它实现。

## 身份文件

```
$DSH_HOME/token-report/identity.json
```

**本地页与插件共用同一份** —— 员工在哪里填一次就够了。

```json
{ "name": "张三", "token": "...", "dept": "研发一部",
  "createdAt": 1789984019944, "updatedAt": 1789984019944 }
```

### 三条实现约束（`packages/core/src/identity-store.ts`）

| 约束 | 不加会怎样 |
|---|---|
| **原子写入**（临时文件 + rename） | 写一半被杀死留下截断 JSON，用户看到「我明明填过了」 |
| **权限 0600** | 文件含 token（凭证） |
| **解析失败不抛错**，降级为「未署名」 | 抛错会让页面白屏，而用户此时最需要看到引导页 |

Windows 上 `chmod` 是 no-op，靠目录 ACL 保护 —— 这是已知且可接受的差异。

## 管理员准备凭证

路径：`ATR_CREDENTIALS` 环境变量，或 `<dshHome>/token-report/credentials.json`

```jsonc
// 格式一（推荐）：一 token 一人。role 缺省是 member
[ { "token": "atr-zhangsan-9f3c", "name": "张三", "dept": "研发一部" },
  { "token": "atr-boss-9f3c",     "name": "李经理", "role": "admin" } ]

// 格式二：姓名 → token 映射（该格式下所有人都是 member）
{ "张三": "atr-zhangsan-9f3c" }
```

- **明文比对 token，不引入哈希** —— 明文必须能从文件恢复（管理员要发给员工），
  哈希带来的安全性提升有限，却让「补发 token」变得麻烦
- 凭证文件损坏时服务端**照常启动**（空表 + 告警），
  不因一份文件写错就让已署名的员工全部失效；
  但**管理页从此拒绝一切写入**（不拿空表覆盖唯一真值）

## 角色与人员管理（发放 token）

★ **角色是权限的唯一来源**，缺省 `member`：`member` 可看全部门看板；
`admin` 额外能进看板上的「人员管理」页签，在那里发放 / 重置 / 吊销 token。
**绝不要用姓名白名单判断管理员** —— 姓名是随便就能改的显示值。

| 入口 | 用途 |
|---|---|
| 手工写 `credentials.json` 的 `"role": "admin"` | 铺开**第一个**管理员 |
| `ATR_ADMIN_TOKEN`（+ `ATR_ADMIN_NAME`）环境变量 | 冷启动兜底（文件为空 / 只读）；**不落文件** |
| 看板 →「人员管理」页 | 日常发放 / 重置 / 吊销 |

三条不可移除的护栏（`packages/server/src/member-admin.ts`）：

| 护栏 | 不加会怎样 |
|---|---|
| **姓名唯一** | 看板按姓名分组，同名会把两个人并成一个人，且看不出异常 |
| **最后一个管理员不可删 / 不可降级** | 一次误操作后没人能再发 token |
| **先落盘、再改内存镜像** | 反过来会出现「页面上 token 能用、重启后消失」 |

管理接口（`/api/v1/admin/members*`）的鉴权失败分三类：
`401`（没带 / token 不对）、**`403`**（token 有效但不是管理员）、
`503`（服务端还没配凭证）；业务失败（重名、最后一个管理员……）才是 `200 + ok:false`。

## 接口与提示文案

| 接口 | 说明 |
|---|---|
| `GET /api/local/identity` | 署名状态 —— **响应不含 token** |
| `POST /api/local/identity` | 提交署名（会向部门服务端校验 token） |
| `DELETE /api/local/identity` | 清除署名 / 换人 |
| `POST /api/v1/identity/verify` | 服务端校验（**纯查询，不写库不落日志**） |

### 两个反直觉的错误处理（刻意如此，不要"修"）

1. **校验失败返回 `200 + ok:false`，不是 401。**
   用 401 会让前端把「token 填错了」和「网络坏了」混为一谈。
2. **`GET /api/local/identity` 绝不返回 token。**
   发回浏览器等于让它暴露在 devtools、磁盘缓存与任何 XSS 面前。
   页面只需要知道「填没填」和「叫什么」。

### 提示文案的三条原则

未署名时的措辞直接决定这个功能会不会被接受：

1. **说明去哪里填**，而不是抱怨「你没填」—— 后者让用户卡住
2. **明确承诺不采集** —— 含糊其辞会让人怀疑在偷采，反而更容易被拒绝
3. **区分「token 填错了」与「管理员还没发凭证」** ——
   后者用户做什么都没用（`registered: false`），混为一谈会让人反复重试

插件侧**每个进程生命周期只提示一次** —— 每次会话都弹会让人烦到直接卸载插件。

## 相关

- 完整设计 → `ARCHITECTURE.md` §4.5
- 契约类型 → `packages/shared/src/identity.ts`
- 指标公式 → `token-metrics-contract` skill