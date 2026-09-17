const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {referenceHtml,loadReferences}=require('../src/views/reference-panel');
const {baseVscode,uri}=require('./helpers');

async function main(){
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  if(!process.argv[2])throw new Error('Usage: node test/references-ui-smoke.js <settings.json>');
  const settings=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const rows=await loadReferences(settings['codeType.ttsReferenceLibrary']);
  let origin;
  const server=http.createServer((req,res)=>{
    if(req.url==='/'){
      let html=referenceHtml({cspSource:origin,asWebviewUri:file=>`${origin}/media/${path.basename(file.fsPath)}`},uri(process.cwd()),baseVscode());
      const nonce=html.match(/nonce-([^']+)/)[1];
      html=html.replace('</head>',`<script nonce="${nonce}">window.messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m)});</script></head>`);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);
    }else if(['/media/references.css','/media/references.js'].includes(req.url)){
      res.writeHead(200,{'Content-Type':req.url.endsWith('.css')?'text/css':'text/javascript'});res.end(fs.readFileSync(path.join(process.cwd(),req.url)));
    }else if(/^\/audio\/[0-2]$/.test(req.url)){
      res.writeHead(200,{'Content-Type':'audio/wav'});res.end(fs.readFileSync(rows[Number(req.url.at(-1))].audio));
    }else{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.waitForFunction(()=>window.messages.some(m=>m.type==='ready'));
    await page.evaluate(rows=>window.postMessage({type:'references',provider:'gpt-sovits',selected:0,rows}),rows.map((row,id)=>({...row,id,exists:true,url:`${origin}/audio/${id}`})));
    assert.equal(await page.locator('.reference').count(),3);
    await page.locator('audio').first().evaluate(audio=>audio.load());
    await page.waitForFunction(()=>document.querySelector('audio').duration>5);
    await page.locator('input[type=radio]').nth(1).check();
    assert.equal(await page.evaluate(()=>window.messages.at(-1).id),1);
    await page.locator('#generate').click();assert.equal(await page.evaluate(()=>window.messages.at(-1).type),'preview');
    await page.evaluate(()=>window.postMessage({type:'busy',value:true}));await page.waitForFunction(()=>document.getElementById('generate').disabled);
    await page.evaluate(()=>window.postMessage({type:'status',error:true,text:'模型尚未启动'}));await page.waitForFunction(()=>!document.getElementById('generate').disabled);
    fs.mkdirSync('.test-output/references',{recursive:true});
    for(const width of [1100,360]){
      await page.setViewportSize({width,height:900});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:`.test-output/references/panel-${width}.png`,fullPage:true});
    }
    assert.deepEqual(errors,[]);console.log('Reference panel: switching, subtitles, audio decoding, retry, desktop and mobile passed.');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
