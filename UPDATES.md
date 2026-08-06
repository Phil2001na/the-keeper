## 2026-08-06 00:55
- Added a new "elysium" backdrop theme to the web UI's Settings > space picker (`galaxy-elysium.png`, cropped from the user's sunset floating-city artwork) alongside the existing "deep field" and "gargantua" backdrops — swappable from the same UI. Since it's an already-warm photo rather than desaturated dust, gave it its own lighter filter/blend in `app.css` instead of reusing the mono-galaxy grayscale+color-blend treatment, so the sunset palette survives.
- Made picking "elysium" a full takeover per feedback (deep field / gargantua stay backdrop-only, colors untouched): selecting it now also swaps the accent hue/spread/chroma/tint/glass to a matching warm-gold palette (`ELYSIUM_THEME` in `app.js`), so bubbles, blooms and the accent gradient all shift to match the artwork instead of just sitting behind unrelated colors.

## 2026-08-05 (time not specified)
- Added `plan_errand_route` tool (`src/agent/route.ts`, wired in `src/agent/tools.ts`), ported from EggRun's delivery route-planner (`egg-delivery/src/lib/route.ts`): nearest-neighbour stop ordering when coordinates are known, plus Google Maps / Apple Maps deep links falling back to address text when they aren't. Closes the System Self-Improvement note `eggrun_route_planner_integration_request` — lets morning briefs turn a list of errands into an ordered plan with tap-to-navigate links.
- Simplified `plan_errand_route` per feedback: dropped lat/lng input, nearest-neighbour ordering, and Apple Maps — it now just takes place names in the order mentioned and builds one Google Maps directions link, letting Google Maps own the actual routing.

## 2026-08-03 12:57
- 13:40 — Fixed GPT-5.6 Luna tool calls being rejected by the Chat Completions API: Keeper now automatically disables reasoning effort only when function tools are included.
- Added durable follow-ups for active open loops: default five-day check-ins are scheduled with each watched thread.
- Closing or rescheduling a thread now cancels or replaces its matching nudge, preventing stale reminders.

## 2026-08-03 11:08
- Added a direct OpenAI provider for GPT-5.6 Luna with high reasoning, preserving Keeper's existing tool loop.
- Documented the OpenAI environment settings required for deployment.

## 2026-08-03 01:45
- Removed the galaxy transparency control and restored both backdrops to their tuned fixed visibility.
- Added palette-aware zoom controls and a full-size lightbox for both Settings backdrop previews.

## 2026-08-03 01:01
- Added persisted galaxy backdrop selection and transparency controls to Settings.
- Added a star-dense Gargantua backdrop and cached both space choices for offline PWA use.

## 2026-08-03 00:47
- Replaced the procedural star pattern with a project-local photographic galaxy backdrop, keeping the conversation lane dark and recolouring the image through the selected liquid palette.
- Added the galaxy asset to the offline PWA shell so installed clients retain the full atmosphere without a network connection.

## 2026-08-03 00:24
- Reworked the live web activity rail into one smoothly transitioning, tool-aware status pill, with branded Drive/Gmail marks and palette-consistent SVGs.
- Refined the existing liquid atmosphere with a restrained stellar layer and conversation-lane vignette; both inherit the selected palette instead of locking the UI to purple.

## 2026-08-03 00:37
- Simplified the shared Kantewa Drive pack to the two chronological affidavits only; the other pack copies were moved to Drive Trash (original source records remain unchanged).
- Rewrote the unsent Jada draft to attach only the initial estimate/impact document, link the affidavits, and offer the fuller prepared evidence on request.

## 2026-08-03 00:22
- Used the existing evidence tracker to add a plain-language summary of Philip's physical, social, creative and continuity-of-care impacts to the front damages document, Drive copy and unsent Jada draft.

## 2026-08-03 00:18
- Added the loss of gym/exercise to the local and Drive damages summaries and the unsent Jada draft, framed as a documented daily-life impact caused by fear of aggravating jaw pain and clenching.

## 2026-08-03 00:13
- Rewrote the two front documents and the unsent Jada email in Philip's plain first-person voice: they now present the facts, acknowledge uncertainty, and ask Jada for guidance instead of adopting legal-counsel language.

