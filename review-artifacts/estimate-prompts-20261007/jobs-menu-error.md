# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workflows.spec.js >> safe four-document render, separate currency, signed recovery and invalidation
- Location: tests\browser\workflows.spec.js:81:1

# Error details

```
Test timeout of 45000ms exceeded.
```

```
Error: locator.click: Test timeout of 45000ms exceeded.
Call log:
  - waiting for locator('#openJobs')
    - locator resolved to <button id="openJobs">Drafts & signed jobs</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not visible
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not visible
    - retrying click action
      - waiting 100ms
    56 × waiting for element to be visible, enabled and stable
       - element is not visible
     - retrying click action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic [ref=f1e1]:
  - banner [ref=f1e2]:
    - link "Alert Disaster Restoration home" [ref=f1e3]:
      - /url: /
      - img "Alert Disaster Restoration" [ref=f1e4]
      - strong [ref=f1e5]: Field Estimator
    - group [ref=f1e7]:
      - generic "Account +" [ref=f1e8] [cursor=pointer]
  - generic [ref=f1e9]:
    - generic [ref=f1e10]:
      - generic [ref=f1e11]:
        - text: FIELD INSPECTION
        - heading "New inspection" [level=1] [ref=f1e12]
        - status [ref=f1e13]: Saved privately · revision 1
      - group [ref=f1e14]:
        - generic "Jobs +" [active] [ref=f1e15] [cursor=pointer]
    - navigation "Inspection tasks" [ref=f1e16]:
      - button "01 Property" [ref=f1e17] [cursor=pointer]:
        - generic [ref=f1e18]: "01"
        - text: Property
      - button "02 Walkthrough" [ref=f1e19] [cursor=pointer]:
        - generic [ref=f1e20]: "02"
        - text: Walkthrough
      - button "03 Evidence" [ref=f1e21] [cursor=pointer]:
        - generic [ref=f1e22]: "03"
        - text: Evidence
      - button "04 Review" [ref=f1e23] [cursor=pointer]:
        - generic [ref=f1e24]: "04"
        - text: Review
  - main [ref=f1e25]:
    - region [ref=f1e26]:
      - generic [ref=f1e27]:
        - heading "Property & scope" [level=2] [ref=f1e28]
        - button "Go to walkthrough →" [ref=f1e29] [cursor=pointer]
      - button "Fill scope from walkthrough" [ref=f1e30] [cursor=pointer]
      - paragraph [ref=f1e31]: Stops capture and proposes values from your recorded observations. Review before applying.
      - group [ref=f1e33]:
        - generic [ref=f1e34]:
          - text: Property address
          - textbox "Property address" [ref=f1e35]:
            - /placeholder: Enter the inspection address
        - generic [ref=f1e37]:
          - text: Year built
          - spinbutton "Year built" [ref=f1e38]
        - generic [ref=f1e39]:
          - generic [ref=f1e40]:
            - checkbox "Crawl space exists" [ref=f1e41]
            - text: Crawl space exists
          - generic [ref=f1e42]:
            - checkbox "Cabinet removal under granite" [ref=f1e43]
            - text: Cabinet removal under granite
          - generic [ref=f1e44]:
            - checkbox "Garage water-heater loss" [ref=f1e45]
            - text: Garage water-heater loss
          - generic [ref=f1e46]:
            - checkbox "This scope has been performed" [ref=f1e47]
            - text: This scope has been performed
        - generic [ref=f1e48]:
          - heading "Rooms & demolition" [level=3] [ref=f1e49]
          - button "Add room" [ref=f1e50] [cursor=pointer]
        - generic [ref=f1e52]:
          - generic [ref=f1e53]:
            - heading "Room 1" [level=3] [ref=f1e54]
            - button "Remove" [ref=f1e55] [cursor=pointer]
          - generic [ref=f1e56]:
            - generic [ref=f1e57]:
              - text: Room name
              - textbox "Room name" [ref=f1e58]: Room 1
            - generic [ref=f1e59]:
              - text: Water category
              - combobox "Water category" [ref=f1e60]:
                - option "1 · Clean water" [selected]
                - option "2 · Gray water"
                - option "3 · Contaminated / mold"
            - generic [ref=f1e61]:
              - text: Unfinished / subfloor SF
              - spinbutton "Unfinished / subfloor SF" [ref=f1e62]: "0"
            - generic [ref=f1e63]:
              - text: Finished / drywall / trim SF
              - spinbutton "Finished / drywall / trim SF" [ref=f1e64]: "0"
            - generic [ref=f1e65]:
              - text: Waste %
              - spinbutton "Waste %" [ref=f1e66]: "0"
          - generic [ref=f1e67]:
            - checkbox "Custom cabinetry · category 3 finished rate ×2" [ref=f1e68]
            - generic [ref=f1e69]: Custom cabinetry · category 3 finished rate ×2
        - heading "Equipment & additional labor" [level=3] [ref=f1e70]
        - generic [ref=f1e71]:
          - generic [ref=f1e72]:
            - text: Air movers
            - spinbutton "Air movers" [ref=f1e73]: "0"
          - generic [ref=f1e74]:
            - text: LGR dehumidifiers
            - spinbutton "LGR dehumidifiers" [ref=f1e75]: "0"
          - generic [ref=f1e76]:
            - text: Drying days
            - spinbutton "Drying days" [ref=f1e77]: "3"
          - generic [ref=f1e78]:
            - text: Additional labor hours
            - spinbutton "Additional labor hours" [ref=f1e79]: "0"
        - generic [ref=f1e80]:
          - 'checkbox "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet''s $47.46/hr estimate formula." [ref=f1e81]'
          - text: "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet's $47.46/hr estimate formula."
        - group [ref=f1e82]:
          - generic "Job charges and optional sheet items" [ref=f1e83] [cursor=pointer]
        - generic [ref=f1e84]:
          - text: Technician observations & scope notes
          - textbox "Technician observations & scope notes" [ref=f1e85]:
            - /placeholder: Record observed conditions and requested work. Flag work outside the listed rates.
        - generic [ref=f1e86]:
          - checkbox "I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities." [ref=f1e87]
          - text: I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities.
      - paragraph [ref=f1e88]: The estimating sheet provides a low–high customer range from the confirmed scope. Itemized charges show the base-rate calculation. Unpriced work requires correction before signing.
  - text: +
  - generic [ref=f1e89]:
    - generic [ref=f1e90]: Confirm scope before generating documents.
    - button "Save draft" [ref=f1e91] [cursor=pointer]
    - button "Finish & review" [ref=f1e92] [cursor=pointer]
  - contentinfo [ref=f1e93]: Alert Disaster Restoration · Private field inspections
```

