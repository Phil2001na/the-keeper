import { execFileSync } from 'node:child_process';
import { config } from '../src/config.js';
const base='https://the-keeper-production.up.railway.app';
let token=config.webToken;
const unauth=await fetch(base+'/api/workstreams');if(unauth.status!==401)throw new Error('Workstream data is not protected');
if((await fetch(base+'/api/workstreams',{headers:{Authorization:`Bearer ${token}`}})).status===401){
 const vars=JSON.parse(execFileSync('railway.exe',['variables','--json','--service','the-keeper'],{encoding:'utf8'}));token=vars.KEEPER_WEB_TOKEN;
}
async function api(body?:unknown,path='/api/workstreams'){
 const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const data=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status}: ${JSON.stringify(data)}`);return data;
}
const a=(await api({action:'create',title:'Workstreams verification',aliases:[]})).result;
const b=(await api({action:'create',title:'Workstreams verification inbox',parentId:a.id,aliases:[]})).result;
let state=await api();
await api({action:'snapshot',id:a.id,revision:state.revision,status:'active',where:'Testing the deployed Workstreams flow with synthetic data.',done:'',blocked:'',next:'Verify the amber compass marker.',owner:'Deployment check'});
const event=(await api({action:'event',streamId:a.id,kind:'update',text:'Synthetic save/reload check',certainty:'suggested'})).result;
await api({action:'correct',id:event.id,streamId:b.id,text:'Synthetic correction and move verified',certainty:'confirmed'});
state=await api();
if(state.events.find((e:{id:string})=>e.id===event.id)?.streamId!==b.id)throw new Error('Move did not persist');
await api({text:'This is the Workstreams deployment verification, not a personal task. Reply in one sentence with the next move stored in this workstream. Do not use tools, send other messages or change goals/reminders.',workstreamId:a.id},'/send');
state=await api();
const response=state.events.filter((e:{streamId:string;source:string})=>e.streamId===a.id&&e.source==='Keeper').at(-1);
if(!response || !/amber compass/i.test(response.text))throw new Error('Chat did not resume from the selected snapshot');
for(const id of [a.id,b.id]){
 state=await api();const stream=state.streams.find((s:{id:string})=>s.id===id);
 await api({action:'snapshot',id,revision:state.revision,status:'done',where:'Synthetic deployment verification completed.',done:'Save, reload, correction/move and chat context verified.',blocked:'',next:'No action; completed verification record.',owner:'Deployment check'});
}
console.log(JSON.stringify({ok:true,unauthenticatedStatus:unauth.status,streams:[a.id,b.id],chatContextVerified:true,correctionAndMoveVerified:true}));
