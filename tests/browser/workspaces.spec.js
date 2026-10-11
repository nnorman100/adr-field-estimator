const {test,expect}=require('@playwright/test');
const uid=role=>'test-owner-ws-'+role;
async function start(page,role){
  await page.addInitScript(value=>sessionStorage.setItem('synthetic-uid',value),uid(role));
  await page.goto('/');await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function call(page,path,method='GET',body,role='owner'){
  return page.request.fetch(path,{method,headers:{Authorization:'Bearer '+uid(role),'X-ADR-Workspace-Protocol':'1'},...(body?{data:body}:{})});
}
test.beforeEach(async({request})=>{await request.post('/__test/workspaces',{data:{enabled:true}});});
test.afterEach(async({request})=>{await request.post('/__test/workspaces',{data:{enabled:false}});});

test('owner dashboard has no automatic blank inspection and fits phones',async({page,browserName})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await start(page,'owner');
  expect((await(await page.request.get('/__test/workspaces-stats')).json()).inspection_count).toBe(1);
  await expect(page.locator('#dashboardTeam')).toBeVisible();await expect(page.locator('#dashboardAdmin')).toBeVisible();
  for(const width of [320,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);}
  if(browserName==='chromium')await page.screenshot({path:'review-artifacts/workspaces-20261007/owner-mobile.png',fullPage:true});
  await page.locator('#dashboardTeam').click();await expect(page.locator('#dashboardHeading')).toHaveText('Team & invitations');
  await page.locator('form').filter({has:page.locator('input[name=email]')}).locator('input[name=email]').fill('new-estimator@example.invalid');
  await page.getByRole('button',{name:'Send invitation',exact:true}).click();await expect(page.locator('#dashboardContent')).toContainText('Email sent');
  const office=page.locator('.dashboard-card').filter({has:page.getByRole('heading',{name:uid('office')+'@example.invalid',exact:true})});
  await office.locator('select[name=status]').selectOption('disabled');await office.getByRole('button',{name:'Save access'}).click();
  await expect(page.locator('#dashboardContent')).toContainText('Office staff · disabled');expect(errors).toEqual([]);
});

test('superadmin manages companies without customer job access',async({page})=>{
  await start(page,'admin');await expect(page.locator('#dashboardJobs')).toBeHidden();await expect(page.locator('#dashboardTeam')).toBeHidden();
  await page.locator('#dashboardAdmin').click();await expect(page.locator('#dashboardHeading')).toHaveText('Companies');
  await page.locator('input[name=name]').fill('New California Restoration');await page.locator('input[name=owner_email]').fill('new-owner@example.invalid');
  await page.getByRole('button',{name:'Create & invite owner'}).click();await expect(page.locator('#dashboardHeading')).toHaveText('New California Restoration');
  await expect(page.locator('#dashboardContent')).toContainText('new-owner@example.invalid');
  expect((await call(page,'/api/inspections/ADR-INS-'+'c'.repeat(32),'GET',undefined,'admin')).status()).toBe(403);
  await page.getByRole('button',{name:'Suspend company',exact:true}).click();await expect(page.locator('#dashboardContent')).toContainText('Company status: suspended');
  await page.getByRole('button',{name:'Reactivate company',exact:true}).click();await expect(page.locator('#dashboardContent')).toContainText('Company status: active');
});

test('office creates empty scope and coordinates without scope or signing controls',async({page})=>{
  await start(page,'office');await expect(page.locator('#dashboardHeading')).toHaveText('Company jobs');await expect(page.locator('#dashboardTeam')).toBeHidden();await expect(page.locator('#dashboardAdmin')).toBeHidden();
  await page.getByRole('button',{name:'New job',exact:true}).click();await expect(page.locator('#jobCoordination')).toBeVisible();
  await expect(page.locator('#address')).toBeDisabled();await expect(page.locator('#yearBuilt')).toHaveValue('');
  await expect(page.locator('#technicianTranscript')).toHaveJSProperty('readOnly',true);
  await page.locator('#coordAddress').fill('Office-created property');await page.locator('#coordName').fill('Synthetic customer');
  await page.locator('#coordEstimator').selectOption(uid('estimator'));await page.locator('#saveCoordination').click();
  await expect(page.locator('#coordinationStatus')).toHaveText('Coordination saved.');await expect(page.locator('#address')).toHaveValue('Office-created property');
  await page.locator('#dashboardHome').click();await page.locator('#dashboardJobs').click();await expect(page.locator('#dashboardContent')).toContainText('Office-created property');
});

