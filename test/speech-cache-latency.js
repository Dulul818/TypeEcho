const assert=require('node:assert/strict');
const {requestSpeech,createSpeechCache}=require('../src/speech/tts');

async function main() {
  const endpoint='http://127.0.0.1:17864/tts',options={voice:'BG3N',rate:1};
  for(let attempt=0;attempt<45;attempt++) {
    try {
      const health=await fetch('http://127.0.0.1:17864/health',{signal:AbortSignal.timeout(1000)}).then(response=>response.json());
      assert.equal(health.cacheBypassesSynthesis,true);
      break;
    } catch(error) {
      if(attempt===44)throw error;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  await requestSpeech(endpoint,'the',new AbortController().signal,options);
  const long='A careful performance check compares cached speech with a new sentence while the local speech engine is busy generating this recording. Trial '+Date.now()+'.';
  let complete,fail;
  const completion=new Promise((resolve,reject)=>{complete=resolve;fail=reject;});
  let calls=0;
  const cache=createSpeechCache(async(...args)=>{
    calls++;
    try {const result=await requestSpeech(...args);if(args[1]===long)complete();return result;}
    catch(error){if(args[1]===long)fail(error);throw error;}
  });
  try {
    const start=performance.now();
    cache.prepare(endpoint,[long],options);
    await new Promise(resolve=>setTimeout(resolve,120));
    const foregroundStart=performance.now();
    await cache.get(endpoint,'the',options);
    const cachedMs=performance.now()-foregroundStart;
    await completion;
    const backgroundMs=performance.now()-start;
    assert.equal(calls,2,'one background request and one foreground request, no resubmission');
    assert.ok(cachedMs<1000 && cachedMs<backgroundMs/2,'cached word must return before background synthesis completes');
    console.log(JSON.stringify({cachedWordMs:Math.round(cachedMs),backgroundMs:Math.round(backgroundMs),requests:calls}));
  } finally {cache.clear();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
