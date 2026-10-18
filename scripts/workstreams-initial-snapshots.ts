import { mutate } from '../src/workstreams/store.js';
import { appendEvent } from '../src/workstreams/model.js';
const snapshots:Record<string,{where:string;done:string;blocked:string;next:string;owner:string;status:'active'|'waiting'}>={
 'Job Search':{where:'Today’s job-scout overview and opportunity review are filed in history. Open individual applications for their current reported state.',done:'Relevant archived reports recovered into Workstreams.',blocked:'Individual applications may have unresolved form or PC/browser blockers; see their histories.',next:'Review the Supabase application stream and the opportunity-review report.',owner:'Philip',status:'active'},
 'Supabase application':{where:'Latest Prime II report says the application has not been submitted. This snapshot does not independently verify the application site.',done:'Archived application reports recovered; no submission is marked complete.',blocked:'Reported PC/browser availability problems. Earlier reports also flag a required vacancy-source choice.',next:'Review the latest report, resolve remaining form fields truthfully, then explicitly authorize submission when ready.',owner:'Philip / Prime II',status:'waiting'},
 'Roblox UGC sales':{where:'The archived setup report is available below. It describes avatar-item selling prerequisites, not an item published or sold.',done:'Seller-setup report recovered into history.',blocked:'Reported account verification, subscription and fee requirements still need checking/completion.',next:'Review the setup report; Philip takes over for identity, legal, payment or publishing steps.',owner:'Philip',status:'waiting'},
};
await mutate(state=>{
 for(const stream of state.streams){const patch=snapshots[stream.title];if(!patch||stream.where!=='No confirmed status yet.')continue;
  Object.assign(stream,patch,{updatedAt:new Date().toISOString()});
  appendEvent(state,{streamId:stream.id,kind:'update',text:'Initial continuity snapshot prepared from recovered reports. Agent claims remain attributed and unverified; next actions are suggestions.',source:'Workstreams setup',certainty:'reported',sourceKey:`initial-snapshot:${stream.id}`});
 }
});console.log('Initial snapshots prepared without overwriting user-edited snapshots.');
