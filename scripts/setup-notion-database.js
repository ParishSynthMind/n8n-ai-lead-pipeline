#!/usr/bin/env node
// One-off: create the "Leads" database (columns from src/notion-lead.js) under
// a Notion page the integration can reach. Prints the database ID to paste
// into the Config node.
//   NOTION_TOKEN=... NOTION_PARENT_PAGE_ID=... node scripts/setup-notion-database.js
const { NOTION_API, NOTION_VERSION, NOTION_SCHEMA } = require('../src/notion-lead.js');

(async () => {
  for (const k of ['NOTION_TOKEN', 'NOTION_PARENT_PAGE_ID']) if (!process.env[k]) throw new Error(`${k} is not set`);
  const res = await fetch(`${NOTION_API}/databases`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      parent: { type: 'page_id', page_id: process.env.NOTION_PARENT_PAGE_ID },
      title: [{ type: 'text', text: { content: process.env.NOTION_DATABASE_TITLE || 'Leads' } }],
      properties: NOTION_SCHEMA,
    }),
  });
  const j = await res.json();
  if (j.object !== 'database') throw new Error(`Notion said ${res.status}: ${j.code || ''} ${j.message || ''}`);
  console.log(`created database "${j.title[0].plain_text}" with ${Object.keys(j.properties).length} columns`);
  console.log(`notion_database_id: ${j.id}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
