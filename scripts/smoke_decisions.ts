/**
 * End-to-end smoke test for the decision queue, driven through dispatchTool —
 * the same entry point the agent uses, so this proves the tools are actually
 * registered and callable, not just that the repositories compile.
 *
 *   npm run smoke:decisions
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_KEY, like the app itself. It creates
 * a throwaway set (smoke-<timestamp>) and deletes it at the end, so it is safe
 * to run against the live project — it never touches a real decision set.
 * Pass --keep to leave the fixture behind for inspection.
 */
import { toolDefinitions, dispatchTool } from '../src/agent/tools.js';
import { db } from '../src/db/client.js';
import { decisionSets, decisions } from '../src/db/repositories.js';

const KEEP = process.argv.includes('--keep');
const slug = `smoke-${Date.now()}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

async function call(tool: string, input: Record<string, unknown>): Promise<string> {
  const res = await dispatchTool(tool, input);
  return res.output;
}

async function main(): Promise<void> {
  console.log(`\nDecision queue smoke test — fixture ${slug}\n`);

  // 17/16. Every decision capability is actually in the tool registry.
  console.log('registry');
  const names = new Set(toolDefinitions.map((t) => ('name' in t ? t.name : '')));
  for (const t of [
    'list_decision_sets',
    'get_decision_set',
    'record_decision',
    'update_decision',
    'export_decision_brief',
    'close_decision_set',
    'link_decision_artifact',
  ]) {
    check(`${t} is registered`, names.has(t));
  }

  // 1. Creation. (Sets are seeded by whatever produced the UAT, not by a tool —
  // the agent answers decisions, it does not invent the questions.)
  console.log('\nfixture');
  const set = await decisionSets.create({
    slug,
    project: 'smoke',
    title: 'Smoke test set',
    context: 'Throwaway fixture created by scripts/smoke_decisions.ts.',
    source_ref: 'smoke/UAT.md',
    export_path: 'smoke/DECISIONS.md',
  });
  check('set created', Boolean(set.id));
  await decisions.create({
    set_id: set.id, ref: 'S-01', question: 'First question?', sort_order: 1,
    options: [{ label: 'Alpha', detail: 'first option' }, { label: 'Beta' }],
    recommendation: 'Alpha, probably.', priority: 'high',
  });
  await decisions.create({
    set_id: set.id, ref: 'S-02', question: 'Second question?', sort_order: 2,
    blocked_by: 'S-01', options: [{ label: 'Yes' }, { label: 'No' }],
  });
  await decisions.create({
    set_id: set.id, ref: 'S-03', question: 'Third question?', sort_order: 3,
  });
  check('decisions created', (await decisions.forSet(set.id)).length === 3);

  // 2. Listing open sets.
  console.log('\nlist');
  const listed = await call('list_decision_sets', { status: 'open' });
  check('open listing includes the fixture', listed.includes(slug));
  check('listing carries real counts', listed.includes('3 open of 3'), listed);

  // 14. The "nothing open" branch the scheduler depends on.
  const none = await call('list_decision_sets', { status: 'implemented' });
  check(
    'empty listing tells the agent not to manufacture a nudge',
    none.toLowerCase().includes('no open decision sets') || none.toLowerCase().includes('no decision sets'),
    none
  );

  // 3. Reading the next unanswered decision — and NOT the blocked one.
  console.log('\nread');
  const next1 = await call('get_decision_set', { set: slug });
  check('next returns S-01', next1.includes('S-01'), next1);
  check('next skips the blocked S-02', !next1.includes('S-02\nQuestion'), next1);
  check('next carries options', next1.includes('Alpha'), next1);
  check('next carries the recommendation', next1.includes('Alpha, probably.'), next1);
  check('next states remaining count', next1.includes('of 3 still need him'), next1);

  const one = await call('get_decision_set', { set: slug, mode: 'one', ref: 'S-02' });
  check('mode one reads a specific ref', one.includes('Second question?'), one);

  // 4/5. Recording a confirmed answer, with reasoning preserved.
  console.log('\nrecord');
  const rec = await call('record_decision', {
    set: slug, ref: 'S-01', status: 'confirmed',
    answer: 'Alpha', rationale: 'Because the client already assumes it.',
  });
  check('record confirms', rec.includes('confirmed'), rec);
  const afterRec = await decisions.resolve(set.id, 'S-01');
  check('answer persisted', afterRec?.answer === 'Alpha');
  check('reasoning persisted verbatim', afterRec?.rationale === 'Because the client already assumes it.');
  check('decided_at stamped', Boolean(afterRec?.decided_at));

  // 13. Idempotency — the identical call again must not double-write history.
  await call('record_decision', {
    set: slug, ref: 'S-01', status: 'confirmed',
    answer: 'Alpha', rationale: 'Because the client already assumes it.',
  });
  const hist1 = await decisions.history(afterRec!.id);
  check('retrying an identical answer appends no second history row', hist1.length === 1, `${hist1.length} rows`);

  // 8. Counts move as answers land, and the unblocked S-02 becomes next.
  const next2 = await call('get_decision_set', { set: slug });
  check('count dropped to 2 remaining', next2.includes('2 of 3 still need him'), next2);
  check('S-02 unblocked once S-01 settled', next2.includes('S-02'), next2);

  // 6. Revising — refused without revise, kept in history with it.
  console.log('\nrevise');
  const refused = await call('record_decision', { set: slug, ref: 'S-01', answer: 'Beta' });
  check('overwrite refused without revise:true', refused.includes('revise:true'), refused);
  const revised = await call('record_decision', {
    set: slug, ref: 'S-01', answer: 'Beta', rationale: 'He changed his mind after reading the Act.', revise: true,
  });
  check('revision accepted with revise:true', revised.includes('Beta'), revised);
  const hist2 = await decisions.history(afterRec!.id);
  check('previous answer survives in history', hist2.some((h) => h.previous_answer === 'Alpha'), JSON.stringify(hist2));
  check(
    'previous reasoning survives in history',
    hist2.some((h) => h.previous_rationale === 'Because the client already assumes it.')
  );

  // 7. Skip and reopen.
  console.log('\nskip / reopen');
  await call('update_decision', { set: slug, ref: 'S-03', status: 'skipped', note: 'not now' });
  const skipped = await decisions.resolve(set.id, 'S-03');
  check('skipped', skipped?.status === 'skipped');
  const afterSkip = await call('get_decision_set', { set: slug });
  check('skipped is not counted as remaining', afterSkip.includes('1 of 3 still need him'), afterSkip);
  // Regression (Codex P2): update_decision passes null answer/rationale to
  // preserve them, so the no-op test must compare EFFECTIVE values. Retrying
  // the same status change on an answered decision used to append history
  // forever.
  const answered = await decisions.resolve(set.id, 'S-01');
  await call('update_decision', { set: slug, ref: 'S-01', status: 'discussed', note: 'reopening' });
  const hBefore = (await decisions.history(answered!.id)).length;
  await call('update_decision', { set: slug, ref: 'S-01', status: 'discussed', note: 'reopening' });
  await call('update_decision', { set: slug, ref: 'S-01', status: 'discussed', note: 'reopening' });
  const hAfter = (await decisions.history(answered!.id)).length;
  check('retried update_decision appends no duplicate history', hBefore === hAfter, `${hBefore} -> ${hAfter}`);
  check('update_decision preserved the answer through a status change',
    (await decisions.resolve(set.id, 'S-01'))?.answer === 'Beta');

  await call('update_decision', { set: slug, ref: 'S-03', status: 'open', note: 'back on' });
  check('reopened', (await decisions.resolve(set.id, 'S-03'))?.status === 'open');
  check('update_decision kept the answer it did not set', (await decisions.resolve(set.id, 'S-01'))?.answer === 'Beta');

  // 10. Closure refused while questions remain.
  console.log('\nclose');
  const refusedClose = await call('close_decision_set', { set: slug, status: 'completed' });
  check('closure refused with open questions', refusedClose.includes('Not closing'), refusedClose);
  const forcedNoReason = await call('close_decision_set', { set: slug, status: 'closed', force: true });
  check('forcing without a reason refused', forcedNoReason.includes('closure_reason'), forcedNoReason);

  // Regression (Codex P2): with every remaining question parked (skipped /
  // unresolved), counts.open is 0 — 'completed' used to sail through unforced
  // even though nothing was settled.
  await call('update_decision', { set: slug, ref: 'S-01', status: 'unresolved', note: 'parked' });
  await call('update_decision', { set: slug, ref: 'S-02', status: 'skipped', note: 'parked' });
  await call('update_decision', { set: slug, ref: 'S-03', status: 'skipped', note: 'parked' });
  const parkedNext = await call('get_decision_set', { set: slug });
  check('nothing counts as open once all are parked', parkedNext.includes('0 still open'), parkedNext);
  check('parked questions are not reported as settled',
    parkedNext.includes('parked') && !parkedNext.includes('Every question in this set is settled'), parkedNext);
  const parkedComplete = await call('close_decision_set', { set: slug, status: 'completed' });
  check('completed refused while questions are only parked, not settled',
    parkedComplete.includes('not settled'), parkedComplete);
  await call('record_decision', { set: slug, ref: 'S-01', answer: 'Beta', rationale: 'settled after all', revise: true });
  await call('update_decision', { set: slug, ref: 'S-02', status: 'open' });
  await call('update_decision', { set: slug, ref: 'S-03', status: 'open' });

  // 9. Deterministic export.
  console.log('\nexport');
  const ex1 = await call('export_decision_brief', { set: slug });
  const hash1 = /hash ([0-9a-f]{16})/.exec(ex1)?.[1];
  check('export produced a hash', Boolean(hash1), ex1.slice(0, 200));
  check('brief carries the confirmed decision', ex1.includes('Beta'), '');
  check('brief carries the reasoning', ex1.includes('changed his mind'), '');
  check('brief lists unresolved questions', ex1.includes('Unresolved questions'), '');
  check('export does not close the set', ex1.includes('exporting does not close it'), '');
  const ex2 = await call('export_decision_brief', { set: slug });
  check('re-export of an unchanged set writes no new version', ex2.includes('Nothing has changed'), ex2.slice(0, 200));
  const preview = await call('export_decision_brief', { set: slug, preview: true });
  check('preview saves nothing', preview.startsWith('Preview only'), preview.slice(0, 80));

  // Regression (Codex P1): an unchanged brief exported earlier without a commit
  // used to return "nothing has changed" and never honour a later commit:true.
  check('unchanged export says how to commit it', ex2.includes('commit:true'), ex2.slice(0, 200));
  const ex3 = await call('export_decision_brief', { set: slug, commit: true });
  check('commit:true on an unchanged brief reaches the commit path, not the early return',
    !ex3.includes('Nothing has changed'), ex3.slice(0, 200));
  check('unchanged commit re-uses the same version rather than minting one',
    ex3.includes('Re-committed v1') || ex3.includes('not committed') || ex3.includes('commit failed'),
    ex3.slice(0, 200));

  // 11. Explicit closure over unresolved questions.
  const forced = await call('close_decision_set', {
    set: slug, status: 'closed', force: true, closure_reason: 'smoke test done',
  });
  check('forced closure with a reason succeeds', forced.includes('closed'), forced);
  check('closure reason recorded', (await decisionSets.resolve(slug))?.closure_reason === 'smoke test done');

  // 12. There is exactly one user, so the boundary that exists is set
  // resolution: an unknown key must not silently resolve to someone's set.
  console.log('\nboundaries');
  check('unknown set key is rejected', (await call('get_decision_set', { set: 'no-such-set' })).includes('No decision set'));
  check('unknown ref is rejected', (await call('record_decision', { set: slug, ref: 'S-99', answer: 'x' })).includes('No decision'));

  // Linking.
  const linked = await call('link_decision_artifact', { set: slug, link_type: 'commit', ref: 'deadbeef' });
  check('link added', linked.includes('deadbeef'), linked);
  const linkedAgain = await call('link_decision_artifact', { set: slug, link_type: 'commit', ref: 'deadbeef' });
  check('duplicate link is idempotent', linkedAgain.includes('deadbeef'), linkedAgain);

  if (!KEEP) {
    await db.from('keeper_decision_sets').delete().eq('id', set.id);
    console.log('\nfixture deleted (cascade).');
  } else {
    console.log(`\nfixture kept: ${slug}`);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
