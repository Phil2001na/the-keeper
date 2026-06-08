import PDFDocument from 'pdfkit';

export interface PdfGenerateResult {
  ok: boolean;
  buffer?: Buffer;
  error?: string;
}

/**
 * Generate a PDF from a title + body text. Returns the PDF as a Buffer.
 * The agent calls this when Philip asks it to produce a document.
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
        doc.fontSize(20).font('Helvetica-Bold').text(title, { align: 'left' });
        doc.moveDown(0.8);
      }
      doc.fontSize(12).font('Helvetica').text(body, { lineGap: 4 });
      doc.end();
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message });
    }
  });
}
