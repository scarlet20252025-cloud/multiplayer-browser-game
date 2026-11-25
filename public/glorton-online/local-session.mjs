const roomPattern=/^[A-HJ-NP-Z2-9]{6}$/;
const seatPattern=/^[A-Za-z0-9_-]{32}$/;
const inboundLimit=1_000_000;
const outboundLimit=64*1024;
const ackInterval=4;
const pingInterval=1200;
const pingTimeout=3600;
const metricsInterval=250;
const linkSampleLifetime=5000;
const seatKey=room=>'glorton-browser-seat:'+room;
const nameKey=room=>'glorton-browser-name:'+room;

function lobbyLink(name){
  const url=new URL('/',location.origin);
  if(name){url.searchParams.set('room',name);url.searchParams.set('game','glorton');}
  return url;
}

export function createLocalSession({room,seat,url,Socket=WebSocket,onPacket=()=>{},onDisconnect=()=>{},onMetrics=()=>{}}){
  let current=null,nextId=0;
  let model={status:'loading',tick:0,corrections:0,rttMs:null,linkRttMs:null,frameBacklog:0,renderMs:null,fps:null};
  let lastMetrics=-Infinity;
  let frameSample=null;

  function publishMetrics(force=false){
    const now=performance.now();
    if(!force&&now-lastMetrics<metricsInterval)return;
    lastMetrics=now;
    if(current&&now-current.linkSampleAt>linkSampleLifetime)model.linkRttMs=null;
    onMetrics({...model});
  }

  function ping(link){
    if(current!==link||link.socket.readyState!==1)return;
    const now=performance.now();
    if(link.ping&&now-link.ping.started<pingTimeout)return;
    if(link.ping){
      model.rttMs=null;
      publishMetrics();
    }
    const id=Date.now();
    if(send(link.id,JSON.stringify({op:'ping',id,client_time_ms:id}))){
      link.ping={id,started:now};
    }
  }

  function open(){
    current?.socket.close();
    const socket=new Socket(url);
    const link={id:++nextId,socket,events:[],first:0,bytes:0,ping:null,pingTimer:null,linkSampleAt:-Infinity,
      frameAck:false,lastAck:-1,latestTick:0,round:0};
    current=link;
    model.rttMs=null;
    model.linkRttMs=null;
    model.frameBacklog=0;
    model.fps=null;
    frameSample=null;
    publishMetrics(true);
    socket.addEventListener('open',()=>socket.send(JSON.stringify({op:'attach',room,seat,frame_ack:true,compact_frames:true})));
    socket.addEventListener('message',event=>{
      if(current!==link)return;
      if(typeof event.data!=='string')return socket.close(4002,'Invalid game packet');
      let packet,message;
      try{
        const wirePacket=JSON.parse(event.data);
        packet=decodeGlortonFrame(wirePacket);
        // Snapshots preserve the raw Python number literals required for state checksums.
        message=packet===wirePacket?event.data:JSON.stringify(packet);
      }catch{return socket.close(4002,'Invalid game packet');}
      if(packet.op==='link_stats'){
        if(Number.isFinite(packet.rtt_ms)&&packet.rtt_ms>=0){
          model.linkRttMs=packet.rtt_ms;
          link.linkSampleAt=performance.now();
          publishMetrics();
        }
        return;
      }
      if(packet.op==='pong'&&link.ping&&packet.id===link.ping.id){
        const sample=performance.now()-link.ping.started;
        link.ping=null;
        model.rttMs=model.rttMs===null?sample:model.rttMs*.75+sample*.25;
        publishMetrics();
        return;
      }
      if(Number.isSafeInteger(packet.round)){
        if(packet.round<link.round)return;
        if(packet.round>link.round){
          link.round=packet.round;
          link.lastAck=-1;
          link.latestTick=0;
          frameSample=null;
        }
      }
      if(link.bytes+message.length>inboundLimit){
        link.events=[];link.first=0;link.bytes=0;
        socket.close(4002,'Request a fresh game state');
        return;
      }
      link.events.push(message);
      link.bytes+=message.length;
      if(packet.op==='welcome'&&!link.pingTimer){
        link.frameAck=packet.frame_ack===true;
        ping(link);
        link.pingTimer=setInterval(()=>ping(link),pingInterval);
      }
      if(packet.op==='frame'){
        link.latestTick=Math.max(link.latestTick,packet.tick);
      }else{
        if(packet.op==='match_start')link.latestTick=packet.initial_snapshot?.tick??0;
        if(packet.op==='snapshot')link.latestTick=Math.max(link.latestTick,packet.snapshot?.tick??0);
        if(packet.op==='room_state'&&Number.isSafeInteger(packet.server_tick))
          link.latestTick=Math.max(link.latestTick,packet.server_tick);
        onPacket(packet);
      }
    });
    socket.addEventListener('close',()=>{
      clearInterval(link.pingTimer);
      if(current!==link)return;
      model.rttMs=null;
      model.linkRttMs=null;
      model.fps=null;
      frameSample=null;
      publishMetrics(true);
      onDisconnect();
    });
    return link.id;
  }
  function send(id,message){
    if(current?.id!==id||current.socket.readyState!==1)return false;
    if(current.socket.bufferedAmount>outboundLimit){current.socket.close(4002,'Input connection stalled');return false;}
    current.socket.send(message);
    return true;
  }
  function read(id){
    if(current?.id!==id)return '';
    const link=current;
    const message=link.events[link.first];
    if(message===undefined)return '';
    link.first++;
    link.bytes-=message.length;
    if(link.first===link.events.length){link.events=[];link.first=0;}
    else if(link.first>=64){link.events=link.events.slice(link.first);link.first=0;}
    return message;
  }

  function acknowledge(tick,immediate,round){
    const link=current;
    if(!link?.frameAck||!Number.isSafeInteger(tick)||tick<link.lastAck)return false;
    if(round!==undefined&&round!==link.round)return false;
    if(!immediate&&tick<link.lastAck+ackInterval)return false;
    if(!send(link.id,JSON.stringify({op:'frame_ack',tick,...(link.round?{round:link.round}:{})})))return false;
    link.lastAck=tick;
    return true;
  }

  function reportFrameRate(status,presented){
    if(status!=='battle'||!Number.isSafeInteger(presented)||presented<0){
      frameSample=null;
      model.fps=null;
      return;
    }
    const time=performance.now();
    if(!frameSample||presented<frameSample.presented){
      frameSample={time,presented};
      model.fps=null;
      return;
    }
    const elapsed=time-frameSample.time;
    if(elapsed>=700){
      model.fps=1000*(presented-frameSample.presented)/elapsed;
      frameSample={time,presented};
    }
  }

  return Object.freeze({
    room,open,read,send,acknowledge,
    state:id=>current?.id===id?current.socket.readyState:3,
    sendControl:packet=>current!==null&&send(current.id,JSON.stringify({...packet,...(current.round?{round:current.round}:{})})),
    close(id){if(current?.id===id)current.socket.close();},
    rtt:()=>model.rttMs??0,
    report(status,tick,corrections,renderMs,presented){
      Object.assign(model,{status,tick,corrections,
        renderMs:renderMs>0?renderMs:null,
        frameBacklog:status==='battle'?Math.max(0,(current?.latestTick??0)-tick):0});
      reportFrameRate(status,presented);
      publishMetrics();
    },
    metrics:()=>({...model}),
  });
}

