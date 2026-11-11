const { getSupabaseAdmin } = require('@careeros/shared');
const { encryptSecret, decryptSecret, isConfigured: cryptoConfigured } = require('./secretCrypto');

// Google OAuth refresh-token store + access-token minting, shared by the Gmail
// (spec §9.1) and Drive (spec §11.3) integrations — one grant, one row per user.
// Acquisition is Supabase-mediated: the frontend runs a "Connect Google" OAuth
// grant requesting the union of scopes both features need (gmail.readonly +
// drive.file, access_type=offline) and hands us the provider_refresh_token
// once; we encrypt it into google_oauth_credentials and thereafter exchange it
// for short-lived access tokens on the server, using the SAME Google OAuth
// client id/secret that backs Supabase's Google provider.
//
// The refresh token is issued to that client, so refreshing requires those
// credentials (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET). The client
// secret never leaves the server.

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// The refresh token is issued to Supabase's Google OAuth client, so refreshing
// needs THAT client's id + secret. Prefer OAuth-specific names, but fall back to
// the pre-existing GOOGLE_CLIENT_* names (already used for the Supabase Google
// provider) so the secret needn't be duplicated under a new key.
function clientId() {
  return process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
}
function clientSecret() {
  return process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
}

class GmailNotConnectedError extends Error {
  constructor(message = 'Gmail is not connected') {
    super(message);
    this.code = 'gmail_not_connected';
    this.status = 400;
  }
}

// True when both the encryption seam and the Google client credentials are
// present — routes gate on this so the feature fails with a clear 503 rather
// than a crash.
function isConfigured() {
  return cryptoConfigured() && !!clientId() && !!clientSecret();
}

// Encrypt + upsert the user's refresh token (one row per user).
async function storeRefreshToken(userId, { refreshToken, googleEmail, scopes }) {
  if (!refreshToken || typeof refreshToken !== 'string') {
    throw Object.assign(new Error('refresh_token is required'), { status: 400 });
  }
  const db = getSupabaseAdmin();
  const { error } = await db
    .from('google_oauth_credentials')
    .upsert(
      {
        user_id: userId,
        google_email: googleEmail || null,
        encrypted_refresh_token: encryptSecret(refreshToken),
        scopes: scopes || null,
        validated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
}

// { connected, google_email, scopes, connected_at } for the status endpoint.
async function getStatus(userId) {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from('google_oauth_credentials')
    .select('google_email, scopes, validated_at, created_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  if (!data) return { connected: false };
  return {
    connected: true,
    google_email: data.google_email,
    scopes: data.scopes,
    connected_at: data.validated_at || data.created_at,
  };
}

// Persist the per-user Drive root folder id once it's created (googleDriveClient
// findOrCreateRootFolder), so later saves never re-search Drive by name.
async function setDriveRootFolderId(userId, folderId) {
  const db = getSupabaseAdmin();
  const { error } = await db
    .from('google_oauth_credentials')
    .update({ drive_root_folder_id: folderId })
    .eq('user_id', userId);
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
}

async function getDriveRootFolderId(userId) {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from('google_oauth_credentials')
    .select('drive_root_folder_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  return data ? data.drive_root_folder_id : null;
}

async function disconnect(userId) {
  const db = getSupabaseAdmin();
  const { error } = await db.from('google_oauth_credentials').delete().eq('user_id', userId);
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
}

// Exchange the stored refresh token for a fresh access token. Throws
// GmailNotConnectedError if the user has no stored grant. A refresh failure
// (revoked/expired refresh token) surfaces as a 400 so the client can prompt a
// reconnect rather than treat it as a server fault.
async function getAccessToken(userId) {
  if (!isConfigured()) {
    throw Object.assign(new Error('Gmail integration is not configured on the server'), { status: 503 });
  }
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from('google_oauth_credentials')
    .select('encrypted_refresh_token')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 500 });
  if (!data) throw new GmailNotConnectedError();

  let refreshToken;
  try {
    refreshToken = decryptSecret(data.encrypted_refresh_token);
  } catch (e) {
    throw Object.assign(new Error('Stored Gmail token could not be decrypted'), { status: 500 });
  }

  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    // invalid_grant = the user revoked access or the token expired.
    const reason = json.error === 'invalid_grant' ? 'Gmail access was revoked — please reconnect' : json.error || `HTTP ${resp.status}`;
    throw Object.assign(new GmailNotConnectedError(reason), {});
  }
  return json.access_token;
}

module.exports = {
  isConfigured,
  storeRefreshToken,
  getStatus,
  disconnect,
  getAccessToken,
  setDriveRootFolderId,
  getDriveRootFolderId,
  GmailNotConnectedError,
};
