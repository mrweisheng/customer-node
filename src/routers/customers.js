// Customers 路由（对齐 MIGRATION_DESIGN §8.3/§8.4 + Python routers/customers.py）
const express = require('express');
const router = express.Router();

const db = require('../db');
const authRequired = require('../middleware/auth');
const { httpError } = require('../middleware/errorHandler');
const { serializeCustomer, serializeDeal, serializeFollowup } = require('../utils/serialize');

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

// 取当前用户名下的客户（用于成交/跟进等写操作的归属校验）
function getOwnedCustomer(customerId, userId) {
  return db.prepare('SELECT * FROM customers WHERE id = ? AND user_id = ?').get(customerId, userId);
}

// 成交时间校验：合法 YYYY-MM-DD 返回原值，否则 null
function normalizeDealTime(v) {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}
// 金额校验：空值→null；数字→Number；非法→抛错
function normalizeAmount(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) throw httpError(422, 'amount 必须为数字');
  return n;
}

// 智能日期解析（用于「日期/名字」精准搜索）
// "0503"(4位月日) → 跨年模糊匹配该月日；"60503"(5位=年份末位+月日) → 就近年份精确匹配
// 返回 { sql, params } 或 null（非 4~5 位数字）
function parseSmartDate(datePart) {
  if (!/^\d{4,5}$/.test(datePart)) return null;
  const mm = datePart.slice(-4, -2);
  const dd = datePart.slice(-2);
  if (datePart.length === 4) {
    // 月日：不限年份，匹配任意年的该月日
    return { sql: ' AND substr(lead_date,6,2)=? AND substr(lead_date,9,2)=?', params: [mm, dd] };
  }
  // 5 位：首位为年份末位，取就近（≤当前年）的年份，精确到年月日
  const yLast = parseInt(datePart[0], 10);
  const currYear = new Date().getFullYear();
  const currLast = currYear % 10;
  const year = currYear - (((currLast - yLast) + 10) % 10);
  return { sql: ' AND lead_date=?', params: [`${year}-${mm}-${dd}`] };
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

    // 「日期/名字」精准搜索：含 / 时拆为日期+名字
    //   4位(如 0503)=月日，跨年模糊；5位(如 60503)=年末位+月日，就近年份精确
    //   日期部分无效时整体回退为纯名字模糊搜
    let namePart = keyword;
    let dateCond = null;
    const slashIdx = keyword.indexOf('/');
    if (slashIdx >= 0) {
      const datePart = keyword.slice(0, slashIdx);
      dateCond = parseSmartDate(datePart);
      if (dateCond) namePart = keyword.slice(slashIdx + 1);
    }

    // LIKE 转义（对齐 §6.5）：\ → \\, % → \%, _ → \_
    const safe = namePart.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const dateSql = dateCond ? dateCond.sql : '';
    const dateParams = dateCond ? dateCond.params : [];
    const rows = db.prepare(
      `SELECT * FROM customers WHERE ${uf.clause}
       AND customer_name LIKE ? ESCAPE '\\'${dateSql}
       ORDER BY lead_date DESC, created_at DESC LIMIT 50`
    ).all(...uf.params, `%${safe}%`, ...dateParams);
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

    // 标注/取消重点：更新标记，备注非空时同时追加一条跟进历史（保证历史完整）
    const remarkText = remark === undefined ? null : remark;
    const tx = db.transaction(() => {
      db.prepare('UPDATE customers SET is_priority = ?, remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(is_priority ? 1 : 0, remarkText, customerId);
      if (remarkText && String(remarkText).trim()) {
        db.prepare('INSERT INTO customer_followups (customer_id, user_id, content) VALUES (?, ?, ?)')
          .run(customerId, req.user.id, `${is_priority ? '标注重点' : '取消重点'}：${String(remarkText).trim()}`);
      }
    });
    tx();
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

    // 兼容旧接口：追加一条跟进历史 + 刷新 customers 缓存（小程序端不改也积累历史、不再丢失）
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO customer_followups (customer_id, user_id, content) VALUES (?, ?, ?)')
        .run(customerId, req.user.id, remark);
      db.prepare('UPDATE customers SET remark = ?, last_visit_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(remark, customerId);
    });
    tx();
    res.json({ code: 0, msg: '回访记录已保存' });
  } catch (e) { next(e); }
});

