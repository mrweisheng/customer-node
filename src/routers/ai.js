// AI 路由（对齐 MIGRATION_DESIGN §8.5 + Python routers/ai.py）
const express = require('express');
const router = express.Router();

const db = require('../db');
const config = require('../config');
const authRequired = require('../middleware/auth');
const { httpError } = require('../middleware/errorHandler');
const { sse } = require('../utils/sse');
const {
  VL_SYSTEM_PROMPT, callSiliconflow, extractJson, parseSections,
  splitNameRemark, cleanContacts, hasMissingDates, fillMissingDates,
} = require('../utils/aiHelper');

// 内存限流：user_id → 时间戳数组（对齐 ai.py _check_rate_limit）
const rateLimitStore = new Map();
function checkRateLimit(userId) {
  const now = Date.now() / 1000;
  const window = config.AI_RATE_LIMIT_WINDOW;
  const maxCalls = config.AI_RATE_LIMIT_MAX;
  const arr = (rateLimitStore.get(userId) || []).filter((t) => now - t < window);
  if (arr.length >= maxCalls) {
    throw httpError(429, '请求过于频繁，请稍后再试');
  }
  arr.push(now);
  rateLimitStore.set(userId, arr);
}

// ── POST /analyze-image (SSE) ──────────────────────────
router.post('/analyze-image', authRequired, (req, res, next) => {
  try {
    checkRateLimit(req.user.id);
  } catch (e) { return next(e); }

  const { image_base64 } = req.body || {};

  // 入参校验（对齐 schemas.AnalyzeImageRequest）
  let decoded;
  try {
    decoded = Buffer.from(image_base64 || '', 'base64');
  } catch {
    return next(httpError(422, '无效的 base64 编码'));
  }
  if (!image_base64) return next(httpError(422, '无效的 base64 编码'));
  if (decoded.length > 5 * 1024 * 1024) {
    return next(httpError(422, '图片大小不能超过 5MB'));
  }
  // JPEG: FF D8 FF ；PNG: 89 50 4E 47 0D 0A 1A 0A
  const isJpeg = decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isPng = decoded.slice(0, 8).equals(pngSig);
  if (!isJpeg && !isPng) {
    return next(httpError(422, '仅支持 JPEG/PNG 格式图片'));
  }

  // SSE 头
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  (async () => {
    try {
      res.write(sse({ step: 'vl_ocr', message: '正在識別截圖文字...' }));

      const vlMessages = [
        { role: 'system', content: VL_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image_base64}` } },
            { type: 'text', text: '请提取这张截图中的所有文字，按日期分组返回JSON' },
          ],
        },
      ];

      let rawContent = await callSiliconflow(vlMessages, { maxTokens: 8192 });
      let vlParsed = extractJson(rawContent);
      let rawItems = vlParsed ? parseSections(vlParsed) : [];

      if (!rawItems.length) {
        res.write(sse({ step: 'vl_retry', message: '重新識別中...' }));
        rawContent = await callSiliconflow(vlMessages, { maxTokens: 8192 });
        vlParsed = extractJson(rawContent);
        rawItems = vlParsed ? parseSections(vlParsed) : [];
      }

      if (!rawItems.length) {
        res.write(sse({ step: 'empty', message: '未識別到聯繫人' }));
        return res.end();
      }

      res.write(sse({ step: 'vl_done', message: `已識別到 ${rawItems.length} 行文字` }));

      // 本地按 "/" 拆分
      let contacts = [];
      for (const item of rawItems) {
        const [name, remark] = splitNameRemark(item.rawLine);
        if (name) contacts.push({ date: item.date, name, remark });
      }
      contacts = cleanContacts(contacts);
      if (hasMissingDates(contacts)) fillMissingDates(contacts);

      res.write(sse({ step: 'complete', contacts }));
      res.end();
    } catch (e) {
      console.error('[SSE流异常]', e);
      try {
        res.write(sse({ step: 'error', message: '處理失敗，請重試' }));
        res.end();
      } catch {
        // 连接已断开
      }
    }
  })();
});

// ── POST /batch-import ─────────────────────────────────
const MAX_DAYS = { 1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30, 7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31 };

// schema 校验（对齐 Python schemas.ImportContact.validate_date_format）
// 注意：Python 在请求进路由前由 Pydantic 校验，任何一条 date 非法 → 整个请求 422
function validateContactDate(v) {
  let d = String(v || '');
  if (/^\d{5}$/.test(d)) d = d.slice(1); // YMMDD → MMDD
  if (!/^\d{4}$/.test(d)) throw new Error('日期格式必须为 MMDD 四位数字或 YMMDD 五位数字');
  const month = parseInt(d.slice(0, 2), 10);
  const day = parseInt(d.slice(2), 10);
  if (month < 1 || month > 12) throw new Error('月份必须在 01-12 之间');
  if (day < 1 || day > MAX_DAYS[month]) throw new Error(`${month}月的日期必须在 01-${MAX_DAYS[month]} 之间`);
  return d; // 返回规整后的 4 位 MMDD
}

router.post('/batch-import', authRequired, (req, res, next) => {
  const contacts = (req.body || {}).contacts;
  if (!Array.isArray(contacts) || contacts.length > 200) {
    return next(httpError(422, 'contacts 必须是数组且不超过 200 条'));
  }

  // 入口 schema 校验：任一条 date 非法 → 422（对齐 Python Pydantic）
  const normalized = [];
  for (const c of contacts) {
    try {
      const d = validateContactDate(c.date);
      normalized.push({ date: d, name: c.name, remark: c.remark === undefined ? null : c.remark });
    } catch (e) {
      return next(httpError(422, e.message));
    }
  }

  let added = 0, updated = 0, skipped = 0;
  const skippedNames = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const currentYear = today.getFullYear();

  // 解析为 leadDate（格式已校验合法，这里不会抛）
  const parsed = [];
  for (const c of normalized) {
    const month = parseInt(c.date.slice(0, 2), 10);
    const day = parseInt(c.date.slice(2), 10);
    let leadDate = new Date(currentYear, month - 1, day);
    if (leadDate > today) leadDate = new Date(currentYear - 1, month - 1, day);
    parsed.push({
      leadDate: `${leadDate.getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      name: c.name,
      remark: c.remark,
    });
  }

  if (!parsed.length) {
    return res.json({ added: 0, updated: 0, skipped, skipped_names: skippedNames });
  }

  // 查已存在
  const leadDates = [...new Set(parsed.map((p) => p.leadDate))];
  const names = [...new Set(parsed.map((p) => p.name))];
  const placeholdersD = leadDates.map(() => '?').join(',');
  const placeholdersN = names.map(() => '?').join(',');
  const existingRows = db.prepare(
    `SELECT * FROM customers WHERE user_id = ? AND lead_date IN (${placeholdersD}) AND customer_name IN (${placeholdersN})`
  ).all(req.user.id, ...leadDates, ...names);
  const existingMap = new Map();
  for (const r of existingRows) existingMap.set(`${r.lead_date}|${r.customer_name}`, r);

  // 单事务执行全部增删改
  const doImport = db.transaction(() => {
    for (const p of parsed) {
      const key = `${p.leadDate}|${p.name}`;
      const existing = existingMap.get(key);
      const isPriority = p.remark ? 1 : 0;

      if (existing) {
        const newRemark = p.remark !== null ? p.remark : existing.remark;
        if (existing.is_priority !== isPriority || existing.remark !== newRemark) {
          db.prepare('UPDATE customers SET is_priority = ?, remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(isPriority, newRemark, existing.id);
          existing.is_priority = isPriority;
          existing.remark = newRemark;
          updated++;
        } else {
          skipped++;
          skippedNames.push(p.name);
        }
      } else {
        const info = db.prepare(
          'INSERT INTO customers (user_id, lead_date, customer_name, is_priority, remark) VALUES (?, ?, ?, ?, ?)'
        ).run(req.user.id, p.leadDate, p.name, isPriority, p.remark);
        existingMap.set(key, { id: info.lastInsertRowid, lead_date: p.leadDate, customer_name: p.name, is_priority: isPriority, remark: p.remark });
        added++;
      }
    }
  });
  doImport();

  res.json({ added, updated, skipped, skipped_names: skippedNames });
});

module.exports = router;
