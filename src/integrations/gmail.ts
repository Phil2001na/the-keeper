import { google } from 'googleapis';
import mammoth from 'mammoth';
import { getOAuth2Client } from './google.js';
import { extractPdfTextFromBuffer } from '../telegram/parsePdf.js';

function client() {
  return google.gmail({ version: 'v1', auth: getOAuth2Client() });
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface EmailFull extends EmailSummary {
  body: string;
  attachments: EmailAttachment[];
}

export interface EmailAttachment { filename: string; mimeType: string; content?: string; note?: string; }
type GmailPart = { mimeType?: string | null; filename?: string | null; body?: { attachmentId?: string | null; data?: string | null; size?: number | null } | null; parts?: GmailPart[] | null; };
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_TEXT_CHARS = 20_000;
const MAX_TOTAL_ATTACHMENT_TEXT_CHARS = 60_000;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function readableAttachmentType(mimeType: string, filename: string): 'pdf' | 'docx' | 'text' | null {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  if (mimeType === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === '.docx') return 'docx';
  if (mimeType.startsWith('text/') || ['application/json', 'application/xml', 'application/javascript'].includes(mimeType) || ['.csv', '.tsv', '.txt', '.md', '.json', '.xml', '.html', '.htm'].includes(ext)) return 'text';
  return null;
}
function attachmentParts(payload: GmailPart | null | undefined): GmailPart[] {
  if (!payload) return [];
  const children = (payload.parts ?? []).flatMap((part) => attachmentParts(part));
  return payload.filename && (payload.body?.attachmentId || payload.body?.data) ? [payload, ...children] : children;
}
async function readAttachment(gmail: ReturnType<typeof client>, messageId: string, part: GmailPart): Promise<EmailAttachment> {
  const filename = part.filename ?? 'attachment';
  const mimeType = (part.mimeType ?? '').toLowerCase();
  const type = readableAttachmentType(mimeType, filename);
  if (!type) return { filename, mimeType, note: 'Unsupported attachment type (available: PDFs, .docx, and text files).' };
  if ((part.body?.size ?? 0) > MAX_ATTACHMENT_BYTES) return { filename, mimeType, note: 'Attachment is larger than 15 MB, so it was not downloaded.' };
  const attachmentId = part.body?.attachmentId;
  const data = attachmentId ? (await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId })).data.data : part.body?.data;
  if (!data) return { filename, mimeType, note: 'Attachment had no readable data.' };
  const buffer = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  let text: string;
  if (type === 'pdf') { const pdf = await extractPdfTextFromBuffer(buffer); text = `(${pdf.pages} page${pdf.pages === 1 ? '' : 's'})\n\n${pdf.text}${pdf.truncated ? '\n\n(note: PDF was long — only the first ~24k characters are included)' : ''}`; }
  else if (type === 'docx') text = (await mammoth.extractRawText({ buffer })).value;
  else text = buffer.toString('utf-8');
  const clean = text.trim();
  return { filename, mimeType, content: clean.slice(0, MAX_ATTACHMENT_TEXT_CHARS) || '(No extractable text found.)', note: clean.length > MAX_ATTACHMENT_TEXT_CHARS ? 'Document was long — this excerpt was truncated.' : undefined };
}

function headerVal(headers: { name?: string | null; value?: string | null }[], name: string): string {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBody(data?: string | null): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractBody(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: unknown[];
} | null | undefined): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return decodeBody(payload.body.data);
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return decodeBody(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (payload.parts) {
    for (const part of payload.parts as typeof payload[]) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return '';
}

/** List recent inbox messages, optionally filtered by a Gmail search query. */
export async function listEmails(query = 'in:inbox', maxResults = 10): Promise<EmailSummary[]> {
  const gmail = client();
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  const messages = list.data.messages ?? [];
  const results: EmailSummary[] = [];
  for (const msg of messages) {
    if (!msg.id) continue;
    const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const h = full.data.payload?.headers ?? [];
    results.push({
      id: msg.id,
      threadId: msg.threadId ?? '',
      from: headerVal(h, 'From'),
      subject: headerVal(h, 'Subject'),
      date: headerVal(h, 'Date'),
      snippet: full.data.snippet ?? '',
    });
  }
  return results;
}

/** Read a full email by message id. */
export async function readEmail(messageId: string): Promise<EmailFull> {
  const gmail = client();
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const h = msg.data.payload?.headers ?? [];
  const parts = attachmentParts(msg.data.payload as GmailPart);
  const attachments: EmailAttachment[] = [];
  let totalChars = 0;
  for (const part of parts.slice(0, MAX_ATTACHMENTS)) {
    const attachment = await readAttachment(gmail, messageId, part);
    if (attachment.content) {
      const remaining = MAX_TOTAL_ATTACHMENT_TEXT_CHARS - totalChars;
      if (remaining <= 0) { attachment.content = undefined; attachment.note = 'Skipped because the email attachment text limit was reached.'; }
      else if (attachment.content.length > remaining) { attachment.content = attachment.content.slice(0, remaining); attachment.note = 'Document was truncated because the email attachment text limit was reached.'; }
      totalChars += attachment.content?.length ?? 0;
    }
    attachments.push(attachment);
  }
  if (parts.length > MAX_ATTACHMENTS) attachments.push({ filename: '', mimeType: '', note: `${parts.length - MAX_ATTACHMENTS} more attachment${parts.length - MAX_ATTACHMENTS === 1 ? '' : 's'} not read (limit: ${MAX_ATTACHMENTS} per email).` });
  return {
    id: messageId,
    threadId: msg.data.threadId ?? '',
    from: headerVal(h, 'From'),
    subject: headerVal(h, 'Subject'),
    date: headerVal(h, 'Date'),
    snippet: msg.data.snippet ?? '',
    body: extractBody(msg.data.payload as Parameters<typeof extractBody>[0]).slice(0, 8000),
    attachments,
  };
}

/** Build a base64url-encoded RFC 822 message for the Gmail API. */
function rawMessage(to: string, subject: string, body: string): string {
  return Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Send an email from Philip's Gmail account. */
export async function sendEmail(to: string, subject: string, body: string): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    const gmail = client();
    const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: rawMessage(to, subject, body) } });
    return { ok: true, messageId: res.data.id ?? undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Save an email as a DRAFT in Philip's Gmail (does NOT send). Lands in his
 * Drafts folder for him to review, tweak, and send himself — the safe default
 * when he hasn't explicitly told the keeper to fire it off.
 */
export async function createDraft(to: string, subject: string, body: string): Promise<{ ok: boolean; draftId?: string; error?: string }> {
  try {
    const gmail = client();
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw: rawMessage(to, subject, body) } },
    });
    return { ok: true, draftId: res.data.id ?? undefined };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
