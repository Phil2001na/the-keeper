# The decision queue

A **decision set** is a project's open questions, held as a queue and worked
through with Philip in conversation one at a time, then exported as an
implementation brief a coding agent can build from without him in the room.

It exists because of a specific shape of work: a UAT comes back with a pile of
questions that block everything, most of them needing a policy call rather than
code. Those calls do not need a PC. They need him and twenty minutes.

## Why this document exists

The tables `keeper_decision_sets` and `keeper_decisions` were created directly
against the live Supabase project on 24 Aug 2026, seeded with the
security-payroll UAT and its 21 questions, and registered as a skill in
`keeper_skills`. A recurring 18:30 touchpoint was scheduled telling the agent to
"call `list_decision_sets` first".

No repository code was ever written. No migration file, no repository
functions, no tool definitions, no dispatch cases. `list_decision_sets` did not
exist. The ritual fired on 25 and 27 August against a tool that was not there,
and the 21 questions sat unread because the agent had no way to reach them.

The lesson is the one this doc opens with: **a capability is not shipped when
the data exists. It is shipped when the runtime can reach it.** See
`scripts/capability_matrix.ts`, which now fails CI-style on exactly this.

## Lifecycle

```
   seeded ──▶ open ──▶ (worked through in conversation) ──▶ completed
                │                                              │
                │                                       export_decision_brief
                │                                              │
                ▼                                              ▼
             paused                                       implemented ──▶ closed
```

A **set** is `open | paused | completed | implemented | closed`.

A **decision** is:

| status | meaning |
|---|---|
| `open` | not yet put to him |
| `discussed` | talked through, he has not landed on it |
| `confirmed` | he made the call |
| `routed` | not his call — the client's, a lawyer's (`routed_to` says whose) |
| `skipped` | he passed on it for now |
| `unresolved` | discussed and genuinely cannot be settled yet |
| `implemented` | the code exists |
| `verified` | the code exists and something proves it |

`confirmed`, `routed`, `implemented` and `verified` are *settled* — they no
longer count as remaining. `skipped` and `unresolved` are parked: also not
remaining, but not settled either, and they show up in the brief's unresolved
section.

That distinction is load-bearing at closing time. "Nothing is open" and
"everything is settled" are different facts, and a set whose remaining
questions are all parked satisfies only the first. So `completed` and
`implemented` — which both assert the work is *done* — require
`settled === total`; `closed` only requires nothing actively open; `paused` is
parking and requires nothing. Anything short of that needs `force` **and** a
`closure_reason`.

`discussed` is deliberately not `confirmed`. Talking about a decision is not
making one, and marking one `implemented` because it was discussed is the
failure mode this taxonomy exists to prevent.

## How UAT results become decisions

Seeding is not something the agent does — it answers questions, it does not
invent them. A set is created (by a coding agent working the UAT, or by hand)
with `decisionSets.create` + `decisions.create`, carrying:

- `source_ref` — where the questions came from (`uat/2026-08-20/UAT.md`)
- `repo_owner` / `repo_name` / `export_path` — where the answers go back to
- per decision: `question`, `context`, `options` (JSON `{label, detail}[]`),
  `recommendation`, `priority`, `sort_order`, and optionally `blocked_by`

`blocked_by` names another decision's **ref** (`D-01`), not its id. The queue is
worked in `sort_order`, and `decisions.next()` skips anything whose blocker has
not settled — so a dependent question is never put to him before the one it
depends on.

## How conversational answers are persisted

`record_decision` → `decisions.record()` → the `keeper_record_decision`
Postgres function.

That function exists because recording an answer is two writes — append to
`keeper_decision_history`, then update the row — and the Supabase JS client has
no transaction API. Doing it in SQL makes it one statement and one transaction.
It also gives two properties for free:

- **Idempotent.** A call that would leave every field as it already is returns
  the current row and appends no history, so a retried tool call is safe. The
  comparison is against the *effective* post-`coalesce` values, not the raw
  arguments — a null argument means "leave this alone", so comparing arguments
  gets it wrong in both directions: `update_decision` passes null
  answer/rationale to preserve them (making every retry look like a change), and
  a call touching only `routed_to` would look like a no-op and be discarded.
