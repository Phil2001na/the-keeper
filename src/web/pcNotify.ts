import { captureReport } from '../workstreams/service.js';
import { bus } from './bus.js';
import { pcEvents, relaysThroughKeeper, type PcEvent } from './pcBridge.js';
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
    if (['done', 'turn_done', 'error'].includes(event.kind)) {
      void captureReport(job, event.text || `Session ended: ${job.status}; no report supplied.`, event.at)
        .catch(err => console.error('[workstreams] report persistence failed', err));
    }
    const say = (content: string) => {
      bus.publish({ type: 'message', role: 'agent', content, ts, source: 'inbound:pc' });
      void interactions
        .log({ role: 'agent', content, trigger: `pc:${job.id}` })
        .catch((err) => console.error('[pc] failed to log to chat history:', err));
    };

    const chip = (label: string) => bus.publish({ type: 'step', label: `${job.name}: ${label.slice(0, 120)}`, tool: 'pc_session' });

    // Workers report to Prime: their steps show as chips, and only a death is said out loud.
    if (job.role === 'worker') {
      if (event.kind === 'error' && job.status === 'failed') say(`[crew] ${job.name} (worker ${job.id}, for Prime) died: ${(event.text ?? '').slice(0, 600)}`);
      else if (event.kind !== 'screenshot') chip(event.kind === 'started' ? `spawned on ${job.project}` : event.kind === 'done' ? 'finished, reported to Prime' : event.text ?? '');
      return;
    }

    switch (event.kind) {
      case 'started':
        say(job.role === 'prime'
          ? `[PC] ${job.name} is online (${job.engine}${job.model ? ` · ${job.model}` : ''}, session ${job.id}): ${job.brief}`
          : `[PC] ${job.name} started on ${job.project} (session ${job.id}): ${job.task.slice(0, 300)}`);
        break;
      case 'step':
      case 'text':
      case 'decided':
        chip(event.text ?? '');
        break;
      case 'approval':
        chip(`needs your OK: ${(event.text ?? '').slice(0, 100)}`);
        break;
      case 'screenshot':
        bus.publish({ type: 'media', kind: 'photo', url: `/pc/shot/${job.id}-${event.at}`, filename: `${job.project}.jpg`, mime: 'image/jpeg' });
        break;
      case 'turn_done':
      case 'done':
        // The Keeper's own retelling (a crew turn) is what lands in the chat; the full report lives in the PC sheet.
        if (relaysThroughKeeper(job, event.text)) chip('reported back (full report in the PC sheet)');
        else say(`[PC] ${job.name} finished ${event.kind === 'turn_done' ? 'this task ' : ''}on ${job.project} (session ${job.id}${event.kind === 'turn_done' ? ', stays open for a follow-up' : ''}).

${(event.text ?? '(no summary)').slice(0, 3500)}`);
        break;
      case 'error':
        say(job.role === 'prime'
          ? `[PC] ${job.name} went offline (session ${job.id}): ${(event.text ?? '').slice(0, 600)}`
          : `[PC] ${job.name} (session ${job.id}) on ${job.project} ${job.status === 'stopped' ? 'was stopped' : 'failed'}: ${(event.text ?? '').slice(0, 800)}`);
        break;
    }
  });
}
