import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, submit, list, review } from '../src/sharedMemory/pilot.js';

async function fixture(fn: (root: string, input: Record<string, unknown>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'keeper-memory-'));
  try {
    await writeFile(join(root, 'CONTEXT.md'), 'Approved project context\n');
    await fn(root, { project: 'the-keeper', category: 'workflow', summary: 'Use UI preview for UI work',
      evidence: ['scripts/ui-preview.ts'], source: 'codex', baseSnapshotHash: (await snapshot(root)).hash });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('submission and review retain evidence without promoting or overwriting context', async () => fixture(async (root, input) => {
  assert.deepEqual(await list(root), []);
  const before = await snapshot(root);
  const p = await submit(root, input);
  assert.equal((await list(root))[0]?.review, null);
  const r = await review(root, p.id, 'philip', 'forward-to-keeper', 'Verified project source');
  assert.equal(r.stale, false);
  assert.equal((await list(root))[0]?.review?.disposition, 'forward-to-keeper');
  assert.deepEqual(await snapshot(root), before);
  assert.equal(JSON.parse(await readFile(join(root, 'inbox', `${p.id}.json`), 'utf8')).summary, input.summary);
  await assert.rejects(review(root, p.id, 'keeper', 'reject', 'Overwrite attempt'), /EEXIST/);
}));

test('scope, unknown fields, size, source, evidence and traversal are rejected', async () => fixture(async (root, input) => {
  for (const patch of [
    { project: 'solarize' }, { category: 'health' }, { source: 'other' }, { secret: 'extra field' },
    { summary: 'x'.repeat(1601) }, { evidence: [] }, { evidence: ['../.env'] },
    { evidence: ['src/../../other/file.ts'] }, { evidence: ['https://example.com'] },
    { evidence: ['C:\\Users\\phili\\.env'] },
  ]) await assert.rejects(submit(root, { ...input, ...patch }));
  assert.deepEqual(await list(root), []);
  await assert.rejects(review(root, '../escape', 'philip', 'reject', 'No'));
}));

test('stale snapshots block submissions and forwarding but allow rejection', async () => fixture(async (root, input) => {
  const p = await submit(root, input);
  await writeFile(join(root, 'CONTEXT.md'), 'Updated context\n');
  await assert.rejects(submit(root, input), /Snapshot changed/);
  assert.equal((await list(root))[0]?.stale, true);
  await assert.rejects(review(root, p.id, 'keeper', 'forward-to-keeper', 'Old evidence'), /Stale/);
  await review(root, p.id, 'keeper', 'reject', 'Superseded by current context');
}));

test('concurrent proposals remain distinct and concurrent reviews cannot overwrite', async () => fixture(async (root, input) => {
  const proposals = await Promise.all([submit(root, input), submit(root, input)]);
  assert.equal((await list(root)).length, 2);
  const results = await Promise.allSettled([
    review(root, proposals[0]!.id, 'philip', 'reject', 'First review'),
    review(root, proposals[0]!.id, 'keeper', 'reject', 'Concurrent review'),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
}));


test('claimed self-review and mismatched stored identities fail closed', async () => fixture(async (root, input) => {
  const own = await submit(root, { ...input, source: 'keeper' });
  await assert.rejects(review(root, own.id, 'keeper', 'forward-to-keeper', 'Self review'), /own proposal/);
  const other = await submit(root, input);
  const path = join(root, 'inbox', `${other.id}.json`);
  await writeFile(path, JSON.stringify({ ...other, id: own.id }));
  await assert.rejects(list(root), /ID/);
  await assert.rejects(review(root, other.id, 'philip', 'reject', 'Mismatch'), /ID/);
}));
