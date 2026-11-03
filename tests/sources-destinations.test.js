// Tests for the Facebook Lead Ads source and the Zoho CRM and Notion
// destinations: the pure logic, and the exported n8n Code nodes run with a
// fake n8n context. No network, no keys.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const meta = require('../src/meta-leads.js');
const { validateLead } = require('../src/validate-lead.js');
const { finalRating } = require('../src/rate-lead.js');
const { buildZohoUpsert, parseZohoUpsert, zohoLeadSource, ZOHO_AI_FIELDS } = require('../src/zoho-lead.js');
const { notionProperties, buildNotionQuery, buildNotionWrite, parseNotionWrite, NOTION_SCHEMA } = require('../src/notion-lead.js');

const ROOT = path.join(__dirname, '..');
const sample = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'samples', 'facebook', f), 'utf8'));
const wf = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8'));
const SECRET = 'test-app-secret-not-real';
const NOW = '2026-11-03T10:00:00.000Z';
const hot = { ok: true, rating: 'Hot', reason: 'Four clinics, budget and a one-month start.', nextStep: 'Call today.' };

// ---------- Meta handshake ----------

test('handshake returns the challenge only for the right token', () => {
  const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1158201444' };
  assert.deepEqual(meta.verifyHandshake(q, 'tok'), { ok: true, challenge: '1158201444' });
  assert.equal(meta.verifyHandshake(q, 'other').ok, false);
  assert.equal(meta.verifyHandshake({ ...q, 'hub.mode': 'unsubscribe' }, 'tok').ok, false);
  assert.equal(meta.verifyHandshake(q, '').ok, false, 'an unset token never matches');
  assert.equal(meta.verifyHandshake(undefined, 'tok').ok, false);
});

// ---------- signature ----------

test('signature check accepts Meta-style signed bytes and rejects everything else', () => {
  const raw = JSON.stringify(sample('webhook-leadgen.json')).replace(/\//g, '\\/');
  const sig = meta.signatureFor(raw, SECRET, crypto);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(meta.verifySignature(raw, sig, SECRET, crypto).ok, true);
  assert.equal(meta.verifySignature(Buffer.from(raw), sig.toUpperCase().replace('SHA256', 'sha256'), SECRET, crypto).ok, true, 'Buffer body, upper-case hex');
  assert.equal(meta.verifySignature(raw + ' ', sig, SECRET, crypto).error, 'signature does not match', 'one extra byte');
  assert.equal(meta.verifySignature(raw, meta.signatureFor(raw, 'wrong', crypto), SECRET, crypto).ok, false);
  assert.match(meta.verifySignature(raw, 'sha1=abc', SECRET, crypto).error, /malformed/);
  assert.match(meta.verifySignature(raw, undefined, SECRET, crypto).error, /missing/);
  assert.match(meta.verifySignature(raw, sig, '', crypto).error, /not configured/);
  assert.match(meta.verifySignature(null, sig, SECRET, crypto).error, /no raw body/);
});

test('signature must be checked on raw bytes: re-serialised JSON would fail', () => {
  const raw = '{"object":"page","note":"caf\\u00e9 \\/ bar"}';
  const sig = meta.signatureFor(raw, SECRET, crypto);
  assert.equal(meta.verifySignature(JSON.stringify(JSON.parse(raw)), sig, SECRET, crypto).ok, false);
  assert.equal(meta.verifySignature(raw, sig, SECRET, crypto).ok, true);
});

// ---------- leadgen events ----------

test('every leadgen change becomes one event; other objects and fields are ignored', () => {
  const events = meta.extractLeadgenEvents(sample('webhook-leadgen.json'));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    leadgenId: '800000000000001', pageId: '100000000000001', formId: '900000000000001',
    adId: '120000000000001', createdTime: new Date(1793700000 * 1000).toISOString(),
  });
  assert.deepEqual(meta.extractLeadgenEvents({ object: 'instagram', entry: [] }), []);
  assert.deepEqual(meta.extractLeadgenEvents({ object: 'page', entry: [{ changes: [{ field: 'feed', value: { leadgen_id: '1' } }] }] }), []);
  assert.deepEqual(meta.extractLeadgenEvents({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: '12; DROP' } }] }] }), [], 'non-numeric IDs dropped');
  assert.deepEqual(meta.extractLeadgenEvents(null), []);
});

