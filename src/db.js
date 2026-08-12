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

-- 成交记录（扁平单表：每条为一个成交项；既买车又办牌=两条；分次成交=不同 deal_time 两条）
CREATE TABLE IF NOT EXISTS customer_deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  deal_type TEXT NOT NULL CHECK(deal_type IN ('vehicle','plate')),  -- 车辆 / 两地牌
  deal_time TEXT,        -- 成交时间 YYYY-MM-DD
  amount REAL,           -- 成交金额
  -- 车辆成交专用(deal_type='vehicle')
  vin TEXT,              -- 车架号
  vehicle_desc TEXT,     -- 车辆描述(车型/颜色等,无 VIN 时填此项)
  -- 两地牌专用(deal_type='plate')
  port TEXT,             -- 口岸(深圳湾/莲塘/沙头角/港珠澳)
  plate_kind TEXT,       -- 期牌 / 现牌
  plate_number TEXT,     -- 车牌号码(仅现牌)
  remark TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_deals_customer ON customer_deals(customer_id);
CREATE INDEX IF NOT EXISTS idx_deals_user ON customer_deals(user_id);
CREATE INDEX IF NOT EXISTS idx_deals_type ON customer_deals(deal_type);

-- 跟进/回访历史（一客户多条，追加而非覆盖）
CREATE TABLE IF NOT EXISTS customer_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_followups_customer ON customer_followups(customer_id);
CREATE INDEX IF NOT EXISTS idx_followups_user ON customer_followups(user_id);

-- 到店记录（客户到店事件，与跟进/回访分开）
-- 未成交：写清需求，自动标重点；已成交：可同时生成成交记录并通过 deal_id 关联
CREATE TABLE IF NOT EXISTS customer_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  visit_time TEXT,          -- 到店时间 YYYY-MM-DD（默认今天）
  needs TEXT,               -- 需求（未成交时必填）
  is_deal INTEGER DEFAULT 0,-- 是否成交 0/1
  deal_id INTEGER,          -- 成交时关联的 customer_deals.id（不加 FK，便于成交独立删除）
  remark TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_visits_customer ON customer_visits(customer_id);
CREATE INDEX IF NOT EXISTS idx_visits_user ON customer_visits(user_id);
CREATE INDEX IF NOT EXISTS idx_visits_is_deal ON customer_visits(is_deal);
`);

module.exports = db;
