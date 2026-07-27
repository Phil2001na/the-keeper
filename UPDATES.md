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
