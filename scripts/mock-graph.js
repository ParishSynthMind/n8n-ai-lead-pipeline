#!/usr/bin/env node
// Local stand-in for graph.facebook.com, for testing the Facebook workflow
// without a Page access token: GET /<version>/<leadgen_id> returns
// samples/facebook/graph-lead-<leadgen_id>.json, and checks that the
// access_token query parameter was sent (as the facebookGraphApi credential does).
//   node scripts/mock-graph.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 5690);
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const m = u.pathname.match(/^\/v\d+\.\d+\/(\d+)$/);
  const file = m && path.join(__dirname, '..', 'samples', 'facebook', `graph-lead-${m[1]}.json`);
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (!u.searchParams.get('access_token')) return send(400, { error: { message: 'An access token is required', code: 104 } });
  if (!file || !fs.existsSync(file)) return send(404, { error: { message: 'Unsupported get request', code: 100 } });
  const lead = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`GET ${u.pathname} fields=${u.searchParams.get('fields')} -> 200`);
  send(200, lead);
}).listen(port, () => console.log(`mock Graph API on http://localhost:${port}`));
