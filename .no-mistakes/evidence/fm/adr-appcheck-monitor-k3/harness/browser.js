// Drives the real app (public/app.js served by the real backend) in Chromium.
// Mode "default": shipped code untouched. Mode "keyed": app.js served with APP_CHECK_SITE_KEY set and the
// vendored App Check build replaced by a stand-in whose getToken returns a JWT signed by the launcher's local JWKS key
// (or never resolves, for "stalled").
const {chromium}=require('playwright');const fs=require('fs');const {execFileSync}=require('child_process');
const [mode,out,py,mint]=process.argv.slice(2);const BASE='https://localhost:8791';
(async()=>{
  const browser=await chromium.launch({args:['--ignore-certificate-errors']});
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:390,height:844}});
  const api=[],scripts=[];
  page.on('request',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/api/'))api.push({t:Date.now(),method:r.method(),path:u.pathname.replace(/ADR-INS-[a-f0-9]+/,'{id}'),appcheck:r.headers()['x-firebase-appcheck']?'present':'absent'});if(r.resourceType()==='script')scripts.push(u.pathname);});
  if(mode!=='default'){
    await page.route('**/app.js*',async route=>{const res=await route.fetch();const body=(await res.text()).replace("const APP_CHECK_SITE_KEY='';","const APP_CHECK_SITE_KEY='synthetic-site-key';");await route.fulfill({response:res,body});});
    const token=execFileSync(py,[mint,'valid']).toString().trim();
    const stall=mode==='stalled';
    await page.route('**/vendor/firebase-app-check-compat.js',route=>route.fulfill({contentType:'text/javascript',body:`(()=>{window.__appCheck={activated:[],calls:0};
      const ac=()=>({activate:(p,refresh)=>window.__appCheck.activated.push({provider:p.constructor.name,siteKey:p.siteKey,refresh}),
        getToken:()=>{window.__appCheck.calls++;return ${stall}&&!window.__unstall?new Promise(()=>{}):Promise.resolve({token:${JSON.stringify(token)}});}});
      ac.ReCaptchaEnterpriseProvider=class ReCaptchaEnterpriseProvider{constructor(k){this.siteKey=k;}};window.firebase.appCheck=ac;})();`}));
  }
  const t0=Date.now();
  await page.goto(BASE+'/');await page.locator('#address').waitFor({state:'visible',timeout:20000});
  await page.waitForFunction(()=>!document.querySelector('#address').disabled,null,{timeout:20000});
  const ready=Date.now()-t0;
  await page.locator('#address').fill('App Check monitor synthetic property');await page.locator('#saveDraft').click();
  await page.waitForFunction(()=>/Saved privately/.test(document.querySelector('#saveStatus').textContent),null,{timeout:20000});
  await page.screenshot({path:out+'.png',fullPage:false});
  const result={mode,nav_start:t0,ready_ms:ready,scripts:scripts.filter(s=>s.includes('vendor')),appCheckSdk:await page.evaluate(()=>window.__appCheck||null),saveStatus:await page.locator('#saveStatus').textContent(),api};
  fs.writeFileSync(out+'.json',JSON.stringify(result,null,1));console.log(JSON.stringify(result,null,1));
  await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
