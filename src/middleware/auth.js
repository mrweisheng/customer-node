// 鉴权中间件（对齐 MIGRATION_DESIGN §9.4 get_current_user）
const { decodeAccessToken } = require('../auth');
const { httpError } = require('./errorHandler');
const db = require('../db');

function authRequired(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return next(httpError(401, 'Invalid or expired token'));
  }
  try {
    const payload = decodeAccessToken(auth.slice(7));
    const user = db.prepare('SELECT id,openid,username,role,nickname,avatar_url,created_at,last_login_at FROM users WHERE id = ?').get(+payload.sub);
    if (!user) return next(httpError(401, 'User not found'));
    req.user = user;
    next();
  } catch (e) {
    return next(httpError(401, 'Invalid or expired token'));
  }
}

module.exports = authRequired;