## 2026-08-03 00:07
- Revised the counsel-review damages schedule and Gmail draft: removed the Mentzel estimate and recovery-income claim, added the N$30k surgeon quote, CT/CBCT estimate, N$35k vocational-impact entry, and affidavit context.
- Preserved a pre-edit desktop backup of the damages schedule; the revised local document and Drive schedule were content-checked, and the Gmail item remains an unsent draft.

## 2026-08-02 23:11
- Prepared two attachable counsel-review documents (damages schedule and evidence index) on Philip's Desktop, and created an unsent Gmail draft to Jada Guriras linking the organised Drive pack.
- Confirmed the local DOCX files pass structural checks; visual rendering could not run because the bundled renderer's `pdf2image` dependency is unavailable on this machine.

## 2026-08-02 23:05
- Created a non-destructive Google Drive counsel-review pack for Kantewa v Kayone: organised copies of 17 source records into clinical, costs, affidavit, and personal-impact folders.
- Added a proposed N$1.3m damages schedule and evidence index, both explicitly marked as working documents for Jada Guriras's legal review; the conflicting older quantum estimate was preserved but excluded.

## 2026-08-01 00:00
- Gave Keeper write access to Google Drive: `create_drive_file` and `update_drive_file` tools (backed by new `createDriveFile`/`updateDriveFile` in `src/integrations/drive.ts`), alongside the existing read-only `list_drive_files`/`read_drive_file`. The OAuth scope was already the full `drive` scope (`scripts/google-auth.ts`), so no re-auth is needed. Unlike email, there's no drafts-folder equivalent for Drive writes — the system prompt tells the agent to go ahead when asked to save/update a file but not to overwrite files unprompted.

