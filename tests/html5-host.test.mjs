// Authored fixture tests for the private research host, not original-game runtime verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {startHtml5ResearchHost} from '../scripts/html5-research-host.mjs';

const anchor = '(o = new h.Game(m)),';
const original = Buffer.from(`// Authored fixture; intentionally not a real game.\r\nconst h = {Game:function(){}}; const m = {}; let o;\r\n${anchor} void 0;\r\n`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'html5-host-test-'));
  const root = path.join(temporary,'game');
  await mkdir(path.join(root,'js'),{recursive:true});
  await mkdir(path.join(root,'bower_components/requirejs'),{recursive:true});
  await writeFile(path.join(root,'js/game.js'),original);
  await writeFile(path.join(root,'bower_components/requirejs/require.js'),'// Authored loader fixture.\n');
  let app;
  t.after(async () => { await app?.close(); await rm(temporary,{recursive:true,force:true}); });
  return {root, temporary, start:async () => (app = await startHtml5ResearchHost({root,script:'js/game.js'}))};
}
function request(url, pathname, extra = {}) {
  return new Promise((resolve,reject) => {
    const origin = new URL(url);
    const req = http.request({hostname:origin.hostname,port:origin.port,path:pathname,...extra},res => {
      const chunks=[]; res.on('data',chunk => chunks.push(chunk));
      res.on('end',() => resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject);req.end();
  });
}

test('HTML5 host: exposes one existing instance only in responses and preserves original bytes',async t => {
  const f = await fixture(t), app = await f.start();
  assert.match(app.url,/^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await request(app.url,'/');
  assert.equal(page.status,200);
  const html = page.body.toString();
  for (const id of ['root','container','hammer','debug-fps']) assert.ok(html.includes(`id="${id}"`));
  assert.match(html,/非原包基准/);
  assert.match(html,/data-main="\/js\/game.js"/);
  assert.doesNotMatch(html,/multiplayer\.js|cloudflare|analytics|https:\/\//i);
  const source = await request(app.url,'/js/game.js?cache=1');
  assert.equal(source.status,200);
  assert.equal(source.body.toString(),original.toString().replace(anchor,'(o = window.__game = new h.Game(m)),'));
  assert.deepEqual(await readFile(path.join(f.root,'js/game.js')),original);
  assert.equal(app.sourceSha256,sha(original)); assert.equal(app.servedSha256,sha(source.body));
  assert.equal(app.sourceBytes,original.length);
  const manifest = JSON.parse((await request(app.url,'/__research__/manifest')).body);
  assert.equal(manifest.originalPackageBaseline,false);assert.equal(manifest.sourceSha256,sha(original));
  assert.ok(!JSON.stringify(manifest).includes(f.root));
  const head = await request(app.url,'/js/game.js',{method:'HEAD'});
  assert.equal(head.status,200);assert.equal(head.body.length,0);
  assert.equal(Number(head.headers['content-length']),source.body.length);
});

test('HTML5 host: refuses missing inputs and ambiguous instance anchors before listening',async t => {
  const f = await fixture(t);
  await assert.rejects(startHtml5ResearchHost({}),{code:'HTML5_ROOT_REQUIRED'});
  await assert.rejects(startHtml5ResearchHost({root:f.root,script:'js/missing.js'}),{code:'HTML5_SOURCE_NOT_FOUND'});
  for (const text of ['// no instance\n',`${anchor} void 0;\n${anchor} void 0;`]) {
    await writeFile(path.join(f.root,'js/game.js'),text);
    await assert.rejects(startHtml5ResearchHost({root:f.root,script:'js/game.js'}),{code:'HTML5_INSTANCE_ANCHOR_COUNT'});
    assert.equal(await readFile(path.join(f.root,'js/game.js'),'utf8'),text);
  }
  await writeFile(path.join(f.root,'js/game.js'),original);
  await rm(path.join(f.root,'bower_components/requirejs/require.js'));
  await assert.rejects(startHtml5ResearchHost({root:f.root,script:'js/game.js'}),{code:'HTML5_REQUIREJS_NOT_FOUND'});
});

test('HTML5 host: denies traversal, hidden resources, arbitrary HTML and non-loopback Host',async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.temporary,'outside.json'),'"private"');
  await writeFile(path.join(f.root,'.secret.json'),'"secret"');
  await writeFile(path.join(f.root,'gameIndex.html'),'<script src="/multiplayer.js"></script>');
  const app = await f.start();
  for (const pathname of ['/../outside.json','/%2e%2e/outside.json','/js/%2e%2e/game.js','/js%2f..%2foutside.json',
    '/js%5cgame.js','/.secret.json','/%252e%252e/outside.json','//other.example/game.js']) {
    assert.equal((await request(app.url,pathname)).status,403,pathname);
  }
  assert.equal((await request(app.url,'/gameIndex.html')).status,404);
  assert.equal((await request(app.url,'/README.md')).status,404);
  assert.equal((await request(app.url,'/%zz')).status,400);
  assert.equal((await request(app.url,'/js/game.js',{headers:{host:'not-loopback.example'}})).status,403);
  assert.equal((await request(app.url,'/',{method:'POST'})).status,405);
  for (const script of ['../game.js','/game.js','js\\game.js','.hidden/game.js','https://example.com/game.js']) {
    await assert.rejects(startHtml5ResearchHost({root:f.root,script}),{code:'HTML5_UNSAFE_PATH'});
  }
});

test('HTML5 host: refuses symlink resources and symlink selected roots',async t => {
  const f = await fixture(t);
  const outside = path.join(f.temporary,'outside'); await mkdir(outside);
  await writeFile(path.join(outside,'secret.json'),'"private"');
  try {
    await symlink(outside,path.join(f.root,'linked'),process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(f.root,path.join(f.temporary,'linked-root'),process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM','EACCES','ENOSYS'].includes(error.code)) { t.skip('This environment cannot create the test symlinks.'); return; }
    throw error;
  }
  const app = await f.start();
  assert.equal((await request(app.url,'/linked/secret.json')).status,403);
  await assert.rejects(startHtml5ResearchHost({root:path.join(f.temporary,'linked-root'),script:'js/game.js'}),{code:'HTML5_UNSAFE_ROOT'});
});

test('HTML5 host: adapter modules only come from the fixed repository allowlist',async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root,'adapters/fireboy-html5'),{recursive:true});
  const fake='// game package must never supply trusted adapter code\n';
  await writeFile(path.join(f.root,'adapters/fireboy-html5/jump-analysis.mjs'),fake);
  const app = await f.start();
  assert.equal((await request(app.url,'/adapters/fireboy-html5/not-allowed.mjs')).status,403);
  assert.equal((await request(app.url,'/adapters/elsewhere/module.mjs')).status,403);
  assert.equal((await request(app.url,'/scripts/html5-research-host.mjs')).status,404);
  const response = await request(app.url,'/adapters/fireboy-html5/jump-analysis.mjs');
  const expectedPath = fileURLToPath(new URL('../adapters/fireboy-html5/jump-analysis.mjs',import.meta.url));
  let expected;
  try { expected = await readFile(expectedPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (expected) { assert.equal(response.status,200); assert.deepEqual(response.body,expected); }
  else assert.equal(response.status,404);
  assert.notEqual(response.body.toString(),fake);
});
