import { config } from './config.js';
import { ensureAnchor } from './agent/digest.js';
import { startTelegram } from './telegram/bot.js';
import { startScheduler } from './scheduler/dueCheck.js';
import { startWebServer } from './web/server.js';

/**
 * THE KEEPER — entry point.
 * Loading ./config validates that every required env var is present (it throws
 * on boot otherwise), so by the time we start the transport + scheduler we know
 * the environment is wired correctly.
 */
function main() {
  console.log('THE KEEPER — starting up.');
  console.log(`  model: ${config.model}`);
  console.log(`  timezone: ${config.timezone}`);

  // Anchor the conversation window on first boot (no-op once the digest row
  // exists). Until it lands, turns fall back to a plain recency window.
  void ensureAnchor().catch((err) => console.error('[keeper] ensureAnchor failed:', err));

  startTelegram();
  startScheduler();
  startWebServer();

  console.log('THE KEEPER — up. Reactive (Telegram + web) + proactive (scheduler) live.');
}

// The agent is a long-running daemon: a stray Telegram polling error or a
// transient network blip should be logged, not fatal. Keep the process alive.
process.on('unhandledRejection', (reason) => {
  console.error('[keeper] unhandled rejection (continuing):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[keeper] uncaught exception (continuing):', err);
});

main();
