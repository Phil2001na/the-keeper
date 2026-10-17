import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const streamInput = z.object({ title: z.string().trim().min(1).max(100), parentId: z.string().uuid().nullable().default(null), aliases: z.array(z.string().trim().min(3).max(60)).max(8).default([]) }).strict();
export const snapshotInput = z.object({ status: z.enum(['active','waiting','parked','done']), where: z.string().max(1000), done: z.string().max(1000), blocked: z.string().max(1000), next: z.string().max(1000), owner: z.string().max(100) }).strict();
export const eventInput = z.object({ streamId: z.string().uuid().nullable(), kind: z.enum(['update','decision','result','blocker','next','correction']), text: z.string().trim().min(1).max(20000), certainty: z.enum(['reported','suggested','confirmed']).default('reported'), source: z.string().max(150).default('Philip'), sourceKey: z.string().max(200).optional(), artifact: z.string().url().max(1000).optional() }).strict().refine(v => !v.artifact || /^https?:\/\//.test(v.artifact), 'Artifact must use HTTP(S)');
export type Snapshot = z.infer<typeof snapshotInput>;
export type Workstream = z.infer<typeof streamInput> & Snapshot & { id: string; updatedAt: string };
// brief: the two-line timeline summary, written after the fact by the digest model.
// `stop` is why the thread paused (blocker, waiting on Philip) or null when it simply finished.
export type Brief = { what: string; stop: string | null; state: 'done' | 'stopped' | 'info' };
export type WorkEvent = z.infer<typeof eventInput> & { id: string; at: string; brief?: Brief; revisions: { at: string; text: string; streamId: string | null; certainty: string }[] };
export type State = { revision: number; streams: Workstream[]; events: WorkEvent[]; bindings: Record<string,string> };
export const empty = (): State => ({ revision: 0, streams: [], events: [], bindings: {} });
export function createStream(state: State, raw: unknown) {
 const input=streamInput.parse(raw);
 if(input.parentId && !state.streams.some(s=>s.id===input.parentId && !s.parentId)) throw new Error('Choose an existing top-level area');
 const stream:Workstream={...input,id:randomUUID(),status:'active',where:'No confirmed status yet.',done:'',blocked:'',next:'',owner:'Unassigned',updatedAt:new Date().toISOString()};
 state.streams.push(stream); return stream;
}
export function route(state: State, text: string): string | null {
 const lower=text.toLowerCase();
 const hits=state.streams.filter(s=>s.status!=='done' && [s.title,...s.aliases].some(a=>lower.includes(a.toLowerCase())));
 // A specific application wins over its area; unrelated matches go to inbox.
 const specific=hits.filter(s=>!hits.some(child=>child.parentId===s.id));
 return specific.length===1?specific[0]!.id:null;
}
export function appendEvent(state: State, raw: unknown) {
 const input=eventInput.parse(raw);
 if(input.streamId && !state.streams.some(s=>s.id===input.streamId)) throw new Error('Workstream not found');
 const existing=input.sourceKey && state.events.find(e=>e.sourceKey===input.sourceKey);
 if(existing) return existing;
 const event:WorkEvent={...input,id:randomUUID(),at:new Date().toISOString(),revisions:[]};state.events.push(event);
 const stream=state.streams.find(s=>s.id===input.streamId);if(stream)stream.updatedAt=event.at;
 return event;
}
export function correctEvent(state: State, id: string, raw: unknown) {
 const patch=z.object({streamId:z.string().uuid().nullable(),text:z.string().trim().min(1).max(20000),certainty:z.enum(['reported','suggested','confirmed'])}).strict().parse(raw);
 const event=state.events.find(e=>e.id===id);if(!event) throw new Error('Update not found');
 if(patch.streamId && !state.streams.some(s=>s.id===patch.streamId)) throw new Error('Workstream not found');
 event.revisions.push({at:new Date().toISOString(),text:event.text,streamId:event.streamId,certainty:event.certainty});
 if(patch.text!==event.text)delete event.brief;Object.assign(event,patch);return event;
}
/** Entries that are bookkeeping, not work — summarised without a model call. */
export function fixedBrief(e: WorkEvent): Brief | null {
  if (e.kind === 'correction' && e.text.startsWith('Snapshot updated by Philip')) return { what: 'You updated where this stands', stop: null, state: 'info' };
  if (/^Session closed\. Nothing was running/.test(e.text)) return { what: `${e.source.replace(/^agent:/, '')} session closed`, stop: null, state: 'info' };
  return null;
}
