import { db } from '../src/db/client.js';
import { appendEvent, createStream, correctEvent } from '../src/workstreams/model.js';
import { mutate } from '../src/workstreams/store.js';

// Narrow recovery of today's PC reports; no journals or unrelated conversation import.
const {data,error}=await db.from('keeper_interactions').select('id,content,trigger,created_at').gte('created_at','2026-10-17T00:00:00Z').eq('role','agent').or('trigger.like.pc:%,trigger.like.crew:%').order('created_at');
if(error)throw error;
const reports=(data??[]).filter(r=>/job.scout|job search|supabase|roblox/i.test(r.content) && !/is online|started on|is starting/.test(r.content));
await mutate(state=>{
 const get=(title:string,parentId:string|null=null,aliases:string[]=[])=>state.streams.find(s=>s.title===title)??createStream(state,{title,parentId,aliases});
 const jobs=get('Job Search',null,['job search','job-scout','job scout']);
 const application=get('Supabase application',jobs.id,['Supabase application']);
 const roblox=get('Roblox UGC sales',null,['Roblox UGC','Roblox marketplace']);
 for(const r of reports){
  const target=/roblox/i.test(r.content)?roblox:/three of|automation is|active listings|job.scout/i.test(r.content)?jobs:/supabase/i.test(r.content)?application:jobs;
  const event=appendEvent(state,{streamId:target.id,kind:'result',text:r.content.slice(0,20000),certainty:'reported',source:`Archive ${r.trigger}`,sourceKey:`history:${r.id}`});
  if(event.streamId!==target.id)correctEvent(state,event.id,{streamId:target.id,text:event.text,certainty:event.certainty});
  event.at=r.created_at;
 }
 return null;
});
console.log(JSON.stringify({recoveredReports:reports.map(r=>({id:r.id,source:r.trigger,excerpt:r.content.slice(0,250)}))}));
