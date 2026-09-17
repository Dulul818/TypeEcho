const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { BrowserBridge, findBrowser } = require('../src/browser');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const fixture = `<!doctype html><html><head><title>Code Type 后台换词测试</title></head><body>
    <div id="words"><div class="word active"><letter>hello</letter></div><div class="word"><letter>world</letter></div></div>
    <textarea id="wordsInput"></textarea>
    <script>const input=document.querySelector('#wordsInput'); window.transitions=0; window.frames=0;
    const frame=()=>{window.frames++;requestAnimationFrame(frame)};requestAnimationFrame(frame);
    input.addEventListener('input',()=>{if(input.value.endsWith(' ')){input.value=' ';window.transitions++;
      requestAnimationFrame(()=>{document.querySelector('.active').classList.remove('active');document.querySelectorAll('.word')[window.transitions%2].classList.add('active')})}});input.focus();</script>
    </body></html>`;
  const server = http.createServer((req,res) => { res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' }); res.end(req.url === '/cover' ? '<title>Code Type 验证中</title><body style="background:#222;color:#ddd">正在验证后台换词，完成后此窗口会自动关闭。</body>' : fixture); });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = new BrowserBridge();
  const evidence=[];
  try {
    await browser.launch(findBrowser(), path.resolve('.test-output/background-profile'));
    await browser.attach();
    await browser.call('Page.navigate',{url:origin},browser.sessionId);
    for(let i=0;i<50;i++) { if(await browser.evaluate(`location.origin === ${JSON.stringify(origin)} && typeof window.transitions === 'number'`)) break; await delay(100); }
    const evaluate=browser.evaluate.bind(browser);
    browser.evaluate=(expression,awaitPromise)=>evaluate(expression.replaceAll('https://monkeytype.com',origin),awaitPromise);
    const {windowId}=await browser.call('Browser.getWindowForTarget',{targetId:browser.targetId});
    await browser.call('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
    await browser.call('Browser.setWindowBounds',{windowId,bounds:{left:150,top:150,width:700,height:500}});
    await browser.call('Page.bringToFront',{},browser.sessionId);
    await delay(500);
    const {targetId:cover}=await browser.call('Target.createTarget',{url:origin+'/cover',newWindow:true,width:1000,height:800});
    const {windowId:coverWindow}=await browser.call('Browser.getWindowForTarget',{targetId:cover});
    await browser.call('Browser.setWindowBounds',{windowId:coverWindow,bounds:{left:50,top:50,width:1000,height:800}});
    await browser.call('Target.activateTarget',{targetId:cover});
    async function transition(label) {
      await delay(1800);
      const before=await browser.evaluate('({frames,transitions,visibility:document.visibilityState,focus:document.hasFocus(),value:input.value})');
      assert.equal(before.visibility,'visible',`${label}: animation frames must remain active behind another window`);
      const word=(await browser.snapshot()).target;
      for (const key of word+' ') {
        const event={key,code:key===' '?'Space':'Key'+key.toUpperCase(),keyCode:key===' '?32:key.toUpperCase().charCodeAt(0),modifiers:0};
        await browser.sendKey({...event,type:'keydown'});
        await browser.sendKey({...event,type:'keyup'});
      }
      await delay(350);
      const after=await browser.evaluate('({frames,visibility:document.visibilityState,transitions,value:input.value})');
      const state=await browser.snapshot();
      evidence.push({label,before,after,target:state.target,expected:(before.transitions+1)%2?'world':'hello'});
      assert.equal(after.transitions,before.transitions+1,`${label}: input must reach the background page`);
      assert.equal(state.target,(before.transitions+1)%2?'world':'hello',`${label}: word must advance without bringing the browser forward`);
      assert.ok(after.frames>before.frames,`${label}: renderer must keep refreshing`);
    }
    await transition('covered-word-1');
    await transition('covered-word-2');
    await transition('covered-word-3');
    await browser.call('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
    await delay(500);
    assert.equal((await browser.snapshot()).backgroundSuspended,true);
    const inputBefore=await browser.evaluate('input.value');
    await assert.rejects(browser.sendKey({type:'keydown',key:'x',code:'KeyX',keyCode:88,modifiers:0}),/最小化/);
    assert.equal(await browser.evaluate('input.value'),inputBefore,'do not send blind input when rendering is suspended');
    await browser.call('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
    await browser.call('Target.activateTarget',{targetId:cover});
    await transition('restored-and-covered');
    fs.mkdirSync('.test-output',{recursive:true});
    fs.writeFileSync('.test-output/background-fixed.json',JSON.stringify(evidence,null,2));
    console.log('PASS: three consecutive words behind an opaque window; minimized input blocked; restored background typing works.');
  } finally { await browser.close();server.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1});
