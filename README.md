# customerbackend-node

客户管理系统 API 的 Node.js 版本，迁移自 Python FastAPI。
设计文档见上级目录 `MIGRATION_DESIGN.md`。

## 环境要求

- Node.js ≥ 18（推荐 20 LTS）

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
#   编辑 .env：填入 JWT_SECRET_KEY（必须与原 Python 后台一致）、WX_*、SILICONFLOW_* 等

# 3.（首次）迁移原 MySQL 数据到 SQLite
#    .env 里同时填好 MYSQL_* 连接信息
npm run migrate

# 4. 启动
npm start            # 生产
npm run dev          # 开发热重载
```

启动后访问 `http://localhost:9527/health` 应返回 `{"status":"ok"}`。

## 与原 Python 后台的兼容性

- 端口、API 路径、出入参结构完全一致，前端零改动
- JWT：同 secret + HS256，旧 token 可继续用
- 密码：bcrypt，旧 hash 可继续验证
- 数据库：由 MySQL 切换为本地 SQLite（`data/customer.db`）

详见 `MIGRATION_DESIGN.md` 第十二节验证清单。

## 目录结构

```
src/
├── app.js              # 入口
├── config.js           # 读 .env
├── db.js               # better-sqlite3 + 建表
├── auth.js             # JWT 工具
├── middleware/         # blockScan / authRequired / errorHandler
├── utils/              # serialize 等
└── routers/            # （P1 起）auth / user / customers / ai
scripts/
└── migrate-from-mysql.js  # 一次性迁移
```
