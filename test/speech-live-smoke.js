const assert=require('node:assert/strict');
const path=require('node:path');
const {BrowserBridge,findBrowser}=require('../src/browser');
const {SentenceContext}=require('../src/speech/sentence');
const {requestSpeech}=require('../src/speech/tts');

async function main(){
  const browser=new BrowserBridge();
  try {
    await browser.launch(findBrowser(),path.resolve('.test-output/speech-guest-profile'),['--headless=new','--disable-gpu']);
    await browser.attach();
    await browser.call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false},browser.sessionId);
    for(let i=0;i<30;i++){
      if((await browser.snapshot()).target)break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    await browser.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='reject non-essential')?.click()`);
    const settings={mode:'words',amount:10,language:'english',punctuation:false,numbers:false};
    let state=await browser.applySettings(settings);
    assert.equal(state.speechEnd,10,'finite word count is read from official test configuration');
    assert.equal(new SentenceContext().update(state).sentence.text.split(' ').length,10,'no punctuation still has a true test end');
    state=await browser.applySettings({...settings,mode:'quote',amount:'medium'});
    assert.ok(state.speechEnd>0,'quote has a finite end');
    const sentence=new SentenceContext().update(state).sentence;
    assert.ok(sentence?.text && sentence.start===0,'sentence is ready before any typing');
    console.log(JSON.stringify({officialWords:state.speechEnd,previewWords:state.preview.length,speechContext:state.speechWords.length,sentence,submitted:false}));
    const endpoint='http://127.0.0.1:17863/tts';
    const health=await fetch('http://127.0.0.1:17863/health').then(r=>r.json());
    assert.ok(health.providers.includes('CUDAExecutionProvider'));
    const audioSizes=[];
    for(const rate of [1,1,0.85]) {
      const start=performance.now();
      const result=await requestSpeech(endpoint,sentence.text,new AbortController().signal,{voice:'af_heart',rate});
      const audio=Buffer.from(result.audio,'base64');
      assert.equal(result.mime,'audio/wav');
      assert.equal(audio.toString('ascii',0,4),'RIFF');
      assert.equal(audio.toString('ascii',8,12),'WAVE');
      const data=audio.indexOf(Buffer.from('data'),12);
      assert.ok(data>=0 && audio.readUInt32LE(data+4)>1000);
      let peak=0;
      for(let i=data+8;i+1<audio.length;i+=2)peak=Math.max(peak,Math.abs(audio.readInt16LE(i)));
      assert.ok(peak>100,'synthesized WAV contains non-silent samples');
      audioSizes.push(audio.length);
      console.log(JSON.stringify({rate,ms:Math.round(performance.now()-start),bytes:audio.length,peak}));
    }
    const updated=await fetch('http://127.0.0.1:17863/health').then(r=>r.json());
    assert.ok(updated.cache.hits>health.cache.hits,'sentence cache is reused');
    assert.notEqual(audioSizes[0],audioSizes[2],'rate changes produce distinct audio rather than reuse the normal-speed cache');
    console.log('PASS: live guest text boundaries, full sentence before typing, Kokoro CUDA synthesis and audio cache. No test input or result submission.');
  } catch(error) {
    console.error(await browser.snapshot());
    console.error(await browser.evaluate('document.body.innerText.slice(0,2200)'));
    throw error;
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
