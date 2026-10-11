const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const elements=new Map(),events=[],timers=new Set();
const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,srcObject:null,className:'',classList:{toggle(){},remove(){}}});return elements.get(id);};
class Socket{static OPEN=1;constructor(){this.readyState=1;}send(){events.push('end');}close(){events.push('socket');}}
const context={ADRCore:require('../public/core.js'),document:{getElementById:element,addEventListener(){}},navigator:{onLine:true},WebSocket:Socket,
  clearTimeout:id=>timers.delete(id),clearInterval:id=>timers.delete(id),setTimeout:()=>{},URL,Uint8Array,console};
context.window=context;
vm.runInNewContext(fs.readFileSync('public/app.js','utf8')+';globalThis.hooks={state,stopWalk,clearPlayback};',context);
(async()=>{
  const {state,stopWalk}=context.hooks;state.socket=new Socket();state.frameTimer=1;state.reconnectTimer=2;timers.add(1);timers.add(2);
  state.node={disconnect:()=>events.push('node')};state.media={getTracks:()=>[{stop:()=>events.push('video')},{stop:()=>events.push('microphone')}]};
  state.audio={close:async()=>events.push('audio')};state.playing.add({stop:()=>events.push('playback')});state.liveReady=true;
  await stopWalk();assert.equal(timers.size,0);assert.equal(state.liveReady,false);assert.equal(state.media,null);assert.equal(state.socket,null);assert.equal(state.audio,null);
  assert.equal(element('stopWalk').hidden,true);assert.equal(element('muteMic').hidden,true);assert.equal(element('takePhoto').disabled,true);
  assert.deepEqual(events,['playback','node','video','microphone','audio','end','socket']);
  await stopWalk();assert.equal(events.length,7);console.log('PASS: idempotent teardown stops tracks, timers, socket, audio processing and queued playback');
})();
