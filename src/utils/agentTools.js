// 「客资助手」agent 可调用的工具定义与执行器
// 设计原则：
//   - LLM 只读不写：写入数据库必须由前端用户点击确认后调 /batch-import
//   - 单工具原则：识别 + 查重合并为 submit_recognition_result
//     （M3 直接看图识别，后端只负责格式校验 + 查重）
//   - 日期校验/查重复用 utils/dateRules + 数据库查重，与 ai.js 的 batch-import 一致
const db = require('../db');
const { validateContactDate, parseLeadDate } = require('./dateRules');
// ── 工具 schema（OpenAI 兼容格式）───────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'submit_recognition_result',
      description:
        '提交你从截图中识别到的联系人列表。系统会自动校验日期、按 (user, lead_date, name) 去重，并把 ' +
        '查重结果告诉你。提交后请用简短的中文回复用户：「识别到 N 位，其中 M 位已存在，请点击右下角确认按钮导入」。' +
        '若全部联系人都已存在（fresh = 0），则回复「这 N 位客户均已存在，无需重复导入」，并提示可点击卡片按钮结束对话，' +
        '**绝不要**引导用户点击确认导入，也**绝不要**自己发起写入。',
      parameters: {
        type: 'object',
        properties: {
          contacts: {
            type: 'array',
            description: '从截图中识别到的联系人（已剥掉日期前缀）',
            items: {
              type: 'object',
              properties: {
                date: {
                  type: 'string',
                  description: '日期 MMDD 四位（如 "0503"）或 YMMDD 五位（如 "60701"，只取后 4 位）',
                },
                name: { type: 'string', description: '客户姓名（已剥掉 "MMDD/" 前缀）' },
                remark: {
                  type: 'string',
                  description: '"/" 后面的备注（如 "莲塘"），无则空字符串',
                },
              },
              required: ['name'],
            },
          },
        },
        required: ['contacts'],
      },
    },
  },
];
// ── 日期校验/解析：统一复用 utils/dateRules（与 ai.js 的 batch-import 完全一致）──
// ── 工具执行器：submit_recognition_result ──────────────────────
// 返回值会作为 tool 消息回填到 LLM，同时通过 SSE pending_import 事件
// 把规整后的 contacts 推给前端，用于「确认导入」按钮的回填。
function executeSubmitRecognition({ userId, args, emit }) {
  const raw = Array.isArray(args?.contacts) ? args.contacts : [];
  // 1) 格式校验 + 规整
  const normalized = [];
  const errors = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] || {};
    const name = String(c.name || '').trim();
    if (!name) {
      errors.push({ index: i, reason: '姓名为空' });
      continue;
    }
    let mmdd;
    try {
      mmdd = validateContactDate(c.date);
    } catch (e) {
      errors.push({ index: i, reason: e.message });
      continue;
    }
    const remark = c.remark == null ? '' : String(c.remark).trim();
    normalized.push({ date: mmdd, name, remark });
  }
  // 2) 去重（同 name + 同 mmdd 在当次提交内只保留一条）
  const seen = new Set();
  const dedup = [];
  for (const c of normalized) {
    const key = `${c.date}|${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(c);
  }
  // 3) 库内查重
  let existingSet = new Set();
  if (dedup.length > 0) {
    const parsed = dedup.map((c) => parseLeadDate(c.date));
    const leadDates = [...new Set(parsed.map((p) => p.leadDate))];
    const names = [...new Set(dedup.map((p) => p.name))];
    const phD = leadDates.map(() => '?').join(',');
    const phN = names.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT lead_date, customer_name FROM customers ` +
        `WHERE user_id = ? AND lead_date IN (${phD}) AND customer_name IN (${phN})`,
      )
      .all(userId, ...leadDates, ...names);
    existingSet = new Set(rows.map((r) => `${r.lead_date}|${r.customer_name}`));
  }
  // 4) 组装结果
  const items = dedup.map((c) => {
    const { leadDate } = parseLeadDate(c.date);
    const exists = existingSet.has(`${leadDate}|${c.name}`);
    return { date: c.date, name: c.name, remark: c.remark, lead_date: leadDate, exists };
  });
  const total = items.length;
  const existingCount = items.filter((i) => i.exists).length;
  const fresh = total - existingCount;
  // 5) 推送给前端（用于确认按钮回填）
  const pendingPayload = items.map((i) => ({
    date: i.date,
    name: i.name,
    remark: i.remark || null,
    exists: i.exists,
  }));
  if (typeof emit === 'function') emit({ type: 'pending_import', contacts: pendingPayload });
  return {
    total,
    fresh,
    existing: existingCount,
    errors,
    message:
      errors.length > 0
        ? `识别到 ${total} 位有效，${existingCount} 位已存在，${fresh} 位新；${errors.length} 条格式错误已忽略`
        : `识别到 ${total} 位，${existingCount} 位已存在，${fresh} 位新客户`,
  };
}
// ── 调度：按 name 分发 ──────────────────────────────────────
function executeToolCall({ userId, name, args, emit }) {
  switch (name) {
    case 'submit_recognition_result':
      return executeSubmitRecognition({ userId, args, emit });
    default:
      throw new Error(`未知工具：${name}`);
  }
}
module.exports = { TOOLS, executeToolCall };
