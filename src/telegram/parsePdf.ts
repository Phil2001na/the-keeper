import { PDFParse } from 'pdf-parse';

const MAX_CHARS = 24_000;

export interface PdfResult {
  text: string;
  pages: number;
  truncated: boolean;
}

/** Download a PDF from a URL and return its extracted text. */
export async function extractPdfText(url: string): Promise<PdfResult> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();

  const full = result.text.trim();
  const truncated = full.length > MAX_CHARS;
  return {
    text: truncated ? full.slice(0, MAX_CHARS) : full,
    pages: result.total,
    truncated,
  };
}
