/**
 * One-time (re-runnable, but NOT idempotent) backfill: walk the ENTIRE
 * conversation archive in order and extract retrospective state_captures for
 * the moments Philip was genuinely venting or revealing something real about
 * his inner state — not routine logistics or small talk.
 *
 * Every capture this writes is mode='retrospective' / approval_status=
 * 'provisional' by construction (see stateCaptures.create) — it is Jarvis's
 * dated best read of an old message, not something Philip confirmed live.
 * Nothing here is a diagnosis; each dimension is tagged reported (close to
 * his own words) or inferred (reading between the lines).
 *
 * Run with: npx tsx scripts/backfill_state_captures.ts
 * Costs real Anthropic tokens — logs its own spend as a sys.turn observation
 * like every other agent run, so /status reflects it.
 * Re-runnable: skips any candidate whose period overlaps a capture that
 * already exists, so tightening the chunk size or prompt and re-running
 * only adds what was missed, it doesn't duplicate what's already there.
 * Chunk size defaults to 40 messages; override with BACKFILL_CHUNK_SIZE.
 */
import '../src/db/client.js'; // ensures config is loaded before anything else touches it
import { config } from '../src/config.js';
import { db } from '../src/db/client.js';
import { stateCaptures, type Interaction } from '../src/db/repositories.js';
import { createMessage } from '../src/agent/llm.js';
import { logUsage, sumUsage } from '../src/agent/usage.js';
import type Anthropic from '@anthropic-ai/sdk';

const CHUNK_SIZE = Number(process.env.BACKFILL_CHUNK_SIZE ?? 40); // messages per extraction call
const VALID_DIMENSIONS = new Set([
  'body', 'emotion', 'thoughts', 'behaviour', 'context', 'meaning', 'need', 'relationships', 'identity',
]);

const SYSTEM =
  `You are archiving THE KEEPER's old conversation with Philip into its new state_capture ledger. ` +
  `You are NOT continuing the conversation and Philip will not see this reply — you are a careful archivist, not a chatbot.\n\n` +
  `Read the transcript segment below (his messages are "him", Jarvis's are "you"). Find moments where Philip reveals ` +
  `something real about his inner state: explicit venting or distress, but ALSO calm, reflective, or philosophical ` +
  `monologues that still carry real emotional weight — grief, existential reflection, self-worth, identity, mortality, ` +
  `relapse or coping patterns (weed, compulsive habits), loneliness, a hard realization about money/health/relationships, ` +
  `a moment of hope or connection that clearly mattered to him. The signal is WEIGHT, not tone — a quiet, articulate ` +
  `reflection on feeling small or stuck counts just as much as an angry vent. Do NOT manufacture drama from routine ` +
  `logistics, small talk, or ordinary task updates with no real feeling behind them. A typical segment has zero to two ` +
  `such moments; a heavier one can have more.\n\n` +
  `For each moment found, output one object:\n` +
  `{\n` +
  `  "period_start": "<ISO timestamp of the first relevant message>",\n` +
  `  "period_end": "<ISO timestamp of the last relevant message>",\n` +
  `  "summary": "<one or two honest sentences, dated>",\n` +
  `  "raw_text": "<a short verbatim quote or two of his own words, the emotionally important part>",\n` +
  `  "confidence": "low" | "medium" | "high",\n` +
  `  "dimensions": [\n` +
  `    {"dimension": "body|emotion|thoughts|behaviour|context|meaning|need|relationships|identity",\n` +
  `     "value": "<plain-language read>",\n` +
  `     "intensity": <optional 1-10>,\n` +
  `     "certainty": "reported" | "inferred",\n` +
  `     "evidence_text": "<optional short quote>"}\n` +
  `  ]\n` +
  `}\n\n` +
  `Rules:\n` +
  `- NEVER diagnose. No clinical or psychiatric labels as a value — describe what was said or observed, in his terms.\n` +
  `- certainty "reported" only when the dimension is close to his own words; "inferred" when you are reading between the lines.\n` +
  `- Give at least one dimension per capture, and don't force dimensions that weren't actually touched on.\n` +
  `- Output ONLY a JSON array (use [] if nothing qualifies in this segment). No prose, no markdown fences, no commentary.`;

interface RawCapture {
  period_start?: string;
  period_end?: string;
  summary?: string;
  raw_text?: string;
  confidence?: string;
  dimensions?: Array<{
    dimension?: string;
    value?: string;
    intensity?: number;
    certainty?: string;
    evidence_text?: string;
  }>;
}

async function fetchAllInteractions(): Promise<Interaction[]> {
  const pageSize = 1000;
  const all: Interaction[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('keeper_interactions')
      .select('id, role, content, trigger, created_at')
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`[backfill] fetch failed: ${error.message}`);
    const rows = data as Interaction[];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  return JSON.parse(body);
}

