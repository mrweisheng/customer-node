// 日期/时间序列化（对齐 MIGRATION_DESIGN §6.1）
// 目标：lead_date → "YYYY-MM-DD"；created_at 等 → "YYYY-MM-DDTHH:mm:ss"（带 T 无 Z 无毫秒）

const pad = (n) => String(n).padStart(2, '0');

// DATE → "YYYY-MM-DD"
function formatDate(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  // SQLite TEXT 通常已是 "YYYY-MM-DD"，原样返回（保险起见取前10位）
  return String(d).slice(0, 10);
}

// DATETIME → "YYYY-MM-DDTHH:mm:ss"
// 兼容三种输入：Date 对象 / "YYYY-MM-DD HH:MM:SS" / "YYYY-MM-DDTHH:mm:ss(.sssZ)"
function formatDateTime(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const s = String(d);
  // 去掉毫秒/时区后缀，把空格替换为 T
  return s.split('.')[0].replace(' ', 'T');
}

// Customer 行 → CustomerOut（字段顺序对齐 Python schemas.CustomerOut）
function serializeCustomer(c) {
  if (!c) return c;
  return {
    id: c.id,
    lead_date: formatDate(c.lead_date),
    customer_name: c.customer_name,
    is_priority: !!c.is_priority,
    remark: (c.remark === null || c.remark === undefined) ? null : c.remark,
    last_visit_at: formatDateTime(c.last_visit_at),
    created_at: formatDateTime(c.created_at),
  };
}

// 成交记录行 → DealOut
function serializeDeal(d) {
  if (!d) return d;
  return {
    id: d.id,
    customer_id: d.customer_id,
    deal_type: d.deal_type,        // 'vehicle' | 'plate'
    deal_time: formatDate(d.deal_time),
    amount: d.amount === null || d.amount === undefined ? null : Number(d.amount),
    vin: d.vin ?? null,
    vehicle_desc: d.vehicle_desc ?? null,
    port: d.port ?? null,
    plate_kind: d.plate_kind ?? null,    // '期牌' | '现牌' | null
    plate_number: d.plate_number ?? null,
    remark: d.remark ?? null,
    created_at: formatDateTime(d.created_at),
  };
}

// 跟进记录行 → FollowupOut
function serializeFollowup(f) {
  if (!f) return f;
  return {
    id: f.id,
    customer_id: f.customer_id,
    content: f.content,
    created_at: formatDateTime(f.created_at),
  };
}

// 到店记录行 → VisitOut
function serializeVisit(v) {
  if (!v) return v;
  return {
    id: v.id,
    customer_id: v.customer_id,
    visit_time: formatDate(v.visit_time),
    needs: v.needs ?? null,
    is_deal: !!v.is_deal,
    deal_id: v.deal_id ?? null,
    remark: v.remark ?? null,
    created_at: formatDateTime(v.created_at),
  };
}

module.exports = { formatDate, formatDateTime, serializeCustomer, serializeDeal, serializeFollowup, serializeVisit };
