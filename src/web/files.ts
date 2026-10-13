import { randomUUID } from 'node:crypto';

/**
 * A short-lived store for files the agent generates, so the browser can
 * download them from a real URL.
 *
 * Generated media used to ride to the UI as a base64 data: URL on the SSE
 * stream. That works on desktop and nowhere else that matters — iOS Safari
 * ignores the `download` attribute on a data: URL, so in the installed PWA a
 * generated PDF simply couldn't be saved. It also pushed the whole file
 * through the event stream twice over (base64 inflates by a third).
 *
 * These live in memory on purpose. They're a delivery buffer, not storage:
 * the keeper already has Drive and GitHub tools for anything meant to last,
 * and a Railway redeploy would wipe a disk cache just as thoroughly. Old
 * entries are evicted by age and by count so a long-running process can't
 * grow without bound.
 */

export interface StoredFile {
  id: string;
  filename: string;
  mime: string;
  buffer: Buffer;
  createdAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;

const files = new Map<string, StoredFile>();

function evict(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, f] of files) if (f.createdAt < cutoff) files.delete(id);

  // Oldest-first while over either ceiling. Insertion order is age order.
  let total = 0;
  for (const f of files.values()) total += f.buffer.length;
  while (files.size > MAX_FILES || total > MAX_TOTAL_BYTES) {
    const oldest = files.keys().next();
    if (oldest.done) break;
    total -= files.get(oldest.value)?.buffer.length ?? 0;
    files.delete(oldest.value);
  }
}

/** Store a file for download and return its id. */
export function putFile(filename: string, mime: string, buffer: Buffer): string {
  const id = randomUUID();
  files.set(id, { id, filename, mime, buffer, createdAt: Date.now() });
  evict();
  return id;
}

/**
 * Reduce a filename to characters that are safe inside a Content-Disposition
 * header and on every filesystem it might land on. Quotes and backslashes are
 * the ones that actually matter — they'd terminate or escape the header value.
 */
export function safeFilename(name: string, fallback = 'file'): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '');
  return clean || fallback;
}

/** Look up a stored file, or undefined if it never existed or has expired. */
export function getFile(id: string): StoredFile | undefined {
  const hit = files.get(id);
  if (!hit) return undefined;
  if (Date.now() - hit.createdAt > TTL_MS) {
    files.delete(id);
    return undefined;
  }
  return hit;
}