// ── GET /:customer_id/followups ────────────────────────
// 跟进/回访历史列表（追加式，最新在前）
router.get('/:customer_id/followups', authRequired, (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customer_id, 10);
    if (Number.isNaN(customerId)) return next(httpError(422, 'customer_id 必须是整数'));
    const customer = getOwnedCustomer(customerId, req.user.id);
    if (!customer) return next(httpError(404, '客户不存在'));
    const rows = db.prepare(
      'SELECT * FROM customer_followups WHERE customer_id = ? ORDER BY created_at DESC, id DESC'
    ).all(customerId);
    res.json(rows.map(serializeFollowup));
  } catch (e) { next(e); }
});

// ── POST /:customer_id/followups ───────────────────────
// 追加一条跟进记录（INSERT 历史 + 刷新 customers.remark/last_visit_at 缓存）
router.post('/:customer_id/followups', authRequired, (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customer_id, 10);
    if (Number.isNaN(customerId)) return next(httpError(422, 'customer_id 必须是整数'));
    const { content } = req.body || {};
    if (!content || content.length < 1 || content.length > 2000) {
      return next(httpError(422, 'content 长度需 1-2000 字符'));
    }
    const customer = getOwnedCustomer(customerId, req.user.id);
    if (!customer) return next(httpError(404, '客户不存在'));
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO customer_followups (customer_id, user_id, content) VALUES (?, ?, ?)')
        .run(customerId, req.user.id, content);
      db.prepare('UPDATE customers SET remark = ?, last_visit_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(content, customerId);
    });
    tx();
    res.json({ code: 0, msg: '跟进记录已保存' });
  } catch (e) { next(e); }
});

// ── GET /:customer_id/deals ────────────────────────────
// 成交记录列表（一客户可多条：车辆/两地牌各自独立）
router.get('/:customer_id/deals', authRequired, (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customer_id, 10);
    if (Number.isNaN(customerId)) return next(httpError(422, 'customer_id 必须是整数'));
    const customer = getOwnedCustomer(customerId, req.user.id);
    if (!customer) return next(httpError(404, '客户不存在'));
    const rows = db.prepare(
      `SELECT * FROM customer_deals WHERE customer_id = ?
       ORDER BY (deal_time IS NULL) ASC, deal_time DESC, created_at DESC, id DESC`
    ).all(customerId);
    res.json(rows.map(serializeDeal));
  } catch (e) { next(e); }
});

// 成交字段校验（vehicle/plate 公用）
function validateDealBody(b) {
  const dealType = b.deal_type;
  if (!['vehicle', 'plate'].includes(dealType)) {
    throw httpError(422, "deal_type 必须为 'vehicle' 或 'plate'");
  }
  if (dealType === 'vehicle' && !(b.vin && String(b.vin).trim()) && !(b.vehicle_desc && String(b.vehicle_desc).trim())) {
    throw httpError(422, '车辆成交需填写车架号或车辆描述');
  }
  if (dealType === 'plate' && !(b.port && String(b.port).trim())) {
    throw httpError(422, '两地牌成交需选择口岸');
  }
  return {
    deal_type: dealType,
    deal_time: normalizeDealTime(b.deal_time),
    amount: normalizeAmount(b.amount),
    // 按 deal_type 只保留对应类型字段，另一类型字段强制清空，避免切换类型残留脏数据
    vin: dealType === 'vehicle' ? (b.vin || null) : null,
    vehicle_desc: dealType === 'vehicle' ? (b.vehicle_desc || null) : null,
    port: dealType === 'plate' ? (b.port || null) : null,
    plate_kind: dealType === 'plate' ? (b.plate_kind || null) : null,
    plate_number: dealType === 'plate' ? (b.plate_number || null) : null,
    remark: b.remark || null,
  };
}