test('estimator opens assigned workflow and loses scope controls on role change',async({page})=>{
  await start(page,'estimator');await expect(page.locator('#dashboardHeading')).toHaveText('My jobs');await page.locator('#dashboardJobs').click();
  await page.getByRole('button',{name:/Assigned bathroom/}).click();await expect(page.locator('#address')).toBeEnabled();await expect(page.locator('#jobCoordination')).toBeHidden();
  await page.locator('#finishAudit').click();await expect(page.locator('#documents')).toBeVisible();await expect(page.locator('#estimateRange')).toHaveText('$1,775.00–$1,788.90');
  const result=await call(page,'/api/companies/adr/team/'+uid('estimator'),'PUT',{expected_version:1,role:'office',status:'active'});expect(result.ok()).toBe(true);
  await page.evaluate(()=>WorkspaceUI.refresh());await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await expect(page.locator('#address')).toHaveValue('');await expect(page.locator('#proposalBody')).toHaveText('');
  await page.locator('#dashboardJobs').click();await page.getByRole('button',{name:/Assigned bathroom/}).click();
  await expect(page.locator('#address')).toBeDisabled();await expect(page.locator('#finishAudit')).toBeDisabled();await expect(page.locator('#signingArea')).toBeHidden();
});

test('company profile edits require regenerated documents and render labels safely',async({page})=>{
  await start(page,'owner');await page.locator('#dashboardProfile').click();
  await page.locator('input[name=signoff]').fill('<img src=x onerror=window.companyInjected=true>');await page.getByRole('button',{name:'Save company details'}).click();
  await expect(page.locator('#message')).toContainText('Company details saved');
  await page.locator('#dashboardJobs').click();await page.getByRole('button',{name:/Assigned bathroom/}).click();
  await page.locator('#finishAudit').click();await expect(page.locator('#proposalBody')).toContainText('<img src=x');expect(await page.evaluate(()=>window.companyInjected)).toBeUndefined();
});

test('invitation is explicit and bound to the matching Google account',async({page})=>{
  const invitation=await(await call(page,'/api/companies/adr/invitations','POST',{email:uid('pending')+'@example.invalid',role:'office'})).json();
  await page.addInitScript(value=>sessionStorage.setItem('synthetic-uid',value),uid('pending'));
  await page.goto('/?invite='+invitation.invitation_id);await expect(page.getByRole('button',{name:'Accept invitation'})).toBeVisible();
  expect((await call(page,'/api/session','GET',undefined,'pending')).status()).toBe(200); // The harness overrides identity only; membership still comes from real policy.
  await expect(page.locator('#dashboardJobs')).toBeHidden();await page.getByRole('button',{name:'Accept invitation'}).click();
  await expect(page.locator('#dashboardJobs')).toBeVisible();await expect(page.locator('#dashboardTeam')).toBeHidden();
  expect(new URL(page.url()).searchParams.has('invite')).toBe(false);
});

test('email failures stay visible and can be retried',async({page,request})=>{
  await request.post('/__test/workspaces',{data:{enabled:true,send_fail:true}});await start(page,'owner');await page.locator('#dashboardTeam').click();
  await page.locator('input[name=email]').fill('fail@example.invalid');await page.getByRole('button',{name:'Send invitation',exact:true}).click();
  await expect(page.locator('#dashboardContent')).toContainText('Email failed');await expect(page.locator('#dashboardContent')).toContainText('Invitation email could not be sent');
  await expect(page.getByRole('button',{name:'Resend invitation'})).toBeVisible();
});


