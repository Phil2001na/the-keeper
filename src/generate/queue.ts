/**
 * Side-channel between the agent tool layer and whichever surface is listening.
 *
 * When the agent calls generate_image / generate_pdf / generate_markdown, the
 * tool generates the file and enqueues it here. After runAgent() returns, the
 * Telegram bot or the web server drains the queue and delivers each item —
 * cleanly separated from the text reply flow.
 *
 * Documents carry their own mime type: it decides the Content-Type Telegram
 * attaches and the one the browser downloads with, and a .md served as
 * application/pdf opens as garbage.
 */

export type QueuedMedia =
  | { kind: 'photo'; buffer: Buffer; caption?: string }
  | { kind: 'document'; buffer: Buffer; filename: string; mime: string; caption?: string };

const queue: QueuedMedia[] = [];

export function enqueueMedia(item: QueuedMedia): void {
  queue.push(item);
}

/** Drain and return all queued media (clears the queue). */
export function drainMedia(): QueuedMedia[] {
  return queue.splice(0, queue.length);
}
