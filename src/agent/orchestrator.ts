import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { interactions, type Touchpoint } from '../db/repositories.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { toolDefinitions, dispatchTool } from './tools.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MAX_TOOL_ROUNDS = 12;

export type Trigger =
  | { kind: 'inbound'; text: string }
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
    await interactions.log({ role: 'user', content: trigger.text, trigger: 'inbound' });
    messages.push({ role: 'user', content: trigger.text });
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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.messages.create({
      model: config.model,
      max_tokens: 1024,
      system,
      tools: toolDefinitions,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

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

    // Final turn — gather any text the model produced.
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (silent || text === '') {
      return { message: null, silent: true };
    }

    await interactions.log({
      role: 'agent',
      content: text,
      trigger: trigger.kind === 'touchpoint' ? `touchpoint:${trigger.touchpoint.id}` : 'inbound',
    });
    return { message: text, silent: false };
  }

  // Safety valve: too many tool rounds.
  return {
    message: silent ? null : "(I got tangled up thinking just now — give me a nudge?)",
    silent,
  };
}
