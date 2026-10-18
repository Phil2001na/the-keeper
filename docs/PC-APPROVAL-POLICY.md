# PC-agent policy: bypass-money-edu-v2

Philip explicitly authorized non-spending bypass on 2026-10-17.

## Coverage

**Strict EDU exception:** every EDU production action requires explicit Philip approval for the concrete action, including non-spending actions. All strict-project tools ask, including reads and opaque tools. Recognizable EDU targets in other projects also ask. This exception takes precedence over general bypass; never retry denied or expired actions through another engine, tool, script or worker. Money, security challenges and existing production safeguards remain mandatory.

All PC roles (solo, persistent, Prime and crew workers), Claude and Codex share
this policy on each new/resumed turn. Messages/email, forms/applications,
publishing/deployments, deletion, account changes, arbitrary shell/browser/desktop
actions, unknown tools and edits outside the project no longer require a policy
approval. Claude retains its every-tool PreToolUse hook, automatically allowing
non-spending calls outside the strict/EDU exception. Codex uses untrusted command review with automatic non-spending
decisions and danger-full-access filesystem/network execution. This is deliberate:
keeping the review channel permits explicit spending escalation.

Purchases, payments, subscriptions, paid bookings/upgrades, donations, money
transfers, order placement and other commitments spending Philip's money require
explicit approval for the concrete transaction, merchant/payee, total/currency and
recurring charges. Denied, expired or aborted spending must not be retried through
another tool or worker. Existing relay expiry/reconnect/delivery rules are retained.

## Limits

This is broad autonomy with a spending instruction and best-effort monetary keyword
interception, NOT a financial security boundary. Generic scripts, browser coordinates,
encoded commands, tool aliases or trusted engine commands can spend without a
recognizable signal. Agents MUST explicitly request approval before these spending
steps. Keywords can also prompt unnecessarily (for example subscription management).
No tool-name classifier can guarantee both zero non-spending prompts and zero
unapproved spending. Native engine/organization restrictions can still refuse work;
unsupported approval RPCs fail closed. This does not change other Codex sessions,
OS privileges, bank/merchant controls or Railway's main Keeper tool permissions.

Project EDU safeguards remain mandatory (schema/data/prod DB operations, business-hour
pm2 restarts and Apache changes require flagging and approval). Missing credentials,
2FA and security challenges still require Philip. Existing running turns retain
old instructions until finished; resumed/new turns get the updated brief. Old context
may contain old policy, explicitly superseded in the new brief. Paid AI usage already
incurred by ordinary agent execution is not mediated as a merchant transaction;
new paid services/upgrades/usage commitments require approval.

## Validation and activation

Unit tests exercise non-spending bypass, spending categories, Claude hook and Codex
adapters. The isolated agent/relay simulation exercises silent non-spending calls,
purchase denial, one-call subscription approval and paid booking approval expiry and cross-project EDU denial.
No real external action is used in testing. Existing relay tests cover reconnect,
expiry and decision delivery. Live activation requires an idle PC-agent scheduled-task
restart; no Railway change is needed. Check the bypass-money-edu-v2 boot marker and
post-restart isolated E2E receipt before claiming deployment.

Philip authorized merge/deployment and activation on 2026-10-18. Actual activation requires a deployed-and-tested receipt for bypass-money-edu-v2; the prior bypass-money-v1 receipt is insufficient. Keyword detection cannot identify every opaque cross-project action; agents must explicitly escalate EDU production actions even when no target is visible to the classifier. No production action or restart is authorized by the brief.

The idle rollout validates reviewed hashes, waits for three idle samples, rechecks immediately before restart, verifies a replacement process and running scheduled task, checks the versioned boot marker and reruns the isolated approval test. With an explicitly selected SessionId, it then queues a verification continuation after that session has been restored idle.
