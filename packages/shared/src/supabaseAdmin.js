const { createClient } = require('@supabase/supabase-js');

let cachedClient = null;

/**
 * Service-role Supabase client. Bypasses RLS — server-side use only, never
 * exposed to a browser. Returns null (not a throw) when env vars are absent
 * so callers like /health can degrade gracefully instead of crashing.
 */
function getSupabaseAdmin() {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

module.exports = { getSupabaseAdmin };
