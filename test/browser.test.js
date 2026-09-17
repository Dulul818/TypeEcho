const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserBridge, keyParams, resultReceipt, isResultRequest, SNAPSHOT, INPUT_GUARD, findBrowser } = require('../src/browser');

const key = (overrides = {}) => ({ type: 'keydown', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 0, repeat: false, ...overrides });

test('auto-detection picks per-user Chrome ahead of Edge and never silently falls back', { skip: process.platform !== 'win32' }, t => {
  const chrome = path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe');
  const edge = path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe');
  const exists = t.mock.method(fs, 'existsSync', candidate => candidate === chrome || candidate === edge);
  assert.equal(findBrowser(), chrome);
  exists.mock.mockImplementation(candidate => candidate === edge);
  assert.throws(() => findBrowser(), /Google Chrome/);
  assert.equal(findBrowser(edge), edge, 'an explicit path still overrides auto-detection');
});

test('preserves physical key identity, release and modifiers; blocks shortcuts/composition', () => {
  assert.deepEqual(keyParams(key()), { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, autoRepeat: false, text: 'a' });
  const release = keyParams(key({ type: 'keyup', key: 'A', modifiers: 8 }));
  assert.equal(release.type, 'keyUp');
  assert.equal(release.modifiers, 8);
  assert.equal(release.text, undefined);
  assert.equal(keyParams(key({ key: 'Backspace', code: 'Backspace', keyCode: 8 })).type, 'rawKeyDown');
  for (const event of [key({ modifiers: 2 }), key({ key: '中' }), key({ key: 'Process', keyCode: 229 }), key({ type: 'paste' }), key({ keyCode: 900 }), key({ code: 'Enter', key: 'Enter', keyCode: 13 })]) {
    assert.throws(() => keyParams(event));
  }
});

test('saved status requires an official result response with an ID and XP', () => {
  assert.equal(resultReceipt(200, '{"data":{"insertedId":"abc","xp":42}}').saved, true);
  assert.equal(resultReceipt(200, '{"data":{"insertedId":"abc","xp":0}}').xp, 0);
  assert.equal(resultReceipt(465, '{"message":"Bot detected"}').saved, false);
  assert.equal(resultReceipt(200, '{"message":"Result saved"}').saved, false);
  assert.equal(resultReceipt(200, '<html>Login</html>').saved, false);
  assert.equal(isResultRequest({ method: 'POST', url: 'https://api.monkeytype.com/results' }), true);
  for (const url of ['https://api.monkeytype.com.evil.test/results', 'http://api.monkeytype.com/results', 'https://api.monkeytype.com/users', 'broken']) {
    assert.equal(isResultRequest({ method: 'POST', url }), false);
  }
  assert.equal(isResultRequest({ method: 'GET', url: 'https://api.monkeytype.com/results' }), false);
});

