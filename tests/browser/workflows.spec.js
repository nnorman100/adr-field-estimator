const {test,expect}=require('@playwright/test');
const fakeAuth=`(()=>{const user={uid:'test-owner',email:'synthetic@example.invalid',getIdToken:async()=> 'test-owner'};const auth={setPersistence:async()=>{},onAuthStateChanged:fn=>fn(user),signInWithPopup:async()=>{},signOut:async()=>{}};const factory=()=>auth;factory.Auth={Persistence:{LOCAL:'local'}};window.firebase={initializeApp:()=>{},auth:factory};window.firebase.auth.GoogleAuthProvider=class{setCustomParameters(){}};})();`;
test.beforeEach(async({page})=>{
  await page.goto('/');await expect(page.locator('#address')).toBeEnabled({timeout:15000});await expect(page.locator('#saveStatus')).toContainText('Saved privately');
});
async function task(page,name){await page.locator('.task-nav [data-task="'+name+'"]').click();}
async function menu(page,id){await page.waitForFunction(()=>state.session&&!state.workspaceInitializing);const m=page.locator('#'+id);if(!await m.evaluate(el=>el.open))await m.locator('summary').click();}
async function scope(page){await task(page,'property');await page.locator('#address').fill('Synthetic browser property');await page.locator('#yearBuilt').fill('1960');await page.locator('[data-room-key="finished_sf"]').fill('10');await page.locator('#scopeConfirmed').check();await page.locator('#saveDraft').click();await expect(page.locator('#saveStatus')).toContainText('Saved privately');}
async function audit(page){await scope(page);await page.locator('#finishAudit').click();await expect(page.locator('#documents')).toBeVisible();}
async function draw(page){const canvas=page.locator('#signCanvas');await canvas.scrollIntoViewIfNeeded();await canvas.click({position:{x:10,y:10}});const rect=await canvas.boundingBox();await page.mouse.move(rect.x+30,rect.y+40);await page.mouse.down();await page.mouse.move(rect.x+110,rect.y+100,{steps:8});await page.mouse.move(rect.x+220,rect.y+30,{steps:8});await page.mouse.up();}

test('mobile task layout exposes capture immediately with readable idle controls',async({page,browserName})=>{
  await page.locator('#address').fill('Synthetic navigation draft');
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});await task(page,'walkthrough');
    expect((await page.locator('.masthead').boundingBox()).height).toBeLessThan(85);
    const start=await page.locator('#startWalk').boundingBox();expect(start.y+start.height).toBeLessThan(844);expect(start.height).toBeGreaterThanOrEqual(48);
    expect(await page.locator('#startWalk').evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(14);
    await expect(page.locator('#stopWalk')).toBeHidden();await expect(page.locator('#muteMic')).toBeHidden();await expect(page.locator('#takePhoto')).toBeDisabled();await expect(page.locator('#uploadPhoto')).toBeEnabled();
    expect((await page.locator('.viewfinder').boundingBox()).height).toBeLessThan(200);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
    if(browserName==='chromium')await page.screenshot({path:test.info().outputPath('redesigned-walkthrough-'+width+'.png'),fullPage:true});
    await task(page,'evidence');await expect(page.locator('#photoGallery')).toBeVisible();await task(page,'review');await expect(page.locator('#reviewEmpty')).toBeVisible();await task(page,'property');await expect(page.locator('#address')).toHaveValue('Synthetic navigation draft');
  }
});

test('all four mobile document choices fit and claims use readable cards',async({page,browserName})=>{
  await audit(page);await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#estimateRange')).toHaveText('$1,208.00–$1,221.90');await expect(page.locator('#itemizedTotal')).toHaveText('$1,208.00');
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    for(const name of ['proposal','claim','defense','photos']){
      const tab=page.locator('[data-tab="'+name+'"]');const rect=await tab.boundingBox();expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(width);
      await tab.click();await expect(page.locator('#doc-'+name)).toBeVisible();await expect(tab).toHaveAttribute('aria-pressed','true');
    }
  }
  await expect(page.locator('#documentProgress')).toContainText('4 of 4');await page.locator('[data-tab="claim"]').click();
  await expect(page.locator('#claimCards')).toBeVisible();await expect(page.locator('.table-scroll')).toBeHidden();await expect(page.locator('.claim-card')).toHaveCount(6);await expect(page.locator('.claim-card').first()).toContainText('Total: $133.95');
  if(browserName==='chromium')await page.screenshot({path:test.info().outputPath('redesigned-mobile-claim.png'),fullPage:true});
  await page.emulateMedia({media:'print'});await expect(page.locator('.table-scroll')).toBeVisible();await expect(page.locator('#claimCards')).toBeHidden();
});

