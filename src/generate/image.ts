import { config } from '../config.js';

export function imageGenEnabled(): boolean {
  return Boolean(config.geminiApiKey);
}

export interface ImageResult {
  ok: boolean;
  pngBase64?: string;
  error?: string;
}

/** Generate an image from a text prompt using Imagen 4. Returns base64 PNG. */
export async function generateImage(prompt: string): Promise<ImageResult> {
  if (!imageGenEnabled()) return { ok: false, error: 'Image generation not configured (missing GEMINI_API_KEY).' };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-generate-001:predict?key=${config.geminiApiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: `Imagen API error ${res.status}: ${body.slice(0, 200)}` };
  }

  const data = (await res.json()) as { predictions?: { bytesBase64Encoded?: string }[] };
  const b64 = data.predictions?.[0]?.bytesBase64Encoded;
  if (!b64) return { ok: false, error: 'Imagen returned no image data.' };
  return { ok: true, pngBase64: b64 };
}
