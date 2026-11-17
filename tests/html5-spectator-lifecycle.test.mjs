import test from 'node:test';
import assert from 'node:assert/strict';
import {connectHtml5Spectator} from '../adapters/fireboy-html5/spectator-client.mjs';

test('native lifecycle event latches a viewer and refuses stale keyboard/P commands',t=>{
  const saved={WebSocket:globalThis.WebSocket,window:globalThis.window,
    document:globalThis.document};
  t.after(()=>Object.assign(globalThis,saved));
  const documentEvents=new Map();
  const game={
    level:{pers1:{sprite:{}},pers2:{sprite:{}},
      togglePause(){},pauseUpdate(){}},
    layers:{underGround:{children:[]}},
    physics:{box2d:{paused:false}},input:{enabled:true},paused:false
  };
  class FakeSocket{
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=1;this.sent=[];FakeSocket.latest=this;}
    send(msg){this.sent.push(JSON.parse(msg));}
    close(){this.readyState=3;}
    receive(event){this.onmessage({data:JSON.stringify(event)});}
  }
  globalThis.WebSocket=FakeSocket;
  globalThis.document={
    addEventListener(type,fn){documentEvents.set(type,fn);},
    removeEventListener(type){documentEvents.delete(type);}
  };
  globalThis.window={addEventListener(){},removeEventListener(){}};
  const browser=connectHtml5Spectator({game,wsUrl:'ws://127.0.0.1:9999/ws',devices:{}});
  const ws=FakeSocket.latest;
  ws.receive({type:'welcome',slot:1,room:{
    roomEpoch:'native-session-1',bothReady:true,effectivePaused:false,
    userPaused:false,pauseRevision:0
  }});
  assert.equal(ws.sent.at(-1).type,'ready');
  const key=(type,code)=>{
    const listener=documentEvents.get(type);
    listener?.({code,repeat:false,preventDefault(){}});
  };
  key('keydown','KeyA');
  assert.ok(ws.sent.some(x=>x.type==='input'&&x.moveX===-1));
  const before=ws.sent.length;
  ws.receive({type:'lifecycle',roomEpoch:'native-session-1',
    reason:'LEVEL_EPOCH_CHANGED',levelEpoch:2,snapshotSeq:88,restartSupported:false});
  assert.deepEqual(browser.status().lifecycle,{
    reason:'LEVEL_EPOCH_CHANGED',levelEpoch:2,snapshotSeq:88,restartSupported:false
  });
  key('keydown','KeyA');
  key('keydown','KeyP');
  key('keyup','KeyA');
  assert.equal(browser.sendInput(),false);
  assert.equal(ws.sent.length,before,'no old scene input or pause may be emitted');
  browser.close();
  assert.equal(ws.sent.at(-1).type,'leave');
  assert.equal(game.input.enabled,true);
});

test('wrong room epoch lifecycle event fails visibly without suspending a valid room',t=>{
  const saved={WebSocket:globalThis.WebSocket,window:globalThis.window,
    document:globalThis.document};
  t.after(()=>Object.assign(globalThis,saved));
  class FakeSocket{
    static OPEN=1;
    constructor(){this.readyState=1;FakeSocket.latest=this;}
    send(){}
    close(){this.readyState=3;}
    receive(event){this.onmessage({data:JSON.stringify(event)});}
  }
  globalThis.WebSocket=FakeSocket;
  globalThis.window={addEventListener(){},removeEventListener(){}};
  globalThis.document={addEventListener(){},removeEventListener(){}};
  const game={level:{pers1:{sprite:{}},pers2:{sprite:{}},
    togglePause(){},pauseUpdate(){}},
    layers:{underGround:{children:[]}},input:{enabled:true},paused:false};
  const browser=connectHtml5Spectator({game,wsUrl:'ws://127.0.0.1:9000/ws',devices:{}});
  FakeSocket.latest.receive({type:'welcome',slot:0,room:{
    roomEpoch:'expected',bothReady:true,effectivePaused:false,pauseRevision:0
  }});
  FakeSocket.latest.receive({type:'lifecycle',roomEpoch:'old',
    reason:'LEVEL_EPOCH_CHANGED',levelEpoch:2});
  assert.equal(browser.status().lastError,'BAD_LIFECYCLE_EVENT');
  assert.equal(browser.status().lifecycle,null);
  browser.close();
});
