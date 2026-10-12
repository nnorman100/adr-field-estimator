const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const PUBLIC=path.resolve(__dirname,'../../public');
const CSP=require('../../firebase.json').hosting.headers.find(r=>r.source==='**').headers.find(h=>h.key==='Content-Security-Policy').value;
const E=process.env.PROBE_OUT;
test.use({serviceWorkers:'block'});
test('probe: app under exact Hosting CSP',async({page,baseURL,browserName})=>{
  const origin=new URL(baseURL).origin;
  await page.addInitScript(()=>{window.__v=[];document.addEventListener('securitypolicyviolation',e=>window.__v.push({d:e.violatedDirective,u:e.blockedURI,s:e.sample,t:e.target.id||e.target.nodeName}));});
  await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());
    if(u.origin!==origin)return route.abort();
    if(u.pathname.startsWith('/vendor/firebase/'))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(PUBLIC,u.pathname))});
    if(r.resourceType()==='document'){const resp=await route.fetch();return route.fulfill({response:resp,headers:{...resp.headers(),'content-security-policy':CSP}});}
    return route.continue();});
  await page.goto('/');
  await expect.poll(()=>page.evaluate(()=>typeof auth!=='undefined'&&auth.app.options.projectId)).toBe('alert-disaster-field-2026');
  await page.waitForTimeout(500);
  // Reveal the two flagged selects to show they render and operate for a technician under the enforced CSP.
  const info=await page.evaluate(()=>{const out={};for(const id of ['coordEstimator','photoRoom']){const s=document.getElementById(id);
    let el=s;while(el){el.hidden=false;el=el.parentElement;}
    if(!s.options.length){for(const n of ['Kitchen','Primary bathroom – very long room name to test text overflow']){s.add(new Option(n,n));}}
    s.selectedIndex=s.options.length-1;s.dispatchEvent(new Event('change',{bubbles:true}));
    const cs=getComputedStyle(s);out[id]={value:s.value,width:s.getBoundingClientRect().width,display:cs.display,textOverflow:cs.textOverflow,hasStyleAttr:s.hasAttribute('style')};}
    return out;});
  await page.locator('#photoRoom').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${E}/app-hosting-csp-${browserName}-photoRoom.png`});
  await page.locator('#coordEstimator').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${E}/app-hosting-csp-${browserName}-coordEstimator.png`});
  const v=await page.evaluate(()=>window.__v);
  fs.writeFileSync(`${E}/app-hosting-csp-${browserName}-violations.json`,JSON.stringify({browserName,csp:CSP,selects:info,violations:v},null,2));
  console.log(browserName,JSON.stringify(info),JSON.stringify(v));
  for(const id of ['coordEstimator','photoRoom']){expect(info[id].width).toBeGreaterThan(0);expect(info[id].hasStyleAttr).toBe(false);}
});
