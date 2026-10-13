import { bus } from './bus.js';
import { pcEvents, type PcEvent } from './pcBridge.js';
import { interactions } from '../db/repositories.js';

/**
 * Fold PC sessions into the one Keeper conversation.
 *
 *  - Web: every step becomes a step chip; start/finish become agent messages.
 *  - Memory: start and finish are logged to keeper_interactions, so the brain
 *    can answer "did the solarize fix land?" from the archive later.
 *
 * Telegram (approval buttons, finish ping) is wired in telegram/bot.ts. Web
 * messages here carry source 'inbound:pc' so push.ts does not buzz the phone a
 * second time for something Telegram already delivered.
 */
export function attachPcToKeeper(): void {
  pcEvents.on('event', (e: PcEvent) => {
    if (e.type !== 'job') return;
    const { job, event } = e;
    const ts = new Date(event.at).toISOString();
    const say = (content: string) => {
      bus.publish({ type: 'message', role: 'agent', content, ts, source: 'inbound:pc' });
      void interactions
        .log({ role: 'agent', content, trigger: `pc:${job.id}` })
        .catch((err) => console.error('[pc] failed to log to chat history:', err));
    };

    switch (event.kind) {
      case 'started':
        say(`[PC] Claude started on ${job.project} (session ${job.id}): ${job.task.slice(0, 300)}`);
        break;
      case 'step':
      case 'text':
      case 'decided':
        bus.publish({ type: 'step', label: `${job.project}: ${(event.text ?? '').slice(0, 120)}`, tool: 'pc_session' });
        break;
      case 'approval':
        bus.publish({ type: 'step', label: `${job.project}: needs your OK: ${(event.text ?? '').slice(0, 100)}`, tool: 'pc_session' });
        break;
      case 'screenshot':
        bus.publish({ type: 'media', kind: 'photo', url: `/pc/shot/${job.id}-${event.at}`, filename: `${job.project}.jpg`, mime: 'image/jpeg' });
        break;
      case 'done':
        say(`[PC] Claude finished on ${job.project} (session ${job.id}).\n\n${(event.text ?? '(no summary)').slice(0, 3500)}`);
        break;
      case 'error':
        say(`[PC] Claude session ${job.id} on ${job.project} ${job.status === 'stopped' ? 'was stopped' : 'failed'}: ${(event.text ?? '').slice(0, 800)}`);
        break;
    }
  });
}
