import { workContext, capture, resumeContext } from '../workstreams/service.js';
import { readState } from '../workstreams/store.js';
import { route } from '../workstreams/model.js';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config, isQuietHours, localTimeString, relativeDayContext } from '../config.js';
import {
  digests,
  interactions,
  touchpoints,
  lockIn,
  type Interaction,
  type Touchpoint,
  type ActiveLockIn,
} from '../db/repositories.js';
import { bus, stepLabel, turnScope } from '../web/bus.js';
import { maybeFold } from './digest.js';
import { createMessage, type LlmResponse } from './llm.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefinitions, presentToolDefinition, dispatchTool } from './tools.js';
import { logUsage } from './usage.js';
import { minutesLeft, renderLockIn } from './lockIn.js';
import { promisesPcDispatch, PC_PROMISE_NUDGE } from './pcPromise.js';

const MAX_TOOL_ROUNDS = 12;

/** Which surface a turn talks back to. Touchpoints/reflection aren't surfaces. */
export type Surface = 'telegram' | 'web';

// If the API ever rejects the server-side web_search tool (org setting, model
// mismatch), strip it and carry on without — a degraded keeper beats a dead one.
let serverToolsDisabled = false;

function activeTools(surface?: Surface): Anthropic.Messages.ToolUnion[] {
  let tools = toolDefinitions;
  // The server-side web_search tool is Anthropic-hosted — strip it when it's
  // been rejected, or whenever a non-Anthropic brain (OpenRouter) is driving.
  if (serverToolsDisabled || config.modelProvider !== 'anthropic') {
    tools = tools.filter((t) => !('type' in t && t.type === 'web_search_20250305'));
  }
  // The present tool only exists where a screen exists.
  return surface === 'web' ? [...tools, presentToolDefinition] : tools;
}

/** An image Philip sent (Telegram or web), ready for the model's vision. */
export interface InboundImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64: string;
}

/** A PDF Philip sent — handed to the model natively (no text extraction). */
export interface InboundPdf {
  base64: string;
  filename?: string;
}

export type Trigger =
  | { kind: 'inbound'; text: string; images?: InboundImage[]; pdfs?: InboundPdf[]; surface?: Surface; workstreamId?: string }
  | { kind: 'touchpoint'; touchpoint: Touchpoint }
  /** Private nightly reflection — never messages him, never logged as conversation. */
  | { kind: 'reflection'; brief: string }
  /**
   * The lock-in protocol waking itself: a timed check-in, the harder second
   * ping after silence, or the end-of-session debrief. Driven by the scheduler,
   * not by the model remembering to look at a clock.
   */
  | { kind: 'lockin'; phase: 'check_in' | 'escalation' | 'debrief'; live: ActiveLockIn }
  /**
   * An agent on his PC (Meeseeks Prime, or a solo Meeseeks with a long report)
   * reported back. The Keeper passes on what matters in plain words; the full
   * report stays in the PC sheet. Never silent: the caller falls back to a short
   * verbatim message if this turn produces nothing.
   */
  | { kind: 'crew'; from: string; jobId: string; report: string };

/**
 * He just messaged us. If the last thing the agent did was a proactive
 * touchpoint (within 6h), that reach-out LANDED — record it so the nightly
 * reflection can learn which check-ins are worth making.
 */
async function markTouchpointEngagement(history: Interaction[]): Promise<void> {
  const lastAgent = [...history].reverse().find((h) => h.role === 'agent');
  if (!lastAgent?.trigger?.startsWith('touchpoint:')) return;
  const ageMs = Date.now() - new Date(lastAgent.created_at).getTime();
  if (ageMs > 6 * 60 * 60 * 1000) return;
  const id = lastAgent.trigger.slice('touchpoint:'.length);
  try {
    await touchpoints.markReplied(id);
  } catch (err) {
    console.error('[agent] failed to mark touchpoint engagement:', err);
  }
}

export interface AgentResult {
  /** Text to send to the user, or null if the agent chose silence. */
  message: string | null;
  silent: boolean;
}

/**
 * The single agentic loop. Serves an inbound message (reactive), a fired
 * touchpoint (proactive), or the nightly reflection. Runs Sonnet with tools
 * until it produces a final text reply or explicitly stays silent.
 */
