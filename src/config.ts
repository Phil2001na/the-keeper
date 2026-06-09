import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(
      `Missing required env var: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return v.trim();
}

/**
 * Like `required`, but for credentials sent as HTTP headers (API keys, JWTs,
 * bot tokens). These never legitimately contain whitespace, yet copy-paste
 * (e.g. a wrapped line in a hosting dashboard's env editor) can inject a stray
 * newline or zero-width space mid-string â€” which `.trim()` can't remove and
 * which makes `fetch` throw "invalid header value". Strip ALL whitespace.
 */
function requiredToken(name: string): string {
  return required(name).replace(/\s+/g, '');
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

/** GitHub Pages credentials â€” whose account a deploy lands in. */
export interface GithubCreds {
  token: string;
  username: string;
}

/**
 * A "guest" deploy-only bot: a separate Telegram bot, sharing this one app and
 * its Anthropic key, but with NONE of the Keeper's memory/touchpoints. All a
 * guest can do is send an .html file and get back a GitHub Pages link â€” deployed
 * to THEIR own GitHub, never Philip's. This is how Philip lets his brother /
 * friends use the deploy feature without each needing their own Railway.
 */
export interface GuestBot {
  name: string;
  telegramBotToken: string;
  /** Optional: lock the bot to a single Telegram chat id. Blank = anyone who finds it. */
  chatId?: string;
  github: GithubCreds;
}

/**
 * Parse GUEST_BOTS â€” a single JSON-array env var (easy to paste into a hosting
 * dashboard as one variable). Each entry:
 *   { "name": "...", "telegramToken": "...", "githubToken": "...",
 *     "githubUsername": "...", "chatId": "optional" }
 */
function parseGuestBots(): GuestBot[] {
  const rawEnv = (process.env.GUEST_BOTS ?? '').trim();
  if (!rawEnv) return [];
  // Hosting dashboards (e.g. Railway) can inject stray newlines/control chars
  // when pasting a long value. Those are illegal inside JSON string literals and
  // crash JSON.parse ("Bad control character"). Our token/name fields never
  // legitimately contain control chars, so strip them before parsing.
  const raw = rawEnv.replace(/[\x00-\x1F]+/g, '');
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    throw new Error(`GUEST_BOTS must be a valid JSON array. Parse error: ${(e as Error).message}`);
  }
  if (!Array.isArray(arr)) throw new Error('GUEST_BOTS must be a JSON array.');
  return arr.map((g, i) => {
    const o = g as Record<string, unknown>;
    const strip = (v: unknown) => String(v ?? '').replace(/\s+/g, '');
    const telegramBotToken = strip(o.telegramToken ?? o.telegramBotToken);
    if (!telegramBotToken) throw new Error(`GUEST_BOTS[${i}] is missing "telegramToken".`);
    return {
      name: String(o.name ?? `guest-${i + 1}`),
      telegramBotToken,
      chatId: o.chatId ? String(o.chatId).replace(/\s+/g, '') : undefined,
      github: { token: strip(o.githubToken), username: strip(o.githubUsername) },
    };
  });
}

export const config = {
  anthropicApiKey: requiredToken('ANTHROPIC_API_KEY'),
  model: optional('MODEL', 'claude-sonnet-4-6'),

  // Optional: enables voice-note transcription. If unset, voice notes get a
  // friendly "I can't hear that yet" reply instead of crashing.
  groqApiKey: (process.env.GROQ_API_KEY ?? '').replace(/\s+/g, ''),
  groqTranscribeModel: optional('GROQ_TRANSCRIBE_MODEL', 'whisper-large-v3'),

  telegramBotToken: requiredToken('TELEGRAM_BOT_TOKEN'),
  telegramOwnerChatId: requiredToken('TELEGRAM_OWNER_CHAT_ID'),

  supabaseUrl: requiredToken('SUPABASE_URL'),
  supabaseServiceKey: requiredToken('SUPABASE_SERVICE_KEY'),

  // Optional: enables website deploy/management tools (GitHub Pages). If unset,
  // those tools stay dormant and the agent says it can't deploy yet.
  githubToken: (process.env.GITHUB_TOKEN ?? '').replace(/\s+/g, ''),
  githubUsername: (process.env.GITHUB_USERNAME ?? '').replace(/\s+/g, ''),

  // Optional: enables image generation via Imagen 4. Leave blank to disable.
  geminiApiKey: (process.env.GEMINI_API_KEY ?? '').replace(/\s+/g, ''),

  // Optional: enables Gmail + Google Drive access. Run `npm run google-auth`
  // once to get the refresh token, then add all three to .env and Railway.
  googleClientId: (process.env.GOOGLE_CLIENT_ID ?? '').replace(/\s+/g, ''),
  googleClientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? '').replace(/\s+/g, ''),
  googleRefreshToken: (process.env.GOOGLE_REFRESH_TOKEN ?? '').replace(/\s+/g, ''),

  // Optional deploy-only guest bots (Philip's brother, friends). See GuestBot.
  guestBots: parseGuestBots(),

  timezone: optional('TIMEZONE', 'Africa/Windhoek'),
  quietStart: intEnv('QUIET_START', 23),
  quietEnd: intEnv('QUIET_END', 7),
  dueCheckIntervalMs: intEnv('DUE_CHECK_INTERVAL_MS', 60_000),
  historyLimit: intEnv('HISTORY_LIMIT', 20),
};

/** Current wall-clock hour (0â€“23) in the configured timezone. */
export function localHour(date = new Date()): number {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  // "24" can appear at midnight in some environments; normalise to 0.
  const h = parseInt(s, 10);
  return h === 24 ? 0 : h;
}

/** Human-readable current local time, for the agent's situational awareness. */
export function localTimeString(date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * True if `date` falls inside the quiet window (no proactive messages).
 * Handles windows that wrap past midnight (e.g. 23 â†’ 7).
 */
export function isQuietHours(date = new Date()): boolean {
  const h = localHour(date);
  const { quietStart, quietEnd } = config;
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) {
    return h >= quietStart && h < quietEnd;
  }
  // wraps midnight
  return h >= quietStart || h < quietEnd;
}
