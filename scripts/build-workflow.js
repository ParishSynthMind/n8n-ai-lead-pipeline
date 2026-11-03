#!/usr/bin/env node
// Builds the importable n8n workflow files in workflows/ from the tested
// logic in src/. The Code nodes get the exact source the unit tests run.
//
//   node scripts/build-workflow.js           write workflows/*.json
//   node scripts/build-workflow.js --check   fail if workflows/*.json are stale
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');

// Placeholders a client replaces after import (see README "Setup").
const CONFIG = {
  business_name: 'Acme Web Studio',
  business_profile:
    'Acme Web Studio builds websites, online booking and small business automations for clinics, salons and local service firms. Typical projects are $3k to $25k.',
  google_sheet_id: 'REPLACE_WITH_GOOGLE_SHEET_ID',
  google_sheet_tab: 'Leads',
  slack_channel: '#leads',
  zoho_api_base: 'https://www.zohoapis.com/crm/v8',
  notion_database_id: 'REPLACE_WITH_NOTION_DATABASE_ID',
};
// Facebook Lead Ads intake workflow settings (secrets come from n8n env vars).
const FB_CONFIG = {
  graph_base_url: 'https://graph.facebook.com',
  graph_api_version: 'v26.0',
  pipeline_webhook_url: 'https://REPLACE_WITH_YOUR_N8N/webhook/lead-intake',
};
const ALERT_EMAIL = 'ops@example.com';

let x = 0;
const pos = (col, row = 0) => [Math.round(col * 220), Math.round(row * 170)];
const node = (name, type, typeVersion, parameters, position, extra = {}) => ({
  parameters,
  name,
  type: `n8n-nodes-base.${type}`,
  typeVersion,
  position,
  id: `node-${String(++x).padStart(2, '0')}`,
  ...extra,
});
const code = (body) => ({ mode: 'runOnceForEachItem', language: 'javaScript', jsCode: body });
const ifNotEmpty = (id, left) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id, leftValue: left, rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});
const ifTrue = (id, left) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id, leftValue: left, rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});
const ifEquals = (id, left, right) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id, leftValue: left, rightValue: right, operator: { type: 'string', operation: 'equals' } }],
    combinator: 'and',
  },
  options: {},
});
const respond = (code, body) => ({
  respondWith: 'json',
  responseBody: body,
  options: { responseCode: code },
});
const claudeHttp = (bodyExpr) => ({
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'anthropicApi',
  sendHeaders: true,
  headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: bodyExpr,
  options: { timeout: 60000 },
});
// Retry transient API failures inside the node, then hand any final error to
// the parser instead of failing the run, so the lead still gets the fallback.
const claudeSettings = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, onError: 'continueRegularOutput' };
// CRM writes retry transient errors, then fail loud so the error workflow fires.
const crmSettings = { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 };
const notionHeaders = { parameters: [{ name: 'Notion-Version', value: '2022-06-28' }] };
const allItems = (body) => ({ mode: 'runOnceForAllItems', language: 'javaScript', jsCode: body });

