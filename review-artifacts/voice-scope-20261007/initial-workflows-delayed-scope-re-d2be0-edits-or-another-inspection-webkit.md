# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workflows.spec.js >> delayed scope results cannot overwrite edits or another inspection
- Location: tests\browser\workflows.spec.js:209:1

# Error details

```
Error: expect(locator).toBeHidden() failed

Locator:  locator('#scopeSuggestionPanel')
Expected: hidden
Received: visible
Timeout:  5000ms

Call log:
  - Expect "toBeHidden" locator('#scopeSuggestionPanel') with timeout 5000ms
  - waiting for locator('#scopeSuggestionPanel')
    9 × locator resolved to <section id="scopeSuggestionPanel" class="scope-suggestions" aria-labelledby="scopeSuggestionHeading">…</section>
      - unexpected value "visible"

```

```yaml
- region "Proposed form values":
  - heading "Proposed form values" [level=3]
  - status: Review the proposed changes and their source statements. Uncheck any you want to keep as entered.
  - checkbox "Room 1" [checked]
  - strong: Room 1
  - paragraph: "Water category: 1 → 2"
  - blockquote: Room 1, category 2, 80 square feet of drywall.
  - paragraph: "Finished / drywall / trim SF: 0 → 80"
  - blockquote: Room 1, category 2, 80 square feet of drywall.
  - checkbox "Air movers" [checked]
  - strong: Air movers
  - paragraph: 0 → 3
  - blockquote: Use 3 fans.
  - list
  - button "Apply selected changes"
  - button "Dismiss"
```

# Test source

