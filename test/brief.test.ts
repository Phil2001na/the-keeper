// The Keeper briefs PC agents with intent, not instructions. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefProblem, withContext } from '../src/agent/brief.js';

test('a short goal passes', () => {
  assert.equal(briefProblem('Test SitePMS end to end through the frontend and report every bug, with who you were viewing as.'), null);
});

test('a numbered procedure or an essay is sent back to be cut to the goal', () => {
  const steps = 'Test SitePMS.\n1. Log in\n2. Open agreements\n3. Approve as supervisor\n4. Check assessments';
  assert.match(briefProblem(steps)!, /4-step procedure/);
  assert.match(briefProblem('x'.repeat(1300))!, /1300 characters/);
});

test('his pasted material travels verbatim beside the goal, not inside it', () => {
  const t = withContext('Find the bugs.', 'Login: bot@plumbline.test\n1. step from his doc');
  assert.match(t, /^Find the bugs\.\n\nMaterial from Philip \(verbatim\):\nLogin: bot@plumbline\.test/);
  assert.equal(withContext('Just this.', '  '), 'Just this.');
});
