export interface MarkdownGenerateResult {
  ok: boolean;
  buffer?: Buffer;
  error?: string;
}

/**
 * Build a .md file from a title + body.
 *
 * The counterpart to generatePdf: same input, but the file stays editable and
 * pastes cleanly into anything that speaks markdown. The only shaping done
 * here is the title — if the body already opens with its own `# heading` the
 * title isn't repeated, so asking for a document doesn't produce two of them.
 */
export function generateMarkdown(title: string, body: string): MarkdownGenerateResult {
  try {
    const text = (body ?? '').replace(/\r\n/g, '\n').trim();
    const hasOwnHeading = /^#\s+\S/.test(text);
    const head = title && !hasOwnHeading ? `# ${title.trim()}\n\n` : '';
    return { ok: true, buffer: Buffer.from(head + text + '\n', 'utf-8') };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Turn a title or requested name into a safe, lowercase file stem. */
export function slugifyFilename(raw: string | undefined, fallback: string): string {
  const stem = (raw ?? '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return stem || fallback;
}
