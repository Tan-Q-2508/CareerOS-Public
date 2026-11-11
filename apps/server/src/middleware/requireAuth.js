const { getSupabaseAdmin } = require('@careeros/shared');

/**
 * Validates a Supabase JWT (Authorization: Bearer <token>) against Supabase's
 * auth server and attaches req.user = { id, email }. This is the single point
 * that scopes every protected route by the authenticated user_id.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }

  const supabaseAdmin = getSupabaseAdmin();
  if (!supabaseAdmin) {
    return res.status(503).json({ error: 'Auth not configured' });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = { id: data.user.id, email: data.user.email };
  next();
}

module.exports = { requireAuth };
