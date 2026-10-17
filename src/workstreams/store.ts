import { db } from '../db/client.js';
import { empty, type State } from './model.js';
const KEY='workstreams.v1';
export async function readState():Promise<State> {
 const {data,error}=await db.from('keeper_settings').select('value').eq('key',KEY).maybeSingle();
 if(error) throw error;return data?.value as State ?? empty();
}
// One atomic compare-and-swap document. Retried edits cannot erase another turn.
export async function mutate<T>(change:(state:State)=>T):Promise<T> {
 for(let attempt=0;attempt<8;attempt++) {
  const state=await readState();const revision=state.revision;const result=change(state);state.revision++;
  if(JSON.stringify(state).length>4_000_000) throw new Error('Workstreams storage is full; export/archive before adding more');
  if(revision===0) {
   const {error}=await db.from('keeper_settings').insert({key:KEY,value:state,updated_at:new Date().toISOString()});
   if(!error)return result;if(error.code!=='23505')throw error;
  } else {
   const {data,error}=await db.from('keeper_settings').update({value:state,updated_at:new Date().toISOString()}).eq('key',KEY).eq('value->>revision',String(revision)).select('key');
   if(error)throw error;if(data?.length)return result;
  }
 }
 throw new Error('Another update just changed this view. Refresh and retry.');
}
