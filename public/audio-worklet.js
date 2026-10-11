/* Continuous mono resampling from the hardware rate to PCM16LE at 16 kHz. */
class ADRMicrophone extends AudioWorkletProcessor {
  constructor(){super();this.phase=0;this.sum=0;this.count=0;this.values=[];this.energy=0;}
  process(inputs){
    const channel=inputs[0] && inputs[0][0];if(!channel)return true;
    for(const sample of channel){
      this.sum+=sample;this.count++;this.phase+=16000;
      if(this.phase>=sampleRate){
        const value=Math.max(-1,Math.min(1,this.sum/this.count));
        this.values.push(Math.round(value<0?value*32768:value*32767));this.energy+=value*value;
        this.phase-=sampleRate;this.sum=0;this.count=0;
        if(this.values.length===1600){
          const buffer=new ArrayBuffer(3200),view=new DataView(buffer);
          this.values.forEach((v,i)=>view.setInt16(i*2,v,true));
          this.port.postMessage({buffer,rms:Math.sqrt(this.energy/1600)},[buffer]);this.values=[];this.energy=0;
        }
      }
    }
    return true;
  }
}
registerProcessor('adr-microphone',ADRMicrophone);
