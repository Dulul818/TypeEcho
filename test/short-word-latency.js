const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');

async function main() {
  const base='http://127.0.0.1:17864';
  for(let attempt=0;;attempt++) {
    try {
      const health=await fetch(base+'/health',{signal:AbortSignal.timeout(1000)}).then(response=>response.json());
      assert.equal(health.shortWordGuard,'bounded-greedy-seeded-retry');
      break;
    } catch(error) {
      if(attempt>=45)throw error;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  const output=path.resolve('.test-output/short-word-guard');
  await fs.mkdir(output,{recursive:true});
  const results=[];
  const request=async(text,rate)=>{
    const started=performance.now();
    const response=await fetch(base+'/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice:'BG3N',language:'en-US',rate}),signal:AbortSignal.timeout(30000)});
    assert.equal(response.status,200,text+' synthesis');
    const audio=Buffer.from(await response.arrayBuffer()),offset=audio.indexOf(Buffer.from('data'),12);
    assert.ok(offset>=0);
    const seconds=audio.readUInt32LE(offset+4)/48000;
    let peak=0;
    for(let i=offset+8;i+1<audio.length;i+=2)peak=Math.max(peak,Math.abs(audio.readInt16LE(i)));
    assert.ok(peak>100,text+' is not silent');
    return {audio,seconds,ms:Math.round(performance.now()-started),cache:response.headers.get('x-cache')};
  };
  for(const text of ['the','in','is','it','be','at','of','to','on','as','and','or','a','with','this','that','from','have','would','could','should']) {
    const clip=await request(text,0.85);
    assert.ok(clip.seconds<3.5,text+' must not stall the queue for many seconds');
    await fs.writeFile(path.join(output,text+'.wav'),clip.audio);
    const cached=await request(text,0.85);
    assert.equal(cached.cache,'HIT');assert.deepEqual(cached.audio,clip.audio);
    const result={text,seconds:+clip.seconds.toFixed(3),ms:clip.ms,cachedMs:cached.ms};
    results.push(result);console.log(JSON.stringify(result));
  }
  const the=await request('the',1);
  const approved=await fs.readFile(path.resolve('.test-output/the-bg3-stable.wav'));
  const position=approved.indexOf(Buffer.from('data'),12);
  assert.equal(the.seconds,approved.readUInt32LE(position+4)/48000,'approved the duration is unchanged');
  assert.deepEqual(the.audio,approved,'approved the audio is unchanged');
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));
  console.log('PASS: bounded short-word generation, cache reuse and unchanged approved the sample.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