# Test source

```ts
  1   | const {test,expect}=require('@playwright/test');
  2   | const fakeAuth=`(()=>{const user={uid:'test-owner',email:'synthetic@example.invalid',getIdToken:async()=> 'test-owner'};const auth={setPersistence:async()=>{},onAuthStateChanged:fn=>fn(user),signInWithPopup:async()=>{},signOut:async()=>{}};const factory=()=>auth;factory.Auth={Persistence:{LOCAL:'local'}};window.firebase={initializeApp:()=>{},auth:factory};window.firebase.auth.GoogleAuthProvider=class{setCustomParameters(){}};})();`;
  3   | test.beforeEach(async({page})=>{
  4   |   await page.goto('/');await expect(page.locator('#address')).toBeEnabled({timeout:15000});await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  5   | });
  6   | async function task(page,name){await page.locator('.task-nav [data-task="'+name+'"]').click();}
  7   | async function menu(page,id){const m=page.locator('#'+id);if(!await m.evaluate(el=>el.open))await m.locator('summary').click();}
  8   | async function scope(page){await task(page,'property');await page.locator('#address').fill('Synthetic browser property');await page.locator('#yearBuilt').fill('1960');await page.locator('[data-room-key="finished_sf"]').fill('10');await page.locator('#scopeConfirmed').check();await page.locator('#saveDraft').click();await expect(page.locator('#saveStatus')).toContainText('Saved privately');}
  9   | async function audit(page){await scope(page);await page.locator('#finishAudit').click();await expect(page.locator('#documents')).toBeVisible();}
  10  | async function draw(page){const canvas=page.locator('#signCanvas');await canvas.scrollIntoViewIfNeeded();await canvas.click({position:{x:10,y:10}});const rect=await canvas.boundingBox();await page.mouse.move(rect.x+30,rect.y+40);await page.mouse.down();await page.mouse.move(rect.x+110,rect.y+100,{steps:8});await page.mouse.move(rect.x+220,rect.y+30,{steps:8});await page.mouse.up();}
  11  | 
  12  | test('mobile task layout exposes capture immediately with readable idle controls',async({page,browserName})=>{
  13  |   await page.locator('#address').fill('Synthetic navigation draft');
  14  |   for(const width of [320,390]){
  15  |     await page.setViewportSize({width,height:844});await task(page,'walkthrough');
  16  |     expect((await page.locator('.masthead').boundingBox()).height).toBeLessThan(85);
  17  |     const start=await page.locator('#startWalk').boundingBox();expect(start.y+start.height).toBeLessThan(844);expect(start.height).toBeGreaterThanOrEqual(48);
  18  |     expect(await page.locator('#startWalk').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
  19  |     await expect(page.locator('#stopWalk')).toBeHidden();await expect(page.locator('#muteMic')).toBeHidden();await expect(page.locator('#takePhoto')).toBeDisabled();await expect(page.locator('#uploadPhoto')).toBeEnabled();
  20  |     expect((await page.locator('.viewfinder').boundingBox()).height).toBeLessThan(200);
  21  |     expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  22  |     if(browserName==='chromium')await page.screenshot({path:'review-artifacts/redesigned-walkthrough-'+width+'.png',fullPage:true});
  23  |     await task(page,'evidence');await expect(page.locator('#photoGallery')).toBeVisible();await task(page,'review');await expect(page.locator('#reviewEmpty')).toBeVisible();await task(page,'property');await expect(page.locator('#address')).toHaveValue('Synthetic navigation draft');
  24  |   }
  25  | });
  26  | 
  27  | test('all four mobile document choices fit and claims use readable cards',async({page,browserName})=>{
  28  |   await audit(page);await page.setViewportSize({width:390,height:844});
  29  |   await expect(page.locator('#estimateRange')).toHaveText('$1,208.00–$1,221.90');await expect(page.locator('#itemizedTotal')).toHaveText('$1,208.00');
  30  |   for(const width of [320,390]){
  31  |     await page.setViewportSize({width,height:844});
  32  |     for(const name of ['proposal','claim','defense','photos']){
  33  |       const tab=page.locator('[data-tab="'+name+'"]');const rect=await tab.boundingBox();expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(width);
  34  |       await tab.click();await expect(page.locator('#doc-'+name)).toBeVisible();await expect(tab).toHaveAttribute('aria-pressed','true');
  35  |     }
  36  |   }
  37  |   await expect(page.locator('#documentProgress')).toContainText('4 of 4');await page.locator('[data-tab="claim"]').click();
  38  |   await expect(page.locator('#claimCards')).toBeVisible();await expect(page.locator('.table-scroll')).toBeHidden();await expect(page.locator('.claim-card')).toHaveCount(6);await expect(page.locator('.claim-card').first()).toContainText('Total: $133.95');
  39  |   if(browserName==='chromium')await page.screenshot({path:'review-artifacts/redesigned-mobile-claim.png',fullPage:true});
  40  |   await page.emulateMedia({media:'print'});await expect(page.locator('.table-scroll')).toBeVisible();await expect(page.locator('#claimCards')).toBeHidden();
  41  | });
  42  | 
  43  | test('optional sheet charges appear in the calculated estimate range',async({page})=>{
  44  |   await scope(page);
  45  |   await page.locator('.sheet-charges summary').click();
  46  |   await page.locator('#matterportScans').fill('1');
  47  |   await page.locator('#woodFloorSystems').fill('1');
  48  |   await page.locator('#scopeConfirmed').check();
  49  |   await page.locator('#finishAudit').click();
  50  |   await expect(page.locator('#estimateRange')).toHaveText('$2,718.00–$2,731.90');
  51  |   await expect(page.locator('#itemizedTotal')).toHaveText('$2,718.00');
  52  |   await page.reload();
  53  |   await expect(page.locator('#matterportScans')).toHaveValue('1');
  54  |   await expect(page.locator('#woodFloorSystems')).toHaveValue('1');
  55  | });
  56  | 
  57  | test('active capture controls expand and Stop tears down the synthetic stream',async({page})=>{
  58  |   test.skip(!await page.evaluate(()=>!!(window.AudioContext||window.webkitAudioContext)),'Windows WebKit has no Web Audio API for this synthetic Live fixture; physical iPhone audio acceptance remains open.');
  59  |   await page.evaluate(()=>{
  60  |     const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
  61  |     const videoTracks=canvas.captureStream?canvas.captureStream(1).getVideoTracks():[];canvas.getContext('2d').fillRect(0,0,640,480);
  62  |     if(!videoTracks.length)document.getElementById('cameraVideo').play=async()=>{};
  63  |     const audio=new(window.AudioContext||window.webkitAudioContext)(),destination=audio.createMediaStreamDestination();
  64  |     window.syntheticInputAudio=audio;window.syntheticTracks=[...videoTracks,...destination.stream.getAudioTracks()];
  65  |     Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>new MediaStream(window.syntheticTracks)}});
  66  |     window.WebSocket=class{
  67  |       static OPEN=1;readyState=0;bufferedAmount=0;
  68  |       constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}
  69  |       send(message){if(JSON.parse(message).type==='authenticate')setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ready'})}),0);}
  70  |       close(){this.readyState=3;this.onclose?.();}
  71  |     };
  72  |   });
  73  |   await task(page,'walkthrough');await page.locator('#startWalk').click();await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
  74  |   await expect(page.locator('#startWalk')).toBeHidden();await expect(page.locator('#stopWalk')).toBeVisible();await expect(page.locator('#muteMic')).toBeVisible();await expect(page.locator('#takePhoto')).toBeEnabled();
  75  |   await page.locator('#muteMic').click();await expect(page.locator('#muteMic')).toHaveText('Unmute microphone');
  76  |   await page.locator('.capture-options summary').click();await page.locator('#thermalToggle').click();await expect(page.locator('#thermalBadge')).toBeVisible();
  77  |   await page.locator('#stopWalk').click();await expect(page.locator('#startWalk')).toBeVisible();await expect(page.locator('#stopWalk')).toBeHidden();await expect(page.locator('#thermalBadge')).toBeHidden();await expect(page.locator('#takePhoto')).toBeDisabled();
  78  |   expect(await page.evaluate(()=>window.syntheticTracks.every(track=>track.readyState==='ended'))).toBe(true);await page.evaluate(()=>window.syntheticInputAudio.close());
  79  | });
  80  | 
  81  | test('safe four-document render, separate currency, signed recovery and invalidation',async({page})=>{
  82  |   await audit(page);await expect(page.locator('#proposalBody')).toContainText('$1,208.00–$1,221.90');await expect(page.locator('#proposalBody')).toContainText('$1,208.00');
  83  |   await expect(page.locator('#proposalBody')).toContainText('<img src=x');expect(await page.evaluate(()=>window.reviewInjected)).toBeUndefined();
  84  |   await page.locator('#documentsConfirmed').check();await draw(page);await page.locator('#authorizeJob').click();await expect(page.locator('#saveStatus')).toContainText('Saved & signed');
  85  |   await expect(page.locator('#savedSignature')).toBeVisible();await page.reload();await expect(page.locator('#address')).toBeEnabled();
> 86  |   await menu(page,'jobMenu');await page.locator('#openJobs').click();await page.locator('.job-link').filter({hasText:'Signed · $1,208.00–$1,221.90'}).last().click();await expect(page.locator('#savedSignature')).toBeVisible();
      |                                                              ^ Error: locator.click: Test timeout of 45000ms exceeded.
  87  |   await expect(page.locator('#address')).toBeDisabled();await menu(page,'jobMenu');await page.locator('#newInspection').click();await audit(page);
  88  |   await draw(page);await task(page,'property');await page.locator('#address').fill('Changed address');await expect(page.locator('#documents')).toBeHidden();await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  89  | });
  90  | test('failed audit stays unsigned and failed save keeps retry reference',async({page})=>{
  91  |   await scope(page);await fault(page,{audit:1});
  92  |   await page.locator('#finishAudit').click();await expect(page.locator('#message')).toContainText('Synthetic provider failure');await expect(page.locator('#documents')).toBeHidden();
  93  |   await page.locator('#finishAudit').click();await expect(page.locator('#documents')).toBeVisible();await page.locator('#documentsConfirmed').check();await draw(page);
  94  |   await fault(page,{authorize:1});
  95  |   await page.locator('#authorizeJob').click();await expect(page.locator('#authorizationStatus')).toContainText('Save not confirmed');await page.locator('#authorizeJob').click();await expect(page.locator('#saveStatus')).toContainText('Saved & signed');const {references}=await fault(page,{});expect(references[0]).toBe(references[1]);
  96  | });
  97  | async function fault(page,faults){return page.evaluate(async faults=>(await fetch('/__test/fault',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:sessionStorage.getItem('synthetic-uid'),faults})})).json(),faults);}
  98  | test('offline draft reload and reconnection preserve local work',async({page,context,browserName})=>{
  99  |   test.skip(browserName==='webkit','Windows Playwright WebKit returns an internal navigation error with offline service workers; physical iPhone acceptance remains open.');
  100 |   await scope(page);await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});await context.setOffline(true);await page.locator('#technicianNotes').fill('Local observations while offline');await expect(page.locator('#saveStatus')).toContainText('offline');
  101 |   await page.waitForTimeout(1700);await page.reload();await expect(page.locator('#technicianNotes')).toHaveValue('Local observations while offline');await expect(page.locator('#finishAudit')).toBeDisabled();
  102 |   await context.setOffline(false);await page.locator('#saveDraft').click();await expect(page.locator('#saveStatus')).toContainText('Saved privately');await page.reload();await expect(page.locator('#technicianNotes')).toHaveValue('Local observations while offline');
  103 | });
  104 | test('permission denial, portrait evidence, clipboard denial and print document layout',async({page,browserName})=>{
  105 |   await scope(page);await page.evaluate(()=>{Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{throw new DOMException('Synthetic permission denial','NotAllowedError');}}});});
  106 |   await task(page,'walkthrough');await page.locator('#startWalk').click();await expect(page.locator('#message')).toContainText('Retry permissions');await expect(page.locator('#cameraEmpty')).toBeVisible();
  107 |   const photo=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=300;c.height=600;c.getContext('2d').fillRect(0,0,100,100);return c.toDataURL('image/png');});
  108 |   await page.locator('#photoFileInput').setInputFiles({name:'portrait.png',mimeType:'image/png',buffer:Buffer.from(photo.split(',')[1],'base64')});
  109 |   await expect(page.locator('#photoGallery')).toContainText('300 × 600');await expect(page.locator('#photoGallery')).toContainText('no meter');await expect(page.locator('#photoCount')).toContainText('0 verified');
  110 |   await task(page,'property');await page.locator('#scopeConfirmed').check();await page.locator('#finishAudit').click();await expect(page.locator('#documents')).toBeVisible();
  111 |   await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}});});await menu(page,'exportMenu');await page.locator('#copyJson').click();await expect(page.locator('#message')).toContainText('Download scope JSON');
  112 |   await page.emulateMedia({media:'print'});for(const id of ['doc-proposal','doc-claim','doc-defense','doc-photos'])await expect(page.locator('#'+id)).toBeVisible();
  113 |   if(browserName==='chromium')await page.pdf({path:'review-artifacts/repaired-documents.pdf',format:'Letter',printBackground:true});
  114 | });
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
```