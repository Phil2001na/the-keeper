import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';

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
  /**
   * `id` lets the page tell overlapping turns apart (a crew report can land
   * while he's mid-conversation) instead of the second start orphaning the
   * first rail, still "thinking" forever.
   */
  | { type: 'turn'; phase: 'start' | 'end'; source: string; id: string; startedAt: number }
  /** `turn` is stamped from the async context by publish(); PC chips have none. */
  | { type: 'step'; label: string; tool: string; turn?: string }
  /**
   * Sent once to each new SSE client: the turns running right now. An `end`
   * missed during a reconnect or a redeploy would otherwise leave the page
   * busy forever; this is what lets it reconcile.
   */
  | { type: 'sync'; turns: LiveTurn[] }
  /**
   * `source` is what the turn was: 'inbound:web', 'inbound:telegram' or
   * 'touchpoint'. Required rather than optional on purpose — src/web/push.ts
   * decides whether to buzz his phone from it, and a forgotten field would
   * either silence proactive reach-outs or notify him about his own replies.
   */
  | { type: 'message'; role: 'user' | 'agent'; content: string; ts: string; source: string }
  | { type: 'card'; card: PresentCard }
  /**
   * `url` points at the served copy in src/web/files.ts rather than carrying a
   * base64 data: URL inline — that is what makes a generated file actually
   * downloadable in the installed PWA (iOS ignores `download` on data: URLs).
   */
  | { type: 'media'; kind: 'photo' | 'document'; url: string; filename?: string; mime?: string; bytes?: number };

export interface LiveTurn {
  id: string;
  source: string;
  startedAt: number;
  label?: string;
  tool?: string;
}

/** Which turn the current async call chain belongs to — see runAgent. */
export const turnScope = new AsyncLocalStorage<string>();

class KeeperBus extends EventEmitter {
  private live = new Map<string, LiveTurn>();

  publish(event: KeeperEvent): void {
    if (event.type === 'turn') {
      if (event.phase === 'start') this.live.set(event.id, { id: event.id, source: event.source, startedAt: event.startedAt });
      else this.live.delete(event.id);
    } else if (event.type === 'step') {
      event = { ...event, turn: event.turn ?? turnScope.getStore() };
      const t = event.turn && this.live.get(event.turn);
      if (t) Object.assign(t, { label: event.label, tool: event.tool });
    }
    this.emit('event', event);
  }

  liveTurns(): LiveTurn[] {
    return [...this.live.values()];
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
  start_claude_session: 'starting Claude on the PC',
  claude_sessions: 'checking the PC',
  delegate_to_prime: 'handing it to Meeseeks Prime',
  add_crew_lesson: 'writing a lesson down for the crew',
  crew_lessons: 'reading the crew lessons',
  stop_claude_session: 'stopping a PC session',
  continue_claude_session: 'sending a follow-up to a PC session',
  pc_session: 'PC',
  recall_facts: 'consulting my memory',
  remember_fact: 'committing that to memory',
  forget_fact: 'letting go of a stale note',
  update_domain: 'reshaping a sector',
  create_domain: 'opening a new sector',
  search_history: 'reaching into the archive',
  log_observation: 'noting a number',
  query_observations: 'reading the trends',
  set_goal: 'setting a goal',
  update_goal: 'updating a goal',
  write_journal: 'writing in my journal',
  update_portrait: 'redrawing how i see him',
  watch_thread: 'noting something to watch',
  update_thread: 'updating what i\'m watching',
  schedule_touchpoint: 'planning when to resurface',
  cancel_touchpoint: 'rearranging my plans',
  stay_silent: 'choosing silence',
  list_emails: 'going through the inbox',
  read_email: 'reading an email',
  draft_email: 'drafting the email',
  send_email: 'sending the email',
  list_drive_files: 'looking through the drive',
  read_drive_file: 'reading a file',
  create_drive_file: 'saving to drive',
  update_drive_file: 'updating the file',
  deploy_html: 'publishing the site',
  list_sites: 'checking the sites',
  check_site_status: 'checking the build',
  rename_site: 'renaming the site',
  delete_site: 'removing the site',
  generate_image: 'painting something',
  generate_pdf: 'drafting the document',
  generate_markdown: 'writing the file',
  web_search: 'searching the web',
  fetch_url: 'opening a web page',
  present: 'arranging a view',
};

export function stepLabel(toolName: string): string {
  return STEP_LABELS[toolName] ?? 'working on it';
}
