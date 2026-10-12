const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const PUBLIC=path.resolve(__dirname,'../../public');
// The test server stubs the SDK and sends no CSP; this spec serves the vendored SDK under Hosting's policy instead.
const CSP=require('../../firebase.json').hosting.headers.find(rule=>rule.source==='**').headers.find(header=>header.key==='Content-Security-Policy').value;
test.use({serviceWorkers:'block'});

test('the vendored modular Firebase SDK starts the app same-origin under the Hosting CSP',async({page,baseURL})=>{
  const origin=new URL(baseURL).origin,external=[];
  await page.addInitScript(()=>{window.__cspViolations=[];document.addEventListener('securitypolicyviolation',event=>window.__cspViolations.push(event.violatedDirective+' '+event.blockedURI));});
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    // Sign-in helpers and reCAPTCHA stay offline; the SDK itself must never come from another origin.
    if(url.origin!==origin){external.push(url.href);return route.abort();}
    if(url.pathname.startsWith('/vendor/firebase/'))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(PUBLIC,url.pathname))});
    if(request.resourceType()==='document'){const response=await route.fetch();return route.fulfill({response,headers:{...response.headers(),'content-security-policy':CSP}});}
    return route.continue();
  });
  await page.goto('/');
  await expect(page.locator('#signInButton')).toBeVisible();await expect(page.locator('#emailAuthForm')).toBeVisible();
  expect(await page.evaluate(()=>({user:auth.currentUser,project:auth.app.options.projectId,persistence:auth.persistenceManager.persistence.type})))
    .toEqual({user:null,project:'alert-disaster-field-2026',persistence:'LOCAL'});
  // App Check joins the same app instance, and a failed attestation still yields no token instead of an error.
  expect(await page.evaluate(async()=>{const sdk=await loadAppCheck('synthetic-site-key');activateAppCheck(auth.app,sdk,'synthetic-site-key');return appCheckToken();})).toBe('');
  expect(await page.evaluate(()=>window.__cspViolations)).toEqual([]);
  expect(external.filter(url=>url.includes('/firebasejs/'))).toEqual([]);
});