test('Graph URL asks for field_data and refuses a non-numeric ID', () => {
  const url = meta.graphLeadUrl('800000000000001', 'v26.0', 'https://graph.facebook.com/');
  assert.equal(url.split('?')[0], 'https://graph.facebook.com/v26.0/800000000000001');
  assert.match(url, /fields=.*field_data/);
  assert.doesNotMatch(url, /access_token/, 'the token is added by the n8n credential, not the URL');
  assert.throws(() => meta.graphLeadUrl('../me'), /invalid leadgen_id/);
});

// ---------- mapping into the existing pipeline ----------

test('a Graph lead maps to a body the existing validation accepts', () => {
  const body = meta.graphLeadToPipelineBody(sample('graph-lead-800000000000001.json'));
  assert.equal(body.name, 'Morgan Testlead');
  assert.equal(body.email, 'morgan.testlead@example.com');
  assert.equal(body.phone, '+15550100001');
  assert.equal(body.company, 'Brightsmile Dental (test)');
  assert.equal(body.budget, '$10,000 to $15,000 total');
  assert.equal(body.source, 'facebook_lead_ads');
  assert.equal(body.facebook_leadgen_id, '800000000000001');
  assert.match(body.message, /What do you need help with: Online booking/);
  assert.match(body.message, /When do you want to start: Within the next month/);
  assert.match(body.message, /Campaign: Clinic booking Q4/);
  // The form's "website" answer goes into the message, never into the honeypot field.
  assert.equal(body.website, undefined);
  assert.match(body.message, /Website: brightsmile\.example\.com/);
  const v = validateLead(body, NOW);
  assert.equal(v.valid, true, v.errors.join(', '));
  assert.equal(v.lead.source, 'facebook_lead_ads');
});

test('first/last name forms and a form with no free-text answers still validate', () => {
  const body = meta.graphLeadToPipelineBody({
    id: '5', form_id: '77', is_organic: true,
    field_data: [{ name: 'first_name', values: ['Ana'] }, { name: 'last_name', values: ['Test'] }, { name: 'email', values: ['ana@example.org'] }],
  });
  assert.equal(body.name, 'Ana Test');
  assert.equal(body.source, 'facebook_lead_form_organic');
  assert.match(body.message, /lead form 77 submitted with no free-text answers/);
  assert.equal(validateLead(body, NOW).valid, true);
  assert.equal(meta.graphLeadToPipelineBody(null).email, '', 'garbage in, empty body out (validation then rejects it)');
});

// ---------- Zoho ----------

test('Zoho upsert is keyed on Email and carries the AI fields', () => {
  const lead = validateLead(meta.graphLeadToPipelineBody(sample('graph-lead-800000000000001.json')), NOW).lead;
  const req = buildZohoUpsert(lead, finalRating(hot, 1));
  assert.deepEqual(req.duplicate_check_fields, ['Email']);
  assert.deepEqual(req.trigger, []);
  const r = req.data[0];
  assert.equal(r.Last_Name, 'Testlead');
  assert.equal(r.First_Name, 'Morgan');
  assert.equal(r.Email, 'morgan.testlead@example.com');
  assert.equal(r.Lead_Source, 'Facebook');
  assert.equal(r.AI_Lead_Rating, 'Hot');
  assert.equal(r.AI_Needs_Review, false);
  assert.match(r.Description, /Budget: \$10,000/);
  for (const f of ZOHO_AI_FIELDS) assert.ok(f.api_name in r, f.api_name);
});

test('Zoho: one-word names go in Last_Name, fallback ratings flag review, sources map to picklist values', () => {
  const lead = validateLead({ name: 'Cher', email: 'cher@example.com', message: 'Need a booking page please.' }, NOW).lead;
  const r = buildZohoUpsert(lead, finalRating({ ok: false, error: 'boom' }, 2)).data[0];
  assert.equal(r.Last_Name, 'Cher');
  assert.equal(r.First_Name, '');
  assert.equal(r.AI_Lead_Rating, 'Warm');
  assert.equal(r.AI_Needs_Review, true);
  assert.equal(zohoLeadSource('facebook_lead_form_organic'), 'Facebook');
  assert.equal(zohoLeadSource('webhook'), 'Web Download');
});