## 2026-07-30 01:05
- Design decision: dropped the atmosphere customisation. No more five motion modes and no motion-speed slider — the field is now one thing: the liquid five-mass gradient at a fixed moderate tempo (periods retuned to 14–29s from liquid's 19–41s). Settings keeps palette + hue/spread/intensity/glass only; `data-motion`, `--motion-speed` and the dead `.segmented` / drift-hue machinery are gone.
- Speed is now the agent's pulse instead of a preference. Idle plays at 1×; a turn surges to 1.5–6.5× in randomised bursts (new interval each burst) and every real activity step punches it to 6.5× before it drops back into the random cycle, so the swooshing tracks work actually happening. Turn end eases it back to 1× over ~2.5s. The blooms also brighten ~25% while busy.
- The rate is driven through `animation.playbackRate` from `app.js`, not by dividing durations in CSS: an animation's progress is elapsed time over duration, so re-timing one mid-flight teleports it to a different point in its cycle and the whole field visibly jumps. Under `prefers-reduced-motion` the blooms have no animations, so the pulse no-ops with no extra check.
- Verified in a real browser at 430×900: 10 animations resolve at the new durations, idle rate pinned at 1.00, a canned turn ramps 1.0 → 6.48 with a visible mid-turn dip and decays cleanly back to 1.00, bloom opacities go 0.5/0.42/0.24/0.28/0.22 → 0.62/0.54/0.34/0.38/0.31 and back, no console errors.

## 2026-07-30 00:00
- Added two new theme axes to the settings sheet: **glass** (0–100) and **motion speed** (0.25×–4×). Glass thins bubbles, cards, their rims and top-edge sheen, and lets the ambient field bleed through them — so moving the hue now visibly washes through the transcript instead of only repainting the accents. Speed divides every ambient keyframe duration, so the gradients can go from glacial to obvious.
- Two constraints in the glass math are load-bearing: the accent bleed is multiplied by `--chroma` (verified: at full glass the mono preset sits at chroma 0.019 vs nebula's 0.075, i.e. stays grey), and `--ub-a` is solved in `app.js` rather than CSS — thinning a *light* accent drags it toward the dark field and would eat the contrast of the dark text `solveAccent` picked for those hues. Glass also lightens as it thins (17%→25.5%); alpha alone reads as a hole rather than as glass.
- New **liquid** atmosphere mode: five masses on composed dual-frequency motion. The paint moved from `.bloom` to `.bloom::before` so each mass can carry two animations at once, on coprime periods (19/23, 27/31, 22/29, 25/37, 33/41) — the combined cycle is hours long, so it never visibly loops. Deformation is non-uniform `scale()` because that composites; `border-radius` wouldn't. b3–b5 run brighter here since the field's centre was where glass had nothing to reveal.
- `backdrop-filter` is fenced twice — `data-glass=off` below a threshold, and only `#stream`'s last 4 children — which is what makes blur affordable on the bubbles that previously refused it outright.
- Verified in a real browser at 430×900: all 10 liquid animations resolve with correct durations and both layers measurably move; speed 4× → 4.75s and 0.25× → 76s; the fence blurs only the last 4; all five modes behave (still/reactive animate nothing and hide the speed slider, aurora is byte-for-byte its old self); glass/speed/motion persist across reload and survive a preset click. Typecheck clean, no console errors.

## 2026-07-29 10:45
- Gave the web surface real notifications, so proactive reach-outs no longer depend on Telegram. Added `src/web/push.ts` (Web Push over VAPID, `web-push` dependency), `migrations/007_web_push.sql` (`keeper_push_subscriptions` + a small `keeper_settings` k/v store, both RLS-on with no policies like every other `keeper_*` table), four `/api/push/*` routes behind the existing token, and `push`/`notificationclick` handlers in `sw.js`. Migration applied to the live Supabase project.
- The notification policy is one line: it pushes only turns the agent started itself. `bus` message events now carry a `source`, and anything `inbound:*` is a reply he asked for — no buzz for a web reply he's watching arrive, none for a Telegram reply Telegram already delivered.
- The VAPID keypair is minted on first boot and stored in `keeper_settings`, so this works on deploy with no dashboard step. It must not be regenerated casually: a subscription is bound to the key that made it, so a new pair silently unsubscribes every device. `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` override it if ever needed.
- Settings sheet gained a notifications section (permission states, iOS "install first" hint, and a "send a test" that shows a real notification even with the app on screen). `app.js` re-registers the subscription on every boot, which is what covers endpoint rotation; sign-out now unsubscribes the device. Added a generated `badge-96.png` for the Android status bar.
- Verified end-to-end against a fake TLS push service: the VAPID JWT verifies against our own public key, and the RFC 8291 payload decrypts back to byte-identical plaintext. In a real browser: subscribe → FCM works, a proactive push with the app closed renders the notification, the same push with the app visible stays silent and is handed to the page, and a 410 prunes the dead subscription.

## 2026-07-29 01:00
- Made the web surface an installable PWA. Added `src/web/manifest.webmanifest` and `src/web/sw.js`, plus `scripts/gen-icons.ts` (`npm run icons`) — a dependency-free PNG encoder that renders the orb mark into 6 icons and 21 iOS launch images (1.7 MB, regenerate rather than hand-edit). `src/web/server.ts` now serves the shell, `/app.css`, `/app.js`, `/sw.js`, the manifest, `/icons/*` and `/fonts/*` as public routes with ETags, and stamps the service worker's `VERSION` with a hash of the shell — that hash is what makes a deploy actually push an update to installed clients. Caching: `/events` and `/send` bypass the worker entirely, navigations are network-first, `/api/snapshot` keeps its last good response so the transcript and mind drawer stay readable offline (flagged stale). Offline is read-only by design — no queued sends.
- Redesigned the whole interface against the concept in `Pictures/jarvis/concept ui.jpeg`. Split the old single `ui.html` into `ui.html` / `app.css` / `app.js` (still no build step) and rebuilt every surface: glass bubbles with an orb avatar byline, gradient user bubbles, the activity rail, all 9 `present` card blocks, the composer, both sheets, gate and toast. Self-hosted Inter Variable (47 KB, `src/web/fonts/`) so type works offline.
- Added a settings sheet with a live theme engine: 6 presets, hue / gradient-spread / intensity sliders, and four atmosphere modes (still, aurora, drift, reactive). The palette is derived in OKLCH from one hue, and `app.js` solves the accent's lightness per hue so white text on it always clears 4.5:1 — verified across the full hue circle. Theme is persisted and applied pre-paint, and syncs `<meta name="theme-color">`.
- Added `scripts/ui-preview.ts` (`npm run ui`, token `1234`) serving the real files against canned data. Use this instead of `npm run dev` for UI work — `npm run dev` starts the Telegram long-poll and fights the live Railway instance for the bot token.

## 2026-07-28 23:40
- Diagnosed the "(something glitched on my end)" reply as Gemini's prepay credits running out (`429 RESOURCE_EXHAUSTED`) — Railway had `MODEL_PROVIDER=gemini` + `MODEL=gemini-3.5-flash` set from the 2026-07-01 Anthropic-credits-empty stopgap, unrelated to the Drive-PDF fix below. Anthropic credits are funded again, so switched Railway back to `MODEL_PROVIDER=anthropic` and removed the stray `MODEL` override (falls back to `claude-sonnet-4-6`). Redeployed — clean startup, no errors.

## 2026-07-28 23:10
- Applied migration `006_semantic_search.sql` to the live Supabase project (`xusprijhfqeyszkjpyyl`) — pgvector column + `match_interactions()` RPC now exist; semantic search from the 22:40 entry is live.
- Fixed `read_drive_file`/`readDriveFile` (`src/integrations/drive.ts`) silently refusing PDFs ("I can only read text, Docs, Sheets, and Slides") — found via a real chat where the agent couldn't read files in a Google Drive folder. PDFs are now downloaded and run through the same `pdf-parse` text extraction (`extractPdfTextFromBuffer`) already used for Telegram-uploaded PDFs over the native-vision size limit. Typecheck clean.

## 2026-07-28 22:40
- Finished wiring the dangling `src/integrations/embeddings.ts` (Gemini `text-embedding-004`) that was left uncommitted/unused since 2026-06-25: added migration `006_semantic_search.sql` (pgvector column on `keeper_interactions` + `match_interactions()` RPC), `interactions.log` now fires-and-forgets an embed-and-update after insert, and `interactions.search` runs FTS + semantic in parallel and merges (FTS first, semantic fills gaps), falling back to FTS-only with no Gemini key. Typecheck clean.

## 2026-07-23 (time not specified)
- Fixed `blank_error_handling_rule` from the `self_improvement` self-improvement log: `src/agent/orchestrator.ts` used to show a "(hm, i blanked for a second there — say that again?)" placeholder whenever the model returned no text on an inbound turn. Now the tool-use loop (`attemptTurn`) is retried silently up to 2 extra times on a blank inbound response before falling back; if still blank after retries, the agent goes silent rather than surfacing any meta-talk about the failure. Typecheck clean.

## 2026-07-01 12:30
- Disabled the in-process nightly reflection trigger in `src/scheduler/dueCheck.ts` (commented out, not deleted) — Anthropic API credits are empty, so reflection moved off pay-per-token infra.
- Added 6 missing MCP tools to `src/mcp/server.ts`: `forget_fact`, `update_domain`, `write_journal`, `update_portrait`, `watch_thread`, `update_thread`, plus read tools `read_portrait`/`list_threads`. Repositories already supported all of these — just needed exposing. Typecheck clean.
- Created a `RemoteTrigger` cloud routine ("Keeper nightly reflection", `trig_01Ua98dqcBkH4S39e4vi1WL4`) that runs nightly at 20:13 UTC (22:13 Windhoek) on the Claude subscription, connecting directly to the Supabase project via the Supabase MCP connector's `execute_sql` and replicating the `reflect.ts` steps (consolidate facts, goals/numbers, watch threads, revise portrait, write journal) in raw SQL against `keeper_*` tables. Re-enable `dueCheck.ts`'s local reflection and disable this routine once Anthropic credits are topped up again — don't run both (duplicate nightly journal writes are harmless due to the upsert guard, but wasteful).
- Seeded a new `keeper_threads` row "Windhoek hackathons watch" (14-day `next_check` cadence, domain `work`) so the reflection routine's WATCH step does a periodic hackathon scan and Telegram-notifies only on a genuine hit — replaces a standalone bi-weekly `RemoteTrigger` ("Windhoek Hackathon Scanner", `trig_01HoRHE6Z1i1W3ntqa5hpN1L`) which is now disabled (not deleted — no delete action in the RemoteTrigger tool).

## 2026-06-25
- Added semantic (vector) search to conversation memory using Gemini `text-embedding-004` and pgvector.
- Embeddings are generated fire-and-forget on every interaction write; search_history now runs both semantic and FTS in parallel and merges results, with graceful fallback to FTS-only if no Gemini key.
