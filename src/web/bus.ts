import { EventEmitter } from 'node:events';

/**
 * In-process event bus between the agent loop and the web UI.
 *
 * The orchestrator narrates what it's actually doing (turn lifecycle, tool
 * steps, logged messages, generated cards/media); the web server forwards the
 * stream to connected browsers over SSE. Telegram ignores all of this — if no
 * browser is connected, emits are no-ops. Zero extra tokens, zero coupling.
 */

/** A generative card the model asked the UI to render (present tool). */
export interface PresentCard {
  title?: string;
  blocks: unknown[];
}

export type KeeperEvent =
  | { type: 'turn'; phase: 'start' | 'end'; source: string }
  | { type: 'step'; label: string }
  | { type: 'message'; role: 'user' | 'agent'; content: string; ts: string }
  | { type: 'card'; card: PresentCard }
  | { type: 'media'; kind: 'photo' | 'document'; dataUrl: string; filename?: string };

class KeeperBus extends EventEmitter {
  publish(event: KeeperEvent): void {
    this.emit('event', event);
  }
  subscribe(fn: (event: KeeperEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new KeeperBus();

/** Human phrasing for what each tool means the agent is doing right now. */
const STEP_LABELS: Record<string, string> = {
  list_domains: 'consulting my memory',
  recall_facts: 'consulting my memory',
  remember_fact: 'committing that to memory',
  forget_fact: 'letting go of a stale note',
  update_domain: 'reshaping a sector',
  create_domain: 'opening a new sector',
  search_history: 'reaching into the archive',
  write_journal: 'writing in my journal',
  schedule_touchpoint: 'planning when to resurface',
  cancel_touchpoint: 'rearranging my plans',
  stay_silent: 'choosing silence',
  list_emails: 'going through the inbox',
  read_email: 'reading an email',
  send_email: 'sending the email',
  list_drive_files: 'looking through the drive',
  read_drive_file: 'reading a file',
  deploy_html: 'publishing the site',
  list_sites: 'checking the sites',
  check_site_status: 'checking the build',
  rename_site: 'renaming the site',
  delete_site: 'removing the site',
  generate_image: 'painting something',
  generate_pdf: 'drafting the document',
  web_search: 'searching the web',
  present: 'arranging a view',
};

export function stepLabel(toolName: string): string {
  return STEP_LABELS[toolName] ?? 'working on it';
}
