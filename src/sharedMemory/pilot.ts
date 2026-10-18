// Deliberately standalone: no config, dotenv, network, database or agent imports.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const PROJECT = 'the-keeper';
const text = z.string().trim().min(1).max(1600);
export const inputSchema = z.object({
  project: z.literal(PROJECT),
  category: z.enum(['architecture', 'workflow', 'decision', 'correction']),
  summary: text,
  evidence: z.array(z.string().regex(/^(src|scripts|test|docs|pc-agent)\/[a-zA-Z0-9_./() -]+$|^(README|AGENTS|CLAUDE|UPDATES)\.md$/)).min(1).max(5),
  source: z.enum(['claude-code', 'codex', 'philip', 'keeper']),
  baseSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const proposalSchema = inputSchema.extend({ id: z.string().uuid(), submittedAt: z.string().datetime() });
const reviewSchema = z.object({
  id: z.string().uuid(), reviewedAt: z.string().datetime(),
  reviewer: z.enum(['philip', 'keeper']), disposition: z.enum(['forward-to-keeper', 'reject']),
  note: text, snapshotHashAtReview: z.string(), stale: z.boolean(),
}).strict();
const idSchema = z.string().uuid();

export async function snapshot(root: string) {
  const content = await readFile(join(root, 'CONTEXT.md'), 'utf8');
  return { project: PROJECT, hash: createHash('sha256').update(content).digest('hex'), content };
}

export async function submit(root: string, raw: unknown) {
  const input = inputSchema.parse(raw);
  // Evidence must name an in-project source, never traverse to another project.
  if (input.evidence.some(p => p.split('/').some(part => part === '..' || part === '.'))) {
    throw new Error('Evidence must stay inside the Keeper project');
  }
  const current = await snapshot(root);
  if (input.baseSnapshotHash !== current.hash) throw new Error('Snapshot changed; reread CONTEXT.md before submitting');
  const proposal = { ...input, id: randomUUID(), submittedAt: new Date().toISOString() };
  await mkdir(join(root, 'inbox'), { recursive: true });
  await writeFile(join(root, 'inbox', `${proposal.id}.json`), JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx' });
  return proposal;
}

export async function list(root: string) {
  const current = await snapshot(root);
  let names: string[];
  try { names = await readdir(join(root, 'inbox')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  return Promise.all(names.filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).sort().map(async name => {
    const proposal = proposalSchema.parse(JSON.parse(await readFile(join(root, 'inbox', name), 'utf8')));
    if (proposal.id !== name.slice(0, -5)) throw new Error('Proposal ID does not match its filename');
    let review = null;
    try { review = reviewSchema.parse(JSON.parse(await readFile(join(root, 'reviews', `${proposal.id}.json`), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (review && review.id !== proposal.id) throw new Error('Review ID does not match its proposal');
    return { proposal, review, stale: proposal.baseSnapshotHash !== current.hash };
  }));
}

export async function review(root: string, id: string, reviewer: string, disposition: string, note: string) {
  idSchema.parse(id);
  const proposal = proposalSchema.parse(JSON.parse(await readFile(join(root, 'inbox', `${id}.json`), 'utf8')));
  if (proposal.id !== id) throw new Error('Proposal ID does not match its filename');
  if (proposal.source === reviewer) throw new Error('Do not review your own proposal');
  const current = await snapshot(root);
  const record = reviewSchema.parse({ id, reviewer, disposition, note,
    reviewedAt: new Date().toISOString(), snapshotHashAtReview: current.hash,
    stale: proposal.baseSnapshotHash !== current.hash });
  if (record.stale && record.disposition === 'forward-to-keeper') throw new Error('Stale proposal: resubmit against current snapshot or reject');
  await mkdir(join(root, 'reviews'), { recursive: true });
  await writeFile(join(root, 'reviews', `${id}.json`), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  return record; // Review never promotes content into CONTEXT.md or Keeper facts.
}
