// Zoho CRM destination: build the Leads upsert request (create or update by
// email) with the AI rating mapped to custom fields, and check Zoho's answer.
// Runs inside the n8n Code nodes around "Zoho: upsert lead" and in the unit
// tests. Pure functions: no n8n globals, no network.

// Custom Leads fields created once by scripts/setup-zoho-fields.js.
const ZOHO_AI_FIELDS = [
  { api_name: 'AI_Lead_Rating', field_label: 'AI Lead Rating', data_type: 'picklist', values: ['Hot', 'Warm', 'Cold'] },
  { api_name: 'AI_Lead_Summary', field_label: 'AI Lead Summary', data_type: 'textarea', textarea: { type: 'large' } },
  { api_name: 'AI_Next_Step', field_label: 'AI Next Step', data_type: 'text', length: 255 },
  { api_name: 'AI_Needs_Review', field_label: 'AI Needs Review', data_type: 'boolean' },
];

function zohoLeadSource(source) {
  const s = String(source || '').toLowerCase();
  if (s.startsWith('facebook')) return 'Facebook';
  if (s === 'chat') return 'Chat';
  return 'Web Download';
}

function buildZohoUpsert(lead, result) {
  // Last_Name is the one field Zoho insists on. A single-word name goes there.
  const lastName = lead.lastName || lead.firstName || lead.email;
  const record = {
    Last_Name: lastName.slice(0, 80),
    First_Name: lead.lastName ? (lead.firstName || '').slice(0, 40) : '',
    Email: lead.email,
    Company: lead.company || '',
    Phone: lead.phone || '',
    Lead_Source: zohoLeadSource(lead.source),
    Description: [lead.message, lead.budget ? `Budget: ${lead.budget}` : ''].filter(Boolean).join('\n\n').slice(0, 32000),
    AI_Lead_Rating: result.rating,
    AI_Lead_Summary: String(result.reason || '').slice(0, 2000),
    AI_Next_Step: String(result.nextStep || '').slice(0, 255),
    AI_Needs_Review: Boolean(result.needsReview),
  };
  // Upsert on Email makes the write idempotent: a repeat lead updates the
  // same record instead of creating a second one. trigger: [] keeps Zoho's
  // own workflow rules and approvals out of an automated write.
  return { data: [record], duplicate_check_fields: ['Email'], trigger: [] };
}

// Zoho returns { data: [ { code, status, action, details: { id }, message } ] }
// for an upsert, with HTTP 200/201 on success and 202/400 on a field error.
function parseZohoUpsert(response) {
  const r = response && typeof response === 'object' ? response : {};
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!row) {
    const msg = r.message || r.code || (r.error && (r.error.message || r.error)) || 'no data in Zoho response';
    return { ok: false, action: null, id: null, error: String(typeof msg === 'string' ? msg : JSON.stringify(msg)).slice(0, 300) };
  }
  if (row.status !== 'success' || row.code !== 'SUCCESS') {
    const where = row.details && row.details.api_name ? ` (field ${row.details.api_name})` : '';
    return { ok: false, action: null, id: null, error: `${row.code || 'ERROR'}: ${row.message || 'Zoho rejected the record'}${where}` };
  }
  return { ok: true, action: row.action || 'upsert', id: row.details && row.details.id ? String(row.details.id) : null, error: null };
}

if (typeof module !== 'undefined') module.exports = { ZOHO_AI_FIELDS, zohoLeadSource, buildZohoUpsert, parseZohoUpsert };
