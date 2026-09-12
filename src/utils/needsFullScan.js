// 启动全量需求扫描：服务启动后对全部重点客户，取其最新一条有效记录（到店 / 跟进）
// 交给 AI 需求冲突分析，判定需求有变化才更新「当前需求」快照并留痕。
// 设计约束：
//   - 只扫重点客户（is_priority = 1），逐个串行，避免瞬时打爆 LLM 接口
//   - 需求快照若已新于最新记录（如手动变更过需求），跳过不回溯，防止旧记录把新需求改回去
//   - 沿用 analyzeNeedsConflict 红线：任何失败一律按"无变更"处理，绝不误改需求
const db = require('../db');
const { analyzeNeedsConflict } = require('./needsSync');

// 需求变更留痕的三种前缀（手动变更 / 到店触发 AI / 跟进触发 AI）
const NEEDS_TRACE_LIKE = "(content LIKE '更新需求：%' OR content LIKE '需求已自动更新：%' OR content LIKE '需求已随跟进自动更新：%')";

async function runStartupNeedsScan() {
  const tag = '[需求全量扫描]';
  const startedAt = Date.now();
  try {
    const customers = db.prepare(
      'SELECT id, user_id, customer_name, current_needs FROM customers WHERE is_priority = 1 ORDER BY id'
    ).all();
    console.log(`${tag} 开始：共 ${customers.length} 位重点客户`);

    let updated = 0, unchanged = 0, skipped = 0, noSignal = 0, failed = 0;

    for (const c of customers) {
      const who = `客户${c.id}(${c.customer_name})`;
      try {
        const visit = db.prepare(
          'SELECT needs, created_at FROM customer_visits WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
        ).get(c.id);
        // 信号记录排除需求变更留痕本身，否则扫描自己生成的留痕会变成下一轮的"最新记录"
        const followup = db.prepare(
          `SELECT content, created_at FROM customer_followups WHERE customer_id = ? AND content NOT LIKE '更新需求：%' AND content NOT LIKE '需求已自动更新：%' AND content NOT LIKE '需求已随跟进自动更新：%' ORDER BY created_at DESC, id DESC LIMIT 1`
        ).get(c.id);

        // 最新信号：到店 vs 跟进，取较新的一条
        let signal = null;
        if (visit && (!followup || String(visit.created_at) >= String(followup.created_at))) {
          signal = { content: visit.needs || '', at: String(visit.created_at || ''), src: '到店' };
        } else if (followup) {
          signal = { content: followup.content, at: String(followup.created_at || ''), src: '跟进' };
        }
        if (!signal || !signal.content.trim()) {
          noSignal++;
          console.log(`${tag} ${who} 无可分析的有效记录，跳过`);
          continue;
        }

        // 需求快照已新于最新记录 → 无需回溯分析
        const trace = db.prepare(
          `SELECT created_at FROM customer_followups WHERE customer_id = ? AND ${NEEDS_TRACE_LIKE} ORDER BY created_at DESC, id DESC LIMIT 1`
        ).get(c.id);
        if (trace && String(trace.created_at) > signal.at) {
          skipped++;
          console.log(`${tag} ${who} 需求快照已新于最新${signal.src}记录（${signal.at}），跳过`);
          continue;
        }

        const prevFollowups = db.prepare(
          'SELECT content FROM customer_followups WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 3'
        ).all(c.id).map((r) => r.content);

        const analysis = await analyzeNeedsConflict({
          currentNeeds: c.current_needs || '',
          followupContent: signal.content,
          recentFollowups: prevFollowups,
          logCtx: who,
        });

        if (analysis && analysis.conflict) {
          const tx = db.transaction(() => {
            db.prepare('UPDATE customers SET current_needs = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(analysis.newNeeds, c.id);
            db.prepare('INSERT INTO customer_followups (customer_id, user_id, content) VALUES (?, ?, ?)')
              .run(c.id, c.user_id, `需求已自动更新：${analysis.newNeeds}`);
          });
          tx();
          updated++;
          console.log(`${tag} ${who} ✓ 需求已更新（来源：${signal.src} ${signal.at}）`);
        } else {
          unchanged++;
          console.log(`${tag} ${who} 需求无变更（来源：${signal.src} ${signal.at}）`);
        }
      } catch (e) {
        failed++;
        console.error(`${tag} ${who} 分析失败：${e.message}`);
      }
    }

    console.log(`${tag} 结束：共 ${customers.length} 位重点客户，更新 ${updated}，无变更 ${unchanged}，快照较新跳过 ${skipped}，无记录 ${noSignal}，失败 ${failed}，耗时 ${Date.now() - startedAt}ms`);
  } catch (e) {
    console.error(`${tag} 扫描未能启动：${e.message}`);
  }
}

module.exports = { runStartupNeedsScan };
