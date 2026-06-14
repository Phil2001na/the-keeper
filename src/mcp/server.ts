import './env.js'; // must be first — loads the project's .env before config reads it
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  domains,
  facts,
  goals,
  observations,
  interactions,
  journal,
  digests,
} from '../db/repositories.js';

/**
 * THE KEEPER as an MCP server — Jarvis's memory and life-tracking, exposed as
 * tools so a chat client (Claude Desktop, claude.ai, the mobile app) can BE the
 * brain while reading and writing the SAME `keeper_*` tables the Telegram agent
 * uses. One shared memory across every surface: log a number here, the Sunday
 * Telegram review sees it; remember a fact in Telegram, it's here too.
 *
 * A cheap stopgap when the Anthropic API credits run dry: reactive chatting
 * moves onto a flat claude.ai subscription, while the lean Railway worker keeps
 * doing the one thing MCP can't — reaching out first (rituals, reflection).
 *
 * Transport is stdio (Claude Desktop spawns this process). NOTHING may write to
 * stdout except the protocol — all diagnostics go to stderr (console.error).
 */

const server = new McpServer({ name: 'the-keeper', version: '1.0.0' });

/** MCP text result. */
function out(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}
function dump(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return out(JSON.stringify(value, null, 2));
}

/** slug → domain id (null for general / unknown). */
async function domainIdForSlug(slug?: string): Promise<string | null> {
  if (!slug || slug === 'general') return null;
  const d = await domains.getBySlug(slug);
  return d?.id ?? null;
}

// ─── Reading the mind ──────────────────────────────────────────────────────

server.tool('list_domains', 'List the life-sectors Jarvis tracks (work, health, …) with their descriptions.', {}, async () => {
  return dump((await domains.list()).map((d) => ({ slug: d.slug, name: d.name, description: d.description, priority: d.priority })));
});

server.tool(
  'recall_facts',
  'Recall stored facts about Philip. Optionally scope to one sector by slug; omit for everything.',
  { domain_slug: z.string().optional().describe('sector slug, e.g. "work"; omit for all facts') },
  async ({ domain_slug }) => {
    const list = domain_slug
      ? await facts.byDomain((await domainIdForSlug(domain_slug)) ?? '00000000-0000-0000-0000-000000000000')
      : await facts.all();
    const slugById = new Map((await domains.list(true)).map((d) => [d.id, d.slug]));
    return dump(list.map((f) => ({ sector: f.domain_id ? slugById.get(f.domain_id) ?? '?' : 'general', key: f.key, value: f.value, confidence: f.confidence })));
  }
);

server.tool(
  'recent_conversation',
  "Read the most recent messages from Philip's running conversation with Jarvis (across Telegram + web). Use this for continuity — what was just discussed.",
  { limit: z.number().int().min(1).max(100).optional().describe('how many recent messages (default 30)') },
  async ({ limit }) => {
    const rows = await interactions.recent(limit ?? 30);
    return dump(rows.map((r) => ({ who: r.role === 'user' ? 'Philip' : 'Jarvis', when: r.created_at, text: r.content })));
  }
);

server.tool(
  'search_history',
  'Full-text search the ENTIRE conversation archive (long-term episodic memory). Supports quoted phrases and -exclusions. Use before saying "I don\'t remember".',
  { query: z.string().describe('search terms, e.g. "ortho payment" or "legal case -draft"'), limit: z.number().int().min(1).max(40).optional() },
  async ({ query, limit }) => {
    const rows = await interactions.search(query, limit ?? 12);
    return dump(rows.map((r) => ({ who: r.role === 'user' ? 'Philip' : 'Jarvis', when: r.created_at, text: r.content })));
  }
);

server.tool('read_digest', "Read the rolling digest — Jarvis's distilled working memory of recent conversation that has scrolled out of raw view.", {}, async () => {
  const d = await digests.get('rolling');
  return out(d?.content ? `${d.content}\n\n(covers up to ${d.covered_until})` : '(no digest yet)');
});

server.tool('read_journal', "Read Jarvis's recent private nightly journal entries — his day-by-day continuity of self.", { limit: z.number().int().min(1).max(14).optional() }, async ({ limit }) => {
  return dump((await journal.recent(limit ?? 3)).map((j) => ({ day: j.day, entry: j.entry })));
});

server.tool('list_goals', "List Philip's goals with their metric, target, deadline and why.", { include_done: z.boolean().optional() }, async ({ include_done }) => {
  return dump((await goals.list(!include_done)).map((g) => ({ id: g.id.slice(0, 8), title: g.title, metric: g.metric, target: g.target_value, unit: g.unit, deadline: g.deadline, status: g.status, why: g.why })));
});

// ─── Writing to the mind ───────────────────────────────────────────────────