test('other company branding and signing snapshots stay isolated from ADR',async({page,browserName})=>{
  await start(page,'other');await page.setViewportSize({width:390,height:844});
  await expect(page.locator('.masthead .brand strong')).toBeVisible();await expect(page.locator('.masthead .brand strong')).toHaveText('Other Restoration');
  await page.getByRole('button',{name:'New job',exact:true}).click();
  await page.locator('#address').fill('Other company synthetic property');await page.locator('#yearBuilt').fill('2000');
  await expect(page.locator('#coordAddress')).toHaveValue('Other company synthetic property');
  await page.locator('#coordNotes').fill('Office note retains the measured property address');await page.locator('#saveCoordination').click();
  await expect(page.locator('#coordinationStatus')).toHaveText('Coordination saved.');await expect(page.locator('#address')).toHaveValue('Other company synthetic property');
  await page.locator('[data-room-key=finished_sf]').fill('10');await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#doc-proposal > h2')).toContainText('Other Restoration');await expect(page.locator('#proposalBody')).toContainText('Other Estimator · CSLB #123456');
  await expect(page.locator('.document-letterhead img')).toBeHidden();await expect(page.locator('#defenseBody')).not.toContainText('Matthew Myers');
  if(browserName==='chromium')await page.screenshot({path:'review-artifacts/workspaces-20261007/other-company-proposal-mobile.png',fullPage:true});
  for(const name of ['proposal','claim','defense','photos'])await page.locator('[data-tab='+name+']').click();await page.locator('[data-tab=proposal]').click();await page.locator('#documentsConfirmed').check();
  const canvas=page.locator('#signCanvas');await canvas.scrollIntoViewIfNeeded();const rect=await canvas.boundingBox();
  await page.mouse.move(rect.x+20,rect.y+40);await page.mouse.down();await page.mouse.move(rect.x+110,rect.y+80,{steps:8});await page.mouse.move(rect.x+220,rect.y+30,{steps:8});await page.mouse.up();
  await page.locator('#authorizeJob').click();await expect(page.locator('#savedSignature')).toBeVisible();
  await page.reload();await page.locator('#dashboardJobs').click();await page.getByRole('button',{name:/Other company synthetic property.*Signed/s}).click();
  await expect(page.locator('#proposalBody')).toContainText('Other Estimator');await expect(page.locator('#savedSignature')).toBeVisible();
  expect((await call(page,'/api/inspections/ADR-INS-'+'c'.repeat(32),'GET',undefined,'other')).status()).toBe(404);
});


test('replacement owner can manage the disabled former owner as staff',async({page})=>{
  const invitation=await(await call(page,'/api/companies/adr/invitations','POST',{email:uid('pending')+'@example.invalid',role:'owner'})).json();
  expect((await call(page,'/api/invitations/'+invitation.invitation_id+'/accept','POST',{},'pending')).ok()).toBe(true);
  await start(page,'pending');await page.locator('#dashboardTeam').click();
  const former=page.locator('.dashboard-card').filter({has:page.getByRole('heading',{name:uid('owner')+'@example.invalid',exact:true})});
  await expect(former).toContainText('Owner · disabled');await former.locator('select[name=role]').selectOption('office');await former.locator('select[name=status]').selectOption('active');
  await former.getByRole('button',{name:'Save access'}).click();await expect(page.locator('#message')).toContainText('Staff access updated.');await expect(former).toContainText('Office staff · active');
  const session=await(await call(page,'/api/session','GET',undefined,'owner')).json();expect(session.role).toBe('office');expect(session.superadmin).toBe(true);
});


test('account switch clears customer fields and documents before another company opens',async({page})=>{
  await start(page,'owner');await page.locator('#dashboardJobs').click();await page.getByRole('button',{name:/Assigned bathroom/}).click();
  await page.locator('#finishAudit').click();await expect(page.locator('#proposalBody')).toContainText('Assigned bathroom');
  await page.evaluate(async value=>{sessionStorage.setItem('synthetic-uid',value);await window.__testAuthChanged({uid:value,email:value+'@example.invalid',getIdToken:async()=>value});},uid('other'));
  await expect(page.locator('#dashboardHeading')).toHaveText('Other Restoration');await expect(page.locator('#address')).toHaveValue('');
  await expect(page.locator('#proposalBody')).toHaveText('');await expect(page.locator('#rooms')).toBeEmpty();await expect(page.locator('#savedSignature')).toBeHidden();
  await page.locator('#dashboardJobs').click();await expect(page.locator('#dashboardContent')).not.toContainText('Assigned bathroom');
});