/** Existing capture windows, so a re-run doesn't duplicate what's already been captured. */
async function fetchExistingRanges(): Promise<Array<{ start: number; end: number }>> {
  const { data, error } = await db.from('keeper_state_captures').select('period_start, period_end, captured_at');
  if (error) throw new Error(`[backfill] fetch existing ranges failed: ${error.message}`);
  return (data as Array<{ period_start: string | null; period_end: string | null; captured_at: string }>).map((r) => ({
    start: new Date(r.period_start ?? r.captured_at).getTime(),
    end: new Date(r.period_end ?? r.captured_at).getTime(),
  }));
}

function overlapsExisting(startIso: string, endIso: string, existing: Array<{ start: number; end: number }>): boolean {
  const s = new Date(startIso).getTime();
  const e = new Date(endIso).getTime();
  return existing.some((r) => s <= r.end && e >= r.start);
}

async function main(): Promise<void> {
  console.log('[backfill] fetching full archive...');
  const all = await fetchAllInteractions();
  console.log(`[backfill] ${all.length} interactions, ${all[0]?.created_at} → ${all[all.length - 1]?.created_at}`);
  const existingRanges = await fetchExistingRanges();
  console.log(`[backfill] ${existingRanges.length} existing capture(s) — will skip anything overlapping them.`);

  const chunks = chunk(all, CHUNK_SIZE);
  const usages: Anthropic.Usage[] = [];
  let written = 0;
  let skippedBad = 0;
  let skippedDupe = 0;

  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i]!;
    const lines = rows
      .map((r) => `[${r.created_at} ${r.role === 'user' ? 'him' : 'you'}] ${r.content}`)
      .join('\n');

    console.log(
      `[backfill] chunk ${i + 1}/${chunks.length} (${rows.length} msgs, ${rows[0]!.created_at.slice(0, 10)} → ${rows[rows.length - 1]!.created_at.slice(0, 10)})...`
    );

    let res;
    try {
      res = await createMessage({
        model: config.model,
        max_tokens: 3000,
        system: SYSTEM,
        tools: [],
        messages: [{ role: 'user', content: lines }],
      });
    } catch (err) {
      console.error(`[backfill] chunk ${i + 1} API call failed, skipping:`, err);
      continue;
    }
    usages.push(res.usage);

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    let parsed: unknown;
    try {
      parsed = text ? extractJson(text) : [];
    } catch (err) {
      console.error(`[backfill] chunk ${i + 1} returned unparseable JSON, skipping. Raw:`, text.slice(0, 300));
      skippedBad++;
      continue;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) continue;

    for (const raw of parsed as RawCapture[]) {
      if (!raw.summary || !raw.period_start || !raw.period_end || !Array.isArray(raw.dimensions) || raw.dimensions.length === 0) {
        console.warn(`[backfill] chunk ${i + 1}: dropping malformed capture`, raw);
        skippedBad++;
        continue;
      }
      const dims = raw.dimensions
        .filter((d) => d.dimension && VALID_DIMENSIONS.has(d.dimension) && d.value)
        .map((d) => ({
          dimension: d.dimension as string,
          value: d.value as string,
          intensity: typeof d.intensity === 'number' ? Math.min(Math.max(Math.round(d.intensity), 1), 10) : null,
          certainty: d.certainty === 'inferred' ? ('inferred' as const) : ('reported' as const),
          evidence_text: d.evidence_text?.trim() || null,
        }));
      if (dims.length === 0) {
        skippedBad++;
        continue;
      }
      if (overlapsExisting(raw.period_start, raw.period_end, existingRanges)) {
        skippedDupe++;
        continue;
      }
      const confidence = raw.confidence === 'low' || raw.confidence === 'high' ? raw.confidence : 'medium';
      try {
        const created = await stateCaptures.create({
          mode: 'retrospective',
          summary: raw.summary.trim(),
          raw_text: raw.raw_text?.trim() || null,
          confidence,
          period_start: raw.period_start,
          period_end: raw.period_end,
          captured_at: raw.period_end,
          dimensions: dims,
        });
        written++;
        existingRanges.push({ start: new Date(raw.period_start).getTime(), end: new Date(raw.period_end).getTime() });
        console.log(`[backfill]   → captured [${created.id.slice(0, 8)}] ${raw.period_start.slice(0, 10)}: ${raw.summary.slice(0, 90)}`);
      } catch (err) {
        console.error('[backfill] insert failed, skipping:', err);
        skippedBad++;
      }
    }
  }

  logUsage('backfill_state_captures', config.model, usages);
  const totals = sumUsage(usages);
  console.log(
    `[backfill] done. ${written} captures written, ${skippedDupe} skipped as overlapping existing captures, ${skippedBad} dropped as malformed. ` +
    `${chunks.length} chunks, ${totals.in + totals.cr}/${totals.out} approx in/out tokens.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill] fatal:', err);
    process.exit(1);
  });
