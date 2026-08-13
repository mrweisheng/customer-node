// SiliconFlow AI 调用 + 解析（对齐 MIGRATION_DESIGN §8.5 + 附录 A/B）
const axios = require('axios');
const config = require('../config');
const { httpError } = require('../middleware/errorHandler');

// ── VL System Prompt（附录 A，逐字保留）──────────────────
const VL_SYSTEM_PROMPT = `你是微信截图联系人提取器。看到联系人就提取。

【输出 JSON，不许有别的文字】
{"sections":[{"date":"MMDD","lines":["姓名","姓名/备注"]}]}

【三种格式都要处理】

A. 通讯录列表：4 位数字单独一行是日期标题，下面是该天联系人。"/" 后面是备注，整行直接放 lines。

B. 微信搜索结果页：搜索框里 "MMDD/" 是该页日期，下面每行形如 "MMDD/姓名"。**剥掉 "MMDD/" 前缀**，只留真实姓名放 lines。

C. 5 位数字格式（YMMDD）：如 "60701/" 或 "60701/jack"。**只取后 4 位作为日期**，剥掉第一位年份标识。例如 "60701/jack" → date="0701", lines=["jack"]。

【示例 A】通讯录列表
输入图：
  0503
  Dave Lau/莲
  Ken
  Jack Wong/莲塘
  0502
  Alice
输出：
{"sections":[{"date":"0503","lines":["Dave Lau/莲","Ken","Jack Wong/莲塘"]},{"date":"0502","lines":["Alice"]}]}

【示例 B】搜索结果页
输入图：搜索框 "0605/"，下面三行
  0605/Ka Po
  0605/华仔
  0605/願一切順心
输出：
{"sections":[{"date":"0605","lines":["Ka Po","华仔","願一切順心"]}]}

【示例 C】只有联系人行，无搜索框/标题
输入图：
  60809/彭秉庚
  60809/木
输出：
{"sections":[{"date":"0809","lines":["彭秉庚","木"]}]}

【其他】
- 保留大小写、空格、繁简体
- 按图从上到下顺序，不漏行
- 凡是看到形如 "数字/姓名"（"/" 分隔姓名/备注）的行就提取，无论是否有顶部搜索框或"联系人"标签
- 完全没有 "数字/姓名" 模式的行（如风景照、纯文本聊天截图）才返回 {"sections":[]}`;

// ── 截断 JSON 修复（附录 B，逐字翻译）──────────────────
function tryFixTruncatedJson(s) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
    else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
  }
  if (inString) s += '"';
  const closing = stack.reverse().map((b) => (b === '{' ? '}' : ']')).join('');
  try {
    return JSON.parse(s + closing);
  } catch {
    return null;
  }
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    const start = cleaned.indexOf('{');
    if (start >= 0) return tryFixTruncatedJson(cleaned.slice(start));
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    return tryFixTruncatedJson(match[0]);
  }
}

// ── sections 解析（对齐 ai.py _parse_sections）──────────
function parseSections(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) return [];
  const result = [];
  for (const section of raw.sections) {
    if (!section || typeof section !== 'object') continue;
    let dateVal = String(section.date == null ? '' : section.date).trim();
    const rawDate = dateVal;
    if (dateVal.length === 5 && /^\d{5}$/.test(dateVal)) dateVal = dateVal.slice(1);
    const lines = section.lines;
    if (!Array.isArray(lines)) continue;
    for (let line of lines) {
      line = String(line).trim();
      if (!line) continue;
      // 剥掉模型可能加的日期前缀（先 4 位再 5 位原始）
      if (dateVal && line.startsWith(dateVal + '/')) {
        line = line.slice(dateVal.length + 1);
      } else if (rawDate && line.startsWith(rawDate + '/')) {
        line = line.slice(rawDate.length + 1);
      }
      if (!line) continue;
      result.push({ date: dateVal, rawLine: line });
    }
  }
  return result;
}

// 按 "/" 拆分 name / remark
function splitNameRemark(rawLine) {
  const idx = rawLine.indexOf('/');
  if (idx >= 0) {
    return [rawLine.slice(0, idx).trim(), rawLine.slice(idx + 1).trim()];
  }
  return [rawLine.trim(), ''];
}

// 去重（对齐 ai.py _clean_contacts）
function cleanContacts(contacts) {
  const valid = [];
  const seen = new Set();
  for (const c of contacts) {
    const name = (c.name || '').trim();
    if (!name) continue;
    const remark = (c.remark || '').trim();
    const key = `${c.date}|${name}|${remark}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ date: c.date, name, remark });
  }
  return valid;
}

function hasMissingDates(contacts) {
  return contacts.some((c) => !/^\d{4,5}$/.test(c.date));
}

// 填充缺失日期：取出现次数最多的日期
function fillMissingDates(contacts) {
  const counts = {};
  for (const c of contacts) {
    if (/^\d{4,5}$/.test(c.date)) counts[c.date] = (counts[c.date] || 0) + 1;
  }
  let defaultDate = '';
  let max = 0;
  for (const [d, n] of Object.entries(counts)) {
    if (n > max) { max = n; defaultDate = d; }
  }
  if (defaultDate) {
    for (const c of contacts) {
      if (!/^\d{4,5}$/.test(c.date)) c.date = defaultDate;
    }
  }
}

// ── SiliconFlow API 调用（对齐 ai.py _call_siliconflow）──
async function callSiliconflow(messages, { maxTokens = 8192, extraParams = {} } = {}) {
  const body = {
    model: config.SILICONFLOW_MODEL,
    messages,
    max_tokens: maxTokens,
    temperature: 0.1,
    ...extraParams,
  };
  let resp;
  try {
    resp = await axios.post(config.SILICONFLOW_API_URL, body, {
      timeout: 60000,
      headers: {
        Authorization: `Bearer ${config.SILICONFLOW_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (e) {
    console.error('[API调用失败]', e.message);
    throw httpError(500, 'AI 识别失败，请稍后重试');
  }
  if (resp.status !== 200) {
    console.error('[API非200]', resp.status);
    throw httpError(500, 'AI 识别失败，请稍后重试');
  }
  let content = (((resp.data || {}).choices || [{}])[0].message || {}).content || '';
  // 剥离 Qwen3 思考过程
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return content;
}

module.exports = {
  VL_SYSTEM_PROMPT,
  tryFixTruncatedJson,
  extractJson,
  parseSections,
  splitNameRemark,
  cleanContacts,
  hasMissingDates,
  fillMissingDates,
  callSiliconflow,
};
