# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: zz-mutant.spec.js >> MUTANT authored style on app select modular Firebase SDK starts the app same-origin under the Hosting CSP
- Location: tests/browser/zz-mutant.spec.js:28:1

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 10

- Array []
+ Array [
+   Object {
+     "blockedURI": "inline",
+     "directive": "style-src-attr",
+     "nativeSelect": false,
+     "sample": "text-overflow:inherit",
+     "sourceFile": "",
+     "target": "coordEstimator",
+   },
+ ]
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "Alert Disaster Restoration home" [ref=e3] [cursor=pointer]:
      - /url: /
      - img "Alert Disaster Restoration" [ref=e4]
      - strong [ref=e5]: Field Estimator
    - generic [ref=e6]:
      - button "Sign in with Google" [ref=e7] [cursor=pointer]: Sign in
      - group [ref=e8]:
        - generic "Account +" [ref=e9] [cursor=pointer]
  - region "Sign in" [ref=e10]:
    - generic [ref=e11]:
      - heading "Sign in with email" [level=2] [ref=e12]
      - paragraph [ref=e13]:
        - text: Use
        - strong [ref=e14]: Sign in
        - text: above for Google, or your email and password. New staff set a password with the link in your invitation email.
      - generic [ref=e15]:
        - text: Email
        - textbox "Email" [ref=e16]
      - generic [ref=e17]:
        - text: Password
        - textbox "Password" [ref=e18]
      - generic [ref=e19]:
        - button "Sign in" [ref=e20] [cursor=pointer]
        - button "Forgot password" [ref=e21] [cursor=pointer]
  - generic [ref=e22]:
    - generic [ref=e23]:
      - generic [ref=e24]:
        - text: FIELD INSPECTION
        - heading "New inspection" [level=1] [ref=e25]
        - status [ref=e26]: Sign in to save a private inspection.
      - group [ref=e27]:
        - generic "Jobs +" [ref=e28] [cursor=pointer]
    - navigation "Inspection tasks" [ref=e29]:
      - button "01 Property" [ref=e30] [cursor=pointer]:
        - generic [ref=e31]: "01"
        - text: Property
      - button "02 Walkthrough" [ref=e32] [cursor=pointer]:
        - generic [ref=e33]: "02"
        - text: Walkthrough
      - button "03 Evidence" [ref=e34] [cursor=pointer]:
        - generic [ref=e35]: "03"
        - text: Evidence
      - button "04 Review" [ref=e36] [cursor=pointer]:
        - generic [ref=e37]: "04"
        - text: Review
  - status [ref=e38]: Offline launch is unavailable in this browser. Online private drafts remain available.
  - main [ref=e39]:
    - region [ref=e40]:
      - generic [ref=e41]:
        - heading "Property & scope" [level=2] [ref=e42]
        - button "Go to walkthrough →" [ref=e43] [cursor=pointer]
      - button "Fill scope from walkthrough" [disabled] [ref=e44]
      - paragraph [ref=e45]: Stops capture and proposes values from your recorded observations. Review before applying.
      - group [ref=e47]:
        - generic [ref=e48]:
          - text: Property address
          - textbox "Property address" [disabled] [ref=e49]:
            - /placeholder: Enter the inspection address
        - generic [ref=e51]:
          - text: Year built
          - spinbutton "Year built" [disabled] [ref=e52]
        - generic [ref=e53]:
          - generic [ref=e54]:
            - checkbox "Crawl space exists" [disabled] [ref=e55]
            - text: Crawl space exists
          - generic [ref=e56]:
            - checkbox "Cabinet removal under granite" [disabled] [ref=e57]
            - text: Cabinet removal under granite
          - generic [ref=e58]:
            - checkbox "Garage water-heater loss" [disabled] [ref=e59]
            - text: Garage water-heater loss
          - generic [ref=e60]:
            - checkbox "This scope has been performed" [disabled] [ref=e61]
            - text: This scope has been performed
        - generic [ref=e62]:
          - heading "Rooms & demolition" [level=3] [ref=e63]
          - button "Add room" [disabled] [ref=e64]
        - heading "Equipment & additional labor" [level=3] [ref=e65]
        - generic [ref=e66]:
          - generic [ref=e67]:
            - text: Air movers
            - spinbutton "Air movers" [disabled] [ref=e68]: "0"
          - generic [ref=e69]:
            - text: LGR dehumidifiers
            - spinbutton "LGR dehumidifiers" [disabled] [ref=e70]: "0"
          - generic [ref=e71]:
            - text: Drying days
            - spinbutton "Drying days" [disabled] [ref=e72]: "3"
          - generic [ref=e73]:
            - text: Additional labor hours
            - spinbutton "Additional labor hours" [disabled] [ref=e74]: "0"
        - generic [ref=e75]:
          - 'checkbox "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet''s $47.46/hr estimate formula." [disabled] [ref=e76]'
          - text: "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet's $47.46/hr estimate formula."
        - group [ref=e77]:
          - generic "Job charges and optional sheet items" [ref=e78] [cursor=pointer]
        - generic [ref=e79]:
          - text: Technician observations & scope notes
          - textbox "Technician observations & scope notes" [disabled] [ref=e80]:
            - /placeholder: Record observed conditions and requested work. Flag work outside the listed rates.
        - generic [ref=e81]:
          - checkbox "I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities." [disabled] [ref=e82]
          - text: I confirmed room quantities, water categories, cabinetry, waste, equipment counts, drying days, added labor and sheet charge quantities.
      - paragraph [ref=e83]: The estimating sheet provides a low–high customer range from the confirmed scope. Itemized charges show the base-rate calculation. Unpriced work requires correction before signing.
  - text: +
  - generic [ref=e84]:
    - generic [ref=e85]: Confirm scope before generating documents.
    - button "Save draft" [disabled] [ref=e86]
    - button "Finish & review" [disabled] [ref=e87]
  - contentinfo [ref=e88]: Alert Disaster Restoration · Private field inspections
