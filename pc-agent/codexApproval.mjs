import { approvalPolicy } from './approvalPolicy.mjs';

/** What his phone shows for a Codex request, and how to answer it either way. */
export function codexAsk(method, p, proj = {}) {
  const gate = approvalPolicy(method, p, { root: proj.path, strict: proj.strict });
  const s = (v, n = 600) => String(v ?? '').slice(0, n);
  const why = p.reason ? `\n(${s(p.reason, 300)})` : '';
  switch (method) {
    case 'item/commandExecution/requestApproval':
      {
      const command = p.command ?? (p.commandActions ?? []).map((a) => a.command).join(' && ');
      const policy = approvalPolicy('Bash', { command, message: p.reason }, { root: proj.path, strict: proj.strict });
      return { auto: policy.allow, tool: 'Bash', text: policy.summary, yes: { decision: 'accept' }, no: { decision: 'decline' } };
      }
    case 'item/fileChange/requestApproval':
      return { auto: gate.allow, tool: 'Edit', text: gate.summary || `Change files${p.grantRoot ? ` under ${s(p.grantRoot, 300)}` : ''}${why || ' outside its project folder'}`, yes: { decision: 'accept' }, no: { decision: 'decline' } };
    case 'item/permissions/requestApproval':
      return { auto: gate.allow, tool: 'Permissions', text: gate.summary || `Allow extra permissions for this entire turn?\n${s(JSON.stringify(p.permissions), 400)}${why}\nThis broadens the sandbox until the turn ends.`, yes: { permissions: p.permissions ?? {}, scope: 'turn' }, no: { permissions: {}, scope: 'turn' } };
    case 'mcpServer/elicitation/request': {
      const yes = { action: 'accept', content: {}, _meta: null };
      const no = { action: 'decline', content: null, _meta: null };
      const tool = String(p.message ?? '').match(/run tool "([^"]+)"/)?.[1] ?? '';
      const params = p._meta?.tool_params;
      const fullName = tool.startsWith('mcp__') ? tool : `mcp__${p.serverName}__${tool}`;
      const policy = approvalPolicy(fullName, params, { root: proj.path, strict: proj.strict });
      if (p._meta?.codex_approval_kind === 'mcp_tool_call' && tool && policy.allow) return { auto: true, yes };
      return { tool: `mcp ${s(p.serverName, 60)}`, text: policy.summary || `Approve ${s(p.serverName, 60)}?\n${s(p.message, 360)}\nUnrecognised request; this call only.`, yes, no };
    }
    case 'execCommandApproval':
      return { auto: approvalPolicy('Bash', { command: (p.command ?? []).join(' '), message: p.reason }, { root: proj.path, strict: proj.strict }).allow, tool: 'Bash', text: `Run a command:\n${s((p.command ?? []).join(' '))}${why}`, yes: { decision: 'approved' }, no: { decision: { denied: { rejection: 'Philip denied this from his phone.' } } } };
    case 'applyPatchApproval':
      return { auto: gate.allow, tool: 'Edit', text: gate.summary || `Change files: ${s(Object.keys(p.fileChanges ?? {}).join(', '), 400)}${why}`, yes: { decision: 'approved' }, no: { decision: { denied: { rejection: 'Philip denied this from his phone.' } } } };
    default:
      return null;
  }
}

