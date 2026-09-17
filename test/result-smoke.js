const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { BrowserBridge, findBrowser } = require('../src/browser');

async function main() {
  const html=`<!doctype html><html><style>body{background:#323437;color:#e2b714;font:24px monospace}.wrapper{width:1000px;margin:50px}.stats{display:flex;gap:30px}.group{padding:12px}.top{color:#999;font-size:15px}.chart{height:180px;background:linear-gradient(150deg,#323437,#414346)}#words{display:none}.buttons{margin-top:20px}</style>
  <div id="result"><div class="wrapper"><div class="stats"><div class="group wpm"><div class="top">wpm</div><div class="bottom">25</div></div><div class="group acc"><div class="top">acc</div><div class="bottom">95%</div></div></div><div class="chart"><canvas></canvas></div><div class="stats"><div class="group raw"><div class="top">raw</div><div class="bottom">26</div></div><div class="group key"><div class="top">characters</div><div class="bottom">149/2/1/0</div></div><div class="group consistency"><div class="top">consistency</div><div class="bottom">13%</div></div><div class="group time"><div class="top">time</div><div class="bottom"><div class="text">01:12</div></div></div><div class="group testType"><div class="bottom">quote medium english</div></div></div><div class="buttons"><button id="nextTestButton">Next test</button><button id="restartTestButtonWithSameWordset">Repeat test</button></div></div></div>
  <div id="words"><div class="word active"><letter>hello</letter></div><div class="word"><letter>world</letter></div></div><textarea id="wordsInput"></textarea>
  <script>window.nextCount=0;window.repeatCount=0;const start=repeat=>{window[repeat?'repeatCount':'nextCount']++;document.querySelector('#result').style.display='none';document.querySelector('#words').style.display='block';document.querySelector('letter').textContent=repeat?'hello':'other';document.querySelector('#wordsInput').focus()};document.querySelector('#nextTestButton').onclick=()=>start(false);document.querySelector('#restartTestButtonWithSameWordset').onclick=()=>start(true);</script></html>`;
  const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html)});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const browser=new BrowserBridge();
  try {
    await browser.launch(findBrowser(),path.resolve('.test-output/result-profile'),['--headless=new','--window-size=1440,1000']);
    await browser.attach();
    await browser.call('Page.navigate',{url:origin},browser.sessionId);
    for(let i=0;i<50;i++){if(await browser.evaluate(`location.origin===${JSON.stringify(origin)} && typeof nextCount==='number'`))break;await new Promise(r=>setTimeout(r,100))}
    assert.equal(await browser.captureResult(),null,'production result reader refuses an unrelated site');
    const evaluate=browser.evaluate.bind(browser);
    browser.evaluate=expression=>evaluate(expression.replaceAll('https://monkeytype.com',origin));
    const result=await browser.captureResult();
    assert.equal(result.metrics.wpm,'25');assert.equal(result.metrics.time,'01:12');
    assert.equal(result.png,undefined);
    await browser.evaluate(`document.body.insertAdjacentHTML('afterbegin','<a data-nav-item="account"><span data-ui-element="userLevel">17</span></a>')`);
    assert.equal((await browser.captureResult()).level,17);
    const next=await browser.nextTest(false);
    assert.equal(next.target,'other');assert.equal(browser.round,1);
    await assert.rejects(browser.nextTest(false),/尚未结束/);
    await browser.evaluate(`document.querySelector('#result').style.display='block';document.querySelector('#words').style.display='none'`);
    const repeat=await browser.nextTest(true);
    assert.equal(repeat.target,'hello');assert.equal(browser.round,2);
    assert.deepEqual(await browser.evaluate('({nextCount,repeatCount})'),{nextCount:1,repeatCount:1});
    console.log('PASS: result metrics and account level without PNG, Next/Repeat buttons, focus restoration and active-test guard.');
  } finally {await browser.close();server.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