- **Non-destructive.** The previous answer and its reasoning land in history
  *before* the row is overwritten. Nothing deletes from that table.

On top of that the tool layer refuses to overwrite an existing answer unless
`revise: true` is passed — so a considered answer cannot be blanked by a
careless call, only by a deliberate one.

`update_decision` goes through the same function with `answer` and `rationale`
null, which `coalesce` leaves untouched: it moves state without disturbing what
was decided.

## How briefs are generated

`export_decision_brief` → `src/agent/decisionBrief.ts`.

The brief is deterministic. `generated_at` is in the footer but **excluded from
the content hash**, so re-exporting an unchanged set produces the same hash and
the tool declines to write a new version. That is what makes "has anything
actually changed since the last export?" answerable, rather than every export
looking like new work.

Versions chain through `supersedes_id`, and the full content is stored verbatim
— a coding agent reads exactly what was exported even if a decision is revised
afterwards.

With `commit: true` the brief is also committed to the project's own repo at
`export_path` via `commitFileFor` in `src/deploy/github.ts`. The
unchanged-content short-circuit yields to that: if the existing version was
never committed and a commit is now asked for, the export proceeds to the
commit and records the URL against that same version rather than minting an
identical v+1. Otherwise "export it and commit it" would silently do nothing
until some decision happened to change.

**Exporting does not close the set.** They are separate calls because they are
separate facts.

## How coding agents consume a brief

The brief is markdown with fixed sections: problem/context, confirmed decisions
(each with the reasoning and the options not taken), routed questions,
unresolved questions, implementation constraints, verification requirements,
source references.

Two constraints are stated in every brief and are load-bearing:

- A routed or unresolved question is **not** a licence to pick a default.
- If implementing surfaces a question the brief does not answer, stop and raise
  it rather than deciding it.

Each confirmed decision carries its `D-nn` ref; tests and commits should quote
it so the trail back survives. `link_decision_artifact` then attaches the commit
or PR to the set.

## Adding a future decision-related tool

1. Repository function in `src/db/repositories.ts` under the decision-queue
   section. Multi-write operations belong in a SQL function, not in JS.
2. Tool definition in `toolDefinitions` (`src/agent/tools.ts`). The description
   is the agent's only documentation — state the refusals, not just the
   capability.
3. A `case` in `dispatchTool` in the same file.
4. Add it to `GROUPS` in `scripts/capability_matrix.ts`.
5. Mention it in the system prompt if the agent needs to know it exists
   unprompted. The matrix flags tools with no prompt coverage as a soft gap.
6. Extend `scripts/smoke_decisions.ts`.

## Registering a tool so both chat and scheduler can reach it

There is no separate scheduler tool list. `activeTools()` in
`src/agent/orchestrator.ts` builds one list for every surface — Telegram, web,
proactive touchpoints, nightly reflection — filtering only `web_search` (by
provider) and `present` (web only). So a tool in `toolDefinitions` with a
matching `dispatchTool` case is automatically available to a firing touchpoint.

The failure was never the wiring. It was that the tool the touchpoint named had
no definition and no case at all. Which is why:

```bash
npx tsx scripts/capability_matrix.ts --check   # exit 1 on any runtime gap
```

Run it against the tree as it stood before this feature and it reports seven
`MISSING TOOL REGISTRATION` rows.

## Testing the whole flow

```bash
npm run typecheck
npx tsx scripts/capability_matrix.ts --check
npm run smoke:decisions          # needs SUPABASE_URL + SUPABASE_SERVICE_KEY
```

`smoke:decisions` drives everything through `dispatchTool` — the same entry
point the agent uses — creating a throwaway `smoke-<timestamp>` set and
deleting it (cascade) at the end. Pass `--keep` to inspect the fixture. It never
touches a real decision set.

There is no unit-test framework in this repo, deliberately (see UPDATES.md,
20 Aug). The smoke script is the substitute; if a framework is ever introduced,
its assertions port over directly.
