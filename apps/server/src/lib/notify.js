// Shared in-app notification insert (spec §12.5) — pulled out of runDueScans.js
// so §15 #24 doesn't duplicate the same insert shape a second time in
// runScan.js (an ATS Direct company-failure notification fires for MANUAL
// scans too, not only scheduled ones — a manual ATS scan whose only tracked
// company is unreachable would otherwise silently return zero jobs with no
// explanation).

async function insertNotification(db, userId, type, message) {
  const { error } = await db.from('notifications').insert({ user_id: userId, type, message });
  if (error) console.error('insertNotification failed:', error.message);
}

module.exports = { insertNotification };