test('optional sheet charges appear in the calculated estimate range',async({page})=>{
  await scope(page);
  await page.locator('.sheet-charges summary').click();
  await page.locator('#matterportScans').fill('1');
  await page.locator('#woodFloorSystems').fill('1');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#estimateRange')).toHaveText('$2,718.00–$2,731.90');
  await expect(page.locator('#itemizedTotal')).toHaveText('$2,718.00');
  await page.reload();
  await expect(page.locator('#matterportScans')).toHaveValue('1');
  await expect(page.locator('#woodFloorSystems')).toHaveValue('1');
});

test('active capture controls expand and Stop tears down the synthetic stream',async({page})=>{
  test.skip(!await page.evaluate(()=>!!(window.AudioContext||window.webkitAudioContext)),'Windows WebKit has no Web Audio API for this synthetic Live fixture; physical iPhone audio acceptance remains open.');
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
    const videoTracks=canvas.captureStream?canvas.captureStream(1).getVideoTracks():[];canvas.getContext('2d').fillRect(0,0,640,480);
    if(!videoTracks.length)document.getElementById('cameraVideo').play=async()=>{};
    const audio=new(window.AudioContext||window.webkitAudioContext)(),destination=audio.createMediaStreamDestination();
    window.syntheticInputAudio=audio;window.syntheticTracks=[...videoTracks,...destination.stream.getAudioTracks()];
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>new MediaStream(window.syntheticTracks)}});
    window.WebSocket=class{
      static OPEN=1;readyState=0;bufferedAmount=0;
      constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}
      send(message){if(JSON.parse(message).type==='authenticate')setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ready'})}),0);}
      close(){this.readyState=3;this.onclose?.();}
    };
  });
  await task(page,'walkthrough');await page.locator('#startWalk').click();await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
  await expect(page.locator('#startWalk')).toBeHidden();await expect(page.locator('#stopWalk')).toBeVisible();await expect(page.locator('#muteMic')).toBeVisible();await expect(page.locator('#takePhoto')).toBeEnabled();
  await page.locator('#muteMic').click();await expect(page.locator('#muteMic')).toHaveText('Unmute microphone');
  await page.locator('.capture-options summary').click();await page.locator('#thermalToggle').click();await expect(page.locator('#thermalBadge')).toBeVisible();
  await page.locator('#stopWalk').click();await expect(page.locator('#startWalk')).toBeVisible();await expect(page.locator('#stopWalk')).toBeHidden();await expect(page.locator('#thermalBadge')).toBeHidden();await expect(page.locator('#takePhoto')).toBeDisabled();
  expect(await page.evaluate(()=>window.syntheticTracks.every(track=>track.readyState==='ended'))).toBe(true);await page.evaluate(()=>window.syntheticInputAudio.close());
});

