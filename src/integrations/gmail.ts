import { google } from 'googleapis';
import { getOAuth2Client } from './google.js';

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
  return {
    id: messageId,
    threadId: msg.data.threadId ?? '',
    from: headerVal(h, 'From'),
    subject: headerVal(h, 'Subject'),
    date: headerVal(h, 'Date'),
    snippet: msg.data.snippet ?? '',
    body: extractBody(msg.data.payload as Parameters<typeof extractBody>[0]).slice(0, 8000),
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