// ── POST /:customer_id/deals ───────────────────────────
// 新增一条成交（车辆或两地牌）；成交后自动取消重点
router.post('/:customer_id/deals', authRequired, (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customer_id, 10);
    if (Number.isNaN(customerId)) return next(httpError(422, 'customer_id 必须是整数'));
    const customer = getOwnedCustomer(customerId, req.user.id);
    if (!customer) return next(httpError(404, '客户不存在'));
    const d = validateDealBody(req.body || {});
    const tx = db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO customer_deals
         (customer_id, user_id, deal_type, deal_time, amount, vin, vehicle_desc, port, plate_kind, plate_number, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(customerId, req.user.id, d.deal_type, d.deal_time, d.amount, d.vin, d.vehicle_desc,
        d.port, d.plate_kind, d.plate_number, d.remark);
      // 成交即转化：自动移出重点客户列表（历史成交与跟进仍保留可查）
      db.prepare('UPDATE customers SET is_priority = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(customerId);
      return info.lastInsertRowid;
    });
    const dealId = tx();
    res.json({ code: 0, msg: '成交已记录，已自动移出重点列表', deal_id: dealId });
  } catch (e) { next(e); }
});

// ── PUT /:customer_id/deals/:deal_id ───────────────────
// 编辑某条成交
router.put('/:customer_id/deals/:deal_id', authRequired, (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customer_id, 10);
    const dealId = parseInt(req.params.deal_id, 10);
    if (Number.isNaN(customerId) || Number.isNaN(dealId)) return next(httpError(422, 'id 必须是整数'));
    const customer = getOwnedCustomer(customerId, req.user.id);
    if (!customer) return next(httpError(404, '客户不存在'));
    const deal = db.prepare('SELECT * FROM customer_deals WHERE id = ? AND customer_id = ? AND user_id = ?')
      .get(dealId, customerId, req.user.id);
    if (!deal) return next(httpError(404, '成交记录不存在'));
    const d = validateDealBody(req.body || {});
    db.prepare(
      `UPDATE customer_deals SET deal_type=?, deal_time=?, amount=?, vin=?, vehicle_desc=?, port=?, plate_kind=?, plate_number=?, remark=?, updated_at=CURRENT_TIMESTAMP WHERE id = ?`
    ).run(d.deal_type, d.deal_time, d.amount, d.vin, d.vehicle_desc, d.port, d.plate_kind, d.plate_number, d.remark, dealId);
    res.json({ code: 0, msg: '成交已更新' });
  } catch (e) { next(e); }
});

// ── DELETE /:customer_id/deals/:deal_id ────────────────
// 删除某条成交（不自动恢复重点，如需恢复请在面板手动标注）
router.delete('/:customer_id/deals/:deal_id', authRequired, (req, res, next) => {
  try {
    const customerId = parseInt(req.params.customer_id, 10);
    const dealId = parseInt(req.params.deal_id, 10);
    if (Number.isNaN(customerId) || Number.isNaN(dealId)) return next(httpError(422, 'id 必须是整数'));
    const customer = getOwnedCustomer(customerId, req.user.id);
    if (!customer) return next(httpError(404, '客户不存在'));
    const info = db.prepare('DELETE FROM customer_deals WHERE id = ? AND customer_id = ? AND user_id = ?')
      .run(dealId, customerId, req.user.id);
    if (info.changes === 0) return next(httpError(404, '成交记录不存在'));
    res.json({ code: 0, msg: '成交已删除' });
  } catch (e) { next(e); }
});

module.exports = router;
