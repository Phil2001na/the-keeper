// Simulated Codex protocol peer. Performs no external action.
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const outcomes = [];
const tools = ['take_snapshot', 'submit_application', 'send_email', 'purchase', 'delete_file', 'change_security_settings', 'subscription', 'paid_booking', 'edu_production_action'];
let index = 0;
function request() {
  if (index === tools.length) {
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: JSON.stringify(outcomes) } } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    return;
  }
  send({ id: `approval-${index}`, method: 'mcpServer/elicitation/request', params: {
    serverName: 'chrome-devtools', message: `Allow to run tool "${tools[index]}"?`,
    _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: { target: tools[index] === 'edu_production_action' ? 'SIMULATED recipient EDU-BACKEND-1.0 production' : 'SIMULATED recipient', body: 'SIMULATED content', amount: tools[index] === 'purchase' || tools[index] === 'subscription' || tools[index] === 'paid_booking' ? 10 : undefined, currency: 'NAD' } },
  } });
}
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  else if (m.method === 'thread/start') {
    if (m.params.approvalPolicy !== 'untrusted' || m.params.sandbox !== 'danger-full-access') throw new Error('Missing command approval/sandbox protection');
    send({ id: m.id, result: { thread: { id: 'simulated-thread' } } });
  } else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'simulated-turn' } } });
    request();
  } else if (String(m.id).startsWith('approval-')) {
    outcomes.push({ tool: tools[index++], action: m.result?.action });
    request();
  }
});
