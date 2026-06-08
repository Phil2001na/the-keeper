/**
 * Side-channel between the agent tool layer and the Telegram bot.
 *
 * When the agent calls generate_image or generate_pdf, the tool generates the
 * media and enqueues it here. After runAgent() returns, the bot drains the
 * queue and sends each item as a Telegram photo/document — cleanly separated
 * from the text reply flow.
 */

export type QueuedMedia =
  | { kind: 'photo'; buffer: Buffer; caption?: string }
  | { kind: 'document'; buffer: Buffer; filename: string; caption?: string };

const queue: QueuedMedia[] = [];

export function enqueueMedia(item: QueuedMedia): void {
  queue.push(item);
}

/** Drain and return all queued media (clears the queue). */
export function drainMedia(): QueuedMedia[] {
  return queue.splice(0, queue.length);
}
