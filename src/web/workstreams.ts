import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { appendEvent, correctEvent, createStream, snapshotInput } from '../workstreams/model.js';
import type { State } from '../workstreams/model.js';
export type WorkStore={readState:()=>Promise<State>;mutate:<T>(change:(s:State)=>T)=>Promise<T>};
export async function workstreamApi(req:IncomingMessage,res:ServerResponse,store:WorkStore) {
 const {mutate,readState}=store;
 const reply=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
 try {
  if(req.method==='GET'){reply(200,await readState());return;}
  if(req.method!=='POST'){reply(405,{error:'Method not allowed'});return;}
  let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>40000){reply(413,{error:'Update too large'});return;}}
  const {action,...input}=JSON.parse(body);
  const result=await mutate(state=>{
   if(action==='create')return createStream(state,input);
   if(action==='event')return appendEvent(state,{...input,source:'Philip'});
   if(action==='correct'){const {id,...patch}=input;return correctEvent(state,z.string().uuid().parse(id),patch);}
   if(action==='snapshot'){
    const {id,revision,...patch}=input;const stream=state.streams.find(s=>s.id===id);if(!stream)throw new Error('Workstream not found');
    if(revision!==state.revision)throw new Error('View changed. Refresh before saving your snapshot.');
    const before=JSON.stringify(stream);Object.assign(stream,snapshotInput.parse(patch),{updatedAt:new Date().toISOString()});
    appendEvent(state,{streamId:id,kind:'correction',text:`Snapshot updated by Philip. Previous snapshot: ${before}`,certainty:'confirmed',source:'Philip'});return stream;
   }
   throw new Error('Unknown action');
  });reply(200,{ok:true,result});
 }catch(error){reply(400,{error:error instanceof Error?error.message:'Could not save workstreams'});}
}
