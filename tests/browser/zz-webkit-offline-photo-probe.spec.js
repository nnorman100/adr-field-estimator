// TEMPORARY diagnostic: why does an offline photo add leave 0 photos in Linux WebKit? Always passes.
const {test,expect}=require('@playwright/test');
test('webkit offline photo probe',async({page,context,browserName})=>{
  test.skip(browserName!=='webkit','WebKit-only diagnostic');
  const logs=[];page.on('console',m=>logs.push(m.type()+': '+m.text()));page.on('pageerror',e=>logs.push('pageerror: '+e.message));
  await page.goto('/');await expect(page.locator('#address')).toBeEnabled({timeout:15000});await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
  const report={};
  for(const mode of ['online','offline']){
    await context.setOffline(mode==='offline');
    report[mode]=await page.evaluate(async()=>{
      const out={room:$('photoRoom').value,photosBefore:state.draft.photos.length};
      const c=document.createElement('canvas');c.width=40;c.height=20;c.getContext('2d').fillRect(0,0,20,10);
      const blob=await new Promise(r=>c.toBlob(r,'image/png'));out.blobType=blob?.type;out.blobSize=blob?.size;
      const race=(p)=>Promise.race([p.then(v=>'ok '+v),new Promise(r=>setTimeout(()=>r('TIMEOUT'),3000))]).catch(e=>'THROW '+e.name+': '+e.message);
      out.createImageBitmap=await race(createImageBitmap(blob).then(b=>{const s=b.width+'x'+b.height;b.close();return s;}));
      out.fileReader=await race(new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(String(fr.result).slice(0,22));fr.onerror=()=>rej(fr.error||Error('reader error'));fr.readAsDataURL(blob);}));
      out.addPhoto=await race(addPhoto(new File([blob],'probe.png',{type:'image/png'})).then(()=>'done'));
      out.photosAfter=state.draft.photos.length;out.message=$('message').hidden?'':$('message').textContent;
      return out;
    });
    const image=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=30;c.height=30;c.getContext('2d').fillRect(0,0,15,15);return c.toDataURL('image/png');});
    await page.locator('#photoFileInput').setInputFiles({name:'probe-'+mode+'.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
    await page.waitForTimeout(2500);
    report[mode].afterInput=await page.evaluate(()=>({photos:state.draft.photos.length,message:$('message').hidden?'':$('message').textContent,count:$('photoCount').textContent,save:$('saveStatus').textContent}));
  }
  await context.setOffline(false);
  console.log('WEBKIT-OFFLINE-PHOTO-PROBE '+JSON.stringify({report,logs:logs.slice(-15)},null,1));
});
