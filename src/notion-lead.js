// Notion destination: one database row per lead, keyed on email so a repeat
// lead updates its row instead of adding a second one.
// Runs inside the n8n Code nodes around the Notion HTTP nodes and in the unit
// tests. Pure functions: no n8n globals, no network.

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const TEXT_MAX = 2000; // Notion's limit per rich text object

// Database columns, created once by scripts/setup-notion-database.js.
const NOTION_SCHEMA = {
  Name: { title: {} },
  Email: { email: {} },
  Company: { rich_text: {} },
  Phone: { phone_number: {} },
  Rating: { select: { options: [{ name: 'Hot', color: 'red' }, { name: 'Warm', color: 'yellow' }, { name: 'Cold', color: 'blue' }] } },
  Summary: { rich_text: {} },
  'Next step': { rich_text: {} },
  'Needs review': { checkbox: {} },
  Source: { select: {} },
  Budget: { rich_text: {} },
  Received: { date: {} },
  Message: { rich_text: {} },
};

const text = (s) => [{ type: 'text', text: { content: String(s || '').slice(0, TEXT_MAX) } }];

function notionProperties(lead, result) {
  return {
    Name: { title: text(lead.name || lead.email) },
    Email: { email: lead.email },
    Company: { rich_text: text(lead.company) },
    Phone: { phone_number: lead.phone || null },
    Rating: { select: { name: result.rating } },
    Summary: { rich_text: text(result.reason) },
    'Next step': { rich_text: text(result.nextStep) },
    'Needs review': { checkbox: Boolean(result.needsReview) },
    Source: { select: { name: String(lead.source || 'webhook').replace(/,/g, ' ').slice(0, 100) } },
    Budget: { rich_text: text(lead.budget) },
    Received: { date: { start: lead.receivedAt } },
    Message: { rich_text: text(lead.message) },
  };
}

function buildNotionQuery(email) {
  return { filter: { property: 'Email', email: { equals: email } }, page_size: 1 };
}

// After the query: update the row that already has this email, or create one.
function buildNotionWrite(databaseId, queryResponse, lead, result) {
  const found = queryResponse && Array.isArray(queryResponse.results) ? queryResponse.results.find((p) => p && p.id && !p.archived) : null;
  const properties = notionProperties(lead, result);
  if (found) {
    return { action: 'update', method: 'PATCH', url: `${NOTION_API}/pages/${found.id}`, body: { properties } };
  }
  return { action: 'create', method: 'POST', url: `${NOTION_API}/pages`, body: { parent: { database_id: databaseId }, properties } };
}

function parseNotionWrite(response) {
  const r = response && typeof response === 'object' ? response : {};
  if (r.object === 'page' && r.id) return { ok: true, id: r.id, url: r.url || '', error: null };
  const msg = r.message || (r.error && (r.error.message || r.error)) || 'unexpected Notion response';
  return { ok: false, id: null, url: '', error: `${r.code ? r.code + ': ' : ''}${typeof msg === 'string' ? msg : JSON.stringify(msg)}`.slice(0, 300) };
}

if (typeof module !== 'undefined') {
  module.exports = { NOTION_API, NOTION_VERSION, NOTION_SCHEMA, notionProperties, buildNotionQuery, buildNotionWrite, parseNotionWrite };
}
