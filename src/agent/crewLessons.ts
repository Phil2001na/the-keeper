import { randomUUID } from 'node:crypto';
import { settings } from '../db/repositories.js';
import { setCrewLessons } from '../web/pcBridge.js';

/**
 * Lessons for the crew, Boris-style: a mistake is corrected once and written
 * down, so every later agent on the PC starts with it. Stored as one
 * keeper_settings row; every job the relay hands out carries the current list,
 * and pc-agent puts it in the session's system prompt.
 *
 * Written by the Keeper (when Philip corrects how an agent worked) and by
 * Meeseeks Prime (when a worker's mistake is worth never repeating).
 */

export interface CrewLesson {
  id: string;
  text: string;
  from: 'philip' | 'prime';
  at: string;
}

const KEY = 'crew_lessons';
const MAX = 30;
let cache: CrewLesson[] = [];

function publish(): void {
  setCrewLessons(cache.map((l) => l.text), (text) => void addLesson(text, 'prime').catch((e) => console.error('[crew] lesson from Prime not saved:', e)));
}

export async function loadLessons(): Promise<void> {
  try {
    cache = (await settings.get<CrewLesson[]>(KEY)) ?? [];
  } catch (err) {
    console.error('[crew] could not load lessons:', err);
  }
  publish();
}

export function listLessons(): CrewLesson[] {
  return [...cache];
}

export async function addLesson(text: string, from: CrewLesson['from']): Promise<CrewLesson | null> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return null;
  if (cache.some((l) => l.text.toLowerCase() === clean.toLowerCase())) return null;
  const lesson: CrewLesson = { id: randomUUID().slice(0, 8), text: clean, from, at: new Date().toISOString() };
  // Newest wins the cap: an old lesson that still matters can be added again.
  cache = [...cache, lesson].slice(-MAX);
  await settings.set(KEY, cache);
  publish();
  return lesson;
}

export async function forgetLesson(idPrefix: string): Promise<CrewLesson | null> {
  const hits = cache.filter((l) => l.id.startsWith(idPrefix.trim()));
  if (hits.length !== 1) return null;
  cache = cache.filter((l) => l !== hits[0]);
  await settings.set(KEY, cache);
  publish();
  return hits[0]!;
}
