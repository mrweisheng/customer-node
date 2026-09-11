# customerbackend_node · API 文档

> 基于实际代码逐条整理（`src/routers/*.js` + `src/middleware/*` + `src/utils/*` + `src/db.js`，
> 与 Python FastAPI 版 100% API 兼容，前端零改动）。
> 文档版本：2026-09-08。

---

## 1. 通用约定

### 1.1 Base URL

```
http://<host>:9527
```

| 端 | 默认 Base URL |
|---|---|
| 开发 Web | `http://localhost:9527` |
| 生产 Web / 小程序 | `https://kehu.gaoshanguoji.top`（Nginx 反代） |

### 1.2 路径前缀

- 业务 API 一律挂在 `/customerapi` 下
- 静态资源：`/avatars/*`（头像文件）
- 健康检查：`/health`、`/`

### 1.3 鉴权

除下表「公开接口」外，所有业务路由都需要 JWT 鉴权：

```
Authorization: Bearer <token>
```

JWT 签发：`HS256`，payload 为 `{ sub: String(userId), openid }`，默认 15 天有效。
**密钥与原 Python 后台共用同一份**（`JWT_SECRET_KEY`），旧 token 仍可继续使用。

### 1.4 公开接口（无需鉴权）

| 方法 | 路径 |
|---|---|
| GET  | `/` |
| GET  | `/health` |
| GET  | `/avatars/*` |
| POST | `/customerapi/auth/wx-login` |
| POST | `/customerapi/auth/admin-login` |
| POST | `/customerapi/auth/account-login` |
| GET  | `/customerapi/customers/ai/daily-quote` |

### 1.5 错误响应格式

统一为 `{ "detail": "<错误描述>" }`：

```json
{ "detail": "客户不存在" }
```

| HTTP | 含义 |
|---|---|
| 400 | 入参不合规（如用户名冲突、扩展名非法） |
| 401 | 未登录 / token 失效 |
| 403 | 越权（如非 admin 使用 `target_user_id`、admin 修改头像） |
| 404 | 资源不存在 |
| 422 | 业务校验失败（长度、数字格式等） |
| 429 | AI 限流 |
| 500 | 服务端异常（详见后端日志） |

### 1.6 时间字段格式

- `lead_date`、`visit_time`、`deal_time`：均为 `YYYY-MM-DD`
- `created_at`、`updated_at`、`last_visit_at`：均为 `YYYY-MM-DDTHH:mm:ss`（本地时区，无时区后缀）

### 1.7 数据隔离规则

非 admin 用户的所有查询/写入都强制带 `user_id = 当前用户.id`；
admin 用户可在查询串加 `target_user_id=<id>` 查看指定用户的数据（不带则看全部）。
非 admin 用户传 `target_user_id` 会返回 403。

### 1.8 客户端请求体大小上限

`express.json({ limit: '12mb' })` —— 为 AI 图片 base64 上传留够空间。

## 2. 鉴权模块 `/customerapi/auth`

### 2.1 `POST /wx-login`（公开）

微信小程序登录：用 `wx.login()` 拿到的 `js_code` 换 `openid`，自动注册新用户并签发 JWT。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| code | string | 是 | `wx.login()` 返回的 js_code |
| nickname | string | 否 | 透传，旧字段保留但实际不写入 |
| avatar | string | 否 | 透传，旧字段保留但实际不写入 |

> 实际写入 users 表的只有 `openid` + `role='user'`；昵称/头像走 `/user/info` 与 `/user/avatar` 单独更新。

**请求示例**

```http
POST /customerapi/auth/wx-login
Content-Type: application/json

{ "code": "071AbcDefGhi..." }
```

