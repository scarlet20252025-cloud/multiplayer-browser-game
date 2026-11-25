import {PULSE_CHARGE_SECONDS} from './rules.mjs';

const TAU=2*Math.PI;
const MASTER_GAIN=.86;
const noise=()=>Math.random()*2-1;

function sweep(time,from,to,length){
  const slope=(to-from)/length;
  const phase=time<length?from*time+slope*time*time/2:(from+to)*length/2+to*(time-length);
  return Math.sin(TAU*phase);
}

function makeSample(context,duration,mix){
  const buffer=context.createBuffer(1,Math.ceil(context.sampleRate*duration),context.sampleRate);
  const samples=buffer.getChannelData(0);
  let bass=0,body=0;
  for(let index=0;index<samples.length;index++){
    const time=index/context.sampleRate;
    const grain=noise();
    bass+=.024*(grain-bass);
    body+=.21*(grain-body);
    const envelope=Math.min(1,time/.00065,(duration-time)/.012);
    samples[index]=Math.tanh(mix(time,grain-body,body,bass)*1.23)*envelope;
  }
  return buffer;
}

const decay=(time,rate)=>Math.exp(-time*rate);
const ring=(time,hz,rate)=>Math.sin(TAU*hz*time)*decay(time,rate);
const crack=(time,edge,rate=90)=>edge*decay(time,rate);
const clatter=(time,edge,hz)=>edge*Math.sin(TAU*hz*time)**6;

function rocketIgnition(t,edge,body,bass){
  const blast=1.74*crack(t,edge,67)+.87*ring(t,154,29)+.68*ring(t,97,17);
  const flame=(.56*edge+.93*body+.81*bass)*decay(t,10);
  return blast+flame;
}

function steelRicochet(t,edge,body,bass){
  const strike=1.28*crack(t,edge,182)+.86*ring(t,148,41)+.56*ring(t,222,46);
  const steel=.38*ring(t,372,30)+.25*ring(t,533,43)+.12*ring(t,783,66);
  return strike+steel+(.46*bass+.19*body)*decay(t,33);
}

function missileImpact(t,edge,body,bass){
  const strike=1.56*crack(t,edge,128)+1.10*sweep(t,208,62,.11)*decay(t,24);
  const shudder=.72*ring(t,108,17)+.39*ring(t,286,29)+.24*ring(t,419,35);
  return strike+shudder+(.68*bass+.39*body)*decay(t,23);
}

function armorImpact(t,edge,body,bass){
  const strike=1.41*crack(t,edge,145)+.94*ring(t,116,19)+.69*ring(t,184,28);
  const plates=.40*ring(t,281,26)+.29*ring(t,407,21)+.15*ring(t,663,42);
  return strike+plates+(.55*bass+.32*body)*decay(t,26);
}

function piercingCharge(t,edge,body){
  const progress=t/PULSE_CHARGE_SECONDS;
  const swell=(1-decay(t,29))*(.20+.80*progress*progress);
  const coils=.40*sweep(t,84,435,PULSE_CHARGE_SECONDS)+.24*sweep(t,168,870,PULSE_CHARGE_SECONDS);
  return swell*(coils+.15*body+.08*clatter(t,edge,37))+.19*ring(t,278,41);
}

function piercingShot(t,edge,body,bass){
  const report=1.68*crack(t,edge,105)+.96*sweep(t,242,58,.13)*decay(t,21)+.48*ring(t,1327,53);
  const field=.30*sweep(t,156,64,1.55)+.12*sweep(t,312,128,1.55)+.20*body+.12*bass;
  const taper=(1-decay(t,47))*decay(t,1.55)*(1-t/2);
  return report+field*taper;
}

