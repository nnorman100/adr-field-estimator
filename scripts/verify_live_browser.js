/* Normal Google staff sign-in and synthetic release verification. No auth state is exported. */
const {chromium,expect}=require('@playwright/test');
const {launchManual,closeManual,sameContextPage}=require('./manual_chrome');
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process'),readline=require('node:readline');
const ROOT=path.resolve(__dirname,'..'),BASE='https://alert-disaster-field-2026.web.app';
const PRODUCTION='https://alert-disaster-field-estimator-545776254070.us-west2.run.app';
const STAGED=process.argv.includes('--workspaces')?'https://workspaces---alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app':'https://live-reliable---alert-disaster-field-estimator-ecyxym3iqa-wl.a.run.app';
const PYTHON=process.env.ADR_TEST_PYTHON||'C:/Users/nnorm/AppData/Roaming/uv/python/cpython-3.11.15-windows-x86_64-none/python.exe';
const mode=process.argv.includes('--production')?'production':'staged';
const HOLD=process.argv.includes('--hold'),HEADLESS=process.argv.includes('--headless');
let service=mode==='production'?PRODUCTION:STAGED,local=mode==='staged';
const inspections=new Set(),agreements=new Set();
const logDir=path.join(ROOT,'review-artifacts',process.argv.includes('--workspaces')?'workspaces-20261007':'live-release-20261007');
fs.mkdirSync(logDir,{recursive:true});
function safe(text){return String(text).replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[token omitted]');}
function python(args,input,label){
  return new Promise((resolve,reject)=>{
    const environment={...process.env,PYTHONPATH:path.join(ROOT,'.voice-test-deps'),PYTHONUNBUFFERED:'1'};
    const child=spawn(PYTHON,[path.join(ROOT,'scripts','verify_live_release.py'),...args],{cwd:ROOT,env:environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
    let output='';
    const record=data=>{const clean=safe(data.toString());output+=clean;process.stdout.write(clean);};
    child.stdout.on('data',record);child.stderr.on('data',record);
    child.once('error',reject);child.once('exit',code=>{
      fs.writeFileSync(path.join(logDir,label+'.txt'),output);
      code===0?resolve():reject(Error(label+' failed; see its credential-free log.'));
    });
    child.stdin.end(input+'\n');
  });
}
(async()=>{
  let manual=null,browser,context,page,signedPage=null;
  let userUid=null,cachedToken=null;
  const smoke=process.argv.includes('--auth-smoke');
  try{
  if(!smoke){
    if(HEADLESS)throw Error('Google sign-in requires normal private Chrome; headless is only for --auth-smoke.');
    manual=await launchManual(BASE);
    console.log('MANUAL_SIGN_IN_REQUIRED: This is normal private Chrome, with no automation attached. Sign in to the app, then send signed-in to this helper. No password/token in chat.');
    const input=readline.createInterface({input:process.stdin});
    let requested=false;
    for await(const line of input){if(line.trim()==='signed-in'){requested=true;break;}if(line.trim()==='quit')break;}
    input.close();
    if(!requested){await closeManual(null,manual);return;}
    console.log('HANDOFF: attaching to the signed-in private Chrome window.');
    browser=await chromium.connectOverCDP(manual.endpoint);
    console.log('HANDOFF: connected to Chrome.');
    context=browser.contexts().find(c=>c.pages().some(p=>p.url().startsWith(BASE)));
    if(!context)throw Error('The manual sign-in tab is not available.');
    signedPage=context.pages().find(p=>p.url().startsWith(BASE));
    await signedPage.waitForFunction(()=>window.firebase?.apps?.length>0&&window.firebase.auth().currentUser&&document.getElementById('address').disabled===false,{},{timeout:30000});
    const existing=await signedPage.evaluate(()=>({signedIn:!!firebase.auth().currentUser,inspection:typeof state!=='undefined'&&state.record?.status==='draft'&&stable(state.draft?.data)===stable(emptyData())&&!state.draft.photos.length?state.draft.inspection_id:null}));
    if(!existing.signedIn)throw Error('Normal Chrome is not signed in yet. Finish Google sign-in before sending signed-in.');
    cachedToken=await signedPage.evaluate(()=>firebase.auth().currentUser.getIdToken());
    console.log('HANDOFF: staff sign-in confirmed in the original Chrome page.');
    if(existing.inspection)inspections.add(existing.inspection);
    await signedPage.evaluate(async()=>{for(const registration of await navigator.serviceWorker.getRegistrations())await registration.unregister();});
    page=await sameContextPage(browser,signedPage);
  }else{
    browser=await chromium.launch({headless:true,channel:'chrome'});
    context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    page=await context.newPage();
  }
  }catch(error){
    await closeManual(browser,manual); 
    throw error;
  }
  try{
    await page.route(BASE+'/**',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(smoke&&process.argv.includes('--slow-init')&&url.pathname==='/__/firebase/init.json')await new Promise(resolve=>setTimeout(resolve,1500));
      if(url.pathname.startsWith('/api/')){
        const authorization=request.headers().authorization;
        if(authorization?.startsWith('Bearer '))cachedToken=authorization.slice(7);
        if(request.method()==='POST'&&url.pathname==='/api/inspections'){
          const value=request.postDataJSON();inspections.add(value.inspection_id);
        }
        if(request.method()==='POST'&&url.pathname==='/api/authorize'){
          const value=request.postDataJSON();agreements.add(value.auth_id);
        }
        const response=await route.fetch({url:service+url.pathname+url.search,timeout:115000});
        if(url.pathname==='/api/session'&&response.ok())userUid=(await response.json()).uid;
        return route.fulfill({response});
      }
      if(url.pathname==='/vendor/firebase-auth-compat.js'){
        const source=fs.readFileSync(path.join(ROOT,'public','vendor','firebase-auth-compat.js'),'utf8');
        return route.fulfill({contentType:'text/javascript',body:source+'\nconst originalPersistence=firebase.auth.Auth.prototype.setPersistence;firebase.auth.Auth.prototype.setPersistence=function(){return originalPersistence.call(this,firebase.auth.Auth.Persistence.NONE);};'});
      }
      const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(local&&['index.html','app.js','workspaces.js','core.js','app.css','audio-worklet.js','sw.js'].includes(file)){
        const contentType=file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'text/javascript';
        return route.fulfill({contentType,body:fs.readFileSync(path.join(ROOT,'public',file))});
      }
      return route.continue();
    });
    await page.goto(BASE,{waitUntil:'domcontentloaded'});
    if(smoke)await expect(page.locator('#signInButton')).toBeVisible({timeout:30000});
    await page.waitForFunction(()=>window.firebase?.apps?.length>0&&window.firebase.auth()._delegate.persistenceManager?.persistence.type==='NONE',{},{timeout:30000});
    if(process.argv.includes('--auth-smoke')){console.log('PASS: actual Firebase SDK initializes with memory-only authentication and the dedicated sign-in UI. No jobs or IAM changes.');return;}
    console.log('VERIFYING_MANUAL_SESSION: Google sign-in was completed before automation attached.');
    await page.waitForFunction(()=>window.firebase?.apps?.length>0&&window.firebase.auth().currentUser&&document.getElementById('address').disabled===false,{},{timeout:30000});
    userUid=await page.evaluate(()=>firebase.auth().currentUser.uid);
    const memoryOnly=await page.evaluate(()=>firebase.auth()._delegate.persistenceManager.persistence.type);
    if(memoryOnly!=='NONE')throw Error('Auth persistence is not memory-only.');
    console.log('PASS: ordinary Google staff sign-in, memory-only Firebase authentication; no IAM changes.');
    if(signedPage&&!signedPage.isClosed()){await signedPage.close();signedPage=null;}
    async function token(){try{cachedToken=await page.evaluate(()=>firebase.auth().currentUser.getIdToken(true));}catch(error){if(!cachedToken)throw error;}return cachedToken;}
    async function cleanBrowserRecords(label){
      if(!inspections.size&&!agreements.size)return;
      await python([service,'--cleanup-stdin'],JSON.stringify({token:await token(),inspections:[...inspections],agreements:[...agreements]}),label+'-browser-cleanup');
      inspections.clear();agreements.clear();
    }
    async function uiCheck(label){
      await page.setViewportSize({width:390,height:844});
      // The page and all created IDs belong only to this ephemeral synthetic session.
      if(await page.locator('#workspaceDashboard').isVisible())await page.getByRole('button',{name:'New job',exact:true}).click();
      else{await page.locator('#jobMenu summary').click();await page.locator('#newInspection').click();}
      await expect(page.locator('#saveStatus')).toContainText('Saved privately',{timeout:30000});
      await page.locator('#address').fill('Synthetic browser release verification - no customer data');
      await page.locator('#yearBuilt').fill('2000');
      await page.locator('#technicianNotes').fill('Room 1, category 1. I measured 10 square feet of finished drywall to remove. For this job use 3 fans and 1 dehumidifier for 3 days. Proposed localized drywall removal and drying only.');
      await page.locator('#fillScopeProperty').click();
      await expect(page.locator('#scopeSuggestionPanel')).toBeVisible({timeout:90000});
      await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('0');
      await expect(page.locator('#airMovers')).toHaveValue('0');
      await page.locator('.scope-suggestion').filter({hasText:'Air movers'}).locator('input').uncheck();
      await page.locator('#applyScopeSuggestions').click();
      await expect(page.locator('[data-room-key="finished_sf"]')).toHaveValue('10');
      await expect(page.locator('#airMovers')).toHaveValue('0');
      await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
      await page.locator('#airMovers').fill('3');
      await page.locator('#dehumidifiers').fill('1');
      await page.locator('#scopeConfirmed').check();
      await page.locator('#finishAudit').click();
      await expect(page.locator('#itemizedTotal')).toHaveText('$1,775.00',{timeout:90000});
      await expect(page.locator('#estimateRange')).toContainText('$1,788.90');
      const tabs=page.locator('[data-tab]');
      for(let index=0;index<await tabs.count();index++)await tabs.nth(index).click();
      await page.locator('[data-tab="proposal"]').click();
      await page.locator('#documentsConfirmed').check();
      const box=await page.locator('#signCanvas').boundingBox();
      await page.mouse.move(box.x+20,box.y+40);await page.mouse.down();
      await page.mouse.move(box.x+120,box.y+80,{steps:12});await page.mouse.move(box.x+220,box.y+35,{steps:12});await page.mouse.up();
      await page.locator('#authorizeJob').click();
      await expect(page.locator('#saveStatus')).toContainText('Saved & signed',{timeout:45000});
      await expect(page.locator('#savedSignature')).toBeVisible();
      await expect(page.locator('#address')).toBeDisabled();
      if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile layout overflows.');
      await page.screenshot({path:path.join(logDir,label+'-synthetic-mobile.png')});
      console.log('PASS: '+label+' real UI reviewed form filling, selected changes, workbook range, four documents and signing.');
    }
    async function run(label){
      try{
        await python([service,'--token-stdin'],await token(),label+'-authenticated');
        await uiCheck(label);
      }finally{
        await cleanBrowserRecords(label);
      }
    }
    let verified=false;
    while(!verified){
      try{await run(mode);verified=true;}
      catch(error){
        if(!HOLD)throw error;
        console.error('CHECK_FAILED: '+safe(error.message));
        console.log('AUTH_RETAINED: browser sign-in remains in memory. Send retry after repair, or quit.');
        const recovery=readline.createInterface({input:process.stdin});let retry=false;
        for await(const line of recovery){if(line.trim()==='retry'){retry=true;break;}if(line.trim()==='quit')break;}
        recovery.close();if(!retry)return;
      }
    }
    if(HOLD){
      console.log(mode==='production'?'PRODUCTION_VERIFIED: authenticated production API and UI checks passed; send quit.':'READY_FOR_CUTOVER: staged checks passed; browser auth retained only in memory. Send production after backend/Hosting release, or quit.');
      const commands=readline.createInterface({input:process.stdin});
      for await(const line of commands){
        if(line.trim()==='quit')break;
        if(line.trim()==='production'){
          service=PRODUCTION;local=false;
          try{
            await run('production');
            console.log('PRODUCTION_VERIFIED: authenticated relay and real UI checks passed.');
          }catch(error){
            console.error('CHECK_FAILED: '+safe(error.message));
            console.log('AUTH_RETAINED: production checks failed; repair and send production again, or quit.');
          }
        }
      }
    }
  }finally{
    if(cachedToken&&(inspections.size||agreements.size)){
      await python([service,'--cleanup-stdin'],JSON.stringify({token:cachedToken,inspections:[...inspections],agreements:[...agreements]}),'failure-browser-cleanup').catch(()=>console.error('Synthetic cleanup needs attention; see its credential-free log.'));
    }
    // Credentials are never exported as browser storage state.
    await page.evaluate(async()=>{if(window.firebase?.auth().currentUser)await firebase.auth().signOut();}).catch(()=>{});
    if(!manual)await context.close().catch(()=>{});
    await closeManual(browser,manual);
    process.stdin.pause();
  }
})().catch(error=>{console.error('FAIL: '+safe(error.message));process.exitCode=1;});