test('safe four-document render, separate currency, signed recovery and invalidation',async({page})=>{
  await audit(page);await expect(page.locator('#proposalBody')).toContainText('$1,208.00–$1,221.90');await expect(page.locator('#proposalBody')).toContainText('$1,208.00');
  await expect(page.locator('#proposalBody')).toContainText('<img src=x');expect(await page.evaluate(()=>window.reviewInjected)).toBeUndefined();
  await page.locator('#documentsConfirmed').check();await draw(page);await page.locator('#authorizeJob').click();await expect(page.locator('#saveStatus')).toContainText('Saved & signed');
  await expect(page.locator('#savedSignature')).toBeVisible();await page.reload();await expect(page.locator('#address')).toBeEnabled();
  await menu(page,'jobMenu');await page.locator('#openJobs').click();await page.locator('.job-link').filter({hasText:'Signed · $1,208.00–$1,221.90'}).last().click();await expect(page.locator('#savedSignature')).toBeVisible();
  await expect(page.locator('#address')).toBeDisabled();await menu(page,'jobMenu');await page.locator('#newInspection').click();await audit(page);
  await draw(page);await task(page,'property');await page.locator('#address').fill('Changed address');await expect(page.locator('#documents')).toBeHidden();await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
});
test('failed audit stays unsigned and failed save keeps retry reference',async({page})=>{
  await scope(page);await fault(page,{audit:1});
  await page.locator('#finishAudit').click();await expect(page.locator('#message')).toContainText('Synthetic provider failure');await expect(page.locator('#documents')).toBeHidden();
  await page.locator('#finishAudit').click();await expect(page.locator('#documents')).toBeVisible();await page.locator('#documentsConfirmed').check();await draw(page);
  await fault(page,{authorize:1});
  await page.locator('#authorizeJob').click();await expect(page.locator('#authorizationStatus')).toContainText('Save not confirmed');await page.locator('#authorizeJob').click();await expect(page.locator('#saveStatus')).toContainText('Saved & signed');const {references}=await fault(page,{});expect(references[0]).toBe(references[1]);
});
async function fault(page,faults){return page.evaluate(async faults=>(await fetch('/__test/fault',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:sessionStorage.getItem('synthetic-uid'),faults})})).json(),faults);}
test('offline draft reload and reconnection preserve local work',async({page,context,browserName})=>{
  test.skip(browserName==='webkit','Windows Playwright WebKit returns an internal navigation error with offline service workers; physical iPhone acceptance remains open.');
  await scope(page);await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});await context.setOffline(true);await page.locator('#technicianNotes').fill('Local observations while offline');await expect(page.locator('#saveStatus')).toContainText('offline');
  await page.waitForTimeout(1700);await page.reload();await expect(page.locator('#technicianNotes')).toHaveValue('Local observations while offline');await expect(page.locator('#finishAudit')).toBeDisabled();
  await context.setOffline(false);await page.locator('#saveDraft').click();await expect(page.locator('#saveStatus')).toContainText('Saved privately');await page.reload();await expect(page.locator('#technicianNotes')).toHaveValue('Local observations while offline');
});
test('permission denial, portrait evidence, clipboard denial and print document layout',async({page,browserName})=>{
  await scope(page);await page.evaluate(()=>{Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{throw new DOMException('Synthetic permission denial','NotAllowedError');}}});});
  await task(page,'walkthrough');await page.locator('#startWalk').click();await expect(page.locator('#message')).toContainText('Retry permissions');await expect(page.locator('#cameraEmpty')).toBeVisible();
  const photo=await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=300;c.height=600;c.getContext('2d').fillRect(0,0,100,100);return c.toDataURL('image/png');});
  await page.locator('#photoFileInput').setInputFiles({name:'portrait.png',mimeType:'image/png',buffer:Buffer.from(photo.split(',')[1],'base64')});
  await expect(page.locator('#photoGallery')).toContainText('300 × 600');await expect(page.locator('#photoGallery')).toContainText('no meter');await expect(page.locator('#photoCount')).toContainText('0 verified');
  await task(page,'property');await page.locator('#scopeConfirmed').check();await page.locator('#finishAudit').click();await expect(page.locator('#documents')).toBeVisible();
  await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('denied');}}});});await menu(page,'exportMenu');await page.locator('#copyJson').click();await expect(page.locator('#message')).toContainText('Download scope JSON');
  await page.emulateMedia({media:'print'});for(const id of ['doc-proposal','doc-claim','doc-defense','doc-photos'])await expect(page.locator('#'+id)).toBeVisible();
  if(browserName==='chromium')await page.pdf({path:test.info().outputPath('repaired-documents.pdf'),format:'Letter',printBackground:true});
});

