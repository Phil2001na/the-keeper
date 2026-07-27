# THE KEEPER — AI / developer guide

Proactive personal-AI agent, live over Telegram (+ an experimental web surface). See `README.md`
for the full architecture (memory layers, nightly reflection, proactive scheduling) — this file
is just the operational quick-reference.

## Stack

- **Node.js + TypeScript** (`tsx`), one agentic loop on **Claude (Anthropic SDK)**, with Gemini
  (`@google/genai`) as an available/fallback model.
- **Telegram** bot (`node-telegram-bot-api`) as the primary surface; MCP server
  (`@modelcontextprotocol/sdk`, `src/mcp/server.ts`) exposes Keeper's tools to Claude Code itself
  (this is the `the-keeper` MCP server registered globally).
- **Supabase** — facts/domains/goals/observations/digests tables, full-text-searchable archive.
- **Google APIs** (`googleapis`) — Gmail + Drive OAuth integration (see
  [[keeper-google-integration]] memory for redirect_uri / port-3000 gotchas).
- Deployed on **Railway** (`railway.json`) — this is the live, running instance real reminders
  and reflections depend on.

## Commands

```bash
npm install
npm run dev           # tsx watch src/index.ts — local dev with reload
npm start              # tsx src/index.ts — no watch
npm run seed           # tsx src/seed/seed.ts
npm run google-auth    # tsx scripts/google-auth.ts — re-run Gmail/Drive OAuth flow
npm run mcp            # tsx src/mcp/server.ts — start the MCP server standalone
npm run typecheck
```

## Conventions / gotchas

- This is a **live production agent** — Philip's actual Telegram bot. Changes to the
  reflection/scheduling loop or memory-write tools affect a real running instance on Railway,
  not a sandbox. Be careful with anything that touches `schedule_touchpoint`, `remember_fact`,
  or the nightly reflection cadence.
- The conversation window is **anchored, not sliding** — don't "fix" apparent duplication or
  length by truncating it; that's the design (prompt-cache-friendly continuity).
- Cost tracking (`sys.turn` observations) is load-bearing for `/status` — don't remove without
  replacing.

## Conventions

- Log every meaningful change to `UPDATES.md` — newest entry at top.
