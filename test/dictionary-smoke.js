const assert = require('node:assert/strict');
const path = require('node:path');
const { BrowserBridge, findBrowser } = require('../src/browser');
const { CATALOG, DictionaryStore } = require('../src/dictionaries');

async function main() {
  const store = new DictionaryStore(path.resolve('.test-output/dictionary-smoke-libraries'));
  const browser = new BrowserBridge();
  let imports = 0;
  const call = browser.call.bind(browser);
  browser.call = (method, ...args) => { if (method === 'DOM.setFileInputFiles') imports++; return call(method, ...args); };
  try {
    await browser.launch(findBrowser(), path.resolve('.test-output/dictionary-guest-profile'), ['--headless=new', '--disable-gpu', '--window-size=1440,1000']);
    await browser.attach();
    for (let i = 0; i < 40; i++) {
      const done = await browser.evaluate(`(() => {const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='reject non-essential');if(button){button.click();return true}return !!document.querySelector('#words .word.active') && !Array.from(document.querySelectorAll('.modal')).some(el=>el.getClientRects().length)})()`);
      if (done) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await browser.waitForTest();
    for (const item of CATALOG) {
      const library = await store.ensure(item.id);
      const file = await store.practiceFile(item.id);
      let afterImport;
      for (const order of ['repeat', 'shuffle', 'random']) {
      const size = item.kind === 'words' ? 20 : 3;
      const state = await browser.applyDictionary(file, { order, size });
      if (order === 'repeat') afterImport = imports;
      else assert.equal(imports, afterImport, 'changing native options does not import the dictionary again');
      assert.equal(state.ready, true);
      assert.equal(state.testMode, 'custom');
      const full = await browser.speechSnapshot();
      const custom = await browser.evaluate(`JSON.parse(localStorage.getItem('customTextSettings'))`);
      assert.equal(custom.pipeDelimiter, true);
      assert.equal(custom.mode, order);
      assert.deepEqual(custom.limit, { mode: 'section', value: size });
      assert.deepEqual(custom.text, library.entries.map(e => e.text), 'the entire dictionary is imported once through the website file handler');
      assert.equal(await browser.matchesDictionary(file), true);
      const words = full.speechWords.map(word => word.text);
      if (order === 'repeat') assert.deepEqual(words, library.entries.slice(0,size).map(e=>e.text).join(' ').split(' '));
      else {
        // Consume only whole source entries: catches accidental sentence word shuffling.
        const pool = library.entries.map(e=>e.text.split(' ')).sort((a,b)=>b.length-a.length);
        let cursor=0, sections=0;
        while(cursor<words.length) {
          const entry=pool.find(entry=>entry.every((word,i)=>words[cursor+i]===word));
          assert.ok(entry, 'generated words form intact source entries');
          cursor+=entry.length; sections++;
        }
        assert.equal(sections,size);
      }
      assert.equal(state.speechEnd, words.length);
      console.log(`${item.name}: ${order}, ${size} intact sections, ${words.length} words; full library ${custom.text.length}`);
      }
    }
    console.log('PASS: four libraries and three native generation modes, without typing or submitting results.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
