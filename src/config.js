require('dotenv').config();

// 必填字段：缺失则在启动时即崩，避免到请求时才报莫名错误
const REQUIRED = [
  'JWT_SECRET_KEY',
  'WX_APPID',
  'WX_SECRET',
  'SILICONFLOW_API_KEY',
  'SILICONFLOW_API_URL',
  'SILICONFLOW_MODEL',
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  throw new Error(`[config] 缺少必填环境变量: ${missing.join(', ')}（请参考 .env.example 填写 .env）`);
}

const config = {
  // 服务监听
  HOST: process.env.HOST || '0.0.0.0',
  PORT: parseInt(process.env.PORT, 10) || 9527,

  // SQLite
  SQLITE_PATH: process.env.SQLITE_PATH || './data/customer.db',

  // JWT
  JWT_SECRET_KEY: process.env.JWT_SECRET_KEY,
  JWT_ALGORITHM: 'HS256',
  JWT_EXPIRE_DAYS: parseInt(process.env.JWT_EXPIRE_DAYS, 10) || 15, // 对齐原 .env

  // 微信
  WX_APPID: process.env.WX_APPID,
  WX_SECRET: process.env.WX_SECRET,

  // SiliconFlow AI
  SILICONFLOW_API_KEY: process.env.SILICONFLOW_API_KEY,
  SILICONFLOW_API_URL: process.env.SILICONFLOW_API_URL,
  SILICONFLOW_MODEL: process.env.SILICONFLOW_MODEL,

  // AI 限流
  AI_RATE_LIMIT_WINDOW: parseInt(process.env.AI_RATE_LIMIT_WINDOW, 10) || 60,
  AI_RATE_LIMIT_MAX: parseInt(process.env.AI_RATE_LIMIT_MAX, 10) || 30,
};

module.exports = config;