test('revision conflict preserves local work and explicit recovery restores the server',async({page})=>{
  await scope(page);await page.evaluate(async()=>{const rows=await(await fetch('/api/inspections',{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json();const id=rows.inspections[0].inspection_id;const record=await(await fetch('/api/inspections/'+id,{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json();record.data.technician_notes='Edited in another tab';await fetch('/api/inspections/'+id,{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')},body:JSON.stringify({expected_revision:record.revision,data:record.data})});});
  await page.locator('#technicianNotes').fill('Local work must survive');await page.locator('#saveDraft').click();await expect(page.locator('#conflictActions')).toBeVisible();await expect(page.locator('#technicianNotes')).toHaveValue('Local work must survive');
  await page.reload();await expect(page.locator('#conflictActions')).toBeVisible();await expect(page.locator('#technicianNotes')).toHaveValue('Local work must survive');await page.locator('#restoreRemote').click();await expect(page.locator('#technicianNotes')).toHaveValue('Edited in another tab');
});
test('worker update prompts, preserves the draft and keeps protected data out of caches',async({page})=>{
  await scope(page);await page.evaluate(()=>navigator.serviceWorker.ready);await page.locator('#technicianNotes').fill('Preserve during installed update');await page.locator('#saveDraft').click();await fault(page,{worker:true});await page.evaluate(async()=>{const registration=await navigator.serviceWorker.ready;await registration.update();});
  await expect(page.locator('#updateBanner')).toBeVisible();await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#applyUpdate').click()]);await expect(page.locator('#technicianNotes')).toHaveValue('Preserve during installed update');
  const urls=await page.evaluate(async()=>{const result=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())result.push(request.url);return result;});expect(urls.filter(url=>url.includes('/api/'))).toEqual([]);
});
test('logout clears user-specific local drafts',async({page})=>{
  await scope(page);await page.locator('#technicianNotes').fill('Synthetic private logout draft');await menu(page,'accountMenu');await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#signOutButton').click()]);await expect(page.locator('#technicianNotes')).toHaveValue('');
  const rows=await page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('adr-private-drafts-v2');request.onsuccess=()=>{const read=request.result.transaction('drafts').objectStore('drafts').getAll();read.onsuccess=()=>resolve(read.result);read.onerror=reject;};}));expect(rows.every(row=>row.draft.data.technician_notes!=='Synthetic private logout draft')).toBe(true);
});
test('sign out keeps an unsynced offline draft until the user discards it',async({page,context,browserName})=>{
  test.skip(browserName==='webkit','Windows Playwright WebKit offline navigation limitation; physical iPhone acceptance remains open.');
  const rows=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('adr-private-drafts-v2');request.onsuccess=()=>{const read=request.result.transaction('drafts').objectStore('drafts').getAll();read.onsuccess=()=>resolve(read.result);read.onerror=reject;};}));
  await scope(page);await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
  await context.setOffline(true);await page.locator('#technicianNotes').fill('Unsynced offline observations');await expect(page.locator('#saveStatus')).toContainText('offline');
  await menu(page,'accountMenu');await page.locator('#signOutButton').click();
  await expect(page.locator('#unsyncedActions')).toBeVisible();await expect(page.locator('#unsyncedCount')).toHaveText('1 draft has not synced. Connect to the internet and wait for sync, or discard it and sign out.');
  await expect(page.locator('#signInButton')).toBeHidden();await expect(page.locator('#technicianNotes')).toHaveValue('Unsynced offline observations');
  expect((await rows()).some(row=>row.draft.data.technician_notes==='Unsynced offline observations')).toBe(true);
  await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#discardSignOut').click()]);
  await expect(page.locator('#signInButton')).toBeVisible();expect((await rows()).length).toBe(0);
  await context.setOffline(false);
});
test('reconnection synchronizes an older queued inspection as well as the open draft',async({page,context,browserName})=>{
  test.skip(browserName==='webkit','Real offline navigation is covered on Chromium; Windows WebKit device acceptance remains open.');
  await scope(page);const original=await page.evaluate(async()=>{const r=await(await fetch('/api/inspections',{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json();return r.inspections[0].inspection_id;});
  await context.setOffline(true);await page.locator('#technicianNotes').fill('Older queued observations');await menu(page,'jobMenu');await page.locator('#newInspection').click();await expect(page.locator('#address')).toHaveValue('');await page.locator('#address').fill('Second local draft');await page.locator('#saveDraft').click();await context.setOffline(false);
  await expect.poll(()=>page.evaluate(async id=>(await(await fetch('/api/inspections/'+id,{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json()).data.technician_notes,original)).toBe('Older queued observations');
});
test('reconnection reports a queued draft that changed on another device',async({page,context,request,browserName})=>{
  test.skip(browserName==='webkit','Real offline navigation is covered on Chromium; Windows WebKit device acceptance remains open.');
  await scope(page);const uid=await page.evaluate(()=>sessionStorage.getItem('synthetic-uid')),headers={Authorization:'Bearer '+uid};
  const original=(await(await request.get('/api/inspections',{headers})).json()).inspections[0].inspection_id;
  await context.setOffline(true);await page.locator('#technicianNotes').fill('Queued observations on this device');await menu(page,'jobMenu');await page.locator('#newInspection').click();await expect(page.locator('#address')).toHaveValue('');
  const record=await(await request.get('/api/inspections/'+original,{headers})).json();record.data.technician_notes='Edited on another device';
  expect((await request.put('/api/inspections/'+original,{headers,data:{expected_revision:record.revision,data:record.data}})).ok()).toBe(true);
  await context.setOffline(false);
  await expect(page.locator('#message')).toHaveText('1 queued draft changed on another device. Open it from Jobs to choose which version to keep.');
  expect((await(await request.get('/api/inspections/'+original,{headers})).json()).data.technician_notes).toBe('Edited on another device');
});
test('reopening a draft after a signed job releases the signed photo object URLs',async({page})=>{
  await page.locator('#address').fill('Draft to reopen');await page.locator('#saveDraft').click();await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  await menu(page,'jobMenu');await page.locator('#newInspection').click();await expect(page.locator('#address')).toHaveValue('');
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=300;c.height=600;return c.toDataURL('image/png');});
  await page.locator('#photoFileInput').setInputFiles({name:'signed.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});await expect(page.locator('#photoGallery')).toContainText('no meter');
  await audit(page);await page.locator('#documentsConfirmed').check();await draw(page);await page.locator('#authorizeJob').click();await expect(page.locator('#saveStatus')).toContainText('Saved & signed');
  await expect.poll(()=>page.evaluate(()=>state.photoUrls.size)).toBe(1);
  const urls=await page.evaluate(()=>{window.revokedUrls=[];const revoke=URL.revokeObjectURL;URL.revokeObjectURL=url=>{window.revokedUrls.push(url);revoke(url);};return [...state.photoUrls.values()];});
  await menu(page,'jobMenu');await page.locator('#openJobs').click();await page.locator('.job-link').filter({hasText:'Draft to reopen'}).click();await expect(page.locator('#address')).toHaveValue('Draft to reopen');
  expect(await page.evaluate(()=>[state.photoUrls.size,window.revokedUrls])).toEqual([0,expect.arrayContaining(urls)]);
});

async function photoDraft(page){
  await scope(page);
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=300;c.height=600;return c.toDataURL('image/png');});
  await page.locator('#photoFileInput').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
  await expect(page.locator('#photoCount')).toContainText('1 photos');
  await expect(page.locator('#photoGallery')).toContainText('no meter');
  const id=await page.evaluate(async()=>{const rows=await(await fetch('/api/inspections',{headers:{Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid')}})).json();return rows.inspections.find(r=>r.address==='Synthetic browser property').inspection_id;});
  return {id,image};
}
async function restoreCloudOnly(page,id){
  await menu(page,'jobMenu');await page.locator('#newInspection').click();
  await expect(page.locator('#jobMenu')).not.toHaveAttribute('open');
  await page.evaluate(id=>new Promise((resolve,reject)=>{const request=indexedDB.open('adr-private-drafts-v2');request.onsuccess=()=>{const tx=request.result.transaction('drafts','readwrite');tx.objectStore('drafts').delete(sessionStorage.getItem('synthetic-uid')+':'+id);tx.oncomplete=resolve;tx.onerror=reject;};}),id);
  await menu(page,'jobMenu');await page.locator('#openJobs').click();await page.locator('.job-link').filter({hasText:'Synthetic browser property'}).click();
  await task(page,'evidence');await expect(page.locator('#photoGallery img')).toHaveCount(1);
  await expect.poll(()=>page.locator('#photoGallery img').evaluate(el=>el.naturalWidth)).toBe(300);
}
test('cloud-restored originals survive photo-backed conflict fork',async({page})=>{
  const {id}=await photoDraft(page);await restoreCloudOnly(page,id);
  await page.evaluate(async id=>{const headers={Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid'),'Content-Type':'application/json'};const r=await(await fetch('/api/inspections/'+id,{headers})).json();r.data.technician_notes='Other device changed the scope';await fetch('/api/inspections/'+id,{method:'PUT',headers,body:JSON.stringify({expected_revision:r.revision,data:r.data})});},id);
  await task(page,'property');await page.locator('#technicianNotes').fill('Keep this device work and photo');await page.locator('#saveDraft').click();await expect(page.locator('#conflictActions')).toBeVisible();
  await page.locator('#forkLocal').click();await expect(page.locator('#conflictActions')).toBeHidden();await expect(page.locator('#saveStatus')).toContainText('Saved privately');await expect(page.locator('#technicianNotes')).toHaveValue('Keep this device work and photo');
  await task(page,'evidence');await expect.poll(()=>page.locator('#photoGallery img').evaluate(el=>el.naturalWidth)).toBe(300);
});
test('reopened local draft merges photos added by another device',async({page})=>{
  const {id,image}=await photoDraft(page);
  await page.evaluate(async({id,image})=>{const headers={Authorization:'Bearer '+sessionStorage.getItem('synthetic-uid'),'Content-Type':'application/json'};const r=await(await fetch('/api/inspections/'+id,{headers})).json();const response=await fetch('/api/inspections/'+id+'/photos',{method:'POST',headers,body:JSON.stringify({photo_id:'d'.repeat(32),expected_revision:r.revision,room:r.data.rooms[0].name,captured_at:new Date().toISOString(),data_url:image})});if(!response.ok)throw Error(await response.text());await fetch('/api/inspections/'+id+'/photos/'+'d'.repeat(32)+'/ocr',{method:'POST',headers,body:'{}'});},{id,image});
  await page.reload();await task(page,'evidence');await expect(page.locator('#photoGallery img')).toHaveCount(2);await expect.poll(()=>page.locator('#photoGallery img').evaluateAll(images=>images.every(img=>img.naturalWidth===300))).toBe(true);
});
test('cloud-restored photos remain visible after offline reload',async({page,context,browserName})=>{
  test.skip(browserName==='webkit','Windows WebKit offline navigation limitation; physical iPhone acceptance remains open.');
  const {id}=await photoDraft(page);await restoreCloudOnly(page,id);
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});
  await context.setOffline(true);await page.reload();await task(page,'evidence');await expect.poll(()=>page.locator('#photoGallery img').evaluate(el=>el.naturalWidth)).toBe(300);
});
test('saved jobs list is newest first and loads older signed jobs',async({page})=>{
  await page.evaluate(async()=>{const response=await fetch('/__test/seed-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uid:sessionStorage.getItem('synthetic-uid')})});if(!response.ok)throw Error('Synthetic seed failed');});
  await menu(page,'jobMenu');await page.locator('#openJobs').click();
  const signed=page.locator('.job-link').filter({hasText:'Synthetic signed job'});
  await expect(signed).toHaveCount(100);await expect(signed.first()).toContainText('job 104');await expect(signed.last()).toContainText('job 005');
  await page.getByRole('button',{name:'Load older signed jobs'}).click();await expect(signed).toHaveCount(105);await expect(signed.last()).toContainText('job 000');await expect(page.getByRole('button',{name:'Load older signed jobs'})).toBeHidden();
});

for(const failure of ['evidence','record'])test('durable signing receipt survives '+failure+' display failure',async({page})=>{
  await audit(page);await page.locator('#documentsConfirmed').check();await draw(page);await fault(page,{[failure]:1});await page.locator('#authorizeJob').click();
  await expect(page.locator('#saveStatus')).toContainText('Saved & signed');await expect(page.locator('#retrySavedEvidence')).toBeVisible();await expect(page.locator('#message')).toContainText('saved');await expect(page.locator('#address')).toBeDisabled();
  await page.locator('#retrySavedEvidence').click();await expect(page.locator('#savedSignature')).toBeVisible();await expect(page.locator('#retrySavedEvidence')).toBeHidden();
  const {references}=await fault(page,{});expect(references).toHaveLength(1);
});

test('walkthrough form fill requires review, supports selection and invalidates old documents',async({page})=>{
  await audit(page);await task(page,'walkthrough');await page.locator('details:has(#technicianTranscript) summary').click();
  await page.locator('#technicianTranscript').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await page.locator('#fillScope').click();await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('10');await expect(page.locator('#airMovers')).toHaveValue('0');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:test.info().outputPath('voice-scope-mobile-suggestions.png'),fullPage:true});
  await expect(page.locator('#scopeSuggestionList')).toContainText('10 → 80');await expect(page.locator('#scopeQuestions')).toContainText('Confirm any additional labor.');
  await page.locator('.scope-suggestion').filter({hasText:'Air movers'}).locator('input').uncheck();
  await page.locator('#applyScopeSuggestions').click();
  await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');await expect(page.locator('[data-room-key="category"]')).toHaveValue('2');await expect(page.locator('#airMovers')).toHaveValue('0');
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();await expect(page.locator('#documents')).toBeHidden();await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();
  await page.locator('#saveDraft').click();await page.reload();await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('80');
  await page.locator('#scopeConfirmed').check();await page.locator('#finishAudit').click();await expect(page.locator('#itemizedTotal')).toHaveText('$1,411.40');
});

test('scope suggestions dismiss and manual edits preserve user values',async({page})=>{
  await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await page.locator('#fillScopeProperty').click();await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.locator('#dismissScopeSuggestions').click();await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
  await page.locator('#fillScopeProperty').click();await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await page.locator('#airMovers').fill('6');await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();await expect(page.locator('#airMovers')).toHaveValue('6');
});

test.describe('controlled scope requests',()=>{
  test.use({serviceWorkers:'block'});

test('delayed scope results cannot overwrite manual edits',async({page})=>{
  let release,started;const gate=new Promise(resolve=>release=resolve),requestStarted=new Promise(resolve=>started=resolve);
  await page.route('**/scope-suggestions',async route=>{started();await gate;await route.continue();});
  try{
    await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
    await page.locator('#fillScopeProperty').click();await requestStarted;
    await page.locator('#airMovers').fill('6');release();
    await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();await expect(page.locator('#airMovers')).toHaveValue('6');
    await expect(page.locator('#message')).toContainText(/changed/);
  }finally{release();}
});

test('fill scope stops active capture before showing reviewable changes',async({page})=>{
  test.skip(!await page.evaluate(()=>!!(window.AudioContext||window.webkitAudioContext)),'Windows WebKit has no Web Audio; physical iPhone capture cleanup remains open.');
  await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
    const videoTracks=canvas.captureStream?canvas.captureStream(1).getVideoTracks():[];canvas.getContext('2d').fillRect(0,0,640,480);
    if(!videoTracks.length)document.getElementById('cameraVideo').play=async()=>{};
    const audio=new(window.AudioContext||window.webkitAudioContext)(),destination=audio.createMediaStreamDestination();
    window.syntheticInputAudio=audio;window.syntheticTracks=[...videoTracks,...destination.stream.getAudioTracks()];
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>new MediaStream(window.syntheticTracks)}});
    window.WebSocket=class{
      static OPEN=1;readyState=0;bufferedAmount=0;
      constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}
      send(message){if(JSON.parse(message).type==='authenticate')setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'ready'})}),0);}
      close(){this.readyState=3;this.onclose?.();}
    };
  });
  await task(page,'walkthrough');await page.locator('#startWalk').click();await expect(page.locator('#liveStatus')).toHaveText('Live AI connected');
  await page.locator('#fillScope').click();await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  expect(await page.evaluate(()=>window.syntheticTracks.every(track=>track.readyState==='ended'))).toBe(true);
  expect(await page.locator('#cameraVideo').evaluate(el=>el.srcObject===null)).toBe(true);
  await expect(page.locator('#liveStatus')).toHaveText('Not connected');await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
  await page.evaluate(()=>window.syntheticInputAudio.close());
});

test('scope results from a previous inspection are discarded',async({page})=>{
  let release,started;const gate=new Promise(resolve=>release=resolve),requestStarted=new Promise(resolve=>started=resolve);
  await page.route('**/scope-suggestions',async route=>{started();await gate;await route.continue();});
  try{
    await page.locator('#technicianNotes').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
    await page.locator('#fillScopeProperty').click();await requestStarted;
    await menu(page,'jobMenu');await page.locator('#newInspection').click();await expect(page.locator('#technicianNotes')).toHaveValue('');release();
    await expect(page.locator('#fillScopeProperty')).toHaveText('Fill scope from walkthrough');await expect(page.locator('#scopeSuggestionPanel')).toBeHidden();await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
  }finally{release();}
});

});
