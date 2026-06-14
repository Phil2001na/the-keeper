import type Anthropic from '@anthropic-ai/sdk';
import { config, localTimeString } from '../config.js';
import { digests, interactions } from '../db/repositories.js';
import { createMessage } from './llm.js';
import { logUsage } from './usage.js';

/**
 * The rolling digest — the memory layer between the raw context window and the
 * nightly journal. Its covered_until timestamp doubles as the context window's
 * LEFT EDGE: everything after the anchor rides in context verbatim (append-only
 * between folds, so the prompt-cache prefix keeps hitting); everything before
 * it has been distilled into the digest by a cheap model.
 *
 * This is what fixes "you don't remember? it's in this chat" — five hours ago
 * is either still in raw view, or summarized two paragraphs up.
 */

let folding = false;

/**
 * Create the anchor row on first run, placed so the current keepRecent
 * messages stay in view. Until an anchor exists the orchestrator falls back to
 * a plain sliding window, so this being fire-and-forget at boot is safe.
 */
export async function ensureAnchor(): Promise<void> {
  const existing = await digests.get('rolling');
  if (existing?.covered_until) return;
  const recent = await interactions.recent(config.keepRecent);
  const oldestKept = recent[0]?.created_at;
  // Strictly before the oldest kept message (sinceAnchor is a strict gt).
  const anchorIso = oldestKept
    ? new Date(new Date(oldestKept).getTime() - 1).toISOString()
    : new Date().toISOString();
  await digests.set('rolling', existing?.content ?? '', anchorIso);
  console.log(`[digest] conversation window anchored at ${anchorIso}.`);
}

const FOLD_SYSTEM =
  `You maintain THE KEEPER's rolling digest — its working memory of the conversation between it ("you") and Philip ("him") that is scrolling out of its context window. ` +
  `Fold the new messages into the existing digest and return the UPDATED DIGEST ONLY: max ~220 words, terse dated notes, oldest first. ` +
  `Keep what future turns will need: decisions, commitments, amounts and numbers, names, dates, plans, open loops, his state of mind where it matters. Drop greetings and filler. ` +
  `Notes that are closed, superseded, or more than a few days old may be dropped — the nightly journal and the searchable archive hold the deep past.`;

export async function foldNow(): Promise<void> {
  const dig = await digests.get('rolling');
  if (!dig?.covered_until) return;
  const rows = await interactions.sinceAnchor(dig.covered_until, 400);
  if (rows.length <= config.foldAt) return;

  const toFold = rows.slice(0, rows.length - config.keepRecent);
  const last = toFold[toFold.length - 1];
  if (!last) return;

  const lines = toFold
    .map((r) => {
      const when = r.created_at.slice(5, 16).replace('T', ' ');
      const text = r.content.length > 600 ? r.content.slice(0, 600) + '…' : r.content;
      return `[${when}Z ${r.role === 'user' ? 'him' : 'you'}] ${text}`;
    })
    .join('\n');

  const res = await createMessage({
    model: config.digestModel,
    max_tokens: 500,
    system: FOLD_SYSTEM,
    tools: [],
    messages: [
      {
        role: 'user',
        content:
          `Now: ${localTimeString()} (${config.timezone}).\n\n` +
          `CURRENT DIGEST:\n${dig.content || '(empty)'}\n\n` +
          `NEW MESSAGES SCROLLING OUT OF VIEW:\n${lines}`,
      },
    ],
  });
  logUsage('fold', config.digestModel, [res.usage]);

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (!text) return;

  await digests.set('rolling', text, last.created_at);
  console.log(`[digest] folded ${toFold.length} messages (anchor → ${last.created_at}).`);
}

/** Post-turn maintenance — fire-and-forget; never blocks a reply. */
export function maybeFold(): void {
  if (folding) return;
  folding = true;
  void foldNow()
    .catch((err) => console.error('[digest] fold failed:', err))
    .finally(() => {
      folding = false;
    });
}
