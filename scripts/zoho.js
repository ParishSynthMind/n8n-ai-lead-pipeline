// Small Zoho helper for the setup and live-check scripts (not used by n8n,
// which handles Zoho OAuth itself). Reads credentials from the environment.
const ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';
const API = process.env.ZOHO_API_BASE || 'https://www.zohoapis.com/crm/v8';

async function accessToken() {
  if (process.env.ZOHO_ACCESS_TOKEN) return process.env.ZOHO_ACCESS_TOKEN;
  for (const k of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN']) {
    if (!process.env[k]) throw new Error(`${k} is not set`);
  }
  const res = await fetch(`${ACCOUNTS}/oauth/v2/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`Zoho token refresh failed: ${j.error || res.status}`);
  return j.access_token;
}

async function zoho(method, path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  return { status: res.status, json: t ? JSON.parse(t) : null };
}

module.exports = { accessToken, zoho, API };
