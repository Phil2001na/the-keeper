# Handoff: Keeper "Grok-bot" build — Phase 2 & 3

Paste everything below the line into a new Claude Code session started in
`C:\Users\phili\OneDrive\Documents\projects\personalAI(jarvis)\the-keeper`.

---

You're continuing a build on THE KEEPER (Philip's live personal-AI agent: Railway + Telegram + web PWA,
Supabase project `xusprijhfqeyszkjpyyl`, `keeper_*` tables in `public`). Read `CLAUDE.md` and the top of
`UPDATES.md` first. Philip wants the Keeper to work like his brother's Grok Bot: do things on his accounts
and computer, and only stop to ask him for approval.

## The plan Philip approved (2026-10-13)
1. Cleanups — DONE.
2. Phase 1: start Claude Code on the PC from the phone — DONE and LIVE.
3. **Phase 2: logins without being at the PC** — NEXT.
4. **Phase 3: screenshots + live view** — after Phase 2.

## Status (updated 2026-10-14)
| Phase | Status |
|---|---|
| Cleanups | DONE |
| Phase 1: start Claude Code on the PC from the phone | DONE and LIVE (c0f7066..2218532) |
| Phase 1b: hardening (result always delivered, promise-without-action guard, restart recovery, timeouts, approval expiry, screenshot-failure note, Telegram→web-push fallback) | WRITTEN, TESTED, COMMITTED on branch `pc-bridge-durable-delivery`. **Not merged to `main`, not deployed.** The PC agent still runs the old `agent.mjs` until restarted. |
| Phase 2: logins without being at the PC (hand-over, then vault) | NOT STARTED — no code yet; browser choice still undecided |
| Phase 3: more screenshots + "Watch live" | NOT STARTED (only the finish screenshot from Phase 1 exists) |

