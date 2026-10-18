/**
 * Read-aloud for the web surface: he taps "listen" on a reply, we voice it.
 *
 * The page POSTs the message text to /api/speak (behind the web token); this
 * turns it into speakable prose and forwards it to OpenAI's speech endpoint
 * with the server's own key, so the key never reaches the page. Nothing here
 * plays on its own — every call is one tap on one message.
 *
 * Deliberately free of src/config.ts, like dictate.ts, so the preview harness
 * and the tests can use it without a full .env; the caller passes the key in.
 */

/** ~$0.015/min of audio at the time of writing; steerable with instructions. */
export const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts';
export const DEFAULT_TTS_VOICE = 'ash';

/** OpenAI's hard cap on `input` for /v1/audio/speech. */
export const MAX_SPEECH_CHARS = 4096;

/** How the model should sound — only the gpt-4o-*-tts models read this. */
const INSTRUCTIONS =
  'Speak like a calm, warm personal assistant talking to one person you know well. ' +
  'Natural pace, conversational, no announcer voice.';

export class SpeechError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Markdown as written for the eye → prose for the ear. Code is skipped rather
 * than read out symbol by symbol, links keep their words and lose their URLs,
 * and the formatting marks go. Long replies are cut at a sentence boundary
 * under the API cap, with a spoken note that the rest is on screen.
 */
export function speakableText(markdown: string): string {
  let t = String(markdown ?? '');
  t = t.replace(/```[\s\S]*?(```|$)/g, '\n(code block — see the screen.)\n');
  t = t.replace(/`([^`\n]+)`/g, '$1');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1');
  t = t.replace(/https?:\/\/\S+/g, 'a link');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');
  t = t.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2');
  t = t.replace(/(^|[^\w*])[*_](?=\S)([^*_\n]+?)(?<=\S)[*_](?=[^\w*]|$)/g, '$1$2');
  t = t.replace(/~~(.+?)~~/g, '$1');
  t = t.replace(/\|/g, ' ');
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (t.length > MAX_SPEECH_CHARS) {
    const tail = ' The rest is on screen.';
    const room = t.slice(0, MAX_SPEECH_CHARS - tail.length);
    const cut = Math.max(room.lastIndexOf('. '), room.lastIndexOf('.\n'), room.lastIndexOf('? '), room.lastIndexOf('! '));
    t = (cut > room.length / 2 ? room.slice(0, cut + 1) : room).trimEnd() + tail;
  }
  return t;
}

export interface SynthesizeOptions {
  apiKey: string;
  text: string;
  model?: string;
  voice?: string;
  /** Injected by the tests; the real thing otherwise. */
  fetchImpl?: typeof fetch;
}

/**
 * One message in, MP3 bytes out. Throws SpeechError with the HTTP status the
 * route should answer with, and a message fit to show on the phone.
 */
export async function synthesize(opts: SynthesizeOptions): Promise<Buffer> {
  if (!opts.apiKey) throw new SpeechError('read-aloud isn’t set up on the server', 503);
  const input = speakableText(opts.text);
  if (!input) throw new SpeechError('nothing to read out', 400);

  const model = opts.model || DEFAULT_TTS_MODEL;
  const body: Record<string, string> = {
    model,
    voice: opts.voice || DEFAULT_TTS_VOICE,
    input,
    response_format: 'mp3',
  };
  if (model.startsWith('gpt-')) body.instructions = INSTRUCTIONS;

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error('[speak] request failed:', (err as Error).message);
    throw new SpeechError('couldn’t reach the voice', 502);
  }

  if (!res.ok) {
    // The detail stays in the server log — it can echo request metadata.
    const detail = await res.text().catch(() => '');
    console.error(`[speak] OpenAI ${res.status}: ${detail.slice(0, 300)}`);
    throw new SpeechError(
      res.status === 429 ? 'the voice is busy — try again in a moment' : 'couldn’t voice that',
      502
    );
  }

  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) throw new SpeechError('couldn’t voice that', 502);
  return audio;
}
