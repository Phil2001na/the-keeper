# THE KEEPER

A proactive personal life-management agent that lives over Telegram. It knows your life, holds your context, and reaches out **on its own schedule** — not on a fixed timer. After every exchange it decides when it should next surface and why, and writes that decision to its own memory.

The intelligence isn't in any trigger. It's in what the agent decides to schedule for itself after every interaction.

---

## How it works

One agentic loop (Claude Sonnet). The database is the agent's hands. The same loop serves both:
- **Reactive** — you text it on Telegram.
- **Proactive** — a touchpoint it scheduled for itself comes due and a lightweight scheduler wakes it.

```
Telegram message ─┐                              ┌─→ remember_fact / forget_fact
Due touchpoint ───┼─→ runAgent (Sonnet + tools) ─┼─→ schedule_touchpoint (its own next move)
Nightly reflection┘                              └─→ reply  /  stay_silent  /  write_journal
```

### Signature ability: it grows with you
Its sense of your life isn't fixed to a hard-coded list of areas. If you bring up something that doesn't fit an existing sector — a new business, an interest, a person — it **asks** whether you'd like it to start tracking that area. On a yes, it creates the sector (a row in `domains`) and manages it like any other: storing facts, scheduling check-ins.

### Memory in three layers
1. **Facts & sectors** — its distilled working model of your life (`keeper_facts` / `keeper_domains`).
2. **Recent conversation** — the last N messages, in context every turn.
3. **The archive** — *everything ever said*, full-text searchable via its `search_history` tool. It never has to say "I don't remember" without actually looking.

### An inner life: nightly reflection + journal
Once per evening (`REFLECTION_HOUR`, default 22:00) it wakes privately — no message to you. It reviews the day, consolidates and prunes facts, retunes sector cadences, checks how its recent reach-outs landed (did you reply or leave them on read?), optionally glances at unread email for tomorrow, and writes a short **journal entry**. The latest entries are folded back into its system prompt — continuity of self across days.

### It learns whether its proactivity lands
Every fired touchpoint records an outcome — `sent`, `silent`, or `replied` (you answered within a few hours). Reflection reads the 7-day stats and adjusts when and why it reaches out.

### Eyes on the world
It has Anthropic's server-side **web search** — live news, prices, docs, weather — used naturally mid-conversation, no extra API key.

### Boundaries
- **Quiet hours** (default `23:00–07:00` Africa/Windhoek): no proactive messages overnight. Touchpoints that come due in the window simply fire once it passes. You can still text it anytime.
- **Silence is allowed.** If a due touchpoint isn't worth interrupting you, it stays silent (and usually schedules a better next one).

---

## Stack
- TypeScript on Node 20+, run with `tsx` (no build step locally).
- Claude Sonnet (`claude-sonnet-4-6`) via `@anthropic-ai/sdk`, with tool use.
- Supabase (Postgres) for memory.
- Telegram via `node-telegram-bot-api` (long-polling locally).

---

## Project layout
```
src/
  index.ts              entry: starts Telegram + scheduler (config validates env on boot)
  config.ts             env + timezone/quiet-hours helpers
  db/
    client.ts           supabase client
    repositories.ts     typed CRUD: domains, facts, touchpoints, interactions
  agent/
    orchestrator.ts     runAgent() — the tool-use loop (inbound / touchpoint / reflection)
    systemPrompt.ts     character (cached block) + live memory snapshot
    tools.ts            tool defs + dispatch (incl. server-side web search)
    reflect.ts          nightly reflection — consolidate memory, write journal
  telegram/bot.ts       long-polling listener, typing keepalive, bubble replies, /status
  scheduler/dueCheck.ts due-check interval with quiet-hours gate + reflection trigger
  seed/seed.ts          idempotent: core sectors + neutral facts + first contact
migrations/
  001_init.sql           schema
  002_memory_depth.sql   full-text search archive, journal, touchpoint outcomes
```

### /status
Text the bot `/status` for an instant ops snapshot (uptime, model, next reach-out, last journal day, which integrations are live) — answered locally, no tokens spent.

---

## Morning setup checklist (wiring the keys)

1. **Install deps**
   ```
   npm install
   ```
2. **Supabase project** → create one at supabase.com. In the SQL editor, paste and run `migrations/001_init.sql`. Confirm 4 tables: `domains`, `memory_facts`, `touchpoints`, `interactions`.
3. **Env** → `copy .env.example .env` (PowerShell: `Copy-Item .env.example .env`) and fill in:
   - `ANTHROPIC_API_KEY` — your key.
   - `TELEGRAM_BOT_TOKEN` — from @BotFather.
   - `TELEGRAM_OWNER_CHAT_ID` — message your bot once, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `result[].message.chat.id`.
   - `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` — Project Settings → API → URL + **service_role** key.
4. **Seed**
   ```
   npm run seed
   ```
   Adds the core sectors, neutral facts (projects + the music), and a first-contact touchpoint ~2 min out.
5. **Run**
   ```
   npm run dev
   ```
   Within ~a minute (outside quiet hours) it sends you its first Telegram message. Reply and it's alive.

> Note: nothing sensitive (health/personal) is seeded — you tell it those in conversation and it remembers.

---

## Verifying it works
- **First contact:** after `npm run dev`, you get an opening message; check `interactions` for an `agent` row and `touchpoints` for a fresh `pending` next one.
- **Memory:** tell it something (e.g. "deadline for Dog Force is Friday") → check `memory_facts` updates.
- **Dynamic sector:** say "I'm starting a sneaker resale business." It should *ask* before tracking it; on yes, a new `domains` row appears.
- **Quiet hours:** insert a touchpoint with `fire_at` inside 23:00–07:00 Windhoek → it won't fire until 07:00.
- **Silence:** a low-value due touchpoint can end with no message sent (touchpoint still marked `fired`).

---

## Deploying later (Railway / similar)
- Push to GitHub, connect the repo, set the same env vars in the host's dashboard.
- Start command: `npm start`. It's a long-running process (Telegram polling + scheduler), so use a **worker/service**, not a serverless function.
- Long-polling works on Railway as-is. To switch to a webhook, replace the `polling: true` setup in `src/telegram/bot.ts` with `bot.setWebHook(...)` and an Express endpoint — the agent code doesn't change.

## Deferred (future)
- Vector/semantic recall (full-text archive search covers most of it; embeddings only if FTS misses become common).
- Haiku for cheap extraction/classification (currently folded into Sonnet's tool calls).
- Google Calendar tools (needs a one-time re-auth with the calendar scope).
- Multi-user (currently single owner).
