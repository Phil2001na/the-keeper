/**
 * Generates the runtime capability matrix by reading the source, not by
 * importing it — so it runs with no credentials and no side effects.
 *
 *   npx tsx scripts/capability_matrix.ts            # print
 *   npx tsx scripts/capability_matrix.ts --check    # exit 1 if any gap
 *
 * It answers the question that produced the decision-queue bug: for every
 * capability, is it defined as a tool, does dispatchTool actually handle it,
 * does the system prompt tell the agent it exists, and does anything in the
 * schedule refer to it? A tool the scheduler names but dispatch cannot serve is
 * exactly the failure that shipped on 24 Aug.
 */
import { readFileSync } from 'node:fs';

const tools = readFileSync('src/agent/tools.ts', 'utf8');
const prompt = readFileSync('src/agent/systemPrompt.ts', 'utf8');
const reflect = readFileSync('src/agent/reflect.ts', 'utf8');

/** Names in the tool definition array (plus the web-only present tool). */
const defined = new Set<string>();
for (const m of tools.matchAll(/^\s{2,4}name: '([a-z_]+)',$/gm)) defined.add(m[1]);
for (const m of tools.matchAll(/^\s{2}name: '([a-z_]+)',$/gm)) defined.add(m[1]);

/** Names dispatchTool actually handles. */
const dispatched = new Set<string>();
for (const m of tools.matchAll(/case '([a-z_]+)': \{/g)) dispatched.add(m[1]);

const GROUPS: Record<string, string[]> = {
  'memory / facts': ['recall_facts', 'remember_fact', 'forget_fact'],
  'sectors': ['list_domains', 'create_domain', 'update_domain'],
  'observations': ['log_observation', 'query_observations'],
  'bank statements': ['log_statement'],
  'goals': ['set_goal', 'update_goal'],
  'threads': ['watch_thread', 'update_thread'],
  'journal / portrait': ['write_journal', 'update_portrait'],
  'state capture': ['capture_state', 'query_state_captures'],
  'skills registry': ['list_skills'],
  'decision queue': [
    'list_decision_sets', 'get_decision_set', 'record_decision',
    'update_decision', 'export_decision_brief', 'close_decision_set',
    'link_decision_artifact',
  ],
  'email': ['list_emails', 'read_email', 'draft_email', 'send_email'],
  'drive': ['list_drive_files', 'read_drive_file', 'create_drive_file', 'update_drive_file'],
  'websites / deploy': ['deploy_html', 'list_sites', 'check_site_status', 'rename_site', 'delete_site'],
  'web': ['fetch_url', 'web_search'],
  'route planning': ['plan_errand_route'],
  'generation': ['generate_image', 'generate_pdf'],
  'scheduling': ['schedule_touchpoint', 'cancel_touchpoint', 'stay_silent'],
  'archive search': ['search_history'],
  'web UI card': ['present'],
};

interface Row {
  group: string;
  tool: string;
  defined: boolean;
  dispatched: boolean;
  inPrompt: boolean;
  gap: string;
}

const rows: Row[] = [];
for (const [group, names] of Object.entries(GROUPS)) {
  for (const tool of names) {
    const isDefined = defined.has(tool);
    // web_search is Anthropic's server-side tool: defined, never dispatched.
    const isDispatched = dispatched.has(tool) || tool === 'web_search';
    const inPrompt = prompt.includes(tool) || reflect.includes(tool);
    let gap = '';
    if (!isDefined) gap = 'MISSING TOOL REGISTRATION';
    else if (!isDispatched) gap = 'DEFINED BUT NOT DISPATCHED';
    else if (!inPrompt) gap = 'no prompt coverage';
    rows.push({ group, tool, defined: isDefined, dispatched: isDispatched, inPrompt, gap });
  }
}

/** Tools that exist in code but no group claims — the matrix must stay honest. */
const claimed = new Set(Object.values(GROUPS).flat());
const unclaimed = [...defined].filter((t) => !claimed.has(t));

const y = (b: boolean): string => (b ? 'yes' : 'NO');
const lines: string[] = [];
lines.push('| capability | tool | defined | dispatched | in prompt | gap |');
lines.push('|---|---|:--:|:--:|:--:|---|');
let lastGroup = '';
for (const r of rows) {
  lines.push(
    `| ${r.group === lastGroup ? '' : r.group} | \`${r.tool}\` | ${y(r.defined)} | ${y(r.dispatched)} | ${y(r.inPrompt)} | ${r.gap || '—'} |`
  );
  lastGroup = r.group;
}
console.log(lines.join('\n'));

const hard = rows.filter((r) => r.gap.startsWith('MISSING') || r.gap.startsWith('DEFINED'));
const soft = rows.filter((r) => r.gap === 'no prompt coverage');
console.log(`\n${rows.length} capabilities · ${hard.length} runtime gaps · ${soft.length} prompt-coverage gaps`);
if (unclaimed.length > 0) console.log(`unclaimed tools not in the matrix: ${unclaimed.join(', ')}`);
if (soft.length > 0) console.log(`no prompt coverage: ${soft.map((r) => r.tool).join(', ')}`);

if (process.argv.includes('--check') && hard.length > 0) {
  console.error(`\nFAIL: ${hard.map((r) => `${r.tool} (${r.gap})`).join(', ')}`);
  process.exit(1);
}
