const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {requestSpeech,createSpeechCache}=require('../src/speech/tts');

test('TTS sends only the target word and language, validates audio, and supports cancellation',async()=>{
  let received;
  const server=http.createServer(async(req,res)=>{
    let body=''; for await(const part of req)body+=part;
    received=JSON.parse(body);
    res.writeHead(200,{'Content-Type':req.url==='/bad'?'text/html':'audio/wav'});
    res.end('fixture audio');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  try {
    const speech=await requestSpeech(endpoint,'hello',new AbortController().signal);
    assert.deepEqual(received,{text:'hello',language:'en-US'});
    assert.equal(speech.mime,'audio/wav');
    assert.equal(Buffer.from(speech.audio,'base64').toString(),'fixture audio');
    await requestSpeech(endpoint,'hello',new AbortController().signal,{voice:'en-US-JennyNeural',rate:0.85});
    assert.deepEqual(received,{text:'hello',language:'en-US',voice:'en-US-JennyNeural',rate:0.85});
    const sentence='This is a longer sentence about programming and careful testing. '.repeat(5).trim();
    await requestSpeech(endpoint,sentence,new AbortController().signal,{voice:'af_heart',rate:1});
    assert.equal(received.text,sentence);
    await assert.rejects(requestSpeech(endpoint,'x'.repeat(1201),new AbortController().signal),/1200/);
    await assert.rejects(requestSpeech(endpoint+'/bad','hello',new AbortController().signal),/audio/);
    const canceled=new AbortController(); canceled.abort();
    await assert.rejects(requestSpeech(endpoint,'hello',canceled.signal));
    await assert.rejects(requestSpeech('file:///tmp/test','hello',new AbortController().signal));
  } finally { await new Promise(resolve=>server.close(resolve)); }
});

test('GPT-SoVITS uses the official fixed-reference API and exposes model errors',async()=>{
  const received=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    received.push(JSON.parse(body));
    if(req.url==='/failure') {res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({message:'tts failed',Exception:'reference audio missing'}));return;}
    res.writeHead(200,{'Content-Type':'audio/wav'});res.end('fixture audio');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  const options={provider:'gpt-sovits',voice:'old-XTTS-voice',rate:0.85,referenceAudio:'D:/Models/voice.wav',referenceText:'This is the reference.',referenceLanguage:'en'};
  try {
    const signal=new AbortController().signal;
    await requestSpeech(endpoint,'the',signal,options);
    assert.deepEqual(received[0],{text:'the',text_lang:'en',ref_audio_path:options.referenceAudio,prompt_text:options.referenceText,
      prompt_lang:'en',speed_factor:0.85,text_split_method:'cut0',batch_size:1,parallel_infer:true,seed:1234,
      fragment_interval:0.03,
      top_k:15,top_p:1,temperature:1,repetition_penalty:1.35,media_type:'wav',streaming_mode:false});
    await requestSpeech(endpoint,'We can begin today.',signal,options);
    assert.equal(received[1].text,'We can begin today.','the plugin never prefixes or modifies practice text');
    assert.equal(received[1].ref_audio_path,received[0].ref_audio_path,'the same reference is reused');
    assert.equal(received[1].fragment_interval,0.3,'sentence spacing is preserved');
    await requestSpeech(endpoint," don't ",signal,options);
    assert.equal(received[2].fragment_interval,0.03,'surrounding whitespace does not turn a word into a sentence');
    const count=received.length;
    await assert.rejects(requestSpeech(endpoint,'the',signal,{...options,referenceText:''}),/参考音频路径和对应文本/);
    assert.equal(received.length,count,'incomplete reference configuration never reaches a model');
    await assert.rejects(requestSpeech(endpoint+'/failure','the',signal,options),/GPT-SoVITS HTTP 400.*reference audio missing/);
  } finally {await new Promise(resolve=>server.close(resolve));}
});

test('GPT-SoVITS serializes synthesis and invalidates cached audio when its reference changes',async()=>{
  const calls=[],tick=()=>new Promise(resolve=>setImmediate(resolve));
  const clip={mime:'audio/wav',audio:'YQ=='};
  let deferred=true;
  const cache=createSpeechCache((endpoint,text,signal,options)=>{
    if(!deferred){calls.push({text,options});return Promise.resolve(clip);}
    return new Promise(resolve=>calls.push({text,options,resolve}));
  });
  const options={provider:'gpt-sovits',voice:'',rate:1,referenceAudio:'voice.wav',referenceText:'Reference text.',referenceLanguage:'en'};
  try {
    cache.prepare('http://local',['Background sentence.','Later sentence.'],options);
    await tick();
    const foreground=cache.get('http://local','the',options);
    await tick();assert.equal(calls.length,1,'no concurrent request is sent to the shared official pipeline');
    calls[0].resolve(clip);await tick();
    assert.equal(calls[1].text,'the','foreground runs before the next background sentence');
    calls[1].resolve(clip);await foreground;await tick();
    assert.equal(calls[2].text,'Later sentence.');
    const count=calls.length;
    await cache.get('http://local','the',options);
    assert.equal(calls.length,count,'client cache remains immediate while the model is busy');
    calls[2].resolve(clip);await tick();deferred=false;
    for(const changed of [{referenceAudio:'new.wav'},{referenceText:'Corrected transcript.'},{referenceLanguage:'zh'},{provider:'custom'}]) {
      const before=calls.length;
      await cache.get('http://local','the',{...options,...changed});
      assert.equal(calls.length,before+1,'reference and provider settings are part of the cache key');
    }
  } finally {cache.clear();}
});

test('lookahead reuses synthesis, prioritizes playback, isolates voice/rate and cancels old rounds',async()=>{
  const calls=[];
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  const clip={mime:'audio/wav',audio:Buffer.from('audio').toString('base64')};
  const cache=createSpeechCache((endpoint,text,signal,options)=>new Promise((resolve,reject)=>{
    calls.push({endpoint,text,signal,options,resolve,reject});
  }));
  const options={voice:'af_heart',rate:1}, endpoint='http://localhost/tts';
  try {
    cache.prepare(endpoint,['current','next','later'],options);
    await tick();
    assert.equal(calls.length,1);
    const current=cache.get(endpoint,'current',options);
    calls[0].resolve(clip);
    assert.deepEqual(await current,clip);
    await tick();
    assert.equal(calls[1].text,'next');
    assert.deepEqual(await cache.get(endpoint,'current',options),clip,'cached playback starts without another request');
    const later=cache.get(endpoint,'later',options);
    await tick();
    assert.equal(calls[1].signal.aborted,false,'active GPU work is not canceled and resubmitted');
    assert.equal(calls.length,3,'one foreground request can reuse server cache while background work runs');
    assert.equal(calls[2].text,'later');
    const duplicate=cache.get(endpoint,'later',options);
    cache.prepare(endpoint,['fresh'],options);
    assert.equal(calls[2].signal.aborted,false,'lookahead updates preserve requested playback');
    calls[2].resolve(clip);
    assert.deepEqual(await later,clip);
    assert.deepEqual(await duplicate,clip);
    await tick();
    assert.equal(calls.length,3,'new lookahead waits for existing background work');
    calls[1].resolve(clip);await tick();
    const voice=cache.get(endpoint,'current',{...options,voice:'af_bella'});
    await tick();
    const fresh=calls.find(call=>call.text==='fresh');
    assert.ok(fresh);
    fresh.resolve(clip);await tick();
    assert.equal(calls.at(-1).options.voice,'af_bella');
    calls.at(-1).resolve(clip);await voice;await tick();
    const rate=cache.get(endpoint,'current',{...options,rate:0.85});
    await tick();
    assert.equal(calls.at(-1).options.rate,0.85);
    cache.clear();
    assert.equal(calls.at(-1).signal.aborted,false,'clearing consumers keeps the occupied synthesis slot');
    await assert.rejects(rate,/取消/);
    const restarted=cache.get(endpoint,'current',options);
    const countBeforeRestart=calls.length;
    await tick();assert.equal(calls.length,countBeforeRestart,'new round waits for old GPU work instead of stacking requests');
    calls.at(-1).resolve(clip);await tick();
    await tick();calls.at(-1).resolve(clip);await restarted;
    assert.equal(calls.filter(call=>call.text==='current' && call.options===options).length,2,'new round does not reuse cleared audio');
  } finally {cache.clear();}
});

test('canceled playback preserves reusable synthesis, failures retry and the word cache is bounded',async()=>{
  const calls=[], tick=()=>new Promise(resolve=>setImmediate(resolve));
  const options={voice:'test',rate:1}, clip={mime:'audio/wav',audio:'YQ=='};
  let deferred=true, fail=false,resolveOld;
  const cache=createSpeechCache((endpoint,text,signal)=>{
    calls.push({text,signal});
    if (fail) return Promise.reject(new Error('offline'));
    return deferred ? new Promise(resolve=>resolveOld=resolve) : Promise.resolve(clip);
  });
  try {
    const controller=new AbortController();
    const old=cache.get('http://local','old',options,controller.signal);
    await tick();controller.abort();
    deferred=false;
    const next=cache.get('http://local','new',options);
    await tick();assert.equal(calls.length,2,'canceled consumer leaves only one background and one foreground request');
    resolveOld(clip);assert.deepEqual(await old,clip);
    assert.deepEqual(await next,clip);
    assert.equal(calls[0].signal.aborted,false);
    fail=true;
    await assert.rejects(cache.get('http://local','retry',options),/offline/);
    fail=false;
    await cache.get('http://local','retry',options);
    for(let i=0;i<130;i++) await cache.get('http://local',String(i),options);
    const count=calls.length;
    await cache.get('http://local','129',options);
    assert.equal(calls.length,count);
    await cache.get('http://local','0',options);
    assert.equal(calls.length,count+1,'oldest clips are evicted');
  } finally {cache.clear();}
});

test('sentence audio shares the bounded cache and pause preserves completed nearby audio',async()=>{
  let calls=0;
  const cache=createSpeechCache(async()=>{calls++;return {mime:'audio/wav',audio:'YQ=='};});
  const endpoint='http://local',options={voice:'test',rate:1};
  const sentences=Array.from({length:140},(_,index)=>`Sentence number ${index}.`);
  for(let index=0;index<sentences.length;index++) {
    cache.prepare(endpoint,sentences.slice(index,index+3),options);
    await new Promise(resolve=>setImmediate(resolve));
    await cache.get(endpoint,sentences[index],options);
  }
  assert.equal(calls,sentences.length,'moving lookahead prepares each sentence once');
  const before=calls;
  await cache.get(endpoint,sentences.at(-1),options);
  assert.equal(calls,before,'nearby sentence audio is reused');
  cache.cancelPending();
  await cache.get(endpoint,sentences.at(-1),options);
  assert.equal(calls,before,'pause preserves already prepared sentence audio');
  await cache.get(endpoint,sentences[0],options);
  assert.equal(calls,before+1,'old sentences are evicted instead of pinned for the entire round');
  cache.clear();
  await cache.get(endpoint,sentences.at(-1),options);
  assert.equal(calls,before+2,'round reset releases cached sentence audio');
  cache.clear();
});

test('round sentences are retained and progress reports completion, failure, pause and clearing',async()=>{
  let calls=0;
  const progress=[],tick=()=>new Promise(resolve=>setImmediate(resolve));
  const cache=createSpeechCache(async(endpoint,text)=>{
    calls++;
    if(text==='Failed sentence.')throw new Error('model offline');
    return {mime:'audio/wav',audio:'YQ=='};
  },value=>progress.push(value));
  const options={voice:'test',rate:1},endpoint='http://local';
  const sentences=Array.from({length:60},(_,i)=>`Sentence ${i}.`);
  cache.prepare(endpoint,sentences,options,sentences);
  await tick();await tick();
  assert.equal(progress.at(-1).ready,60);
  assert.equal(progress.at(-1).total,60);
  for(let i=0;i<60;i++)await cache.get(endpoint,'word'+i,options);
  const before=calls;
  for(const text of sentences)await cache.get(endpoint,text,options);
  assert.equal(calls,before,'all round sentences survive word cache eviction');
  cache.prepare(endpoint,[...sentences,'Failed sentence.'],options,[...sentences,'Failed sentence.']);
  await tick();await tick();
  assert.equal(progress.at(-1).failed,1);
  assert.equal(progress.at(-1).error,'model offline');
  cache.retryFailed();await tick();
  assert.equal(progress.at(-1).failed,0,'retry clears failed entries without losing completed audio');
  cache.cancelPending();await tick();
  assert.equal(progress.at(-1).ready,60,'pause preserves completed round audio');
  cache.clear();await tick();
  assert.equal(progress.at(-1).total,0);
});
