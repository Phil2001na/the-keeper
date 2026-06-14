import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * The brain boundary. The whole agent loop is written in Anthropic's message
 * shapes (content blocks, tool_use / tool_result, usage). This module is the
 * ONE place that talks to a model API, so we can swap the brain underneath the
 * loop without touching it:
 *
 *   MODEL_PROVIDER=anthropic   → Claude, native (full fidelity, prompt caching)
 *   MODEL_PROVIDER=gemini      → Gemini direct, via Google's OpenAI-compatible
 *                                endpoint, reusing GEMINI_API_KEY.
 *   MODEL_PROVIDER=openrouter  → any model over OpenRouter's OpenAI-compatible
 *                                API (GPT-5-mini, etc.).
 *
 * For the two OpenAI-compatible providers we translate the request from
 * Anthropic shapes → OpenAI chat format on the way out, and the response back →
 * Anthropic content blocks on the way in, so the orchestrator never knows the
 * difference. We lose two Anthropic-only things in these modes — explicit
 * prompt-cache breakpoints and the server-side web_search tool — both non-fatal
 * (the models are cheap; search degrades gracefully).
 */

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

export interface LlmRequest {
  model: string;
  max_tokens: number;
  system: Anthropic.TextBlockParam[] | string;
  tools: Anthropic.Messages.ToolUnion[];
  messages: Anthropic.MessageParam[];
}

/** Just the slice of an Anthropic message the orchestrator actually reads. */
export interface LlmResponse {
  content: Anthropic.ContentBlock[];
  usage: Anthropic.Usage;
  stop_reason: string | null;
}

/** OpenAI-compatible endpoints, keyed by provider. */
const OPENAI_COMPAT: Record<string, { url: string; apiKey: () => string }> = {
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey: () => config.geminiApiKey,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    apiKey: () => config.openrouterApiKey,
  },
};

export async function createMessage(req: LlmRequest): Promise<LlmResponse> {
  const compat = OPENAI_COMPAT[config.modelProvider];
  if (compat) return viaOpenAiCompat(req, compat.url, compat.apiKey());
  return viaAnthropic(req);
}

async function viaAnthropic(req: LlmRequest): Promise<LlmResponse> {
  const res = await anthropic.messages.create({
    model: req.model,
    max_tokens: req.max_tokens,
    system: req.system,
    tools: req.tools,
    messages: req.messages,
  });
  return { content: res.content, usage: res.usage, stop_reason: res.stop_reason };
}

// ---------------------------------------------------------------------------
// OpenRouter (OpenAI-compatible) translation
// ---------------------------------------------------------------------------

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | unknown[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function systemToString(system: LlmRequest['system']): string {
  if (typeof system === 'string') return system;
  return system.map((b) => b.text).join('\n\n');
}

/** Anthropic tool defs → OpenAI function tools. Server-side tools are dropped. */
function toolsToOpenAi(tools: Anthropic.Messages.ToolUnion[]): unknown[] {
  const out: unknown[] = [];
  for (const t of tools) {
    // Server tools (web_search_20250305 etc.) carry a `type`; only plain
    // custom tools survive — OpenRouter models can't run Anthropic's hosted tools.
    if ('type' in t && t.type !== 'custom') continue;
    const tool = t as Anthropic.Messages.Tool;
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema,
      },
    });
  }
  return out;
}

/** tool_result content (string | block[]) → flat text for an OpenAI tool message. */
function blockContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

function messagesToOpenAi(req: LlmRequest): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: systemToString(req.system) }];

  for (const m of req.messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        out.push({ role: 'user', content: m.content });
        continue;
      }
      const toolResults = m.content.filter((b) => b.type === 'tool_result');
      if (toolResults.length) {
        // Tool results become individual `tool` messages keyed by call id.
        for (const tr of toolResults) {
          const r = tr as Anthropic.ToolResultBlockParam;
          out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: blockContentToText(r.content) });
        }
        continue;
      }
      // Text + images + PDFs. Build an OpenAI multimodal content array. Gemini's
      // OpenAI-compatible endpoint accepts a PDF as an image_url data URL with
      // mime application/pdf — so documents ride the same channel as images.
      const parts: unknown[] = [];
      for (const b of m.content) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          const src = b.source;
          if (src.type === 'base64') {
            parts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
          }
        } else if (b.type === 'document') {
          const src = (b as Anthropic.DocumentBlockParam).source;
          if (src.type === 'base64') {
            parts.push({ type: 'image_url', image_url: { url: `data:${src.media_type};base64,${src.data}` } });
          }
        }
      }
      out.push({ role: 'user', content: parts.length === 1 && (parts[0] as { type: string }).type === 'text' ? (parts[0] as { text: string }).text : parts });
    } else {
      // assistant
      if (typeof m.content === 'string') {
        out.push({ role: 'assistant', content: m.content });
        continue;
      }
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as Anthropic.TextBlockParam).text)
        .join('\n');
      const toolCalls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => {
          const u = b as Anthropic.ToolUseBlockParam;
          return { id: u.id, type: 'function' as const, function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) } };
        });
      const msg: OpenAiMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    }
  }
  return out;
}

interface OpenAiResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

async function viaOpenAiCompat(req: LlmRequest, url: string, apiKey: string): Promise<LlmResponse> {
  const tools = toolsToOpenAi(req.tools);
  const body = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages: messagesToOpenAi(req),
    tools: tools.length ? tools : undefined,
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      // Harmless attribution headers (OpenRouter shows them; Google ignores them).
      'HTTP-Referer': 'https://github.com/Phil2001na/the-keeper',
      'X-Title': 'The Keeper',
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`${config.modelProvider} ${r.status}: ${detail.slice(0, 500)}`);
  }

  const data = (await r.json()) as OpenAiResponse;
  if (data.error) throw new Error(`${config.modelProvider} error: ${data.error.message ?? 'unknown'}`);

  const choice = data.choices?.[0];
  const msg = choice?.message ?? {};
  const content: Anthropic.ContentBlock[] = [];

  if (msg.content) {
    content.push({ type: 'text', text: msg.content, citations: null } as unknown as Anthropic.ContentBlock);
  }
  for (const tc of msg.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || '{}');
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input } as unknown as Anthropic.ContentBlock);
  }

  const u = data.usage ?? {};
  const usage = {
    input_tokens: u.prompt_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  } as unknown as Anthropic.Usage;

  const stop_reason = choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
  return { content, usage, stop_reason };
}
