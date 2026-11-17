#!/usr/bin/env node
// Builds our original AS3 fixture with the official Apache Flex compiler.
// SDKs are downloaded only with --download, and stay outside tracked source.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const help = `Build the original AS3/AVM2 networking probe.\n\n` +
  `node scripts/build-as3-probe.mjs --sdk /path/to/apache-flex-sdk-4.16.1-bin --playerglobal /path/to/playerglobal32_0.swc\n` +
  `node scripts/build-as3-probe.mjs --download [--tool-dir /path/to/tool-cache]\n\n` +
  `Requires Java. --download also requires curl and tar. Downloads are SHA-256 checked.\n`;
if (args.includes('--help')) { console.log(help); process.exit(0); }
const flags = new Map();
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (key === '--download') flags.set(key, true);
  else if (['--sdk', '--playerglobal', '--tool-dir'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) flags.set(key, args[++i]);
  else throw new Error(`Unknown or incomplete argument: ${key}\n${help}`);
}

const sources = {
  flex: {
    version: '4.16.1 build 20171115',
    url: 'https://downloads.apache.org/flex/4.16.1/binaries/apache-flex-sdk-4.16.1-bin.tar.gz',
    sha256: '17fda7ac8d3e476cad3127f345455ef316acfb87c6f4322e5897bd8d9b09388e',
    officialMd5Url: 'https://downloads.apache.org/flex/4.16.1/binaries/apache-flex-sdk-4.16.1-bin.tar.gz.md5',
    officialMd5: '0fba6c912c3919ae1b978ca2d053fe07',
  },
  playerglobal: {
    version: '32.0',
    url: 'https://fpdownload.macromedia.com/get/flashplayer/updaters/32/playerglobal32_0.swc',
    sha256: '7d4d6168d27603cfb3b750302448e354e0bbc1bdd58f5d101c3dcf6891e9bb65',
  },
};

const toolDir = resolve(flags.get('--tool-dir') || process.env.AS3_PROBE_TOOLS || join(root, 'local/tools/as3-probe'));
let sdk = flags.get('--sdk') || process.env.AS3_PROBE_FLEX_SDK;
let playerglobal = flags.get('--playerglobal') || process.env.AS3_PROBE_PLAYERGLOBAL;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, parameters, capture = false) {
  const result = spawnSync(command, parameters, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${result.stderr || ''}`);
  return (result.stdout || '').trim();
}
function checkedDownload(item, destination) {
  if (!existsSync(destination)) {
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    run(curl, ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '20', '--max-time', '240', '--output', destination, item.url]);
  }
  const actual = hash(readFileSync(destination));
  if (actual !== item.sha256) throw new Error(`SHA-256 mismatch for ${destination}: ${actual}. Remove the file and retry.`);
}

if (flags.has('--download')) {
  mkdirSync(toolDir, { recursive: true });
  const archive = join(toolDir, 'apache-flex-sdk-4.16.1-bin.tar.gz');
  checkedDownload(sources.flex, archive);
  const downloadedSdk = join(toolDir, 'apache-flex-sdk-4.16.1-bin');
  if (!existsSync(join(downloadedSdk, 'lib/mxmlc.jar'))) run('tar', ['-xzf', archive, '-C', toolDir]);
  const downloadedPlayerglobal = join(toolDir, 'playerglobal32_0.swc');
  checkedDownload(sources.playerglobal, downloadedPlayerglobal);
  sdk ||= downloadedSdk;
  playerglobal ||= downloadedPlayerglobal;
}
if (!sdk || !playerglobal) throw new Error(help);
sdk = resolve(sdk);
playerglobal = resolve(playerglobal);
const compiler = join(sdk, 'lib/mxmlc.jar');
if (!existsSync(compiler) || !existsSync(playerglobal)) throw new Error('Missing mxmlc.jar or playerglobal SWC; check --sdk and --playerglobal.');
if (hash(readFileSync(playerglobal)) !== sources.playerglobal.sha256) throw new Error('The playerglobal file does not match the pinned Adobe 32.0 library.');

const relativeSource = 'experiments/as3-probe/src/NetProbe.as';
const relativeOutput = 'experiments/as3-probe/probe.swf';
const options = [
  '-load-config=',
  `-compiler.external-library-path=${playerglobal}`,
  '-target-player=11.1',
  '-swf-version=14',
  '-static-link-runtime-shared-libraries=true',
  '-debug=false',
  '-omit-trace-statements=false',
  `-output=${relativeOutput}`,
  relativeSource,
];
const compilerVersion = run('java', ['-jar', compiler, '-version'], true);
if (compilerVersion !== `Version ${sources.flex.version}`) throw new Error(`Unexpected compiler version: ${compilerVersion}`);
run('java', [`-Dflexlib=${join(sdk, 'frameworks')}`, '-jar', compiler, ...options]);

const swf = readFileSync(join(root, relativeOutput));
const signature = swf.subarray(0, 3).toString('ascii');
if (!['CWS', 'FWS'].includes(signature)) throw new Error(`Unexpected SWF signature ${signature}`);
const body = signature === 'CWS' ? inflateSync(swf.subarray(8)) : swf.subarray(8);
const declaredLength = swf.readUInt32LE(4);
if (declaredLength !== body.length + 8) throw new Error('SWF uncompressed length does not match its header.');
const rectBits = body[0] >> 3;
let offset = Math.ceil((5 + rectBits * 4) / 8) + 4;
let abcCount = 0;
let avm2Flag = false;
while (offset + 2 <= body.length) {
  const record = body.readUInt16LE(offset);
  offset += 2;
  const tag = record >> 6;
  let length = record & 63;
  if (length === 63) { length = body.readUInt32LE(offset); offset += 4; }
  if (offset + length > body.length) throw new Error('Invalid SWF tag length.');
  if (tag === 69 && length >= 4) avm2Flag = Boolean(body.readUInt32LE(offset) & 8);
  if (tag === 82) abcCount++;
  offset += length;
  if (tag === 0) break;
}
if (!avm2Flag || abcCount < 1) throw new Error('Fixture did not compile as AS3/AVM2.');
const report = {
  schemaVersion: 1,
  purpose: 'Original AS3 bridge fixture; does not contain or validate either archived game.',
  sources,
  compiler: { version: compilerVersion, mxmlcJarSha256: hash(readFileSync(compiler)), options: options.map(s => s.startsWith('-compiler.external-library-path=') ? '-compiler.external-library-path=<playerglobal32_0.swc>' : s) },
  fixture: { source: relativeSource, sourceSha256: hash(readFileSync(join(root, relativeSource))), output: relativeOutput, sha256: hash(swf), bytes: swf.length, signature, swfVersion: swf[3], declaredUncompressedBytes: declaredLength, avm2Flag, doAbcTags: abcCount },
  verification: { compiled: true, validSwfLength: true, actionScript3: true, runtimeTest: 'See separate browser-test evidence; compilation alone does not prove the bridge runs.' },
};
writeFileSync(join(root, 'experiments/as3-probe/build-evidence.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.fixture, null, 2));
