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

export const config = {
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  model: optional('MODEL', 'claude-sonnet-4-6'),

  // Optional: enables voice-note transcription. If unset, voice notes get a
  // friendly "I can't hear that yet" reply instead of crashing.
  groqApiKey: process.env.GROQ_API_KEY?.trim() || '',
  groqTranscribeModel: optional('GROQ_TRANSCRIBE_MODEL', 'whisper-large-v3'),

  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramOwnerChatId: required('TELEGRAM_OWNER_CHAT_ID'),

  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceKey: required('SUPABASE_SERVICE_KEY'),

  timezone: optional('TIMEZONE', 'Africa/Windhoek'),
  quietStart: intEnv('QUIET_START', 23),
  quietEnd: intEnv('QUIET_END', 7),
  dueCheckIntervalMs: intEnv('DUE_CHECK_INTERVAL_MS', 60_000),
  historyLimit: intEnv('HISTORY_LIMIT', 20),
};

/** Current wall-clock hour (0–23) in the configured timezone. */
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
 * Handles windows that wrap past midnight (e.g. 23 → 7).
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
