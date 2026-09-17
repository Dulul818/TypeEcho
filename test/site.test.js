const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { decompressFromURI } = require('lz-ts');
const { settingsUrl, readAccountLevel } = require('../src/site');
const { suggestions } = require('../src/completions');
const { writeReport } = require('../src/result-report');
const { BrowserBridge } = require('../src/browser');

test('official shared settings encode dictionary and toggles, while rejecting unsupported values', () => {
  const settings = {mode:'words',amount:25,language:'english_5k',punctuation:true,numbers:false};
  const url = new URL(settingsUrl(settings));
  assert.equal(url.origin,'https://monkeytype.com');
  assert.deepEqual(JSON.parse(decompressFromURI(url.searchParams.get('testSettings'))),['words',25,null,true,false,'english_5k',null,null]);
  const quote = new URL(settingsUrl({...settings,mode:'quote',amount:'medium'}));
  assert.equal(JSON.parse(decompressFromURI(quote.searchParams.get('testSettings')))[1],null,'quote length must not become a quote ID');
  assert.throws(()=>settingsUrl({...settings,language:'<script>'}));
  assert.throws(()=>settingsUrl({...settings,amount:99999}));
});

test('completion hints prefer real provider output and fall back to file identifiers', () => {
  const source='session.status sessionStore sessionState';
  const items=suggestions(source,4,[{label:'sessionService',detail:'service',kind:5}]);
  assert.equal(items[0].label,'sessionService');
  assert.equal(items[0].origin,'VS Code');
  assert.ok(items.some(item=>item.label==='sessionStore'));
  assert.deepEqual(suggestions(source,1),[]);
});

test('local reports preserve metrics and receipt, escape HTML and update without prompts', async () => {
  const dir=path.resolve('.test-output/report-test');
  const record={id:'test-report',createdAt:'2026-09-16',metrics:{wpm:'25',accuracy:'95%',source:'<script>alert(1)</script>'},accountStatus:'waiting'};
  const files=await writeReport(dir,record);
  const html=await fs.readFile(files.html,'utf8');
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert'));
  record.receipt={saved:true,xp:12,text:'官网已保存，经验 +12'};
  record.png=Buffer.from('not an image').toString('base64');
  await writeReport(dir,record);
  assert.equal(JSON.parse(await fs.readFile(files.json,'utf8')).png,undefined);
  assert.ok(!(await fs.readFile(files.html,'utf8')).includes('<img src='));
  await assert.rejects(fs.access(path.join(dir,'test-report.png')));
  assert.equal(JSON.parse(await fs.readFile(files.json,'utf8')).receipt.xp,12);
  await assert.rejects(writeReport(dir,{...record,id:'../escape'}));
});

test('level is read only from the official account badge; result capture never requests a screenshot', async () => {
  const vm=require('node:vm');
  const document={querySelector:selector=>selector==='[data-nav-item="account"] [data-ui-element="userLevel"]' ? {textContent:'17'} : null};
  assert.equal(vm.runInNewContext(`(${readAccountLevel.toString()})()`,{document}),17);
  assert.equal(vm.runInNewContext(`(${readAccountLevel.toString()})()`,{document:{querySelector:()=>null}}),null);
  const bridge=new BrowserBridge();
  bridge.evaluate=async()=>({metrics:{wpm:'25'},level:17});
  bridge.call=()=>{throw new Error('no screenshot calls allowed')};
  assert.equal((await bridge.captureResult()).level,17);
});

test('delayed receipt retains its original round instead of acknowledging a new test', async () => {
  const bridge=new BrowserBridge();
  bridge.round=3;
  await bridge.onEvent({method:'Network.requestWillBeSent',params:{requestId:'one',request:{method:'POST',url:'https://api.monkeytype.com/results'}}});
  await bridge.onEvent({method:'Network.responseReceived',params:{requestId:'one',response:{status:200}}});
  bridge.round=4;
  bridge.call=async()=>({body:'{"data":{"insertedId":"id","xp":10}}'});
  let receipt;
  bridge.on('receipt',value=>{receipt=value});
  await bridge.onEvent({method:'Network.loadingFinished',params:{requestId:'one'}});
  assert.equal(receipt.round,3);
  assert.equal(bridge.latestReceipt,undefined);
});
