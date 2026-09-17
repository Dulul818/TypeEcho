const assert=require('node:assert/strict');
const {BrowserBridge}=require('../src/browser');
async function main(){
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const page=await browser.newPage();
    await page.route('https://monkeytype.com/',route=>route.fulfill({contentType:'text/html',body:'<div id="words"><div class="word active" data-wordindex="0">'+Array.from('hello',c=>`<letter>${c}</letter>`).join('')+'</div></div><input id="wordsInput"><script>document.querySelector("input").focus()</script>'}));
    await page.goto('https://monkeytype.com/');
    await page.bringToFront();
    await page.screenshot({path:'.test-output/input-fixture.png'});
    const cdp=await page.context().newCDPSession(page);
    const bridge=new BrowserBridge();
    bridge.call=(method,params)=>cdp.send(method,params);
    const times=[];
    for(let i=0;i<30;i++){
      const key=i%2 ? {key:'Backspace',code:'Backspace',keyCode:8} : {key:'h',code:'KeyH',keyCode:72};
      const start=performance.now();
      const state=await bridge.sendKey({...key,type:'keydown',modifiers:0});
      times.push(performance.now()-start);
      assert.equal(state.typed,i%2 ? '' : 'h');
      await bridge.sendKey({...key,type:'keyup',modifiers:0});
    }
    times.sort((a,b)=>a-b);
    console.log(JSON.stringify({samples:times.length,medianMs:+times[15].toFixed(1),p95Ms:+times[28].toFixed(1),source:'isolated browser fixture, actual CDP keyboard input'}));
    await page.evaluate(()=>{
      const input=document.getElementById('wordsInput'),words=document.getElementById('words');
      const second=words.firstElementChild.cloneNode(true);second.classList.remove('active');second.dataset.wordindex='1';words.append(second);
      window.transitionFrames=[];
      // Reproduce the website's intermediate state before the scheduled active-word render.
      let pendingFrame;
      window.requestAnimationFrame=callback=>{pendingFrame=callback;return 1;};
      window.cancelAnimationFrame=()=>{pendingFrame=undefined;};
      input.addEventListener('keydown',event=>{
        if(![' ','Backspace'].includes(event.key))return;
        event.preventDefault();input.value=event.key===' ' ? '' : 'hello';
        const index=event.key===' ' ? 1 : 0;
        setTimeout(()=>{
          for(const word of words.children)word.classList.toggle('active',Number(word.dataset.wordindex)===index);
          window.transitionFrames.push(index);
          const callback=pendingFrame;pendingFrame=undefined;callback?.();
        },12);
      });
    });
    for(let i=0;i<12;i++) {
      const key=i%2 ? {key:'Backspace',code:'Backspace',keyCode:8} : {key:' ',code:'Space',keyCode:32};
      const state=await bridge.sendKey({...key,type:'keydown',modifiers:0});
      assert.equal(state.wordIndex,i%2?0:1,'space/backspace never returns the previous active word');
      assert.equal(state.typed,i%2?'hello':'');
      await bridge.sendKey({...key,type:'keyup',modifiers:0});
    }
    await page.evaluate(()=>{window.requestAnimationFrame=()=>1;});
    assert.equal(await bridge.snapshot(true),null,'a stalled frame must not publish half-updated input');
    console.log('PASS: 12 delayed space/backspace transitions and bounded stalled-frame handling.');
    await page.evaluate(()=>{const input=document.createElement('input');input.type='password';document.body.append(input);input.focus();});
    await assert.rejects(bridge.sendKey({type:'keydown',key:'h',code:'KeyH',keyCode:72,modifiers:0}),/官网输入区/);
    assert.equal(await page.locator('input[type=password]').inputValue(),'');
    await page.evaluate(()=>{
      const words=document.getElementById('words'),input=document.getElementById('wordsInput');
      words.replaceChildren(...Array.from({length:240},(_,index)=>{
        const word=document.createElement('div');word.className='word'+(index===0?' active':'');word.dataset.wordindex=index;word.textContent='hello';return word;
      }));
      input.value='';input.focus();
      window.requestIdleCallback=callback=>{window.readRound=callback;};
    });
    let completed=false;
    const fullRead=bridge.speechSnapshot().then(state=>{completed=true;return state;});
    await page.waitForFunction(()=>typeof window.readRound==='function');
    const state=await bridge.sendKey({type:'keydown',key:'h',code:'KeyH',keyCode:72,modifiers:0});
    assert.equal(state.typed,'h');
    assert.equal(state.speechWords.length,97);
    assert.equal(completed,false,'keyboard input works while background text collection is waiting');
    await bridge.sendKey({type:'keyup',key:'h',code:'KeyH',keyCode:72,modifiers:0});
    await page.evaluate(()=>window.readRound());
    assert.equal((await fullRead).speechWords.length,240);
    console.log('PASS: real input proceeds independently of full-round text preparation.');
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