export async function runAgent(trigger: Trigger): Promise<AgentResult> {
  // Narrate the turn to the web UI (no-op when no browser is connected).
  const source = trigger.kind === 'inbound' ? `inbound:${trigger.surface ?? 'telegram'}` : trigger.kind === 'crew' ? 'inbound:crew' : trigger.kind;
  const id = randomUUID();
  const startedAt = Date.now();
  bus.publish({ type: 'turn', phase: 'start', source, id, startedAt });
  try {
    // Scoped so every step published below is tagged with this turn's id.
    let workId: string | null = null;
    if (trigger.kind === 'inbound') {
      try { workId = trigger.workstreamId ?? route(await readState(), trigger.text); }
      catch (err) { console.error('[workstreams] routing unavailable', err); }
    }
    const run = async () => {
      if (trigger.kind === 'inbound' && workId) {
        await capture(trigger.text || '(attachment)', 'Philip', `chat:${id}:user`, workId).catch(err => console.error('[workstreams] capture failed', err));
      }
      const result = await turnScope.run(id, () => runTurn(trigger));
      if (workId && result.message) await capture(result.message, 'Keeper', `chat:${id}:agent`, workId).catch(err => console.error('[workstreams] reply capture failed', err));
      return result;
    };
    return await (workId ? workContext.run(workId, run) : run());
  } finally {
    bus.publish({ type: 'turn', phase: 'end', source, id, startedAt });
    // Window maintenance: if too much has piled up since the digest anchor,
    // fold the overflow into the rolling digest. Async — never delays a reply.
    maybeFold();
  }
}

/**
 * Volatile situational facts live HERE, in the trigger message, not in the
 * system prompt — so the system prompt (and the history before this message)
 * stays byte-identical between turns and the prompt cache keeps hitting.
 */
function contextLine(
  history: Interaction[],
  anchored: boolean,
  surface: Surface | undefined,
  live: ActiveLockIn | null
): string {
  const now = `${localTimeString()} (${config.timezone}) · UTC ${new Date().toISOString().slice(0, 16)}Z`;
  const days = relativeDayContext();
  const oldest = history[0];
  const span = oldest
    ? `${history.length} msgs in view, back to ${oldest.created_at.slice(0, 16).replace('T', ' ')} UTC`
    : 'no prior messages in view';
  const beyond = anchored
    ? 'older: rolling digest (above) → journal → search_history'
    : 'older: search_history';
  const quiet = live
    ? 'quiet hours do not apply — he opted into this session'
    : isQuietHours()
    ? 'QUIET HOURS now — he wrote first, reply, but keep it low-key'
    : `quiet hours ${config.quietStart}:00–${config.quietEnd}:00`;
  const where = surface === 'web' ? ' · he is on the WEB UI (present tool available)' : '';
  // The stance itself is in the system prompt; this is just the clock, which
  // moves every turn and so must not sit inside a cached block.
  const stance = live
    ? ` · LOCK IN: ${minutesLeft(live.session.ends_at)} min left, open targets ${
        live.targets.filter((t) => t.status === 'committed' || t.status === 'partial').map((t) => t.position).join('/') || 'none'
      }`
    : '';
  // Timestamps in view/archive are UTC; reckon "today/tomorrow" against the
  // local dates above, and never ask about something before its time has
  // actually passed in local time.
  return `[context: ${now} · ${days} · ${span} · ${beyond} · ${quiet}${where}${stance}]`;
}

/**
 * Prompt-cache breakpoints. The API allows 4; the system prompt carries two
 * (character block, memory block). The other two live in the messages:
 *  - the LAST HISTORY message — the anchored window is append-only between
 *    folds, so this prefix hits turn after turn;
 *  - the request TAIL — so each round of a multi-tool turn reuses the previous
 *    round's prefix instead of re-reading the whole conversation at full price.
 * Marks are stripped and re-applied each round (stale marks would breach the
 * 4-breakpoint limit).
 */
function applyCacheMarks(messages: Anthropic.MessageParam[], histEnd: number): void {
  type Markable = { cache_control?: { type: 'ephemeral' } };
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) delete (b as Markable).cache_control;
    }
  }
  const mark = (i: number): void => {
    const m = messages[i];
    if (!m) return;
    if (typeof m.content === 'string') {
      m.content = [{ type: 'text', text: m.content }];
    }
    const lastBlock = m.content[m.content.length - 1];
    if (lastBlock) (lastBlock as Markable).cache_control = { type: 'ephemeral' };
  };
  if (histEnd > 0 && histEnd <= messages.length) mark(histEnd - 1);
  const last = messages.length - 1;
  // Tail-mark only after a user message (trigger / tool results) — never on
  // assistant server-tool blocks, where cache_control isn't accepted.
  if (last >= histEnd && messages[last]?.role === 'user') mark(last);
}

