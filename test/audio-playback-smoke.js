const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {loadExtension,baseVscode,uri}=require('./helpers');
const {requestSpeech,createSpeechCache}=require('../src/speech/tts');
async function main(){
  const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const {htmlFor}=loadExtension(baseVscode());
  let origin;
  const server=http.createServer((req,res)=>{
    if(req.url==='/'){
      let html=htmlFor({cspSource:origin,asWebviewUri:v=>origin+'/media/'+path.basename(v.fsPath)},uri(path.resolve(__dirname,'..')),'audio-test',{fileName:'sample.js',languageId:'javascript'});
      const nonce=html.match(/script-src 'nonce-([^']+)'/)[1];
      html=html.replace('</head>',`<script nonce="${nonce}">window.messages=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.messages.push(m)});const NativeAudio=Audio;window.instances=[];window.Audio=function(src){const audio=new NativeAudio(src);window.instances.push(audio);return audio;};</script></head>`);
      res.writeHead(200,{'Content-Type':'text/html'});res.end(html);
    } else if(['/media/practice.js','/media/practice.css','/media/word-feedback.js'].includes(req.url)){
      res.writeHead(200,{'Content-Type':req.url.endsWith('.css')?'text/css':'text/javascript'});res.end(fs.readFileSync(path.join(__dirname,'..',req.url)));
    } else {res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    let requests=0;
    const cache=createSpeechCache((...args)=>{requests++;return requestSpeech(...args);});
    const endpoint=process.env.TTS_SMOKE_ENDPOINT || 'http://127.0.0.1:17863/tts',options={voice:process.env.TTS_SMOKE_VOICE || 'af_heart',rate:1};
    cache.prepare(endpoint,['a'],options);
    const result=await cache.get(endpoint,'a',options);
    const started=performance.now();
    assert.deepEqual(await cache.get(endpoint,'a',options),result);
    const cachedMs=performance.now()-started;
    assert.equal(requests,1,'prepared real audio is reused by playback');
    cache.clear();
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin);await page.locator('#editor').click();
    await page.evaluate(()=>{
      window.postMessage({type:'preferences',speechEnabled:true,speechMode:'word',speechVolume:300});
      window.postMessage({type:'armed'});
      window.postMessage({type:'state',ready:true,target:'a',typed:'',wordIndex:0,testMode:'words',speechEpoch:1,preview:[{index:0,text:'a'}]});
    });
    await page.waitForFunction(()=>window.messages.some(m=>m.type==='speech'));
    const request=await page.evaluate(()=>window.messages.find(m=>m.type==='speech'));
    assert.equal(request.text,'a','no prefix is added to a short word');
    await page.evaluate(data=>window.postMessage(data),{type:'speech',id:request.id,...result});
    await page.waitForFunction(()=>document.querySelector('.prompt-word.speaking'));
    await page.waitForFunction(()=>window.instances.at(-1)?.ended);
    assert.equal(await page.locator('.prompt-word.speaking').count(),0,'real ended event clears the playback underline');
    assert.equal(await page.locator('#speech-status').textContent(),'');
    const gain=await page.evaluate(async encoded=>{
      const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
      const context=new AudioContext();const buffer=await context.decodeAudioData(bytes.buffer);await context.close();
      const peaks=[];
      for(const volume of [0,1,3]) {
        const offline=new OfflineAudioContext(1,buffer.length,buffer.sampleRate),source=offline.createBufferSource(),gain=offline.createGain();
        source.buffer=buffer;gain.gain.value=volume;source.connect(gain);gain.connect(offline.destination);source.start();
        const output=await offline.startRendering();let peak=0;for(const sample of output.getChannelData(0))peak=Math.max(peak,Math.abs(sample));peaks.push(peak);
      }
      return peaks;
    },result.audio);
    assert.equal(gain[0],0);assert.ok(gain[1]>0);assert.ok(Math.abs(gain[2]/gain[1]-3)<.001);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({voice:options.voice,shortWord:request.text,cachedMs,requests,realPlaybackEnded:true,peaks:gain,amplification:gain[2]/gain[1]}));
  } finally {await browser.close();server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
