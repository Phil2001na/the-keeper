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
npm run ui             # UI preview on :5173 (token 1234) — canned data, no bot
npm run icons          # regenerate PWA icons + iOS splash screens
npm run typecheck
```

## The web surface (`src/web/`)

An installable PWA with no build step: `ui.html` + `app.css` + `app.js` served as
separate public routes by `server.ts`, which holds them in memory and ETags them.

- **Never use `npm run dev` to work on the UI.** It starts the Telegram long-poll,
  which fights the live Railway instance for the bot token and knocks the real
  Keeper offline. Use `npm run ui` — same files, canned data, no agent.
- **The service worker version is a hash of the shell**, stamped into `sw.js` at
  boot by `loadStatic()`. That's the only reason a deploy reaches installed
  clients, so don't "simplify" it to a constant.
- `/events` and `/send` are explicitly excluded from the service worker; routing
  SSE through a fetch handler breaks streaming.
- **The whole palette derives from one hue in OKLCH.** `app.js` solves
  `--accent-l` per hue so white text on the accent always clears 4.5:1 — a fixed
  lightness looks broken on half the hue circle. Don't hardcode colours in
  components; use the tokens at the top of `app.css`.
- **`--glass` (0–100) drives every translucent surface** — bubbles, cards,
  their rims and sheen. Two constraints are load-bearing: the accent bleed is
  multiplied by `--chroma` so the mono preset stays grey, and `--ub-a` (the user
  bubble's alpha) is solved in `app.js` because a translucent *light* accent
  darkens toward the field and would eat the dark-text contrast solved above.
  Glass also lightens as it thins — alpha alone reads as a hole, not as glass.
- **The ambient field is one fixed design, not a set of modes.** Five blooms,
  each animating `.bloom` *and* `.bloom::before` on coprime periods (14/17,
  19/23, …) so the combined cycle is hours long and never visibly repeats —
  that's the only reason the paint lives on the pseudo-element, so don't
  collapse it back onto `.bloom`. The deformation is non-uniform `scale()`,
  which composites; `border-radius` or `filter` would not.
- **How fast the field plays is the agent's pulse, and it lives in `app.js`
  (`pulseField`), not in CSS.** Idle sits at 1×; a turn surges it to 1.5–6.5× in
  randomised bursts, kicked again on every real activity step, then eases back.
  Speed is changed via `animation.playbackRate` — never by rewriting
  `animation-duration`, which re-maps a running animation's progress and makes
  the whole field jump. Under `prefers-reduced-motion` the blooms have no
  animations, so the pulse is a silent no-op by construction.
- **`backdrop-filter` is fenced twice**: `data-glass=off` below a threshold,
  and only on `#stream`'s last 4 children. A long transcript would otherwise
  stack dozens of blur layers and drop frames on mobile.
- Icons and splash screens are **generated** (`npm run icons`), not hand-made.
  Edit the constants in `scripts/gen-icons.ts` and re-run.

### Notifications (`src/web/push.ts`)

Web Push is what lets the Keeper interrupt him here rather than only on Telegram.

- **It only pushes turns the agent started itself.** `bus` message events carry a
  `source`; anything `inbound:*` is a reply he asked for and is deliberately
  silent. That one line in `attachPushToBus` is the whole notification policy.
- The **VAPID keypair is stored** in `keeper_settings`, minted on first boot if
  absent. Never regenerate it casually — a subscription is bound to the key that
  created it, so a new pair silently unsubscribes every installed device. Env
  (`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`) overrides the stored pair.
- Subscriptions are disposable: a 404/410 from the push service means gone, and
  we prune. The page re-registers on every boot, which is what covers endpoint
  rotation — there's no `pushsubscriptionchange` handler.
- The service worker does **not** notify when a window is already visible (it
  hands the payload to the page instead); `force: true` overrides that, and only
  the "send a test" button sets it.
- `npm run ui` serves real push too, with an ephemeral keypair. It also exposes
  `POST /api/push/reachout?in=8` — fires a proactive push after a delay so you
  can close the tab and see what an actual reach-out looks like.

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
