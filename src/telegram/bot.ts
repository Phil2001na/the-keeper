import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config.js';
import { runAgent } from '../agent/orchestrator.js';
import { transcribeFromUrl, transcriptionEnabled } from './transcribe.js';

/**
 * Telegram transport. Long-polling for local dev — no public URL needed.
 * To deploy behind a webhook later, swap `polling: true` for webhook setup;
 * the agent code below doesn't change.
 */
const bot = new TelegramBot(config.telegramBotToken, { polling: true });
const OWNER = String(config.telegramOwnerChatId);

/** Send a message to the owner. Used by both reactive and proactive paths. */
export async function sendToOwner(text: string): Promise<void> {
  await bot.sendMessage(OWNER, text);
}

/**
 * Resolve an inbound message to plain text. Text messages pass through;
 * voice notes / audio get transcribed via Groq Whisper first.
 * Returns null if there's nothing actionable to send to the agent.
 */
async function extractText(msg: TelegramBot.Message): Promise<string | null> {
  if (msg.text && msg.text.trim()) return msg.text.trim();

  const media = msg.voice ?? msg.audio;
  if (media) {
    if (!transcriptionEnabled()) {
      await sendToOwner(
        "i can't listen to voice notes yet — drop a GROQ_API_KEY in my config and i'll have ears. for now, text me?"
      );
      return null;
    }
    try {
      await bot.sendChatAction(OWNER, 'typing');
      const fileUrl = await bot.getFileLink(media.file_id);
      const transcript = await transcribeFromUrl(fileUrl);
      console.log(`[telegram] transcribed voice note (${transcript.length} chars).`);
      return transcript;
    } catch (err) {
      console.error('[telegram] transcription failed:', err);
      await sendToOwner("i couldn't make out that voice note — mind sending it again or texting it?");
      return null;
    }
  }

  return null; // stickers, photos, etc. — nothing to act on
}

export function startTelegram(): void {
  bot.on('message', async (msg) => {
    const chatId = String(msg.chat.id);
    // Single-user agent: ignore anyone who isn't the owner.
    if (chatId !== OWNER) {
      console.warn(`[telegram] ignoring message from non-owner chat ${chatId}`);
      return;
    }

    const text = await extractText(msg);
    if (!text) return;

    try {
      await bot.sendChatAction(OWNER, 'typing');
      const result = await runAgent({ kind: 'inbound', text });
      if (result.message) await sendToOwner(result.message);
    } catch (err) {
      console.error('[telegram] runAgent failed:', err);
      await sendToOwner('(something glitched on my end — try me again in a sec)');
    }
  });

  bot.on('polling_error', (err) => console.error('[telegram] polling error:', err.message));

  console.log('[telegram] listening (long-polling).');
}
