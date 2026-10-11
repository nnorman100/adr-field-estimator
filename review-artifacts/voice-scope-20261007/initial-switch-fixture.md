# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workflows.spec.js >> scope results from a previous inspection are discarded
- Location: tests\browser\workflows.spec.js:245:1

# Error details

```
Test timeout of 45000ms exceeded.
```

```
Error: locator.click: Test timeout of 45000ms exceeded.
Call log:
  - waiting for locator('#newInspection')
    - locator resolved to <button id="newInspection">New inspection</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not visible
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not visible
    - retrying click action
      - waiting 100ms
    61 × waiting for element to be visible, enabled and stable
       - element is not visible
     - retrying click action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - banner [ref=e2]:
    - link "Alert Disaster Restoration home" [ref=e3]:
      - /url: /
      - img "Alert Disaster Restoration" [ref=e4]
      - strong [ref=e5]: Field Estimator
    - group [ref=e7]:
      - generic "Account +" [ref=e8] [cursor=pointer]
  - generic [ref=e9]:
    - generic [ref=e10]:
      - generic [ref=e11]:
        - text: FIELD INSPECTION
        - heading "New inspection" [level=1] [ref=e12]
        - status [ref=e13]: Saved privately · revision 2
      - group [ref=e14]:
        - generic "Jobs +" [ref=e15] [cursor=pointer]
    - navigation "Inspection tasks" [ref=e16]:
      - button "01 Property" [ref=e17] [cursor=pointer]:
        - generic [ref=e18]: "01"
        - text: Property
      - button "02 Walkthrough" [ref=e19] [cursor=pointer]:
        - generic [ref=e20]: "02"
        - text: Walkthrough
      - button "03 Evidence" [ref=e21] [cursor=pointer]:
        - generic [ref=e22]: "03"
        - text: Evidence
      - button "04 Review" [ref=e23] [cursor=pointer]:
        - generic [ref=e24]: "04"
        - text: Review
  - main [ref=e25]:
    - region [ref=e26]:
      - generic [ref=e27]:
        - heading "Property & scope" [active] [level=2] [ref=e28]
        - button "Go to walkthrough →" [ref=e29] [cursor=pointer]
      - button "Fill scope from walkthrough" [ref=e30] [cursor=pointer]
      - paragraph [ref=e31]: Stops capture and proposes values from your recorded observations. Review before applying.
      - region [ref=e32]:
        - heading "Proposed form values" [level=3] [ref=e33]
        - status [ref=e34]: Review the proposed changes and their source statements. Uncheck any you want to keep as entered.
        - generic [ref=e35]:
          - generic [ref=e36]:
            - generic [ref=e37]:
              - checkbox "Room 1" [checked] [ref=e38]
              - strong [ref=e39]: Room 1
            - paragraph [ref=e40]: "Water category: 1 → 2"
            - blockquote [ref=e41]: Room 1, category 2, 80 square feet of drywall.
            - paragraph [ref=e42]: "Finished / drywall / trim SF: 0 → 80"
            - blockquote [ref=e43]: Room 1, category 2, 80 square feet of drywall.
          - generic [ref=e44]:
            - generic [ref=e45]:
              - checkbox "Air movers" [checked] [ref=e46]
              - strong [ref=e47]: Air movers
            - paragraph [ref=e48]: 0 → 3
            - blockquote [ref=e49]: Use 3 fans.
        - list [ref=e50]:
          - listitem [ref=e51]: Confirm any additional labor.
        - generic [ref=e52]:
          - button "Apply selected changes" [ref=e53] [cursor=pointer]
          - button "Dismiss" [ref=e54] [cursor=pointer]
      - group [ref=e56]:
        - generic [ref=e57]:
          - text: Property address
          - textbox "Property address" [ref=e58]:
            - /placeholder: Enter the inspection address
        - generic [ref=e60]:
          - text: Year built
          - spinbutton "Year built" [ref=e61]
        - generic [ref=e62]:
          - generic [ref=e63]:
            - checkbox "Crawl space exists" [ref=e64]
            - text: Crawl space exists
          - generic [ref=e65]:
            - checkbox "Cabinet removal under granite" [ref=e66]
            - text: Cabinet removal under granite
          - generic [ref=e67]:
            - checkbox "Garage water-heater loss" [ref=e68]
            - text: Garage water-heater loss
          - generic [ref=e69]:
            - checkbox "This scope has been performed" [ref=e70]
            - text: This scope has been performed
        - generic [ref=e71]:
          - heading "Rooms & demolition" [level=3] [ref=e72]
          - button "Add room" [ref=e73] [cursor=pointer]
        - generic [ref=e75]:
          - generic [ref=e76]:
            - heading "Room 1" [level=3] [ref=e77]
            - button "Remove" [ref=e78] [cursor=pointer]
          - generic [ref=e79]:
            - generic [ref=e80]:
              - text: Room name
              - textbox "Room name" [ref=e81]: Room 1
            - generic [ref=e82]:
              - text: Water category
              - combobox "Water category" [ref=e83]:
                - option "1 · Clean water" [selected]
                - option "2 · Gray water"
                - option "3 · Contaminated / mold"
            - generic [ref=e84]:
              - text: Unfinished / subfloor SF
              - spinbutton "Unfinished / subfloor SF" [ref=e85]: "0"
            - generic [ref=e86]:
              - text: Finished / drywall / trim SF
              - spinbutton "Finished / drywall / trim SF" [ref=e87]: "0"
            - generic [ref=e88]:
              - text: Waste %
              - spinbutton "Waste %" [ref=e89]: "0"
          - generic [ref=e90]:
            - checkbox "Custom cabinetry · category 3 finished rate ×2" [ref=e91]
            - generic [ref=e92]: Custom cabinetry · category 3 finished rate ×2
        - heading "Equipment & additional labor" [level=3] [ref=e93]
        - generic [ref=e94]:
          - generic [ref=e95]:
            - text: Air movers
            - spinbutton "Air movers" [ref=e96]: "0"
          - generic [ref=e97]:
            - text: LGR dehumidifiers
            - spinbutton "LGR dehumidifiers" [ref=e98]: "0"
          - generic [ref=e99]:
            - text: Drying days
            - spinbutton "Drying days" [ref=e100]: "3"
          - generic [ref=e101]:
            - text: Additional labor hours
            - spinbutton "Additional labor hours" [ref=e102]: "0"
        - generic [ref=e103]:
          - 'checkbox "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet''s $47.46/hr estimate formula." [ref=e104]'
          - text: "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet's $47.46/hr estimate formula."
        - group [ref=e105]:
          - generic "Job charges and optional sheet items" [ref=e106] [cursor=pointer]
        - generic [ref=e107]:
          - text: Technician observations & scope notes
          - textbox "Technician observations & scope notes" [ref=e108]:
            - /placeholder: Record observed conditions and requested work. Flag work outside the listed rates.
            - text: Room 1, category 2, 80 square feet of drywall. Use 3 fans.
        - generic [ref=e109]:
          - checkbox "I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities." [ref=e110]
          - text: I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities.
      - paragraph [ref=e111]: The estimating sheet provides a low–high customer range from the confirmed scope. Itemized charges show the base-rate calculation. Unpriced work requires correction before signing.
  - text: +
  - generic [ref=e112]:
    - generic [ref=e113]: Confirm scope before generating documents.
    - button "Save draft" [ref=e114] [cursor=pointer]
    - button "Finish & review" [ref=e115] [cursor=pointer]
  - contentinfo [ref=e116]: Alert Disaster Restoration · Private field inspections
```

# Test source

```ts
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
  215 |   await page.locator('#airMovers').fill('6');release();
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
> 250 |   await menu(page,'jobMenu');await page.locator('#newInspection').click();await expect(page.locator('#technicianNotes')).toHaveValue('');release();
      |                                                                   ^ Error: locator.click: Test timeout of 45000ms exceeded.
  251 |   await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
  252 | });
  253 | 
```