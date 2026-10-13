import { createHash } from 'node:crypto';
import {
  countDecisions,
  type Decision,
  type DecisionLink,
  type DecisionSet,
} from '../db/repositories.js';

/**
 * Renders a decision set as an implementation brief — the artifact a coding
 * agent reads instead of Philip repeating the conversation.
 *
 * Deterministic by design: the same decisions in the same states always render
 * byte-identical, and generated_at is excluded from the hash. That is what
 * makes "has anything actually changed since the last export?" answerable, and
 * what stops a re-export from looking like a new decision every time.
 */

function bullet(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

function optionLines(d: Decision): string[] {
  if (!Array.isArray(d.options) || d.options.length === 0) return [];
  return d.options.map((o) => {
    const label = typeof o?.label === 'string' ? o.label : String(o);
    const detail = typeof o?.detail === 'string' && o.detail ? ` — ${o.detail}` : '';
    return `  - ${label}${detail}`;
  });
}

/** The body of the brief, without the generated_at line. Hash this. */
function renderBody(set: DecisionSet, list: Decision[], links: DecisionLink[]): string {
  const counts = countDecisions(list);
  const confirmed = list.filter((d) => d.status === 'confirmed' || d.status === 'implemented' || d.status === 'verified');
  const routed = list.filter((d) => d.status === 'routed');
  const openLeft = list.filter((d) => d.status === 'open' || d.status === 'discussed');
  const parked = list.filter((d) => d.status === 'skipped' || d.status === 'unresolved');

  const out: string[] = [];
  out.push(`# Implementation brief — ${set.title}`);
  out.push('');
  out.push(`**Project:** ${set.project}  `);
  out.push(`**Decision set:** \`${set.slug}\`  `);
  if (set.source_ref) out.push(`**Source:** ${set.source_ref}  `);
  out.push(`**Status:** ${set.status}`);
  out.push('');
  out.push(
    `${counts.confirmed} confirmed · ${counts.routed} routed elsewhere · ` +
      `${counts.open} still open · ${counts.skipped + counts.unresolved} parked · ${counts.total} total`
  );

  if (set.context) {
    out.push('');
    out.push('## Problem / context');
    out.push('');
    out.push(bullet(set.context));
  }

  out.push('');
  out.push('## Confirmed decisions');
  out.push('');
  if (confirmed.length === 0) {
    out.push('_None confirmed yet._');
  } else {
    for (const d of confirmed) {
      out.push(`### ${d.ref} — ${d.question}`);
      out.push('');
      if (d.area) out.push(`**Area:** ${d.area}  `);
      out.push(`**Decision:** ${d.answer ?? '(no answer text recorded)'}`);
      if (d.rationale) {
        out.push('');
        out.push(`**Why:** ${bullet(d.rationale)}`);
      }
      const rejected = optionLines(d).filter(
        (line) => !d.answer || !line.toLowerCase().includes(String(d.answer).toLowerCase().slice(0, 40))
      );
      if (rejected.length > 0) {
        out.push('');
        out.push('**Options not taken:**');
        out.push(...rejected);
      }
      out.push('');
    }
  }

  if (routed.length > 0) {
    out.push('## Routed — not Philip\'s call');
    out.push('');
    out.push('These are answered by someone else. Do not implement a guess for them.');
    out.push('');
    for (const d of routed) {
      out.push(`- **${d.ref}** ${d.question}`);
      out.push(`  - Whose call: ${d.routed_to ?? 'unspecified'}`);
      if (d.rationale) out.push(`  - Note: ${bullet(d.rationale)}`);
    }
    out.push('');
  }

  out.push('## Unresolved questions');
  out.push('');
  if (openLeft.length === 0 && parked.length === 0) {
    out.push('_None — every question in this set is settled._');
  } else {
    for (const d of [...openLeft, ...parked]) {
      out.push(`- **${d.ref}** (${d.status}) ${d.question}`);
      if (d.blocked_by) out.push(`  - Blocked by ${d.blocked_by}`);
      if (d.rationale) out.push(`  - Note: ${bullet(d.rationale)}`);
    }
  }
  out.push('');

  out.push('## Implementation constraints');
  out.push('');
  out.push('- Implement only the confirmed decisions above. A routed or unresolved question is not a licence to pick a default.');
  out.push('- Where a decision names a rule as configuration rather than fixed behaviour, build it as configuration.');
  out.push('- If implementing one of these surfaces a question that is not in this brief, stop and raise it rather than deciding it.');
  out.push('');

  out.push('## Verification requirements');
  out.push('');
  out.push('- Each confirmed decision needs a test or a check that would fail if the opposite option had been built.');
  out.push('- Reference the decision ref (D-nn) in the test name or commit message so the trail back to this brief survives.');
  out.push('');

  if (links.length > 0) {
    out.push('## Linked artifacts');
    out.push('');
    for (const l of links) {
      out.push(`- ${l.link_type}: ${l.ref}${l.note ? ` — ${l.note}` : ''}`);
    }
    out.push('');
  }

  out.push('## Source references');
  out.push('');
  out.push(`- UAT / origin: ${set.source_ref ?? '(none recorded)'}`);
  if (set.repo_owner && set.repo_name) out.push(`- Repository: ${set.repo_owner}/${set.repo_name}`);
  if (set.export_path) out.push(`- Brief path: ${set.export_path}`);
  out.push(`- Decision set id: ${set.id}`);

  return out.join('\n');
}

export interface RenderedBrief {
  /** Full markdown, including the generated_at footer. */
  content: string;
  /** Hash of the body only — stable across re-exports when nothing changed. */
  contentHash: string;
}

export function renderDecisionBrief(
  set: DecisionSet,
  list: Decision[],
  links: DecisionLink[] = [],
  generatedAt: Date = new Date()
): RenderedBrief {
  const body = renderBody(set, list, links);
  const contentHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const content =
    `${body}\n\n---\n\n_Generated by THE KEEPER at ${generatedAt.toISOString()} · content hash \`${contentHash}\`_\n`;
  return { content, contentHash };
}
