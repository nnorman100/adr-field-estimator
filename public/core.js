/* Small pure functions shared by the UI and behavioral tests. */
(function(root){
  const emptyData=()=>({address:'',year_built:null,has_crawl_space:false,granite_removal:false,water_heater_loss:false,work_performed:false,rooms:[{name:'Room 1',category:1,unfinished_sf:0,finished_sf:0,custom_cabinetry:false,waste_percent:0}],air_movers:0,dehumidifiers:0,drying_days:3,labor_hours:0,is_after_hours:false,emergency_calls:1,monitoring_hours:13.25,haul_loads:1,air_scrubbers:1,hepa_filters:1,matterport_scans:0,dump_truck_loads:0,equipment_decon:0,power_distribution:0,wood_floor_systems:0,wood_floor_days:7,package_price:null,technician_notes:'',technician_transcript:'',assistant_transcript:'',scope_confirmed:false});
  const stable=value=>JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v)?Object.keys(v).sort().reduce((o,k)=>(o[k]=v[k],o),{}):v);
  const money=value=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(value));
  const pcmToFloat=bytes=>{if(bytes.byteLength%2)throw Error('Invalid PCM');const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);return Float32Array.from({length:bytes.byteLength/2},(_,i)=>view.getInt16(i*2,true)/32768);};
  const aspect=(width,height,limit=1280)=>{const scale=Math.min(1,limit/Math.max(width,height));return [Math.round(width*scale),Math.round(height*scale)];};
  const scopeJobLabels={address:'Property address',year_built:'Year built',has_crawl_space:'Crawl space exists',granite_removal:'Cabinet removal under granite',water_heater_loss:'Garage water-heater loss',air_movers:'Air movers',dehumidifiers:'LGR dehumidifiers',drying_days:'Drying days',labor_hours:'Additional labor hours',is_after_hours:'After-hours loss',emergency_calls:'Emergency calls',monitoring_hours:'Monitoring hours',haul_loads:'Haul pickup loads',air_scrubbers:'Air-scrubber rental days',hepa_filters:'HEPA filters',matterport_scans:'Matterport scans',dump_truck_loads:'Dump-truck loads',equipment_decon:'Equipment decontamination',power_distribution:'Power distribution units',wood_floor_systems:'Wood-floor systems / heaters',wood_floor_days:'Wood-floor drying days'};
  const scopeRoomLabels={category:'Water category',unfinished_sf:'Unfinished / subfloor SF',finished_sf:'Finished / drywall / trim SF',custom_cabinetry:'Custom cabinetry',waste_percent:'Waste %'};
  const roomKey=name=>name.trim().replace(/\s+/g,' ').toLowerCase();
  function applyScopeChanges(data,changes){
    const result=structuredClone(data),newRooms=new Map();
    for(const change of changes){
      if(change.room==null){if(!Object.hasOwn(scopeJobLabels,change.field))throw Error('Unsupported scope field.');result[change.field]=change.value;}
      else{
        if(!Object.hasOwn(scopeRoomLabels,change.field))throw Error('Unsupported room field.');
        const matches=result.rooms.filter(room=>roomKey(room.name)===roomKey(change.room));
        if(matches.length>1)throw Error('Give duplicate rooms distinct names before applying changes.');
        let room=matches[0];
        if(!room){const key=roomKey(change.room);if(!newRooms.has(key))newRooms.set(key,{name:change.room});room=newRooms.get(key);}
        room[change.field]=change.value;
      }
    }
    for(const room of newRooms.values()){
      if(!Object.hasOwn(room,'category')||(!Object.hasOwn(room,'finished_sf')&&!Object.hasOwn(room,'unfinished_sf')))throw Error('A new room needs a stated water category and demolition area.');
      result.rooms.push({...emptyData().rooms[0],...room});
    }
    if(result.rooms.length>30)throw Error('At most 30 rooms are supported.');
    result.scope_confirmed=false;return result;
  }
  function ingestTranscript(data,message){
    const capture=data.capture_metadata;
    if(!capture)return {changed:false};
    const identity=message.connection_id+':'+message.sequence;
    if(capture.segments.some(segment=>segment.connection_id+':'+segment.sequence===identity))return {changed:false};
    const side=message.speaker==='technician'?'technician':'assistant',key=side+'_transcript';
    const previous=[...capture.segments].reverse().find(segment=>segment.speaker===side);
    const boundary=message.text && data[key] && (!previous||previous.finished===true||previous.connection_id!==message.connection_id)?'\n':'';
    if((data[key]||'').length+boundary.length+message.text.length>80000||capture.segments.length>=2000){capture.status='truncated';return {changed:true,limit:true};}
    const before=data[key]||'';
    capture.segments.push({speaker:side,connection_id:message.connection_id,sequence:message.sequence,text:message.text,finished:message.finished??null});
    data[key]=before+boundary+message.text;
    if(new TextEncoder().encode(JSON.stringify(data)).length>550000){capture.segments.pop();data[key]=before;capture.status='truncated';return {changed:true,limit:true};}
    return {changed:true,preview:message.finished!==true};
  }
  const api={emptyData,stable,money,pcmToFloat,aspect,scopeJobLabels,scopeRoomLabels,roomKey,applyScopeChanges,ingestTranscript};
  if(typeof module!=='undefined')module.exports=api;else root.ADRCore=api;
})(typeof window==='undefined'?globalThis:window);
