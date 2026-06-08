import type Anthropic from '@anthropic-ai/sdk';
import { domains, facts, touchpoints } from '../db/repositories.js';

/**
 * The tools the orchestrator can call. The database is the agent's hands:
 * everything it knows and everything it plans lives in these calls.
 */
export const toolDefinitions: Anthropic.Tool[] = [
  {
    name: 'list_domains',
    description:
      'List all the life-sectors you currently track (slug, name, description, cadence). ' +
      'Call this when you need to know whether something the user mentioned fits an existing sector.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'recall_facts',
    description:
      'Read what you know about the user. Omit domain_slug to read everything, or pass a slug to focus on one sector.',
    input_schema: {
      type: 'object',
      properties: {
        domain_slug: { type: 'string', description: 'Optional sector slug to filter by.' },
      },
    },
  },
  {
    name: 'remember_fact',
    description:
      'Store or update something true about the user. Upserts on (domain, key): reuse an existing key to update it. ' +
      'Use concise, stable keys like "current_focus" or "side_business_name".',
    input_schema: {
      type: 'object',
      properties: {
        domain_slug: { type: 'string', description: 'Sector this fact belongs to.' },
        key: { type: 'string', description: 'Short stable identifier for the fact.' },
        value: { type: 'string', description: 'The fact itself.' },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['domain_slug', 'key', 'value'],
    },
  },
  {
    name: 'create_domain',
    description:
      'Start tracking a brand-new sector of the user\'s life (a business, an interest, a relationship, anything). ' +
      'IMPORTANT: only call this AFTER the user has agreed they want you to track it. Ask first in conversation.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'lowercase_snake_case unique id, e.g. "sneaker_business".' },
        name: { type: 'string', description: 'Human-readable name, e.g. "Sneaker Resale Business".' },
        description: { type: 'string', description: 'What this sector covers and how you should treat it.' },
        cadence_hint: { type: 'string', description: 'Your note on how often to check in on this.' },
        priority: { type: 'number', description: '1 (high) to 5 (low). Default 3.' },
      },
      required: ['slug', 'name', 'description'],
    },
  },
  {
    name: 'schedule_touchpoint',
    description:
      'Schedule your OWN next proactive reach-out — how you stay alive between conversations. ' +
      'Use sparingly: only when nothing suitable is already pending, or when new information means the timing/topic must change. ' +
      'Do NOT add one after every message; aim to keep at most one sensible next touchpoint pending. Cancel-and-replace rather than stacking duplicates.',
    input_schema: {
      type: 'object',
      properties: {
        fire_at_iso: {
          type: 'string',
          description: 'When to reach out, as an ISO 8601 timestamp (UTC, e.g. 2026-06-08T06:30:00Z).',
        },
        domain_slug: { type: 'string', description: 'Optional sector this check-in relates to.' },
        reason: { type: 'string', description: 'Why you are reaching out / what you want to raise.' },
      },
      required: ['fire_at_iso', 'reason'],
    },
  },
  {
    name: 'cancel_touchpoint',
    description: 'Cancel a planned check-in by its id (e.g. it is no longer relevant).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'stay_silent',
    description:
      'End your turn WITHOUT sending the user a message. Use this when a due touchpoint turns out not to be worth ' +
      'interrupting them for — silence builds trust. You should usually still schedule a future touchpoint before going quiet.',
    input_schema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'Private note on why you stayed silent.' } },
    },
  },
];

export interface ToolResult {
  output: string;
  /** Set by stay_silent so the orchestrator knows not to send anything. */
  silent?: boolean;
}

async function resolveDomainId(slug: string | undefined): Promise<string | null> {
  if (!slug) return null;
  const d = await domains.getBySlug(slug);
  return d?.id ?? null;
}

/** Execute one tool call and return a string result for the model. */
export async function dispatchTool(
  name: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  switch (name) {
    case 'list_domains': {
      const list = await domains.list();
      if (list.length === 0) return { output: 'No domains yet.' };
      return {
        output: list
          .map(
            (d) =>
              `- ${d.slug} (${d.name}) [p${d.priority}] — ${d.description ?? 'no description'}` +
              (d.cadence_hint ? ` | cadence: ${d.cadence_hint}` : '')
          )
          .join('\n'),
      };
    }

    case 'recall_facts': {
      const slug = input.domain_slug as string | undefined;
      let rows;
      if (slug) {
        const d = await domains.getBySlug(slug);
        if (!d) return { output: `No domain with slug "${slug}".` };
        rows = await facts.byDomain(d.id);
      } else {
        rows = await facts.all();
      }
      if (rows.length === 0) return { output: 'No facts stored yet.' };
      // map domain ids back to slugs for readability
      const allDomains = await domains.list(true);
      const slugById = new Map(allDomains.map((d) => [d.id, d.slug]));
      return {
        output: rows
          .map(
            (f) =>
              `[${f.domain_id ? slugById.get(f.domain_id) ?? '?' : 'general'}] ${f.key}: ${f.value} (${f.confidence})`
          )
          .join('\n'),
      };
    }

    case 'remember_fact': {
      const domainId = await resolveDomainId(input.domain_slug as string);
      if (input.domain_slug && !domainId) {
        return {
          output: `No domain "${input.domain_slug}". Create it first (after asking the user) or use an existing one.`,
        };
      }
      const f = await facts.upsert({
        domain_id: domainId,
        key: input.key as string,
        value: input.value as string,
        confidence: (input.confidence as string) ?? 'medium',
      });
      return { output: `Remembered: ${f.key} = ${f.value}` };
    }

    case 'create_domain': {
      const existing = await domains.getBySlug(input.slug as string);
      if (existing) return { output: `Domain "${input.slug}" already exists.` };
      const d = await domains.create({
        slug: input.slug as string,
        name: input.name as string,
        description: input.description as string,
        cadence_hint: input.cadence_hint as string | undefined,
        priority: input.priority as number | undefined,
        created_by: 'agent',
      });
      return { output: `Created new sector "${d.slug}" (${d.name}). You can now store facts and touchpoints against it.` };
    }

    case 'schedule_touchpoint': {
      const domainId = await resolveDomainId(input.domain_slug as string);
      const fireAt = input.fire_at_iso as string;
      const parsed = new Date(fireAt);
      if (Number.isNaN(parsed.getTime())) {
        return { output: `Invalid fire_at_iso "${fireAt}". Use ISO 8601, e.g. 2026-06-08T06:30:00Z.` };
      }
      const tp = await touchpoints.create({
        fire_at: parsed.toISOString(),
        domain_id: domainId,
        reason: input.reason as string,
      });
      return { output: `Scheduled touchpoint ${tp.id} for ${tp.fire_at}: ${tp.reason}` };
    }

    case 'cancel_touchpoint': {
      await touchpoints.setStatus(input.id as string, 'cancelled');
      return { output: `Cancelled touchpoint ${input.id}.` };
    }

    case 'stay_silent': {
      return { output: 'Staying silent.', silent: true };
    }

    default:
      return { output: `Unknown tool: ${name}` };
  }
}
