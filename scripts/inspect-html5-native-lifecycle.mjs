#!/usr/bin/env node
// Enumerate the loaded native game lifecycle interface. No restart method is invoked.
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';

const {values}=parseArgs({options:{
  root:{type:'string'},script:{type:'string'},'require-script':{type:'string'},
  'entry-path':{type:'string'},'expected-sha256':{type:'string'},
  'level-id':{type:'string'},out:{type:'string'}
}});
const dir=path.resolve(values.out??'local/html5-lifecycle-discovery');
await mkdir(dir,{recursive:true});
const output={schemaVersion:1,status:'blocked',method:'read-only introspection',
  nativeRestartVerified:false,deathVerified:false,clientEpochRolloverVerified:false,
  originalPackageBaseline:false,errors:[]};
let room;
try{
  if(!values.root||!values.script)throw Error('Missing private game runtime');
  const levelId=Number(values['level-id']??1);
  if(!Number.isSafeInteger(levelId)||levelId<1)throw Error('Invalid level ID');
  room=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],levelId});
  output.sourceSha256=room.sourceSha256;
  if(values['expected-sha256']&&values['expected-sha256']!==room.sourceSha256)
    throw Error('Research candidate game.js hash changed');
  output.level=room.level;
  output.native=await room.inspectLifecycle();
  if(output.native.stateName!=='level'||!Number.isSafeInteger(output.native.levelEpoch))
    throw Error('Native level/epoch not ready');
  output.status='inspected';
}catch(error){output.errors.push(String(error.stack??error));}
finally{
  await room?.close().catch(error=>output.errors.push(String(error)));
  await writeFile(path.join(dir,'lifecycle-native-methods.json'),
    JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({status:output.status,sourceSha256:output.sourceSha256,
    methods:output.native?.levelMethods,scene:output.native?.levelStateMethods,
    errors:output.errors}));
  if(output.status!=='inspected')process.exitCode=1;
}
