// 板块需求分类器：从 当前需求 / 备注 / 最新跟进 的合并文本中识别业务板块（可多选）
// 三大板块：香港移民 / 卖车 / 办两地牌；LLM 语义理解优先，关键词匹配兜底；
// 结果按「客户 + 文本指纹」缓存，文本未变化时不重复调用 LLM
const crypto = require('crypto');
const db = require('../db');
const { callSiliconflow, extractJson } = require('./aiHelper');

const MODULES = [
  { key: 'hk_migration', name: '香港移民' },
  { key: 'car_sale', name: '卖车' },
  { key: 'two_plate', name: '办两地牌' },
];

const SYSTEM_PROMPT = `你是汽车销售团队的需求分析师。团队有三个业务板块，请对每位客户的需求文本判断命中哪些板块（可命中多个，也可都不命中）：
- hk_migration：香港移民/香港身份相关，如咨询香港户籍、香港身份、高才/优才/专才、港宝、移民规划等
- car_sale：买车需求，如提到具体车型（埃尔法、G63、霸道、库里南等）、预算选车、换车、想看车
- two_plate：办理两地牌（粤港/粤澳牌照），含指定口岸（深圳湾/莲塘/沙头角/港珠澳）的申请意向（新申请/现牌/纳税牌），或仅表达办两地牌意向未指定口岸
注意：一位客户可能同时有多个板块需求（如既想买车又想办牌）。
只输出 JSON，不要输出其他内容，格式：
{"results":[{"id":<客户id>,"labels":["hk_migration","two_plate"]}]}
未命中任何板块的客户 labels 为空数组。`;

function textHash(text) {
  return crypto.createHash('md5').update(String(text)).digest('hex');
}

// LLM 不可用/失败时的关键词兜底
function keywordFallback(text) {
  const labels = [];
  if (/香港|港户|港籍|港身份|移民|高才|优才|专才|身份规划/.test(text)) labels.push('hk_migration');
  if (/买车|卖车|购车|看车|提车|车型|换车|埃尔法|阿尔法|G63|霸道|普拉多|库里南|酷路泽|奔驰|宝马|奥迪|SUV|商务车/.test(text)) labels.push('car_sale');
  if (/两地牌|粤港|粤澳|深圳湾|莲塘|沙头角|港珠澳|大桥|纳税牌|现牌|牌证/.test(text)) labels.push('two_plate');
  return labels;
}

// items: [{ id, text }]，返回 { [id]: ['hk_migration', ...] }
async function classifyCustomers(items) {
  const result = {};
  const pending = [];

  for (const it of items) {
    const hash = textHash(it.text);
    const row = db.prepare(
      'SELECT labels_json FROM ai_need_classifications WHERE customer_id = ? AND text_hash = ?'
    ).get(it.id, hash);
    if (row) {
      try { result[it.id] = JSON.parse(row.labels_json); continue; } catch { /* 缓存损坏则重算 */ }
    }
    pending.push({ id: it.id, text: it.text, hash });
  }
  if (pending.length === 0) return result;

  let aiResults = null;
  try {
    const userMsg = pending.map((p) => `客户${p.id}：${String(p.text).slice(0, 500)}`).join('\n');
    const content = await callSiliconflow(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      { maxTokens: 2048 }
    );
    const parsed = extractJson(content);
    if (parsed && Array.isArray(parsed.results)) aiResults = parsed.results;
  } catch (e) {
    // 静默降级：走关键词兜底
  }

  const insert = db.prepare(
    'INSERT OR REPLACE INTO ai_need_classifications (customer_id, text_hash, labels_json) VALUES (?, ?, ?)'
  );
  const tx = db.transaction(() => {
    for (const p of pending) {
      let labels = null;
      if (aiResults) {
        const hit = aiResults.find((r) => r && Number(r.id) === Number(p.id));
        if (hit && Array.isArray(hit.labels)) {
          labels = hit.labels.filter((l) => MODULES.some((m) => m.key === l));
        }
      }
      if (labels === null) labels = keywordFallback(p.text);
      result[p.id] = labels;
      insert.run(p.id, p.hash, JSON.stringify(labels));
    }
  });
  tx();

  return result;
}

module.exports = { MODULES, classifyCustomers };
