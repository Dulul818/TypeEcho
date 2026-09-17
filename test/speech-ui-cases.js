const assert=require('node:assert/strict');
const {SentenceContext}=require('../src/speech/sentence');

module.exports=async page=>{
  const post=data=>page.evaluate(data=>new Promise(resolve=>{
    const received=event=>{if(event.data===data || event.data.type===data.type){window.removeEventListener('message',received);resolve();}};
    window.addEventListener('message',received);window.postMessage(data);
  }),data);
  await page.evaluate(()=>{
    window.audioInstances=[];window.audioEvents=[];window.audioGains=[];
    window.AudioContext=class {constructor(){this.destination={};}createGain(){const gain={gain:{value:1},connect(){}};window.audioGains.push(gain);return gain;}createMediaElementSource(){return {connect(){},disconnect(){}};}resume(){return Promise.resolve();}};
    window.Audio=class {constructor(){window.audioInstances.push(this);}play(){window.audioEvents.push('play');return Promise.resolve();}pause(){window.audioEvents.push('pause');}removeAttribute(){}load(){}};
  });
  let epoch=100,words=[],context;
  const last=()=>page.evaluate(()=>window.messages.filter(message=>message.type==='speech').at(-1));
  const count=()=>page.evaluate(()=>window.messages.filter(message=>message.type==='speech').length);
  const plays=()=>page.evaluate(()=>window.audioEvents.filter(event=>event==='play').length);
  const state=async(index,typed='',mode='quote')=>{
    const data={type:'state',ready:true,testMode:mode,speechEpoch:epoch,wordIndex:index,target:words[index],typed,
      preview:words.map((text,index)=>({text,index})),speechWords:words.map((text,index)=>({text,index})),speechEnd:words.length};
    await post({...data,...context.update(data)});
  };
  const reset=async(text,mode='hybrid',smartSpeech=false)=>{
    words=text.split(' ');context=new SentenceContext();epoch++;
    await post({type:'round-reset'});
    await post({type:'preferences',displayMode:'dock',speechEnabled:true,speechMode:mode,smartSpeech});
    await post({type:'armed'});
  };
  const deliver=async id=>post({type:'speech',id:id ?? (await last()).id,mime:'audio/wav',audio:'fixture'});
  const start=()=>page.evaluate(()=>window.audioInstances.at(-1).onplaying());
  const end=()=>page.evaluate(()=>window.audioInstances.at(-1).onended());
  const waitText=text=>page.waitForFunction(text=>window.messages.filter(message=>message.type==='speech').at(-1)?.text===text,text);

  await reset('cat and or a the dog.','word');
  await state(0);
  await post({type:'speech-preparation',epoch,ready:0,total:6,failed:0,unit:'word'});
  assert.match(await page.locator('#tts-status').textContent(),/等待模型.*预生成 0\/6/);
  assert.equal(await page.locator('footer').isVisible(),true);
  const cat=await last(),initial=await count();
  await state(0,'ca');
  assert.equal(await count(),initial,'typing inside a word does not duplicate requests');
  await state(0,'cat');
  for(let index=1;index<6;index++)await state(index);
  assert.match(await page.locator('#tts-status').textContent(),/排队 5/);
  assert.equal(await count(),initial,'pending synthesis is protected while every next word queues');
  await deliver(cat.id);await start();
  assert.match(await page.locator('#tts-status').textContent(),/朗读中/);
  assert.deepEqual(await page.locator('.prompt-word.speaking').allTextContents(),['cat']);
  const beforeDuplicate=await plays();await deliver(cat.id);
  assert.equal(await plays(),beforeDuplicate,'duplicate audio cannot overlap');
  for(const expected of ['and','or','a','the','dog.']) {
    await end();assert.equal((await last()).text,expected,'FIFO preserves every short word');
    await deliver();await start();
  }
  const lastWordCount=await count();await end();
  assert.equal(await count(),lastWordCount,'draining the queue does not repeat the latest word');
  assert.equal(await page.locator('.prompt-word.speaking').count(),0);
  await state(4);assert.equal((await last()).text,'the','explicit backtracking can repeat a word');
  await deliver();await start();await state(5);
  const beforePause=await count();await post({type:'halt',text:'paused'});await end();
  assert.equal(await count(),beforePause,'pause discards backlog');
  await post({type:'speech-preparation',epoch,ready:4,total:6,failed:0,unit:'word',paused:true});
  assert.match(await page.locator('#tts-status').textContent(),/已暂停 4\/6/);

  await reset('a man; girl, and a ship');await state(0);
  await post({type:'speech-preparation',epoch,ready:2,total:18,failed:0,unit:'sentence'});
  assert.match(await page.locator('#tts-status').textContent(),/预生成 2\/18 段/);
  await post({type:'speech-preparation',epoch:epoch-1,ready:999,total:999,failed:0,unit:'sentence'});
  assert.ok(!(await page.locator('#tts-status').textContent()).includes('999'),'old round progress is ignored');
  for(const width of [1200,360]) {
    await page.setViewportSize({width,height:720});
    const layout=await page.evaluate(()=>{
      const footer=document.querySelector('footer').getBoundingClientRect(),strip=document.getElementById('prompt-panel').getBoundingClientRect();
      const status=document.getElementById('tts-status').getBoundingClientRect(),resume=document.getElementById('resume').getBoundingClientRect();
      return {separate:strip.bottom<=footer.top+1,inside:status.right<=innerWidth && status.left>=resume.right,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert.deepEqual(layout,{separate:true,inside:true,overflow:false});
    await page.screenshot({path:`.test-output/speech-preparation-${width}.png`});
  }
  await page.setViewportSize({width:1200,height:720});
  assert.equal((await last()).text,'a man;');
  const first=await last();await state(1,'man;');
  await state(2);await state(2,'girl,');await state(3);
  await deliver(first.id);await start();await end();await waitText('girl,');
  assert.equal((await last()).unit,'word','single-word segment has no sentence pass');
  await deliver();await start();await end();await waitText('and a ship');
  assert.equal((await last()).unit,'sentence');
  await deliver();await start();
  const sentenceCount=await count();await state(4);await state(5);
  assert.equal(await count(),sentenceCount,'typing never cuts sentence playback');
  await end();await waitText('ship');
  assert.equal((await last()).unit,'word');

  for(const punctuation of ['.',';',':']) {
    await reset(`We stop${punctuation} Tomorrow is sunny.`);await state(0);
    await deliver();await start();await end();await waitText('We');
    await deliver();await start();await state(1,'stop'+punctuation);
    const boundaryCount=await count();await end();await waitText('Tomorrow is sunny.');
    assert.equal((await last()).unit,'sentence','boundary lookahead schedules an entire sentence');
    await state(2);assert.equal(await count(),boundaryCount+1,'space never duplicates early sentence speech');
  }

  await reset('Hello world. Next sentence. Last phrase.');await state(0);
  const firstSentence=await last();await state(2);await state(4);
  await deliver(firstSentence.id);await start();await end();await waitText('Next sentence.');
  await deliver();await start();await end();await waitText('Last phrase.');
  const old=await last();await reset('Fresh round.');await state(0);
  const beforeOld=await plays();await deliver(old.id);await post({type:'speech-ended',id:old.id});
  assert.equal(await plays(),beforeOld,'new round rejects old audio and completion');

  await reset('Hello world.','hybrid',true);await state(0);
  assert.equal(await page.locator('#smart-speech').isChecked(),true);
  await deliver();await start();await state(0,'H');await end();
  const smartCount=await count();await page.waitForTimeout(200);
  assert.equal(await count(),smartCount,'smart mode does not repeat fluent words');
  await state(0,'Hx');await waitText('Hello');
  await deliver();await start();await end();
  await state(1,'w');await waitText('world.');
  await post({type:'halt',text:'paused'});

  await reset('one two three','word');await state(0);const failure=await last();await state(1);
  await post({type:'speech-error',id:failure.id,text:'fixture failure'});await waitText('two');
  await post({type:'speech-preparation',epoch,ready:1,total:3,failed:1,error:'model offline',unit:'word'});
  assert.match(await page.locator('#tts-status').textContent(),/1 项失败/);
  assert.equal(await page.locator('#tts-status').getAttribute('title'),'model offline');
  assert.equal(await page.locator('#tts-retry').isVisible(),true);
  await page.locator('#tts-retry').click();
  assert.equal(await page.evaluate(()=>window.messages.at(-1).type),'speech-retry');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'editor','retry never steals typing focus');
  const native=await last();await post({type:'speech-started',id:native.id});
  await state(2);assert.equal((await last()).id,native.id);
  await post({type:'speech-ended',id:native.id});await waitText('three');
  await deliver();await start();
  await post({type:'preferences',displayMode:'dock',speechEnabled:true,speechMode:'word',speechVolume:300});
  assert.equal(await page.evaluate(()=>window.audioGains.at(-1).gain.value),3);
  await post({type:'preferences',displayMode:'dock',speechEnabled:false,speechMode:'word'});
  const disabled=await plays();await deliver();assert.equal(await plays(),disabled);

  await reset('one two','word');await state(0);await deliver();await start();await state(1);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  const blurred=await count();await end();assert.equal(await count(),blurred,'blur stops the queue');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await reset('Hello world.');await state(0);
  if(!await page.locator('#speech-panel').isVisible())await page.evaluate(()=>document.getElementById('speech-panel').hidden=false);
  await page.locator('#speech-replay').click();
  if((await last()).text!=='Hello world.')await state(0);
  assert.equal((await last()).unit,'sentence');
  await page.locator('#editor').focus();await page.keyboard.press('Escape');
  const exited=await plays();await deliver();assert.equal(await plays(),exited,'exit rejects late playback');
  await post({type:'preferences',displayMode:'dock',speechEnabled:false});
};
