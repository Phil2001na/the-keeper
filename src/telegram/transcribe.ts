import { config } from '../config.js';

export const transcriptionEnabled = (): boolean => config.groqApiKey !== '';

/**
 * Transcribe a Telegram voice note via Groq's Whisper (OpenAI-compatible
 * endpoint). Telegram voice notes are OGG/Opus, which Whisper accepts directly.
 *
 * @param fileUrl  A direct download URL for the audio (from bot.getFileLink).
 * @param filename Hint for the upload part; extension helps the decoder.
 * @returns        The transcribed text (trimmed), or throws on failure.
 */
export async function transcribeFromUrl(
  fileUrl: string,
  filename = 'voice.ogg'
): Promise<string> {
  if (!transcriptionEnabled()) {
    throw new Error('Transcription not configured (GROQ_API_KEY missing).');
  }

  // Pull the audio bytes from Telegram.
  const audioRes = await fetch(fileUrl);
  if (!audioRes.ok) {
    throw new Error(`Failed to download voice note (${audioRes.status}).`);
  }
  const audioBuf = await audioRes.arrayBuffer();

  // Hand it to Groq Whisper as multipart form-data.
  const form = new FormData();
  form.append('file', new Blob([audioBuf]), filename);
  form.append('model', config.groqTranscribeModel);
  form.append('response_format', 'json');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Groq transcription failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const data = (await res.json()) as { text?: string };
  const text = (data.text ?? '').trim();
  if (!text) throw new Error('Transcription came back empty.');
  return text;
}
