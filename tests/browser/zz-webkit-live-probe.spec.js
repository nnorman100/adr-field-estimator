// TEMPORARY diagnostic: reports which Live startup step fails in Linux WebKit. Always passes.
const {test,expect}=require('@playwright/test');
test('webkit live startup probe',async({page,browserName})=>{
  test.skip(browserName!=='webkit','WebKit-only diagnostic');
  const logs=[];page.on('console',m=>logs.push('console.'+m.type()+': '+m.text()));page.on('pageerror',e=>logs.push('pageerror: '+e.message));
  await page.goto('/');await expect(page.locator('#address')).toBeEnabled({timeout:15000});await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  const steps=await page.evaluate(async()=>{
    const out=[],race=(p,ms=3000)=>Promise.race([p.then(v=>'ok '+(v===undefined?'':String(v))),new Promise(r=>setTimeout(()=>r('TIMEOUT '+ms+'ms'),ms))]).catch(e=>'THROW '+e.name+': '+e.message);
    out.push('AudioContext='+typeof window.AudioContext+' AudioWorkletNode='+typeof window.AudioWorkletNode+' captureStream='+typeof HTMLCanvasElement.prototype.captureStream);
    let stream;
    out.push('getUserMedia mock: '+await race((async()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;canvas.getContext('2d').fillRect(0,0,640,480);const a=new AudioContext();stream=new MediaStream([...canvas.captureStream(1).getVideoTracks(),...a.createMediaStreamDestination().stream.getAudioTracks()]);return stream.getTracks().map(t=>t.kind).join(',');})()));
    const video=document.getElementById('cameraVideo');video.srcObject=stream;
    out.push('video.play: '+await race(video.play()));
    const ctx=new AudioContext();out.push('ctx.state before resume: '+ctx.state+' sampleRate='+ctx.sampleRate);
    out.push('ctx.resume: '+await race(ctx.resume()));
    out.push('audioWorklet present: '+!!ctx.audioWorklet);
    out.push('addModule: '+await race(ctx.audioWorklet?ctx.audioWorklet.addModule('/audio-worklet.js?v=probe'):Promise.reject(Error('no audioWorklet'))));
    out.push('createMediaStreamSource+node: '+await race((async()=>{const s=ctx.createMediaStreamSource(stream);const n=new AudioWorkletNode(ctx,'adr-microphone');s.connect(n);n.connect(ctx.destination);})()));
    video.srcObject=null;stream?.getTracks().forEach(t=>t.stop());await ctx.close();
    return out;
  });
  // Full app path with the same mocks as live-reliability.spec.js.
  await page.evaluate(()=>{
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;canvas.getContext('2d').fillRect(0,0,640,480);const audio=new AudioContext();return new MediaStream([...canvas.captureStream(1).getVideoTracks(),...audio.createMediaStreamDestination().stream.getAudioTracks()]);}}});
    window.WebSocket=class{static OPEN=1;readyState=0;bufferedAmount=0;constructor(){setTimeout(()=>{this.readyState=1;this.onopen?.();},0);}emit(p){this.onmessage?.({data:JSON.stringify(p)});}send(raw){const p=JSON.parse(raw);if(p.type==='authenticate')setTimeout(()=>this.emit({type:'ready',protocol_version:2,connection_id:'probe',recovery:'new'}),0);}close(){this.readyState=3;this.onclose?.();}};
  });
  await page.locator('.task-nav [data-task="walkthrough"]').click();await page.locator('#startWalk').click();
  const seen=[];for(let i=0;i<16;i++){const s=await page.locator('#liveStatus').textContent();if(seen.at(-1)!==s)seen.push(s);await page.waitForTimeout(500);}
  const message=await page.locator('#message').textContent();
  console.log('WEBKIT-PROBE '+JSON.stringify({steps,liveStatusSequence:seen,message,logs},null,1));
});
