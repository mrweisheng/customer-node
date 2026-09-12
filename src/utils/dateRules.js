// 客户日期规则（唯一实现），供两处消费方共用：
//   - routers/ai.js        batch-import / check-duplicates（录入与查重）
//   - utils/agentTools.js  agent 的 submit_recognition_result 查重
// 约定与原 Python 版对齐：
//   - 日期格式：MMDD 四位（默认就近过去年份）或 YMMDD 五位（首位为年份末位，只取后 4 位）
//   - lead_date：MMDD 解析为具体的 YYYY-MM-DD，未来日期归为去年（如今年 12 月录 "0503" 算去年）
const MAX_DAYS = {
  1: 31, 2: 29, 3: 31, 4: 30, 5: 31, 6: 30,
  7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31,
};

// 校验并规整日期：非法时抛错（错误文案会经 422 / 工具回执透出给用户与 LLM），
// 合法时返回规整后的 4 位 MMDD
function validateContactDate(v) {
  let d = String(v || '');
  if (/^\d{5}$/.test(d)) d = d.slice(1); // YMMDD → MMDD
  if (!/^\d{4}$/.test(d)) throw new Error(`日期格式必须为 MMDD 四位数字或 YMMDD 五位数字（收到：${v}）`);
  const month = parseInt(d.slice(0, 2), 10);
  const day = parseInt(d.slice(2), 10);
  if (month < 1 || month > 12) throw new Error('月份必须在 01-12 之间');
  if (day < 1 || day > MAX_DAYS[month]) throw new Error(`${month}月的日期必须在 01-${MAX_DAYS[month]} 之间`);
  return d;
}

// 解析为 lead_date（YYYY-MM-DD）：按今天零点做跨年归位，未来日期算去年
function parseLeadDate(mmd) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentYear = today.getFullYear();
  const month = parseInt(mmd.slice(0, 2), 10);
  const day = parseInt(mmd.slice(2), 10);
  let d = new Date(currentYear, month - 1, day);
  if (d > today) d = new Date(currentYear - 1, month - 1, day);
  return {
    mmdd: mmd,
    leadDate: `${d.getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

module.exports = { MAX_DAYS, validateContactDate, parseLeadDate };
