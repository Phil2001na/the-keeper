// ─── Briefing agents on the PC ─────────────────────────────────────────────
// Philip's rule: agents on the PC are stronger models than the Keeper and get
// intent, not instructions. The prompt says so; this makes it hold. A brief that
// is long or reads like a procedure is sent back once to be cut to the goal.
// What he gave verbatim (a pasted doc, logins) travels separately in `context`.
const STEP_LINE = /^\s*(\d+[.)]|[-*\u2022]|step\s*\d+)/i;
export function briefProblem(goal: string): string | null {
  const steps = goal.split(/\r?\n/).filter((l) => STEP_LINE.test(l)).length;
  if (goal.length <= 1200 && steps < 4) return null;
  return (
    `Not started: that brief is ${goal.length > 1200 ? `${goal.length} characters` : `a ${steps}-step procedure`}. ` +
    'The agent is a stronger model than you and already has the standing rules. Rewrite the goal in a few sentences: what he wants and what done looks like. ' +
    'Anything he gave you verbatim (a pasted doc, test logins, URLs) goes in `context`, not the goal. Then call the tool again.'
  );
}

export function withContext(goal: string, context: unknown): string {
  const c = typeof context === 'string' ? context.trim().slice(0, 12000) : '';
  return c ? `${goal.trim()}\n\nMaterial from Philip (verbatim):\n${c}` : goal;
}