```

# Test source

```ts
  1  | const {test,expect}=require('@playwright/test');
  2  | const fs=require('node:fs'),path=require('node:path');
  3  | const PUBLIC=path.resolve(__dirname,'../../public');
  4  | // The test server stubs the SDK and sends no CSP; this spec serves the vendored SDK under Hosting's policy instead.
  5  | const CSP=require('../../firebase.json').hosting.headers.find(rule=>rule.source==='**').headers.find(header=>header.key==='Content-Security-Policy').value;
  6  | // report-sample adds diagnostics only; the Hosting policy's enforcement stays intact.
  7  | const DIAGNOSTIC_CSP=CSP.replace("style-src 'self'","style-src 'self' 'report-sample'");
  8  | test.use({serviceWorkers:'block'});
  9  | 
  10 | async function observeCsp(page){
  11 |   await page.addInitScript(()=>{
  12 |     window.__cspViolations=[];
  13 |     document.addEventListener('securitypolicyviolation',event=>window.__cspViolations.push({
  14 |       directive:event.violatedDirective,blockedURI:event.blockedURI,sample:event.sample,sourceFile:event.sourceFile,
  15 |       target:event.target.id||'',nativeSelect:event.target instanceof HTMLSelectElement&&!event.target.hasAttribute('style'),
  16 |     }));
  17 |   });
  18 | }
  19 | async function unexpectedCsp(page,browserName,nativeSelectIds){
  20 |   const violations=await page.evaluate(()=>window.__cspViolations);
  21 |   // WebKit 2370 sets this style on a detached UA select slot, before its shadow-tree CSP exemption applies.
  22 |   // https://github.com/WebKit/WebKit/commit/ef67848e58750b33e018150541e1085fd5dedfd9
  23 |   // Keep authored styles (even identical text), script reports and every other style report visible.
  24 |   return violations.filter(event=>!(browserName==='webkit'&&event.nativeSelect&&nativeSelectIds.includes(event.target)
  25 |     &&event.directive==='style-src-attr'&&event.blockedURI==='inline'&&event.sample==='text-overflow:inherit'&&event.sourceFile===''));
  26 | }
  27 | 
  28 | test('MUTANT authored style on app select modular Firebase SDK starts the app same-origin under the Hosting CSP',async({page,baseURL,browserName})=>{
  29 |   const origin=new URL(baseURL).origin,external=[];
  30 |   await observeCsp(page);
  31 |   await page.route('**/*',async route=>{
  32 |     const request=route.request(),url=new URL(request.url());
  33 |     // Sign-in helpers and reCAPTCHA stay offline; the SDK itself must never come from another origin.
  34 |     if(url.origin!==origin){external.push(url.href);return route.abort();}
  35 |     if(url.pathname.startsWith('/vendor/firebase/'))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(PUBLIC,url.pathname))});
  36 |     if(request.resourceType()==='document'){const response=await route.fetch();return route.fulfill({response,headers:{...response.headers(),'content-security-policy':DIAGNOSTIC_CSP}});}
  37 |     return route.continue();
  38 |   });
  39 |   await page.goto('/');
  40 |   await expect(page.locator('#signInButton')).toBeVisible();await expect(page.locator('#emailAuthForm')).toBeVisible();
  41 |   expect(await page.evaluate(()=>({user:auth.currentUser,project:auth.app.options.projectId,persistence:auth.persistenceManager.persistence.type})))
  42 |     .toEqual({user:null,project:'alert-disaster-field-2026',persistence:'LOCAL'});
  43 |   // App Check joins the same app instance, and a failed attestation still yields no token instead of an error.
  44 |   expect(await page.evaluate(async()=>{const sdk=await loadAppCheck('synthetic-site-key');activateAppCheck(auth.app,sdk,'synthetic-site-key');return appCheckToken();})).toBe('');
  45 |   await page.evaluate(()=>document.querySelector('#coordEstimator').setAttribute('style','text-overflow:inherit'));await page.waitForTimeout(300);
