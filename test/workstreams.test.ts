import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {empty,createStream,appendEvent,correctEvent,route} from '../src/workstreams/model.js';
import {workstreamApi,type WorkStore} from '../src/web/workstreams.js';
test('specific routing, ambiguity inbox and independent watch-free state',()=>{
 const s=empty();const jobs=createStream(s,{title:'Job Search'});const app=createStream(s,{title:'Supabase application',parentId:jobs.id,aliases:['Supabase']});createStream(s,{title:'Roblox UGC'});
 assert.equal(route(s,'Job Search: Supabase application'),app.id);assert.equal(route(s,'Supabase and Roblox UGC'),null);assert.equal(route(s,'unrelated'),null);
 assert.throws(()=>createStream(s,{title:'Nested',parentId:app.id}));
});
test('report deduplication, evidence labels, correction history and moves',()=>{
 const s=empty();const a=createStream(s,{title:'Job Search'}),b=createStream(s,{title:'Roblox UGC'});
 const e=appendEvent(s,{streamId:a.id,kind:'result',text:'Agent says submitted',source:'agent:Prime II',sourceKey:'job:1'});
 assert.equal(e.certainty,'reported');assert.equal(appendEvent(s,{streamId:a.id,kind:'result',text:'retry',sourceKey:'job:1'}).id,e.id);assert.equal(s.events.length,1);
 correctEvent(s,e.id,{streamId:b.id,text:'Draft only',certainty:'confirmed'});assert.equal(e.revisions[0]?.text,'Agent says submitted');assert.equal(e.streamId,b.id);
 assert.equal(a.done,'');assert.throws(()=>appendEvent(s,{streamId:a.id,kind:'result',text:'bad',artifact:'javascript:alert(1)'}));
});
test('authenticated HTTP flow: create, snapshot conflict, file, correct/move, reload and reject invalid input',async()=>{
 let state=empty();const store:WorkStore={readState:async()=>structuredClone(state),mutate:async fn=>{const next=structuredClone(state);const result=fn(next);next.revision++;state=next;return result;}};
 const server=createServer((req,res)=>{if(req.headers.authorization!=='Bearer test'){res.writeHead(401);res.end();return;}void workstreamApi(req,res,store);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address && typeof address!=='string');const url=`http://127.0.0.1:${address.port}`;
 const call=async(body?:unknown)=>{const r=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer test','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 try{
 assert.equal((await fetch(url)).status,401);
 const a=(await call({action:'create',title:'Test applications'})).body.result;
 const b=(await call({action:'create',title:'Other test'})).body.result;
 const e=(await call({action:'event',streamId:a.id,kind:'result',text:'Draft created',certainty:'reported'})).body.result;
 assert.equal((await call({action:'correct',id:e.id,streamId:b.id,text:'Draft checked',certainty:'confirmed'})).status,200);
 const current=(await call()).body;
 const patch={action:'snapshot',id:b.id,revision:current.revision,status:'waiting',where:'Draft ready',done:'Draft checked',blocked:'Review',next:'Philip reviews',owner:'Philip'};
 assert.equal((await call(patch)).status,200);assert.equal((await call(patch)).status,400);
 assert.equal((await call({action:'create',title:''})).status,400);
 const loaded=(await call()).body;assert.equal(loaded.streams.find((s:{id:string})=>s.id===b.id).next,'Philip reviews');assert.equal(loaded.events.find((x:{id:string})=>x.id===e.id).revisions.length,1);
 }finally{await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
});
