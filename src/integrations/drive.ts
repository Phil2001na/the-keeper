import { google } from 'googleapis';
import { getOAuth2Client } from './google.js';

function client() {
  return google.drive({ version: 'v3', auth: getOAuth2Client() });
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: string;
}

const READABLE_MIME_TYPES = new Set([
  'text/plain',
  'text/html',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/x-javascript',
  'text/javascript',
]);

const EXPORT_MAP: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** List files in Drive, optionally filtered by a Drive query string. */
export async function listDriveFiles(query?: string, maxResults = 15): Promise<DriveFile[]> {
  const drive = client();
  const res = await drive.files.list({
    q: query ?? "trashed = false",
    pageSize: maxResults,
    fields: 'files(id,name,mimeType,modifiedTime,size)',
    orderBy: 'modifiedTime desc',
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? '',
    name: f.name ?? '',
    mimeType: f.mimeType ?? '',
    modifiedTime: f.modifiedTime ?? '',
    size: f.size ?? undefined,
  }));
}

/** Read the text content of a Drive file (supports Docs/Sheets/plain text). */
export async function readDriveFile(fileId: string): Promise<{ ok: boolean; content?: string; name?: string; error?: string }> {
  const drive = client();
  try {
    const meta = await drive.files.get({ fileId, fields: 'name,mimeType' });
    const name = meta.data.name ?? fileId;
    const mime = meta.data.mimeType ?? '';

    // Google Workspace docs need to be exported as plain text.
    const exportMime = EXPORT_MAP[mime];
    if (exportMime) {
      const res = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: 'text' });
      const text = String(res.data).slice(0, 20_000);
      return { ok: true, name, content: text };
    }

    if (READABLE_MIME_TYPES.has(mime)) {
      const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
      const text = String(res.data).slice(0, 20_000);
      return { ok: true, name, content: text };
    }

    return { ok: false, error: `File "${name}" is a ${mime} — I can only read text, Docs, Sheets, and Slides.` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
