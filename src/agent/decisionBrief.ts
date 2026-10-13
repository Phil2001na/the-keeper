import type { Decision, DecisionSet } from '../db/repositories.js';

/**
 * Renders an answered decision set as an implementation brief.
 *
 * The audience is a coding agent working the repo alone, days later, with
 * Philip unreachable — so the brief has to be unambiguous about what was
 * decided AND about what was deliberately not. Anything still open or routed
 * to the client/lawyer is listed as a hard stop, not as latitude to invent a
 * rule.
 */

const STATUS_LABEL: Record<string, string> = {
  answered: 'Decided',
  deferred: 'Deferred',
  needs_client: 'Client decision — DO NOT IMPLEMENT',
  needs_legal: 'Legal decision — DO NOT IMPLEMENT',
  open: 'Unanswered — DO NOT IMPLEMENT',
};

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function renderBriefMarkdown(set: DecisionSet, rows: Decision[], nowIso: string): string {
  const decided = rows.filter((r) => r.status === 'answered');
  const blocked = rows.filter((r) => r.status !== 'answered');

  const out: string[] = [];
  out.push(`# ${set.title} — decisions`);
  out.push('');
  out.push(`**Project:** ${set.project}  `);
  if (set.source_ref) out.push(`**Questions from:** ${set.source_ref}  `);
  out.push(`**Decided by:** Philip, in conversation with THE KEEPER  `);
  out.push(`**Exported:** ${nowIso}  `);
  out.push(`**Coverage:** ${decided.length} of ${rows.length} decided, ${blocked.length} not actionable`);
  out.push('');
  out.push('> Generated from Keeper\'s decision queue. Implement only the items under');
  out.push('> **Decided**. Every item under **Not actionable** is an explicit hold —');
  out.push('> do not guess a rule, do not implement a default, and do not treat silence');
  out.push('> as permission. If a decided item turns out to depend on a held one, stop');
  out.push('> and leave it for Philip.');
  out.push('');

  out.push('## Decided');
  out.push('');
  if (decided.length === 0) {
    out.push('_Nothing decided yet._');
    out.push('');
  } else {
    for (const d of sortForBrief(decided)) {
      out.push(`### ${d.ref}${d.area ? ` — ${d.area}` : ''}`);
      out.push('');
      out.push(`**Question:** ${d.question}`);
      out.push('');
      out.push(`**Decision:** ${d.answer ?? '(no answer recorded)'}`);
      if (d.rationale) {
        out.push('');
        out.push(`**Why:** ${d.rationale}`);
      }
      out.push('');
      out.push(`_Priority: ${d.priority}${d.decided_at ? ` · decided ${d.decided_at}` : ''}_`);
      out.push('');
    }
  }

  out.push('## Not actionable');
  out.push('');
  if (blocked.length === 0) {
    out.push('_Everything was decided._');
    out.push('');
  } else {
    out.push('| Ref | Area | Status | Question | Note |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const d of sortForBrief(blocked)) {
      const note = [d.answer, d.rationale].filter(Boolean).join(' — ') || '—';
      out.push(
        `| ${d.ref} | ${d.area ?? '—'} | ${STATUS_LABEL[d.status] ?? d.status} | ` +
          `${cell(d.question)} | ${cell(note)} |`
      );
    }
    out.push('');
  }

  out.push('## Suggested order of work');
  out.push('');
  const ordered = sortForBrief(decided);
  if (ordered.length === 0) out.push('_Nothing to sequence._');
  else ordered.forEach((d, i) => out.push(`${i + 1}. **${d.ref}** — ${d.question}`));
  out.push('');

  return out.join('\n');
}

/** The same content as data, for an agent that would rather parse than read. */
export function renderBriefJson(set: DecisionSet, rows: Decision[], nowIso: string): string {
  return JSON.stringify(
    {
      set: {
        slug: set.slug,
        project: set.project,
        title: set.title,
        source_ref: set.source_ref,
        exported_at: nowIso,
      },
      decisions: rows.map((d) => ({
        ref: d.ref,
        area: d.area,
        question: d.question,
        status: d.status,
        implementable: d.status === 'answered',
        answer: d.answer,
        rationale: d.rationale,
        priority: d.priority,
        blocked_by: d.blocked_by,
        decided_at: d.decided_at,
      })),
    },
    null,
    2
  );
}

function sortForBrief(rows: Decision[]): Decision[] {
  return [...rows].sort(
    (a, b) =>
      (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) ||
      a.sort_order - b.sort_order
  );
}

/** Pipes and newlines would break the markdown table row. */
function cell(text: string): string {
  return text.replace(/\|/g, '\|').replace(/\s*\n\s*/g, ' ').trim();
}