test('DOM adapter refuses other origins, login focus and completed tests', async () => {
  const visible = { getClientRects: () => [1] };
  const input = { value: ' he' };
  const next = { textContent: 'world', querySelectorAll: () => [], getAttribute: () => '31' };
  const active = { textContent: 'hello', nextElementSibling: next, querySelectorAll: () => [], getAttribute: () => '30' };
  const words = { ...visible, querySelector: () => active, querySelectorAll: () => [active, next] };
  const nodes = { '#words': words, '#wordsInput': input };
  const document = { querySelector: s => nodes[s], activeElement: input };
  const location = { origin: 'https://monkeytype.com', pathname: '/' };
  const context = { document, location, getComputedStyle: () => ({ visibility: 'visible' }) };
  const snapshot = () => vm.runInNewContext(SNAPSHOT, context);
  assert.equal(snapshot().ready, true);
  const guard=()=>vm.runInNewContext(INPUT_GUARD,context);
  assert.equal(guard().ready,true);
  assert.equal(guard().preview,undefined,'input guard does not build the word preview');
  assert.equal(snapshot().target, 'hello');
  assert.equal(snapshot().typed, 'he');
  assert.equal(snapshot().wordIndex, 30, 'preserves absolute index after the website removes previous rows');
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot().preview)), [{index:30,text:'hello'},{index:31,text:'world'}]);
  const previous={textContent:'word!',getAttribute:()=> '29',querySelectorAll:()=>[
    ...Array.from('word!',(textContent,i)=>({textContent,classList:{contains:name=>name==='correct' && i<3}})),
    {textContent:'x',classList:{contains:name=>name==='extra' || name==='incorrect'}}
  ]};
  words.querySelectorAll=()=>[previous,active,next];
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot().preview[0])),{index:29,text:'word!',feedback:{complete:true,errors:[3,4],extra:1}});
  const button=(label,selected)=>({textContent:label,getAttribute:()=>null,classList:{contains:name=>selected && name==='[--themable-button-text:var(--themable-button-active)]'}});
  const wordMode=button('words',true),timeAmount=button('30',true),wordAmount=button('10',true),otherAmount=button('25',false);
  timeAmount.parentElement={querySelectorAll:()=>[timeAmount]};
  wordAmount.parentElement={querySelectorAll:()=>[wordAmount,otherAmount]};
  nodes['[data-ui-element="testConfig"]']={querySelectorAll:()=>[wordMode,timeAmount,wordAmount,otherAmount]};
  assert.equal(snapshot().speechEnd,10,'hidden time settings cannot be mistaken for a word count');
  assert.equal(snapshot().testMode,'words');
  const all=Array.from({length:240},(_,i)=>({textContent:`word${i}`,querySelectorAll:()=>[],getAttribute:()=>String(i)}));
  words.querySelectorAll=()=>all;
  words.querySelector=()=>all[0];
  assert.equal(snapshot().preview.length,36);
  assert.equal(snapshot().speechWords.length,97,'round start reads only the current word and 96 upcoming words');
  const background=new BrowserBridge();
  background.evaluate=expression=>vm.runInNewContext(expression,{...context,setTimeout});
  const full=await background.speechSnapshot();
  assert.equal(full.speechWords.length,240,'background scan reads the complete available round');
  assert.equal(full.speechRevision,snapshot().speechRevision);
  input.value='h';
  assert.equal(full.speechRevision,snapshot().speechRevision,'typing does not invalidate the round inventory');
  words.querySelector=()=>all[120];
  assert.equal(snapshot().speechWords.length,193,'speech context is bounded to 96 previous and 96 upcoming words');
  assert.equal(snapshot().speechWords[0].index,24);
  assert.equal(snapshot().speechWords.at(-1).index,216);
  for(const word of all) word.getAttribute=()=>null;
  assert.deepEqual(Array.from(snapshot().preview,word=>word.index),Array.from({length:60},(_,i)=>i+96),'preview fallback indexes remain absolute when DOM indexes are absent');
  for(const [i,word] of all.entries()) word.getAttribute=()=>String(i);
  words.querySelector=()=>all[0];
  const firstIdentity=snapshot().testId;
  all[0]={...all[0]};
  assert.notEqual(snapshot().testId,firstIdentity,'restarting identical text gets a new identity');
  nodes['[data-ui-element="testConfig"]']={querySelectorAll:()=>[button('time',true)]};
  assert.equal(snapshot().speechEnd,null,'timed DOM tail is not a test ending');
  assert.equal(snapshot().testMode,'time');
  words.querySelector=()=>active;
  words.querySelectorAll=()=>[previous,active,next];
  document.activeElement = { type: 'password' };
  assert.equal(guard().ready,false,'lightweight guard still rejects login focus');
  assert.equal(snapshot().ready, false);
  document.activeElement = input;
  document.visibilityState = 'hidden';
  assert.equal(guard().ready,false);
  assert.equal(snapshot().ready, false);
  assert.equal(snapshot().backgroundSuspended, true);
  document.visibilityState = 'visible';
  location.origin = 'https://evil.test';
  assert.equal(guard().ready,false);
  assert.equal(snapshot().ready, false);
  location.origin = 'https://monkeytype.com';
  location.pathname = '/account';
  assert.equal(snapshot().ready, false);
  location.pathname = '/';
  nodes['#result'] = visible;
  assert.equal(guard().ready,false);
  assert.equal(snapshot().finished, true);
});

test('key forwarding checks focus, then returns immediate official feedback only for keydown',async()=>{
  const bridge=new BrowserBridge();
  const calls=[];
  bridge.evaluate=async expression=>{assert.equal(expression,INPUT_GUARD);calls.push('guard');return {ready:true};};
  bridge.call=async method=>calls.push(method);
  bridge.snapshot=async afterPaint=>{calls.push(afterPaint?'settled-snapshot':'snapshot');return {ready:true,typed:'a'};};
  assert.equal((await bridge.sendKey(key())).typed,'a');
  assert.deepEqual(calls,['guard','Input.dispatchKeyEvent','snapshot']);
  calls.length=0;
  await bridge.sendKey(key({type:'keyup'}));
  assert.deepEqual(calls,['guard','Input.dispatchKeyEvent']);
  for(const event of [key({key:' ',code:'Space',keyCode:32}),key({key:'Backspace',code:'Backspace',keyCode:8})]) {
    calls.length=0;
    await bridge.sendKey(event);
    assert.deepEqual(calls,['guard','Input.dispatchKeyEvent','settled-snapshot'],'word transitions wait for the official active-word update');
  }
  bridge.evaluate=async()=>({ready:false,reason:'lost focus'});
  calls.length=0;
  await assert.rejects(bridge.sendKey(key()),/lost focus/);
  assert.deepEqual(calls,[],'invalid focus never forwards input');
});
