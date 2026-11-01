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
      `${src('rate-lead.js')}\n${src('messages.js')}\n// ---- n8n glue ----\nconst result = finalRating($json.parsed, $json.attempts);\nconst lead = $json.lead;\nconst businessName = $('Config').first().json.business_name;\nreturn { json: { lead, result, sheet_row: sheetRow(lead, result), slack_text: slackText(lead, result), welcome: welcomeEmail(lead, businessName) } };\n`,
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

const outputs = {
  'workflows/ai-lead-pipeline.json': mainWorkflow(),
  'workflows/error-alert.json': errorWorkflow(),
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

module.exports = { mainWorkflow, errorWorkflow, CONFIG };
