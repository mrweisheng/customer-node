// 客户管理系统 API（Node.js 版）入口
// 对齐 MIGRATION_DESIGN §9.1 / §9.3 / §6.6
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
// 引入 db 即触发建表 DDL（幂等）
require('./db');
// 启动时自动补录：有成交但无到店的客户，按最新成交日补一条到店（幂等）
const backfillVisits = require('./utils/backfillVisits');
const backfilled = backfillVisits();
if (backfilled > 0) console.log(`[backfill] 已为 ${backfilled} 位历史成交客户补录到店记录`);
const blockScan = require('./middleware/blockScan');
const { MALICIOUS_PATTERNS } = require('./middleware/blockScan');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();

// ── 中间件 ─────────────────────────────────────────────
app.use(cors({ origin: '*', methods: '*', allowedHeaders: '*' }));

// access log + scan-skip reuse MALICIOUS_PATTERNS (aligned with SkipScanFilter)
morgan.token('asctime', () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
});
morgan.format('applog', ':method :url :status - :response-time ms [:asctime]');
app.use(morgan('applog', {
  skip: (req) => {
    let decoded = req.path;
    try { decoded = decodeURIComponent(req.path); } catch {}
    const combined = (req.path + ' ' + decoded).toLowerCase();
    return MALICIOUS_PATTERNS.some((p) => combined.includes(p.toLowerCase()));
  },
}));

// 恶意路径拦截（403）
app.use(blockScan);

// body 解析
app.use(express.json({ limit: '12mb' })); // AI 图片 base64 可能较大
app.use(express.urlencoded({ extended: true }));

// ── 静态文件：头像（路径 /avatars/*）────────────────────
const AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
app.use('/avatars', express.static(AVATAR_DIR));

// ── 根路由 & 健康检查 ───────────────────────────────────
app.get('/', (req, res) => res.json({ msg: '客户管理系统 API 运行中' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── 业务路由（/customerapi 前缀）────────────────────────
app.use('/customerapi/auth', require('./routers/auth'));
app.use('/customerapi/user', require('./routers/user'));
app.use('/customerapi/customers', require('./routers/customers'));
app.use('/customerapi/customers', require('./routers/ai'));

// ── 404 ────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ detail: 'Not Found' });
});

// ── 统一错误处理 ────────────────────────────────────────
app.use(errorHandler);

// ── 启动 ───────────────────────────────────────────────
if (require.main === module) {
  app.listen(config.PORT, config.HOST, () => {
    console.log(`客户管理系统 API 运行中 → http://${config.HOST}:${config.PORT}`);
  });
}

module.exports = app;
