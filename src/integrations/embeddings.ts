import { config } from '../config.js';

const MODEL = 'text-embedding-004';

export async function embed(text: string): Promise<number[] | null> {
  if (!config.geminiApiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent?key=${config.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${MODEL}`,
          content: { parts: [{ text: text.slice(0, 2000) }] },
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as { embedding?: { values?: number[] } };
    return data.embedding?.values ?? null;
  } catch {
    return null;
  }
}
