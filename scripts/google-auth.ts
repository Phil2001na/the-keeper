/**
 * One-time Google OAuth2 authorization script.
 *
 * Run once: npm run google-auth
 * It opens your browser, you click Allow, and it prints your GOOGLE_REFRESH_TOKEN.
 * Paste that value into Railway (and into .env for local dev).
 *
 * Requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file first.
 */
import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? '';
const REDIRECT_URI = 'http://localhost:3000';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌  Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
];

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',   // force consent so we always get a refresh_token
  scope: SCOPES,
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Open this URL in your browser:\n');
console.log(' ', authUrl);
console.log('\n  (waiting for Google to redirect to localhost:3000…)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Try to open the browser automatically.
const { exec } = await import('child_process');
exec(`start "" "${authUrl}"`, () => {});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:3000`);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400);
    res.end(`<h2>Authorization failed: ${error}</h2>`);
    console.error('\n❌  Authorization failed:', error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(200);
    res.end('<h2>Waiting for authorization…</h2>');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200);
    res.end('<h2>✅ Authorized! Check your terminal for the refresh token.</h2><p>You can close this tab.</p>');

    console.log('\n✅  Success! Add these to your .env and Railway Variables:\n');
    console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (e) {
    res.writeHead(500);
    res.end(`<h2>Error exchanging code: ${(e as Error).message}</h2>`);
    console.error('\n❌  Token exchange failed:', (e as Error).message);
  } finally {
    server.close();
  }
});

server.listen(3000);
