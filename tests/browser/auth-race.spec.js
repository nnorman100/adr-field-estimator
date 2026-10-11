const {test,expect}=require('@playwright/test');
const uid=role=>'test-owner-ws-'+role;
async function gateFirstSession(page){
  let release,first=true;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/api/session',async route=>{if(first){first=false;await gate;}await route.continue();});
  return ()=>{release();return page.waitForResponse('**/api/session').then(()=>page.waitForTimeout(500));};
}

test('signing out while the session request is delayed ends signed out with no stale session',async({page})=>{
  const release=await gateFirstSession(page),requested=page.waitForRequest('**/api/session');
  await page.goto('/');await requested;
  await page.evaluate(()=>firebase.auth().signOut());await expect(page.locator('#signInButton')).toBeVisible();
  await release();
  expect(await page.evaluate(()=>({user:state.user,session:state.session,draft:state.draft}))).toEqual({user:null,session:null,draft:null});
  await expect(page.locator('#signInButton')).toBeVisible();await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('#address')).toBeDisabled();await expect(page.locator('#workspaceNav')).toBeHidden();await expect(page.locator('#message')).toBeHidden();
});

test.describe('company workspaces',()=>{
  test.beforeEach(async({request})=>{await request.post('/__test/workspaces',{data:{enabled:true}});});
  test.afterEach(async({request})=>{await request.post('/__test/workspaces',{data:{enabled:false}});});
  test('switching accounts while the first session request is delayed opens only the second account',async({page})=>{
    const release=await gateFirstSession(page),requested=page.waitForRequest('**/api/session');
    await page.addInitScript(value=>{if(!sessionStorage.getItem('synthetic-uid'))sessionStorage.setItem('synthetic-uid',value);},uid('owner'));
    await page.goto('/');await requested;
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