**响应 200**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user_id": 7,
  "openid": "oXyzAbc...",
  "nickname": "",
  "avatar_url": "",
  "role": "user",
  "username": ""
}
```

**错误**

- 400 `微信登录失败: code 缺失`
- 400 `微信登录失败: <微信 errmsg>`
- 400 `微信登录失败: <axios error>`

---

### 2.2 `POST /admin-login`（公开）

管理员账号 + 密码登录（仅 `role='admin'` 的用户可登录）。

**请求体**

| 字段 | 类型 | 必填 |
|---|---|---|
| username | string | 是 |
| password | string | 是 |

**响应 200**

```json
{
  "token": "eyJ...",
  "user_id": 1,
  "username": "admin",
  "nickname": "管理员",
  "avatar_url": "",
  "role": "admin"
}
```

**错误**

- 401 `账号或密码错误`（用户不存在、不是 admin、密码错误均返回此）

---

### 2.3 `POST /account-login`（公开）

普通用户（用户名 + 密码）登录。要求用户必须已经通过 `/bind-account` 绑定过账号。

**请求体**

| 字段 | 类型 | 必填 |
|---|---|---|
| username | string | 是 |
| password | string | 是 |

**响应 200**

```json
{
  "token": "eyJ...",
  "user_id": 7,
  "openid": "oXyzAbc...",
  "nickname": "销售员 A",
  "avatar_url": "/avatars/7_1700000000.jpg",
  "role": "user",
  "username": "alice"
}
```

**错误**

- 401 `账号或密码错误`

---

### 2.4 `POST /bind-account`（需鉴权）

把已登录的微信用户绑定到一组用户名 + 密码，使其能用账号密码登录（适用于 Web 工作台）。
用户名唯一，长度 3–64；密码长度 6–128；密码以 bcrypt 12 rounds 散列。

**请求体**

```json
{ "username": "alice", "password": "secret123" }
```

**响应 200**

```json
{ "message": "账号绑定成功", "username": "alice" }
```

**错误**

- 422 `用户名长度需 3-64 字符`
- 422 `密码长度需 6-128 字符`
- 400 `该用户名已被占用`
- 401 `Invalid or expired token`

## 3. 用户信息 `/customerapi/user`

### 3.1 `GET /info`（需鉴权）

```http
GET /customerapi/user/info
Authorization: Bearer <token>
```

**响应 200**

```json
{ "id": 7, "nickname": "销售员 A", "avatar_url": "/avatars/7_1700000000.jpg" }
```

> admin 也能调，返回的是 admin 自己的昵称/头像。

### 3.2 `PUT /info`（需鉴权，非 admin）

仅更新非空字段。

**请求体**（至少传一个）

```json
{ "nickname": "新昵称", "avatar_url": "/avatars/xxx.jpg" }
```

**响应 200**

```json
{ "id": 7, "nickname": "新昵称", "avatar_url": "/avatars/xxx.jpg" }
```

**错误**

- 403 `管理员不允许修改个人信息`

### 3.3 `POST /avatar`（需鉴权，非 admin，multipart）

上传头像图片，写入 `uploads/avatars/<userId>_<unix>.ext`，URL 通过 `/avatars/...` 暴露。

**请求**（`multipart/form-data`，字段名 `file`）

| 限制 | 值 |
|---|---|
| 文件大小 | ≤ 2 MB |
| 扩展名白名单 | `.jpg .jpeg .png .gif .webp` |

**响应 200**

```json
{ "avatar_url": "/avatars/7_1700000000.jpg" }
```

**错误**

- 400 `文件大小不能超过 2MB`
- 400 `不支持的文件类型: .pdf`
- 400 `未上传文件`
- 403 `管理员不允许修改头像`

## 4. 客户模块 `/customerapi/customers`

> 客户的「新增」统一走 `ai/batch-import`（参见 §6.2），本模块不提供 `POST /customers`；
> 单客户的元数据修改通过 `PUT /:customer_id/{needs|priority|visit}` 这类细粒度接口完成。

### 4.1 `GET /stats`（需鉴权）

工作台顶部统计卡片。

**Query**

| 参数 | 类型 | 说明 |
|---|---|---|
| target_user_id | int? | 仅 admin 可用，指定查看哪个用户 |

**响应 200**

```json
{
  "month_count": 18,           // 本月（自本月 1 号起）新增客户数
  "yesterday_count": 0,        // 昨日新增客户数
  "priority_count": 4,         // 重点客户总数
  "total_count": 127,          // 客户总数
  "last_month_count": 12,      // 上月同期累计（到上月今天为止）
  "last_month_total": 22,      // 上月全月总数
  "last_month_same_day": 0     // 上月同日那一天的新增数
}
```

### 4.2 `GET /trend`（需鉴权）

最近 N 天每日新增趋势，可选附带上一周期对比。

**Query**

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| days | int | 7 | 范围 1–90 |
| previous | bool | true | 是否同时返回上一周期的对比数据 |
| target_user_id | int? | — | admin 可用 |

**响应 200**

```json
{
  "dates":      ["09-02","09-03","09-04","09-05","09-06","09-07","09-08"],
  "counts":     [0, 3, 1, 5, 2, 0, 4],
  "prev_dates": ["08-26","08-27","08-28","08-29","08-30","08-31","09-01"],
  "prev_counts":[1, 0, 2, 1, 3, 0, 1]
}
```

### 4.3 `GET /latest`（需鉴权）

取最近一个 `lead_date` 的所有客户（最多 50 条）。

**Query**：`target_user_id?: int`（admin）

**响应 200**

```json
{
  "lead_date_str": "0907",     // MMDD 形式
  "customers": [
    {
      "id": 42,
      "lead_date": "2026-09-07",
      "customer_name": "张三",
      "is_priority": false,
      "remark": null,
      "current_needs": null,
      "last_visit_at": "2026-09-07T10:32:11",
      "created_at": "2026-09-07T10:32:11"
    }
  ]
}
```

空数据时返回 `{ "lead_date_str": "", "customers": [] }`。

### 4.4 `GET /priority`（需鉴权）

重点客户列表：`is_priority = TRUE`，按「无 last_visit_at 优先 → last_visit_at 升序 → lead_date 降序」排列。

**Query**：`target_user_id?: int`

**响应 200**：`CustomerOut[]`（结构同 §4.3）

### 4.5 `GET /search`（需鉴权）

「日期/名字」精准 + 模糊搜索。

**Query**

| 参数 | 必填 | 说明 |
|---|---|---|
| keyword | 是 | 搜索关键字 |
| target_user_id | 否 | admin 可用 |

**keyword 解析规则**

- 整个串当作名字模糊搜（`LIKE %name%`，最大返回 50 条，按 `lead_date DESC, created_at DESC`）
- 若含 `/`，则斜杠前当作日期前缀，斜杠后当作名字：
  - `4` 位（如 `0503`，MMDD）→ 跨年匹配任意年的该月日
  - `5` 位（如 `60503`，Y + MMDD）→ 取就近（≤当前年）的年份精确到日
  - 其余 → 日期部分忽略，整体回退为纯名字模糊搜

**示例**

```
?keyword=0503/张三       # 跨年匹配 5 月 3 日、名字含"张三"的客户
?keyword=60503/张三      # 就近年份（首数字 6 ≈ 当前年最后一位 + 0）5 月 3 日 + 张三
?keyword=张三            # 仅名字模糊
```

**响应 200**：`CustomerOut[]`

### 4.6 `GET /latest-date`（需鉴权）

```json
{ "latest_date": "2026-09-07" }   // 该用户最近一笔 lead_date；无数据时 null
```

### 4.7 `GET /by-date`（需鉴权）

按日查询客户列表。

**Query**

| 参数 | 必填 | 格式 |
|---|---|---|
| date | 是 | `YYYY-MM-DD` |
| target_user_id | 否 | int |

**响应 200**

```json
{
  "date": "09-07",
  "customers": [ /* CustomerOut[] */ ]
}
```

**错误**

- 422 `date 必填`
- 422 `date 格式应为 YYYY-MM-DD`

### 4.8 `GET /calendar`（需鉴权）

月度日历视图：标记每天是否有客户录入、未来/已更/未更状态、统计月度更新率。

**Query**

| 参数 | 默认 | 说明 |
|---|---|---|
| year | 当前年 | int |
| month | 当前月（1–12） | int |
| target_user_id | — | int（admin） |

**响应 200**

```json
{
  "year": 2026,
  "month": 9,
  "days": [
    { "day": 1,  "status": "updated" },   // updated = 有客户
    { "day": 2,  "status": "missed" },    // missed  = 过去但无客户
    { "day": 3,  "status": "future" }     // future  = 未到
  ],
  "updated_count": 12,
  "missed_count": 18,
  "update_rate": 40.0   // updated / (updated+missed) * 100，保留 1 位小数
}
```

### 4.9 `GET /monthly-stats`（需鉴权）

最近 N 个月每月新增客户数（用于柱状图）。

**Query**

| 参数 | 默认 | 范围 |
|---|---|---|
| months | 6 | 1–12 |
| target_user_id | — | int（admin） |

**响应 200**

```json
{
  "months": ["2026-04","2026-05","2026-06","2026-07","2026-08","2026-09"],
  "counts": [12, 9, 15, 11, 22, 18]
}
```

### 4.10 `GET /users/list`（需鉴权，admin only）

列出所有普通用户（用于 admin 切换查看视角）。

```json
[ { "id": 7, "nickname": "销售员 A" }, { "id": 8, "nickname": "销售员 B" } ]
```

**错误**

- 403 `权限不足`

### 4.11 `GET /deal-stats`（需鉴权）

成交统计：总览 + 近 6 月单数趋势 + 口岸分布 + 期/现牌 + 最近 10 条。

**Query**：`target_user_id?: int`

**响应 200**

```json
{
  "total_count": 30,        // 成交单数
  "customer_count": 21,     // 成交客户数（去重）
  "vehicle_count": 12,
  "plate_count": 18,
  "month_count": 5,         // 本月成交单数（按 deal_time）
  "monthly": {
    "months": ["2026-04","2026-05","2026-06","2026-07","2026-08","2026-09"],
    "counts": [3, 4, 5, 6, 7, 5]
  },
  "by_port": { "深圳湾": 8, "莲塘": 4, "港珠澳": 6 },
  "by_plate_kind": { "期牌": 10, "现牌": 8 },
  "recent": [ /* DealOut + customer_name，最多 10 条，按 created_at DESC */ ]
}
```

### 4.12 `GET /deal-list`（需鉴权）

按月查询成交列表（默认本月），含客户信息。

**Query**

| 参数 | 默认 | 格式 |
|---|---|---|
| month | 当前月 | `YYYY-MM` |
| target_user_id | — | int（admin） |

**响应 200**：`Array<DealOut & { customer_name, lead_date }>`

### 4.13 `GET /visit-list`（需鉴权）

按月查询到店列表（默认本月），含客户与关联成交摘要。

**Query**：同上。

**响应 200**：`Array<VisitOut & { customer_name, lead_date, deal_type, vehicle_desc, port, plate_kind }>`

### 4.14 `PUT /:customer_id/needs`（需鉴权）

更新客户的「当前需求」（`customers.current_needs`，v2 上提的客户级字段）。

**请求体**

| 字段 | 必填 | 长度 |
|---|---|---|
| needs | 是 | 1–2000 |
| followup | 否 | bool；为 true 时同步追加一条 followup 留痕 |

**响应 200**

```json
{ "code": 0, "msg": "需求已更新" }
```

**错误**

- 422 `customer_id 必须是整数`
- 422 `needs 长度需 1-2000 字符`
- 422 `needs 不能为空`
- 404 `客户不存在`

### 4.15 `PUT /:customer_id/priority`（需鉴权）

标注 / 取消重点。

**请求体**

| 字段 | 类型 | 说明 |
|---|---|---|
| is_priority | bool | true = 标重点，false = 取消 |
| remark | string? | 非空时会追加一条 followup；标重点时同步重置 `last_visit_at` 为当前时间，作为待回访计时起点 |

**响应 200**

```json
{ "code": 0, "msg": "更新成功" }
```

### 4.16 `PUT /:customer_id/visit`（需鉴权，兼容旧接口）

旧「回访」接口：追加一条 followup 历史并刷新 `customers.remark / last_visit_at` 缓存。
新业务请直接用 `POST /:customer_id/followups`。

**请求体**

```json
{ "remark": "客户反馈不错，约下周再来" }
```

**响应 200**

```json
{ "code": 0, "msg": "回访记录已保存" }
```

## 5. 客户子资源

### 5.1 跟进 / 回访 `/customers/:customer_id/followups`

#### 5.1.1 `GET`（需鉴权）

列表，按 `created_at DESC, id DESC`。

```json
[
  {
    "id": 12,
    "customer_id": 42,
    "content": "更新需求：想看 A6",
    "created_at": "2026-09-07T15:21:00"
  }
]
```

#### 5.1.2 `POST`（需鉴权）

**请求体**

| 字段 | 必填 | 长度 |
|---|---|---|
| content | 是 | 1–2000 |

副作用：INSERT 一条 followup 历史 + 刷新 `customers.remark` 与 `customers.last_visit_at`。

```json
{ "code": 0, "msg": "跟进记录已保存" }
```

**错误**：422（长度）、404（客户不存在）。

---

### 5.2 到店 `/customers/:customer_id/visits`

#### 5.2.1 `GET`（需鉴权）

按 `visit_time IS NULL DESC, visit_time DESC, created_at DESC, id DESC`。

```json
[
  {
    "id": 99,
    "customer_id": 42,
    "visit_time": "2026-09-05",
    "needs": "想看 A6",
    "is_deal": false,
    "deal_id": null,
    "remark": null,
    "created_at": "2026-09-05T11:00:00"
  }
]
```

#### 5.2.2 `POST`（需鉴权，仅「未成交」到店）

**请求体**

| 字段 | 必填 | 说明 |
|---|---|---|
| visit_time | 否 | `YYYY-MM-DD`，空或非法 → 今天 |
| needs | 是 | 未成交需求（自动 trim） |
| remark | 否 | 备注 |

**副作用**（单事务内）：

1. INSERT 一条 `is_deal=0` 的到店记录
2. 客户的 `is_priority=1`、`remark=needs`、`last_visit_at=now`
3. 追加一条 followup 留痕（"到店未成交：…"）

**响应 200**

```json
{ "code": 0, "msg": "到店已记录，已自动标为重点客户", "visit_id": 99 }
```

**错误**

- 422 `请填写需求`

> 已成交到店不需要手动录入，由 `POST /:customer_id/deals` 自动生成（见 §5.3.2）。

#### 5.2.3 `PUT /:visit_id`（需鉴权）

编辑到店日/需求/备注；`is_deal` 与 `deal_id` 由成交联动管理，此接口不会改变。

**请求体**

```json
{ "visit_time": "2026-09-06", "needs": "改主意了，看 Q5", "remark": null }
```

**响应 200**：`{ "code": 0, "msg": "到店记录已更新" }`

**错误**

- 422 `未成交时请填写需求`
- 404 `到店记录不存在`

#### 5.2.4 `DELETE /:visit_id`（需鉴权）

只删到店记录，不连带删除关联的成交记录。

```json
{ "code": 0, "msg": "到店记录已删除" }
```

---

### 5.3 成交 `/customers/:customer_id/deals`

每客户可多条成交：车辆和两地牌独立成行，既买车又办牌 = 两条；
不同时间分次成交 = 不同 `deal_time` 的多条。

#### 5.3.1 `GET`（需鉴权）

按 `deal_time IS NULL ASC, deal_time DESC, created_at DESC, id DESC`。

```json
[
  {
    "id": 5,
    "customer_id": 42,
    "deal_type": "vehicle",
    "deal_time": "2026-09-01",
    "amount": 288000.0,
    "vin": "LFV...",
    "vehicle_desc": null,
    "port": null,
    "plate_kind": null,
    "plate_number": null,
    "remark": null,
    "created_at": "2026-09-01T14:00:00"
  },
  {
    "id": 6,
    "customer_id": 42,
    "deal_type": "plate",
    "deal_time": "2026-09-01",
    "amount": null,
    "vin": null,
    "vehicle_desc": null,
    "port": "深圳湾",
    "plate_kind": "现牌",
    "plate_number": "粤Z·12345港",
    "remark": null,
    "created_at": "2026-09-01T14:00:00"
  }
]
```

#### 5.3.2 `POST`（需鉴权）

**字段校验**

| deal_type | 必填字段 |
|---|---|
| `vehicle` | `vin` 或 `vehicle_desc` 至少填一项 |
| `plate`   | `port` 必填；`plate_kind` 可选（期牌 / 现牌）；现牌时 `plate_number` 可填 |

**通用校验**

| 字段 | 校验 |
|---|---|
| `deal_type` | 必须为 `vehicle` 或 `plate`，否则 422 |
| `deal_time` | `YYYY-MM-DD`，空或非法 → 今天 |
| `amount` | 数字；空 → null；非数字 → 422 `amount 必须为数字` |

**侧效（单事务）**

1. INSERT 一条 `customer_deals` 行，返回 `deal_id`
2. 自动生成一条 `is_deal=1` 的到店记录并 `deal_id` 关联本次成交；
   同客户同日若已存在 `is_deal=1` 的到店记录则复用（避免「车+牌」一次到店被重复计数）
3. 客户 `is_priority=0`（自动移出重点列表）、`last_visit_at=now`
4. 历史成交与跟进仍保留可查

**请求示例**

```json
{
  "deal_type": "plate",
  "deal_time": "2026-09-08",
  "port": "深圳湾",
  "plate_kind": "现牌",
  "plate_number": "粤Z·12345港",
  "amount": null,
  "remark": "王经理转介"
}
```

**响应 200**

```json
{ "code": 0, "msg": "成交已记录，已自动登记到店并移出重点列表", "deal_id": 6 }
```

**错误**

- 422 `deal_type 必须为 'vehicle' 或 'plate'`
- 422 `车辆成交需填写车架号或车辆描述`
- 422 `两地牌成交需选择口岸`
- 422 `amount 必须为数字`
- 404 `客户不存在`

#### 5.3.3 `PUT /:deal_id`（需鉴权）

同上字段校验。**注意**：`deal_type` 改变时会清空对方类型的字段，避免脏数据。

```json
{ "code": 0, "msg": "成交已更新" }
```

#### 5.3.4 `DELETE /:deal_id`（需鉴权）

只删成交；不自动恢复重点客户（业务上需手动在面板标注）。

```json
{ "code": 0, "msg": "成交已删除" }
```

## 6. AI 模块 `/customerapi/customers/ai`

### 6.1 `POST /analyze-image`（需鉴权，SSE）

微信截图识别 → 输出结构化联系人。**限流**：默认 30 次/分钟/用户，超出 429。

**入参校验**

| 字段 | 规则 |
|---|---|
| `image_base64` | 必须存在且能 base64 解码，解码后 ≤ 5 MB；magic bytes 必须是 JPEG（`FF D8 FF`）或 PNG（`89 50 4E 47 0D 0A 1A 0A`） |

**响应**：`Content-Type: text/event-stream; charset=utf-8`；帧格式 `data: <json>\n\n`。

**事件帧（按顺序）**

```json
{ "step": "vl_ocr",        "message": "正在識別截圖文字..." }
{ "step": "vl_retry",      "message": "重新識別中..." }                // 仅当首次识别 0 行时
{ "step": "vl_done",       "message": "已識別到 N 行文字" }
{ "step": "complete",      "contacts": [                              // 解析成功
    { "date": "0503", "name": "Dave Lau", "remark": "莲" },
    { "date": "0503", "name": "Ken",      "remark": "" }
  ]
}
{ "step": "empty",         "message": "未識別到聯繫人" }               // 两次识别均 0 行
{ "step": "error",         "message": "處理失敗，請重試" }              // 异常
```

**模型与 Prompt**：使用 `SILICONFLOW_MODEL`（环境变量），系统 prompt 见 `src/utils/aiHelper.js` 的 `VL_SYSTEM_PROMPT`。
支持三类格式：A. 通讯录列表（4 位日期标题）B. 微信搜索结果页（MMDD/姓名）C. 5 位 YMMDD 格式（只取后 4 位）。
返回前会用 `tryFixTruncatedJson` 修复模型偶发的截断 JSON。

### 6.2 `POST /batch-import`（需鉴权）

把 analyze-image 产出的（或手动拼的）联系人批量写入。一次最多 200 条。

**请求体**

```json
{
  "contacts": [
    { "date": "0503", "name": "Dave Lau", "remark": "莲" },
    { "date": "60503", "name": "Ken",     "remark": null }
  ]
}
```

**字段校验**

| 字段 | 规则 |
|---|---|
| `contacts` | 必须为数组，1–200 条 |
| `date` | 必须 4 位 MMDD 或 5 位 YMMDD（5 位时只取后 4 位），月份 01–12，日随月合法 |
| `name` | 非空字符串 |

**写入策略**

- `lead_date`：取 `currentYear-MM-DD`；若该日期在未来则用 `currentYear-1-MM-DD`
- 去重键：`(user_id, lead_date, customer_name)` 唯一索引
  - 命中已存在 → 比对 `is_priority`、`remark`：变了就 UPDATE 计入 `updated`，没变就 SKIP 计入 `skipped`
  - 未命中 → INSERT，计入 `added`
- `is_priority`：若 `remark` 非空 → 1，否则 0

**响应 200**

```json
{
  "added": 18,
  "updated": 2,
  "skipped": 1,
  "skipped_names": ["张三"]
}
```

**错误**

- 422 `contacts 必须是数组且不超过 200 条`
- 422 `日期格式必须为 MMDD 四位数字或 YMMDD 五位数字`
- 422 `月份必须在 01-12 之间`
- 422 `<M>月的日期必须在 01-<D> 之间`

### 6.3 `POST /check-duplicates`（需鉴权）

导入前批量查重（不写入），与 batch-import 的解析 + 去重键完全一致。

**请求体**：同 §6.2。

**响应 200**

```json
{
  "results": [
    { "date": "0503", "name": "Dave Lau", "exists": false },
    { "date": "0503", "name": "Ken",      "exists": true  }
  ]
}
```

### 6.4 `GET /daily-quote`（公开，每日激励语）

调用 SiliconFlow 生成一句话，按 `YYYY-MM-DD` 内存缓存，全员所有用户复用同一句。

**响应 200**

```json
{ "quote": "每天多联系一位客户", "cached": false }
```

- `cached=true` 表示命中当日缓存（次日切换为新一日后会重新生成）
- 模型 prompt 要求：主题围绕汽车销售 / 中港两地牌 / 跟进 / 转化；≤ 18 汉字；无引号 / 表情；空结果会被截断到 30 字符内兜底

## 7. 数据模型 / 输出 Schema

> 所有「行 → JSON」均通过 `src/utils/serialize.js` 统一序列化，时间字段格式见 §1.6。

### 7.1 `CustomerOut`

```json
{
  "id": 42,
  "lead_date": "2026-09-07",          // YYYY-MM-DD
  "customer_name": "张三",
  "is_priority": false,               // boolean（DB 存 0/1，序列化时 !!）
  "remark": null,                     // string | null
  "current_needs": null,              // string | null（v2 上提字段）
  "last_visit_at": "2026-09-07T10:32:11",  // YYYY-MM-DDTHH:mm:ss | null
  "created_at": "2026-09-07T10:32:11"
}
```

### 7.2 `DealOut`

```json
{
  "id": 6,
  "customer_id": 42,
  "deal_type": "plate",               // "vehicle" | "plate"
  "deal_time": "2026-09-01",          // YYYY-MM-DD | null
  "amount": null,                     // number | null
  "vin": null,                        // vehicle 专用
  "vehicle_desc": null,               // vehicle 专用
  "port": "深圳湾",                    // plate 专用；可选：莲塘 / 沙头角 / 港珠澳
  "plate_kind": "现牌",                // plate 专用；"期牌" | "现牌"
  "plate_number": "粤Z·12345港",        // plate + 现牌时填
  "remark": null,
  "created_at": "2026-09-01T14:00:00"
}
```

### 7.3 `FollowupOut`

```json
{
  "id": 12,
  "customer_id": 42,
  "content": "更新需求：想看 A6",
  "created_at": "2026-09-07T15:21:00"
}
```

### 7.4 `VisitOut`

```json
{
  "id": 99,
  "customer_id": 42,
  "visit_time": "2026-09-05",         // YYYY-MM-DD
  "needs": "想看 A6",                  // string | null；未成交到店必填
  "is_deal": false,                   // boolean；true 表示由成交自动生成
  "deal_id": null,                    // number | null；与 customer_deals.id 弱关联
  "remark": null,
  "created_at": "2026-09-05T11:00:00"
}
```

### 7.5 后端表结构（参考）

| 表 | 关键字段 |
|---|---|
| `users` | `id`, `openid`(UNIQUE), `username`(UNIQUE?), `password_hash`, `role`(`user`/`admin`), `nickname`, `avatar_url`, `created_at`, `last_login_at` |
| `customers` | `id`, `user_id`(FK), `lead_date`, `customer_name`, `is_priority`, `remark`, `current_needs`, `last_visit_at`, `created_at`, `updated_at`；唯一索引 `(user_id, lead_date, customer_name)` |
| `customer_deals` | `id`, `customer_id`(FK), `user_id`(FK), `deal_type`(`CHECK IN ('vehicle','plate')`), `deal_time`, `amount`, `vin`, `vehicle_desc`, `port`, `plate_kind`, `plate_number`, `remark`, `created_at`, `updated_at` |
| `customer_followups` | `id`, `customer_id`(FK), `user_id`(FK), `content`, `created_at` |
| `customer_visits` | `id`, `customer_id`(FK), `user_id`(FK), `visit_time`, `needs`, `is_deal`, `deal_id`(弱关联), `remark`, `created_at`, `updated_at` |

PRAGMA：`journal_mode=WAL`，`busy_timeout=5000`，`foreign_keys=ON`。

---

## 8. 业务触发器一览

> 下列副作用全部在 SQLite 事务（`db.transaction(...)`）内执行。

| 触发操作 | 副作用 |
|---|---|
| **未成交到店**（`POST /visits`） | 客户 `is_priority=1`，`remark=needs`，`last_visit_at=now`，追加 followup「到店未成交：…」 |
| **成交**（`POST /deals`） | 客户 `is_priority=0`，`last_visit_at=now`；自动生成一条 `is_deal=1` 的到店记录（同日已存在则复用） |
| **标重点**（`PUT /priority`，`is_priority=true`） | `last_visit_at=now`；如 remark 非空 → 追加 followup |
| **追加 followup**（`POST /followups` 或旧 `PUT /visit`） | 客户 `remark=content`，`last_visit_at=now` |
| **启动时**（`backfillVisits`） | 对「有成交但无 `is_deal=1` 到店」的客户，按其最新一条 `deal_time` 补一条到店 |
| **客户级 needs**（`PUT /needs`） | `current_needs=new`；`followup=true` 时同步追加 followup「更新需求：…」 |

---

## 9. 中间件与安全

| 中间件 | 行为 |
|---|---|
| `cors({ origin: '*' })` | 全放开，仅本地工具调用 |
| `morgan('applog')` | 自定义格式 `:method :url :status - :response-time ms [:asctime]`，扫到的恶意路径 skip |
| `blockScan` | path（解码后）匹配 `/.env`、`/.git`、`/wp-admin`、`/etc/passwd` 等 → 403 `Forbidden` |
| `express.json({ limit: '12mb' })` | body 上限 12 MB（AI base64） |
| `express.static('/avatars')` | `uploads/avatars/` 静态托管 |
| `authRequired` | Bearer JWT 校验；失败 401 `Invalid or expired token` |
| `errorHandler` | 统一 `{ detail }`；`SyntaxError` JSON 解析错 → 400 `请求体不是合法的 JSON`；5xx 不外泄堆栈 |
| AI 限流（`checkRateLimit`） | 内存 map，按 `user_id` 滑动窗口，默认 `60s/30 次` |

---

## 10. 启动 & 部署补充

- 端口：`config.PORT || 9527`
- SQLite 路径：`config.SQLITE_PATH || ./data/customer.db`（启动时自动 `mkdir -p`）
- 启动时自动 `backfillVisits()`（见 §8）；命中 N 条会打日志 `[backfill] 已为 N 位历史成交客户补录到店记录`
- 静态头像写入 `uploads/avatars/<userId>_<unix>.<ext>`
- `morgan` 跳过扫到的恶意路径，避免日志噪音
- 必填环境变量（缺失即启动失败）：`JWT_SECRET_KEY / WX_APPID / WX_SECRET / SILICONFLOW_API_KEY / SILICONFLOW_API_URL / SILICONFLOW_MODEL`（见 `src/config.js`）

## 11. 路由速查表

| Method | Path | Auth | 说明 |
|---|---|---|---|
| GET | `/` | — | 服务运行提示 |
| GET | `/health` | — | 健康检查 `{ status: "ok" }` |
| GET | `/avatars/*` | — | 静态头像 |
| **Auth** | | | |
| POST | `/customerapi/auth/wx-login` | — | 微信登录 |
| POST | `/customerapi/auth/admin-login` | — | 管理员账号登录 |
| POST | `/customerapi/auth/account-login` | — | 用户名+密码登录 |
| POST | `/customerapi/auth/bind-account` | ✓ | 绑定账号密码 |
| **User** | | | |
| GET | `/customerapi/user/info` | ✓ | 当前用户信息 |
| PUT | `/customerapi/user/info` | ✓ | 修改昵称/头像URL（非 admin） |
| POST | `/customerapi/user/avatar` | ✓ | 上传头像图片（非 admin） |
| **Customers · 列表/统计** | | | |
| GET | `/customerapi/customers/stats` | ✓ | 顶部统计 |
| GET | `/customerapi/customers/trend` | ✓ | 趋势（支持 previous 对比） |
| GET | `/customerapi/customers/latest` | ✓ | 最近一天的客户 |
| GET | `/customerapi/customers/priority` | ✓ | 重点客户 |
| GET | `/customerapi/customers/search` | ✓ | 日期/名字搜索 |
| GET | `/customerapi/customers/latest-date` | ✓ | 最近 lead_date |
| GET | `/customerapi/customers/by-date` | ✓ | 按日查询 |
| GET | `/customerapi/customers/calendar` | ✓ | 月度日历 |
| GET | `/customerapi/customers/monthly-stats` | ✓ | 月度柱状 |
| GET | `/customerapi/customers/users/list` | admin | 用户列表 |
| GET | `/customerapi/customers/deal-stats` | ✓ | 成交统计 |
| GET | `/customerapi/customers/deal-list` | ✓ | 按月成交 |
| GET | `/customerapi/customers/visit-list` | ✓ | 按月到店 |
| **Customers · 客户级写** | | | |
| PUT | `/customerapi/customers/:customer_id/needs` | ✓ | 更新当前需求 |
| PUT | `/customerapi/customers/:customer_id/priority` | ✓ | 标注/取消重点 |
| PUT | `/customerapi/customers/:customer_id/visit` | ✓ | 旧回访接口（兼容） |
| **Followups** | | | |
| GET | `/customerapi/customers/:customer_id/followups` | ✓ | 跟进列表 |
| POST | `/customerapi/customers/:customer_id/followups` | ✓ | 新增跟进 |
| **Visits** | | | |
| GET | `/customerapi/customers/:customer_id/visits` | ✓ | 到店列表 |
| POST | `/customerapi/customers/:customer_id/visits` | ✓ | 新增未成交到店 |
| PUT | `/customerapi/customers/:customer_id/visits/:visit_id` | ✓ | 编辑到店 |
| DELETE | `/customerapi/customers/:customer_id/visits/:visit_id` | ✓ | 删除到店 |
| **Deals** | | | |
| GET | `/customerapi/customers/:customer_id/deals` | ✓ | 成交列表 |
| POST | `/customerapi/customers/:customer_id/deals` | ✓ | 新增成交（自动到店+移出重点） |
| PUT | `/customerapi/customers/:customer_id/deals/:deal_id` | ✓ | 编辑成交 |
| DELETE | `/customerapi/customers/:customer_id/deals/:deal_id` | ✓ | 删除成交 |
| **AI** | | | |
| POST | `/customerapi/customers/ai/analyze-image` | ✓ | SSE：截图识别 |
| POST | `/customerapi/customers/ai/batch-import` | ✓ | 批量导入 |
| POST | `/customerapi/customers/ai/check-duplicates` | ✓ | 导入前查重 |
| GET | `/customerapi/customers/ai/daily-quote` | — | 每日激励语 |

---

*本文档与代码同步生成于 2026-09-08；如修改路由或字段请同步更新。*
