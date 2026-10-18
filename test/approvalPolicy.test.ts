import { test } from 'node:test';
import assert from 'node:assert/strict';
const { approvalPolicy: policy, claudeApprovalHook } = await import('../pc-agent/approvalPolicy.mjs');
const { codexAsk } = await import('../pc-agent/codexApproval.mjs');
test('all non-spending operations bypass, including unknown tools and protected paths', () => {
  for (const tool of ['send_email','submit_application','delete_file','change_security_settings','deploy','unknown','Write']) {
    assert.equal(policy(tool, { file_path: '../AGENTS.md' }, { strict: false }).allow, true, tool);
  }
  assert.equal(policy('Bash', { command: 'npm run deploy' }).allow, true);
});
test('spending categories and generic execution require approval', () => {
  for (const tool of ['purchase','payment','subscription','paid_booking','transfer_money','donate','paid_upgrade','create_order']) assert.equal(policy(tool).allow, false, tool);
  for (const input of [{ command: 'curl https://shop/checkout' }, { code: 'await page.click("Buy")' }, { action: 'pay' }]) assert.equal(policy('generic', input).allow, false);
  const d = policy('purchase', { target: 'Kit', amount: 300, currency: 'NAD', api_key: 'secret-value' });
  assert.match(d.summary, /Kit.*300 NAD/); assert.ok(!d.summary.includes('secret-value'));
  assert.match(d.summary, /This call only/);
});
test('Claude hook asks for money and allows other operations', () => {
  assert.equal(claudeApprovalHook(policy,'purchase',{}).hookSpecificOutput.permissionDecision,'ask');
  assert.equal(claudeApprovalHook(policy,'send_email',{}).hookSpecificOutput.permissionDecision,'allow');
});
test('Codex adapters bypass non-spending and preserve per-call monetary decisions', () => {
  const proj = { path: '.', strict: false };
  for (const method of ['item/fileChange/requestApproval','item/permissions/requestApproval','applyPatchApproval']) assert.equal(codexAsk(method,{},proj).auto,true);
  assert.equal(codexAsk('item/commandExecution/requestApproval',{ command:'npm run deploy' },proj).auto,true);
  assert.equal(codexAsk('item/commandExecution/requestApproval',{ command:'curl /checkout' },proj).auto,false);
  for (const tool of ['send_email','purchase']) {
    const d=codexAsk('mcpServer/elicitation/request',{serverName:'test',message:`run tool "${tool}"`,_meta:{codex_approval_kind:'mcp_tool_call',tool_params:{}}},proj);
    assert.equal(Boolean(d.auto),tool==='send_email');
    if(tool==='purchase') {assert.equal(d.yes.action,'accept');assert.equal(d.no.action,'decline');}
  }
  assert.equal(codexAsk('unsupported',{},proj),null);
});


test('strict EDU exception overrides bypass in both engines and every Codex approval adapter', () => {
  const proj = { path: 'C:/projects/EDU-FRONTEND', strict: true };
  for (const tool of ['Read', 'Write', 'Bash', 'unknown', 'purchase']) {
    assert.equal(policy(tool, {}, { root: proj.path, strict: true }).allow, false);
    assert.equal(claudeApprovalHook(policy, tool, {}, { strict: true }).hookSpecificOutput.permissionDecision, 'ask');
  }
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval']) {
    assert.equal(codexAsk(method, { command: [] }, proj).auto, false, method);
  }
  const mcp = codexAsk('mcpServer/elicitation/request', { serverName: 'test', message: 'run tool "read"',
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: {} } }, proj);
  assert.ok(!mcp.auto);
  assert.equal(mcp.no.action, 'decline');
});

test('EDU targeting from non-strict sessions still asks, including patches and legacy commands', () => {
  for (const input of [{ command: 'ssh EDU-BACKEND-1.0 pm2 restart app' },
    { file_path: 'C:/EDU-FRONTEND/app.ts' }, { target: 'Welwitch production' }]) {
    assert.equal(policy('generic', input).allow, false);
  }
  assert.equal(codexAsk('applyPatchApproval', { fileChanges: { 'C:/EDU-FRONTEND/app.ts': {} } }).auto, false);
  assert.equal(codexAsk('execCommandApproval', { command: ['ssh', 'EDU-BACKEND-1.0', 'pm2', 'restart'] }).auto, false);
  assert.equal(codexAsk('item/fileChange/requestApproval', { grantRoot: 'C:/EDU-FRONTEND' }).auto, false);
  assert.equal(codexAsk('mcpServer/elicitation/request', { serverName: 'unknown', message: 'opaque request' }).auto, undefined);
});
