/**
 * Dictation for the web composer: the browser records, we transcribe.
 *
 * The browser POSTs raw audio to /api/dictate (behind the web token); this
 * forwards it to OpenAI's transcription endpoint with the server's own key, so
 * the key never reaches the page. The transcript goes back to the composer for
 * him to edit — nothing here sends a message to the agent.
 *
 * Deliberately free of src/config.ts so the preview harness and the tests can
 * use it without a full .env; the caller passes the key in.
 */

/** $0.003/min at the time of writing — cheap enough to leave on. */
export const DEFAULT_DICTATION_MODEL = 'gpt-4o-mini-transcribe';

/** Well under OpenAI's 25 MB upload cap; ~5 min of iPhone AAC is ~4 MB. */
export const MAX_DICTATION_BYTES = 15 * 1024 * 1024;

/**
 * OpenAI decides the format from the upload's filename, not its MIME type, so
 * the extension is what actually matters. iPhone Safari records audio/mp4,
 * Chrome and Firefox audio/webm (Opus); the rest are here for completeness.
 */
const EXT: Record<string, string> = {
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
};

/** The upload extension for a Content-Type, or null if it isn't audio we take. */
export function audioExtension(contentType: string | undefined): string | null {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return EXT[base] ?? null;
}

export class DictationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface TranscribeOptions {
  apiKey: string;
  audio: Buffer;
  contentType: string | undefined;
  model?: string;
  /** Injected by the tests; the real thing otherwise. */
  fetchImpl?: typeof fetch;
}

/**
 * One recording in, its text out. Throws DictationError with the HTTP status
 * the route should answer with, and a message fit to show on the phone.
 */
export async function transcribe(opts: TranscribeOptions): Promise<string> {
  if (!opts.apiKey) throw new DictationError('dictation isn’t set up on the server', 503);
  const ext = audioExtension(opts.contentType);
  if (!ext) throw new DictationError('that isn’t audio it can read', 415);
  if (opts.audio.length === 0) throw new DictationError('nothing was recorded', 400);
  if (opts.audio.length > MAX_DICTATION_BYTES) throw new DictationError('that recording is too long', 413);

  const form = new FormData();
  form.append('file', new Blob([opts.audio], { type: opts.contentType }), `dictation.${ext}`);
  form.append('model', opts.model || DEFAULT_DICTATION_MODEL);
  form.append('response_format', 'json');

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    console.error('[dictate] request failed:', (err as Error).message);
    throw new DictationError('couldn’t reach the transcriber', 502);
  }

  if (!res.ok) {
    // The detail stays in the server log — it can echo request metadata.
    const detail = await res.text().catch(() => '');
    console.error(`[dictate] OpenAI ${res.status}: ${detail.slice(0, 300)}`);
    throw new DictationError(
      res.status === 429 ? 'the transcriber is busy — try again in a moment' : 'transcription failed',
      502
    );
  }

  const data = (await res.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) throw new DictationError('didn’t catch any words', 422);
  return text;
}
