const {test,expect}=require('@playwright/test');
const uid=role=>'test-owner-ws-'+role;
async function gateFirstSession(page){
  await page.addInitScript(()=>{
    const fetch=window.fetch;let first=true;
    const gate=new Promise(resolve=>{window.__releaseSession=resolve;});
    window.fetch=async function(input,options){
      if(input==='/api/session'&&first){first=false;window.__sessionStarted=true;await gate;const response=await fetch.call(this,input,options);window.__sessionReturned=true;return response;}
      return fetch.call(this,input,options);
    };
  });
  return async()=>{await page.evaluate(()=>window.__releaseSession());await page.waitForFunction(()=>window.__sessionReturned);await page.waitForTimeout(500);};
}

test('signing out while the session request is delayed ends signed out with no stale session',async({page})=>{
  const release=await gateFirstSession(page);
  await page.goto('/');await page.waitForFunction(()=>window.__sessionStarted);
  await page.evaluate(()=>auth.signOut());await expect(page.locator('#signInButton')).toBeVisible();
  await release();
  expect(await page.evaluate(()=>({user:state.user,session:state.session,draft:state.draft}))).toEqual({user:null,session:null,draft:null});
  await expect(page.locator('#signInButton')).toBeVisible();await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('#address')).toBeDisabled();await expect(page.locator('#workspaceNav')).toBeHidden();await expect(page.locator('#message')).toBeHidden();
});

test.describe('company workspaces',()=>{
  test.beforeEach(async({request})=>{await request.post('/__test/workspaces',{data:{enabled:true}});});
  test.afterEach(async({request})=>{await request.post('/__test/workspaces',{data:{enabled:false}});});
  test('switching accounts while the first session request is delayed opens only the second account',async({page})=>{
    const release=await gateFirstSession(page);
    await page.addInitScript(value=>{if(!sessionStorage.getItem('synthetic-uid'))sessionStorage.setItem('synthetic-uid',value);},uid('owner'));
    await page.goto('/');await page.waitForFunction(()=>window.__sessionStarted);
    await page.evaluate(async value=>{sessionStorage.setItem('synthetic-uid',value);await window.__testAuthChanged({uid:value,email:value+'@example.invalid',getIdToken:async()=>value});},uid('other'));
    await expect(page.locator('#dashboardHeading')).toHaveText('Other Restoration');
    const session=await page.evaluate(async()=>await(await fetch('/api/session',{headers:{Authorization:'Bearer '+state.user.uid}})).json());
    await release();
    expect(await page.evaluate(()=>[state.user.uid,state.session])).toEqual([uid('other'),session]);
    await expect(page.locator('#message')).toBeHidden();
    await expect(page.locator('#dashboardHeading')).toHaveText('Other Restoration');await expect(page.locator('#workspaceNav')).toBeVisible();
    await page.locator('#dashboardJobs').click();await expect(page.locator('#dashboardContent')).not.toContainText('Assigned bathroom');
  });
});