test('email sign-up stays unverified without authenticated calls, then accepts its invitation',async({page})=>{
  const email=uid('pending')+'@example.invalid';
  const invitation=await(await call(page,'/api/companies/adr/invitations','POST',{email,role:'office'})).json();
  const authenticated=[];page.on('request',request=>{if(request.headers().authorization)authenticated.push(request.url());});
  await page.addInitScript(()=>{if(!sessionStorage.getItem('synthetic-accounts'))sessionStorage.setItem('synthetic-signed-out','1');});
  await page.goto('/?invite='+invitation.invitation_id);await expect(page.locator('#emailAuthForm')).toBeVisible();await expect(page.locator('#signInButton')).toBeVisible();
  await page.locator('#authEmail').fill(email);await page.locator('#authPassword').fill('synthetic-password');
  await page.getByRole('button',{name:'Create account',exact:true}).click();
  await expect(page.locator('#verifyEmail')).toBeVisible();await expect(page.locator('#verifyAddress')).toHaveText(email);await expect(page.locator('#emailAuthForm')).toBeHidden();
  await expect(page.locator('#authStatus')).toHaveText('Verification email sent to '+email+'.');
  await page.getByRole('button',{name:'Resend verification email'}).click();await expect(page.locator('#authStatus')).toHaveText('Verification email sent to '+email+'.');
  expect(await page.evaluate(()=>window.__testEmails)).toEqual([{type:'verify',email},{type:'verify',email}]);
  await page.getByRole('button',{name:"I've verified"}).click();await expect(page.locator('#authStatus')).toContainText('not verified yet');
  await page.reload();await expect(page.locator('#verifyEmail')).toBeVisible();
  await expect(page.locator('#workspaceDashboard')).toBeHidden();await expect(page.locator('#address')).toBeDisabled();expect(authenticated).toEqual([]);
  await page.evaluate(value=>window.__testVerify(value),email);await page.getByRole('button',{name:"I've verified"}).click();
  await expect(page.locator('#authPanel')).toBeHidden();await page.getByRole('button',{name:'Accept invitation'}).click();
  await expect(page.locator('#dashboardJobs')).toBeVisible();await expect(page.locator('#dashboardHeading')).toHaveText('Company jobs');
  expect(authenticated.length).toBeGreaterThan(0);
});

test('email sign-in errors share one message and do not reveal accounts',async({page})=>{
  const email=uid('owner')+'@example.invalid';
  await page.addInitScript(value=>{if(!sessionStorage.getItem('synthetic-accounts')){sessionStorage.setItem('synthetic-accounts',JSON.stringify({[value]:{password:'correct-password',verified:true}}));sessionStorage.setItem('synthetic-signed-out','1');}},email);
  await page.goto('/');await expect(page.locator('#emailAuthForm')).toBeVisible();
  const signIn=async(address,password)=>{await page.locator('#authEmail').fill(address);await page.locator('#authPassword').fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();};
  await signIn(email,'wrong-password');await expect(page.locator('#authStatus')).toHaveText('Email or password is incorrect.');
  await signIn('nobody@example.invalid','wrong-password');await expect(page.locator('#authStatus')).toHaveText('Email or password is incorrect.');
  await page.getByRole('button',{name:'Forgot password'}).click();await expect(page.locator('#authStatus')).toHaveText('If an account uses nobody@example.invalid, a password reset email is on its way.');
  await page.locator('#authEmail').fill(email);await page.getByRole('button',{name:'Create account',exact:true}).click();
  await expect(page.locator('#authStatus')).toHaveText('An account already uses this email. Sign in or reset the password.');
  await expect(page.locator('#workspaceDashboard')).toBeHidden();
  await signIn(email,'correct-password');await expect(page.locator('#workspaceDashboard')).toBeVisible();await expect(page.locator('#authPanel')).toBeHidden();
  await expect(page.locator('#dashboardTeam')).toBeVisible();
});
