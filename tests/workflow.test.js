// Structural tests for the exported n8n workflows, plus running each Code
// node's real source with a fake n8n context.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const load = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', f), 'utf8'));
const main = load('ai-lead-pipeline.json');
const errWf = load('error-alert.json');
const byName = (wf, name) => wf.nodes.find((n) => n.name === name);

function runCodeNode(wf, name, json, refs = {}) {
  const n = byName(wf, name);
  assert.ok(n, `node ${name} exists`);
  const $ = (other) => ({ item: { json: refs[other] }, first: () => ({ json: refs[other] }) });
  // Same shape as n8n's "Run once for each item" mode: top-level return.
  const fn = new Function('$json', '$', n.parameters.jsCode);
  return fn(json, $).json;
}

test('exported workflows are up to date with src/ (build --check)', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-workflow.js'), '--check']);
});

test('every connection points at a node that exists, and names are unique', () => {
  for (const wf of [main, errWf]) {
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.equal(names.size, wf.nodes.length);
    for (const [from, outs] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), from);
      for (const branch of outs.main) for (const c of branch) assert.ok(names.has(c.node), `${from} -> ${c.node}`);
    }
  }
});

test('pipeline has the expected path from webhook to every destination', () => {
  const next = (name) => (main.connections[name]?.main || []).flat().map((c) => c.node);
  const reach = new Set();
  const walk = (n) => { if (reach.has(n)) return; reach.add(n); next(n).forEach(walk); };
  walk('Lead webhook');
  for (const n of ['Dedupe by email', 'Claude: rate lead', 'Claude: retry', 'HubSpot: upsert contact',
    'Google Sheets: log lead', 'Slack: alert sales', 'Gmail: welcome email', 'Respond 400 invalid', 'Respond 200 duplicate']) {
    assert.ok(reach.has(n), `${n} reachable`);
  }
  assert.deepEqual(next('Hot lead?'), ['Slack: alert sales'], 'Slack only on the true branch');
});

test('no credentials, IDs or real addresses are shipped in the export', () => {
  const text = JSON.stringify([main, errWf]);
  for (const n of [...main.nodes, ...errWf.nodes]) assert.equal(n.credentials, undefined, n.name);
  assert.doesNotMatch(text, /sk-ant-|xox[bp]-|@gmail\.com|app\.n8n\.cloud/);
  assert.equal(main.settings.errorWorkflow, '');
});

test('Claude HTTP nodes retry, never fail the run, and use the Anthropic credential type', () => {
  for (const name of ['Claude: rate lead', 'Claude: retry']) {
    const n = byName(main, name);
    assert.equal(n.retryOnFail, true);
    assert.equal(n.maxTries, 3);
    assert.equal(n.onError, 'continueRegularOutput');
    assert.equal(n.parameters.nodeCredentialType, 'anthropicApi');
  }
});

test('Code node "Validate and normalise" runs with a fake n8n context', () => {
  const out = runCodeNode(main, 'Validate and normalise', { body: { name: 'Ann Lee', email: 'ANN@example.org', message: 'Need a new website soon.' } });
  assert.equal(out.valid, true);
  assert.equal(out.lead.email, 'ann@example.org');
});

test('Code nodes chain: build request -> parse -> finalise', () => {
  const lead = { name: 'Ann Lee', firstName: 'Ann', lastName: 'Lee', email: 'ann@example.org', company: '', budget: '', source: 'webhook', message: 'Need a new website soon.', receivedAt: 'x' };
  const config = { business_profile: 'A studio.', business_name: 'Acme Web Studio' };
  const built = runCodeNode(main, 'Build Claude request', { lead }, { Config: config });
  assert.equal(built.request.model, 'claude-sonnet-5-5');

  const apiReply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"rating":"Warm","reason":"Vague timeline.","next_step":"Ask for budget."}' }] };
  const parsed = runCodeNode(main, 'Parse rating', apiReply, { 'Build Claude request': built });
  assert.equal(parsed.parsed.ok, true);

  const fin = runCodeNode(main, 'Finalise rating', parsed, { Config: config });
  assert.equal(fin.result.rating, 'Warm');
  assert.equal(fin.sheet_row.email, 'ann@example.org');
  assert.match(fin.welcome.subject, /Acme Web Studio/);
});

test('Code node "Parse retry" turns a failed API call into the safe fallback', () => {
  const lead = { email: 'ann@example.org' };
  const parsed = runCodeNode(main, 'Parse retry', { error: { message: 'Authorization failed' } }, { 'Build retry request': { lead } });
  assert.equal(parsed.parsed.ok, false);
  const fin = runCodeNode(main, 'Finalise rating', { ...parsed, lead: { ...lead, name: 'Ann', firstName: 'Ann', message: 'm', receivedAt: 'x' } }, { Config: { business_name: 'Acme' } });
  assert.equal(fin.result.rating, 'Warm');
  assert.equal(fin.result.needsReview, true);
});

test('error workflow formats an alert from an Error Trigger payload', () => {
  const out = runCodeNode(errWf, 'Format alert', {
    workflow: { name: 'AI Lead Pipeline' },
    execution: { id: '6', mode: 'webhook', error: { message: 'Node does not have any credentials set', node: { name: 'HubSpot: upsert contact' } } },
  });
  assert.match(out.subject, /HubSpot: upsert contact/);
});
