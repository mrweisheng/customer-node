const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

// 确保 data 目录存在
const dbPath = path.resolve(process.cwd(), config.SQLITE_PATH);
const dbDir = path.dirname(dbPath);
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

// 性能与约束：WAL（读写并发，仅写写互斥）+ busy_timeout（写冲突排队）+ 外键
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

// ── 建表 DDL（幂等，对齐 MIGRATION_DESIGN §5.3）──────────────
db.exec(`
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

module.exports = db;
