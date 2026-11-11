require('dotenv').config();
const { createApp } = require('./app');
const { getSupabaseAdmin } = require('@careeros/shared');
const { startStaleScanTimer } = require('./scan/staleScanTimer');

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`CareerOS server listening on port ${PORT}`);

  // F5: server-wide stale-scan reaper, independent of the external GitHub
  // Actions cron that also hits reapStaleScans via /api/internal/run-due-scans
  // every 30 min — see staleScanTimer.js for why. Started once here, for the
  // life of the process. No-op if Supabase isn't configured (e.g. some local
  // dev setups), same guard every internal route already uses.
  const db = getSupabaseAdmin();
  if (db) {
    startStaleScanTimer(db);
  } else {
    console.warn('staleScanTimer: Supabase not configured, skipping server-wide reaper timer');
  }
});
