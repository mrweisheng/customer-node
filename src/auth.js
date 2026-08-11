// JWT 工具（对齐 MIGRATION_DESIGN §6.2）
const jwt = require('jsonwebtoken');
const config = require('./config');

// 签发：payload = { sub: String(userId), openid }，HS256
function createAccessToken(userId, openid) {
  return jwt.sign(
    { sub: String(userId), openid },
    config.JWT_SECRET_KEY,
    { algorithm: 'HS256', expiresIn: `${config.JWT_EXPIRE_DAYS}d` }
  );
}

// 校验：返回 payload（含 sub 字符串、openid、exp）
function decodeAccessToken(token) {
  return jwt.verify(token, config.JWT_SECRET_KEY, { algorithms: ['HS256'] });
}

module.exports = { createAccessToken, decodeAccessToken };