const tones={
  shell:[.16,(t,edge,body)=>{
    const report=1.35*crack(t,edge)+.72*sweep(t,231,94,.055)*decay(t,31);
    return report+.36*body*decay(t,23)+.24*ring(t,1241,54);
  }],
  scatter:[.21,(t,edge,body)=>1.58*crack(t,edge,61)+.68*sweep(t,169,62,.09)*decay(t,19)+.95*body*decay(t,22)],
  'pulse-shell':[.22,(t,edge)=>.91*crack(t,edge)+.62*sweep(t,1620,310,.10)*decay(t,21)+.31*ring(t,487,36)],
  'pulse-charge':[PULSE_CHARGE_SECONDS,piercingCharge],
  pulse:[2,piercingShot],
  burst:[.085,(t,edge,body)=>1.39*crack(t,edge,122)+.41*ring(t,316,51)+.29*ring(t,1974,65)+.35*body*decay(t,35)],
  'spin-up':[.25,(t,edge)=>.28*sweep(t,131,721,.24)*Math.min(1,t*16)+.31*clatter(t,edge,44)*decay(t,10)],
  'spin-down':[.20,(t,edge)=>.33*sweep(t,653,160,.17)*decay(t,16)+.25*clatter(t,edge,31)*decay(t,15)],
  double:[.17,(t,edge,body)=>1.42*crack(t,edge,95)+.70*ring(t,187,31)+.29*ring(t,1111,37)+.51*body*decay(t,24)],
  seeker:[.30,rocketIgnition],
  lock:[.12,t=>.25*ring(t,1186,25)+.18*ring(t,1659,29)],
  cluster:[.24,(t,edge,body)=>1.21*crack(t,edge,86)+.88*sweep(t,222,57,.13)*decay(t,22)+.60*body*decay(t,20)],
  fragment:[.25,(t,edge)=>1.04*crack(t,edge,60)+.84*clatter(t,edge,34)*decay(t,22)+.27*ring(t,981,35)],
  guide:[.27,rocketIgnition],
  'rocket-bounce':[.25,missileImpact],
  beam:[.24,(t,edge)=>1.29*crack(t,edge,117)+.73*sweep(t,1970,266,.11)*decay(t,17)+.43*ring(t,276,27)],
  mine:[.16,(t,edge)=>.75*crack(t,edge,162)+.39*ring(t,319,42)+.29*ring(t,1487,40)],
  'mine-blast':[.55,(t,edge,body,bass)=>{
    const impact=1.42*crack(t,edge,43)+1.04*sweep(t,150,51,.26)*decay(t,10)+.75*bass*decay(t,13);
    return impact+(.87*clatter(t,edge,27)+.45*body)*decay(t,9);
  }],
  bounce:[.17,steelRicochet],
  shield:[.30,armorImpact],
  pickup:[.22,(t,edge)=>.38*crack(t,edge,235)+.40*ring(t,741,31)+.29*ring(t,1134,18)],
  respawn:[.23,t=>.39*sweep(t,318,636,.17)*Math.sin(Math.PI*Math.min(1,t/.23))**2],
  explosion:[.73,(t,edge,body,bass)=>{
    const blast=1.89*crack(t,edge,44)+.95*ring(t,76,11)+.78*bass*decay(t,8);
    const metal=.46*ring(t,271,16)+.36*ring(t,1237,24);
    const debris=(.55*bass+.67*body+.76*clatter(t,edge,19))*decay(t,6);
    return blast+metal+debris;
  }],
};

export function createArenaAudio(){
  const Audio=globalThis.AudioContext??globalThis.webkitAudioContext;
  let enabled=true;
  let context,master;
  const samples=new Map();
  return {
    supported:Boolean(Audio),
    enable(value){
      enabled=value;
      if(master)master.gain.setTargetAtTime(value?MASTER_GAIN:0,context.currentTime,.009);
    },
    unlock(){
      if(!Audio||!enabled)return;
      if(!context){
        try{context=new Audio();}catch{return;}
        master=context.createGain();
        master.gain.value=MASTER_GAIN;
        const compressor=context.createDynamicsCompressor();
        compressor.threshold.value=-11;
        compressor.knee.value=5;
        compressor.ratio.value=11;
        compressor.attack.value=.002;
        compressor.release.value=.13;
        master.connect(compressor).connect(context.destination);
      }
      if(context.state!=='running')void context.resume().catch(()=>{});
    },
    play(kind,volume=1,pan=0){
      if(!enabled||context?.state!=='running'||!tones[kind])return;
      if(!samples.has(kind))samples.set(kind,makeSample(context,...tones[kind]));
      const source=context.createBufferSource(),gain=context.createGain();
      source.buffer=samples.get(kind);
      gain.gain.value=volume;
      if(kind==='shell'||kind==='bounce')source.playbackRate.value=1+noise()*.055;
      source.connect(gain);
      if(pan&&context.createStereoPanner){
        const stereo=context.createStereoPanner();
        stereo.pan.value=Math.max(-1,Math.min(1,pan));
        gain.connect(stereo).connect(master);
      }else gain.connect(master);
      source.start();
    },
  };
}
