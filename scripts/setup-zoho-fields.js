#!/usr/bin/env node
// One-off: create the four AI custom fields on the Zoho CRM Leads module.
// Safe to re-run: fields that already exist are skipped.
//   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_REFRESH_TOKEN=... node scripts/setup-zoho-fields.js
const { ZOHO_AI_FIELDS } = require('../src/zoho-lead.js');
const { accessToken, zoho } = require('./zoho.js');

(async () => {
  const token = await accessToken();
  const existing = await zoho('GET', '/settings/fields?module=Leads', null, token);
  if (existing.status !== 200) throw new Error(`could not read Leads fields: HTTP ${existing.status}`);
  const have = new Set(existing.json.fields.map((f) => f.api_name));
  for (const f of ZOHO_AI_FIELDS) {
    if (have.has(f.api_name)) { console.log(`exists   ${f.api_name}`); continue; }
    const field = { field_label: f.field_label, data_type: f.data_type };
    if (f.length) field.length = f.length;
    if (f.textarea) field.textarea = f.textarea;
    if (f.values) field.pick_list_values = f.values.map((v) => ({ display_value: v, actual_value: v }));
    const r = await zoho('POST', '/settings/fields?module=Leads', { fields: [field] }, token);
    const row = r.json && r.json.fields ? r.json.fields[0] : r.json;
    console.log(`created  ${f.api_name}: HTTP ${r.status} ${row && (row.code || row.status)}`);
    if (r.status >= 300) process.exitCode = 1;
  }
  const after = await zoho('GET', '/settings/fields?module=Leads', null, token);
  const names = new Set(after.json.fields.map((f) => f.api_name));
  const missing = ZOHO_AI_FIELDS.filter((f) => !names.has(f.api_name)).map((f) => f.api_name);
  if (missing.length) { console.error(`still missing: ${missing.join(', ')} (check the api_name Zoho generated)`); process.exit(1); }
  console.log('all AI fields present on Leads');
})().catch((e) => { console.error(e.message); process.exit(1); });