function mainWorkflow() {
  x = 0;
  const N = {
    webhook: node('Lead webhook', 'webhook', 2, {
      httpMethod: 'POST',
      path: 'lead-intake',
      responseMode: 'responseNode',
      options: {},
    }, pos(0, 0), { webhookId: 'lead-intake' }),
    config: node('Config', 'set', 3.4, {
      assignments: {
        assignments: Object.entries(CONFIG).map(([name, value], i) => ({ id: `cfg-${i}`, name, value, type: 'string' })),
      },
      includeOtherFields: true,
      options: {},
    }, pos(1, 0)),
    validate: node('Validate and normalise', 'code', 2, code(
      `${src('validate-lead.js')}\n// ---- n8n glue ----\nreturn { json: validateLead($json.body, new Date().toISOString()) };\n`,
    ), pos(2, 0)),
    isValid: node('Valid?', 'if', 2.2, ifTrue('valid', '={{ $json.valid }}'), pos(3, 0)),
    reject: node('Respond 400 invalid', 'respondToWebhook', 1.1,
      respond(400, '={{ { "status": "rejected", "errors": $json.errors } }}'), pos(4, 1)),
    dedupe: node('Dedupe by email', 'removeDuplicates', 2, {
      operation: 'removeItemsSeenInPreviousExecutions',
      dedupeValue: '={{ $json.lead.email }}',
      options: { historySize: 10000 },
    }, pos(4, 0), { alwaysOutputData: true }),
    isNew: node('New lead?', 'if', 2.2, ifNotEmpty('new', '={{ $json.lead?.email ?? "" }}'), pos(5, 0)),
    duplicate: node('Respond 200 duplicate', 'respondToWebhook', 1.1,
      respond(200, '={{ { "status": "duplicate", "message": "This email has already been received." } }}'), pos(6, 1)),
    accept: node('Respond 202 accepted', 'respondToWebhook', 1.1,
      respond(202, '={{ { "status": "accepted", "email": $json.lead.email } }}'), pos(6, 0)),
    build1: node('Build Claude request', 'code', 2, code(
      `${src('rate-lead.js')}\n// ---- n8n glue ----\nconst profile = $('Config').item.json.business_profile;\nreturn { json: { lead: $json.lead, request: buildClaudeRequest($json.lead, profile, 1) } };\n`,
    ), pos(7, 0)),
    claude1: node('Claude: rate lead', 'httpRequest', 4.2,
      claudeHttp('={{ JSON.stringify($json.request) }}'), pos(8, 0), claudeSettings),
    parse1: node('Parse rating', 'code', 2, code(
      `${src('rate-lead.js')}\n// ---- n8n glue ----\nreturn { json: { lead: $('Build Claude request').item.json.lead, parsed: parseRating($json), attempts: 1 } };\n`,
    ), pos(9, 0)),
    ok1: node('Rating OK?', 'if', 2.2, ifTrue('ok', '={{ $json.parsed.ok }}'), pos(10, 0)),
    build2: node('Build retry request', 'code', 2, code(
      `${src('rate-lead.js')}\n// ---- n8n glue ----\nconst profile = $('Config').item.json.business_profile;\nreturn { json: { lead: $json.lead, request: buildClaudeRequest($json.lead, profile, 2, $json.parsed.error) } };\n`,
    ), pos(11, 1)),
    claude2: node('Claude: retry', 'httpRequest', 4.2,
      claudeHttp('={{ JSON.stringify($json.request) }}'), pos(12, 1), claudeSettings),
    parse2: node('Parse retry', 'code', 2, code(
      `${src('rate-lead.js')}\n// ---- n8n glue ----\nreturn { json: { lead: $('Build retry request').item.json.lead, parsed: parseRating($json), attempts: 2 } };\n`,
    ), pos(13, 1)),
    finalise: node('Finalise rating', 'code', 2, code(
      `${src('rate-lead.js')}\n${src('messages.js')}\n${src('zoho-lead.js')}\n${src('notion-lead.js')}\n// ---- n8n glue ----\nconst result = finalRating($json.parsed, $json.attempts);\nconst lead = $json.lead;\nconst businessName = $('Config').first().json.business_name;\nreturn { json: { lead, result, sheet_row: sheetRow(lead, result), slack_text: slackText(lead, result), welcome: welcomeEmail(lead, businessName), zoho: buildZohoUpsert(lead, result), notion_query: buildNotionQuery(lead.email) } };\n`,
    ), pos(14, 0)),
    hubspot: node('HubSpot: upsert contact', 'hubspot', 2.1, {
      authentication: 'oAuth2',
      resource: 'contact',
      operation: 'upsert',
      email: '={{ $json.lead.email }}',
      additionalFields: {
        firstName: '={{ $json.lead.firstName }}',
        lastName: '={{ $json.lead.lastName }}',
        companyName: '={{ $json.lead.company }}',
        message: '={{ $json.lead.message }}',
        lifeCycleStage: 'lead',
        customPropertiesUi: {
          customPropertiesValues: [
            { property: 'ai_lead_rating', value: '={{ $json.result.rating }}' },
            { property: 'ai_lead_reason', value: '={{ $json.result.reason }}' },
            { property: 'ai_needs_review', value: '={{ $json.result.needsReview ? "true" : "false" }}' },
          ],
        },
      },
    }, pos(15.5, -1.5)),
    sheetRowNode: node('Sheet row', 'code', 2, code('return { json: $json.sheet_row };\n'), pos(15.5, -0.5)),
    sheets: node('Google Sheets: log lead', 'googleSheets', 4.5, {
      operation: 'append',
      documentId: { __rl: true, mode: 'id', value: `={{ $('Config').first().json.google_sheet_id }}` },
      sheetName: { __rl: true, mode: 'name', value: `={{ $('Config').first().json.google_sheet_tab }}` },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: {},
    }, pos(16.5, -0.5)),
    isHot: node('Hot lead?', 'if', 2.2, ifEquals('hot', '={{ $json.result.rating }}', 'Hot'), pos(15.5, 0.5)),
    slack: node('Slack: alert sales', 'slack', 2.3, {
      authentication: 'oAuth2',
      select: 'channel',
      channelId: { __rl: true, mode: 'name', value: `={{ $('Config').first().json.slack_channel }}` },
      text: '={{ $json.slack_text }}',
      otherOptions: { includeLinkToWorkflow: false },
    }, pos(16.5, 0.5)),
    gmail: node('Gmail: welcome email', 'gmail', 2.1, {
      sendTo: '={{ $json.lead.email }}',
      subject: '={{ $json.welcome.subject }}',
      emailType: 'text',
      message: '={{ $json.welcome.body }}',
      options: { appendAttribution: false, senderName: `={{ $('Config').first().json.business_name }}` },
    }, pos(15.5, 1.5)),
    zoho: node('Zoho: upsert lead', 'httpRequest', 4.2, {
      method: 'POST',
      url: `={{ $('Config').first().json.zoho_api_base }}/Leads/upsert`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'zohoOAuth2Api',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.zoho) }}',
      options: { timeout: 30000 },
    }, pos(15.5, 2.5), crmSettings),
    zohoCheck: node('Zoho: check result', 'code', 2, code(
      `${src('zoho-lead.js')}\n// ---- n8n glue ----\nconst r = parseZohoUpsert($json);\nif (!r.ok) throw new Error('Zoho CRM rejected the lead: ' + r.error);\nreturn { json: { zoho_action: r.action, zoho_lead_id: r.id, email: $('Finalise rating').item.json.lead.email } };\n`,
    ), pos(16.5, 2.5)),
    notionFind: node('Notion: find lead', 'httpRequest', 4.2, {
      method: 'POST',
      url: `=https://api.notion.com/v1/databases/{{ $('Config').first().json.notion_database_id }}/query`,
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'notionApi',
      sendHeaders: true,
      headerParameters: notionHeaders,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.notion_query) }}',
      options: { timeout: 30000 },
    }, pos(15.5, 3.5), crmSettings),
    notionBuild: node('Notion: create or update', 'code', 2, code(
      `${src('notion-lead.js')}\n// ---- n8n glue ----\nconst fin = $('Finalise rating').item.json;\nreturn { json: buildNotionWrite($('Config').first().json.notion_database_id, $json, fin.lead, fin.result) };\n`,
    ), pos(16.5, 3.5)),
    notionWrite: node('Notion: write row', 'httpRequest', 4.2, {
      method: '={{ $json.method }}',
      url: '={{ $json.url }}',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'notionApi',
      sendHeaders: true,
      headerParameters: notionHeaders,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 30000 },
    }, pos(17.5, 3.5), crmSettings),
    notionCheck: node('Notion: check result', 'code', 2, code(
      `${src('notion-lead.js')}\n// ---- n8n glue ----\nconst r = parseNotionWrite($json);\nif (!r.ok) throw new Error('Notion rejected the lead: ' + r.error);\nreturn { json: { notion_action: $('Notion: create or update').item.json.action, notion_page_id: r.id, notion_url: r.url } };\n`,
    ), pos(18.5, 3.5)),
  };

  const c = {};
  const link = (from, to, outIndex = 0) => {
    c[from.name] = c[from.name] || { main: [] };
    while (c[from.name].main.length <= outIndex) c[from.name].main.push([]);
    c[from.name].main[outIndex].push({ node: to.name, type: 'main', index: 0 });
  };
  link(N.webhook, N.config);
  link(N.config, N.validate);
  link(N.validate, N.isValid);
  link(N.isValid, N.dedupe, 0);
  link(N.isValid, N.reject, 1);
  link(N.dedupe, N.isNew);
  link(N.isNew, N.accept, 0);
  link(N.isNew, N.duplicate, 1);
  link(N.accept, N.build1);
  link(N.build1, N.claude1);
  link(N.claude1, N.parse1);
  link(N.parse1, N.ok1);
  link(N.ok1, N.finalise, 0);
  link(N.ok1, N.build2, 1);
  link(N.build2, N.claude2);
  link(N.claude2, N.parse2);
  link(N.parse2, N.finalise);
  link(N.finalise, N.hubspot);
  link(N.finalise, N.sheetRowNode);
  link(N.finalise, N.isHot);
  link(N.finalise, N.gmail);
  link(N.sheetRowNode, N.sheets);
  link(N.isHot, N.slack, 0);
  link(N.finalise, N.zoho);
  link(N.zoho, N.zohoCheck);
  link(N.finalise, N.notionFind);
  link(N.notionFind, N.notionBuild);
  link(N.notionBuild, N.notionWrite);
  link(N.notionWrite, N.notionCheck);

  return {
    name: 'AI Lead Pipeline',
    nodes: Object.values(N),
    connections: c,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner', errorWorkflow: '' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

function errorWorkflow() {
  x = 100;
  const trigger = node('Error Trigger', 'errorTrigger', 1, {}, pos(0));
  const format = node('Format alert', 'code', 2, code(
    `${src('messages.js')}\n// ---- n8n glue ----\nreturn { json: errorAlert($json) };\n`,
  ), pos(1));
  const mail = node('Gmail: alert ops', 'gmail', 2.1, {
    sendTo: ALERT_EMAIL,
    subject: '={{ $json.subject }}',
    emailType: 'text',
    message: '={{ $json.body }}',
    options: { appendAttribution: false },
  }, pos(2));
  return {
    name: 'AI Lead Pipeline: error alert',
    nodes: [trigger, format, mail],
    connections: {
      [trigger.name]: { main: [[{ node: format.name, type: 'main', index: 0 }]] },
      [format.name]: { main: [[{ node: mail.name, type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
    pinData: {},
    tags: [],
  };
}

// Reads a secret from n8n Variables ($vars, n8n Cloud / Enterprise) or from
// an environment variable ($env, self-hosted). Never from the workflow JSON.
const SECRET_GLUE = `const secret = (name) => {
  try { if (typeof $vars !== 'undefined' && $vars[name]) return $vars[name]; } catch (e) {}
  try { return $env[name]; } catch (e) { return undefined; }
};
`;

function facebookWorkflow() {
  x = 200;
  const N = {
    getHook: node('Meta verify (GET)', 'webhook', 2, {
      httpMethod: 'GET',
      path: 'fb-lead-ads',
      responseMode: 'responseNode',
      options: {},
    }, pos(0, -1), { webhookId: 'fb-lead-ads-verify' }),
    handshake: node('Check handshake', 'code', 2, code(
      `${src('meta-leads.js')}\n// ---- n8n glue ----\n${SECRET_GLUE}return { json: verifyHandshake($json.query, secret('META_VERIFY_TOKEN')) };\n`,
    ), pos(1, -1)),
    tokenOk: node('Token OK?', 'if', 2.2, ifTrue('tok', '={{ $json.ok }}'), pos(2, -1)),
    challenge: node('Respond with challenge', 'respondToWebhook', 1.1,
      { respondWith: 'text', responseBody: '={{ $json.challenge }}', options: { responseCode: 200 } }, pos(3, -1.5)),
    badToken: node('Respond 403 wrong token', 'respondToWebhook', 1.1,
      { respondWith: 'text', responseBody: 'Forbidden', options: { responseCode: 403 } }, pos(3, -0.5)),

    postHook: node('Meta lead event (POST)', 'webhook', 2, {
      httpMethod: 'POST',
      path: 'fb-lead-ads',
      responseMode: 'responseNode',
      options: { rawBody: true },
    }, pos(0, 1), { webhookId: 'fb-lead-ads-events' }),
    verify: node('Verify signature', 'code', 2, allItems(
      `${src('meta-leads.js')}\n// ---- n8n glue ----\n${SECRET_GLUE}const crypto = require('crypto');\nconst item = $input.first();\nlet raw = null;\ntry { raw = await this.helpers.getBinaryDataBuffer(0, 'data'); } catch (e) { raw = null; }\nconst headers = item.json.headers || {};\nconst check = verifySignature(raw, headers['x-hub-signature-256'], secret('META_APP_SECRET'), crypto);\nconst events = check.ok ? extractLeadgenEvents(item.json.body) : [];\nreturn [{ json: { valid: check.ok, error: check.error, events } }];\n`,
    ), pos(1, 1)),
    sigOk: node('Signature OK?', 'if', 2.2, ifTrue('sig', '={{ $json.valid }}'), pos(2, 1)),
    ack: node('Respond 200 to Meta', 'respondToWebhook', 1.1,
      respond(200, '={{ { "status": "received", "leads": $json.events.length } }}'), pos(3, 1)),
    badSig: node('Respond 403 bad signature', 'respondToWebhook', 1.1,
      respond(403, '={{ { "status": "rejected", "error": $json.error } }}'), pos(3, 2)),
    config: node('FB Config', 'set', 3.4, {
      assignments: {
        assignments: Object.entries(FB_CONFIG).map(([name, value], i) => ({ id: `fbcfg-${i}`, name, value, type: 'string' })),
      },
      includeOtherFields: false,
      options: {},
    }, pos(4, 1)),
    split: node('Split leadgen events', 'code', 2, allItems(
      `${src('meta-leads.js')}\n// ---- n8n glue ----\nconst cfg = $('FB Config').first().json;\nreturn $('Verify signature').first().json.events.map((e) => ({ json: { ...e, graphUrl: graphLeadUrl(e.leadgenId, cfg.graph_api_version, cfg.graph_base_url) } }));\n`,
    ), pos(5, 1)),
    dedupe: node('Dedupe by leadgen_id', 'removeDuplicates', 2, {
      operation: 'removeItemsSeenInPreviousExecutions',
      dedupeValue: '={{ $json.leadgenId }}',
      options: { historySize: 10000 },
    }, pos(6, 1)),
    graph: node('Graph: fetch lead', 'httpRequest', 4.2, {
      method: 'GET',
      url: '={{ $json.graphUrl }}',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'facebookGraphApi',
      options: { timeout: 30000 },
    }, pos(7, 1), crmSettings),
    map: node('Map to pipeline lead', 'code', 2, code(
      `${src('meta-leads.js')}\n// ---- n8n glue ----\nreturn { json: graphLeadToPipelineBody($json, $('Dedupe by leadgen_id').item.json) };\n`,
    ), pos(8, 1)),
    forward: node('Send to lead pipeline', 'httpRequest', 4.2, {
      method: 'POST',
      url: `={{ $('FB Config').first().json.pipeline_webhook_url }}`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json) }}',
      options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true } } },
    }, pos(9, 1), crmSettings),
    check: node('Check pipeline reply', 'code', 2, code(
      `// ---- n8n glue ----\nconst lead = $('Map to pipeline lead').item.json;\nconst status = $json.statusCode;\n// 202 = accepted and being rated, 200 = this email was already received.\nif (status !== 202 && status !== 200) {\n  throw new Error('Lead pipeline did not accept Facebook lead ' + lead.facebook_leadgen_id + ': HTTP ' + status + ' ' + JSON.stringify($json.body).slice(0, 300));\n}\nreturn { json: { facebook_leadgen_id: lead.facebook_leadgen_id, email: lead.email, pipeline_status: status, pipeline_reply: $json.body } };\n`,
    ), pos(10, 1)),
  };
  const c = {};
  const link = (from, to, outIndex = 0) => {
    c[from.name] = c[from.name] || { main: [] };
    while (c[from.name].main.length <= outIndex) c[from.name].main.push([]);
    c[from.name].main[outIndex].push({ node: to.name, type: 'main', index: 0 });
  };
  link(N.getHook, N.handshake);
  link(N.handshake, N.tokenOk);
  link(N.tokenOk, N.challenge, 0);
  link(N.tokenOk, N.badToken, 1);
  link(N.postHook, N.verify);
  link(N.verify, N.sigOk);
  link(N.sigOk, N.ack, 0);
  link(N.sigOk, N.badSig, 1);
  link(N.ack, N.config);
  link(N.config, N.split);
  link(N.split, N.dedupe);
  link(N.dedupe, N.graph);
  link(N.graph, N.map);
  link(N.map, N.forward);
  link(N.forward, N.check);
  return {
    name: 'AI Lead Pipeline: Facebook Lead Ads intake',
    nodes: Object.values(N),
    connections: c,
    settings: { executionOrder: 'v1', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner', errorWorkflow: '' },
    pinData: {},
    meta: { templateCredsSetupCompleted: false },
    tags: [],
  };
}

const outputs = {
  'workflows/ai-lead-pipeline.json': mainWorkflow(),
  'workflows/error-alert.json': errorWorkflow(),
  'workflows/facebook-lead-ads.json': facebookWorkflow(),
};

if (require.main === module) {
  const check = process.argv.includes('--check');
  let stale = false;
  for (const [rel, wf] of Object.entries(outputs)) {
    const file = path.join(ROOT, rel);
    const text = JSON.stringify(wf, null, 2) + '\n';
    if (check) {
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) {
        console.error(`stale: ${rel} (run node scripts/build-workflow.js)`);
        stale = true;
      }
    } else {
      fs.writeFileSync(file, text);
      console.log(`wrote ${rel} (${wf.nodes.length} nodes)`);
    }
  }
  process.exit(stale ? 1 : 0);
}

module.exports = { mainWorkflow, errorWorkflow, facebookWorkflow, CONFIG, FB_CONFIG };