async function runTurn(trigger: Trigger): Promise<AgentResult> {
  const surface = trigger.kind === 'inbound' ? trigger.surface ?? 'telegram' : undefined;
  // Rides on every message event: the web push hook uses it to tell a proactive
  // reach-out (worth a notification) from a reply he asked for (not).
  // A crew report is delivered on Telegram by the caller, so its web echo must not buzz the phone again.
  const eventSource = trigger.kind === 'inbound' ? `inbound:${surface}` : trigger.kind === 'crew' ? 'inbound:crew' : trigger.kind;

  // Anchored window: everything since the digest anchor rides in context
  // verbatim — hours or days of real conversation, append-only between folds.
  // The digest (in the system prompt) carries what came before. No anchor yet
  // (first boot) → plain recency window until ensureAnchor lands.
  const dig = await digests.get('rolling').catch(() => null);
  // A running lock-in session rewrites the Keeper's whole posture for this turn.
  const live = await lockIn.active().catch(() => null);
  const system = await buildSystemPrompt(dig, live);
  const history = dig?.covered_until
    ? await interactions.sinceAnchor(dig.covered_until, 200)
    : await interactions.recent(config.historyLimit);

  const messages: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: h.content,
  }));
  const histEnd = messages.length;

  // Time, window map, quiet hours, surface — all volatile, so they ride in the
  // trigger message (NOT the system prompt or the log) to keep caches stable.
  let ctx = contextLine(history, Boolean(dig?.covered_until), surface, live);
  const workId = workContext.getStore();
  if (workId) ctx += await resumeContext(workId).catch(() => '\nWorkstream context unavailable; do not guess its status.');

  // The triggering turn.
  if (trigger.kind === 'inbound') {
    await markTouchpointEngagement(history);

    // We don't persist file bytes — log a text marker so history stays clean,
    // but send the actual image/PDF to the model in THIS turn's content.
    const attachMarker = trigger.pdfs?.length
      ? `(sent ${trigger.pdfs.length === 1 ? 'a PDF' : trigger.pdfs.length + ' PDFs'})`
      : trigger.images?.length
        ? `(sent ${trigger.images.length === 1 ? 'an image' : trigger.images.length + ' images'})`
        : '';
    const logText = trigger.text || attachMarker;
    await interactions.log({ role: 'user', content: logText, trigger: 'inbound' });
    bus.publish({ type: 'message', role: 'user', content: logText, ts: new Date().toISOString(), source: eventSource });

    if (trigger.images?.length || trigger.pdfs?.length) {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const img of trigger.images ?? []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
      }
      // Native PDF: Anthropic reads document blocks directly; the OpenAI-compat
      // adapter (Gemini) turns them into a data-URL the model reads natively too.
      for (const pdf of trigger.pdfs ?? []) {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.base64 } });
      }
      content.push({ type: 'text', text: trigger.text ? `${ctx}\n\n${trigger.text}` : ctx });
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: `${ctx}\n\n${trigger.text}` });
    }
  } else if (trigger.kind === 'touchpoint') {
    const tp = trigger.touchpoint;
    const wake =
      `${ctx}\n\n[INTERNAL WAKE — not from Philip] A touchpoint you scheduled has come due.\n` +
      `Reason you set: "${tp.reason}"\n` +
      (tp.recurrence
        ? `This is a STANDING RITUAL (${tp.recurrence}) — it renews itself automatically; do not reschedule it.\n`
        : '') +
      `Decide whether reaching out right now genuinely serves him. If yes, write the message you'd text him. ` +
      `If it's not worth interrupting him, use stay_silent. Either way, update memory${tp.recurrence ? '' : ' and tend your next touchpoint'}.`;
    messages.push({ role: 'user', content: wake });
  } else if (trigger.kind === 'lockin') {
    const { live: sess, phase } = trigger;
    const left = minutesLeft(sess.session.ends_at);
    const head =
      phase === 'debrief'
        ? `[INTERNAL WAKE — not from Philip] The lock-in session has reached its end.
` +
          `${renderLockIn(sess)}

` +
          `Debrief it now. Read the session log above and lock_in_status if you need more. Score each target honestly against what he COMMITTED to — ` +
          `not against how hard it felt, and not against what he did instead. Then call end_lock_in with the score and your read, and write him the debrief: ` +
          `what landed, where the time actually went, one thing worth carrying into the next session. Blunt, then done — after end_lock_in you are back in CALM. ` +
          `Never stay_silent on a debrief; he is owed the read.`
        : phase === 'escalation'
          ? `[INTERNAL WAKE — not from Philip] You checked in ${sess.session.last_check_in_at ? `at ${sess.session.last_check_in_at.slice(11, 16)} UTC` : 'a while ago'} and he has not answered.
` +
            `${renderLockIn(sess)}

` +
            `This is the HARDER second ping — one message, harder than the first. Name the silence, name the minutes gone out of the ${left > 0 ? `${left} remaining` : 'session'}, ` +
            `and ask for one sentence on the open target. No new questions, no softening, no apology for pinging. Do not stay_silent — the silence is exactly what you are pushing on.`
          : `[INTERNAL WAKE — not from Philip] Check-in due. ${left > 0 ? `${left} min left in the session.` : 'The session is at its end.'}
` +
            `${renderLockIn(sess)}

` +
            `Ask him one direct question: what has landed since the last check-in. Not "how's it going". Short and flat. ` +
            `When he answers, log_lock_in_progress it and move any target that genuinely moved. Do not stay_silent — the check-in IS the protocol he asked for.`;
    messages.push({ role: 'user', content: `${ctx}

${head}` });
  } else if (trigger.kind === 'crew') {
    messages.push({
      role: 'user',
      content:
        `${ctx}

[INTERNAL — not from Philip] ${trigger.from} (${trigger.jobId}) on his PC reported back. ` +
        'Pass it on to him the way a sharp chief of staff would brief a busy person by text: a few plain sentences on what was done or found, ' +
        'anything he has to decide or do, and what is still open. No headings, no tables, no jargon, no restating the whole report; he can read it in full in the PC sheet. ' +
        'If it needs a decision from him, end with that question.\n\n<report>\n' +
        trigger.report.slice(0, 20000) +
        '\n</report>',
    });
  } else {
    // Nightly reflection: the brief is internal and never logged — the journal
    // entry the agent writes IS the durable record of this run.
    messages.push({ role: 'user', content: `${ctx}\n\n${trigger.brief}` });
  }

  // A single attempt at the full tool-use loop. Mutates `messages` in place —
  // callers that want to retry from scratch must snapshot/restore its length.
  async function attemptTurn(): Promise<{ text: string; silent: boolean; toolsRan: boolean; tools: Set<string> }> {
    let silent = false;
    let toolsRan = false;
    const tools = new Set<string>();
    // The model often writes its reply in the SAME turn as a tool call (e.g.
    // "got it 👍" alongside schedule_touchpoint). That turn's stop_reason is
    // "tool_use", so we must capture text from every turn, not just the final
    // one — otherwise the reply is silently dropped and the user is left on read.
    const textParts: string[] = [];

    const collectText = (content: Anthropic.ContentBlock[]) => {
      const t = content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (t) textParts.push(t);
    };

    const usages: Anthropic.Usage[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      applyCacheMarks(messages, histEnd);
      let response: LlmResponse;
      try {
        response = await createMessage({
          model: config.model,
          max_tokens: 2048,
          system,
          tools: activeTools(surface),
          messages,
        });
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!serverToolsDisabled && /web_search/i.test(msg)) {
          console.error('[agent] API rejected web_search tool — disabling it and retrying:', msg);
          serverToolsDisabled = true;
          round--;
          continue;
        }
        throw err;
      }

      usages.push(response.usage);
      messages.push({ role: 'assistant', content: response.content });
      collectText(response.content);

      // web_search runs inside the API — surface it as a live step anyway.
      for (const block of response.content) {
        if (block.type === 'server_tool_use') {
          bus.publish({ type: 'step', label: stepLabel(block.name), tool: block.name });
        }
      }

      // Server-side tools (web_search) can pause a long turn — resume by sending
      // the partial assistant content back and calling again, no tool results.
      if (response.stop_reason === 'pause_turn') continue;

      if (response.stop_reason === 'tool_use') {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue;
          toolsRan = true;
          tools.add(block.name);
          bus.publish({ type: 'step', label: stepLabel(block.name), tool: block.name });
          // A tool that throws (network blip, expired Google token, etc.) must
          // NEVER take down the whole turn — feed the error back to the model as a
          // tool_result so it can recover and still reply, instead of leaving him
          // on read. Catch here covers every tool at the single choke point.
          let result: { output: string; silent?: boolean };
          try {
            result = await dispatchTool(block.name, block.input as Record<string, unknown>);
          } catch (err) {
            console.error(`[agent] tool "${block.name}" threw:`, err);
            result = { output: `Error running ${block.name}: ${(err as Error).message}. Tell him you couldn't do that right now, and carry on.` };
          }
          if (result.silent) silent = true;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.output,
          });
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Final turn — the model is done. Assemble everything it said.
      break;
    }

    logUsage(trigger.kind, config.model, usages);
    return { text: textParts.join('\n\n').trim(), silent, toolsRan, tools };
  }

  // Philip must never see a "blanked, say that again?" placeholder or any
  // other meta-talk about a transient failure — retry the whole turn silently
  // instead. Blank final text on an inbound message is almost always a
  // transient hiccup (model returned no content), not a real "nothing to say".
  //
  // How the retry rewinds depends on whether the blank attempt actually did
  // anything. Rewinding past executed tools would re-run their side effects —
  // a second remember_fact, a duplicate schedule_touchpoint, an email sent
  // twice — and re-pay for every round that got us there. So:
  //   - no tools ran  → discard the attempt entirely and start fresh
  //   - tools ran     → KEEP their results in `messages` and ask again. The
  //                     work is done and paid for; all that's missing is the
  //                     text, and the model now has everything it needs to
  //                     write it in a single cheap round.
  const baseMessagesLen = messages.length;
  const MAX_BLANK_RETRIES = 2;
  let text = '';
  let silent = false;
  const toolsUsed = new Set<string>();
  for (let attempt = 0; attempt <= MAX_BLANK_RETRIES; attempt++) {
    const result = await attemptTurn();
    text = result.text;
    silent = result.silent;
    for (const t of result.tools) toolsUsed.add(t);
    if (text !== '' || silent || trigger.kind !== 'inbound') break;
    console.error(`[agent] blank response on inbound turn (attempt ${attempt + 1}/${MAX_BLANK_RETRIES + 1}) — retrying silently`);
    if (result.toolsRan) {
      messages.push({
        role: 'user',
        content:
          '[system] Your last response came back empty. Everything above already ran — do NOT repeat any tool call. Just reply to him now, in your own voice, as if this note were not here.',
      });
    } else {
      messages.length = baseMessagesLen; // nothing happened — try fresh
    }
  }

  // "Claude is on it" with no start_claude_session behind it is the worst kind
  // of reply: nothing is running, so nothing ever comes back, and he waits on a
  // result that cannot arrive. One extra round to make the call or take the
  // claim back. The earlier text is replaced, never sent alongside.
  if (trigger.kind === 'inbound' && text !== '' && !toolsUsed.has('start_claude_session') && !toolsUsed.has('continue_claude_session') && !toolsUsed.has('delegate_to_prime') && promisesPcDispatch(text)) {
    console.error('[agent] reply promised a PC session but never started one — asking it to act or correct itself');
    messages.push({ role: 'user', content: PC_PROMISE_NUDGE });
    try {
      const fixed = await attemptTurn();
      if (fixed.text !== '') text = fixed.text;
    } catch (err) {
      console.error('[agent] PC-promise correction round failed, keeping the original reply:', err);
    }
  }

  // Reflection is always silent: it's the agent thinking, not talking. Its
  // output lives in the journal + memory writes, never in Philip's chat.
  if (trigger.kind === 'reflection') {
    return { message: null, silent: true };
  }

  // Silence only ever applies to a proactive touchpoint (the agent deciding a
  // due check-in isn't worth interrupting him, via stay_silent or empty text).
  // A direct inbound message must ALWAYS get a reply — never leave him on read.
  if (trigger.kind === 'touchpoint' && (silent || text === '')) {
    return { message: null, silent: true };
  }

  // Inbound text can still be blank after exhausting the silent retries above
  // (a real outage, not a blip). Never surface a "blanked/say that again"
  // placeholder — going silent is the lesser failure than meta-talk about it.
  if (text === '') {
    console.error('[agent] inbound turn still blank after retries — going silent rather than showing a placeholder');
    return { message: null, silent: true };
  }

  const message = text;

  await interactions.log({
    role: 'agent',
    content: message,
    trigger:
      trigger.kind === 'touchpoint'
        ? `touchpoint:${trigger.touchpoint.id}`
        : trigger.kind === 'lockin'
          ? `lockin:${trigger.phase}:${trigger.live.session.id}`
          : trigger.kind === 'crew'
            ? `crew:${trigger.jobId}`
            : 'inbound',
  });
  bus.publish({ type: 'message', role: 'agent', content: message, ts: new Date().toISOString(), source: eventSource });
  return { message, silent: false };
}
