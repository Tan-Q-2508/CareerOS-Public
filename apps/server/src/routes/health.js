const { Router } = require('express');
const { getSupabaseAdmin } = require('@careeros/shared');

const router = Router();

router.get('/', (_req, res) => {
  res.json({ name: 'CareerOS API' });
});

router.get('/health', async (_req, res) => {
  const supabaseAdmin = getSupabaseAdmin();
  // process.memoryUsage() (4.6.13) — cheap, always-available diagnostic. The
  // scan heartbeat (4.6.12) already hits this endpoint every 5 min for the
  // full duration of any scan, so this is a free, low-resolution memory
  // trend without a dedicated poller; Render's own Metrics API (per-minute,
  // container-level) is the authoritative source for verification numbers.
  const memory = process.memoryUsage();

  if (!supabaseAdmin) {
    return res.json({ status: 'ok', db: 'not configured', memory });
  }

  const { error } = await supabaseAdmin.from('users').select('id').limit(1);
  if (error) {
    return res.json({ status: 'ok', db: 'error', detail: error.message, memory });
  }

  res.json({ status: 'ok', db: 'connected', memory });
});

module.exports = router;
