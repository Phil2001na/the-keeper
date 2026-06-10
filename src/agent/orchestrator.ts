import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { interactions, type Touchpoint } from '../db/repositories.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefinitions, dispatchTool } from './tools.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MAX_TOOL_ROUNDS = 12;

/** An image Philip sent over Telegram, ready to hand to Claude's vision. */
export interface InboundImage {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  base64: string;
}

export type Trigger =
  | { kind: 'inbound'; text: string; images?: InboundImage[] }
  | { kind: 'touchpoint'; touchpoint: Touchpoint };

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
  } else {
    const tp = trigger.touchpoint;
    const wake =
      `[INTERNAL WAKE — not from Philip] A touchpoint you scheduled has come due.\n` +
      `Reason you set: "${tp.reason}"\n` +
      `Decide whether reaching out right now genuinely serves him. If yes, write the message you'd text him. ` +
      `If it's not worth interrupting him, use stay_silent. Either way, update memory and schedule your next touchpoint.`;
    messages.push({ role: 'user', content: wake });
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
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: 1024,
      system,
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });
    collectText(response.content);

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const result = await dispatchTool(
          block.name,
          block.input as Record<string, unknown>
        );
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
