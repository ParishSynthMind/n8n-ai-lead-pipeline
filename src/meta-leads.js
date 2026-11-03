// Facebook / Meta Lead Ads intake: the webhook verification handshake, the
// X-Hub-Signature-256 check, leadgen event parsing, and turning a lead fetched
// from the Graph API into the body the main pipeline's webhook expects.
// Runs inside the n8n Code nodes of the "Facebook Lead Ads intake" workflow
// and in the unit tests. Pure functions: crypto is passed in, no network.

const GRAPH_LEAD_FIELDS = 'id,created_time,ad_id,ad_name,adset_name,campaign_name,form_id,field_data,is_organic,platform';
const STANDARD = {
  full_name: 'name', first_name: 'firstName', last_name: 'lastName', email: 'email', work_email: 'email',
  phone_number: 'phone', work_phone_number: 'phone', company_name: 'company',
};

// GET /webhook/fb-lead-ads?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
function verifyHandshake(query, verifyToken) {
  const q = query && typeof query === 'object' ? query : {};
  const ok = Boolean(verifyToken) && q['hub.mode'] === 'subscribe'
    && q['hub.verify_token'] === verifyToken && q['hub.challenge'] !== undefined && q['hub.challenge'] !== '';
  return ok ? { ok: true, challenge: String(q['hub.challenge']) } : { ok: false, challenge: null };
}

function signatureFor(rawBody, appSecret, crypto) {
  return 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

// Meta signs the exact bytes it sent with the app secret. The check must run on
// the raw body: re-serialised JSON differs (Meta escapes "/" and non-ASCII).
function verifySignature(rawBody, header, appSecret, crypto) {
  if (!appSecret) return { ok: false, error: 'app secret is not configured' };
  if (rawBody === undefined || rawBody === null) return { ok: false, error: 'no raw body received' };
  if (typeof header !== 'string' || !/^sha256=[0-9a-f]{64}$/i.test(header.trim())) {
    return { ok: false, error: 'missing or malformed X-Hub-Signature-256 header' };
  }
  const expected = Buffer.from(signatureFor(rawBody, appSecret, crypto));
  const given = Buffer.from(header.trim().toLowerCase());
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, error: 'signature does not match' };
  }
  return { ok: true, error: null };
}

// One webhook POST can carry several leads (several entries and changes).
function extractLeadgenEvents(body) {
  if (!body || body.object !== 'page' || !Array.isArray(body.entry)) return [];
  const events = [];
  for (const entry of body.entry) {
    for (const change of (entry && entry.changes) || []) {
      const v = change && change.field === 'leadgen' ? change.value || {} : null;
      if (!v || !/^\d+$/.test(String(v.leadgen_id || ''))) continue;
      events.push({
        leadgenId: String(v.leadgen_id),
        pageId: String(v.page_id || entry.id || ''),
        formId: String(v.form_id || ''),
        adId: String(v.ad_id || ''),
        createdTime: v.created_time ? new Date(Number(v.created_time) * 1000).toISOString() : '',
      });
    }
  }
  return events;
}

function graphLeadUrl(leadgenId, version, baseUrl) {
  if (!/^\d+$/.test(String(leadgenId))) throw new Error(`invalid leadgen_id: ${leadgenId}`);
  const base = String(baseUrl || 'https://graph.facebook.com').replace(/\/+$/, '');
  return `${base}/${version || 'v26.0'}/${leadgenId}?fields=${GRAPH_LEAD_FIELDS}`;
}

function questionLabel(key) {
  const s = String(key).replace(/[_?]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Answer';
}

// Graph lead -> the JSON body the "Lead webhook" in the main pipeline accepts.
// Standard questions map to fields; every custom question becomes a line of
// the message, which is what Claude reads when it rates the lead. A form's
// "website" question goes into the message too, never into body.website,
// because that field is the pipeline's spam honeypot.
function graphLeadToPipelineBody(graphLead, event) {
  const lead = graphLead && typeof graphLead === 'object' ? graphLead : {};
  const out = {};
  const extra = [];
  for (const f of Array.isArray(lead.field_data) ? lead.field_data : []) {
    if (!f || !f.name) continue;
    const value = (Array.isArray(f.values) ? f.values : [f.values]).filter((v) => v !== undefined && v !== null && v !== '').join(', ');
    if (!value) continue;
    const key = String(f.name).toLowerCase();
    if (STANDARD[key] && !out[STANDARD[key]]) out[STANDARD[key]] = value;
    else if (/budget/.test(key) && !out.budget) out.budget = value;
    else extra.push(`${questionLabel(f.name)}: ${value}`);
  }
  const name = out.name || [out.firstName, out.lastName].filter(Boolean).join(' ');
  const context = [lead.campaign_name && `Campaign: ${lead.campaign_name}`, lead.ad_name && `Ad: ${lead.ad_name}`].filter(Boolean);
  let message = extra.join('\n');
  if (message.length < 10) {
    message = [message, `Facebook lead form ${lead.form_id || (event && event.formId) || ''} submitted with no free-text answers.`].filter(Boolean).join('\n');
  }
  if (context.length) message += `\n(${context.join(', ')})`;
  const body = {
    name,
    email: out.email || '',
    phone: out.phone || '',
    company: out.company || '',
    budget: out.budget || '',
    message,
    source: lead.is_organic ? 'facebook_lead_form_organic' : 'facebook_lead_ads',
    facebook_leadgen_id: String(lead.id || (event && event.leadgenId) || ''),
  };
  return body;
}

if (typeof module !== 'undefined') {
  module.exports = {
    GRAPH_LEAD_FIELDS, verifyHandshake, signatureFor, verifySignature,
    extractLeadgenEvents, graphLeadUrl, graphLeadToPipelineBody,
  };
}
