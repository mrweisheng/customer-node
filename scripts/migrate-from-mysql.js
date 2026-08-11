// 一次性数据迁移：MySQL → SQLite（对齐 MIGRATION_DESIGN §7.4）
// 设计为一次性运行；重跑前请先删除 data/customer.db
require('dotenv').config();
const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ── 日期格式规整（定义在调用前，避免阅读时找不到实现）──────────────
// 注意：用 UTC（getUTC*）而非本地时间。原 MySQL created_at 由 server now() 写入，
// 配合下方 timezone:'+00:00'，驱动返回的 Date 对象是 UTC 时刻，用 UTC 取值可防 tz 漂移。
const pad = (n) => String(n).padStart(2, '0');

// DATE → 'YYYY-MM-DD'（取前10位，兼容已是字符串的情况）
function fmtD(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  return String(v).slice(0, 10);
}

// DATETIME → 'YYYY-MM-DD HH:MM:SS'（SQLite CURRENT_TIMESTAMP 格式）
function norm(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ` +
           `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
  }
  return String(v).replace('T', ' ').split('.')[0]; // 去毫秒/时区
}

(async () => {
  const dbPath = path.resolve(process.cwd(), process.env.SQLITE_PATH || './data/customer.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  // 如果目标库已存在数据，拒绝运行（防误覆盖）
  if (fs.existsSync(dbPath)) {
    const probe = new Database(dbPath, { readonly: true });
    try {
      const n = probe.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name IN ('users','customers')").get();
      if (n.c > 0) {
        const rows = probe.prepare('SELECT count(*) c FROM users').get().c + probe.prepare('SELECT count(*) c FROM customers').get().c;
        if (rows > 0) {
          throw new Error(`目标库已存在数据（${rows} 行）。如需重跑迁移，请先删除 ${dbPath}`);
        }
      }
    } finally { probe.close(); }
  }

  const mdb = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: +process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DB,
    charset: 'utf8mb4',
    timezone: '+00:00', // 让驱动以 UTC 返回 Date，配合 norm() 的 getUTC*
  });

  const sdb = new Database(dbPath);
  sdb.pragma('journal_mode = WAL');
  sdb.pragma('foreign_keys = ON'); // ★ 启用外键（SQLite 默认关闭）

  // 执行建表 DDL（与 src/db.js 一致）
  sdb.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  openid TEXT NOT NULL UNIQUE,
  username TEXT UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  nickname TEXT DEFAULT '',
  avatar_url TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_openid ON users(openid);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lead_date TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  is_priority INTEGER DEFAULT 0,
  remark TEXT,
  last_visit_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_lead_name ON customers(user_id, lead_date, customer_name);
CREATE INDEX IF NOT EXISTS ix_customers_user_id ON customers(user_id);
CREATE INDEX IF NOT EXISTS ix_customers_lead_date ON customers(lead_date);
CREATE INDEX IF NOT EXISTS ix_customers_is_priority ON customers(is_priority);
`);

  const insertUser = sdb.prepare(
    'INSERT OR REPLACE INTO users(id,openid,username,password_hash,role,nickname,avatar_url,created_at,last_login_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  const insertCust = sdb.prepare(
    'INSERT OR REPLACE INTO customers(id,user_id,lead_date,customer_name,is_priority,remark,last_visit_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
  );

  // 一次性拉取两表数据
  const [users] = await mdb.query('SELECT id,openid,username,password_hash,role,nickname,avatar_url,created_at,last_login_at FROM users');
  const [custs] = await mdb.query('SELECT id,user_id,lead_date,customer_name,is_priority,remark,last_visit_at,created_at,updated_at FROM customers');

  // ★ 外层事务：users + customers 一起提交，任一失败整体回滚，不留半截数据
  const migrateAll = sdb.transaction(() => {
    for (const r of users) {
      insertUser.run(r.id, r.openid, r.username, r.password_hash, r.role || 'user',
                     r.nickname || '', r.avatar_url || '', norm(r.created_at), norm(r.last_login_at));
    }
    for (const r of custs) {
      insertCust.run(r.id, r.user_id, fmtD(r.lead_date), r.customer_name, r.is_priority ? 1 : 0,
                     r.remark, norm(r.last_visit_at), norm(r.created_at), norm(r.updated_at));
    }
  });
  migrateAll();

  // ★ 行数断言校验（不一致即抛错）
  const [u] = await mdb.query('SELECT COUNT(*) c FROM users');
  const [c] = await mdb.query('SELECT COUNT(*) c FROM customers');
  const u2 = sdb.prepare('SELECT COUNT(*) c FROM users').get().c;
  const c2 = sdb.prepare('SELECT COUNT(*) c FROM customers').get().c;
  console.log(`users: ${u[0].c} → ${u2}`);
  console.log(`customers: ${c[0].c} → ${c2}`);
  if (u[0].c !== u2 || c[0].c !== c2) {
    throw new Error(`行数校验失败：users ${u[0].c}→${u2}, customers ${c[0].c}→${c2}`);
  }

  await mdb.end();
  sdb.close();
  console.log('迁移完成');
})().catch((e) => { console.error('迁移失败:', e.message); process.exit(1); });