server.tool(
  'remember_fact',
  'Store or update a durable fact about Philip. Upserts on (sector, key) — newest value wins. This is shared memory: the Telegram agent will see it.',
  {
    domain_slug: z.string().optional().describe('sector slug; omit for general'),
    key: z.string().describe('short stable label, e.g. "current_focus"'),
    value: z.string().describe('the fact'),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
  },
  async ({ domain_slug, key, value, confidence }) => {
    const f = await facts.upsert({ domain_id: await domainIdForSlug(domain_slug), key, value, confidence });
    return out(`Remembered: ${key} = ${f.value}`);
  }
);

server.tool(
  'log_observation',
  'Log a life metric to the append-only time-series (money, weight, sleep, mood, spend.*, …). Use dot-namespaced metric names. Shared with the Telegram agent.',
  {
    metric: z.string().describe('e.g. "balance.main", "spend.food", "body.weight_kg", "mood"'),
    value: z.number().optional().describe('numeric value (preferred for anything quantitative)'),
    text_value: z.string().optional().describe('use only for non-numeric observations'),
    unit: z.string().optional().describe('e.g. "NAD", "kg", "hrs"'),
    note: z.string().optional(),
    observed_at: z.string().optional().describe('ISO timestamp; omit for now. Use the REAL date for back-dated statement lines.'),
    domain_slug: z.string().optional(),
  },
  async ({ metric, value, text_value, unit, note, observed_at, domain_slug }) => {
    const o = await observations.log({ metric, value, text_value, unit, note, observed_at, domain_id: await domainIdForSlug(domain_slug), source: 'mcp' });
    return out(`Logged ${o.metric} = ${o.value ?? o.text_value}${o.unit ? ' ' + o.unit : ''} @ ${o.observed_at}`);
  }
);

server.tool(
  'query_observations',
  'Read tracked metrics. mode "latest" = newest of every metric; "series" = all points for one metric (a trailing "." makes it a prefix, e.g. "spend."); "monthly" = per-month totals for a metric/prefix.',
  {
    mode: z.enum(['latest', 'series', 'monthly']),
    metric: z.string().optional().describe('required for series/monthly; trailing "." = prefix aggregate'),
    since_iso: z.string().optional().describe('only points on/after this ISO instant'),
  },
  async ({ mode, metric, since_iso }) => {
    if (mode === 'latest') {
      const rows = (await observations.latestPerMetric()).filter((o) => !o.metric.startsWith('sys.'));
      return dump(rows.map((o) => ({ metric: o.metric, value: o.value ?? o.text_value, unit: o.unit, at: o.observed_at })));
    }
    if (!metric) return out('Error: "metric" is required for series/monthly.');
    const rows = await observations.series(metric, since_iso);
    if (mode === 'series') {
      return dump(rows.map((o) => ({ metric: o.metric, value: o.value ?? o.text_value, unit: o.unit, at: o.observed_at, note: o.note })));
    }
    // monthly: sum numeric values per calendar month (UTC).
    const byMonth = new Map<string, number>();
    for (const o of rows) {
      if (o.value == null) continue;
      const m = o.observed_at.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + Number(o.value));
    }
    return dump([...byMonth.entries()].sort().map(([month, total]) => ({ month, total: Math.round(total * 100) / 100 })));
  }
);

server.tool(
  'set_goal',
  "Create a goal with its metric, target, deadline and — importantly — the WHY behind it.",
  {
    title: z.string(),
    metric: z.string().optional().describe('the metric that measures progress, e.g. "balance.main"'),
    target_value: z.number().optional(),
    unit: z.string().optional(),
    deadline: z.string().optional().describe('YYYY-MM-DD'),
    why: z.string().optional(),
    domain_slug: z.string().optional(),
  },
  async ({ title, metric, target_value, unit, deadline, why, domain_slug }) => {
    const g = await goals.create({ title, metric, target_value, unit, deadline, why, domain_id: await domainIdForSlug(domain_slug) });
    return out(`Goal set (${g.id.slice(0, 8)}): ${g.title}`);
  }
);

server.tool(
  'update_goal',
  'Update a goal by id (full or unambiguous prefix from list_goals). Set status to "done"/"dropped" to close it.',
  {
    id_prefix: z.string(),
    title: z.string().optional(),
    metric: z.string().optional(),
    target_value: z.number().optional(),
    unit: z.string().optional(),
    deadline: z.string().optional(),
    status: z.string().optional(),
    why: z.string().optional(),
  },
  async ({ id_prefix, ...patch }) => {
    const g = await goals.byIdPrefix(id_prefix);
    if (!g) return out(`No single goal matches id prefix "${id_prefix}".`);
    const updated = await goals.update(g.id, patch);
    return out(`Updated: ${updated?.title} → status ${updated?.status}`);
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[keeper-mcp] connected over stdio — Jarvis memory is live.');
}

main().catch((err) => {
  console.error('[keeper-mcp] fatal:', err);
  process.exit(1);
});
