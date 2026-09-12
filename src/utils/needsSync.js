// 跟进-需求冲突分析器：销售提交跟进后，判断新信息是否与「当前需求」快照冲突。
// 有冲突 → 以跟进为准给出新需求表述，由调用方（POST /followups）落库并回传前端提示。
// 红线：任何异常一律返回 null（视为无冲突），绝不阻塞跟进保存，也绝不误改需求。
const { callSiliconflow, extractJson } = require('./aiHelper');

const SYSTEM_PROMPT = `你是汽车销售团队的助理。一位客户有一份「当前需求」快照，销售刚提交了一条「新跟进」。
请判断这条跟进带来的最新信息是否与当前需求不一致（例如：预算变了、车型/板块意向变了、需求取消或转向、关键诉求被推翻）。
- 纯过程性记录（如"已电话联系""约了下周见面""发了报价"）或与需求无关的内容 → 不算冲突
- 只有当跟进明确表达了与当前需求不同的新诉求时才算冲突；轻微补充（如增加一个备选车型）也算冲突，新需求要合并新旧信息
- 不确定时一律判为不冲突
只输出 JSON，不要输出其他内容，格式：
{"conflict": true, "new_needs": "冲突时给出合并新旧信息后的完整需求描述；无冲突给空字符串", "reason": "一句话理由"}
无冲突时：{"conflict": false, "new_needs": "", "reason": "一句话理由"}`;

/**
 * @returns {Promise<{conflict: boolean, newNeeds: string, reason: string}|null>}
 *          null 表示分析失败/结论无效（调用方按无冲突处理）
 */
async function analyzeNeedsConflict({ currentNeeds, followupContent, recentFollowups = [] }) {
  try {
    const recentText = recentFollowups.length
      ? `\n此前几条跟进（旧→新）：\n${recentFollowups.map((s) => `- ${String(s).slice(0, 200)}`).join('\n')}`
      : '';
    const content = await callSiliconflow(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `当前需求：${currentNeeds ? String(currentNeeds).slice(0, 500) : '（空）'}\n新跟进：${String(followupContent).slice(0, 500)}${recentText}`,
        },
      ],
      { maxTokens: 2048, timeoutMs: 10000 } // 短超时：AI 卡死也不能拖住跟进保存请求（前端 60s 会先超时造成假失败）
    );
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.conflict !== true) return { conflict: false, newNeeds: '', reason: String(parsed.reason || '') };
    const newNeeds = String(parsed.new_needs || '').trim();
    // 新需求为空/超长/与原需求完全相同 → 结论无效，按无冲突处理
    if (!newNeeds || newNeeds.length > 2000 || newNeeds === currentNeeds) return null;
    return { conflict: true, newNeeds, reason: String(parsed.reason || '').trim() };
  } catch (_) {
    return null;
  }
}

module.exports = { analyzeNeedsConflict };
