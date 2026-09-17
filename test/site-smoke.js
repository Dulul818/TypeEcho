const assert = require('node:assert/strict');
const path = require('node:path');
const { BrowserBridge, findBrowser } = require('../src/browser');

async function main() {
  const browser = new BrowserBridge();
  try {
    await browser.launch(findBrowser(), path.resolve('.test-output/settings-guest-profile'), ['--headless=new', '--disable-gpu', '--window-size=1440,1000']);
    await browser.attach();
    for(let i=0;i<40;i++) {
      const done=await browser.evaluate(`(() => {const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='reject non-essential');if(button){button.click();return true}return !!document.querySelector('#words .word.active') && !Array.from(document.querySelectorAll('.modal')).some(el=>el.getClientRects().length)})()`);
      if(done) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    for (const settings of [
      { mode: 'time', amount: 15, language: 'english_1k', punctuation: true, numbers: false },
      { mode: 'words', amount: 25, language: 'english', punctuation: false, numbers: true },
      { mode: 'quote', amount: 'short', language: 'english', punctuation: false, numbers: false },
    ]) {
      const state = await browser.applySettings(settings);
      assert.equal(state.ready, true);
      const active = await browser.evaluate(`Array.from(document.querySelectorAll('[data-ui-element="testConfig"] button')).filter(b=>b.getClientRects().length && b.className.includes('[--themable-button-text:var(--themable-button-active)]')).map(b=>b.textContent.trim())`);
      assert.ok(active.includes(settings.mode));
      assert.ok(active.includes(String(settings.amount)));
      if(settings.mode!=='quote') {
        assert.equal(active.includes('punctuation'),settings.punctuation);
        assert.equal(active.includes('numbers'),settings.numbers);
      }
      console.log(JSON.stringify({ settings, target: state.target, active }));
    }
    console.log('PASS: guest website settings accepted without typing or submitting any result.');
  } catch (error) {
    console.log(await browser.evaluate('({url:location.href,text:document.body.innerText.slice(0,3500),focus:document.activeElement?.outerHTML.slice(0,300)})').catch(()=>null));
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
