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

// Which API serves the agent's "brain":
//   anthropic   → Claude, native (full fidelity + prompt caching)
//   gemini      → Gemini direct, via Google's OpenAI-compatible endpoint,
//                 reusing GEMINI_API_KEY. Cheapest path — no extra account.
//   openrouter  → any model (GPT-5-mini, etc.) over OpenRouter.
//   openai      → GPT direct, using OPENAI_API_KEY.
// A stopgap when Anthropic credits run dry: the whole keeper — proactivity,
// rituals, continuity — keeps running, just on cheaper tokens.
const modelProvider = optional('MODEL_PROVIDER', 'anthropic');

// Per-provider model defaults (overridable with MODEL / DIGEST_MODEL).
const defaultModel =
  modelProvider === 'gemini'
    ? 'gemini-3.5-flash'
    : modelProvider === 'openrouter'
      ? 'google/gemini-2.5-flash'
      : modelProvider === 'openai'
        ? 'gpt-5.6-luna'
      : 'claude-sonnet-4-6';
const defaultDigestModel =
  modelProvider === 'gemini'
    ? 'gemini-3.5-flash'
    : modelProvider === 'openrouter'
      ? 'google/gemini-2.5-flash'
      : modelProvider === 'openai'
        ? 'gpt-5.6-luna'
      : 'claude-haiku-4-5-20251001';

export const config = {
  modelProvider,
  // Anthropic key is only mandatory when Anthropic is actually the brain.
  anthropicApiKey:
    modelProvider === 'anthropic'
      ? requiredToken('ANTHROPIC_API_KEY')
      : (process.env.ANTHROPIC_API_KEY ?? '').replace(/\s+/g, ''),
  // OpenRouter key is mandatory only when OpenRouter is the brain.
  openrouterApiKey:
    modelProvider === 'openrouter'
      ? requiredToken('OPENROUTER_API_KEY')
      : (process.env.OPENROUTER_API_KEY ?? '').replace(/\s+/g, ''),
  openaiApiKey:
    modelProvider === 'openai'
      ? requiredToken('OPENAI_API_KEY')
      : (process.env.OPENAI_API_KEY ?? '').replace(/\s+/g, ''),
  // Model id; defaults follow the provider. Override to flip models, no code —
  // except Gemini, which is pinned to the regular (flash) model, never pro.
  model: modelProvider === 'gemini' ? defaultModel : optional('MODEL', defaultModel),
  reasoningEffort: optional('MODEL_REASONING_EFFORT', 'high'),

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

  // Enables image generation via Imagen 4 — and, when MODEL_PROVIDER=gemini,
  // it's also the agent's brain key (Google's OpenAI-compatible endpoint).
  geminiApiKey:
    modelProvider === 'gemini'
      ? requiredToken('GEMINI_API_KEY')
      : (process.env.GEMINI_API_KEY ?? '').replace(/\s+/g, ''),

  // Optional: enables Gmail + Google Drive access. Run `npm run google-auth`
  // once to get the refresh token, then add all three to .env and Railway.
  googleClientId: (process.env.GOOGLE_CLIENT_ID ?? '').replace(/\s+/g, ''),
  googleClientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? '').replace(/\s+/g, ''),
  googleRefreshToken: (process.env.GOOGLE_REFRESH_TOKEN ?? '').replace(/\s+/g, ''),

  // Optional deploy-only guest bots (Philip's brother, friends). See GuestBot.
  guestBots: parseGuestBots(),

  // Optional: enables the web UI. Set a long random string; the browser asks
  // for it once. Leave blank to run Telegram-only (no HTTP server at all).
  webToken: (process.env.KEEPER_WEB_TOKEN ?? '').trim(),

  // Web Push (browser notifications). All optional: with none of these set the
  // server mints a keypair on first boot and stores it in keeper_settings, so
  // notifications work without a dashboard step. Set them explicitly only to
  // pin a pair you already have — CHANGING an existing pair unsubscribes every
  // installed device, since a subscription is bound to the key that made it.
  vapidPublicKey: (process.env.VAPID_PUBLIC_KEY ?? '').replace(/\s+/g, ''),
  vapidPrivateKey: (process.env.VAPID_PRIVATE_KEY ?? '').replace(/\s+/g, ''),
  // Contact address push services use to report abuse. Must be a mailto: or
  // https: URL — they reject anything else.
  vapidSubject: optional('VAPID_SUBJECT', 'mailto:philipkantewa@gmail.com'),
  // Railway injects PORT automatically when the service has a domain.
  port: intEnv('PORT', 8080),

  timezone: optional('TIMEZONE', 'Africa/Windhoek'),
  quietStart: intEnv('QUIET_START', 23),
  quietEnd: intEnv('QUIET_END', 7),
  dueCheckIntervalMs: intEnv('DUE_CHECK_INTERVAL_MS', 60_000),
  historyLimit: intEnv('HISTORY_LIMIT', 30),

  // The conversation window is ANCHORED, not sliding: every message since the
  // rolling-digest anchor rides in context verbatim (append-only, so it prompt-
  // caches), until more than foldAt have piled up — then the oldest are folded
  // into the digest by a cheap model, keeping the newest keepRecent in raw view.
  digestModel: optional('DIGEST_MODEL', defaultDigestModel),
  foldAt: intEnv('FOLD_AT', 60),
  keepRecent: intEnv('KEEP_RECENT', 30),

  // Local hour (0–23) at which the agent runs its private nightly reflection:
  // consolidates memory, reviews how its reach-outs landed, writes its journal.
  reflectionHour: intEnv('REFLECTION_HOUR', 22),
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

/** Local calendar date as YYYY-MM-DD in the configured timezone. */
export function localDateString(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
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

/** Short local weekday for a date, e.g. "Wed", in the configured timezone. */
function localWeekday(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, weekday: 'short' }).format(date);
}

/** Lowercase 3-letter local weekday, e.g. "sun" — for cadence gating. */
export function localWeekdayShort(date = new Date()): string {
  return localWeekday(date).toLowerCase().slice(0, 3);
}

/**
 * Explicit relative-day anchor for the agent's situational awareness. The
 * conversation window and archive are stamped in UTC, but he lives in local
 * time — so "today / tomorrow / yesterday" must be reckoned against THESE local
 * dates, not a UTC clock that can be a day off either side of midnight. Keeps
 * the keeper from asking about an event before it has actually happened.
 */
export function relativeDayContext(date = new Date()): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const yest = new Date(date.getTime() - dayMs);
  const tom = new Date(date.getTime() + dayMs);
  return (
    `today is ${localWeekday(date)} ${localDateString(date)} local` +
    ` · tomorrow ${localWeekday(tom)} ${localDateString(tom)}` +
    ` · yesterday ${localWeekday(yest)} ${localDateString(yest)}`
  );
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
