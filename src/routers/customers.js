// Customers 路由（对齐 MIGRATION_DESIGN §8.3/§8.4 + Python routers/customers.py）
const express = require('express');
const router = express.Router();

const db = require('../db');
const authRequired = require('../middleware/auth');
const { httpError } = require('../middleware/errorHandler');
const { serializeCustomer } = require('../utils/serialize');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const md = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function monthDays(y, m) { return new Date(y, m, 0).getDate(); } // m: 1-12，返回该月天数

// 统一构造 user_filter 的 SQL 片段 + 参数（对齐 Python 的 user_filter 逻辑）
// 返回 { clause, params }；clause 为 "1=1" 表示全部
function buildUserFilter(user, targetUserId) {
  if (user.role !== 'admin' && targetUserId !== undefined && targetUserId !== null) {
    throw httpError(403, '权限不足');
  }
  if (user.role === 'admin' && targetUserId !== undefined && targetUserId !== null) {
    return { clause: 'user_id = ?', params: [targetUserId] };
  }
  if (user.role === 'admin') {
    return { clause: '1=1', params: [] };
  }
  return { clause: 'user_id = ?', params: [user.id] };
}

// 查询参数解析（空字符串视为未传，对齐 FastAPI Query(None)）
function optInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

// ── GET /stats ─────────────────────────────────────────
router.get('/stats', authRequired, (req, res, next) => {
  try {
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const yesterday = addDays(today, -1);

    // 上月同期：prevMonth 统一用 1-based（1=一月）
    const curMonth1 = today.getMonth() + 1; // 当前月 1-based
    let prevYear, prevMonth; // prevMonth 为 1-based
    if (curMonth1 === 1) { prevYear = today.getFullYear() - 1; prevMonth = 12; }
    else { prevYear = today.getFullYear(); prevMonth = curMonth1 - 1; }

    let lastMonthSameDay, lastMonthStart;
    if (today.getDate() > 1) {
      lastMonthSameDay = new Date(prevYear, prevMonth - 1, today.getDate());
      lastMonthStart = new Date(prevYear, prevMonth - 1, 1);
    } else {
      const lastDay = monthDays(prevYear, prevMonth);
      lastMonthSameDay = new Date(prevYear, prevMonth - 1, lastDay);
      lastMonthStart = new Date(prevYear, prevMonth - 1, 1);
    }
    const lastDayOfPrevMonth = monthDays(prevYear, prevMonth);

    const agg = db.prepare(
      `SELECT
         SUM(CASE WHEN lead_date >= ? THEN 1 ELSE 0 END) AS a,
         SUM(CASE WHEN lead_date = ? THEN 1 ELSE 0 END) AS b,
         SUM(CASE WHEN is_priority IS TRUE THEN 1 ELSE 0 END) AS c
       FROM customers WHERE ${uf.clause}`
    ).get(ymd(monthStart), ymd(yesterday), ...uf.params);

    const total = db.prepare(`SELECT COUNT(*) AS c FROM customers WHERE ${uf.clause}`).get(...uf.params).c;
    const lastMonthCount = db.prepare(
      `SELECT COUNT(*) AS c FROM customers WHERE ${uf.clause} AND lead_date >= ? AND lead_date <= ?`
    ).get(...uf.params, ymd(lastMonthStart), ymd(lastMonthSameDay)).c;
    const lastMonthSameDayCount = db.prepare(
      `SELECT COUNT(*) AS c FROM customers WHERE ${uf.clause} AND lead_date = ?`
    ).get(...uf.params, ymd(lastMonthSameDay)).c;
    const lastMonthTotal = db.prepare(
      `SELECT COUNT(*) AS c FROM customers WHERE ${uf.clause} AND lead_date >= ? AND lead_date <= ?`
    ).get(...uf.params, ymd(lastMonthStart), `${prevYear}-${pad(prevMonth)}-${pad(lastDayOfPrevMonth)}`).c;

    res.json({
      month_count: agg.a || 0,
      yesterday_count: agg.b || 0,
      priority_count: agg.c || 0,
      total_count: total,
      last_month_count: lastMonthCount,
      last_month_total: lastMonthTotal,
      last_month_same_day: lastMonthSameDayCount,
    });
  } catch (e) { next(e); }
});