Next concrete steps, in order:
1. Merge `pc-bridge-durable-delivery` into `main` (= Railway redeploy, needs Philip's OK), then restart the
   "Keeper PC Agent" scheduled task so the PC runs the new `agent.mjs`.
2. Verify live: start a session, restart nothing, check the ending arrives; then a session with the PC
   asleep → "never picked up" message after 10 min.
3. Still open from Phase 1: verify the Telegram Approve/Deny buttons live (see "Verified" below).
4. Phase 2 step 1: decide the shared browser for hand-over, write it down here, then build it.

## What's live (commits c0f7066..2218532 on `main`)
- **Merge:** the never-deployed local work (LOCK IN, files, Gmail) was merged with the deployed main. The
  deployed decision queue (#9) was kept because it matches the live tables. Pre-merge backup: branch
  `backup/wip-2026-10-13` (also on GitHub).
- **Web token rotated** to 32 chars on Railway (`KEEPER_WEB_TOKEN`). The value is in
  `C:\Users\phili\keeper-web-token.txt`. Never print it in chat.
- **PC bridge (Phase 1):**
  - `src/web/pcBridge.ts`: in-memory relay under `/pc/*`. The PC only calls OUT. Agent auth is
    `X-Agent-Token` = `REMOTE_BROWSER_TOKEN`; viewer routes use the web token. Routes: `/pc/agent/poll`
    (long-poll: projects in → jobs/decisions/stops out), `/pc/agent/event`, `/pc/state`, `/pc/start`,
    `/pc/approve`, `/pc/stop`, `/pc/shot/<jobId>-<at>`.
  - `src/web/pcNotify.ts`: steps go to web step chips; start and finish go to the chat as messages
    (source `inbound:pc`, so web push does not double-buzz) and are logged to `keeper_interactions` with
    `trigger pc:<id>`.
  - `src/telegram/bot.ts` `attachPcToTelegram()`: Approve/Deny inline buttons
    (`callback_data pc:y|n:<approvalId>`), plus start and finish pings with the finish screenshot.
  - Tools in `src/agent/tools.ts`: `start_claude_session`, `claude_sessions`, `stop_claude_session`. There
    is a prompt section "Claude on his PC" in `systemPrompt.ts`.
  - `pc-agent/agent.mjs`: Claude Agent SDK `query()` in the project folder, `settingSources`
    user/project/local, `permissionMode 'auto'` (only risky actions ask). Projects listed under `strict`
    in `pc-agent/projects.json` (EDU REFACTOR) use `'default'`. `canUseTool` → approval event → phone →
    decision. Allowlist = every folder under the projects root, minus `exclude`. Max 2 parallel sessions.
    It takes an ffmpeg screenshot at the finish.
  - Auto-start: Windows scheduled task **"Keeper PC Agent"** (`pc-agent/install-autostart.ps1`). Log is
    in `pc-agent/logs/agent.log`.
  - Local test without touching prod: `scripts/pc-harness.ts` (a test relay on :8787 that auto-approves
    the first request and denies the second), plus `KEEPER_URL=http://localhost:8787` and
    `PC_AGENT_CONFIG=<test projects.json>` when running the agent.

## Verified
- Local harness: approve let the write through, deny blocked the `rm`, Claude reported the denial
  honestly, and the screenshot arrived.
- Live job a25ee4cf: start → steps → summary → screenshot in about 45 seconds. No Telegram errors.
- **NOT verified live: the Telegram Approve/Deny buttons.** Auto mode judged the test safe and never
  asked. Do this first: have Philip text the Keeper something risky (for example, have Claude send a
  test email) and confirm the buttons work, including the edited "✅ Approved" state.

## Gotchas learned the hard way
- **Defender (AMSI) blocks PowerShell System.Drawing screen capture as "malicious".** Do not try to
  evade it; use ffmpeg `gdigrab` (already wired in). Keystroke-injection scripts (SendKeys) may get
  flagged the same way. Check before you build on them.
- A locked PC captures as the lock screen. Sessions still run.
- Write `projects.json` with a JSON serializer. A heredoc wrote single backslashes and the agent exited
  on boot with code 1.
- Never run `npm run dev` / `npm start` locally: two Telegram pollers fight (409) and knock the live
  bot offline. Use the harness or `npm run ui`.
- Push to `main` = Railway redeploy (about 5–10 minutes; the old instance serves until then). Check
  `railway deployment list --service the-keeper`.
- Bridge state is in memory. A Railway restart drops jobs, and the agent stops orphaned sessions.
- Philip's PC was very low on memory (~0.9 GB free). Background shells can be reaped.

## Phase 2 to design and build: logins without being at the PC
Grok's model (researched): for login/2FA/payment it **hands the live screen to the human**, who types
the password themselves, and it can fill from 1Password **with per-fill approval**. The agent never
sees the password. Build the same two things:
1. **Hand-over (do this first).** When a session hits a login wall, Philip gets a Telegram link to a
   live view of that browser, types the password on his phone, and the session continues. The existing
   remote browser (`src/web/remoteBrowser.ts` + `remote.html`, `/rb/*`, PC side = job-scout
   `remote_agent.mjs`, per-session key in the Telegram link) already does phone → PC browser input. Open
   design question: Claude sessions drive Philip's real Chrome (claude-in-chrome) or Playwright, while
   the remote browser is a separate headless Chrome profile, so cookies are not shared. Pick one browser
   both can use (for example, the session drives the remote-browser Chrome over CDP), or make the
   hand-over open the session's own browser. Decide, then write it down.
2. **Vault with per-fill approval.** Passwords are stored encrypted on the PC (Windows Credential
   Manager / DPAPI) and entered once through a local prompt. Expose a fill action to sessions, with no
   read action. Every fill goes through the **existing approval channel** ("Fill your Gmail password?
   Approve"). The secret must never enter Claude's context, the relay, chat, or logs. Before filling,
   check that the target page/window is the expected site.
- Two-factor codes are always a hand-over.

## Phase 3 after that
- More screenshots in the chat timeline (on key steps, not just the finish).
- A "Watch live" button that opens the live view of the browser the session is using.
- Full-desktop live view only later, if Philip wants it, and gated hard.

## Rules (from Philip's global CLAUDE.md)
- **EDU REFACTOR is his main income and is live prod.** Flag and stop before schema changes, data
  deletes, prod DB access, pm2 restarts in business hours, or Apache config. Keep it `strict`.
- Do things yourself instead of handing him manual steps. Pause only for approval on sends, deletes,
  payments, prod, and deploys of big behaviour changes.
- Add a dated entry to the top of `UPDATES.md` (`## YYYY-MM-DD HH:MM`) for every meaningful change.
- Talk to Philip in plain language: short sentences, lead with the point.
- Never print secrets (web token, REMOTE_BROWSER_TOKEN) in chat.
