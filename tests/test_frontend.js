const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../public/core.js');
assert.deepEqual(fs.readFileSync('index.html'),fs.readFileSync('public/index.html'));
assert.equal(core.money(2049.99),'$2,049.99');
assert.deepEqual(core.aspect(1080,1920,1280),[720,1280]);
assert.equal(core.stable({b:2,a:1}),core.stable({a:1,b:2}));
assert.equal(core.emptyData().year_built,null);assert.equal(core.emptyData().package_price,null);
const bytes=new Uint8Array([0,128,0,0,255,127]);assert.deepEqual([...core.pcmToFloat(bytes)],[-1,0,32767/32768]);
assert.throws(()=>core.pcmToFloat(new Uint8Array([0])));
let Processor,packets=[];
const context={AudioWorkletProcessor:class{constructor(){this.port={postMessage:p=>packets.push(p)};}},sampleRate:48000,registerProcessor:(n,p)=>Processor=p,ArrayBuffer,DataView,Math};
vm.runInNewContext(fs.readFileSync('public/audio-worklet.js','utf8'),context);
const processor=new Processor();for(let i=0;i<48000/128;i++)processor.process([[new Float32Array(128).fill(.5)]]);
assert.equal(packets.length,10);assert.equal(packets[0].buffer.byteLength,3200);assert.equal(new DataView(packets[0].buffer).getInt16(0,true),16384);
console.log('PASS: currency, empty state, portrait aspect, PCM playback, continuous 16 kHz resampling and HTML mirror');

const original=core.emptyData();original.scope_confirmed=true;original.air_movers=6;
const filled=core.applyScopeChanges(original,[{field:'finished_sf',room:'Room 1',value:80},{field:'category',room:'Room 1',value:2},{field:'has_crawl_space',room:null,value:false},{field:'labor_hours',room:null,value:0}]);
assert.equal(filled.scope_confirmed,false);assert.equal(filled.rooms[0].finished_sf,80);assert.equal(filled.air_movers,6);assert.equal(filled.monitoring_hours,13.25);assert.equal(original.rooms[0].finished_sf,0);assert.equal(original.scope_confirmed,true);
assert.throws(()=>core.applyScopeChanges(original,[{field:'scope_confirmed',room:null,value:true}]));
assert.throws(()=>core.applyScopeChanges(original,[{field:'unit_price',room:null,value:1}]));
assert.throws(()=>core.applyScopeChanges(original,[{field:'finished_sf',room:'New room',value:10}]));
const newRoom=core.applyScopeChanges(original,[{field:'category',room:'Bathroom',value:2},{field:'finished_sf',room:'bathroom',value:80}]);assert.equal(newRoom.rooms.length,2);assert.equal(newRoom.rooms[1].name,'Bathroom');assert.equal(newRoom.rooms[1].category,2);
console.log('PASS: selective scope application preserves manual values and sheet defaults; resets confirmation and requires complete new-room measurements');

{
  const core=require('../public/core.js'),data=core.emptyData();data.capture_metadata={capture_id:'a'.repeat(32),status:'recording',segments:[]};
  const chunk=(sequence,text,finished=false)=>({speaker:'technician',connection_id:'one',sequence,text,finished});
  core.ingestTranscript(data,chunk(1,'Bath'));core.ingestTranscript(data,chunk(2,'room',true));
  assert.equal(data.technician_transcript,'Bathroom');assert.equal(core.ingestTranscript(data,chunk(2,'room',true)).changed,false);
  core.ingestTranscript(data,chunk(3,'80 SF',true));assert.equal(data.technician_transcript,'Bathroom\n80 SF');
  data.technician_transcript='x'.repeat(79999);assert.equal(core.ingestTranscript(data,chunk(4,'overflow',true)).limit,true);
  assert.equal(data.technician_transcript.length,79999);assert.equal(data.capture_metadata.status,'truncated');
  console.log('PASS: fragmented transcript boundaries, identity deduplication and explicit storage limits');
}

{
  const core=require('../public/core.js'),data=core.emptyData();data.technician_transcript='語'.repeat(60000);data.assistant_transcript='文'.repeat(60000);
  data.capture_metadata={capture_id:'b'.repeat(32),status:'recording',segments:[{speaker:'technician',connection_id:'old',sequence:1,text:'語'.repeat(40000),finished:true},{speaker:'assistant',connection_id:'old',sequence:2,text:'文'.repeat(40000),finished:true}]};
  assert.equal(core.ingestTranscript(data,{speaker:'technician',connection_id:'new',sequence:3,text:'x',finished:true}).limit,true);
  assert.equal(data.technician_transcript.length,60000);assert.equal(data.capture_metadata.segments.length,2);
  console.log('PASS: UTF-8 capture budget preserves earlier text and leaves room for saved evidence/audit metadata');
}
