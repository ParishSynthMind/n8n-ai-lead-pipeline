#!/usr/bin/env node
// Posts a webhook body to a URL signed exactly the way Meta signs it
// (X-Hub-Signature-256 = HMAC-SHA256 of the raw bytes with the app secret).
//   META_APP_SECRET=... node scripts/send-signed-webhook.js <url> <body.json> [--forge]
// --forge signs with a wrong secret, to check the 403 path.
const fs = require('fs');
const crypto = require('crypto');
const { signatureFor } = require('../src/meta-leads.js');

(async () => {
  const [url, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const forge = process.argv.includes('--forge');
  if (!url || !file) throw new Error('usage: send-signed-webhook.js <url> <body.json> [--forge]');
  if (!process.env.META_APP_SECRET) throw new Error('META_APP_SECRET is not set');
  // Compact JSON with "/" escaped, like Meta's own payloads.
  const raw = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))).replace(/\//g, '\\/');
  const sig = signatureFor(raw, forge ? 'not-the-app-secret' : process.env.META_APP_SECRET, crypto);
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  console.log(`${forge ? 'FORGED ' : ''}POST ${new URL(url).pathname} -> ${res.status} ${await res.text()}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
