import PDFDocument from 'pdfkit';

export interface PdfGenerateResult {
  ok: boolean;
  buffer?: Buffer;
  error?: string;
}

/**
 * Generate a PDF from a title + body. Returns the PDF as a Buffer.
 *
 * The body is treated as markdown, because that is what the model writes
 * whether or not you ask it to. Rendering it raw put literal `##` and `**`
 * in the finished document. This understands the subset that actually shows
 * up in the keeper's output: headings, bullet and numbered lists, block
 * quotes, fenced code, horizontal rules, and inline bold / italic / code.
 * Anything it doesn't recognise falls through as a normal paragraph, so an
 * unsupported construct degrades to plain text rather than breaking.
 */
export async function generatePdf(title: string, body: string): Promise<PdfGenerateResult> {
  return new Promise((resolve) => {
    try {
      const doc = new PDFDocument({ margin: 60, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve({ ok: true, buffer: Buffer.concat(chunks) }));
      doc.on('error', (e: Error) => resolve({ ok: false, error: e.message }));

      if (title) {
        doc.fontSize(22).font('Helvetica-Bold').fillColor('#111111').text(title);
        doc.moveDown(0.7);
      }
      renderMarkdown(doc, body ?? '');
      doc.end();
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message });
    }
  });
}

const BODY_SIZE = 11.5;
const HEADING_SIZES: Record<number, number> = { 1: 18, 2: 15, 3: 13 };

type Doc = InstanceType<typeof PDFDocument>;

/** One stretch of inline text plus the styling that applies to it. */
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * Split a line into styled runs. Deliberately single-pass and non-nesting:
 * `**bold `code`**` renders as bold then code rather than both at once, which
 * is a fair trade for not hand-rolling a real markdown parser here.
 */
function inlineRuns(line: string): Run[] {
  const runs: Run[] = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*]+)\*|_([^_]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(line)) !== null) {
    if (m.index > last) runs.push({ text: line.slice(last, m.index) });
    const bold = m[1] ?? m[2];
    const code = m[3];
    const italic = m[4] ?? m[5];
    if (bold !== undefined) runs.push({ text: bold, bold: true });
    else if (code !== undefined) runs.push({ text: code, code: true });
    else runs.push({ text: italic ?? '', italic: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last) });
  return runs.length ? runs : [{ text: line }];
}

function fontFor(run: Run): string {
  if (run.code) return 'Courier';
  if (run.bold) return 'Helvetica-Bold';
  if (run.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/** Write a line of runs, keeping them on one flowing paragraph. */
function writeRuns(doc: Doc, runs: Run[], opts: PDFKit.Mixins.TextOptions = {}): void {
  runs.forEach((run, i) => {
    doc.font(fontFor(run)).fillColor(run.code ? '#9a3412' : '#111111');
    doc.text(run.text, { ...opts, continued: i < runs.length - 1 });
  });
  doc.fillColor('#111111');
}

function renderMarkdown(doc: Doc, body: string): void {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code — consume through the closing fence (or the end of input).
    const fence = line.match(/^\s*```/);
    if (fence) {
      const block: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) block.push(lines[i++] ?? '');
      i++; // closing fence
      doc.moveDown(0.3);
      doc.font('Courier').fontSize(BODY_SIZE - 1).fillColor('#1f2937');
      doc.text(block.join('\n'), { lineGap: 2, indent: 12 });
      doc.fillColor('#111111');
      doc.moveDown(0.6);
      continue;
    }

    i++;

    if (!line.trim()) {
      doc.moveDown(0.5);
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      doc.moveDown(0.3);
      const y = doc.y;
      doc
        .strokeColor('#d4d4d8')
        .lineWidth(1)
        .moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .stroke();
      doc.moveDown(0.7);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      doc.moveDown(0.5);
      doc.fontSize(HEADING_SIZES[(heading[1] ?? '#').length] ?? HEADING_SIZES[3]!);
      writeRuns(doc, inlineRuns(heading[2] ?? '').map((r) => ({ ...r, bold: true })));
      doc.moveDown(0.35);
      doc.fontSize(BODY_SIZE);
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const depth = Math.min(Math.floor((bullet[1] ?? '').length / 2), 3);
      doc.fontSize(BODY_SIZE);
      writeRuns(doc, [{ text: '•  ' }, ...inlineRuns(bullet[2] ?? '')], {
        indent: 12 + depth * 14,
        lineGap: 3,
      });
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (numbered) {
      const depth = Math.min(Math.floor((numbered[1] ?? '').length / 2), 3);
      doc.fontSize(BODY_SIZE);
      writeRuns(doc, [{ text: (numbered[2] ?? '') + '.  ' }, ...inlineRuns(numbered[3] ?? '')], {
        indent: 12 + depth * 14,
        lineGap: 3,
      });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      doc.fontSize(BODY_SIZE);
      writeRuns(doc, inlineRuns(quote[1] ?? '').map((r) => ({ ...r, italic: !r.code })), {
        indent: 18,
        lineGap: 3,
      });
      continue;
    }

    doc.fontSize(BODY_SIZE);
    writeRuns(doc, inlineRuns(line), { lineGap: 3 });
  }
}
