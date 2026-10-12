const {chromium}=require('playwright'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
  const base='https://alert-disaster-field-2026.web.app';
  const response=await fetch(base);assert(response.ok);assert.equal(await response.text(),fs.readFileSync('public/index.html','utf8'));
  for(const path of ['/', '/index.html', '/?v=ui-20261006-6']){
    const html=await fetch(base+path);
    assert.match(html.headers.get('cache-control')||'',/\bno-store\b/,'The app shell can stay stale in a browser: '+path);
    assert((await html.text()).includes('class="task-nav"'),'Redesigned task navigation is missing: '+path);
  }
  for(const file of ['app.js','workspaces.js','app.css','core.js','audio-worklet.js','sw.js'])assert.equal(await(await fetch(base+'/'+file+'?verify=repair-20261006')).text(),fs.readFileSync('public/'+file,'utf8'),'Deployed asset differs: '+file);
  for(const file of ['brand/adr-logo.jpg','fonts/lato-400-latin.woff2','fonts/lato-700-latin.woff2','fonts/lato-900-latin.woff2','fonts/ebgaramond-400-latin.woff2']){
    const asset=await fetch(base+'/'+file);assert(asset.ok);
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()),fs.readFileSync('public/'+file),'Deployed branding differs: '+file);
  }
  assert(response.headers.get('content-security-policy').includes("object-src 'none'"));
  assert.deepEqual(await(await fetch(base+'/api/health')).json(),{status:'healthy',schema_version:3});
  assert.equal((await fetch(base+'/api/inspections')).status,401);
  const config=await(await fetch(base+'/__/firebase/init.json')).json();assert.equal(config.projectId,'alert-disaster-field-2026');
  const browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/Content Security Policy|Refused to/.test(m.text()))errors.push(m.text());});
  await page.goto(base);await page.waitForFunction(()=>window.firebase&&document.getElementById('signInButton').hidden===false);
  await page.waitForTimeout(1500);assert(!(await page.locator('#message').textContent()).includes('initialization failed'));
  await page.evaluate(()=>document.fonts.ready);
  for(const width of [320,390]){
    await page.setViewportSize({width,height:844});
    assert((await page.locator('.masthead').boundingBox()).height<85,'Narrow header is oversized');
    await page.locator('.task-nav [data-task="walkthrough"]').click();
    const start=await page.locator('#startWalk').boundingBox();assert(start.y+start.height<844,'Capture action is below the first screen');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile task layout overflows');
    assert(await page.locator('#stopWalk').isHidden(),'Idle Stop control is visible');
  }
  assert.equal(await page.locator('.brand img').evaluate(img=>img.naturalWidth),225);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile page overflows');
  assert(await page.evaluate(()=>document.fonts.check('16px Lato')),'Local Lato font unavailable');
  await page.evaluate(async()=>navigator.serviceWorker.ready);
  const cached=await page.evaluate(async()=>{const urls=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())urls.push(new URL(request.url).pathname);return urls;});
  for(const path of ['/brand/adr-logo.jpg','/fonts/lato-400-latin.woff2','/fonts/ebgaramond-400-latin.woff2'])assert(cached.includes(path),'Missing offline branding: '+path);
  await page.screenshot({path:'review-artifacts/redesigned-live-mobile.png'});
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:'review-artifacts/redesigned-live-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  const popupPromise=page.waitForEvent('popup',{timeout:15000});await page.locator('#signInButton').click();
  const popup=await popupPromise;await popup.waitForURL(url=>url.hostname==='accounts.google.com',{timeout:20000});
  console.log('PASS: deployed assets, narrow/mobile task navigation and capture layout, local fonts/cache, dedicated Firebase/API, CSP and real Google OAuth popup');
  assert.equal(errors.length,0,'Browser initialization/CSP error: '+errors.join(';'));
  await browser.close();
})().catch(e=>{console.error(e.message);process.exit(1);});
