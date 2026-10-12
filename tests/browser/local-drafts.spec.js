const {test,expect}=require('@playwright/test');
const {randomUUID}=require('node:crypto');
const core=require('../../public/core.js');
const auth=uid=>({Authorization:'Bearer '+uid});
async function ready(page){await expect(page.locator('#address')).toBeEnabled({timeout:15000});await expect(page.locator('#saveStatus')).toContainText('Saved privately');}
async function controlled(page){await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));});}
async function addImage(page,width,height){
  const image=await page.evaluate(([width,height])=>{const c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').fillRect(0,0,width/2,height/2);return c.toDataURL('image/png');},[width,height]);
  await page.locator('#photoFileInput').setInputFiles({name:'synthetic-'+width+'.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});return image;
}
const widths=page=>page.locator('#photoGallery img').evaluateAll(images=>images.map(img=>img.naturalWidth).sort((a,b)=>a-b));
const storage=page=>page.evaluate(()=>new Promise((resolve,reject)=>{const request=indexedDB.open('adr-private-drafts-v2');request.onerror=reject;request.onsuccess=()=>{try{const db=request.result,tx=db.transaction(['drafts','photos']),drafts=tx.objectStore('drafts').getAll(),photos=tx.objectStore('photos').getAll();tx.oncomplete=()=>{resolve({version:db.version,drafts:drafts.result,photos:photos.result});db.close();};}catch(e){reject(e.message);}};}));

test('offline draft with several photos survives reload with images intact and bytes kept out of the draft row',async({page,context,browserName})=>{
  test.skip(browserName==='webkit'&&process.platform==='win32','Windows Playwright WebKit offline navigation limitation; physical iPhone acceptance remains open.');
  await page.goto('/');await ready(page);await controlled(page);
  await context.setOffline(true);
  for(const [width,height] of [[300,600],[200,100],[120,80]]){await addImage(page,width,height);}
  await expect(page.locator('#photoCount')).toContainText('3 photos');await expect(page.locator('#saveStatus')).toContainText('offline');
  await page.reload();await page.locator('.task-nav [data-task="evidence"]').click();
  await expect(page.locator('#photoGallery img')).toHaveCount(3);await expect.poll(()=>widths(page)).toEqual([120,200,300]);
  const {drafts,photos}=await storage(page),row=drafts.find(r=>r.draft.photos.length===3);
  expect(row.draft.photos.some(p=>'data_url'in p)).toBe(false);expect(photos.filter(p=>p.draft_key===row.key).length).toBe(3);
  await context.setOffline(false);await page.locator('#saveDraft').click();await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  const uid=await page.evaluate(()=>sessionStorage.getItem('synthetic-uid')),remote=await(await page.request.get('/api/inspections/'+row.draft.inspection_id,{headers:auth(uid)})).json();
  expect(remote.photos.map(p=>p.width).sort((a,b)=>a-b)).toEqual([120,200,300]);
  await page.locator('#accountMenu summary').click();await Promise.all([page.waitForEvent('domcontentloaded'),page.locator('#signOutButton').click()]);
  expect(await storage(page)).toMatchObject({drafts:[],photos:[]});
});

test('typing a note rewrites the draft row a few times and never rewrites photo bytes',async({page})=>{
  await page.addInitScript(()=>{window.__storePuts=[];const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){window.__storePuts.push(this.name);return put.apply(this,args);};});
  await page.goto('/');await ready(page);
  for(const [width,height] of [[300,600],[200,100]])await addImage(page,width,height);
  await expect(page.locator('#photoCount')).toContainText('2 photos');await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  await page.evaluate(async()=>{await syncChain;await Promise.all([...state.ocr.values()]);});
  await page.locator('#saveDraft').click();
  await page.evaluate(()=>syncChain);
  await page.evaluate(()=>{window.__storePuts=[];});
  await page.locator('#technicianNotes').pressSequentially('Moisture readings along the north wall.',{delay:10});
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');await page.waitForTimeout(600);
  const puts=await page.evaluate(()=>window.__storePuts);
  expect(puts.filter(name=>name==='photos')).toEqual([]);expect(puts.filter(name=>name==='drafts').length).toBeLessThanOrEqual(4);
  await page.reload();await expect(page.locator('#technicianNotes')).toHaveValue('Moisture readings along the north wall.');
});

test('an immediate save consumes the pending autosave without losing later edits',async({page})=>{
  await page.goto('/');await ready(page);await page.evaluate(()=>syncChain);
  await page.evaluate(()=>{window.__syncCalls=0;const original=doSync;doSync=async()=>{window.__syncCalls++;return original();};});
  await page.locator('#technicianNotes').fill('Saved now');
  await page.locator('#saveDraft').click();await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  await page.evaluate(()=>syncChain);
  // Observe beyond the application's 1500 ms autosave deadline, not a network readiness delay.
  await page.waitForTimeout(1700);
  expect(await page.evaluate(()=>window.__syncCalls)).toBe(1);
  await page.locator('#technicianNotes').fill('A later edit still autosaves');
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  await page.evaluate(()=>syncChain);
  expect(await page.evaluate(()=>window.__syncCalls)).toBe(2);
  await page.reload();await expect(page.locator('#technicianNotes')).toHaveValue('A later edit still autosaves');
});

test('finishing the initial save does not close a Jobs menu opened during startup',async({page})=>{
  // Gate at fetch entry so service-worker ownership cannot bypass Playwright routing.
  await page.addInitScript(()=>{
    const fetch=window.fetch,gate=new Promise(resolve=>{window.__releaseInitialSave=resolve;});
    window.fetch=async function(input,options){
      if(input==='/api/inspections'&&options?.method==='POST'){window.__initialSaveStarted=true;await gate;}
      return fetch.call(this,input,options);
    };
  });
  try{
    await page.goto('/');await page.waitForFunction(()=>window.__initialSaveStarted);
    await expect(page.locator('#address')).toBeEnabled();
    await page.locator('#jobMenu summary').click();
    await expect(page.locator('#openJobs')).toBeVisible();
    await page.evaluate(()=>window.__releaseInitialSave());
    await page.waitForFunction(()=>state.session&&!state.workspaceInitializing&&!state.syncing);
    await expect(page.locator('#saveStatus')).toContainText('Saved privately');
    await expect(page.locator('#openJobs')).toBeVisible();
    await page.locator('#openJobs').click();await expect(page.locator('#jobsDialog')).toBeVisible();
  }finally{await page.evaluate(()=>window.__releaseInitialSave?.()).catch(()=>{});}
});

test('version 1 draft rows with embedded photos migrate on upgrade and still sync, including a queued draft',async({page})=>{
  const uid='test-owner-migrate-'+randomUUID(),open='ADR-INS-'+randomUUID().replaceAll('-',''),queued='ADR-INS-'+randomUUID().replaceAll('-','');
  await page.goto('/manifest.webmanifest');
  const images=await page.evaluate(async({uid,open,queued,data})=>{
    sessionStorage.setItem('synthetic-uid',uid);
    const image=(width,height)=>{const c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').fillRect(0,0,10,10);return c.toDataURL('image/png');};
    const photo=(id,width,height)=>({id:id.repeat(32),room:'Room 1',captured_at:new Date().toISOString(),data_url:image(width,height),width,height,ocr_status:'pending',uploaded:false});
    const row=(id,address,photos,updated_at)=>({key:uid+':'+id,uid,company_id:null,draft:{inspection_id:id,data:{...data,address,technician_notes:'Written before the storage upgrade'},photos},record:null,ack:null,session:null,updated_at});
    const rows=[row(open,'Migrated open property',[photo('0',300,600),photo('1',200,100)],'2026-10-10T12:00:00.000Z'),row(queued,'Migrated queued property',[photo('2',120,80)],'2026-10-09T12:00:00.000Z')];
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('adr-private-drafts-v2',1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'key'});request.onsuccess=()=>resolve(request.result);request.onerror=reject;});
    await new Promise((resolve,reject)=>{const tx=db.transaction('drafts','readwrite');for(const r of rows)tx.objectStore('drafts').put(r);tx.oncomplete=resolve;tx.onerror=reject;});
    db.close();return rows.flatMap(r=>r.draft.photos.map(p=>p.data_url));
  },{uid,open,queued,data:core.emptyData()});
  await page.goto('/');await expect(page.locator('#address')).toHaveValue('Migrated open property',{timeout:15000});await expect(page.locator('#technicianNotes')).toHaveValue('Written before the storage upgrade');
  await page.locator('.task-nav [data-task="evidence"]').click();await expect.poll(()=>widths(page)).toEqual([200,300]);
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  const remote=async id=>(await(await page.request.get('/api/inspections/'+id,{headers:auth(uid)})).json()).photos?.map(p=>p.width)||[];
  await expect.poll(()=>remote(open)).toEqual([300,200]);
  await expect.poll(()=>remote(queued)).toEqual([120]);
  const {version,drafts,photos}=await storage(page);
  expect(version).toBe(2);expect(drafts.map(r=>r.draft.data.address).sort()).toEqual(['Migrated open property','Migrated queued property']);
  expect(drafts.some(r=>r.draft.photos.some(p=>'data_url'in p))).toBe(false);expect(photos.map(p=>p.data_url).sort()).toEqual([...images].sort());
});