```ts
  115 | 
  116 | test('revision conflict preserves local work and explicit recovery restores the server',async({page})=>{
  117 |   await scope(page);await page.evaluate(async()=>{const rows=await(await fetch('/api/inspections',{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json();const id=rows.inspections[0].inspection_id;const record=await(await fetch('/api/inspections/'+id,{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json();record.data.technician_notes='Edited in another tab';await fetch('/api/inspections/'+id,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')},body:JSON.stringify({expected_revision:record.revision,data:record.data})});});
  118 |   await page.locator('#technicianNotes').fill('Local work must survive');await page.locator('#saveDraft').click();await expect(page.locator('#conflictActions')).toBeVisible();await expect(page.locator('#technicianNotes')).toHaveValue('Local work must survive');
  119 |   await page.reload();await expect(page.locator('#conflictActions')).toBeVisible();await expect(page.locator('#technicianNotes')).toHaveValue('Local work must survive');await page.locator('#restoreRemote').click();await expect(page.locator('#technicianNotes')).toHaveValue('Edited in another tab');
  120 | });
  121 | test('worker update prompts, preserves the draft and keeps protected data out of caches',async({page})=>{
  122 |   await scope(page);await page.evaluate(()=>navigator.serviceWorker.ready);await page.locator('#technicianNotes').fill('Preserve during installed update');await page.locator('#saveDraft').click();await fault(page,{worker:true});await page.evaluate(async()=>{const registration=await navigator.serviceWorker.ready;await registration.update();});
  123 |   await expect(page.locator('#updateBanner')).toBeVisible();await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#applyUpdate').click()]);await expect(page.locator('#technicianNotes')).toHaveValue('Preserve during installed update');
  124 |   const urls=await page.evaluate(async()=>{const result=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())result.push(request.url);return result;});expect(urls.filter(url=>url.includes('/api/'))).toEqual([]);
  125 | });
  126 | test('logout clears user-specific local drafts',async({page})=>{
  127 |   await scope(page);await page.locator('#technicianNotes').fill('Synthetic private logout draft');await menu(page,'accountMenu');await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#signOutButton').click()]);await expect(page.locator('#technicianNotes')).toHaveValue('');
  128 |   const rows=await page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('adr-private-drafts-v2',1);request.onsuccess=()=>{const read=request.result.transaction('drafts').objectStore('drafts').getAll();read.onsuccess=()=>resolve(read.result);read.onerror=reject;};}));expect(rows.every(row=>row.draft.data.technician_notes!=='Synthetic private logout draft')).toBe(true);
  129 | });
  130 | test('reconnection synchronizes an older queued inspection as well as the open draft',async({page,context,browserName})=>{
  131 |   test.skip(browserName==='webkit','Real offline navigation is covered on Chromium; Windows WebKit device acceptance remains open.');
  132 |   await scope(page);const original=await page.evaluate(async()=>{const r=await(await fetch('/api/inspections',{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json();return r.inspections[0].inspection_id;});
  133 |   await context.setOffline(true);await page.locator('#technicianNotes').fill('Older queued observations');await menu(page,'jobMenu');await page.locator('#newInspection').click();await expect(page.locator('#address')).toHaveValue('');await page.locator('#address').fill('Second local draft');await page.locator('#saveDraft').click();await context.setOffline(false);
  134 |   await expect.poll(()=>page.evaluate(async id=>(await(await fetch('/api/inspections/'+id,{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json()).data.technician_notes,original)).toBe('Older queued observations');
  135 | });
  136 | 
  137 | async function photoDraft(page){
  138 |   await scope(page);
  139 |   const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=300;c.height=600;return c.toDataURL('image/png');});
  140 |   await page.locator('#photoFileInput').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
  141 |   await expect(page.locator('#photoCount')).toContainText('1 photos');
  142 |   await expect(page.locator('#photoGallery')).toContainText('no meter');
  143 |   const id=await page.evaluate(async()=>{const rows=await(await fetch('/api/inspections',{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json();return rows.inspections.find(r=>r.address==='Synthetic browser property').inspection_id;});
  144 |   return {id,image};
  145 | }
  146 | async function restoreCloudOnly(page,id){
  147 |   await menu(page,'jobMenu');await page.locator('#newInspection').click();
  148 |   await expect(page.locator('#jobMenu')).not.toHaveAttribute('open');
  149 |   await page.evaluate(id=>new Promise((resolve,reject)=>{const request=indexedDB.open('adr-private-drafts-v2',1);request.onsuccess=()=>{const tx=request.result.transaction('drafts','readwrite');tx.objectStore('drafts').delete(sessionStorage.getItem('synthetic-uid')+':'+id);tx.oncomplete=resolve;tx.onerror=reject;};}),id);
  150 |   await menu(page,'jobMenu');await page.locator('#openJobs').click();await page.locator('.job-link').filter({hasText:'Synthetic browser property'}).click();
  151 |   await task(page,'evidence');await expect(page.locator('#photoGallery img')).toHaveCount(1);
  152 |   await expect.poll(()=>page.locator('#photoGallery img').evaluate(el=>el.naturalWidth)).toBe(300);
  153 | }
  154 | test('cloud-restored originals survive photo-backed conflict fork',async({page})=>{
  155 |   const {id}=await photoDraft(page);await restoreCloudOnly(page,id);
  156 |   await page.evaluate(async id=>{const headers={Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid'),'Content-Type':'application/json'};const r=await(await fetch('/api/inspections/'+id,{headers})).json();r.data.technician_notes='Other device changed the scope';await fetch('/api/inspections/'+id,{method:'PUT',headers,body:JSON.stringify({expected_revision:r.revision,data:r.data})});},id);
  157 |   await task(page,'property');await page.locator('#technicianNotes').fill('Keep this device work and photo');await page.locator('#saveDraft').click();await expect(page.locator('#conflictActions')).toBeVisible();
  158 |   await page.locator('#forkLocal').click();await expect(page.locator('#conflictActions')).toBeHidden();await expect(page.locator('#saveStatus')).toContainText('Saved privately');await expect(page.locator('#technicianNotes')).toHaveValue('Keep this device work and photo');
  159 |   await task(page,'evidence');await expect.poll(()=>page.locator('#photoGallery img').evaluate(el=>el.naturalWidth)).toBe(300);
  160 | });
  161 | test('reopened local draft merges photos added by another device',async({page})=>{
  162 |   const {id,image}=await photoDraft(page);
  163 |   await page.evaluate(async({id,image})=>{const headers={Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid'),'Content-Type':'application/json'};const r=await(await fetch('/api/inspections/'+id,{headers})).json();const response=await fetch('/api/inspections/'+id+'/photos',{method:'POST',headers,body:JSON.stringify({photo_id:'d'.repeat(32),expected_revision:r.revision,room:r.data.rooms[0].name,captured_at:new Date().toISOString(),data_url:image})});if(!response.ok)throw Error(await response.text());await fetch('/api/inspections/'+id+'/photos/'+'d'.repeat(32)+'/ocr',{method:'POST',headers,body:'{}'});},{id,image});
  164 |   await page.reload();await task(page,'evidence');await expect(page.locator('#photoGallery img')).toHaveCount(2);await expect.poll(()=>page.locator('#photoGallery img').evaluateAll(images=>images.every(img=>img.naturalWidth===300))).toBe(true);
  165 | });
  166 | test('cloud-restored photos remain visible after offline reload',async({page,context,browserName})=>{
  167 |   test.skip(browserName==='webkit','Windows WebKit offline navigation limitation; physical iPhone acceptance remains open.');
  168 |   const {id}=await photoDraft(page);await restoreCloudOnly(page,id);
  169 |   await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
  170 |   await context.setOffline(true);await page.reload();await task(page,'evidence');await expect.poll(()=>page.locator('#photoGallery img').evaluate(el=>el.naturalWidth)).toBe(300);
  171 | });
  172 | test('saved jobs list is newest first and loads older signed jobs',async({page})=>{
  173 |   await page.evaluate(async()=>{const response=await fetch('/__test/seed-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:sessionStorage.getItem('synthetic-uid')})});if(!response.ok)throw Error('Synthetic seed failed');});
  174 |   await menu(page,'jobMenu');await page.locator('#openJobs').click();
  175 |   const signed=page.locator('.job-link').filter({hasText:'Synthetic signed job'});
  176 |   await expect(signed).toHaveCount(100);await expect(signed.first()).toContainText('job 104');await expect(signed.last()).toContainText('job 005');
  177 |   await page.getByRole('button',{name:'Load older signed jobs'}).click();await expect(signed).toHaveCount(105);await expect(signed.last()).toContainText('job 000');await expect(page.getByRole('button',{name:'Load older signed jobs'})).toBeHidden();
  178 | });
  179 | 
  180 | for(const failure of ['evidence','record'])test('durable signing receipt survives '+failure+' display failure',async({page})=>{
  181 |   await audit(page);await page.locator('#documentsConfirmed').check();await draw(page);await fault(page,{[failure]:1});await page.locator('#authorizeJob').click();
  182 |   await expect(page.locator('#saveStatus')).toContainText('Saved & signed');await expect(page.locator('#retrySavedEvidence')).toBeVisible();await expect(page.locator('#message')).toContainText('saved');await expect(page.locator('#address')).toBeDisabled();
  183 |   await page.locator('#retrySavedEvidence').click();await expect(page.locator('#savedSignature')).toBeVisible();await expect(page.locator('#retrySavedEvidence')).toBeHidden();
  184 |   const {references}=await fault(page,{});expect(references).toHaveLength(1);
  185 | });
  186 | 
  187 | test('walkthrough form fill requires review, supports selection and invalidates old documents',async({page})=>{
  188 |   await audit(page);await task(page,'walkthrough');await page.locator('details:has(#technicianTranscript) summary').click();
  189 |   await page.locator('#technicianTranscript').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  190 |   await page.locator('#fillScope').click();await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  191 |   await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('10');await expect(page.locator('#airMovers')).toHaveValue('0');
  192 |   await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);if(await page.evaluate(()=>!!window.chrome))await page.screenshot({path:'review-artifacts/voice-scope-20261007/mobile-suggestions.png',fullPage:true});
  193 |   await expect(page.locator('#scopeSuggestionList')).toContainText('10 → 80');await expect(page.locator('#scopeQuestions')).toContainText('Confirm any additional labor.');
  194 |   await page.locator('.scope-suggestion').filter({hasText:'Air movers'}).locator('input').uncheck();
  195 |   await page.locator('#applyScopeSuggestions').click();
  196 |   await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');await expect(page.locator('[data-room-key="category"]')).toHaveValue('2');await expect(page.locator('#airMovers')).toHaveValue('0');
  197 |   await expect(page.locator('#scopeConfirmed')).not.toBeChecked();await expect(page.locator('#documents')).toBeHidden();await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
  198 |   await page.locator('#saveDraft').click();await page.reload();await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  199 |   await page.locator('#scopeConfirmed').check();await page.locator('#finishAudit').click();await expect(page.locator('#itemizedTotal')).toHaveText('$1,411.40');
  200 | });
  201 | 
  202 | test('scope suggestions dismiss and manual edits preserve user values',async({page})=>{
  203 |   await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  204 |   await page.locator('#fillScopeProperty').click();await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  205 |   await page.locator('#dismissScopeSuggestions').click();await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
  206 |   await page.locator('#fillScopeProperty').click();await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  207 |   await page.locator('#airMovers').fill('6');await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();await expect(page.locator('#airMovers')).toHaveValue('6');
  208 | });
  209 | 
  210 | test('delayed scope results cannot overwrite manual edits',async({page})=>{
  211 |   let release;const gate=new Promise(resolve=>release=resolve);
  212 |   await page.route('**/scope-suggestions',async route=>{await gate;await route.continue();});
  213 |   await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  214 |   await page.locator('#fillScopeProperty').click();await expect(page.locator('#fillScopeProperty')).toHaveText('Reading walkthrough…');
> 215 |   await page.locator('#airMovers').fill('6');release();
      |                                                                                                                                                  ^ Error: expect(locator).toBeHidden() failed
  216 |   await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();await expect(page.locator('#airMovers')).toHaveValue('6');
  217 |   await expect(page.locator('#message')).toContainText(/changed/);
  218 | });
  219 | 
  220 | test('fill scope stops active capture before showing reviewable changes',async({page})=>{
  221 |   test.skip(!await page.evaluate(()=>!!(window.AudioContext||window.webkitAudioContext)),'Windows WebKit has no Web Audio; physical iPhone capture cleanup remains open.');
  222 |   await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  223 |   await page.evaluate(()=>{
  224 |     const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
  225 |     const videoTracks=canvas.captureStream?canvas.captureStream(1).getVideoTracks():[];canvas.getContext('2d').fillRect(0,0,640,480);
  226 |     if(!videoTracks.length)document.getElementById('cameraVideo').play=async()=>{};
  227 |     const audio=new(window.AudioContext||window.webkitAudioContext)(),destination=audio.createMediaStreamDestination();
  228 |     window.syntheticInputAudio=audio;window.syntheticTracks=[...videoTracks,...destination.stream.getAudioTracks()];
  229 |     Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>new MediaStream(window.syntheticTracks)}});
  230 |     window.WebSocket=class{
  231 |       static OPEN=1;readyState=0;bufferedAmount=0;
  232 |       constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}
  233 |       send(message){if(JSON.parse(message).type==='authenticate')setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ready'})}),0);}
  234 |       close(){this.readyState=3;this.onclose?.();}
  235 |     };
  236 |   });
  237 |   await task(page,'walkthrough');await page.locator('#startWalk').click();await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
  238 |   await page.locator('#fillScope').click();await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  239 |   expect(await page.evaluate(()=>window.syntheticTracks.every(track=>track.readyState==='ended'))).toBe(true);
  240 |   expect(await page.locator('#cameraVideo').evaluate(el=>el.srcObject===null)).toBe(true);
  241 |   await expect(page.locator('#liveStatus')).toHaveText('Not connected');await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
  242 |   await page.evaluate(()=>window.syntheticInputAudio.close());
  243 | });
  244 | 
  245 | test('scope results from a previous inspection are discarded',async({page})=>{
  246 |   let release;const gate=new Promise(resolve=>release=resolve);
  247 |   await page.route('**/scope-suggestions',async route=>{await gate;await route.continue();});
  248 |   await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  249 |   await page.locator('#fillScopeProperty').click();await expect(page.locator('#fillScopeProperty')).toHaveText('Reading walkthrough…');
  250 |   await menu(page,'jobMenu');await page.locator('#newInspection').click();await expect(page.locator('#technicianNotes')).toHaveValue('');release();
  251 |   await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
  252 | });
  253 | 
```