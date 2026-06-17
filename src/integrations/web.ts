import { extractPdfTextFromBuffer } from '../telegram/parsePdf.js';

/**
 * Fetch a live web page and return readable text for the model — Jarvis's eyes
 * on the open internet (job boards, articles, company pages, docs, prices).
 *
 * Deliberately dependency-free and free to run: a plain HTTP GET with a
 * browser-like User-Agent, then a lightweight HTML→text reduction. It does NOT
 * run JavaScript, so heavily client-rendered or bot-walled sites (LinkedIn,
 * Indeed) will often return a login/block page rather than content — that's a
 * limitation of free fetching, not a bug. Most of the open web works fine.
 */

const MAX_CHARS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024; // 4MB — don't swallow huge assets
const TIMEOUT_MS = 20_000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface FetchResult {
  ok: boolean;
  url?: string;
  title?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
}

/** Block obviously-internal targets (basic SSRF guard for a single-user agent). */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  // IPv4 private / loopback / link-local ranges
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/** Reduce an HTML document to readable plain text + its <title>. */
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1] ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ').trim()) : '';

  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|head|nav|footer|header|form|button)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');

  s = decodeEntities(s)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: s };
}

/** Read a response body up to MAX_BYTES, then stop. */
async function readCapped(res: Response): Promise<Buffer> {
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > MAX_BYTES ? buf.subarray(0, MAX_BYTES) : buf;
}

export async function fetchUrl(rawUrl: string): Promise<FetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: `"${rawUrl}" is not a valid URL.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `Only http/https URLs are supported, got "${url.protocol}".` };
  }
  if (isBlockedHost(url.hostname)) {
    return { ok: false, error: 'That host is internal/private — refusing to fetch it.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      const hint =
        res.status === 999 || res.status === 403 || res.status === 401
          ? ' (this site is blocking automated access — common for LinkedIn/Indeed; try a different source)'
          : '';
      return { ok: false, url: res.url, error: `HTTP ${res.status} ${res.statusText}${hint}` };
    }

    const ctype = (res.headers.get('content-type') ?? '').toLowerCase();
    const bytes = await readCapped(res);

    let title = '';
    let text: string;
    if (ctype.includes('application/pdf')) {
      const pdf = await extractPdfTextFromBuffer(bytes);
      text = pdf.text;
    } else if (ctype.includes('html') || ctype.includes('xml')) {
      const reduced = htmlToText(bytes.toString('utf-8'));
      title = reduced.title;
      text = reduced.text;
    } else if (ctype.includes('json') || ctype.startsWith('text/')) {
      text = bytes.toString('utf-8');
    } else {
      return { ok: false, url: res.url, error: `Unsupported content type "${ctype || 'unknown'}".` };
    }

    text = text.trim();
    if (!text) return { ok: false, url: res.url, error: 'Page fetched but no readable text found (likely JS-rendered or blocked).' };

    const truncated = text.length > MAX_CHARS;
    return {
      ok: true,
      url: res.url,
      title: title || undefined,
      text: truncated ? text.slice(0, MAX_CHARS) : text,
      truncated,
    };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? `timed out after ${TIMEOUT_MS / 1000}s` : (e as Error).message;
    return { ok: false, error: `Couldn't fetch that: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
