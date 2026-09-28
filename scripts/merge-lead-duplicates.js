#!/usr/bin/env node
// ── 合并第三方导入产生的重复线索 ───────────────────────────
// 背景：POST /customers/lead 曾把导入线索统一写到 system 用户（"内部线索同步"）
// 名下，导致同一 (lead_date, customer_name) 在 system 桶和业务用户桶各有一条。
// 现导入已改为固定写 user 14；本脚本一次性清理存量：
//   1. system 桶的记录在目标用户(14)桶有同名同日期记录 → 把头像补到目标记录
//      （仅当目标头像为空），然后删除 system 桶那条
//   2. 没有对应记录的 → 直接把 user_id 改成目标用户（数据不丢）
//   3. system 桶记录若挂有成交/跟进/到店子数据 → 不动，打印出来人工确认
// 用法：node scripts/merge-lead-duplicates.js            （干跑，只打印计划）
//       node scripts/merge-lead-duplicates.js --apply   （真正执行）
const path = require('path');
const Database = require('better-sqlite3');

const TARGET_USER_ID = 14;                          // 合并目标：明哥兩地牌HK（助理）
const SYSTEM_OPENID = 'internal_system';            // system 用户固定 openid
const APPLY = process.argv.includes('--apply');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'customer.db');
const db = new Database(dbPath);
console.log(`数据库: ${dbPath}  模式: ${APPLY ? '★ APPLY（实际执行）' : '干跑（只打印计划，加 --apply 执行）'}`);

const sysUser = db.prepare('SELECT id FROM users WHERE openid = ?').get(SYSTEM_OPENID);
if (!sysUser) { console.log('未找到 system 用户，无需清理。'); process.exit(0); }
const sysId = sysUser.id;
const target = db.prepare('SELECT id, nickname FROM users WHERE id = ?').get(TARGET_USER_ID);
if (!target) { console.error(`目标用户 ${TARGET_USER_ID} 不存在，终止`); process.exit(1); }
console.log(`system 用户 id=${sysId} → 目标用户 id=${TARGET_USER_ID}（${target.nickname}）\n`);

const sysLeads = db.prepare(
  'SELECT * FROM customers WHERE user_id = ? ORDER BY id'
).all(sysId);
if (!sysLeads.length) { console.log('system 用户名下没有线索记录，无需清理。'); process.exit(0); }

const findByKey = db.prepare(
  'SELECT * FROM customers WHERE user_id = ? AND lead_date = ? AND customer_name = ?'
);
const childCount = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM customer_deals WHERE customer_id = ?) AS deals,
    (SELECT COUNT(*) FROM customer_followups WHERE customer_id = ?) AS followups,
    (SELECT COUNT(*) FROM customer_visits WHERE customer_id = ?) AS visits
`);
const updateAvatar = db.prepare('UPDATE customers SET customer_avatar_url = ? WHERE id = ?');
const reassign = db.prepare('UPDATE customers SET user_id = ? WHERE id = ?');
const del = db.prepare('DELETE FROM customers WHERE id = ?');

let nMerged = 0, nReassigned = 0, nSkipped = 0;

const ops = [];
for (const lead of sysLeads) {
  const children = childCount.get(lead.id, lead.id, lead.id);
  if (children.deals || children.followups || children.visits) {
    console.log(`⚠ 跳过 id=${lead.id} "${lead.customer_name}"：挂有子数据` +
      `（成交${children.deals}/跟进${children.followups}/到店${children.visits}），需人工确认`);
    nSkipped++;
    continue;
  }
  const dup = findByKey.get(TARGET_USER_ID, lead.lead_date, lead.customer_name);
  if (dup) {
    const newAvatar = (!dup.customer_avatar_url && lead.customer_avatar_url) ? lead.customer_avatar_url : null;
    console.log(`合并 id=${lead.id} → 目标 id=${dup.id} "${lead.customer_name}" ${lead.lead_date}` +
      (newAvatar ? `（补头像 ${newAvatar.slice(0, 50)}…）` : '（目标已有头像或源无头像，不覆盖）'));
    ops.push(() => { if (newAvatar) updateAvatar.run(newAvatar, dup.id); del.run(lead.id); });
    nMerged++;
  } else {
    console.log(`改归属 id=${lead.id} "${lead.customer_name}" ${lead.lead_date} → user ${TARGET_USER_ID}`);
    ops.push(() => reassign.run(TARGET_USER_ID, lead.id));
    nReassigned++;
  }
}

if (!APPLY) {
  console.log(`\n干跑结果：合并 ${nMerged} 条 / 改归属 ${nReassigned} 条 / 跳过 ${nSkipped} 条。加 --apply 执行。`);
  process.exit(0);
}

db.transaction(() => { for (const op of ops) op(); })();
console.log(`\n完成：合并 ${nMerged} 条 / 改归属 ${nReassigned} 条 / 跳过 ${nSkipped} 条。`);