if(typeof window!=='undefined'){
  const params=new URLSearchParams(location.hash.slice(1));
  const room=params.get('room');
  let seat=params.get('seat');
  let roomName=params.get('name');
  if(roomPattern.test(room??'')){
    try{
      if(seatPattern.test(seat??'')){
        sessionStorage.setItem(seatKey(room),seat);
        if(roomName)sessionStorage.setItem(nameKey(room),roomName);
        history.replaceState(null,'',location.pathname+location.search+'#room='+room);
      }else if(seat===null){
        seat=sessionStorage.getItem(seatKey(room));
        roomName=sessionStorage.getItem(nameKey(room));
      }
    }catch{}
  }
  if(!roomPattern.test(room??'')||!seatPattern.test(seat??'')){
    location.replace(lobbyLink(roomPattern.test(room??'')?roomName||room:null));
  }else{
    let leaving=false;
    function saveRoomName(value){
      if(typeof value!=='string'||!value||Array.from(value).length>24)return;
      roomName=value;
      try{sessionStorage.setItem(nameKey(room),value);}catch{}
    }
    async function leave({rejoin=false}={}){
      if(leaving)return;
      leaving=true;
      const endpoint='/glorton-online/leave';
      const body=JSON.stringify({room,seat});
      const headers={'content-type':'application/json'};
      transport.sendControl({op:'leave'});
      try{
        const response=await fetch(endpoint,{method:'POST',headers,body,keepalive:true,signal:AbortSignal.timeout(2400)});
        if(!response.ok)throw Error('Seat could not be released');
      }catch{
        navigator.sendBeacon?.(endpoint,new Blob([body],{type:'application/json'}));
      }
      try{sessionStorage.removeItem(seatKey(room));}catch{}
      window.onbeforeunload=null;
      location.replace(lobbyLink(rejoin?roomName||room:null));
    }
    const url=new URL('/glorton-online/browser-ws',location.href);
    url.protocol=location.protocol==='https:'?'wss:':'ws:';
    const transport=createLocalSession({room,seat,url:url.href,onPacket(packet){
      saveRoomName(packet.roomName);
      hud.receive(packet);
    },onDisconnect:()=>{if(!leaving)hud.disconnect();},
    onMetrics:metrics=>hud.transportMetrics?.(metrics)});
    const hud=mountGlortonHud({room,roomName:roomName||room,send:packet=>transport.sendControl(packet),leave});
    Object.defineProperty(window,'GlortonLocalSession',{value:transport});
  }
}
import {mountGlortonHud} from './local-hud.mjs';
import {decodeGlortonFrame} from './frame-wire.mjs';
