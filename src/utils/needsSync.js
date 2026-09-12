// 跟进-需求冲突分析器：销售提交跟进后，判断新信息是否与「当前需求」快照冲突。
// 有冲突 → 以跟进为准给出新需求表述，由调用方（POST /followups）落库并回传前端提示。
// 红线：任何异常一律返回 null（视为无冲突），绝不阻塞跟进保存，也绝不误改需求。
const { callSiliconflow, extractJson } = require('./aiHelper');

const SYSTEM_PROMPT = `你是汽车销售团队的助理。一位客户有一份「当前需求」快照，销售刚提交了一条新的跟进或到店登记内容。
请判断这条新内容带来的最新信息是否与当前需求不一致（例如：预算变了、车型/板块意向变了、需求取消或转向、关键诉求被推翻）。
- 纯过程性记录（如"已电话联系""约了下周见面""发了报价"）或无明确诉求的内容（如"过来看一看""陪朋友来店里"）→ 不算变更
- 只有当新内容明确表达了与当前需求不同的新诉求时才算变更；轻微补充（如增加一个备选车型）也算变更，新需求要合并新旧信息，仍有效的旧意向要保留
- 不确定时一律判为不变更
只输出 JSON，不要输出其他内容，格式：
{"conflict": true, "new_needs": "变更时给出合并新旧信息后的完整需求描述；未变更给空字符串", "reason": "一句话理由"}
未变更时：{"conflict": false, "new_needs": "", "reason": "一句话理由"}`;

// 客户当前需求为空时走「提取」模式：不问"是否变更"（从无到有本就不算变更，
// 会导致需求永远写不进），而是直接问"这条内容里有没有可提取的需求"
const EXTRACT_SYSTEM_PROMPT = `你是汽车销售团队的助理。销售记录了一条客户接触内容（到店登记或跟进），客户此前没有需求记录。请从中提取客户当前的业务需求/意向。
- 明确诉求包括：具体车型/车辆要求、两地牌或口岸意向（深圳湾/莲塘/沙头角/港珠澳）、预算、购车/办牌时间、香港身份/移民/户籍咨询等
- 有明确诉求 → {"has_needs": true, "needs": "凝练后的需求描述，保留车型/口岸/预算/时间等关键信息", "reason": "一句话依据"}
- 纯过程性内容（已联系、约见面、发了报价、过来看一看等，无任何诉求）→ {"has_needs": false, "needs": "", "reason": "一句话依据"}
- 无把握时不硬造需求，按 has_needs: false 处理
只输出 JSON，不要输出其他内容。`;

/**
 * @param {string} [logCtx] 日志上下文（如 "客户6271(张三)"），仅用于日志定位
 * @returns {Promise<{conflict: boolean, newNeeds: string, reason: string}|null>}
 *          null 表示分析失败/结论无效（调用方按无冲突处理）
 */
async function analyzeNeedsConflict({ currentNeeds, followupContent, recentFollowups = [], logCtx = '' } = {}) {
  const tag = `[需求分析]${logCtx ? ' ' + logCtx : ''}`;
  // 需求为空 → 提取模式；已有需求 → 变更检测模式。两种模式返回结构一致（conflict/newNeeds）
  const extractMode = !currentNeeds;
  const mode = extractMode ? '提取' : '变更检测';
  try {
    console.log(`${tag} 开始分析（${mode}模式）：当前需求=${currentNeeds ? JSON.stringify(String(currentNeeds).slice(0, 100)) : '（空）'}；新内容=${JSON.stringify(String(followupContent).slice(0, 100))}`);
    const recentText = recentFollowups.length
      ? `\n此前几条跟进（旧→新）：\n${recentFollowups.map((s) => `- ${String(s).slice(0, 200)}`).join('\n')}`
      : '';
    const userContent = extractMode
      ? `新记录：${String(followupContent).slice(0, 500)}${recentText}`
      : `当前需求：${String(currentNeeds).slice(0, 500)}\n新跟进：${String(followupContent).slice(0, 500)}${recentText}`;
    const content = await callSiliconflow(
      [
        { role: 'system', content: extractMode ? EXTRACT_SYSTEM_PROMPT : SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      { maxTokens: 2048, timeoutMs: 30000 } // 30s：容忍网络波动；仍低于前端 60s 超时，不会造成保存假失败，超时按无冲突跳过
    );
    console.log(`${tag} 模型原始返回：${JSON.stringify(String(content || '')).slice(0, 400)}`);
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') { console.warn(`${tag} ✗ 返回内容解析不出 JSON，按无变更处理`); return null; }
    if (extractMode) {
      const newNeeds = String(parsed.needs || parsed.new_needs || '').trim();
      if (parsed.has_needs !== true || !newNeeds || newNeeds.length > 2000) {
        console.log(`${tag} 判定：无可提取的需求（${String(parsed.reason || '模型未给出理由')}）`);
        return { conflict: false, newNeeds: '', reason: String(parsed.reason || '') };
      }
      console.log(`${tag} 判定：提取到需求 → ${JSON.stringify(newNeeds.slice(0, 150))}`);
      return { conflict: true, newNeeds, reason: String(parsed.reason || '').trim() };
    }
    if (parsed.conflict !== true) { console.log(`${tag} 判定：不变更（${String(parsed.reason || '模型未给出理由')}）`); return { conflict: false, newNeeds: '', reason: String(parsed.reason || '') }; }
    const newNeeds = String(parsed.new_needs || '').trim();
    // 新需求为空/超长/与原需求完全相同 → 结论无效，按无变更处理
    if (!newNeeds || newNeeds.length > 2000 || newNeeds === currentNeeds) { console.warn(`${tag} ✗ conflict=true 但 new_needs 无效（空/超长/与原需求相同），按无变更处理`); return null; }
    console.log(`${tag} 判定：需求变更 → ${JSON.stringify(newNeeds.slice(0, 150))}`);
    return { conflict: true, newNeeds, reason: String(parsed.reason || '').trim() };
  } catch (e) {
    console.warn(`${tag} ✗ 分析异常：${e.message}`);
    return null;
  }
}

module.exports = { analyzeNeedsConflict };