// ── GET /trend ─────────────────────────────────────────
router.get('/trend', authRequired, (req, res, next) => {
  try {
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);
    let days = parseInt(req.query.days, 10);
    if (Number.isNaN(days)) days = 7;
    days = Math.min(90, Math.max(1, days));
    const previous = req.query.previous === undefined ? true : req.query.previous !== 'false';

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const startDate = addDays(today, -(days - 1));

    const rows = db.prepare(
      `SELECT lead_date, COUNT(*) AS c FROM customers
       WHERE ${uf.clause} AND lead_date >= ? AND lead_date <= ?
       GROUP BY lead_date`
    ).all(...uf.params, ymd(startDate), ymd(today));
    const countMap = {};
    for (const r of rows) countMap[r.lead_date] = r.c;

    const dates = [], counts = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(startDate, i);
      dates.push(md(d));
      counts.push(countMap[ymd(d)] || 0);
    }

    const prevDates = [], prevCounts = [];
    if (previous) {
      const prevStart = addDays(startDate, -days);
      const prevEnd = addDays(startDate, -1);
      const prevRows = db.prepare(
        `SELECT lead_date, COUNT(*) AS c FROM customers
         WHERE ${uf.clause} AND lead_date >= ? AND lead_date <= ?
         GROUP BY lead_date`
      ).all(...uf.params, ymd(prevStart), ymd(prevEnd));
      const prevMap = {};
      for (const r of prevRows) prevMap[r.lead_date] = r.c;
      for (let i = 0; i < days; i++) {
        const d = addDays(prevStart, i);
        prevDates.push(md(d));
        prevCounts.push(prevMap[ymd(d)] || 0);
      }
    }

    res.json({ dates, counts, prev_dates: prevDates, prev_counts: prevCounts });
  } catch (e) { next(e); }
});

// ── GET /latest ────────────────────────────────────────
router.get('/latest', authRequired, (req, res, next) => {
  try {
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);
    const latest = db.prepare(
      `SELECT * FROM customers WHERE ${uf.clause}
       ORDER BY lead_date DESC, created_at DESC LIMIT 50`
    ).all(...uf.params);

    if (!latest.length) return res.json({ lead_date_str: '', customers: [] });

    const latestDate = latest[0].lead_date; // "YYYY-MM-DD"
    const dayCustomers = latest.filter((c) => c.lead_date === latestDate);
    // lead_date_str = MMDD
    const leadDateStr = latestDate.slice(5).replace('-', '');
    res.json({ lead_date_str: leadDateStr, customers: dayCustomers.map(serializeCustomer) });
  } catch (e) { next(e); }
});

// ── GET /priority ──────────────────────────────────────
router.get('/priority', authRequired, (req, res, next) => {
  try {
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);
    const rows = db.prepare(
      `SELECT * FROM customers WHERE ${uf.clause} AND is_priority IS TRUE
       ORDER BY (last_visit_at IS NULL) DESC, last_visit_at ASC, lead_date DESC`
    ).all(...uf.params);
    res.json(rows.map(serializeCustomer));
  } catch (e) { next(e); }
});

// ── GET /search ────────────────────────────────────────
router.get('/search', authRequired, (req, res, next) => {
  try {
    const keyword = req.query.keyword;
    if (!keyword || keyword.length < 1) return next(httpError(422, 'keyword 必填'));
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);

    // LIKE 转义（对齐 §6.5）：\ → \\, % → \%, _ → \_
    const safe = keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const rows = db.prepare(
      `SELECT * FROM customers WHERE ${uf.clause}
       AND customer_name LIKE ? ESCAPE '\\'
       ORDER BY lead_date DESC, created_at DESC LIMIT 50`
    ).all(...uf.params, `%${safe}%`);
    res.json(rows.map(serializeCustomer));
  } catch (e) { next(e); }
});

// ── GET /latest-date ───────────────────────────────────
router.get('/latest-date', authRequired, (req, res, next) => {
  try {
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);
    const row = db.prepare(`SELECT MAX(lead_date) AS m FROM customers WHERE ${uf.clause}`).get(...uf.params);
    res.json({ latest_date: row.m || null });
  } catch (e) { next(e); }
});