test('Zoho answers are parsed: insert, update, field error, auth error', () => {
  assert.deepEqual(parseZohoUpsert({ data: [{ code: 'SUCCESS', status: 'success', action: 'insert', details: { id: '5000000000000000001' }, message: 'record added' }] }),
    { ok: true, action: 'insert', id: '5000000000000000001', error: null });
  assert.equal(parseZohoUpsert({ data: [{ code: 'SUCCESS', status: 'success', action: 'update', details: { id: '1' } }] }).action, 'update');
  const bad = parseZohoUpsert({ data: [{ code: 'INVALID_DATA', status: 'error', message: 'invalid data', details: { api_name: 'AI_Lead_Rating' } }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /INVALID_DATA.*AI_Lead_Rating/);
  assert.match(parseZohoUpsert({ code: 'INVALID_TOKEN', message: 'invalid oauth token' }).error, /invalid oauth token/);
  assert.equal(parseZohoUpsert(undefined).ok, false);
});

// ---------- Notion ----------

test('Notion row properties match the database schema', () => {
  const lead = validateLead(meta.graphLeadToPipelineBody(sample('graph-lead-800000000000001.json')), NOW).lead;
  const props = notionProperties(lead, finalRating(hot, 1));
  assert.deepEqual(Object.keys(props).sort(), Object.keys(NOTION_SCHEMA).sort());
  assert.equal(props.Name.title[0].text.content, 'Morgan Testlead');
  assert.equal(props.Email.email, 'morgan.testlead@example.com');
  assert.equal(props.Rating.select.name, 'Hot');
  assert.equal(props['Needs review'].checkbox, false);
  assert.equal(props.Received.date.start, NOW);
  const long = notionProperties({ ...lead, message: 'x'.repeat(5000) }, finalRating(hot, 1));
  assert.equal(long.Message.rich_text[0].text.content.length, 2000, 'Notion 2000-char limit respected');
});

test('Notion write creates a new row, or updates the row that already has this email', () => {
  const lead = validateLead({ name: 'Ann Lee', email: 'ann@example.org', message: 'Need a new website soon.' }, NOW).lead;
  const result = finalRating(hot, 1);
  assert.deepEqual(buildNotionQuery('ann@example.org'), { filter: { property: 'Email', email: { equals: 'ann@example.org' } }, page_size: 1 });
  const create = buildNotionWrite('db-1', { object: 'list', results: [] }, lead, result);
  assert.equal(create.action, 'create');
  assert.equal(create.method, 'POST');
  assert.deepEqual(create.body.parent, { database_id: 'db-1' });
  const update = buildNotionWrite('db-1', { object: 'list', results: [{ object: 'page', id: 'page-9' }] }, lead, result);
  assert.equal(update.action, 'update');
  assert.equal(update.method, 'PATCH');
  assert.equal(update.url, 'https://api.notion.com/v1/pages/page-9');
  assert.equal(update.body.parent, undefined);
  assert.equal(buildNotionWrite('db-1', { results: [{ id: 'old', archived: true }] }, lead, result).action, 'create', 'archived rows are not reused');
});

test('Notion answers are parsed', () => {
  assert.deepEqual(parseNotionWrite({ object: 'page', id: 'p1', url: 'https://www.notion.so/p1' }), { ok: true, id: 'p1', url: 'https://www.notion.so/p1', error: null });
  assert.match(parseNotionWrite({ object: 'error', status: 400, code: 'validation_error', message: 'Email is not a property that exists.' }).error, /validation_error: Email/);
  assert.equal(parseNotionWrite(null).ok, false);
});

// ---------- exported workflows ----------

// Runs a Code node's exported source the way n8n does, with a fake context.
async function runNode(workflow, name, { json, items, refs = {}, env = {}, rawBody } = {}) {
  const n = workflow.nodes.find((x) => x.name === name);
  assert.ok(n, `node ${name} exists`);
  const $ = (other) => ({ item: { json: refs[other] }, first: () => ({ json: refs[other] }) });
  const $input = { first: () => (items || [{ json }])[0], all: () => items || [{ json }] };
  const ctx = { helpers: { getBinaryDataBuffer: async () => { if (rawBody === undefined) throw new Error('no binary'); return Buffer.from(rawBody); } } };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction('$json', '$', '$input', '$env', 'require', n.parameters.jsCode);
  return fn.call(ctx, json, $, $input, env, require);
}

const fb = wf('facebook-lead-ads.json');
const main = wf('ai-lead-pipeline.json');

test('Facebook workflow: GET and POST share one path, POST keeps the raw body', () => {
  const get = fb.nodes.find((n) => n.name === 'Meta verify (GET)');
  const post = fb.nodes.find((n) => n.name === 'Meta lead event (POST)');
  assert.equal(get.parameters.path, post.parameters.path);
  assert.equal(get.parameters.httpMethod, 'GET');
  assert.equal(post.parameters.httpMethod, 'POST');
  assert.equal(post.parameters.options.rawBody, true);
  const names = new Set(fb.nodes.map((n) => n.name));
  for (const [from, outs] of Object.entries(fb.connections)) {
    assert.ok(names.has(from), from);
    for (const b of outs.main) for (const c of b) assert.ok(names.has(c.node), `${from} -> ${c.node}`);
  }
  for (const n of fb.nodes) assert.equal(n.credentials, undefined, n.name);
  assert.doesNotMatch(JSON.stringify(fb), /EAA[A-Za-z0-9]{20}|app_secret|sk-ant-/);
  assert.equal(fb.nodes.find((n) => n.name === 'Graph: fetch lead').parameters.nodeCredentialType, 'facebookGraphApi');
});

test('Facebook workflow: Meta is answered (200) before the Graph fetch, and only on a valid signature', () => {
  const next = (name) => (fb.connections[name]?.main || []).map((b) => b.map((c) => c.node));
  assert.deepEqual(next('Signature OK?'), [['Respond 200 to Meta'], ['Respond 403 bad signature']]);
  assert.deepEqual(next('Respond 200 to Meta'), [['FB Config']]);
  assert.deepEqual(next('Dedupe by leadgen_id'), [['Graph: fetch lead']]);
  assert.deepEqual(next('Map to pipeline lead'), [['Send to lead pipeline']]);
});

test('Code node "Check handshake" uses the env token', async () => {
  const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '42' };
  assert.deepEqual((await runNode(fb, 'Check handshake', { json: { query: q }, env: { META_VERIFY_TOKEN: 'tok' } })).json, { ok: true, challenge: '42' });
  assert.equal((await runNode(fb, 'Check handshake', { json: { query: q }, env: {} })).json.ok, false);
});

test('Code node "Verify signature" checks the raw body and extracts events', async () => {
  const raw = JSON.stringify(sample('webhook-leadgen.json'));
  const body = JSON.parse(raw);
  const sig = meta.signatureFor(raw, SECRET, crypto);
  const ok = await runNode(fb, 'Verify signature', { json: { headers: { 'x-hub-signature-256': sig }, body }, env: { META_APP_SECRET: SECRET }, rawBody: raw });
  assert.equal(ok[0].json.valid, true);
  assert.equal(ok[0].json.events.length, 2);
  const forged = await runNode(fb, 'Verify signature', { json: { headers: { 'x-hub-signature-256': meta.signatureFor(raw, 'x', crypto) }, body }, env: { META_APP_SECRET: SECRET }, rawBody: raw });
  assert.equal(forged[0].json.valid, false);
  assert.deepEqual(forged[0].json.events, [], 'no events leak out of a forged request');
  const noRaw = await runNode(fb, 'Verify signature', { json: { headers: { 'x-hub-signature-256': sig }, body }, env: { META_APP_SECRET: SECRET } });
  assert.match(noRaw[0].json.error, /no raw body/);
});

test('Code nodes "Split leadgen events" -> "Map to pipeline lead" -> "Check pipeline reply"', async () => {
  const events = meta.extractLeadgenEvents(sample('webhook-leadgen.json'));
  const split = await runNode(fb, 'Split leadgen events', { refs: { 'FB Config': { graph_api_version: 'v26.0', graph_base_url: 'http://localhost:5690' }, 'Verify signature': { events } } });
  assert.equal(split.length, 2);
  assert.match(split[0].json.graphUrl, /^http:\/\/localhost:5690\/v26\.0\/800000000000001\?fields=/);
  const mapped = await runNode(fb, 'Map to pipeline lead', { json: sample('graph-lead-800000000000001.json'), refs: { 'Dedupe by leadgen_id': split[0].json } });
  assert.equal(mapped.json.email, 'morgan.testlead@example.com');
  const refs = { 'Map to pipeline lead': mapped.json };
  assert.equal((await runNode(fb, 'Check pipeline reply', { json: { statusCode: 202, body: { status: 'accepted' } }, refs })).json.pipeline_status, 202);
  assert.equal((await runNode(fb, 'Check pipeline reply', { json: { statusCode: 200, body: { status: 'duplicate' } }, refs })).json.pipeline_status, 200);
  await assert.rejects(runNode(fb, 'Check pipeline reply', { json: { statusCode: 400, body: { errors: ['email is required'] } }, refs }), /did not accept Facebook lead 800000000000001: HTTP 400/);
});

test('main pipeline: Zoho and Notion run from Finalise rating with retries and fail loud', async () => {
  const next = (name) => (main.connections[name]?.main || []).flat().map((c) => c.node);
  assert.ok(next('Finalise rating').includes('Zoho: upsert lead'));
  assert.ok(next('Finalise rating').includes('Notion: find lead'));
  assert.deepEqual(next('Notion: create or update'), ['Notion: write row']);
  for (const name of ['Zoho: upsert lead', 'Notion: find lead', 'Notion: write row']) {
    const n = main.nodes.find((x) => x.name === name);
    assert.equal(n.retryOnFail, true, name);
    assert.equal(n.onError, undefined, `${name} must not swallow errors`);
  }
  assert.equal(main.nodes.find((x) => x.name === 'Zoho: upsert lead').parameters.nodeCredentialType, 'zohoOAuth2Api');
  const notion = main.nodes.find((x) => x.name === 'Notion: write row');
  assert.equal(notion.parameters.nodeCredentialType, 'notionApi');
  assert.deepEqual(notion.parameters.headerParameters.parameters, [{ name: 'Notion-Version', value: '2022-06-28' }]);

  const fin = { lead: validateLead({ name: 'Ann Lee', email: 'ann@example.org', message: 'Need a new website soon.' }, NOW).lead, result: finalRating(hot, 1) };
  const refs = { 'Finalise rating': fin, Config: { notion_database_id: 'db-1' }, 'Notion: create or update': { action: 'create' } };
  assert.equal((await runNode(main, 'Zoho: check result', { json: { data: [{ code: 'SUCCESS', status: 'success', action: 'insert', details: { id: '9' } }] }, refs })).json.zoho_lead_id, '9');
  await assert.rejects(runNode(main, 'Zoho: check result', { json: { data: [{ code: 'MANDATORY_NOT_FOUND', status: 'error', message: 'required field not found' }] }, refs }), /Zoho CRM rejected the lead: MANDATORY_NOT_FOUND/);
  const write = await runNode(main, 'Notion: create or update', { json: { results: [] }, refs });
  assert.equal(write.json.action, 'create');
  assert.equal((await runNode(main, 'Notion: check result', { json: { object: 'page', id: 'p1', url: 'u' }, refs })).json.notion_page_id, 'p1');
  await assert.rejects(runNode(main, 'Notion: check result', { json: { object: 'error', code: 'unauthorized', message: 'API token is invalid.' }, refs }), /Notion rejected the lead: unauthorized/);
});

test('Finalise rating now also builds the Zoho request and Notion query', async () => {
  const lead = validateLead({ name: 'Ann Lee', email: 'ann@example.org', message: 'Need a new website soon.' }, NOW).lead;
  const parsed = { ok: true, rating: 'Warm', reason: 'Vague.', nextStep: 'Ask.', error: null };
  const out = (await runNode(main, 'Finalise rating', { json: { lead, parsed, attempts: 1 }, refs: { Config: { business_name: 'Acme' } } })).json;
  assert.equal(out.zoho.data[0].Email, 'ann@example.org');
  assert.equal(out.zoho.data[0].AI_Lead_Rating, 'Warm');
  assert.deepEqual(out.notion_query.filter.email, { equals: 'ann@example.org' });
});