> 46 |   expect(await unexpectedCsp(page,browserName,['coordEstimator','photoRoom'])).toEqual([]);
     |                                                                                ^ Error: expect(received).toEqual(expected) // deep equality
  47 |   expect(external.filter(url=>url.includes('/firebasejs/'))).toEqual([]);
  48 | });
  49 | 
  50 | 
  51 | 
  52 | 
  53 | test('MUTANT script eval modular Firebase SDK starts the app same-origin under the Hosting CSP',async({page,baseURL,browserName})=>{
  54 |   const origin=new URL(baseURL).origin,external=[];
  55 |   await observeCsp(page);
  56 |   await page.route('**/*',async route=>{
  57 |     const request=route.request(),url=new URL(request.url());
  58 |     // Sign-in helpers and reCAPTCHA stay offline; the SDK itself must never come from another origin.
  59 |     if(url.origin!==origin){external.push(url.href);return route.abort();}
  60 |     if(url.pathname.startsWith('/vendor/firebase/'))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(path.join(PUBLIC,url.pathname))});
  61 |     if(request.resourceType()==='document'){const response=await route.fetch();return route.fulfill({response,headers:{...response.headers(),'content-security-policy':DIAGNOSTIC_CSP}});}
  62 |     return route.continue();
  63 |   });
  64 |   await page.goto('/');
  65 |   await expect(page.locator('#signInButton')).toBeVisible();await expect(page.locator('#emailAuthForm')).toBeVisible();
  66 |   expect(await page.evaluate(()=>({user:auth.currentUser,project:auth.app.options.projectId,persistence:auth.persistenceManager.persistence.type})))
  67 |     .toEqual({user:null,project:'alert-disaster-field-2026',persistence:'LOCAL'});
  68 |   // App Check joins the same app instance, and a failed attestation still yields no token instead of an error.
  69 |   expect(await page.evaluate(async()=>{const sdk=await loadAppCheck('synthetic-site-key');activateAppCheck(auth.app,sdk,'synthetic-site-key');return appCheckToken();})).toBe('');
  70 |   await page.evaluate(()=>{const s=document.createElement('script');s.textContent='window.__x=1';document.head.append(s);});await page.waitForTimeout(300);
  71 |   expect(await unexpectedCsp(page,browserName,['coordEstimator','photoRoom'])).toEqual([]);
  72 |   expect(external.filter(url=>url.includes('/firebasejs/'))).toEqual([]);
  73 | });
  74 | 
  75 | 
```