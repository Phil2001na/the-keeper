import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { interactions, touchpoints, type Interaction, type Touchpoint } from '../db/repositories.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefinitions, dispatchTool } from './tools.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MAX_TOOL_ROUNDS = 12;

// If the API ever rejects the server-side web_search tool (org setting, model
// mismatch), strip it and carry on without — a degraded keeper beats a dead one.
let serverToolsDisabled = false;

function activeTools(): Anthropic.Messages.ToolUnion[] {
  if (!serverToolsDisabled) return toolDefinitions;
  return toolDefinitions.filter((t) => !('type' in t && t.type === 'web_search_20250305'));
}

/** An image Philip sent over Telegram, ready to hand to Claude's vision. */
export interface InboundImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64: string;
}

export type Trigger =
  | { kind: 'inbound'; text: string; images?: InboundImage[] }
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
 * The single agentic loop. Serves both an inbound message (reactive) and a
 * fired touchpoint (proactive). Runs Sonnet with tools until it produces a
 * final text reply or explicitly stays silent.
 */
export async function runAgent(trigger: Trigger): Promise<AgentResult> {
  const system = await buildSystemPrompt();
  const history = await interactions.recent(config.historyLimit);

  const messages: Anthropic.MessageParam[] = history.map((h) => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: h.content,
  }));

  // The triggering turn.
  if (trigger.kind === 'inbound') {
    await markTouchpointEngagement(history);

    // We don't persist image bytes — log a text marker so history stays clean,
    // but send the actual image to Claude in THIS turn's content.
    const logText =
      trigger.text || (trigger.images?.length ? '(sent an image)' : trigger.text);
    await interactions.log({ role: 'user', content: logText, trigger: 'inbound' });

    if (trigger.images?.length) {
      const content: Array<Anthropic.ImageBlockParam | Anthropic.TextBlockParam> = [
        ...trigger.images.map((img) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: img.mediaType, data: img.base64 },
        })),
        ...(trigger.text ? [{ type: 'text' as const, text: trigger.text }] : []),
      ];
      messages.push({ role: 'user', content });
    } else {
      messages.push({ role: 'user', content: trigger.text });
    }
  } else if (trigger.kind === 'touchpoint') {
    const tp = trigger.touchpoint;
    const wake =
      `[INTERNAL WAKE — not from Philip] A touchpoint you scheduled has come due.\n` +
      `Reason you set: "${tp.reason}"\n` +
      `Decide whether reaching out right now genuinely serves him. If yes, write the message you'd text him. ` +
      `If it's not worth interrupting him, use stay_silent. Either way, update memory and schedule your next touchpoint.`;
    messages.push({ role: 'user', content: wake });
  } else {
    // Nightly reflection: the brief is internal and never logged — the journal
    // entry the agent writes IS the durable record of this run.
    messages.push({ role: 'user', content: trigger.brief });
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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: config.model,
        max_tokens: 1024,
        system,
        tools: activeTools(),
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

    messages.push({ role: 'assistant', content: response.content });
    collectText(response.content);

    // Server-side tools (web_search) can pause a long turn — resume by sending
    // the partial assistant content back and calling again, no tool results.
    if (response.stop_reason === 'pause_turn') continue;

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
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
  return { message, silent: false };
}
