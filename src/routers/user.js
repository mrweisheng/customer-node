// User 路由（对齐 MIGRATION_DESIGN §8.2 + Python routers/user.py）
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();

const db = require('../db');
const authRequired = require('../middleware/auth');
const { httpError } = require('../middleware/errorHandler');

const AVATAR_DIR = path.join(__dirname, '..', '..', 'uploads', 'avatars');
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const MAX_AVATAR_SIZE = 2 * 1024 * 1024;

// multer：内存存储，路由内主动校验大小/扩展名，保证返回中文 detail
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_SIZE },
});

// ── POST /avatar ───────────────────────────────────────
router.post('/avatar', authRequired, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(httpError(400, '文件大小不能超过 2MB'));
      return next(httpError(400, err.message || '上传失败'));
    }
    next();
  });
}, async (req, res, next) => {
  if (req.user.role === 'admin') {
    return next(httpError(403, '管理员不允许修改头像'));
  }
  if (!req.file) {
    return next(httpError(400, '未上传文件'));
  }

  // 扩展名白名单（无扩展名默认 .jpg）
  let ext = path.extname(req.file.originalname || '.jpg').toLowerCase() || '.jpg';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return next(httpError(400, `不支持的文件类型: ${ext}`));
  }
  // 大小校验
  if (req.file.size > MAX_AVATAR_SIZE) {
    return next(httpError(400, '文件大小不能超过 2MB'));
  }

  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const filename = `${req.user.id}_${Math.floor(Date.now() / 1000)}${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, filename), req.file.buffer);

  const avatarUrl = `/avatars/${filename}`;
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, req.user.id);

  res.json({ avatar_url: avatarUrl });
});

// ── GET /info ──────────────────────────────────────────
router.get('/info', authRequired, (req, res) => {
  res.json({
    id: req.user.id,
    nickname: req.user.nickname,
    avatar_url: req.user.avatar_url,
  });
});

// ── PUT /info ──────────────────────────────────────────
router.put('/info', authRequired, (req, res, next) => {
  if (req.user.role === 'admin') {
    return next(httpError(403, '管理员不允许修改个人信息'));
  }
  const { nickname, avatar_url } = req.body || {};

  // 仅更新非空字段
  if (nickname !== undefined && nickname !== null) {
    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, req.user.id);
  }
  if (avatar_url !== undefined && avatar_url !== null) {
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatar_url, req.user.id);
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({
    id: user.id,
    nickname: user.nickname,
    avatar_url: user.avatar_url,
  });
});

module.exports = router;
