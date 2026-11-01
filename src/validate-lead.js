// Validate and normalise one inbound lead.
// Runs inside the n8n Code node "Validate and normalise" and in the unit tests.
// Pure function: no n8n globals, no network.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LIMITS = { name: 120, company: 160, message: 4000, budget: 60, source: 60, phone: 40 };

function clean(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function splitName(full) {
  const parts = full.split(' ').filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function validateLead(body, nowIso) {
  const errors = [];
  const raw = body && typeof body === 'object' ? body : {};

  // Honeypot: a hidden "website" field humans never fill in. Bots usually do.
  if (clean(raw.website, 200) !== '') {
    return { valid: false, errors: ['spam: honeypot field was filled'], lead: null };
  }

  const email = clean(raw.email, 254).toLowerCase();
  const name = clean(raw.name, LIMITS.name);
  const message = clean(raw.message, LIMITS.message);

  if (!email) errors.push('email is required');
  else if (!EMAIL_RE.test(email)) errors.push('email is not a valid address');
  if (!name) errors.push('name is required');
  if (!message) errors.push('message is required');
  else if (message.length < 10) errors.push('message is too short to assess (min 10 characters)');

  if (errors.length) return { valid: false, errors, lead: null };

  const { firstName, lastName } = splitName(name);
  const lead = {
    email,
    name,
    firstName,
    lastName,
    company: clean(raw.company, LIMITS.company),
    phone: clean(raw.phone, LIMITS.phone),
    budget: clean(raw.budget, LIMITS.budget),
    source: clean(raw.source, LIMITS.source) || 'webhook',
    message,
    receivedAt: nowIso || new Date().toISOString(),
  };
  return { valid: true, errors: [], lead };
}

if (typeof module !== 'undefined') module.exports = { validateLead, EMAIL_RE };
