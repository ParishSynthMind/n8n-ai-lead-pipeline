// Text for the Slack alert, the welcome email, the Sheet row and the error alert.
// Runs inside n8n Code nodes and in the unit tests. Pure functions.

function sheetRow(lead, result) {
  return {
    received_at: lead.receivedAt,
    email: lead.email,
    name: lead.name,
    company: lead.company,
    budget: lead.budget,
    source: lead.source,
    rating: result.rating,
    reason: result.reason,
    next_step: result.nextStep,
    needs_review: result.needsReview ? 'yes' : 'no',
    ai_attempts: result.attempts,
    message: lead.message,
  };
}

function slackText(lead, result) {
  const who = lead.company ? `${lead.name} (${lead.company})` : lead.name;
  return [
    `:fire: *Hot lead:* ${who}`,
    `*Email:* ${lead.email}${lead.budget ? `   *Budget:* ${lead.budget}` : ''}`,
    `*Why hot:* ${result.reason}`,
    `*Next step:* ${result.nextStep}`,
    `> ${lead.message.slice(0, 300)}${lead.message.length > 300 ? '...' : ''}`,
  ].join('\n');
}

function welcomeEmail(lead, businessName) {
  const first = lead.firstName || 'there';
  return {
    subject: `Thanks for getting in touch with ${businessName}`,
    body: [
      `Hi ${first},`,
      '',
      `Thanks for your message. It has reached the team at ${businessName} and someone will reply within one working day.`,
      '',
      'If anything is urgent, just reply to this email and add a line about the deadline.',
      '',
      'Best regards,',
      businessName,
    ].join('\n'),
  };
}

function errorAlert(err) {
  const ex = (err && err.execution) || {};
  const wf = (err && err.workflow) || {};
  const e = ex.error || {};
  const node = (e.node && e.node.name) || ex.lastNodeExecuted || 'unknown node';
  return {
    subject: `n8n failure: ${wf.name || 'workflow'} at "${node}"`,
    body: [
      `Workflow: ${wf.name || '(unknown)'}`,
      `Failed node: ${node}`,
      `Error: ${e.message || '(no message)'}`,
      `Execution: ${ex.url || ex.id || '(no link)'}`,
      `Mode: ${ex.mode || '(unknown)'}`,
      '',
      'Open the execution link to see the input that failed, fix the cause, then retry the execution from n8n.',
    ].join('\n'),
  };
}

if (typeof module !== 'undefined') module.exports = { sheetRow, slackText, welcomeEmail, errorAlert };
