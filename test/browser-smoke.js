const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserBridge, findBrowser } = require('../src/browser');

async function main() {
  const browser = new BrowserBridge();
  const fixture = `<!doctype html><html><body>
    <div id="words"><div class="word active"><letter>h</letter><letter>e</letter><letter>l</letter><letter>l</letter><letter>o</letter></div><div class="word"><letter>w</letter><letter>o</letter><letter>r</letter><letter>l</letter><letter>d</letter></div></div>
    <textarea id="wordsInput"></textarea><input id="password" type="password">
    <script>window.events=[]; const input=document.querySelector('#wordsInput');
    for(const type of ['keydown','keyup','input']) input.addEventListener(type,e=>events.push({type:e.type,key:e.key,trusted:e.isTrusted,value:input.value})); input.focus();</script></body></html>`;
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await browser.launch(findBrowser(), path.resolve('.test-output/browser-smoke-profile'), ['--headless=new', '--disable-gpu']);
    await browser.attach();
    await browser.call('Page.navigate', { url: origin }, browser.sessionId);
    for (let i = 0; i < 50; i++) {
      if (await browser.evaluate(`location.origin === ${JSON.stringify(origin)} && !!document.querySelector('#password')`)) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal((await browser.snapshot()).ready, false, 'Production adapter must refuse the local fixture');
    // Only this isolated fixture substitutes the expected origin. Production code is unchanged.
    const evaluate=browser.evaluate.bind(browser);
    browser.evaluate=(expression,awaitPromise)=>evaluate(expression.replaceAll('https://monkeytype.com',origin),awaitPromise);
    assert.equal((await browser.snapshot()).target, 'hello');
    for (const [key, code, keyCode] of [['h','KeyH',72], ['i','KeyI',73], ['Backspace','Backspace',8], ['e','KeyE',69]]) {
      await browser.sendKey({ type: 'keydown', key, code, keyCode, modifiers: 0 });
      await browser.sendKey({ type: 'keyup', key, code, keyCode, modifiers: 0 });
    }
    assert.equal(await browser.evaluate("document.querySelector('#wordsInput').value"), 'he');
    const events = await browser.evaluate('window.events');
    assert.equal(events.filter(e => e.type === 'keydown').length, 4);
    assert.equal(events.filter(e => e.type === 'keyup').length, 4);
    assert.ok(events.every(e => e.trusted));
    await browser.evaluate("document.querySelector('#password').focus()");
    await assert.rejects(browser.sendKey({ type: 'keydown', key: 'x', code: 'KeyX', keyCode: 88, modifiers: 0 }), /官网输入区/);
    assert.equal(await browser.evaluate("document.querySelector('#password').value"), '');
    fs.mkdirSync('.test-output', { recursive: true });
    fs.writeFileSync('.test-output/browser-smoke.json', JSON.stringify({ passed: true, input: 'he', keydown: 4, keyup: 4, focusProtection: true }, null, 2));
    console.log('PASS: browser pipe, input, key release, backspace, DOM read and password-focus protection.');
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
