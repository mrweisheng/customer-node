// 启动时自动补录：有成交记录、但还没有「已成交到店」记录的客户，
// 按其最新一条成交记录的成交日补一条到店（is_deal=1，关联该成交）。
// 幂等：已补过/已存在的客户不会重复补，故每次启动安全运行。
const db = require('../db');

function backfillVisits() {
  // 找出「有成交」且「无任何已成交到店」的客户
  const needy = db.prepare(`
    SELECT c.id AS customer_id, c.user_id
    FROM customers c
    WHERE EXISTS (SELECT 1 FROM customer_deals d WHERE d.customer_id = c.id)
      AND NOT EXISTS (SELECT 1 FROM customer_visits v WHERE v.customer_id = c.id AND v.is_deal = 1)
  `).all();
  if (!needy.length) return 0;

  // 每个客户取最新一条成交（按 id 倒序），用其成交日作为到店日
  const latestDeal = db.prepare(
    `SELECT id, COALESCE(deal_time, substr(created_at, 1, 10)) AS visit_time
     FROM customer_deals WHERE customer_id = ? ORDER BY id DESC LIMIT 1`
  );
  const insertVisit = db.prepare(
    `INSERT INTO customer_visits (customer_id, user_id, visit_time, needs, is_deal, deal_id)
     VALUES (?, ?, ?, NULL, 1, ?)`
  );

  const tx = db.transaction(() => {
    for (const c of needy) {
      const dl = latestDeal.get(c.customer_id);
      if (dl) insertVisit.run(c.customer_id, c.user_id, dl.visit_time, dl.id);
    }
  });
  tx();
  return needy.length;
}

module.exports = backfillVisits;
