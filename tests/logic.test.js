// Unit tests for the logic that runs inside the n8n Code nodes.
// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateLead } = require('../src/validate-lead.js');
const { buildClaudeRequest, parseRating, finalRating, MODEL, RATING_SCHEMA } = require('../src/rate-lead.js');
const { sheetRow, slackText, welcomeEmail, errorAlert } = require('../src/messages.js');

const NOW = '2026-11-01T12:00:00.000Z';
const good = {
  name: '  Dana   Example ',
  email: ' Dana@Example.COM ',
  company: 'Example Dental Group',
  budget: '$5k-$10k',
  message: 'We need an online booking system live before January, can we get a quote this week?',
};

function apiResponse(text, stop = 'end_turn') {
  return { id: 'msg_test', type: 'message', stop_reason: stop, content: [{ type: 'text', text }] };
}

// ---------- validation ----------

test('valid lead is normalised (email lowercased, whitespace collapsed, name split)', () => {
  const r = validateLead(good, NOW);
  assert.equal(r.valid, true);
  assert.equal(r.lead.email, 'dana@example.com');
  assert.equal(r.lead.name, 'Dana Example');
  assert.equal(r.lead.firstName, 'Dana');
  assert.equal(r.lead.lastName, 'Example');
  assert.equal(r.lead.source, 'webhook');
  assert.equal(r.lead.receivedAt, NOW);
});

test('missing and malformed fields are all reported', () => {
  const r = validateLead({ email: 'not-an-email', message: 'hi' }, NOW);
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, [
    'email is not a valid address',
    'name is required',
    'message is too short to assess (min 10 characters)',
  ]);
});

test('empty or non-object body is rejected, not thrown', () => {
  assert.equal(validateLead(undefined, NOW).valid, false);
  assert.equal(validateLead('junk', NOW).valid, false);
});

test('honeypot field marks the submission as spam', () => {
  const r = validateLead({ ...good, website: 'http://spam.example' }, NOW);
  assert.equal(r.valid, false);
  assert.match(r.errors[0], /honeypot/);
});

test('over-long fields are truncated', () => {
  const r = validateLead({ ...good, message: 'x'.repeat(10000) }, NOW);
  assert.equal(r.lead.message.length, 4000);
});

// ---------- Claude request ----------

test('request uses the right model, structured output schema and treats lead as data', () => {
  const lead = validateLead(good, NOW).lead;
  const req = buildClaudeRequest(lead, 'A web studio.', 1);
  assert.equal(req.model, MODEL);
  assert.equal(req.model, 'claude-sonnet-5-5');
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: RATING_SCHEMA });
  assert.match(req.system, /not instructions/);
  assert.match(req.messages[0].content, /<lead>[\s\S]*Example Dental Group[\s\S]*<\/lead>/);
  assert.equal(req.messages.length, 1, 'no assistant prefill');
});

test('retry request tells the model what went wrong', () => {
  const lead = validateLead(good, NOW).lead;
  const req = buildClaudeRequest(lead, 'A web studio.', 2, 'answer was not valid JSON');
  assert.match(req.messages[0].content, /previous answer could not be used \(answer was not valid JSON\)/);
});

// ---------- parsing ----------

test('good answer parses', () => {
  const p = parseRating(apiResponse('{"rating":"Hot","reason":"Budget and deadline given.","next_step":"Call today."}'));
  assert.deepEqual(p, { ok: true, rating: 'Hot', reason: 'Budget and deadline given.', nextStep: 'Call today.', error: null });
});

test('fenced JSON still parses', () => {
  const p = parseRating(apiResponse('```json\n{"rating":"Cold","reason":"Job seeker.","next_step":"Archive."}\n```'));
  assert.equal(p.ok, true);
  assert.equal(p.rating, 'Cold');
});

test('bad answers are rejected with a clear reason', () => {
  const cases = [
    [apiResponse('Sure! This lead is hot.'), /not valid JSON/],
    [apiResponse('{"rating":"Very hot","reason":"x","next_step":"y"}'), /not Hot, Warm or Cold/],
    [apiResponse('{"rating":"Hot","reason":"","next_step":"y"}'), /reason is missing/],
    [apiResponse('[1,2]'), /not a JSON object/],
    [apiResponse('{"rating":"Hot"', 'max_tokens'), /cut off/],
    [{ stop_reason: 'refusal', content: [] }, /declined/],
    [{ content: [] }, /no text block/],
    [{ error: { message: '529 overloaded' } }, /API error: 529 overloaded/],
    [null, /empty response/],
  ];
  for (const [input, re] of cases) {
    const p = parseRating(input);
    assert.equal(p.ok, false, JSON.stringify(input));
    assert.match(p.error, re);
  }
});

test('fallback is Warm and flagged for review, never Cold', () => {
  const f = finalRating({ ok: false, error: 'answer was not valid JSON' }, 2);
  assert.equal(f.rating, 'Warm');
  assert.equal(f.needsReview, true);
  assert.equal(f.attempts, 2);
  assert.match(f.reason, /not valid JSON/);
});

test('successful parse passes straight through', () => {
  const f = finalRating({ ok: true, rating: 'Hot', reason: 'r', nextStep: 'n' }, 1);
  assert.deepEqual(f, { rating: 'Hot', reason: 'r', nextStep: 'n', needsReview: false, attempts: 1, ratingError: '' });
});

// ---------- outputs ----------

test('sheet row has every column in a stable order', () => {
  const lead = validateLead(good, NOW).lead;
  const row = sheetRow(lead, finalRating({ ok: true, rating: 'Hot', reason: 'r', nextStep: 'n' }, 1));
  assert.deepEqual(Object.keys(row), [
    'received_at', 'email', 'name', 'company', 'budget', 'source',
    'rating', 'reason', 'next_step', 'needs_review', 'ai_attempts', 'message',
  ]);
  assert.equal(row.needs_review, 'no');
});

test('slack text and welcome email use the lead details', () => {
  const lead = validateLead(good, NOW).lead;
  const res = finalRating({ ok: true, rating: 'Hot', reason: 'Budget given.', nextStep: 'Call.' }, 1);
  assert.match(slackText(lead, res), /Hot lead:\* Dana Example \(Example Dental Group\)/);
  const mail = welcomeEmail(lead, 'Acme Studio');
  assert.match(mail.subject, /Acme Studio/);
  assert.match(mail.body, /^Hi Dana,/);
});

test('error alert names the workflow, node and message, and copes with missing fields', () => {
  const a = errorAlert({
    workflow: { name: 'AI Lead Pipeline' },
    execution: { id: '42', url: 'https://n8n.example/execution/42', mode: 'webhook', error: { message: 'HubSpot 401', node: { name: 'HubSpot: upsert contact' } } },
  });
  assert.match(a.subject, /AI Lead Pipeline at "HubSpot: upsert contact"/);
  assert.match(a.body, /HubSpot 401/);
  assert.doesNotThrow(() => errorAlert({}));
});
