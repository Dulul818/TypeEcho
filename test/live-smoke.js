const fs = require('node:fs');
const path = require('node:path');
const { BrowserBridge, findBrowser } = require('../src/browser');

async function main() {
  const browser = new BrowserBridge();
  try {
    await browser.launch(findBrowser(), path.resolve('.test-output/live-guest-profile'), ['--headless=new', '--disable-gpu']);
    await browser.attach();
    let snapshot;
    for (let i = 0; i < 50; i++) {
      snapshot = await browser.snapshot();
      if (snapshot.target || snapshot.finished) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const evidence = await browser.evaluate(`({url:location.href,title:document.title,input:!!document.querySelector('#wordsInput'),words:!!document.querySelector('#words'),active:!!document.querySelector('#words .word.active'),text:document.body.innerText.slice(0,1800)})`);
    fs.mkdirSync('.test-output', { recursive: true });
    fs.writeFileSync('.test-output/live-guest.json', JSON.stringify({ snapshot, evidence, submitted: false }, null, 2));
    console.log(JSON.stringify({ snapshot, evidence, submitted: false }, null, 2));
    if (!evidence.input) throw new Error('Official input is not yet accessible; see guest-page evidence.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
