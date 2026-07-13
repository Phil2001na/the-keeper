-- 005_statement_recon — deterministic statement reconciliation + line dedup
--
-- Backs the log_statement tool: batch-log a parsed bank statement's
-- transaction lines plus its stated closing balance, skip lines already
-- logged (re-pasted or overlapping statements), and verify prior
-- balance.main + this period's net flow against the new stated balance
-- in code — not in the model's head.

alter table keeper_observations add column if not exists external_ref text;

-- Plain (non-partial) unique index: Postgres never treats two NULLs as
-- equal in a unique index, so chat-sourced rows (external_ref left null)
-- are unaffected — only statement lines, which always set external_ref,
-- are deduplicated.
create unique index if not exists keeper_observations_external_ref_uq
  on keeper_observations(external_ref);
