// Diagnostic only: stop before passwords, never export auth state or OAuth URLs.
const {chromium}=require('playwright');
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,ignoreDefaultArgs:['--enable-automation']});
  try{
    const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
    let popup=page;
    if(process.argv.includes('--google-only')){
      await page.goto('https://accounts.google.com/');
    }else{
      await page.goto('https://alert-disaster-field-2026.web.app');
      await page.waitForFunction(()=>window.firebase?.auth()&&document.getElementById('signInButton').hidden===false);
      await page.locator('#accountMenu summary').click();
      const pending=page.waitForEvent('popup',{timeout:20000});
      await page.locator('#signInButton').click();
      popup=await pending;
      await popup.waitForURL(url=>url.hostname==='accounts.google.com',{timeout:30000});
    }
    const identifier=popup.getByRole('textbox',{name:'Email or phone',exact:true});
    await identifier.waitFor({timeout:15000});
    await identifier.fill('nathanaelcnorman@gmail.com');
    await popup.getByRole('button',{name:'Next',exact:true}).click();
    await popup.waitForFunction(()=>{
      const text=document.body.innerText;
      return /browser or app may not be secure|Couldn't sign you in|couldn’t sign you in/i.test(text)||!!document.querySelector('input[type=password]');
    },{},{timeout:30000});
    const result=await popup.evaluate(()=>{
      const text=document.body.innerText;
      return {blocked:/browser or app may not be secure|Couldn't sign you in|couldn’t sign you in/i.test(text),passwordStep:!!document.querySelector('input[type=password]'),message:/browser or app may not be secure/i.test(text)?'This browser or app may not be secure.':null};
    });
    console.log(JSON.stringify(result));
    if(result.blocked)process.exitCode=1;
  }finally{await browser.close();}
})().catch(error=>{console.error('Diagnostic stopped: '+error.message.split('\n')[0]);process.exitCode=2;});
