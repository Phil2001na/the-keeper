import Anthropic from '@anthropic-ai/sdk';
import { config, isQuietHours, localTimeString, relativeDayContext } from '../config.js';
import {
  digests,
  interactions,
  touchpoints,
  type Interaction,
  type Touchpoint,
} from '../db/repositories.js';
import { bus, stepLabel } from '../web/bus.js';
import { maybeFold } from './digest.js';
import { createMessage, type LlmResponse } from './llm.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefinitions, presentToolDefinition, dispatchTool } from './tools.js';
import { logUsage } from './usage.js';

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
  | { kind: 'inbound'; text: string; images?: InboundImage[]; pdfs?: InboundPdf[]; surface?: Surface }
  | { kind: 'touchpoint'; touchpoint: Touchpoint }
  /** Private nightly reflection — never messages him, never logged as conversation. */
  | { kind: 'reflection'; brief: string };

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
  const source = trigger.kind === 'inbound' ? `inbound:${trigger.surface ?? 'telegram'}` : trigger.kind;
  bus.publish({ type: 'turn', phase: 'start', source });
  try {
    return await runTurn(trigger);
  } finally {
    bus.publish({ type: 'turn', phase: 'end', source });
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
function contextLine(history: Interaction[], anchored: boolean, surface?: Surface): string {
  const now = `${localTimeString()} (${config.timezone}) · UTC ${new Date().toISOString().slice(0, 16)}Z`;
  const days = relativeDayContext();
  const oldest = history[0];
  const span = oldest
    ? `${history.length} msgs in view, back to ${oldest.created_at.slice(0, 16).replace('T', ' ')} UTC`
    : 'no prior messages in view';
  const beyond = anchored
    ? 'older: rolling digest (above) → journal → search_history'
    : 'older: search_history';
  const quiet = isQuietHours()
    ? 'QUIET HOURS now — he wrote first, reply, but keep it low-key'
    : `quiet hours ${config.quietStart}:00–${config.quietEnd}:00`;
  const where = surface === 'web' ? ' · he is on the WEB UI (present tool available)' : '';
  // Timestamps in view/archive are UTC; reckon "today/tomorrow" against the
  // local dates above, and never ask about something before its time has
  // actually passed in local time.
  return `[context: ${now} · ${days} · ${span} · ${beyond} · ${quiet}${where}]`;
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

  // Anchored window: everything since the digest anchor rides in context
  // verbatim — hours or days of real conversation, append-only between folds.
  // The digest (in the system prompt) carries what came before. No anchor yet
  // (first boot) → plain recency window until ensureAnchor lands.
  const dig = await digests.get('rolling').catch(() => null);
  const system = await buildSystemPrompt(dig);
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
  const ctx = contextLine(history, Boolean(dig?.covered_until), surface);

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
    bus.publish({ type: 'message', role: 'user', content: logText, ts: new Date().toISOString() });

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
  } else {
    // Nightly reflection: the brief is internal and never logged — the journal
    // entry the agent writes IS the durable record of this run.
    messages.push({ role: 'user', content: `${ctx}\n\n${trigger.brief}` });
  }

  let silent = false;
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
        bus.publish({ type: 'step', label: stepLabel(block.name) });
      }
    }

    // Server-side tools (web_search) can pause a long turn — resume by sending
    // the partial assistant content back and calling again, no tool results.
    if (response.stop_reason === 'pause_turn') continue;

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        bus.publish({ type: 'step', label: stepLabel(block.name) });
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

  const text = textParts.join('\n\n').trim();
  logUsage(trigger.kind, config.model, usages);

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

  const message = text === '' ? '(hm, i blanked for a second there — say that again?)' : text;

  await interactions.log({
    role: 'agent',
    content: message,
    trigger: trigger.kind === 'touchpoint' ? `touchpoint:${trigger.touchpoint.id}` : 'inbound',
  });
  bus.publish({ type: 'message', role: 'agent', content: message, ts: new Date().toISOString() });
  return { message, silent: false };
}
