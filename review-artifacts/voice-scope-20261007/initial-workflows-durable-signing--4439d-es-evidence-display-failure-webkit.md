# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workflows.spec.js >> durable signing receipt survives evidence display failure
- Location: tests\browser\workflows.spec.js:180:44

# Error details

```
Error: expect(locator).toBeEnabled() failed

Locator:  locator('#address')
Expected: enabled
Received: disabled
Timeout:  5000ms

Call log:
  - Expect "toBeEnabled" locator('#address') with timeout 5000ms
  - waiting for locator('#address')
    6 × locator resolved to <input required="" id="address" name="address" maxlength="500" autocomplete="street-address" placeholder="Enter the inspection address"/>
      - unexpected value "disabled"
    - waiting for "https://localhost:8765/" navigation to finish...
    - navigated to "https://localhost:8765/"
    - locator resolved to <input required="" id="address" name="address" maxlength="500" autocomplete="street-address" placeholder="Enter the inspection address"/>
    - unexpected value "disabled"

```

```yaml
- textbox "Property address" [disabled]:
  - /placeholder: Enter the inspection address
```

# Test source

```ts
  1   | const {test,expect}=require('@playwright/test');
  2   | const fakeAuth=`(()=>{const user={uid:'test-owner',email:'synthetic@example.invalid',getIdToken:async()=> 'test-owner'};const auth={setPersistence:async()=>{},onAuthStateChanged:fn=>fn(user),signInWithPopup:async()=>{},signOut:async()=>{}};const factory=()=>auth;factory.Auth={Persistence:{LOCAL:'local'}};window.firebase={initializeApp:()=>{},auth:factory};window.firebase.auth.GoogleAuthProvider=class{setCustomParameters(){}};})();`;
  3   | test.beforeEach(async({page})=>{
> 4   |   await page.goto('/');await expect(page.locator('#address')).toBeEnabled();await expect(page.locator('#saveStatus')).toContainText('Saved privately');
      |                                                               ^ Error: expect(locator).toBeEnabled() failed
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
  86  |   await menu(page,'jobMenu');await page.locator('#openJobs').click();await page.locator('.job-link').filter({hasText:'Signed · $1,208.00–$1,221.90'}).last().click();await expect(page.locator('#savedSignature')).toBeVisible();
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
```