// ── GET /by-date ───────────────────────────────────────
router.get('/by-date', authRequired, (req, res, next) => {
  try {
    const dateParam = req.query.date;
    if (!dateParam) return next(httpError(422, 'date 必填'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return next(httpError(422, 'date 格式应为 YYYY-MM-DD'));
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);
    const rows = db.prepare(
      `SELECT * FROM customers WHERE ${uf.clause} AND lead_date = ?
       ORDER BY created_at DESC`
    ).all(...uf.params, dateParam);
    // 返回 date 字段是 MM-DD
    const d = new Date(dateParam + 'T00:00:00');
    res.json({ date: md(d), customers: rows.map(serializeCustomer) });
  } catch (e) { next(e); }
});

// ── GET /calendar ──────────────────────────────────────
router.get('/calendar', authRequired, (req, res, next) => {
  try {
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let year = parseInt(req.query.year, 10);
    let month = parseInt(req.query.month, 10);
    if (Number.isNaN(year) || year === 0) year = today.getFullYear();
    if (Number.isNaN(month) || month === 0) month = today.getMonth() + 1;

    const lastDay = monthDays(year, month);
    const monthStart = `${year}-${pad(month)}-01`;
    const monthEnd = `${year}-${pad(month)}-${pad(lastDay)}`;
    const rows = db.prepare(
      `SELECT DISTINCT lead_date FROM customers
       WHERE ${uf.clause} AND lead_date >= ? AND lead_date <= ?`
    ).all(...uf.params, monthStart, monthEnd);
    const active = new Set(rows.map((r) => r.lead_date));

    const days = [];
    let updatedCount = 0, missedCount = 0;
    for (let dayNum = 1; dayNum <= lastDay; dayNum++) {
      const dStr = `${year}-${pad(month)}-${pad(dayNum)}`;
      const d = new Date(dStr + 'T00:00:00');
      let status;
      if (d > today) status = 'future';
      else if (active.has(dStr)) { status = 'updated'; updatedCount++; }
      else { status = 'missed'; missedCount++; }
      days.push({ day: dayNum, status });
    }
    const totalDays = updatedCount + missedCount;
    const updateRate = totalDays > 0 ? Math.round((updatedCount / totalDays) * 1000) / 10 : 0.0;

    res.json({ year, month, days, updated_count: updatedCount, missed_count: missedCount, update_rate: updateRate });
  } catch (e) { next(e); }
});

// ── GET /monthly-stats ─────────────────────────────────
router.get('/monthly-stats', authRequired, (req, res, next) => {
  try {
    const targetUserId = optInt(req.query.target_user_id);
    const uf = buildUserFilter(req.user, targetUserId);
    let months = parseInt(req.query.months, 10);
    if (Number.isNaN(months)) months = 6;
    months = Math.min(12, Math.max(1, months));

    const today = new Date();
    const monthLabels = [], monthCounts = [];
    for (let i = months - 1; i >= 0; i--) {
      // 对齐 Python customers.py:456-461 的跨年补偿
      let year, month;
      if (today.getMonth() + 1 - i > 0) {
        year = today.getFullYear();
        month = today.getMonth() + 1 - i;
      } else {
        const yearOffset = Math.floor((today.getMonth() + 1 - i - 1) / 12);
        year = today.getFullYear() + yearOffset;
        month = today.getMonth() + 1 - i - yearOffset * 12;
      }
      const endDay = (month === today.getMonth() + 1 && year === today.getFullYear())
        ? today.getDate()
        : monthDays(year, month);
      const start = `${year}-${pad(month)}-01`;
      const end = `${year}-${pad(month)}-${pad(endDay)}`;
      const cnt = db.prepare(
        `SELECT COUNT(*) AS c FROM customers WHERE ${uf.clause} AND lead_date >= ? AND lead_date <= ?`
      ).get(...uf.params, start, end).c;
      monthLabels.push(`${year}-${pad(month)}`);
      monthCounts.push(cnt);
    }
    res.json({ months: monthLabels, counts: monthCounts });
  } catch (e) { next(e); }
});

// ── GET /users/list ────────────────────────────────────
router.get('/users/list', authRequired, (req, res, next) => {
  try {
    if (req.user.role !== 'admin') return next(httpError(403, '权限不足'));
    const rows = db.prepare("SELECT id, nickname FROM users WHERE role = 'user'").all();
    res.json(rows);
  } catch (e) { next(e); }
});

// ── PUT /:customer_id/priority ─────────────────────────
router.put('/:customer_id/priority', authRequired, (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customer_id, 10);
    if (Number.isNaN(customerId)) return next(httpError(422, 'customer_id 必须是整数'));
    const { is_priority, remark } = req.body || {};
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND user_id = ?').get(customerId, req.user.id);
    if (!customer) return next(httpError(404, '客户不存在'));

    db.prepare('UPDATE customers SET is_priority = ?, remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(is_priority ? 1 : 0, remark === undefined ? null : remark, customerId);
    res.json({ code: 0, msg: '更新成功' });
  } catch (e) { next(e); }
});

// ── PUT /:customer_id/visit ────────────────────────────
router.put('/:customer_id/visit', authRequired, (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customer_id, 10);
    if (Number.isNaN(customerId)) return next(httpError(422, 'customer_id 必须是整数'));
    const { remark } = req.body || {};
    if (!remark || remark.length < 1 || remark.length > 2000) {
      return next(httpError(422, 'remark 长度需 1-2000 字符'));
    }
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND user_id = ?').get(customerId, req.user.id);
    if (!customer) return next(httpError(404, '客户不存在'));

    db.prepare('UPDATE customers SET remark = ?, last_visit_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(remark, customerId);
    res.json({ code: 0, msg: '回访记录已保存' });
  } catch (e) { next(e); }
});

module.exports = router;
