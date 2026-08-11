// Auth 路由（对齐 MIGRATION_DESIGN §8.1 + Python routers/auth.py）
const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const router = express.Router();

const db = require('../db');
const config = require('../config');
const authRequired = require('../middleware/auth');
const { createAccessToken } = require('../auth');
const { httpError } = require('../middleware/errorHandler');

// ── POST /wx-login ─────────────────────────────────────
router.post('/wx-login', async (req, res, next) => {
  const { code } = req.body || {};
  if (!code) return next(httpError(400, '微信登录失败: code 缺失'));

  let data;
  try {
    const resp = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
      params: {
        appid: config.WX_APPID,
        secret: config.WX_SECRET,
        js_code: code,
        grant_type: 'authorization_code',
      },
      timeout: 10000,
    });
    data = resp.data;
  } catch (e) {
    return next(httpError(400, `微信登录失败: ${e.message}`));
  }

  if (!data || !data.openid) {
    return next(httpError(400, `微信登录失败: ${(data && data.errmsg) || 'unknown error'}`));
  }

  const openid = data.openid;
  let user = db.prepare('SELECT * FROM users WHERE openid = ?').get(openid);

  if (!user) {
    // 新用户：last_login_at 走 DEFAULT
    const info = db.prepare(
      "INSERT INTO users (openid, nickname, avatar_url, role) VALUES (?, '', '', 'user')"
    ).run(openid);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  } else {
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  }

  const token = createAccessToken(user.id, user.openid);
  res.json({
    token,
    user_id: user.id,
    openid: user.openid,
    nickname: user.nickname || '',
    avatar_url: user.avatar_url || '',
    role: user.role || 'user',
    username: user.username || '',
  });
});

// ── POST /admin-login ──────────────────────────────────
router.post('/admin-login', async (req, res, next) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || user.role !== 'admin') {
    return next(httpError(401, '账号或密码错误'));
  }
  const ok = user.password_hash && await bcrypt.compare(password, user.password_hash);
  if (!ok) return next(httpError(401, '账号或密码错误'));

  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = createAccessToken(user.id, user.openid);
  res.json({
    token,
    user_id: user.id,
    username: user.username,
    nickname: user.nickname,
    avatar_url: user.avatar_url,
    role: user.role,
  });
});

// ── POST /bind-account ─────────────────────────────────
router.post('/bind-account', authRequired, async (req, res, next) => {
  const { username, password } = req.body || {};

  // 入参长度校验（方案 A：422 + detail 字符串）
  if (!username || username.length < 3 || username.length > 64) {
    return next(httpError(422, '用户名长度需 3-64 字符'));
  }
  if (!password || password.length < 6 || password.length > 128) {
    return next(httpError(422, '密码长度需 6-128 字符'));
  }

  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing && existing.id !== req.user.id) {
    return next(httpError(400, '该用户名已被占用'));
  }

  const passwordHash = await bcrypt.hash(password, 12); // 对齐 passlib 默认 12 rounds
  db.prepare('UPDATE users SET username = ?, password_hash = ? WHERE id = ?')
    .run(username, passwordHash, req.user.id);

  res.json({ message: '账号绑定成功', username });
});

// ── POST /account-login ────────────────────────────────
router.post('/account-login', async (req, res, next) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user) return next(httpError(401, '账号或密码错误'));
  const ok = user.password_hash && await bcrypt.compare(password, user.password_hash);
  if (!ok) return next(httpError(401, '账号或密码错误'));

  db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  const token = createAccessToken(user.id, user.openid);
  res.json({
    token,
    user_id: user.id,
    openid: user.openid || '',
    nickname: user.nickname || '',
    avatar_url: user.avatar_url || '',
    role: user.role || 'user',
    username: user.username || '',
  });
});

module.exports = router;
